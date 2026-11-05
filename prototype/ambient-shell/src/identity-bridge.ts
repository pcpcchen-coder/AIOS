// 家人辨識與記憶的傳輸選擇（RPI-ID，George 2026-11-05）：Mac 主視窗用 App 的 IPC（window.nousDesktop），
// Pi 等終端機頁面（沒有 preload、網址帶合法的 ?terminal=）用 HTTP（/api/terminal/identity、/api/terminal/memory），
// 一般瀏覽器兩者都沒有（null，和之前一樣不認人、不顯示記憶）。
// 終端機的 HTTP 只能用認人與本次人物的操作；登記、校準與記憶管理仍只在 Mac（核心擋，見 server/terminal-routes.ts）。

import type { IdentityRequest, IdentityResponse } from "../shared/identity.ts";
import type { MemoryPresenceResponse, MemoryRequest, MemoryResponse } from "../shared/memory.ts";
import { pageTerminal } from "../shared/terminal.ts";

export type IdentitySend = (request: IdentityRequest) => Promise<IdentityResponse>;
export type MemorySend = (request: MemoryRequest) => Promise<MemoryResponse>;
/** 本次人物用的記憶傳輸：App 的 IPC 回完整的 MemoryResponse；終端機的 HTTP 只回投影過的 MemoryPresenceResponse。 */
export type PresenceSend = (request: MemoryRequest) => Promise<MemoryResponse | MemoryPresenceResponse>;

export interface BridgeEnv {
  /** App preload 的兩個 IPC（沒有 preload 時 undefined）。 */
  desktop?: { identity?: IdentitySend; memory?: MemorySend } | undefined;
  /** location.search */
  search: string;
  http: {
    identity(terminal: string, request: IdentityRequest): Promise<IdentityResponse>;
    memory(terminal: string, request: MemoryRequest): Promise<MemoryPresenceResponse>;
  };
}

export interface PageBridges {
  /** 這個頁面是終端機時的識別碼；Mac 主視窗與一般瀏覽器是 null。 */
  terminal: string | null;
  identity: IdentitySend | null;
  memory: PresenceSend | null;
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
    return { terminal: null, identity: identity ? (request) => identity(request) : null, memory: memory ? (request) => memory(request) : null };
  }
  if (terminal === null) return { terminal: null, identity: null, memory: null };
  return {
    terminal,
    identity: (request) => env.http.identity(terminal, request).catch(failure),
    memory: (request) => env.http.memory(terminal, request).catch(failure),
  };
}
