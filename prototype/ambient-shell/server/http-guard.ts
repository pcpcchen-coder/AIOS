import type { IncomingHttpHeaders } from "node:http";

/**
 * 只接受來自本機頁面的請求，避免其他網站透過瀏覽器替使用者交辦任務（花用 API 額度）
 * 或以 DNS rebinding 讀取成果。
 */
export function allowedHosts(port: number, devPort: number): Set<string> {
  const hosts = new Set<string>();
  for (const name of ["localhost", "127.0.0.1"]) {
    hosts.add(`${name}:${port}`);
    hosts.add(`${name}:${devPort}`);
  }
  return hosts;
}

export type GuardResult = { ok: true } | { ok: false; status: number; message: string };

export function checkRequest(
  method: string,
  headers: IncomingHttpHeaders,
  hosts: Set<string>,
): GuardResult {
  const host = headers.host ?? "";
  if (!hosts.has(host)) return { ok: false, status: 403, message: "host not allowed" };
  if (method === "GET" || method === "HEAD") return { ok: true };

  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, message: "bad origin" };
    }
    if (!hosts.has(originHost)) return { ok: false, status: 403, message: "origin not allowed" };
  }
  // 要求 JSON content-type：跨站的 simple request 無法帶這個 header 而不觸發 preflight。
  const type = headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, message: "content-type must be application/json" };
  }
  return { ok: true };
}
