// 常駐喚醒聆聽（docs/17 §5、ADR-0003；WK-01a）的共用型別、狀態、原因碼、偏好驗證與介面文字。
// 狀態以裝置事件為準（17 §5.1）：只有來源 track 為 live 而且 AudioWorklet 回報開始處理之後才是 listening_local。
// 這個檔案只有型別、常數與純函式；音訊程式在 src/audio/（NOUS_WAKE=on 才以動態 import 載入）。
// 介面文字以繁中為原文，英文在 shared/messages.en.json（共用翻譯表）。

export const WAKE_STATES = ["off", "armed", "listening_local", "paused", "in_call", "released", "error"] as const;
export type WakeState = (typeof WAKE_STATES)[number];

export const WAKE_REASONS = [
  "pref_off",
  "starting",
  "auto_resume",
  "user_pause",
  "sleep",
  "lock",
  "rate_limited",
  "calibrating",
  "realtime",
  "web_speech",
  "permission_denied",
  "device_missing",
  "device_ended",
  "runtime_missing",
  "runtime_load_failed",
  "audio_failed",
  "unsupported",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

/** 每個狀態允許的原因碼（reportState 的白名單；preload.cjs 有同一份，tests/audio-privacy.test.ts 核對兩者相同）。 */
export const WAKE_STATE_REASONS: { readonly [S in WakeState]: readonly (WakeReason | null)[] } = {
  off: [null, "pref_off"],
  armed: ["starting", "auto_resume"],
  listening_local: [null],
  paused: ["user_pause", "sleep", "lock", "rate_limited", "calibrating"],
  in_call: ["realtime"],
  released: ["web_speech"],
  error: ["permission_denied", "device_missing", "device_ended", "runtime_missing", "runtime_load_failed", "audio_failed", "unsupported"],
};

export type WakeErrorReason = "permission_denied" | "device_missing" | "device_ended" | "runtime_missing" | "runtime_load_failed" | "audio_failed" | "unsupported";

/** 回報給 App 選單列的喚醒狀態（只有列舉值）。 */
export interface WakeReport {
  state: WakeState;
  reason: WakeReason | null;
}

export function isWakeReport(value: unknown): value is WakeReport {
  if (!value || typeof value !== "object") return false;
  const { state, reason } = value as Record<string, unknown>;
  if (typeof state !== "string" || !(WAKE_STATES as readonly string[]).includes(state)) return false;
  return (WAKE_STATE_REASONS[state as WakeState] as readonly unknown[]).includes(reason ?? null);
}

// ───────────── 偏好（configDir/wake.json；server/wake-settings.ts 是唯一寫入者） ─────────────

export interface WakePrefs {
  /** 「常駐喚醒聆聽」開關；預設關閉，讀不懂時也是關閉（fail closed）。 */
  wake_listen: boolean;
  /** 上一次真的進入 listening_local 的麥克風 deviceId；自動恢復時以 exact 指定，找不到就 error device_missing。 */
  device_id: string | null;
  /** 喚醒後多久沒人出聲就結束這通（秒，src/audio/wake-call.ts）；只能是 WAKE_SILENCE_OPTIONS_S 其中一個。 */
  wake_silence_s: number;
  /**
   * 「矯正喚醒詞…」套用的門檻（George 2026-11-01）：蓋過清單 shared/wake-runtime.json 每一行的提升分數與門檻；
   * null＝用出貨的清單值（「回復預設」）。偵測器載入時讀這份（src/audio/detector.ts 的 kwsConfig）。
   */
  keyword_overrides: WakeKeywordOverrides | null;
}
export type WakePrefsPatch = Partial<WakePrefs>;

/** 一組關鍵詞（例如 HEY_NOUS 的三種念法）共用的提升分數與門檻。 */
export interface WakeKeywordTuning {
  boost: number;
  threshold: number;
}

export interface WakeKeywordOverrides {
  /** 關鍵詞組（清單 id 去掉最後的念法，wakeKeywordGroup）→ 這組每一行的提升分數與門檻。沒列的組照清單。 */
  groups: Record<string, WakeKeywordTuning>;
  /** 做矯正的人的代號（1–4 個英文字母或數字），不記名字。 */
  code: string;
  /** 套用時間（ISO 8601；核心保存時填上，頁面送來的會被蓋掉）。 */
  at: string | null;
}

/**
 * 覆寫值的範圍：比清單驗證（提升分數 (0, 10]、門檻 (0, 1)）窄，只容許矯正會掃到的附近。
 * 門檻太低會讓電視、家人聊天常常叫醒（每次叫醒就開始外傳聲音），所以下限 0.05；太高等於關掉，上限 0.5。
 */
export const WAKE_OVERRIDE_LIMITS = { boost: { min: 0.5, max: 3 }, threshold: { min: 0.05, max: 0.5 } } as const;
export const WAKE_CALIBRATION_CODE = /^[A-Za-z0-9]{1,4}$/;
const KEYWORD_GROUP = /^[A-Z][A-Z0-9_]{0,31}$/;
const MAX_OVERRIDE_GROUPS = 8;

const inRange = (value: unknown, { min, max }: { readonly min: number; readonly max: number }): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** keyword_overrides 的邊界驗證（null 或完整物件）；不合法時丟 WakePatchError。數字一律四捨五入到小數兩位。 */
export function parseKeywordOverrides(value: unknown): WakeKeywordOverrides | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WakePatchError("keyword_overrides 必須是物件或 null");
  const { groups, code, at, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new WakePatchError("keyword_overrides 只能有 groups、code、at");
  if (typeof code !== "string" || !WAKE_CALIBRATION_CODE.test(code)) throw new WakePatchError("代號必須是 1–4 個英文字母或數字");
  if (at !== undefined && at !== null && (typeof at !== "string" || at.length > 40 || Number.isNaN(Date.parse(at)))) throw new WakePatchError("keyword_overrides.at 格式不正確");
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new WakePatchError("keyword_overrides.groups 必須是物件");
  const entries = Object.entries(groups as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_OVERRIDE_GROUPS) throw new WakePatchError("keyword_overrides.groups 要有 1–8 組");
  const out: Record<string, WakeKeywordTuning> = {};
  for (const [group, tuning] of entries) {
    if (!KEYWORD_GROUP.test(group)) throw new WakePatchError(`不認得的關鍵詞組：${group}`);
    const t = tuning as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || Object.keys(t).sort().join(",") !== "boost,threshold") throw new WakePatchError(`${group} 只能有 boost 與 threshold`);
    if (!inRange(t.boost, WAKE_OVERRIDE_LIMITS.boost)) throw new WakePatchError(`${group} 的提升分數必須在 0.5–3 之間`);
    if (!inRange(t.threshold, WAKE_OVERRIDE_LIMITS.threshold)) throw new WakePatchError(`${group} 的門檻必須在 0.05–0.5 之間`);
    out[group] = { boost: round2(t.boost), threshold: round2(t.threshold) };
  }
  return { groups: out, code, at: typeof at === "string" ? at : null };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 「喚醒後等你開口」的選項（選單列一組 radio）。George 2026-10-31 定 5 秒；2026-11-01 要求可以調整。
 * 下限 3 秒：念完喚醒詞、聽完招呼還來得及開口；上限 20 秒：誤喚醒時麥克風不會外傳太久（17 §5.7）。
 */
export const WAKE_SILENCE_OPTIONS_S = [3, 5, 8, 10, 15, 20] as const;
export const DEFAULT_WAKE_SILENCE_S = 5;

export const DEFAULT_WAKE_PREFS: WakePrefs = { wake_listen: false, device_id: null, wake_silence_s: DEFAULT_WAKE_SILENCE_S, keyword_overrides: null };
export const WAKE_PREF_KEYS = ["wake_listen", "device_id", "wake_silence_s", "keyword_overrides"] as const satisfies readonly (keyof WakePrefs)[];

export class WakePatchError extends Error {}

/** deviceId 是瀏覽器給的不透明字串；只接受可見 ASCII、最多 256 字元。 */
const DEVICE_ID = /^[\x21-\x7e]{1,256}$/;

/**
 * 邊界驗證：只接受 wake_listen（布林）、device_id（字串或 null）、wake_silence_s（選項之一）與 keyword_overrides
 * （parseKeywordOverrides）；其他鍵、空 patch、型別不符一律丟錯。
 */
export function parseWakePatch(input: unknown): WakePrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WakePatchError("喚醒設定必須是 JSON 物件");
  const patch: WakePrefsPatch = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "wake_listen") {
      if (typeof value !== "boolean") throw new WakePatchError("wake_listen 必須是 true 或 false");
      patch.wake_listen = value;
    } else if (key === "device_id") {
      if (value !== null && (typeof value !== "string" || !DEVICE_ID.test(value))) throw new WakePatchError("device_id 格式不正確");
      patch.device_id = value;
    } else if (key === "wake_silence_s") {
      if (!(WAKE_SILENCE_OPTIONS_S as readonly unknown[]).includes(value)) {
        throw new WakePatchError("wake_silence_s 必須是選單裡的秒數（3、5、8、10、15 或 20）");
      }
      patch.wake_silence_s = value as number;
    } else if (key === "keyword_overrides") {
      patch.keyword_overrides = parseKeywordOverrides(value);
    } else {
      throw new WakePatchError(`不認得的喚醒設定：${key}`);
    }
  }
  if (Object.keys(patch).length === 0) throw new WakePatchError("喚醒設定沒有任何欄位");
  return patch;
}

