// 即時語音的控制連線（WebSocket）共用工具：live 路徑的 sideband（server/live-route.ts）與 MEM-3 API key 路徑的旁路
// （server/realtime.ts、server/apikey-call.ts）共用。沒有其他相依，避免模組循環。

/** 測試注入的 WebSocket：Node 22 的全域 WebSocket（undici）符合這個形狀。 */
export interface SidebandSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}
export type SidebandSocketCtor = new (url: string, init: { headers: Record<string, string> }) => SidebandSocket;

/** Location 最後一段是 rtc_… 或 UUID；沒有時用 openai-session-id。 */
export function callIdFrom(location: string | null, sessionHeader: string | null): string | null {
  if (location) {
    let path = location;
    try {
      path = new URL(location, "https://chatgpt.com").pathname;
    } catch {
      // 不是網址：當成路徑
    }
    const last = path.split("/").filter(Boolean).at(-1) ?? "";
    if (/^rtc_[\w-]{1,128}$/.test(last) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)) return last;
  }
  const header = sessionHeader?.trim();
  return header && /^[\w-]{1,128}$/.test(header) ? header : null;
}

/**
 * 開一條 WebSocket（live 的 sideband 與 MEM-3 API key 路徑的旁路共用）；open 才 resolve，錯誤、關閉、逾時或 signal 中止 reject
 * （中止或逾時時關掉 socket）。
 */
export function openSidebandSocket(WS: SidebandSocketCtor, url: string, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal | null = null): Promise<SidebandSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: SidebandSocket;
    if (signal?.aborted) {
      reject(new Error("sideband 連線已中止"));
      return;
    }
    try {
      socket = new WS(url, { headers });
    } catch (err) {
      reject(err);
      return;
    }
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已關閉
      }
      reject(new Error("sideband 連線已中止"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // 已關閉
      }
      reject(new Error("sideband 連線逾時"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("sideband 連線失敗"));
    };
    socket.addEventListener("error", fail);
    socket.addEventListener("close", fail);
  });
}

