import { parseRealtimePatch, type RealtimePrefs, type RealtimePrefsPatch } from "../shared/realtime-route.ts";
import { PrefsFile } from "./prefs-file.ts";

// 即時語音的路徑偏好與 ChatGPT 方案路徑的聲音（configDir/realtime.json）。這個檔案只有這裡寫入。
// 設定畫面與桌面選單都經 POST /api/settings/realtime 改它：不用改 .env、不用重新啟動核心。
// 正在進行的工作階段不受影響：RealtimeSessions 只在 start() 讀偏好。
// 優先順序：使用者保存的值 > NOUS_REALTIME_ROUTE／NOUS_LIVE_VOICE > auto／cove。

export interface RealtimeSettingsStoreOptions {
  dir: string;
  defaults: RealtimePrefs;
  onChange(): void;
  log?(message: string): void;
}

export class RealtimeSettingsStore {
  private readonly file: PrefsFile<RealtimePrefs>;

  constructor(private readonly options: RealtimeSettingsStoreOptions) {
    this.file = new PrefsFile<RealtimePrefs>({
      dir: options.dir,
      name: "realtime.json",
      version: 1,
      parse: parseRealtimePatch,
      failClosed: {},
      unreadable: "即時語音的路徑偏好用預設值",
      log: options.log,
    });
  }

  view(): RealtimePrefs {
    return { ...this.options.defaults, ...this.file.saved };
  }

  /** 先寫檔，成功後才改記憶體並呼叫 onChange；失敗時丟錯、記憶體不變。 */
  update(patch: RealtimePrefsPatch): RealtimePrefs {
    this.file.update(patch);
    this.options.onChange();
    return this.view();
  }
}