// ───────────── 引擎清單（shared/wake-runtime.json，WK-01b 的格式） ─────────────
// 清單是唯一的設定來源：核心（server/wake-runtime.ts）用它核對與提供檔案，worker（src/audio/detector.ts）用它核對雜湊與
// 產生關鍵詞（keywordsBuf），scripts/wake-setup.mjs --product 用它下載與安裝。這裡只有型別與純函式。

/** release：GitHub Actions 建出的 wasm 與 JS（.github/workflows/wake-wasm.yml）；model_archive：WK-00 已釘住的 KWS 模型壓縮檔。 */
export interface WakeRuntimeFileEntry {
  /** 安裝後的檔名（/wake-runtime/<name>；不含子資料夾）。 */
  name: string;
  role: "runtime" | "model";
  source: "release" | "model_archive";
  /** 小寫 64 位十六進位；第一次 CI 建置之前 release 檔是空字串（不得自行填寫）。 */
  sha256: string;
  /** model_archive：哪一個模型（spike/wake/models.json 的 id）與壓縮檔內的檔名。 */
  model?: string;
  member?: string;
  license: string;
}

export interface WakeRuntimeModel {
  id: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

/** 一個關鍵詞：發音單元（以空白分開）與可選的提升分數（:）、觸發門檻（#）。id 是 `@` 之後的字串。 */
export interface WakeKeywordEntry {
  id: string;
  tokens: string;
  boost: number | null;
  threshold: number | null;
}

export interface WakeKeywordConfig {
  /** pending_owner_numbers：等 George 在 Mac 的 WK-00 每人 5 次試跑數字（17 §14.1 D1），在那之前沒有關鍵詞。 */
  status: "pending_owner_numbers" | "configured";
  model: string | null;
  keywords_score: number | null;
  keywords_threshold: number | null;
  entries: WakeKeywordEntry[];
}

export interface WakeRuntimeManifest {
  schema_version: 1;
  /** pending_first_build：release 檔的雜湊要等第一次 CI 建置；有這個標記時引擎一律不可用。 */
  status: "pending_first_build" | "built";
  url_prefix: string;
  build: {
    workflow: string;
    script: string;
    sherpa_onnx_version: string;
    sherpa_onnx_commit: string;
    emsdk_version: string;
    emsdk_commit: string;
    release_repo: string;
    release_tag: string | null;
    config_sha256: string | null;
  };
  files: WakeRuntimeFileEntry[];
  models: WakeRuntimeModel[];
  keywords: WakeKeywordConfig;
}

/** 三個 release 檔的固定檔名（建置腳本產出、worker 載入）。 */
export const WAKE_RELEASE_FILES = {
  glue: "sherpa-onnx-wasm-kws-main.mjs",
  wasm: "sherpa-onnx-wasm-kws-main.wasm",
  api: "sherpa-onnx-kws.mjs",
} as const;

const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEYWORD_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
/** 發音單元：不含空白與 sherpa-onnx 關鍵詞檔的保留字元（: # @ 換行）。 */
const KEYWORD_TOKEN = /^[^\s:#@]{1,16}$/u;

/** 清單格式檢查；回傳錯誤清單（空的才算格式正確）。不檢查檔案是否存在。 */
export function validateWakeRuntimeManifest(value: unknown): string[] {
  const errors: string[] = [];
  const m = value as Partial<WakeRuntimeManifest> | null;
  if (!m || typeof m !== "object") return ["manifest must be an object"];
  if (m.schema_version !== 1) errors.push("schema_version must be 1");
  if (m.status !== "pending_first_build" && m.status !== "built") errors.push("status must be pending_first_build or built");
  if (m.url_prefix !== "/wake-runtime/") errors.push("url_prefix must be /wake-runtime/");
  const b = m.build;
  if (!b || typeof b !== "object") errors.push("build is required");
  else {
    if (!/^[0-9a-f]{40}$/.test(b.sherpa_onnx_commit ?? "")) errors.push("build.sherpa_onnx_commit must be a full commit SHA");
    if (!/^[0-9a-f]{40}$/.test(b.emsdk_commit ?? "")) errors.push("build.emsdk_commit must be a full commit SHA");
    if (!/^\d+\.\d+\.\d+$/.test(b.sherpa_onnx_version ?? "") || !/^\d+\.\d+\.\d+$/.test(b.emsdk_version ?? "")) errors.push("build versions must be exact x.y.z");
    if (m.status === "built" && !(b.release_tag && SHA256.test(b.config_sha256 ?? ""))) errors.push("built manifests need build.release_tag and build.config_sha256");
    if (m.status === "pending_first_build" && (b.release_tag !== null || b.config_sha256 !== null)) errors.push("pending manifests keep build.release_tag and build.config_sha256 null");
  }
  const files = Array.isArray(m.files) ? m.files : [];
  if (!Array.isArray(m.files)) errors.push("files must be an array");
  const names = new Set<string>();
  for (const f of files) {
    if (!FILE_NAME.test(f?.name ?? "")) errors.push(`bad file name: ${String(f?.name)}`);
    if (names.has(f.name)) errors.push(`duplicate file: ${f.name}`);
    names.add(f.name);
    if (f.role !== "runtime" && f.role !== "model") errors.push(`${f.name}: bad role`);
    if (f.source === "release") {
      if (m.status === "pending_first_build" ? f.sha256 !== "" : !SHA256.test(f.sha256)) errors.push(`${f.name}: release hash must be empty while pending_first_build and a SHA-256 after`);
    } else if (f.source === "model_archive") {
      if (!SHA256.test(f.sha256)) errors.push(`${f.name}: model files need a SHA-256`);
      if (!f.model || !f.member) errors.push(`${f.name}: model files need model and member`);
    } else errors.push(`${f.name}: bad source`);
    if (typeof f.license !== "string" || !f.license) errors.push(`${f.name}: license is required`);
  }
  for (const name of Object.values(WAKE_RELEASE_FILES)) if (!files.some((f) => f.name === name && f.source === "release")) errors.push(`missing release file ${name}`);
  const models = Array.isArray(m.models) ? m.models : [];
  for (const model of models) {
    for (const key of ["encoder", "decoder", "joiner", "tokens"] as const) {
      const f = files.find((x) => x.name === model[key]);
      if (!f || f.source !== "model_archive" || f.model !== model.id) errors.push(`model ${model.id}: ${key} is not a listed file of that model`);
    }
  }
  const k = m.keywords;
  if (!k || typeof k !== "object") errors.push("keywords is required");
  else if (k.status === "pending_owner_numbers") {
    if (k.model !== null || k.keywords_score !== null || k.keywords_threshold !== null || !Array.isArray(k.entries) || k.entries.length !== 0) errors.push("pending keywords must be empty (model, score, threshold null; entries [])");
  } else if (k.status === "configured") {
    if (!models.some((x) => x.id === k.model)) errors.push("keywords.model must be a listed model");
    if (!(typeof k.keywords_score === "number" && k.keywords_score > 0 && k.keywords_score <= 10)) errors.push("keywords_score must be in (0, 10]");
    if (!(typeof k.keywords_threshold === "number" && k.keywords_threshold > 0 && k.keywords_threshold < 1)) errors.push("keywords_threshold must be in (0, 1)");
    if (!Array.isArray(k.entries) || k.entries.length === 0 || k.entries.length > 64) errors.push("keywords.entries must have 1-64 entries");
    const ids = new Set<string>();
    for (const e of k.entries ?? []) {
      if (!KEYWORD_ID.test(e.id) || ids.has(e.id)) errors.push(`bad or duplicate keyword id: ${e.id}`);
      ids.add(e.id);
      const tokens = typeof e.tokens === "string" ? e.tokens.split(" ") : [];
      if (tokens.length === 0 || !tokens.every((t) => KEYWORD_TOKEN.test(t))) errors.push(`${e.id}: tokens must be space-separated units without : # @`);
      if (e.boost !== null && !(typeof e.boost === "number" && e.boost > 0 && e.boost <= 10)) errors.push(`${e.id}: boost must be null or in (0, 10]`);
      if (e.threshold !== null && !(typeof e.threshold === "number" && e.threshold > 0 && e.threshold < 1)) errors.push(`${e.id}: threshold must be null or in (0, 1)`);
    }
  } else errors.push("keywords.status must be pending_owner_numbers or configured");
  return errors;
}

/**
 * 引擎還不能用的理由（空陣列才可能可用；可用與否還要看檔案是否在、雜湊是否相符）。
 * pending_first_build、release 檔沒有雜湊、關鍵詞還在等 George 的數字，都會讓核心回報 missing、worker 回報 runtime_missing。
 */
export function wakeRuntimeBlockers(m: WakeRuntimeManifest): string[] {
  const errors = validateWakeRuntimeManifest(m);
  if (errors.length > 0) return ["manifest_invalid"];
  const blockers: string[] = [];
  if (m.status === "pending_first_build") blockers.push("pending_first_build");
  if (m.files.some((f) => !SHA256.test(f.sha256))) blockers.push("hash_missing");
  if (m.keywords.status !== "configured") blockers.push("keywords_pending");
  return blockers;
}

/** 關鍵詞設定 → sherpa-onnx 關鍵詞檔內容（keywordsBuf）；一行一個：發音單元 [:提升分數] [#門檻] @id。 */
export function wakeKeywordsText(k: WakeKeywordConfig): string {
  return k.entries.map((e) => [e.tokens, e.boost === null ? null : `:${e.boost}`, e.threshold === null ? null : `#${e.threshold}`, `@${e.id}`].filter(Boolean).join(" ")).join("\n") + "\n";
}

/** 關鍵詞組：清單 id 去掉最後一段念法（HEY_NOUS_OW → HEY_NOUS）。同一組的幾行念法共用一組矯正值。 */
export function wakeKeywordGroup(id: string): string {
  const cut = id.lastIndexOf("_");
  return cut > 0 ? id.slice(0, cut) : id;
}

/** 每一組目前在清單上的有效值（行內沒寫就用全域的 keywords_score／keywords_threshold），依清單順序。 */
export function wakeKeywordDefaults(k: WakeKeywordConfig): { group: string; boost: number; threshold: number }[] {
  const out: { group: string; boost: number; threshold: number }[] = [];
  for (const e of k.entries) {
    const group = wakeKeywordGroup(e.id);
    if (out.some((g) => g.group === group)) continue;
    out.push({ group, boost: e.boost ?? k.keywords_score ?? 1, threshold: e.threshold ?? k.keywords_threshold ?? 0.25 });
  }
  return out;
}

/** 把使用者的矯正值蓋到清單的每一行（同一組的每種念法都改）；沒列的組、null 時照清單。不改傳入的物件。 */
export function applyKeywordOverrides(k: WakeKeywordConfig, overrides: WakeKeywordOverrides | null): WakeKeywordConfig {
  if (!overrides) return k;
  return {
    ...k,
    entries: k.entries.map((e) => {
      const tuning = overrides.groups[wakeKeywordGroup(e.id)];
      return tuning ? { ...e, boost: tuning.boost, threshold: tuning.threshold } : e;
    }),
  };
}

/** 只留一組（矯正比較時每個候選各自一個偵測器：同一串發音放在同一份關鍵詞檔會互相覆蓋，不能把幾組門檻放在一起）。 */
export function wakeKeywordsForGroup(k: WakeKeywordConfig, group: string, tuning: WakeKeywordTuning): WakeKeywordConfig {
  return { ...k, entries: k.entries.filter((e) => wakeKeywordGroup(e.id) === group).map((e) => ({ ...e, boost: tuning.boost, threshold: tuning.threshold })) };
}

/** 喚醒引擎檔案（shared/wake-runtime.json）的核對結果；WK-01a 清單是空的，所以一律是 missing。 */
export type WakeRuntimeState = "ok" | "missing" | "hash_mismatch" | "not_configured";

/** SettingsView.wake：只有 NOUS_WAKE=on 時才有這個欄位（關閉時 /api/settings 與之前逐位元組相同）。 */
export interface WakeSettingsView extends WakePrefs {
  runtime: WakeRuntimeState;
}

// ───────────── 喚醒觸發（WK-01 的終點，WK-02 接上 startRealtime("wake_word")） ─────────────

export interface WakeTrigger {
  /** 這次喚醒的識別碼（頁面產生；核心不能拿它當成喚醒真的發生的證據，ADR-0003 §2.2）。 */
  wake_id: string;
  /** 偵測到的時間（頁面時鐘，毫秒）。 */
  detected_at: number;
  /** 關鍵詞清單中的編號（不是文字、不含音訊）。 */
  keyword_index: number;
}

// ───────────── WK-02：喚醒開始的通話（限速、Companion 的共用接口） ─────────────

/**
 * 由喚醒開始的即時語音通話，每個滾動 60 秒最多 3 次（docs/17 §5.7 第 4 點；George 2026-10-31：超過時暫停聆聽、時間到自動恢復）。
 * 核心（RealtimeSessions.start）只計算被接受的 wake_word 開始；其他來源不算。
 */
export const WAKE_START_RATE = { per_minute: 3, window_ms: 60_000 } as const;

/**
 * Companion Mode 的 activation=wake 共用接口（docs/17 §10.4、15 §3.1；WK-02 只交付契約）。
 * 每次喚醒觸發（提示音播完、沒有取消、仍在 listening_local）通知一次；只有識別碼、時間與關鍵詞編號，不含音訊或文字。
 */
export interface WakeActivation {
  activation: "wake";
  wake_id: string;
  detected_at: number;
  keyword_index: number;
}

export interface WakeActivationPort {
  /** 訂閱喚醒觸發；回傳取消訂閱。 */
  subscribe(listener: (activation: WakeActivation) => void): () => void;
}

/** 頁面送到核心的 wake_id 格式（只接受這種；核心不拿它當成喚醒真的發生的證據）。 */
export const WAKE_ID = /^int_[0-9a-f]{16}$/;

// ───────────── worker 協定：worker 只送出事件，不送出任何樣本（started／detected／load_error／closed；矯正另有 clip／scan／sweep_done） ─────────────

export type WakeWorkerOut =
  | { type: "started" }
  /** worker 已清空環形緩衝並釋放偵測器（收到 close 之後），主執行緒等到它才 terminate。 */
  | { type: "closed" }
  | { type: "detected"; keyword_index: number }
  | { type: "load_error"; reason: "runtime_missing" | "runtime_load_failed" }
  /** 矯正：第 clip 段錄完，用目前的設定掃過的結果（keyword_index 是清單編號，-1＝沒有偵測到）。 */
  | { type: "clip"; clip: number; keyword_index: number }
  /** 矯正：第 candidate 個候選掃第 clip 段的結果（keyword_index 是清單編號，-1＝沒有偵測到）。 */
  | { type: "scan"; candidate: number; clip: number; keyword_index: number }
  /** 矯正：全部候選掃完。 */
  | { type: "sweep_done" };

/** 矯正一次最多錄幾段、比較幾個候選（worker 與檢查共用）。 */
export const WAKE_CALIBRATION_MAX_CLIPS = 64;
export const WAKE_CALIBRATION_MAX_CANDIDATES = 32;

const intIn = (value: unknown, min: number, max: number): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) < max;

/**
 * worker 送出訊息的完整檢查：只接受上面幾種形狀，欄位只能是字串或整數，不能有型別陣列、ArrayBuffer、陣列或多餘欄位。
 * 主執行緒收到不符的訊息一律丟掉（tests/audio-privacy.test.ts 另外靜態檢查 worker 的 postMessage）。
 */
export function isWakeWorkerOut(value: unknown): value is WakeWorkerOut {
  if (!value || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (o.type === "started" || o.type === "closed" || o.type === "sweep_done") return keys === "type";
  if (o.type === "detected") return keys === "keyword_index,type" && intIn(o.keyword_index, 0, 64);
  if (o.type === "load_error") return keys === "reason,type" && (o.reason === "runtime_missing" || o.reason === "runtime_load_failed");
  if (o.type === "clip") return keys === "clip,keyword_index,type" && intIn(o.clip, 0, WAKE_CALIBRATION_MAX_CLIPS) && intIn(o.keyword_index, -1, 64);
  if (o.type === "scan") {
    return keys === "candidate,clip,keyword_index,type" && intIn(o.candidate, 0, WAKE_CALIBRATION_MAX_CANDIDATES) && intIn(o.clip, 0, WAKE_CALIBRATION_MAX_CLIPS) && intIn(o.keyword_index, -1, 64);
  }
  return false;
}

/** 矯正比較的一個候選：某一組關鍵詞換成這組提升分數與門檻（主執行緒送進 worker；只有數字與組名）。 */
export interface WakeSweepCandidate extends WakeKeywordTuning {
  group: string;
}

/** worker 收到的候選清單檢查：不合法就整份丟掉（回 null），不猜。 */
export function parseSweepCandidates(value: unknown): WakeSweepCandidate[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > WAKE_CALIBRATION_MAX_CANDIDATES) return null;
  const out: WakeSweepCandidate[] = [];
  for (const c of value) {
    if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== "boost,group,threshold") return null;
    const { group, boost, threshold } = c as Record<string, unknown>;
    if (typeof group !== "string" || !KEYWORD_GROUP.test(group) || !inRange(boost, WAKE_OVERRIDE_LIMITS.boost) || !inRange(threshold, WAKE_OVERRIDE_LIMITS.threshold)) return null;
    out.push({ group, boost, threshold });
  }
  return out;
}

