import { toolResult, type IntegrationToolId, type ToolResult, type ToolResultReason } from "../../../shared/integrations.ts";
import { GENRES, INTENT_IDS, type RelayCatalog, type RelayRefusal, type TtsEngine } from "../../../shared/voice-relay.ts";
import type { Config } from "../../config.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";
import { composeRelayDocument } from "../voice-relay/builtin.ts";
import { parseRelayCatalog, readRelayUserConfig } from "../voice-relay/catalog.ts";
import { FakeRelayOutput, type PlaybackReceipt, type RelayJob, type RelayOutput } from "../voice-relay/output.ts";
import { resolveRelay, type DiagnosticOptions, type RelayRequest, type RelayResolution } from "../voice-relay/resolver.ts";

// VCR-0／VCR-1（fake）（docs/19）：Voice Command Relay Adapter。模型只能選「目標＋意圖＋slot」；
// 實際說法、喚醒詞、聲線、輸出裝置都由核心依已審閱的資料決定，模型看不到也改不了。
// 播放後最多是 unconfirmed（聲音送出了，但沒有獨立的下游狀態讀取，不知道音箱有沒有照做）；永遠不回 confirmed，也不自動重試。
// 目前只有假輸出（NOUS_VCR=fake，mock）：沒有實體喇叭發聲；實體播音（VCR-2/3）尚未實作。

export const VOICE_RELAY_TOOL: IntegrationToolId = "app.voice_relay.send_intent";

const UNCONFIRMED = "已發出語音命令，但執行結果尚未確認。";
const MOCK_UNCONFIRMED = "（模擬）已發出語音命令，但執行結果尚未確認；這次是假輸出，沒有實體喇叭發聲。";

/** 解析器的拒絕原因 → 整合層的原因代碼。 */
const AIL_REASON: Partial<Record<RelayRefusal, ToolResultReason>> = { unknown_target: "invalid_arguments", unsupported_intent: "invalid_arguments", invalid_slots: "invalid_arguments" };

const REFUSAL_MESSAGE: Record<RelayRefusal, string> = {
  unknown_target: "沒有這個音箱目標，沒有播放。",
  target_disabled: "這個音箱目標沒有啟用，沒有播放。",
  unsupported_intent: "這個音箱目前沒有可用的命令說法，沒有播放。",
  invalid_slots: "命令參數不正確，沒有播放。",
  ambiguous_template: "這個命令有多個說法互相衝突，沒有播放；請檢查命令包設定。",
  not_reviewed: "這個命令說法還沒有審閱通過，沒有播放。",
  policy_blocked: "政策不允許這個命令（例如 Spotify 語音控制未取得授權），沒有播放。",
  tts_unavailable: "這個音箱的指定聲線無法使用，沒有播放，也沒有改用其他聲線。",
  output_unavailable: "輸出裝置沒有設定，沒有播放。",
  diagnostic_invalid: "診斷參數不正確，沒有播放。",
};

export interface VoiceRelayAdapterOptions {
  catalog: RelayCatalog;
  output: RelayOutput;
}

export class VoiceRelayAdapter implements IntegrationAdapter {
  readonly id = "voice_relay";
  readonly service = "voice_relay";
  readonly version = 1;
  readonly mock: boolean;
  /**
   * 每個輸出端同時只播一個命令。只在這個核心行程裡有效；呼叫被中止或逾時後鎖就釋放，
   * 但實體輸出端可能還在播（VCR-2/3 要由輸出端自己回報忙碌）。
   */
  private readonly busy = new Set<string>();

  constructor(private readonly options: VoiceRelayAdapterOptions) {
    this.mock = options.output.mock;
  }

  private enabledTargets() {
    return this.options.catalog.targets.filter((t) => t.enabled);
  }

