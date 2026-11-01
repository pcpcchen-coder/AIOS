// 聲音輸入／輸出裝置的選擇（docs/validation/audio-devices-2026-11-01.md；George 2026-11-01）。
// 偏好存在 configDir/audio.json（server/audio-settings.ts 是唯一寫入者）；null＝系統預設。
// 這個檔案只有型別、常數與純函式：邊界驗證、頁面回報給選單列的裝置清單整理，以及兩個介面共用的狀態句。
// 狀態以裝置事件為準：「使用中」只來自真的開著的 track（getSettings().deviceId）或播放元素的 sinkId。
// 介面文字以繁中為原文，英文在 src/messages.en.json 與 desktop/messages.en.json（共用翻譯表）。

/** deviceId 是瀏覽器給的不透明字串；只接受可見 ASCII、最多 256 字元（原本在 shared/wake.ts）。 */
export const DEVICE_ID = /^[\x21-\x7e]{1,256}$/;
/** 裝置名稱最多 128 字元；不收控制字元。 */
export const DEVICE_LABEL_MAX = 128;
/** 回報給選單列的清單，每一種最多幾個裝置。 */
export const DEVICE_LIST_MAX = 24;
/** 瀏覽器自己的別名（Chromium 的 "default"、Windows 的 "communications"）：不當成一個裝置列出。 */
export const ALIAS_DEVICE_IDS = ["default", "communications"] as const;

export interface AudioPrefs {
  /** 選定的麥克風 deviceId；null＝系統預設。 */
  input_device_id: string | null;
  /** 選定時的裝置名稱（deviceId 換掉時用名稱找回；也用來顯示「找不到「X」」）。 */
  input_label: string | null;
  /** 選定的聲音輸出 deviceId；null＝系統預設。 */
  output_device_id: string | null;
  output_label: string | null;
}
export type AudioPrefsPatch = Partial<AudioPrefs>;

export const DEFAULT_AUDIO_PREFS: AudioPrefs = { input_device_id: null, input_label: null, output_device_id: null, output_label: null };
export const AUDIO_PREF_KEYS = ["input_device_id", "input_label", "output_device_id", "output_label"] as const satisfies readonly (keyof AudioPrefs)[];
export const AUDIO_WRITE_PATH = "/api/settings/audio";

/** /api/settings 的 audio 欄位：偏好與寫入路徑（核心一定提供；不綁任何 .env 旗標）。 */
export interface AudioSettingsView {
  prefs: AudioPrefs;
  write_path: typeof AUDIO_WRITE_PATH;
}

export class AudioPatchError extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/;

export function isDeviceLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DEVICE_LABEL_MAX && !CONTROL.test(value);
}

/** 邊界驗證：只接受四個鍵；deviceId 是可見 ASCII 或 null，名稱是 128 字以內的字串或 null。其他鍵、空 patch、型別不符一律丟錯。 */
export function parseAudioPatch(input: unknown): AudioPrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AudioPatchError("聲音裝置設定必須是 JSON 物件");
  const patch: AudioPrefsPatch = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "input_device_id" || key === "output_device_id") {
      if (value !== null && (typeof value !== "string" || !DEVICE_ID.test(value))) throw new AudioPatchError(`${key} 格式不正確`);
      patch[key] = value;
    } else if (key === "input_label" || key === "output_label") {
      if (value !== null && !isDeviceLabel(value)) throw new AudioPatchError(`${key} 必須是 128 字以內的裝置名稱`);
      patch[key] = value;
    } else {
      throw new AudioPatchError(`不認得的聲音裝置設定：${key}`);
    }
  }
  if (Object.keys(patch).length === 0) throw new AudioPatchError("聲音裝置設定沒有任何欄位");
  return patch;
}

// ───────────── 頁面回報的裝置清單（preload.cjs 與 desktop/settings-menu.mjs 各有同樣規則的整理） ─────────────

export interface AudioDevice {
  /** deviceId（可見 ASCII，最多 256 字元）。 */
  id: string;
  /** 裝置名稱；麥克風還沒授權時瀏覽器給空字串。 */
  label: string;
}

/** 真的在用的裝置；id 為 null＝系統預設（播放元素的 sinkId 是空字串）。 */
export interface AudioInUse {
  id: string | null;
  label: string;
}

export interface AudioReport {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** 系統預設目前指向哪一個（Chromium "default" 項目的名稱，去掉「Default - 」）；不知道時 null。 */
  default_input: string | null;
  default_output: string | null;
  /** 開著的麥克風 track 的裝置；沒有開著的麥克風時 null。 */
  input_in_use: AudioInUse | null;
  /** 開著的播放元素或提示音的 sinkId；沒有在播時 null。 */
  output_in_use: AudioInUse | null;
  /** 最近一次開麥克風時，選定的裝置找不到而改用系統預設。 */
  input_fallback: boolean;
  /** 最近一次設定播放裝置時，選定的裝置找不到而改用系統預設。 */
  output_fallback: boolean;
  /** 瀏覽器有沒有給裝置名稱（麥克風授權之前是空字串）。 */
  labels: boolean;
}

