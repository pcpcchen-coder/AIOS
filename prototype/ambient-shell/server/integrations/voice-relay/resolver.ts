import type { CommandEntry, CommandPack, DownstreamService, IntentDef, RelayCatalog, RelayRefusal, ResolveLevel, Target, TemplateStatus, TestResult, VoiceProfile } from "../../../shared/voice-relay.ts";
import { containsWakePhrase, safeText } from "./catalog.ts";
import { relayPolicy } from "./policy.ts";

// VCR-0（docs/19 §4.4）：決定論的解析器。同樣的 (目錄, 請求, 選項) 一定得到同樣的結果（沒有亂數、沒有時間）。
// 順序：目標 → 意圖與 slot → 模板（裝置覆寫 > 型號＋語系 > 助理＋語系 > 品牌＋語系 > 通用）→ 政策 → 審閱 → 聲線 → 輸出 → 喚醒詞 → 組字。
// 第一個不通過就拒絕；語系只比對完全相同，絕不退回其他語系；聲線不可用時絕不換另一個聲線。這裡不播任何聲音。

export interface RelayRequest {
  targetId: string;
  intentId: string;
  slots: Readonly<Record<string, unknown>>;
}

export interface DiagnosticOptions {
  /** 指定一個候選模板（只限這個意圖、而且命令包相容於目標）。 */
  candidateTemplateId?: string;
  /** 指定一個候選聲線（只限目標的 voiceProfileId 或 candidateVoiceProfileIds）。 */
  candidateVoiceId?: string;
}

export interface ResolveOptions {
  /** 只有使用者觸發的診斷流程可以帶；模型的工具呼叫拿不到這個參數。 */
  diagnostic?: DiagnosticOptions;
  /** 輸出端實際有沒有這個聲音；回 false 就是 tts_unavailable（不換別的聲音）。 */
  voiceAvailable?: (node: string, engine: VoiceProfile["engine"], voiceId: string) => boolean;
}

export interface RelayResolved {
  kind: "resolved";
  targetId: string;
  intentId: string;
  templateId: string;
  templateVersion: number;
  packId: string;
  catalogVersion: number;
  level: ResolveLevel;
  voiceProfileId: string;
  wakePhrase: string;
  commandText: string;
  /** 預覽用：`${wakePhrase} ${commandText}`（實際播放時中間有停頓）。 */
  spokenText: string;
  outputNode: string;
  outputDeviceId: string;
  profile: VoiceProfile;
  testStatus: TestResult;
  reviewStatus: TemplateStatus;
  diagnostic: boolean;
  downstreamService: DownstreamService;
}

export interface RelayRefused {
  kind: "refused";
  reason: RelayRefusal;
  detail?: string;
}

export type RelayResolution = RelayResolved | RelayRefused;

const refuse = (reason: RelayRefusal, detail?: string): RelayRefused => (detail ? { kind: "refused", reason, detail } : { kind: "refused", reason });

const LEVELS = ["model_locale", "assistant_locale", "vendor_locale", "generic"] as const;

/** 命令包相容於目標時回它的層級，否則 null。 */
export function packLevel(pack: CommandPack, target: Target): (typeof LEVELS)[number] | null {
  if (pack.locale !== target.locale) return null;
  if (pack.scope === "model") return pack.vendor === target.vendor && pack.assistant === target.assistant && pack.model === target.model ? "model_locale" : null;
  if (pack.scope === "assistant") return pack.vendor === target.vendor && pack.assistant === target.assistant ? "assistant_locale" : null;
  if (pack.scope === "vendor") return pack.vendor === target.vendor ? "vendor_locale" : null;
  return pack.compatibleAssistants?.includes(target.assistant) ? "generic" : null;
}

function findTemplate(catalog: RelayCatalog, templateId: string): { pack: CommandPack; entry: CommandEntry } | null {
  for (const pack of catalog.packs) for (const entry of pack.entries) if (entry.templateId === templateId) return { pack, entry };
  return null;
}

