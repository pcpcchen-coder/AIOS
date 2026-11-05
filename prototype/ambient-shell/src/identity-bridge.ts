// 家人辨識與記憶的傳輸選擇（RPI-ID，George 2026-11-05）：Mac 主視窗用 App 的 IPC（window.nousDesktop），
// Pi 等終端機頁面（沒有 preload、網址帶合法的 ?terminal=）用 HTTP（/api/terminal/identity、/api/terminal/memory），
// 一般瀏覽器兩者都沒有（null，和之前一樣不認人、不顯示記憶）。
// 終端機的 HTTP 只能用認人與本次人物的操作；登記、校準與記憶管理仍只在 Mac（核心擋，見 server/terminal-routes.ts）。
// 終端機的認人請求另外附上頁面的鏡頭回報（TerminalPageReport：Pi 本機的看著說話三個設定與鏡頭是否在跑）；核心依它決定這台的稱名。

import type { IdentityRequest, IdentityResponse } from "../shared/identity.ts";
import type { MemoryPresenceResponse, MemoryRequest, MemoryResponse } from "../shared/memory.ts";
import { pageTerminal, type TerminalPageReport } from "../shared/terminal.ts";

export type IdentitySend = (request: IdentityRequest) => Promise<IdentityResponse>;
export type MemorySend = (request: MemoryRequest) => Promise<MemoryResponse>;
/** 本次人物用的記憶傳輸：App 的 IPC 回完整的 MemoryResponse；終端機的 HTTP 只回投影過的 MemoryPresenceResponse。 */
export type PresenceSend = (request: MemoryRequest) => Promise<MemoryResponse | MemoryPresenceResponse>;

export interface BridgeEnv {
  /** App preload 的兩個 IPC（沒有 preload 時 undefined）。 */
  desktop?: { identity?: IdentitySend; memory?: MemorySend } | undefined;
  /** location.search */
  search: string;
  /** 終端機頁面目前實際套用的鏡頭設定與鏡頭是否在跑；每個終端機的認人請求都附上。 */
  page?: () => TerminalPageReport;
  http: {
    identity(terminal: string, request: IdentityRequest, page?: TerminalPageReport): Promise<IdentityResponse>;
    memory(terminal: string, request: MemoryRequest): Promise<MemoryPresenceResponse>;
  };
}

export interface PageBridges {
  /** 這個頁面是終端機時的識別碼；Mac 主視窗與一般瀏覽器是 null。 */
  terminal: string | null;
  identity: IdentitySend | null;
  memory: PresenceSend | null;
  /**
   * 終端機頁面：回報和上次送出的不同（或 force）時，用 ambient_status 送一次給核心。頁面的同步辨識要等核心說可用才會發請求，
   * 所以鏡頭或設定改變時要主動送，不能只靠附在請求上。Mac 主視窗與一般瀏覽器是 null。
   */
  syncPage: ((force?: boolean) => void) | null;
}

/** HTTP 失敗（核心沒有這個路由、拒絕或連不上）當成和 IPC 一樣的不可用回應，畫面照實顯示，不丟例外。 */
function failure(err: unknown): { ok: false; code: "unavailable"; message: string } {
  return { ok: false, code: "unavailable", message: err instanceof Error ? err.message : String(err) };
}

export function selectBridges(env: BridgeEnv): PageBridges {
  const desktop = env.desktop;
  const terminal = pageTerminal(env.search, !!desktop);
  if (desktop) {
    const { identity, memory } = desktop;
    return { terminal: null, identity: identity ? (request) => identity(request) : null, memory: memory ? (request) => memory(request) : null, syncPage: null };
  }
  if (terminal === null) return { terminal: null, identity: null, memory: null, syncPage: null };
  let sent: string | null = null;
  const identity: IdentitySend = (request) => {
    const page = env.page?.();
    const key = page ? JSON.stringify(page) : null;
    sent = key;
    return env.http.identity(terminal, request, page).catch((err: unknown) => {
      if (sent === key) sent = null;
      return failure(err);
    });
  };
  return {
    terminal,
    identity,
    memory: (request) => env.http.memory(terminal, request).catch(failure),
    syncPage: (force = false) => {
      const page = env.page?.();
      if (page && (force || JSON.stringify(page) !== sent)) void identity({ op: "ambient_status" });
    },
  };
}