/** 回報給選單列的版本：加上頁面算好的兩句狀態（選單列不重算，句子只能是 AUDIO_STATUS_TEXTS 其中之一）。 */
export interface AudioMenuReport extends AudioReport {
  input_status: AudioLine;
  output_status: AudioLine;
}

export const EMPTY_AUDIO_REPORT: AudioReport = {
  inputs: [], outputs: [], default_input: null, default_output: null, input_in_use: null, output_in_use: null,
  input_fallback: false, output_fallback: false, labels: false,
};

function cleanLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, DEVICE_LABEL_MAX);
}

function cleanDevice(value: unknown): AudioDevice | null {
  if (!value || typeof value !== "object") return null;
  const { id, label } = value as Record<string, unknown>;
  if (typeof id !== "string" || !DEVICE_ID.test(id)) return null;
  return { id, label: cleanLabel(label) };
}

function cleanInUse(value: unknown): AudioInUse | null {
  if (!value || typeof value !== "object") return null;
  const { id, label } = value as Record<string, unknown>;
  if (id !== null && (typeof id !== "string" || !DEVICE_ID.test(id))) return null;
  return { id: id as string | null, label: cleanLabel(label) };
}

function cleanLine(value: unknown): AudioLine | null {
  if (!value || typeof value !== "object") return null;
  const { text, values } = value as Record<string, unknown>;
  if (typeof text !== "string" || !(AUDIO_STATUS_TEXTS as readonly string[]).includes(text)) return null;
  const list = Array.isArray(values) ? values.slice(0, 1).map(cleanLabel) : [];
  return { text, values: list };
}

/** 頁面回報給選單列的清單與狀態句整理成固定形狀（preload.cjs 與 desktop/settings-menu.mjs 有同樣規則的副本，測試核對）。 */
export function sanitizeAudioMenuReport(value: unknown): AudioMenuReport | null {
  const report = sanitizeAudioReport(value);
  if (!report) return null;
  const v = value as Record<string, unknown>;
  const input = cleanLine(v.input_status);
  const output = cleanLine(v.output_status);
  if (!input || !output) return null;
  return { ...report, input_status: input, output_status: output };
}

/** 頁面回報的清單整理成固定形狀：每種最多 24 個、id 可見 ASCII 256 字內、名稱 128 字內；不符的項目丟掉。 */
export function sanitizeAudioReport(value: unknown): AudioReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const list = (items: unknown) => (Array.isArray(items) ? items.map(cleanDevice).filter((d): d is AudioDevice => d !== null).slice(0, DEVICE_LIST_MAX) : []);
  const name = (x: unknown) => (typeof x === "string" && x ? cleanLabel(x) : null);
  return {
    inputs: list(v.inputs),
    outputs: list(v.outputs),
    default_input: name(v.default_input),
    default_output: name(v.default_output),
    input_in_use: cleanInUse(v.input_in_use),
    output_in_use: cleanInUse(v.output_in_use),
    input_fallback: v.input_fallback === true,
    output_fallback: v.output_fallback === true,
    labels: v.labels === true,
  };
}

// ───────────── 介面文字（頁面設定畫面與選單列共用同樣的句子；desktop/settings-menu.mjs 有同一份，測試核對） ─────────────

export const AUDIO_TEXT = {
  group: "聲音",
  input: "聲音輸入",
  output: "聲音輸出",
  systemDefault: "系統預設",
  systemDefaultNow: "系統預設（目前：{0}）",
  inUse: "使用中：{0}",
  missing: "找不到「{0}」，暫用系統預設",
  noMic: "目前沒有開著的麥克風",
  nextPlayback: "播放時使用：{0}",
  notFoundOption: "{0}（目前找不到）",
  notReportedOption: "{0}（尚未回報）",
  unnamedInput: "未命名的麥克風 {0}",
  unnamedOutput: "未命名的聲音輸出 {0}",
  unknownDevice: "（名稱未知的裝置）",
  needPermission: "授權麥克風後才會列出裝置名稱",
  bluetoothHint: "藍牙耳機當麥克風會切到低音質通話模式；建議麥克風留在 Mac、聲音輸出選藍牙喇叭",
  systemSpeechHint: "按下說話與系統朗讀（語音模式、校準陌生聲音）一律用 Mac 的系統輸入／輸出",
  nextCall: "下一通起使用「{0}」",
  nextCallDefault: "下一通起使用系統預設麥克風",
  outputLost: "「{0}」已中斷，改由系統預設播放",
  outputBack: "已改回「{0}」播放",
  notReported: "尚未回報",
} as const;

