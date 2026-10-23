// 所有秒數設定的描述，給選單列直接畫（SettingsView.seconds）。由核心從 CAMERA_PREFS、VOICE_PREFS 與目前的值推導；
// desktop/main.mjs 不知道任何鍵、範圍、選項、標籤或寫入路徑，照這裡的列畫出來。
import { formatSeconds, type SecondsKeyOf, type SecondsPrefSpec } from "./prefs.ts";
import { CAMERA_PREFS, type CameraSettings } from "./sense.ts";
import type { RealtimeBaseInfo } from "./types.ts";
import { VOICE_PREFS, type VoicePrefs } from "./voice-prefs.ts";

export type CameraSecondsKey = SecondsKeyOf<typeof CAMERA_PREFS>;
export type SecondsKey = CameraSecondsKey | keyof VoicePrefs;

export const CAMERA_DISABLED_REASON = "鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）";
export const VOICE_UNSAVED_REASON = "核心沒有語音設定檔，無法保存";

export interface SecondsOption {
  value: number;
  /** 「1.5 秒（預設）」「2 分鐘」；目前的值不是選項時另加一項「1.6 秒（目前）」。 */
  label: string;
  checked: boolean;
}

export interface SecondsSetting {
  key: SecondsKey;
  group: "camera" | "voice";
  /** 選單裡的分段標題。 */
  group_label: string;
  label: string;
  value: number;
  value_label: string;
  /** 由小到大，剛好一項 checked，而且就是目前的值（不在選項裡時插入「（目前）」，選單不會勾錯）。 */
  options: SecondsOption[];
  /** 不是 null 時所有選項停用，並把原因放在子選單第一項。 */
  disabled_reason: string | null;
  /** 不影響設定的說明（例如「看著說話目前關閉」），否則是規格的 hint。 */
  note: string;
  /** 選單把 { [key]: value } POST 到這裡；每個設定檔只有一個寫入者。 */
  write_path: "/api/settings/camera" | "/api/settings/voice";
}

export interface SecondsSource {
  /** 沒有鏡頭設定來源時，鏡頭的列一律停用。 */
  camera?: CameraSettings;
  voice: VoicePrefs;
  /** false：核心沒有語音設定檔可寫（只在測試組裝時發生）。 */
  voiceWritable: boolean;
  /** 只讀 available 與 detail（下一次開始會用的路徑）。 */
  realtime?: RealtimeBaseInfo;
}

/** 依 CAMERA_PREFS、VOICE_PREFS 的順序，每個秒數規格一列。 */
export function describeSeconds(source: SecondsSource): SecondsSetting[] {
  const rows: SecondsSetting[] = [];
  const camera = source.camera;
  for (const [key, spec] of secondsSpecs(CAMERA_PREFS)) {
    const value = camera?.[key] ?? spec.default;
    let note: string = spec.hint;
    if (camera && !camera.look_to_talk) note = "看著說話目前關閉，這個秒數暫時用不到";
    rows.push(row(key, "camera", "鏡頭", spec, value, camera?.enabled ? null : CAMERA_DISABLED_REASON, note, "/api/settings/camera"));
  }
  for (const [key, spec] of secondsSpecs(VOICE_PREFS)) {
    let note: string = spec.hint;
    if (key === "realtime_idle_s" && !source.realtime?.available) note = `即時語音目前不可用（${source.realtime?.detail ?? "未設定"}）`;
    rows.push(row(key, "voice", "語音", spec, source.voice[key], source.voiceWritable ? null : VOICE_UNSAVED_REASON, note, "/api/settings/voice"));
  }
  return rows;
}

function secondsSpecs<S extends Record<string, { kind: string }>>(specs: S): [SecondsKeyOf<S> & SecondsKey, SecondsPrefSpec][] {
  return Object.entries(specs).filter(([, spec]) => spec.kind === "seconds") as [SecondsKeyOf<S> & SecondsKey, SecondsPrefSpec][];
}

function row(
  key: SecondsKey,
  group: SecondsSetting["group"],
  groupLabel: string,
  spec: SecondsPrefSpec,
  value: number,
  disabledReason: string | null,
  note: string,
  writePath: SecondsSetting["write_path"],
): SecondsSetting {
  const values = [...new Set([...spec.presets, value])].sort((a, b) => a - b);
  const options = values.map((v) => ({
    value: v,
    label: `${formatSeconds(v)}${v === spec.default ? "（預設）" : spec.presets.includes(v) ? "" : "（目前）"}`,
    checked: v === value,
  }));
  return {
    key,
    group,
    group_label: groupLabel,
    label: spec.label,
    value,
    value_label: formatSeconds(value),
    options,
    disabled_reason: disabledReason,
    note,
    write_path: writePath,
  };
}