  tools(): readonly ToolDefinition[] {
    const targets = this.enabledTargets();
    if (!targets.length) return [];
    const lights = [...new Set(targets.flatMap((t) => t.devices.filter((d) => d.kind === "light").map((d) => d.id)))].sort();
    const zhPrefix = this.mock ? "（模擬）" : "";
    const enPrefix = this.mock ? "(Mock) " : "";
    return [
      {
        id: VOICE_RELAY_TOOL,
        description: `${zhPrefix}用語音合成對附近的智慧音箱說一句事先審閱過的命令（例如下一首、暫停、音量、開關燈）。結果最多是「已發出、未確認」，不知道音箱有沒有照做。只在使用者明確要求控制那個音箱時呼叫。`,
        descriptionEn: `${enPrefix}Sends a pre-approved voice command to a nearby smart speaker by playing synthesized speech (e.g. next song, pause, volume, lights). The result is at most "sent, unconfirmed"; it cannot tell whether the speaker obeyed. Call only when the user explicitly asks to control that speaker.`,
        inputSchema: {
          type: "object",
          properties: {
            target_id: { type: "string", description: "音箱目標 ID", enum: targets.map((t) => t.id) },
            intent_id: { type: "string", description: "意圖", enum: [...INTENT_IDS] },
            genre: { type: "string", description: "music.play_genre 的曲風", enum: [...GENRES] },
            ...(lights.length ? { device: { type: "string" as const, description: "light.* 的燈 ID", enum: lights } } : {}),
            on: { type: "boolean", description: "light.power：打開（true）或關掉（false）" },
            percent: { type: "integer", description: "volume.set／light.brightness 的百分比", minimum: 0, maximum: 100 },
            seconds: { type: "integer", description: "assistant.timer 的秒數", minimum: 1, maximum: 3600 },
          },
          required: ["target_id", "intent_id"],
          additionalProperties: false,
        },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 20_000,
        supportedRoutes: ["api_key", "live"],
      },
    ];
  }

  async health(): Promise<HealthReport> {
    return this.enabledTargets().length ? { health: "available", reason: "ok" } : { health: "unavailable", reason: "not_configured" };
  }

  /**
   * 唯讀預覽（不播放）：給之後「使用者觸發的診斷畫面」用，可以指定候選模板與聲線。
   * 只能由核心程式碼呼叫；模型的工具呼叫（execute）拿不到診斷參數。
   */
  diagnose(request: RelayRequest, diagnostic: DiagnosticOptions = {}): RelayResolution {
    return resolveRelay(this.options.catalog, request, { diagnostic, voiceAvailable: this.voiceAvailable });
  }

  private readonly voiceAvailable = (node: string, engine: TtsEngine, voiceId: string) => this.options.output.voiceAvailable(node, engine, voiceId);

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const base = { mock: this.mock };
    if (toolId !== VOICE_RELAY_TOOL) return toolResult("refused", "沒有這個工具，沒有播放。", { reason: "not_registered", data: base });
    const { target_id, intent_id, ...slots } = args;
    const resolved = resolveRelay(this.options.catalog, { targetId: String(target_id), intentId: String(intent_id), slots }, { voiceAvailable: this.voiceAvailable });
    if (resolved.kind === "refused") {
      return toolResult("refused", REFUSAL_MESSAGE[resolved.reason], { reason: AIL_REASON[resolved.reason] ?? "unavailable", data: { ...base, vcr_reason: resolved.reason } });
    }
    if (this.busy.has(resolved.outputNode)) return toolResult("refused", "這個輸出端正在播放另一個命令，這次沒有播放。", { reason: "unavailable", data: { ...base, vcr_reason: "output_busy" } });

    const p = resolved.profile;
    const job: RelayJob = {
      jobId: ctx.requestId,
      targetId: resolved.targetId,
      outputNode: resolved.outputNode,
      outputDeviceId: resolved.outputDeviceId,
      engine: p.engine,
      voiceId: p.voiceId,
      ...(p.modelId ? { modelId: p.modelId } : {}),
      segments: [
        { kind: "silence", ms: p.leadSilenceMs },
        { kind: "speech", part: "wake", text: resolved.wakePhrase },
        { kind: "silence", ms: p.wakeToCommandPauseMs },
        { kind: "speech", part: "command", text: resolved.commandText },
        { kind: "silence", ms: p.tailSilenceMs },
      ],
      rate: p.rate,
      pitch: p.pitch,
      gainDb: p.gainDb,
    };
    const data = {
      ...base,
      target_id: resolved.targetId,
      intent_id: resolved.intentId,
      template_id: resolved.templateId,
      template_version: resolved.templateVersion,
      catalog_version: resolved.catalogVersion,
      voice_profile_id: resolved.voiceProfileId,
      test_status: resolved.testStatus,
      job_id: job.jobId,
    };
    this.busy.add(job.outputNode);
    try {
      let receipt: unknown;
      try {
        receipt = await this.options.output.play(job, ctx.signal);
      } catch {
        // 播放途中出錯或被中止：可能已經發出一部分聲音，結果不明（不重試）。
        return toolResult("unknown", `${this.mock ? "（模擬）" : ""}播放中斷，語音命令可能已部分發出，結果不明，請確認。`, { reason: ctx.signal.aborted ? "aborted" : "adapter_error", data });
      }
      return receiptOutcome(receipt, job, this.mock, data);
    } finally {
      this.busy.delete(job.outputNode);
    }
  }
}

