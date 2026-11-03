// VCR-0（docs/19）：Voice Command Relay 的共用型別、列舉與純函式（試驗統計）。
// 這裡沒有 I/O、沒有裝置、沒有播音；資料分三層：意圖目錄 → 命令包（品牌／型號／語系的說法）→ 聲線設定，
// 裝置表（Target）只用 ID 參照這三層。所有命令說法都是待實測的候選，不是任何廠商的相容保證。

export const RELAY_SCHEMA_VERSION = 1 as const;

export const VENDORS = ["google", "apple", "amazon", "xiaomi"] as const;
export type Vendor = (typeof VENDORS)[number];

export const ASSISTANTS = ["google_assistant", "siri", "alexa", "xiaoai"] as const;
export type Assistant = (typeof ASSISTANTS)[number];

/** 語系（例如 zh-TW、en-US、zh-CN）；只做完全相同的比對，絕不退回其他語系。 */
export const RELAY_LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
export type RelayLocale = string;

export const INTENT_IDS = ["music.next", "music.pause", "music.resume", "music.play_genre", "volume.set", "light.power", "light.brightness", "assistant.timer"] as const;
export type IntentId = (typeof INTENT_IDS)[number];

export const SLOT_NAMES = ["genre", "device", "on", "percent", "seconds"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export const GENRES = ["pop", "jazz", "classical", "rock", "lofi", "kids"] as const;

export type SlotDef =
  | { kind: "enum"; values: readonly string[]; required: true }
  | { kind: "boolean"; required: true }
  | { kind: "integer"; min: number; max: number; required: true }
  | { kind: "device"; deviceKind: "light"; required: true };

export interface IntentDef {
  id: IntentId;
  /** 只有 low 可以播；high（付款、門鎖、保全、購物、帳號）一律被政策擋下。V1 沒有任何 high 意圖。 */
  riskClass: "low" | "high";
  category: "music" | "volume" | "light" | "timer";
  slots: Readonly<Partial<Record<SlotName, SlotDef>>>;
}

export const PACK_SCOPES = ["model", "assistant", "vendor", "generic"] as const;
export type PackScope = (typeof PACK_SCOPES)[number];

export const DOWNSTREAM_SERVICES = ["assistant_builtin", "configured_music_service", "smart_home", "spotify", "other"] as const;
export type DownstreamService = (typeof DOWNSTREAM_SERVICES)[number];

export const TEMPLATE_STATUSES = ["candidate", "approved", "rejected"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEST_RESULTS = ["NOT_TESTED", "PASS", "FAIL"] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export interface WakePhrase {
  id: string;
  text: string;
  selected: boolean;
}

export interface CommandEntry {
  templateId: string;
  version: number;
  intentId: IntentId;
  /** 命令說法；{slot} 是佔位符。不含喚醒詞。 */
  utteranceTemplate: string;
  /** enum／boolean slot 在這個語系的說法（boolean 用 "true"／"false" 當鍵）。 */
  slotText?: Readonly<Partial<Record<SlotName, Readonly<Record<string, string>>>>>;
  selected: boolean;
  supported: boolean;
  status: TemplateStatus;
  downstreamService: DownstreamService;
  source: string;
  testedOn: string | null;
  testResult: TestResult;
}

export interface CommandPack {
  id: string;
  version: number;
  scope: PackScope;
  vendor?: Vendor;
  assistant?: Assistant;
  model?: string;
  locale: RelayLocale;
  compatibleAssistants?: readonly Assistant[];
  wakePhrases: readonly WakePhrase[];
  entries: readonly CommandEntry[];
}

export const TTS_ENGINES = ["macos_say", "browser_speech", "local_tts"] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];

export const SAMPLE_RATES = [16000, 22050, 24000, 44100, 48000] as const;
export const AUDIO_FORMATS = ["wav", "aiff", "pcm16"] as const;

export interface VoiceProfile {
  id: string;
  engine: TtsEngine;
  voiceId: string;
  modelId?: string;
  modelVersion?: string;
  locale: RelayLocale;
  /** 語速倍率 0.5–2.0。 */
  rate: number;
  /** 音高（半音）-12–12。 */
  pitch: number;
  /** 增益（dB）-30–6。 */
  gainDb: number;
  wakeToCommandPauseMs: number;
  leadSilenceMs: number;
  tailSilenceMs: number;
  outputSampleRateHz?: (typeof SAMPLE_RATES)[number];
  format?: (typeof AUDIO_FORMATS)[number];
  outputNode?: string;
  outputDeviceId?: string;
  testedAt: string | null;
  recognitionStatsId: string | null;
  /** 內建示範資料：沒有在任何 Mac 上驗證過這個聲音。 */
  fixture?: boolean;
}

export interface VoiceDefault {
  vendor: Vendor;
  assistant: Assistant;
  model?: string;
  locale: RelayLocale;
  voiceProfileId: string;
}

export const MUSIC_SERVICES = ["youtube_music", "apple_music", "spotify", "other", "unknown"] as const;
export type MusicService = (typeof MUSIC_SERVICES)[number];

export interface ReviewedTemplate {
  templateId: string;
  version: number;
  status: "approved" | "rejected";
  reviewedAt: string;
  note?: string;
}

export interface TargetDevice {
  id: string;
  kind: "light";
  /** 目標語系裡的說法；只用來組命令，不交給模型。 */
  name: string;
}

export interface Target {
  id: string;
  vendor: Vendor;
  assistant: Assistant;
  model: string;
  locale: RelayLocale;
  enabled: boolean;
  outputNode: string;
  outputDeviceId: string;
  voiceProfileId?: string;
  candidateVoiceProfileIds: readonly string[];
  wakePhraseId?: string;
  templateOverrides: Readonly<Partial<Record<IntentId, string>>>;
  reviewedTemplates: readonly ReviewedTemplate[];
  musicService: MusicService;
  devices: readonly TargetDevice[];
  /** 內建示範目標（只在 NOUS_VCR=fake）。 */
  fixture?: boolean;
}

export interface RelayCatalog {
  schemaVersion: typeof RELAY_SCHEMA_VERSION;
  catalogVersion: number;
  intents: readonly IntentDef[];
  packs: readonly CommandPack[];
  profiles: readonly VoiceProfile[];
  voiceDefaults: readonly VoiceDefault[];
  targets: readonly Target[];
}

export const RELAY_REFUSALS = [
  "unknown_target",
  "target_disabled",
  "unsupported_intent",
  "invalid_slots",
  "ambiguous_template",
  "not_reviewed",
  "policy_blocked",
  "tts_unavailable",
  "output_unavailable",
  "diagnostic_invalid",
] as const;
export type RelayRefusal = (typeof RELAY_REFUSALS)[number];

export type ResolveLevel = "diagnostic" | "device_override" | "model_locale" | "assistant_locale" | "vendor_locale" | "generic";

// ---- 試驗紀錄與統計（docs/experiments/VOICE_COMMAND_RELAY_TEST_PLAN.md §C 量測公式） ----

export interface RelayTrial {
  id: string;
  targetId: string;
  templateId: string;
  templateVersion: number;
  voiceProfileId: string;
  at: string;
  kind: "positive" | "negative";
  /** positive：音箱有沒有被喚醒；negative：有沒有誤喚醒。 */
  wake: "WAKE_OK" | "NO_WAKE" | "UNKNOWN";
  /** 只有 positive 有意義；沒有喚醒時一定是 NO_COMMAND。 */
  command: "COMMAND_OK" | "WRONG_COMMAND" | "NO_COMMAND" | "UNKNOWN";
  evidence: "visual" | "human_confirmed" | "device_state_api";
  review: "reviewed" | "pending";
}

/** 比率：分母是 0 時 value 為 null（N/A），不捏造數字。 */
export interface Rate {
  num: number;
  den: number;
  value: number | null;
}

export interface TrialSummary {
  key: string;
  targetId: string;
  templateId: string;
  templateVersion: number;
  voiceProfileId: string;
  /** 已審閱的 positive 試驗數。 */
  trials: number;
  wakeDetected: number;
  correctCommand: number;
  wrongCommand: number;
  unknown: number;
  negativeTrials: number;
  falseWake: number;
  /** 還沒審閱的試驗（不列入任何比率）。 */
  pending: number;
  wakeRate: Rate;
  commandRate: Rate;
  endToEndRate: Rate;
  falseWakeRate: Rate;
  status: "NOT_TESTED" | "MEASURED";
}

export function rate(num: number, den: number): Rate {
  return { num, den, value: den === 0 ? null : num / den };
}

/** 依 target｜template@version｜voice 分組；只算已審閱的試驗。 */
export function summarizeTrials(trials: readonly RelayTrial[]): TrialSummary[] {
  const groups = new Map<string, TrialSummary>();
  for (const t of trials) {
    // JSON 陣列當鍵：ID 裡有 | 或 @ 也不會撞在一起。
    const key = JSON.stringify([t.targetId, t.templateId, t.templateVersion, t.voiceProfileId]);
    let g = groups.get(key);
    if (!g) {
      g = { key, targetId: t.targetId, templateId: t.templateId, templateVersion: t.templateVersion, voiceProfileId: t.voiceProfileId, trials: 0, wakeDetected: 0, correctCommand: 0, wrongCommand: 0, unknown: 0, negativeTrials: 0, falseWake: 0, pending: 0, wakeRate: rate(0, 0), commandRate: rate(0, 0), endToEndRate: rate(0, 0), falseWakeRate: rate(0, 0), status: "NOT_TESTED" };
      groups.set(key, g);
    }
    if (t.review !== "reviewed") {
      g.pending++;
      continue;
    }
    if (t.wake === "UNKNOWN" || t.command === "UNKNOWN") g.unknown++;
    if (t.kind === "negative") {
      g.negativeTrials++;
      if (t.wake === "WAKE_OK") g.falseWake++;
      continue;
    }
    g.trials++;
    if (t.wake === "WAKE_OK") g.wakeDetected++;
    if (t.wake === "WAKE_OK" && t.command === "COMMAND_OK") g.correctCommand++;
    if (t.wake === "WAKE_OK" && t.command === "WRONG_COMMAND") g.wrongCommand++;
  }
  const out = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const g of out) {
    g.wakeRate = rate(g.wakeDetected, g.trials);
    g.commandRate = rate(g.correctCommand, g.wakeDetected);
    g.endToEndRate = rate(g.correctCommand, g.trials);
    g.falseWakeRate = rate(g.falseWake, g.negativeTrials);
    g.status = g.trials === 0 ? "NOT_TESTED" : "MEASURED";
  }
  return out;
}
