import { randomUUID } from "node:crypto";
import { toolResult, type IntegrationToolId, type ToolResult, type ToolResultReason } from "../../../shared/integrations.ts";
import { GENRES, INTENT_IDS, summarizeTrials, type RelayCatalog, type RelayRefusal, type RelayTrial, type Target, type TtsEngine, type VoiceRelayIntentView, type VoiceRelayMode, type VoiceRelayPart, type VoiceRelayPlayResult, type VoiceRelayPreview, type VoiceRelayProfileView, type VoiceRelayTargetView, type VoiceRelayView } from "../../../shared/voice-relay.ts";
import type { Config } from "../../config.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";
import { BUILTIN_PROFILES, composeRelayDocument } from "../voice-relay/builtin.ts";
import { parseRelayCatalog, readRelayUserConfig } from "../voice-relay/catalog.ts";
import { MacSayOutput, type SayRunner } from "../voice-relay/mac-say.ts";
import { FakeRelayOutput, type PlaybackReceipt, type RelayJob, type RelayOutput } from "../voice-relay/output.ts";
import { levelDefault, packLevel, resolveRelay, wakePhraseFor, type DiagnosticOptions, type RelayRequest, type RelayResolution, type RelayResolved } from "../voice-relay/resolver.ts";
import { templatePolicyOk, VoiceRelayStore } from "../voice-relay/store.ts";

// VCR-0／VCR-1（fake）（docs/19）：Voice Command Relay Adapter。模型只能選「目標＋意圖＋slot」；
// 實際說法、喚醒詞、聲線、輸出裝置都由核心依已審閱的資料決定，模型看不到也改不了。
// 播放後最多是 unconfirmed（聲音送出了，但沒有獨立的下游狀態讀取，不知道音箱有沒有照做）；永遠不回 confirmed，也不自動重試。
// NOUS_VCR=fake：假輸出（mock），沒有實體喇叭發聲。NOUS_VCR=mac（VCR-2）：Mac 的 say 從選定喇叭實際發聲（mock=false），
// 但這個批次只在 Linux 用假的 runner 測過，沒有在真的 Mac 上跑過。沒有回音抑制（已知風險）。Pi 喇叭（VCR-3）尚未實作。

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
  /** 預設依輸出端：mock → fake，否則 mac。 */
  mode?: VoiceRelayMode;
  /** 診斷畫面的寫入端（設定檔與試驗紀錄）；沒有時只能看、不能改。 */
  store?: VoiceRelayStore;
}

const BUILTIN_PROFILE_IDS = new Set(BUILTIN_PROFILES.map((p) => p.id));

