// 家人辨識的 IPC 過濾（純函式，不載入 Electron；tests/identity-ipc.test.ts 直接測）。
// 架構（ADR-0001 §2.1）：核心持有資料與比對，IPC 只做傳輸。這裡只做三件事：
//   1. 確認發送者是主視窗的主框架、而且頁面來自本機核心（不是其他視窗、iframe 或導覽後的外部頁面）；
//   2. op 白名單與每個 op 允許的欄位與型別：和終端機的 HTTP 共用 shared/identity-validate.mjs（打包時 esbuild 併進來）；
//   3. 選單列點擊時間窗：只有使用者在選單列點「家人辨識…」後 10 秒內，open_session 才算使用者發起（一次有效）。

import { checkTrustedSender } from "./trusted-sender.mjs";

export { IDENTITY_OPS, validateIdentityRequest } from "../shared/identity-validate.mjs";

export const MENU_CLICK_WINDOW_MS = 10_000;

/**
 * 發送者檢查（與記憶 IPC 共用 desktop/trusted-sender.mjs）。回傳 true 才轉給核心。
 */
export const checkIdentitySender = checkTrustedSender;

/** 選單列點擊的時間窗：mark() 在點擊時呼叫；consume() 在 open_session 時呼叫，10 秒內第一次回 true，之後失效。 */
export class MenuClickWindow {
  constructor(windowMs = MENU_CLICK_WINDOW_MS) {
    this.windowMs = windowMs;
    this.at = null;
  }

  mark(now) {
    this.at = now;
  }

  consume(now) {
    const at = this.at;
    this.at = null;
    return at !== null && now >= at && now - at <= this.windowMs;
  }
}