/** 確定沒有發出聲音的失敗 → 說明。 */
const NOT_PLAYED: Partial<Record<NonNullable<PlaybackReceipt["failure"]>, string>> = {
  synthesis_failed: "語音合成失敗",
  device_unavailable: "輸出裝置無法使用",
  start_failed: "播放沒有開始",
};

/**
 * 收據 → 結果。永遠不回 confirmed：就算播完，也只代表聲音送出了（unconfirmed）。
 * 收據缺漏、對不上這次工作或裝置、播到一半、只合成沒開始播 → unknown；確定沒有發出聲音的失敗 → failed。
 */
export function receiptOutcome(receipt: unknown, job: RelayJob, mock: boolean, data: Record<string, unknown> = { mock }): ToolResult {
  const m = mock ? "（模擬）" : "";
  const unknown = (why: string) => toolResult("unknown", `${m}沒有拿到可信的播放收據，語音命令是否發出不明，請確認。`, { reason: "invalid_result", data: { ...data, vcr_reason: why } });
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return unknown("receipt_missing");
  const r = receipt as Partial<PlaybackReceipt>;
  if (r.jobId !== job.jobId || r.outputNode !== job.outputNode || r.outputDeviceId !== job.outputDeviceId) return unknown("receipt_mismatch");
  if (typeof r.audioStarted !== "boolean" || typeof r.audioFinished !== "boolean") return unknown("receipt_invalid");
  // 自相矛盾（沒開始卻播完）：不採信。
  if (!r.audioStarted && r.audioFinished) return unknown("receipt_contradictory");
  // 確定沒有發出聲音的失敗才是 failed；interrupted 表示可能已經播了一部分，所以是 unknown。
  if (!r.audioStarted && r.failure !== undefined && Object.hasOwn(NOT_PLAYED, r.failure)) {
    return toolResult("failed", `${m}語音命令沒有發出（${NOT_PLAYED[r.failure]}）。`, { reason: "unavailable", data: { ...data, vcr_reason: r.failure } });
  }
  if (r.audioStarted === true && r.audioFinished === true && r.failure === undefined) {
    return toolResult("unconfirmed", mock ? MOCK_UNCONFIRMED : UNCONFIRMED, { data });
  }
  if (r.audioStarted === true) return unknown("playback_incomplete");
  return unknown("not_started");
}

/** 已審核的建立方式（index.ts）：NOUS_VCR=off（沒有 vcr）回 null；設定檔壞掉回 null 並記錄（fail closed，不擋 Nous 啟動）。 */
export function createVoiceRelayAdapter(config: Config["ail"], log: (line: string) => void = () => undefined): VoiceRelayAdapter | null {
  if (!config.vcr || config.vcr.mode !== "fake") return null;
  const user = readRelayUserConfig(config.vcr.dir);
  if (!user.ok) {
    log(`整合層：voice_relay 設定檔不正確，未啟用（${user.errors.slice(0, 5).join("；")}）`);
    return null;
  }
  const parsed = parseRelayCatalog(composeRelayDocument(user.config));
  if (!parsed.ok) {
    log(`整合層：voice_relay 目錄驗證失敗，未啟用（${parsed.errors.slice(0, 5).join("；")}）`);
    return null;
  }
  const catalog = parsed.catalog;
  // 假輸出：目標實際會用到的聲線都當作「可用」（不代表 Mac 上真的有這個聲音）。
  const voices = catalog.targets.flatMap((t) => {
    const ids = [t.voiceProfileId, ...t.candidateVoiceProfileIds, ...catalog.voiceDefaults.filter((d) => d.vendor === t.vendor && d.assistant === t.assistant && d.locale === t.locale).map((d) => d.voiceProfileId)];
    return catalog.profiles.filter((p) => ids.includes(p.id)).map((p) => ({ node: p.outputNode ?? t.outputNode, engine: p.engine, voiceId: p.voiceId }));
  });
  log(`整合層：voice_relay 以假輸出（模擬）啟用，${catalog.targets.filter((t) => t.enabled).length} 個目標；沒有實體喇叭發聲`);
  return new VoiceRelayAdapter({ catalog, output: new FakeRelayOutput({ voices }) });
}