// ───────────── 介面文字（共用翻譯表） ─────────────

export const WAKE_WORD_TEXT = "Hello Nous／Hey Nous";

export const WAKE_STATE_LABEL: { readonly [S in WakeState]: string } = {
  off: "未開啟",
  armed: "準備中",
  listening_local: "本機聆聽中",
  paused: "已暫停",
  in_call: "通話中",
  released: "已讓出麥克風",
  error: "無法使用",
};

export const WAKE_REASON_LABEL: { readonly [R in WakeReason]: string } = {
  pref_off: "常駐喚醒聆聽已關閉",
  starting: "正在取得麥克風",
  auto_resume: "正在自動恢復",
  user_pause: "暫停到這次結束；App 重開後會自動恢復，要長期停止請關掉開關",
  sleep: "系統睡眠中",
  lock: "螢幕已鎖定",
  rate_limited: "一分鐘內已由喚醒開始 3 次通話，暫停到一分鐘後自動恢復",
  calibrating: "正在矯正喚醒詞，結束後自動恢復",
  realtime: "即時語音使用中，喚醒偵測暫停",
  web_speech: "按下說話或語音模式使用中，喚醒偵測暫停",
  permission_denied: "麥克風權限被拒，常駐聆聽沒有開啟",
  device_missing: "找不到上次使用的麥克風",
  device_ended: "麥克風已拔除或停止，沒有改用其他麥克風",
  runtime_missing: "喚醒引擎尚未安裝，沒有開啟麥克風",
  runtime_load_failed: "喚醒引擎載入失敗，已停止收音",
  audio_failed: "無法開始本機收音",
  unsupported: "這個環境不支援本機收音",
};

