import { isTerminalId } from "../shared/terminal.ts";

// SET-1（George 2026-11-07）：Pi 終端頁面右下角的設定按鈕，用滑鼠點一下就打開這台 Pi 的設定畫面，再點一下收起。
// 只在終端頁面（沒有 App preload、網址只有一個合法的 ?terminal=）出現：Mac 有選單列，不需要這個按鈕。
// 這是使用者指定的常駐入口（產品紅線不建立 App 圖示或常駐側欄；這裡只有一個設定按鈕，不開任何 App、不列功能清單），
// data-visibility-reason="user_request:terminal_settings_entry" 記下理由。設定畫面本身照舊是 settings Surface。

export const SETTINGS_ENTRY_TEXT = {
  open: "打開設定",
  close: "收起設定",
} as const;

export interface SettingsEntryEnv {
  /** location.search */
  search: string;
  /** 有 App preload（window.nousDesktop）。 */
  desktop: boolean;
}

/** 只有 Pi 這類終端頁面才放按鈕。 */
export function settingsEntryEnabled(env: SettingsEntryEnv): boolean {
  if (env.desktop) return false;
  const terminal = new URLSearchParams(env.search).getAll("terminal");
  return terminal.length === 1 && isTerminalId(terminal[0]);
}

const GEAR_PATH =
  "M19.14 12.94a7.43 7.43 0 0 0 .05-.94 7.43 7.43 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.43 7.43 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54a7.03 7.03 0 0 0 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z";

export interface SettingsEntryOptions {
  /** 設定畫面現在是否開著。 */
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** 翻譯（src/i18n.ts 的 t）。 */
  t(source: string): string;
  doc?: Document;
  host?: HTMLElement;
}

export class SettingsEntry {
  readonly button: HTMLButtonElement;

  constructor(private readonly options: SettingsEntryOptions) {
    const doc = options.doc ?? document;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "settings-entry";
    b.setAttribute("data-visibility-reason", "user_request:terminal_settings_entry");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", GEAR_PATH);
    svg.append(path);
    b.append(svg);
    b.addEventListener("click", () => {
      if (this.options.isOpen()) this.options.close();
      else this.options.open();
      this.refresh();
    });
    (options.host ?? doc.body).append(b);
    this.button = b;
    this.refresh();
  }

  /** 設定畫面開關或換語言時更新標籤與狀態。 */
  refresh(): void {
    const open = this.options.isOpen();
    const label = this.options.t(open ? SETTINGS_ENTRY_TEXT.close : SETTINGS_ENTRY_TEXT.open);
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    this.button.setAttribute("aria-pressed", String(open));
  }
}