/** slot 必須剛好是意圖的 slot，型別與範圍都對；燈必須是這個目標裡的燈。 */
function slotsValid(intent: IntentDef, target: Target, slots: Readonly<Record<string, unknown>>): boolean {
  const defs = intent.slots as Record<string, IntentDef["slots"][keyof IntentDef["slots"]]>;
  for (const key of Object.keys(slots)) if (!Object.hasOwn(defs, key)) return false;
  for (const [name, def] of Object.entries(defs)) {
    const v = slots[name];
    if (!def || v === undefined) return false;
    if (def.kind === "enum" && !(typeof v === "string" && def.values.includes(v))) return false;
    if (def.kind === "boolean" && typeof v !== "boolean") return false;
    if (def.kind === "integer" && !(typeof v === "number" && Number.isInteger(v) && v >= def.min && v <= def.max)) return false;
    if (def.kind === "device" && !(typeof v === "string" && target.devices.some((d) => d.id === v && d.kind === def.deviceKind))) return false;
  }
  return true;
}

function render(intent: IntentDef, entry: CommandEntry, target: Target, slots: Readonly<Record<string, unknown>>): string {
  return entry.utteranceTemplate.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const def = (intent.slots as Record<string, IntentDef["slots"][keyof IntentDef["slots"]]>)[name];
    const v = slots[name];
    if (def?.kind === "device") return target.devices.find((d) => d.id === v)?.name ?? "";
    if (def?.kind === "integer") return String(v);
    return (entry.slotText as Record<string, Record<string, string>> | undefined)?.[name]?.[String(v)] ?? "";
  });
}

/**
 * 喚醒詞只能來自同品牌、同助理、同語系的命令包：裝置表指定的（還要屬於這樣的命令包），
 * 否則依序取型號層（型號也相同）、助理層命令包的選定喚醒詞。絕不從通用包或別的品牌、語系拿。
 */
export function wakePhraseFor(catalog: RelayCatalog, target: Target): string | undefined {
  const own = (p: CommandPack) => p.vendor === target.vendor && p.assistant === target.assistant && p.locale === target.locale;
  if (target.wakePhraseId !== undefined) {
    return catalog.packs.filter(own).flatMap((p) => p.wakePhrases).find((w) => w.id === target.wakePhraseId)?.text;
  }
  const model = catalog.packs.filter((p) => own(p) && p.scope === "model" && p.model === target.model);
  const assistant = catalog.packs.filter((p) => own(p) && p.scope === "assistant");
  for (const pack of [...model, ...assistant]) {
    const selected = pack.wakePhrases.find((w) => w.selected);
    if (selected) return selected.text;
  }
  return undefined;
}

/** 層級選定的模板（不看裝置覆寫）：第一個有選定模板的層級；同層多個回 { ambiguous: 層級 }；都沒有是 null。 */
export function levelDefault(catalog: RelayCatalog, target: Target, intentId: string): { pack: CommandPack; entry: CommandEntry; level: ResolveLevel } | { ambiguous: ResolveLevel } | null {
  for (const level of LEVELS) {
    const found = catalog.packs
      .filter((pack) => packLevel(pack, target) === level)
      .flatMap((pack) => pack.entries.filter((e) => e.intentId === intentId && e.selected).map((entry) => ({ pack, entry, level })));
    if (found.length > 1) return { ambiguous: level };
    if (found.length === 1) return found[0]!;
  }
  return null;
}

