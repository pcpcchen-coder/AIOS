import { DEFAULT_WAKE_PREFS, parseWakePatch, WAKE_PREF_KEYS, type WakePrefs, type WakePrefsPatch } from "../shared/wake.ts";
import { PrefsStore } from "./prefs-store.ts";

// 常駐喚醒聆聽的偏好（configDir/wake.json）。這個檔案只有這裡寫入，而且只有 NOUS_WAKE=on 時才建立這個 store。
// fail closed：檔案讀不懂、或某個鍵不合法時，wake_listen 一律當成關閉、device_id 當成沒有（不猜成開，不用來源不明的裝置）。
// wake_silence_s 不合法時用預設 5 秒（不影響隱私，只影響誤喚醒時多等幾秒）；wake_threshold_offset 不合法時用預設 0（產品原本的門檻）。voice_name_test（SP-02a 測試開關）讀不懂時是關閉。
// 「暫停聆聽」只到本次執行結束，不寫進這個檔案（docs/17 §5.5）。

export interface WakeSettingsStoreOptions {
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated）。 */
  onChange(): void;
  log?(message: string): void;
}

export class WakeSettingsStore extends PrefsStore<WakePrefs, WakeSettingsStoreOptions> {
  constructor(options: WakeSettingsStoreOptions) {
    super({ name: "wake.json", parse: parseWakePatch, failClosed: { wake_listen: false, device_id: null, voice_name_test: false, speaker_in_call: false }, unreadable: "常駐喚醒聆聽保持關閉" }, options);
  }

  view(): WakePrefs {
    return this.resolve(WAKE_PREF_KEYS, DEFAULT_WAKE_PREFS);
  }

  /**
   * 先寫檔，成功後才改記憶體並呼叫 onChange；失敗時丟錯、記憶體不變。
   * 開關關著（或這次關掉）時一律不記麥克風：下次由使用者明確打開時用預設麥克風，並記下新的那一支；
   * 關掉之後才到的 device_id（頁面晚到的回報）也不會留下來。
   */
  update(patch: WakePrefsPatch): WakePrefs {
    const listen = patch.wake_listen ?? this.view().wake_listen;
    const next: WakePrefsPatch = listen ? patch : { ...patch, device_id: null };
    this.commit(next);
    return this.view();
  }
}
