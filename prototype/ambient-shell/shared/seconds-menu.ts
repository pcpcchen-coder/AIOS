// 選單列「鏡頭與語音設定」的描述：數值設定（秒數與倍率）與鏡頭的開關，給選單列直接畫
// （SettingsView.seconds；欄位名沿用最早只有秒數時的名稱，現在以 kind 區分 seconds／factor／bool）。
// 由核心從 CAMERA_PREFS、VOICE_PREFS 與目前的值推導；desktop/main.mjs 不知道任何鍵、範圍、選項、標籤或寫入路徑，
// 照這裡的列畫出來。
import { formatNumberPref, type BoolPrefSpec, type FactorKeyOf, type NumberPrefSpec, type SecondsKeyOf } from "./prefs.ts";
import { CAMERA_PREFS, type CameraSettings } from "./sense.ts";
import type { RealtimeBaseInfo } from "./types.ts";
import { VOICE_PREFS, type VoicePrefs } from "./voice-prefs.ts";

export type CameraSecondsKey = SecondsKeyOf<typeof CAMERA_PREFS>;
export type SecondsKey = CameraSecondsKey | keyof VoicePrefs;
export type FactorKey = FactorKeyOf<typeof CAMERA_PREFS>;
/** 鏡頭的開關（CAMERA_PREFS 裡 kind 為 bool 的鍵）。 */
export type CameraBoolKey = { [K in keyof typeof CAMERA_PREFS]: (typeof CAMERA_PREFS)[K] extends { kind: "bool" } ? K : never }[keyof typeof CAMERA_PREFS];
export type MenuNumberKey = SecondsKey | FactorKey;
export type MenuPrefKey = MenuNumberKey | CameraBoolKey;

export const CAMERA_DISABLED_REASON = "鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）";
export const VOICE_UNSAVED_REASON = "核心沒有語音設定檔，無法保存";
export const CAMERA_OFF_PREVIEW_REASON = "鏡頭目前關閉，勾選「鏡頭」後才能顯示畫面";

export interface MenuPrefOption {
  value: number;
  /** 「1.5 秒（預設）」「2 分鐘」「2 倍（預設）」；目前的值不是選項時另加一項「1.6 秒（目前）」。 */
  label: string;
  checked: boolean;
}

/** 選單列每一列共用的欄位。 */
interface MenuRowFields<K extends MenuPrefKey> {
  key: K;
  group: "camera" | "voice";
  /** 選單裡的分段標題。 */
  group_label: string;
  label: string;
  /** 不是 null 時這一列停用（數值列：所有選項停用，原因放在子選單第一項；開關列：原因放在 sublabel）。 */
  disabled_reason: string | null;
  /** 不影響設定的說明（例如「看著說話目前關閉」），否則是規格的 hint。 */
  note: string;
  /** 選單把 { [key]: value } POST 到這裡；每個設定檔只有一個寫入者。 */
  write_path: "/api/settings/camera" | "/api/settings/voice";
}

/** 選單列的一列數值設定（子選單裡一組 radio）。kind 決定單位（秒／倍）；其餘欄位兩種都一樣。 */
export interface MenuNumberSetting<K extends MenuNumberKey = MenuNumberKey> extends MenuRowFields<K> {
  kind: NumberPrefSpec["kind"];
  value: number;
  value_label: string;
  /** 由小到大，剛好一項 checked，而且就是目前的值（不在選項裡時插入「（目前）」，選單不會勾錯）。 */
  options: MenuPrefOption[];
}

/** 選單列的一個開關（checkbox）；點了把 { [key]: !value } POST 到 write_path。 */
export interface MenuBoolSetting<K extends CameraBoolKey = CameraBoolKey> extends MenuRowFields<K> {
  kind: BoolPrefSpec["kind"];
  value: boolean;
  /** 「開」「關」。 */
  value_label: string;
}

/** 選單列的一列：以 kind 區分 seconds／factor（數值）與 bool（開關）。 */
export type MenuPrefSetting = MenuNumberSetting | MenuBoolSetting;

export type SecondsOption = MenuPrefOption;
export type SecondsSetting = MenuNumberSetting<SecondsKey>;

export interface SecondsSource {
  /** 沒有鏡頭設定來源時，鏡頭的列一律停用。 */
  camera?: CameraSettings;
  voice: VoicePrefs;
  /** false：核心沒有語音設定檔可寫（只在測試組裝時發生）。 */
  voiceWritable: boolean;
  /** 只讀 available 與 detail（下一次開始會用的路徑）。 */
  realtime?: RealtimeBaseInfo;
}

/**
 * 依 CAMERA_PREFS、VOICE_PREFS 的順序，每個規格一列（開關、秒數與倍率）：選單列「鏡頭與語音設定」照這個畫。
 * 保持表的順序，「看著說話」的秒數與「看著說話時先打招呼」緊接在它後面。
 */