export function resolveRelay(catalog: RelayCatalog, request: RelayRequest, opts: ResolveOptions = {}): RelayResolution {
  const diag = opts.diagnostic;
  const diagnostic = !!(diag && (diag.candidateTemplateId !== undefined || diag.candidateVoiceId !== undefined));
  /** 只有明確指定候選模板的診斷才可以試還沒審閱的模板；只換聲線不改審閱規則。 */
  const tryCandidate = diag?.candidateTemplateId !== undefined;

  // 1. 目標
  const target = catalog.targets.find((t) => t.id === request.targetId);
  if (!target) return refuse("unknown_target");
  if (!target.enabled) return refuse("target_disabled");

  // 2. 意圖與 slot
  const intent = catalog.intents.find((i) => i.id === request.intentId);
  if (!intent) return refuse("unsupported_intent", "unknown_intent");
  if (!slotsValid(intent, target, request.slots ?? {})) return refuse("invalid_slots");

  // 3. 模板
  let hit: { pack: CommandPack; entry: CommandEntry; level: ResolveLevel } | null = null;
  if (diag?.candidateTemplateId !== undefined) {
    const found = findTemplate(catalog, diag.candidateTemplateId);
    if (!found || found.entry.intentId !== intent.id || !packLevel(found.pack, target)) return refuse("diagnostic_invalid", "template");
    hit = { ...found, level: "diagnostic" };
  } else if (target.templateOverrides[intent.id] !== undefined) {
    const found = findTemplate(catalog, target.templateOverrides[intent.id]!);
    if (!found || found.entry.intentId !== intent.id || !packLevel(found.pack, target)) return refuse("unsupported_intent", "override_incompatible");
    hit = { ...found, level: "device_override" };
  } else {
    const found = levelDefault(catalog, target, intent.id);
    if (found && "ambiguous" in found) return refuse("ambiguous_template", found.ambiguous);
    hit = found;
  }
  if (!hit) return refuse("unsupported_intent", "no_template");
  const { pack, entry, level } = hit;
  if (!entry.supported) return refuse("unsupported_intent", "marked_unsupported");

  // 4. 政策（在審閱之前；診斷也不能繞過）
  const commandText = render(intent, entry, target, request.slots ?? {});
  const policy = relayPolicy(intent, entry, target, commandText);
  if (!policy.ok) return refuse("policy_blocked", policy.detail);

  // 5. 審閱：目錄標成 rejected 的一律拒絕（裝置表不能翻案）；其他以裝置表的審閱紀錄優先（同模板同版本）
  const reviewStatus = entry.status === "rejected" ? "rejected" : (target.reviewedTemplates.find((r) => r.templateId === entry.templateId && r.version === entry.version)?.status ?? entry.status);
  if (reviewStatus === "rejected") return refuse("not_reviewed", "rejected");
  if (reviewStatus === "candidate" && !tryCandidate) return refuse("not_reviewed", "candidate");

  // 6. 聲線（不換聲）
  let profileId: string | undefined;
  if (diag?.candidateVoiceId !== undefined) {
    if (diag.candidateVoiceId !== target.voiceProfileId && !target.candidateVoiceProfileIds.includes(diag.candidateVoiceId)) return refuse("diagnostic_invalid", "voice");
    profileId = diag.candidateVoiceId;
  } else {
    profileId = target.voiceProfileId;
    if (profileId === undefined) {
      const same = catalog.voiceDefaults.filter((d) => d.vendor === target.vendor && d.assistant === target.assistant && d.locale === target.locale);
      profileId = (same.find((d) => d.model === target.model) ?? same.find((d) => d.model === undefined))?.voiceProfileId;
    }
  }
  const profile = profileId === undefined ? undefined : catalog.profiles.find((p) => p.id === profileId);
  if (!profile) return refuse("tts_unavailable", "no_voice");
  if (profile.locale !== target.locale) return refuse("tts_unavailable", "voice_locale");

  // 7. 輸出：聲線指定的輸出端必須就是目標的喇叭；不同就拒絕，絕不把聲音搬到別的喇叭。
  if ((profile.outputNode !== undefined && profile.outputNode !== target.outputNode) || (profile.outputDeviceId !== undefined && profile.outputDeviceId !== target.outputDeviceId)) {
    return refuse("output_unavailable", "output_mismatch");
  }
  const outputNode = target.outputNode;
  const outputDeviceId = target.outputDeviceId;
  if (opts.voiceAvailable && !opts.voiceAvailable(outputNode, profile.engine, profile.voiceId)) return refuse("tts_unavailable", "voice_missing");
  if (!outputNode || !outputDeviceId) return refuse("output_unavailable");

  // 8. 喚醒詞
  const wakePhrase = wakePhraseFor(catalog, target);
  if (!wakePhrase) return refuse("unsupported_intent", "no_wake_phrase");

  // 9. 組字：最後的命令不能含任何喚醒詞（正規化後比對目錄裡所有喚醒詞）
  if (!safeText(commandText)) return refuse("invalid_slots", "rendered_text");
  if (containsWakePhrase(commandText, catalog.packs.flatMap((p) => p.wakePhrases.map((w) => w.text)))) return refuse("invalid_slots", "wake_phrase_in_command");

  return {
    kind: "resolved",
    targetId: target.id,
    intentId: intent.id,
    templateId: entry.templateId,
    templateVersion: entry.version,
    packId: pack.id,
    catalogVersion: catalog.catalogVersion,
    level,
    voiceProfileId: profile.id,
    wakePhrase,
    commandText,
    spokenText: `${wakePhrase} ${commandText}`,
    outputNode,
    outputDeviceId,
    profile,
    testStatus: entry.testResult,
    reviewStatus,
    diagnostic,
    downstreamService: entry.downstreamService,
  };
}
