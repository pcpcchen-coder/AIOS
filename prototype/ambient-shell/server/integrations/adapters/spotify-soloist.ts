import { toolResult, type ToolResult } from "../../../shared/integrations.ts";
import type { HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// SP-1（docs/18 §5–§6）：Spotify Soloist 的本機健康狀態。**沒有任何模型工具**：Spotify Developer Policy III.3
// 禁止未經授權的語音控制，SP-2 維持 BLOCKED（server/integrations/policy.ts 也會拒絕任何 app.spotify.* 註冊）。
//
// 連線：Pi 上的 Soloist 用 `--ws 127.0.0.1:9090` 只綁 Pi 的 loopback；Pi 的 SSH 連線加上
// `-R 127.0.0.1:19090:127.0.0.1:9090` 把它轉到 Mac 的 loopback。這裡只連 ws://127.0.0.1:<port>：
// 主機寫死成 127.0.0.1，port 只來自核心設定（NOUS_SPOTIFY_SOLOIST_PORT），頁面與模型都不能指定網址。
//
// 讀什麼：官方 WebSocket API（developer.spotify.com/documentation/soloist/reference/websocket-api，2026-11-03 查核）
// 連上後伺服器送 `auth_state`（logged_in、is_active、device_name）；`get_auth_state` 也會回同一個事件。
// 只讀 logged_in 與 is_active 兩個布林值。其他事件（playback_state 等，含歌名與歌單）一律不解析、不保存、不轉出；
// 也不送 get_state、play、pause 或任何控制指令。device_name 不讀。沒有 API Key、權杖或帳號經過這裡。
//
// 判斷（沒有確定答案就不是 available）：
//   連不上（Pi 離線、SSH 通道斷、Soloist 沒在跑或 build 過期而結束）→ unavailable／connection_refused
//   連上後在回報前斷線 → unknown／connection_closed；時限內沒有 auth_state → unknown／timeout
//   auth_state 欄位看不懂 → unknown／bad_reply
//   logged_in false（沒有登入或 session 被換掉）→ unavailable／not_ready
//   logged_in true、is_active false（官方定義：Soloist 不是目前使用中的 Connect 裝置；待命或已切到別台都是）→ unavailable／taken_over
//   兩者皆 true → available／ok
// Soloist 的 build 過期時以 exit code 10 結束，這裡看到的是連不上，分不出是過期還是沒啟動（照實歸在 connection_refused）。

export const DEFAULT_SOLOIST_PORT = 19090;
export const SOLOIST_HOST = "127.0.0.1";
/** 單次健康檢查的時限（狀態頁另外有 3 秒上限）。 */
export const SOLOIST_HEALTH_TIMEOUT_MS = 2_500;
/** 超過這個長度的訊息不解析（auth_state 很小；大的是播放狀態，本來就不讀）。 */
const MAX_MESSAGE_CHARS = 4_096;

/** 最小的 WebSocket 介面（Node 22 的全域 WebSocket 相容；測試可注入）。 */
export interface SoloistSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}
export type SoloistSocketCtor = new (url: string) => SoloistSocket;

export interface SpotifySoloistOptions {
  port?: number;
  WebSocket?: SoloistSocketCtor;
  timeoutMs?: number;
}

export function parseSoloistPort(value: string | undefined): number {
  if (value === undefined || !value.trim()) return DEFAULT_SOLOIST_PORT;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`NOUS_SPOTIFY_SOLOIST_PORT 必須是 1024–65535 的整數，收到 "${value}"`);
  return port;
}

export class SpotifySoloistAdapter implements IntegrationAdapter {
  readonly id = "spotify_soloist";
  readonly service = "spotify";
  readonly version = 1;
  readonly mock = false;
  private readonly url: string;
  private readonly WS: SoloistSocketCtor;

  constructor(private readonly options: SpotifySoloistOptions = {}) {
    const port = options.port ?? DEFAULT_SOLOIST_PORT;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Soloist port 不合法");
    this.url = `ws://${SOLOIST_HOST}:${port}`;
    this.WS = options.WebSocket ?? (globalThis.WebSocket as unknown as SoloistSocketCtor);
  }

  /** 執行環境沒有 WebSocket：是 Nous 這邊的問題，不能說成 Pi 離線。 */
  private get hasSocket(): boolean {
    return typeof this.WS === "function";
  }

  /** SP-2 BLOCKED：沒有模型工具。 */
  tools(): readonly ToolDefinition[] {
    return [];
  }

  async execute(): Promise<ToolResult> {
    return toolResult("refused", "Spotify 語音控制沒有取得授權，沒有執行。", { reason: "not_registered" });
  }

  health(signal: AbortSignal): Promise<HealthReport> {
    return new Promise<HealthReport>((resolve) => {
      let settled = false;
      let opened = false;
      let socket: SoloistSocket | null = null;
      const finish = (report: HealthReport) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        try {
          socket?.close();
        } catch {
          // 已經關閉
        }
        resolve(report);
      };
      const onAbort = () => finish({ health: "unknown", reason: "timeout" });
      const timer = setTimeout(onAbort, this.options.timeoutMs ?? SOLOIST_HEALTH_TIMEOUT_MS);
      if (signal.aborted) return onAbort();
      if (!this.hasSocket) return finish({ health: "unknown", reason: "error" });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        socket = new this.WS(this.url);
      } catch {
        return finish({ health: "unavailable", reason: "connection_refused" });
      }
      socket.addEventListener("open", () => {
        opened = true;
        try {
          // 官方文件：連上時就會送 auth_state；get_auth_state 只是保險（同一個事件，不需要登入、不讀播放內容）。
          socket?.send(JSON.stringify({ type: "command", command: "get_auth_state" }));
        } catch {
          // 送不出去：等 close／error
        }
      });
      socket.addEventListener("message", (event) => {
        const report = readAuthState(event.data);
        if (report) finish(report);
      });
      socket.addEventListener("error", () => finish(opened ? { health: "unknown", reason: "connection_closed" } : { health: "unavailable", reason: "connection_refused" }));
      socket.addEventListener("close", () => finish(opened ? { health: "unknown", reason: "connection_closed" } : { health: "unavailable", reason: "connection_refused" }));
    });
  }
}

/**
 * 只看 auth_state 的兩個布林值；其他事件回 null（略過、不解析內容）。
 * auth_state 欄位型別不對 → unknown／bad_reply。
 */
export function readAuthState(data: unknown): HealthReport | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "auth_state") return null;
  const { logged_in, is_active } = parsed as { logged_in?: unknown; is_active?: unknown };
  if (typeof logged_in !== "boolean" || typeof is_active !== "boolean") return { health: "unknown", reason: "bad_reply" };
  if (!logged_in) return { health: "unavailable", reason: "not_ready" };
  if (!is_active) return { health: "unavailable", reason: "taken_over" };
  return { health: "available", reason: "ok" };
}
