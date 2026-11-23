// 選單列（SettingsView.seconds）每一列的型別：鍵的集合與 seconds／factor／bool 三種列。
// 2026-11-10 從 shared/menu-prefs.ts（原名 seconds-menu.ts）搬出來；menu-prefs.ts 原樣 re-export，既有 import 不用改。
// 這個檔只有型別，而且不 import shared/types.ts：types.ts 的 SettingsView 從這裡取 MenuPrefSetting，
// menu-prefs.ts 就不再和 types.ts 互相 import。
import type { BoolPrefSpec, FactorKeyOf, NumberPrefSpec, SecondsKeyOf } from "./prefs.ts";
import type { CAMERA_PREFS } from "./sense.ts";
import type { VoicePrefs } from "./voice-prefs.ts";

export type CameraSecondsKey = SecondsKeyOf<typeof CAMERA_PREFS>;
export type SecondsKey = CameraSecondsKey | keyof VoicePrefs;
export type FactorKey = FactorKeyOf<typeof CAMERA_PREFS>;
/** 鏡頭的開關（CAMERA_PREFS 裡 kind 為 bool 的鍵）。 */
export type CameraBoolKey = { [K in keyof typeof CAMERA_PREFS]: (typeof CAMERA_PREFS)[K] extends { kind: "bool" } ? K : never }[keyof typeof CAMERA_PREFS];
export type MenuNumberKey = SecondsKey | FactorKey;
export type MenuPrefKey = MenuNumberKey | CameraBoolKey;

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