export function describeMenuPrefs(source: SecondsSource): MenuPrefSetting[] {
  const rows: MenuPrefSetting[] = [];
  const camera = source.camera;
  const cameraDisabled = camera?.enabled ? null : CAMERA_DISABLED_REASON;
  // 分段標題和設定畫面的段落同名；第一個開關就叫「鏡頭」，標題再叫「鏡頭」會重複。
  const cameraGroup = "鏡頭與手勢";
  for (const [key, spec] of Object.entries(CAMERA_PREFS) as [keyof typeof CAMERA_PREFS, BoolPrefSpec | NumberPrefSpec][]) {
    if (spec.kind === "bool") {
      const k = key as CameraBoolKey;
      const value = camera?.[k] ?? spec.default;
      let note: string = spec.hint;
      // 和設定畫面「鏡頭與手勢」同一個提示。
      if (k === "look_to_talk" && !source.realtime?.available) note = `${spec.hint}；需要即時語音（目前不可用）`;
      if (camera && k === "look_to_talk_greet" && !camera.look_to_talk) note = "看著說話目前關閉，這個開關暫時用不到";
      // 鏡頭關著時其他開關都用不到（和倍率列「鏡頭目前關閉…」一致）；這個說明優先。
      if (camera && k !== "active" && !camera.active) note = "鏡頭目前關閉，這個開關暫時用不到";
      rows.push({
        key: k,
        kind: "bool",
        group: "camera",
        group_label: cameraGroup,
        label: spec.label,
        value,
        value_label: value ? "開" : "關",
        disabled_reason: cameraDisabled,
        note,
        write_path: "/api/settings/camera",
      });
      continue;
    }
    const k = key as CameraSecondsKey | FactorKey;
    const value = camera?.[k] ?? spec.default;
    let note: string = spec.hint;
    if (camera && spec.kind === "seconds" && !camera.look_to_talk) note = "看著說話目前關閉，這個秒數暫時用不到";
    if (camera && spec.kind === "factor" && !camera.active) note = "鏡頭目前關閉，量不到距離，電子腦不會放大";
    rows.push(row(k, "camera", cameraGroup, spec, value, cameraDisabled, note, "/api/settings/camera"));
  }
  for (const [key, spec] of numberSpecs(VOICE_PREFS)) {
    let note: string = spec.hint;
    if (key === "realtime_idle_s" && !source.realtime?.available) note = `即時語音目前不可用（${source.realtime?.detail ?? "未設定"}）`;
    rows.push(row(key, "voice", "語音", spec, source.voice[key], source.voiceWritable ? null : VOICE_UNSAVED_REASON, note, "/api/settings/voice"));
  }
  return rows;
}

/**
 * 選單列「顯示鏡頭畫面」不能用的原因（SettingsView.camera_preview_disabled_reason）；可以用時為 null。
 * 鏡頭未啟用（.env）或使用者關掉鏡頭時都沒有畫面可顯示。
 */
export function cameraPreviewDisabledReason(camera: CameraSettings | undefined): string | null {
  if (!camera?.enabled) return CAMERA_DISABLED_REASON;
  if (!camera.active) return CAMERA_OFF_PREVIEW_REASON;
  return null;
}

/** 數值列（秒數與倍率）。 */
export function isNumberRow(row: MenuPrefSetting): row is MenuNumberSetting {
  return row.kind !== "bool";
}

/** 只有秒數的列（語音指令表、既有測試用）。 */
export function describeSeconds(source: SecondsSource): SecondsSetting[] {
  return describeMenuPrefs(source).filter((r): r is SecondsSetting => r.kind === "seconds");
}

type NumberKeyOf<S> = { [K in keyof S]: S[K] extends NumberPrefSpec ? K : never }[keyof S];

function numberSpecs<S extends Record<string, { kind: string }>>(specs: S): [NumberKeyOf<S> & MenuNumberKey, NumberPrefSpec][] {
  return Object.entries(specs).filter(([, spec]) => spec.kind === "seconds" || spec.kind === "factor") as [NumberKeyOf<S> & MenuNumberKey, NumberPrefSpec][];
}

function row(
  key: MenuNumberKey,
  group: MenuPrefSetting["group"],
  groupLabel: string,
  spec: NumberPrefSpec,
  value: number,
  disabledReason: string | null,
  note: string,
  writePath: MenuPrefSetting["write_path"],
): MenuNumberSetting {
  const values = [...new Set([...spec.presets, value])].sort((a, b) => a - b);
  const options = values.map((v) => ({
    value: v,
    label: `${formatNumberPref(spec, v)}${v === spec.default ? "（預設）" : spec.presets.includes(v) ? "" : "（目前）"}`,
    checked: v === value,
  }));
  return {
    key,
    kind: spec.kind,
    group,
    group_label: groupLabel,
    label: spec.label,
    value,
    value_label: formatNumberPref(spec, value),
    options,
    disabled_reason: disabledReason,
    note,
    write_path: writePath,
  };
}
