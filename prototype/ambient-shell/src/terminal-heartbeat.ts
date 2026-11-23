// 服務模式：終端機（Pi kiosk，網址帶 ?terminal=<id>）每 10 秒送一次心跳給核心，Mac 選單列的「Pi 已連線」只以這個為準。
// 只在沒有 App preload（不是 Mac 的主視窗）而且識別碼合法時才送；不論頁面是否可見都送，失敗不顯示，下一次再送。

import { pageTerminal, TERMINAL_HEARTBEAT_MS } from "../shared/terminal.ts";

export interface TerminalHeartbeatDeps {
  /** 有 App preload（window.nousDesktop）時不送。 */
  desktop: boolean;
  /** location.search */
  search: string;
  send(terminal: string): Promise<unknown>;
  every?(run: () => void, ms: number): () => void;
}

/** 開始送心跳；回傳停止（沒有開始時回 null）。 */
export function startTerminalHeartbeat(deps: TerminalHeartbeatDeps): (() => void) | null {
  const terminal = pageTerminal(deps.search, deps.desktop);
  if (terminal === null) return null;
  const beat = () => void deps.send(terminal).catch(() => {});
  const every = deps.every ?? ((run: () => void, ms: number) => {
    const id = setInterval(run, ms);
    return () => clearInterval(id);
  });
  beat();
  return every(beat, TERMINAL_HEARTBEAT_MS);
}
