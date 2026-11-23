// WIN-1（George 2026-11-23）：Pi 設定裡的「離開全螢幕／回到全螢幕」。
// Pi 頁面不能自己關掉 Chromium 的 --kiosk 全螢幕，所以走和 DN-3 深夜關螢幕同一條路：頁面把想要的模式送到核心
// （POST /api/terminal/window），Pi 套件的 aios-display 每 2 秒讀 GET /api/terminal/display 時一起拿到，
// 寫進 Pi 上的 ~/.config/aios-terminal/window-mode，再重開 aios-kiosk.service（全螢幕用 --kiosk，視窗模式不用）。
// 核心只在記憶體記最近一次請求，超過 WINDOW_REQUEST_FRESH_MS 就不再給（Pi 上的檔案才是持久的設定，不會一直重開）。

export type WindowMode = "kiosk" | "window";

export const TERMINAL_WINDOW_PATH = "/api/terminal/window" as const;
/** 請求多久內有效（Pi 每 2 秒讀一次；過了就當成沒有請求）。 */
export const WINDOW_REQUEST_FRESH_MS = 60_000;
/** 按下後多久頁面還在，就說 Pi 沒有反應（重開 Chromium 會重新載入頁面）。 */
export const WINDOW_NO_RESPONSE_MS = 20_000;

export function isWindowMode(value: unknown): value is WindowMode {
  return value === "kiosk" || value === "window";
}

/** 頁面現在是哪一種：Pi 套件在視窗模式開頁面時，網址多帶 display=window。 */
export function windowModeFromSearch(search: string): WindowMode {
  return new URLSearchParams(search).get("display") === "window" ? "window" : "kiosk";
}

/** 設定頁的文字（原文；畫面上經 t() 翻譯）。 */
export const TERMINAL_WINDOW_TEXT = {
  title: "這台 Pi 的全螢幕",
  exit: "離開全螢幕",
  enter: "回到全螢幕",
  nowKiosk: "目前：全螢幕",
  nowWindow: "目前：視窗",
  note: "按下後 Pi 會在幾秒內重新開啟 Nous 畫面（進行中的語音對話會中斷）。視窗模式下可以用 Pi 的桌面；關掉視窗後會自動再開。重開機後沿用最後的選擇。",
  pending: "已送出，Pi 會在幾秒內重新開啟畫面…",
  noResponse: "Pi 沒有反應：請確認 Pi 套件已更新（在 Pi 上重新執行 install.sh），而且 aios-display 服務在執行。",
  failed: "沒有送出：{0}",
} as const;