/** 模型工具清單取決於這兩組 ID（啟動時凍結進工具 schema）。 */
function toolKey(catalog: RelayCatalog): string {
  const enabled = catalog.targets.filter((t) => t.enabled);
  return JSON.stringify([enabled.map((t) => t.id).sort(), [...new Set(enabled.flatMap((t) => t.devices.filter((d) => d.kind === "light").map((d) => d.id)))].sort()]);
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
  readonly mode: VoiceRelayMode;
  readonly store: VoiceRelayStore | undefined;
  private catalog: RelayCatalog;
  private readonly startupToolKey: string;
  /** mac：第一次讀聲音與喇叭清單（讀完之前 voiceAvailable 都是 false）。 */
  ready: Promise<void> = Promise.resolve();

  constructor(private readonly options: VoiceRelayAdapterOptions) {
    this.mock = options.output.mock;
    this.mode = options.mode ?? (options.output.mock ? "fake" : "mac");
    this.store = options.store;
    this.catalog = options.catalog;
    this.startupToolKey = toolKey(options.catalog);
  }

  /** 換目錄（診斷畫面存檔後）：execute／diagnose 立刻用新的；已註冊的工具 schema 不變（要重新啟動）。 */
  reload(catalog: RelayCatalog): void {
    this.catalog = catalog;
  }

  get restartRequired(): boolean {
    return toolKey(this.catalog) !== this.startupToolKey;
  }

  currentCatalog(): RelayCatalog {
    return this.catalog;
  }

  async refresh(): Promise<void> {
    await this.options.output.refresh?.();
  }

  private enabledTargets() {
    return this.catalog.targets.filter((t) => t.enabled);
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
    return resolveRelay(this.catalog, request, { diagnostic, voiceAvailable: this.voiceAvailable });
  }

  /** 診斷畫面的「預覽文字」：不播放。 */
  preview(request: RelayRequest, diagnostic: DiagnosticOptions = {}): VoiceRelayPreview {
    const r = this.diagnose(request, diagnostic);
    if (r.kind === "refused") return r.detail ? { kind: "refused", reason: r.reason, detail: r.detail } : { kind: "refused", reason: r.reason };
    return { kind: "resolved", template_id: r.templateId, level: r.level, voice_profile_id: r.voiceProfileId, wake: r.wakePhrase, command: r.commandText, spoken: r.spokenText, output_device_id: r.outputDeviceId, test_status: r.testStatus };
  }

  /**
   * 診斷畫面的「測試喚醒／測試整句」：使用者在設定頁明確按下才播；可以指定候選模板與聲線（診斷），政策仍然擋。
   * 和模型路徑共用同一個輸出端與忙碌鎖；結果最多 unconfirmed。
   */
  async playDiagnostic(request: RelayRequest, diagnostic: DiagnosticOptions, part: VoiceRelayPart, signal: AbortSignal): Promise<VoiceRelayPlayResult> {
    const r = this.diagnose(request, diagnostic);
    if (r.kind === "refused") return r.detail ? { status: "refused", reason: r.reason, detail: r.detail } : { status: "refused", reason: r.reason };
    return this.playResolved(r, part, `diag-${randomUUID()}`, signal);
  }

  /** 設定頁的檢視（GET /api/voice-relay）。 */
  view(): VoiceRelayView {
    const inv = this.options.output.inventory?.() ?? { voices: [], devices: [], checkedAt: null, error: null };
    let trials: RelayTrial[] = [];
    let error = inv.error;
    try {
      trials = this.store?.readTrials() ?? [];
    } catch {
      error ??= "trials_unreadable";
    }
    return {
      mode: this.mode,
      mock: this.mock,
      restart_required: this.restartRequired,
      output: { voices: inv.voices, devices: inv.devices, checked_at: inv.checkedAt, error },
      targets: this.catalog.targets.map((t) => this.targetView(t, trials.filter((x) => x.targetId === t.id))),
    };
  }

  private targetView(t: Target, trials: RelayTrial[]): VoiceRelayTargetView {
    const c = this.catalog;
    const same = c.voiceDefaults.filter((d) => d.vendor === t.vendor && d.assistant === t.assistant && d.locale === t.locale);
    const selected = t.voiceProfileId ?? (same.find((d) => d.model === t.model) ?? same.find((d) => d.model === undefined))?.voiceProfileId ?? null;
    const ids = [...new Set([...(selected ? [selected] : []), ...t.candidateVoiceProfileIds])];
    const profiles: VoiceRelayProfileView[] = ids
      .map((id) => c.profiles.find((p) => p.id === id))
      .filter((p) => !!p && (this.mode !== "mac" || p.engine === "macos_say"))
      .map((p) => ({
        id: p!.id, voice_id: p!.voiceId, locale: p!.locale, rate: p!.rate, gain_db: p!.gainDb, pause_ms: p!.wakeToCommandPauseMs, lead_ms: p!.leadSilenceMs, tail_ms: p!.tailSilenceMs,
        selected: p!.id === selected, editable: !!this.store && !BUILTIN_PROFILE_IDS.has(p!.id) && !t.fixture, available: this.voiceAvailable(p!.outputNode ?? t.outputNode, p!.engine, p!.voiceId),
      }));
    const wake = wakePhraseFor(c, t) ?? "";
    const intents: VoiceRelayIntentView[] = [];
    for (const intent of c.intents) {
      const def = levelDefault(c, t, intent.id);
      const defaultId = t.templateOverrides[intent.id] ?? (def && !("ambiguous" in def) ? def.entry.templateId : undefined);
      const templates = c.packs
        .filter((pack) => packLevel(pack, t))
        .flatMap((pack) => pack.entries.filter((e) => e.intentId === intent.id))
        .map((e) => {
          const reviewed = t.reviewedTemplates.find((r) => r.templateId === e.templateId && r.version === e.version);
          return {
            template_id: e.templateId, version: e.version, text: e.utteranceTemplate, wake,
            status: e.status === "rejected" ? ("rejected" as const) : (reviewed?.status ?? e.status),
            selected_default: e.templateId === defaultId, adopted: e.status !== "rejected" && reviewed?.status === "approved", policy_blocked: !templatePolicyOk(c, t, e.templateId),
          };
        });
      if (templates.length) intents.push({ intent_id: intent.id, slots: Object.keys(intent.slots) as VoiceRelayIntentView["slots"], templates });
    }
    return {
      id: t.id, locale: t.locale, enabled: t.enabled, output_device_id: t.outputDeviceId, music_service: t.musicService, voice_profile_id: selected,
      profiles, intents, trials: summarizeTrials(trials), devices: t.devices.filter((d) => d.kind === "light").map((d) => ({ id: d.id, name: d.name })),
    };
  }

  private readonly voiceAvailable = (node: string, engine: TtsEngine, voiceId: string) => this.options.output.voiceAvailable(node, engine, voiceId);

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const base = { mock: this.mock };
    if (toolId !== VOICE_RELAY_TOOL) return toolResult("refused", "沒有這個工具，沒有播放。", { reason: "not_registered", data: base });
    const { target_id, intent_id, ...slots } = args;
    const resolved = resolveRelay(this.catalog, { targetId: String(target_id), intentId: String(intent_id), slots }, { voiceAvailable: this.voiceAvailable });
    if (resolved.kind === "refused") {
      return toolResult("refused", REFUSAL_MESSAGE[resolved.reason], { reason: AIL_REASON[resolved.reason] ?? "unavailable", data: { ...base, vcr_reason: resolved.reason } });
    }
    return this.playResolved(resolved, "full", ctx.requestId, ctx.signal);
  }

  /** 模型路徑與診斷畫面共用：組工作 → 忙碌鎖 → 播一次（不重試）→ 收據對應結果。 */
  private async playResolved(resolved: RelayResolved, part: VoiceRelayPart, jobId: string, signal: AbortSignal): Promise<ToolResult> {
    const base = { mock: this.mock };
    if (this.busy.has(resolved.outputNode)) return toolResult("refused", "這個輸出端正在播放另一個命令，這次沒有播放。", { reason: "unavailable", data: { ...base, vcr_reason: "output_busy" } });

    const p = resolved.profile;
    // 只測喚醒：前後靜音＋喚醒詞，沒有命令。
    const segments: RelayJob["segments"] =
      part === "wake"
        ? [{ kind: "silence", ms: p.leadSilenceMs }, { kind: "speech", part: "wake", text: resolved.wakePhrase }, { kind: "silence", ms: p.tailSilenceMs }]
        : [
            { kind: "silence", ms: p.leadSilenceMs },
            { kind: "speech", part: "wake", text: resolved.wakePhrase },
            { kind: "silence", ms: p.wakeToCommandPauseMs },
            { kind: "speech", part: "command", text: resolved.commandText },
            { kind: "silence", ms: p.tailSilenceMs },
          ];
    const job: RelayJob = {
      jobId,
      targetId: resolved.targetId,
      outputNode: resolved.outputNode,
      outputDeviceId: resolved.outputDeviceId,
      engine: p.engine,
      voiceId: p.voiceId,
      ...(p.modelId ? { modelId: p.modelId } : {}),
      segments,
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
      ...(resolved.diagnostic || part === "wake" ? { diagnostic: true, part } : {}),
    };
    this.busy.add(job.outputNode);
    try {
      let receipt: unknown;
      try {
        receipt = await this.options.output.play(job, signal);
      } catch {
        // 播放途中出錯或被中止：可能已經發出一部分聲音，結果不明（不重試）。
        return toolResult("unknown", `${this.mock ? "（模擬）" : ""}播放中斷，語音命令可能已部分發出，結果不明，請確認。`, { reason: signal.aborted ? "aborted" : "adapter_error", data });
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

export interface VoiceRelayFactoryDeps {
  /** 預設 process.platform（測試注入）。 */
  platform?: NodeJS.Platform;
  /** say 的執行方式（測試注入假的 runner）。 */
  run?: SayRunner;
  now?: () => Date;
}

/**
 * 已審核的建立方式（index.ts）：NOUS_VCR=off（沒有 vcr）回 null；設定檔壞掉回 null 並記錄（fail closed，不擋 Nous 啟動）。
 * fake：假輸出（mock），沒有設定檔時用示範目標。mac：只限 macOS；沒有示範目標（沒有設定檔＝0 個目標，診斷畫面可以新增）。
 */
export function createVoiceRelayAdapter(config: Config["ail"], log: (line: string) => void = () => undefined, deps: VoiceRelayFactoryDeps = {}): VoiceRelayAdapter | null {
  if (!config.vcr) return null;
  const mode = config.vcr.mode;
  if (mode === "mac" && (deps.platform ?? process.platform) !== "darwin") {
    log("voice_relay：NOUS_VCR=mac 只能在 macOS 使用，未啟用");
    return null;
  }
  const user = readRelayUserConfig(config.vcr.dir);
  if (!user.ok) {
    log(`整合層：voice_relay 設定檔不正確，未啟用（${user.errors.slice(0, 5).join("；")}）`);
    return null;
  }
  const parsed = parseRelayCatalog(composeRelayDocument(user.config, { fixtures: mode === "fake" }));
  if (!parsed.ok) {
    log(`整合層：voice_relay 目錄驗證失敗，未啟用（${parsed.errors.slice(0, 5).join("；")}）`);
    return null;
  }
  const catalog = parsed.catalog;
  let adapter: VoiceRelayAdapter | null = null;
  const store = new VoiceRelayStore(config.vcr.dir, { mode, ...(deps.now ? { now: deps.now } : {}), onChange: (c) => adapter?.reload(c) });
  const count = catalog.targets.filter((t) => t.enabled).length;
  if (mode === "mac") {
    const output = new MacSayOutput(deps.run ? { run: deps.run } : {});
    adapter = new VoiceRelayAdapter({ catalog, output, mode, store });
    // 第一次讀聲音與喇叭清單（非同步；讀完之前所有聲線都當作不可用）。
    adapter.ready = output.refresh();
    log(`整合層：voice_relay 以 Mac say 實際發聲啟用，${count} 個目標（沒有回音抑制；尚未在真的 Mac 上驗證）`);
    return adapter;
  }
  // 假輸出：目標實際會用到的聲線都當作「可用」（不代表 Mac 上真的有這個聲音）。
  const voices = catalog.targets.flatMap((t) => {
    const ids = [t.voiceProfileId, ...t.candidateVoiceProfileIds, ...catalog.voiceDefaults.filter((d) => d.vendor === t.vendor && d.assistant === t.assistant && d.locale === t.locale).map((d) => d.voiceProfileId)];
    return catalog.profiles.filter((p) => ids.includes(p.id)).map((p) => ({ node: p.outputNode ?? t.outputNode, engine: p.engine, voiceId: p.voiceId, locale: p.locale }));
  });
  const devices = [...new Set(catalog.targets.map((t) => t.outputDeviceId))].map((id) => ({ id, name: id }));
  log(`整合層：voice_relay 以假輸出（模擬）啟用，${count} 個目標；沒有實體喇叭發聲`);
  adapter = new VoiceRelayAdapter({ catalog, output: new FakeRelayOutput({ voices, devices }), mode, store });
  return adapter;
}