/** 狀態句只能是這幾句（選單列的白名單）。 */
export const AUDIO_STATUS_TEXTS = [AUDIO_TEXT.inUse, AUDIO_TEXT.missing, AUDIO_TEXT.noMic, AUDIO_TEXT.nextPlayback, AUDIO_TEXT.notReported] as const;
/** 狀態句裡要翻譯的值（介面字，不是裝置名稱）。 */
export const AUDIO_UI_VALUES = [AUDIO_TEXT.systemDefault, AUDIO_TEXT.unknownDevice] as const;

/** 一句狀態：text 是翻譯表的原文，values 是要代入的裝置名稱（不翻譯）。 */
export interface AudioLine {
  text: string;
  values: string[];
}

/**
 * 保存的選擇沒有名稱、清單裡卻有那一支的名稱時，要補上的 patch（同時帶 deviceId，名稱一定屬於那一支）；不用補時 null。
 */
export function labelBackfill(prefs: AudioPrefs, report: AudioReport): AudioPrefsPatch | null {
  if (!report.labels) return null;
  const patch: AudioPrefsPatch = {};
  const input = prefs.input_device_id && !prefs.input_label ? report.inputs.find((d) => d.id === prefs.input_device_id)?.label : undefined;
  const output = prefs.output_device_id && !prefs.output_label ? report.outputs.find((d) => d.id === prefs.output_device_id)?.label : undefined;
  if (input && isDeviceLabel(input)) Object.assign(patch, { input_device_id: prefs.input_device_id, input_label: input });
  if (output && isDeviceLabel(output)) Object.assign(patch, { output_device_id: prefs.output_device_id, output_label: output });
  return Object.keys(patch).length ? patch : null;
}

/** 偏好的裝置名稱：清單裡找得到就用清單的（較新），否則用保存的名稱。 */
export function preferredLabel(id: string | null, saved: string | null, devices: readonly AudioDevice[]): string | null {
  if (id === null) return null;
  const listed = devices.find((d) => d.id === id)?.label;
  return listed || saved || null;
}

/** 偏好的裝置是不是在清單裡（id 相同，或名稱相同）。清單是空的（還沒回報）時當成不知道（true）。 */
export function preferredPresent(id: string | null, saved: string | null, devices: readonly AudioDevice[]): boolean {
  if (id === null || devices.length === 0) return true;
  return devices.some((d) => d.id === id || (!!saved && d.label === saved));
}

/** 聲音輸入的狀態句（兩個介面共用）。 */
export function inputStatus(prefs: AudioPrefs, report: AudioReport | null): AudioLine {
  if (!report) return { text: AUDIO_TEXT.notReported, values: [] };
  const name = preferredLabel(prefs.input_device_id, prefs.input_label, report.inputs) ?? AUDIO_TEXT.unknownDevice;
  if (prefs.input_device_id !== null && report.input_fallback && report.input_in_use) return { text: AUDIO_TEXT.missing, values: [name] };
  if (report.input_in_use) return { text: AUDIO_TEXT.inUse, values: [report.input_in_use.label || inUseFallbackLabel(report.input_in_use, report.default_input)] };
  if (prefs.input_device_id !== null && (report.input_fallback || !preferredPresent(prefs.input_device_id, prefs.input_label, report.inputs))) {
    return { text: AUDIO_TEXT.missing, values: [name] };
  }
  return { text: AUDIO_TEXT.noMic, values: [] };
}

/** 聲音輸出的狀態句（兩個介面共用）。 */
export function outputStatus(prefs: AudioPrefs, report: AudioReport | null): AudioLine {
  if (!report) return { text: AUDIO_TEXT.notReported, values: [] };
  const name = preferredLabel(prefs.output_device_id, prefs.output_label, report.outputs) ?? AUDIO_TEXT.unknownDevice;
  if (prefs.output_device_id !== null && (report.output_fallback || !preferredPresent(prefs.output_device_id, prefs.output_label, report.outputs))) {
    return { text: AUDIO_TEXT.missing, values: [name] };
  }
  if (report.output_in_use) return { text: AUDIO_TEXT.inUse, values: [report.output_in_use.label || inUseFallbackLabel(report.output_in_use, report.default_output)] };
  const next = prefs.output_device_id === null ? report.default_output ?? AUDIO_TEXT.systemDefault : name;
  return { text: AUDIO_TEXT.nextPlayback, values: [next] };
}

function inUseFallbackLabel(use: AudioInUse, defaultLabel: string | null): string {
  if (use.id === null) return defaultLabel ?? AUDIO_TEXT.systemDefault;
  return AUDIO_TEXT.unknownDevice;
}
