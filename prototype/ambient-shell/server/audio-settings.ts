import { AUDIO_PREF_KEYS, DEFAULT_AUDIO_PREFS, parseAudioPatch, type AudioPrefs, type AudioPrefsPatch } from "../shared/audio-devices.ts";
import { PrefsFile } from "./prefs-file.ts";

// 聲音輸入／輸出裝置的選擇（configDir/audio.json；George 2026-11-01）。這個檔案只有這裡寫入；不綁任何 .env 旗標。
// null＝系統預設。檔案讀不懂、或某個鍵不合法時一律當成 null（回到系統預設，沒有安全疑慮）。
// 「處理中音效」processing_cue（George 2026-11-02）也存在這裡；沒有保存過或讀不懂時用預設的開。
// 常駐聆聽也跟著這裡的麥克風；wake.json 舊的 device_id 不搬過來（那只是當時的系統預設麥克風，搬過來會把所有路徑釘在那一支），
// 也不再寫入。

export interface AudioSettingsStoreOptions {
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated）。 */
  onChange(): void;
  log?(message: string): void;
}

export class AudioSettingsStore {
  private readonly file: PrefsFile<AudioPrefs>;

  constructor(private readonly options: AudioSettingsStoreOptions) {
    this.file = new PrefsFile<AudioPrefs>({
      dir: options.dir,
      name: "audio.json",
      version: 1,
      parse: parseAudioPatch,
      failClosed: { ...DEFAULT_AUDIO_PREFS },
      unreadable: "聲音輸入與輸出都用系統預設",
      log: options.log,
    });
  }

  view(): AudioPrefs {
    const saved = this.file.saved;
    return Object.fromEntries(AUDIO_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_AUDIO_PREFS[key]])) as unknown as AudioPrefs;
  }

  /**
   * 套用已驗證的 patch（呼叫端先用 parseAudioPatch）：先寫檔，成功後才改記憶體並呼叫 onChange；失敗時丟錯、記憶體不變。
   * 選回系統預設（id 為 null）時名稱一起清掉。
   */
  update(patch: AudioPrefsPatch): AudioPrefs {
    const next: AudioPrefsPatch = { ...patch };
    if (patch.input_device_id === null) next.input_label = null;
    if (patch.output_device_id === null) next.output_label = null;
    this.file.update(next);
    this.options.onChange();
    return this.view();
  }
}
