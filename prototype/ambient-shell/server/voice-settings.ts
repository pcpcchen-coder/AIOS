import { DEFAULT_VOICE_PREFS, parseVoicePatch, VOICE_PREF_KEYS, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import { PrefsStore } from "./prefs-store.ts";

// 語音閒置秒數（configDir/voice.json）。這個檔案只有這裡寫入。優先順序：使用者保存的值 > VOICE_PREFS 預設。

export interface VoiceSettingsStoreOptions {
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated，頁面立即套用）。 */
  onChange(): void;
  log?(message: string): void;
}

export class VoiceSettingsStore extends PrefsStore<VoicePrefs, VoiceSettingsStoreOptions> {
  constructor(options: VoiceSettingsStoreOptions) {
    super({ name: "voice.json", parse: parseVoicePatch, failClosed: {}, unreadable: "語音閒置秒數用預設值" }, options);
  }

  view(): VoicePrefs {
    return this.resolve(VOICE_PREF_KEYS, DEFAULT_VOICE_PREFS);
  }

  /** 與 CameraSettingsStore.update 同一個約定：先寫檔，成功後才改記憶體並呼叫 onChange；失敗時丟錯、記憶體不變。 */
  update(patch: VoicePrefsPatch): VoicePrefs {
    this.commit(patch);
    return this.view();
  }
}
