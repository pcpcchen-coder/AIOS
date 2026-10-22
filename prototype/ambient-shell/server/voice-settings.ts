import { DEFAULT_VOICE_PREFS, parseVoicePatch, VOICE_PREF_KEYS, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import { PrefsFile } from "./prefs-file.ts";

// 語音閒置秒數（configDir/voice.json）。這個檔案只有這裡寫入。優先順序：使用者保存的值 > VOICE_PREFS 預設。

export interface VoiceSettingsStoreOptions {
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated，頁面立即套用）。 */
  onChange(): void;
  log?(message: string): void;
}

export class VoiceSettingsStore {
  private readonly file: PrefsFile<VoicePrefs>;

  constructor(private readonly options: VoiceSettingsStoreOptions) {
    this.file = new PrefsFile<VoicePrefs>({
      dir: options.dir,
      name: "voice.json",
      version: 1,
      parse: parseVoicePatch,
      failClosed: {},
      unreadable: "語音閒置秒數用預設值",
      log: options.log,
    });
  }

  view(): VoicePrefs {
    const saved = this.file.saved;
    return Object.fromEntries(VOICE_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_VOICE_PREFS[key]])) as unknown as VoicePrefs;
  }

  /** 與 CameraSettingsStore.update 同一個約定：先寫檔，成功後才改記憶體並呼叫 onChange；失敗時丟錯、記憶體不變。 */
  update(patch: VoicePrefsPatch): VoicePrefs {
    this.file.update(patch);
    this.options.onChange();
    return this.view();
  }
}