/** 選單列與畫面上的固定文字。 */
export const WAKE_TEXT = {
  group: "喚醒詞",
  statusPrefix: "喚醒聆聽",
  listen: "常駐喚醒聆聽",
  listenNote: "只在這台 Mac 本機偵測「Hello Nous」或「Hey Nous」",
  silence: "喚醒後等你開口",
  silenceNote: "喚醒後這麼久沒聽到聲音就結束這通；Nous 說話時不算",
  pause: "暫停聆聽（到這次結束）",
  resume: "繼續聆聽",
  speaker: "通話中辨認說話者",
  speakerNote: "SP-02 之後才能使用",
  heard: "聽到了",
  resumed: "已恢復常駐喚醒聆聽（只在本機偵測「Hello Nous」或「Hey Nous」）",
  failed: "常駐喚醒聆聽沒有開啟：{0}",
  stopped: "常駐喚醒聆聽已停止：{0}",
  notReported: "尚未回報",
  indicator: "本機聆聽喚醒詞中",
  dialogMessage: "要開啟常駐喚醒聆聽嗎？",
  dialogDetail:
    "開啟後麥克風會常駐開著，只在這台 Mac 本機偵測「Hello Nous」或「Hey Nous」。沒有喚醒時的聲音只留在記憶體中約 2 秒，不寫檔、不進紀錄、不上傳。App 重開與睡眠回來後會自動恢復，直到你關掉這個開關；「暫停聆聽」只到這次結束。",
  dialogRuntimeMissing: "目前還沒有安裝喚醒引擎：開啟後會顯示「無法使用」，不會開啟麥克風。",
  dialogEnable: "開啟",
  dialogCancel: "取消",
  notSaved: "常駐喚醒聆聽沒有保存",
  /** WK-02：喚醒開始的通話在使用者沒出聲 5 秒後自動結束。 */
  noVoice: "沒有聽到聲音，已結束通話，回到喚醒聆聽",
  /** WK-02：喚醒時即時語音不能用（{0} 是原因）。 */
  unavailable: "即時語音目前不可用（{0}）",
  /** 「矯正喚醒詞…」（George 2026-11-01）的選單列文字；畫面文字在 src/wake-calibration-view.ts。 */
  calibrate: "矯正喚醒詞…",
  calibrateNote: "依提示念幾次，替這個家重新選門檻",
  calibratedNote: "目前用代號 {0} 的矯正值",
  calibrateUnavailable: "喚醒引擎可以使用後才能矯正",
} as const;
