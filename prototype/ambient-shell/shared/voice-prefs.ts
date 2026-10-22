// 語音閒置秒數（使用者設定，保存在 configDir/voice.json）。沒有鏡頭也適用，所以不放在 CAMERA_PREFS。
import { parsePrefsPatch, prefDefaults, type PrefSpecs } from "./prefs.ts";

export interface VoicePrefs {
  /** 瀏覽器語音模式：多久沒聽到話（也沒在等或念回覆）就自動關閉。 */
  voice_idle_s: number;
  /** 即時語音：多久沒說話（也沒在回覆、查詢或等確認）就自動結束，避免忘記關而持續計費。 */
  realtime_idle_s: number;
}

export type VoicePrefsPatch = Partial<VoicePrefs>;

/**
 * 唯一的語音設定清單。下限 30 秒：想一下再說不會被切掉；上限 10 分鐘：忘記關的即時語音不會一直計費。
 * 提示文字照實寫 src/voice.ts、src/realtime.ts 的 resetIdle：哪些時候不計時。
 */
export const VOICE_PREFS = {
  voice_idle_s: {
    kind: "seconds", default: 90, min: 30, max: 600, step: 10, presets: [30, 60, 90, 120, 180, 300],
    label: "語音模式閒置多久自動關閉",
    hint: "從最後一次聽到你說話或 Nous 念完算起；等回覆與念回覆時不算",
  },
  realtime_idle_s: {
    kind: "seconds", default: 120, min: 30, max: 600, step: 10, presets: [60, 120, 180, 300, 600],
    label: "即時語音閒置多久自動結束",
    hint: "從你最後一次開口、打字或 Nous 回覆完算起；回覆、查資料、等確認時不算（即時語音依用量計費）",
  },
} as const satisfies PrefSpecs<VoicePrefs>;

export type VoicePrefKey = keyof VoicePrefs;

export const VOICE_PREF_KEYS = Object.keys(VOICE_PREFS) as VoicePrefKey[];

export const DEFAULT_VOICE_PREFS: VoicePrefs = prefDefaults<VoicePrefs>(VOICE_PREFS);

export class VoicePatchError extends Error {}

/** 邊界驗證（HTTP body、voice.json）；規則與 parseCameraPatch 相同。 */
export function parseVoicePatch(input: unknown): VoicePrefsPatch {
  return parsePrefsPatch<VoicePrefs>(VOICE_PREFS, input, { noun: "語音設定", make: (m) => new VoicePatchError(m) });
}

/** 頁面交給兩個閒置計時器的毫秒數（VoiceConversation、RealtimeVoice 的 idleMs）；收到核心的設定前用預設值。 */
export function idleTimeoutsMs(voice: VoicePrefs | undefined): { voice_mode: number; realtime: number } {
  const prefs = voice ?? DEFAULT_VOICE_PREFS;
  return { voice_mode: prefs.voice_idle_s * 1000, realtime: prefs.realtime_idle_s * 1000 };
}
