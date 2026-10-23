// gpt-live-1-codex 的 "frameless"（v3）事件：頁面（oai-events 資料通道）與核心（sideband）共用同一個解析器。
// 形狀對照 OpenClaw realtime-quicksilver-events.ts:38-87、:168-177 與 Codex protocol_frameless_bidi.rs:12-95。
// 不認得的事件回傳 null（忽略，不當錯誤）。
// session.updated 不等於開始（不對應到 session.started）；session.closed 不在 frameless 的事件表裡，
// 所以結束一律以 sideband 斷線或錯誤為準（server/live-route.ts）。

export type FramelessEvent =
  | { kind: "session.started"; expires_at: number | null }
  /** *_transcript.added（item.text，片段）或 turn.done（turn.transcript，整句）。 */
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean; item_id: string | null }
  /** output_audio_buffer.cleared：模型被插話、清掉了要播的聲音。 */
  | { kind: "audio.cleared" }
  /** delegation.created：只在 item.type 是 delegation、target 是 client 時。 */
  | { kind: "delegation"; id: string; text: string }
  | { kind: "error"; code: string | null; message: string; status: number | null; fatal: boolean };

/** 致命錯誤（OpenClaw events.ts:134-151）：狀態 401 或驗證相關的代碼。 */
export const FATAL_ERROR_CODES = ["authentication_error", "invalid_api_key", "invalid_token", "token_expired"] as const;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 接受已解析的 JSON；驗證形狀；永遠不丟錯。 */
export function parseFramelessEvent(raw: unknown): FramelessEvent | null {
  const event = rec(raw);
  if (!event || typeof event.type !== "string") return null;
  switch (event.type) {
    case "session.started": {
      const expires = rec(event.session)?.expires_at;
      // 伺服器給的是秒。
      return { kind: "session.started", expires_at: typeof expires === "number" && Number.isFinite(expires) ? expires * 1000 : null };
    }
    case "input_transcript.added":
    case "output_transcript.added": {
      const item = rec(event.item);
      if (!item || typeof item.text !== "string") return null;
      return {
        kind: "transcript",
        role: event.type === "input_transcript.added" ? "user" : "assistant",
        text: item.text,
        final: false,
        item_id: str(item.id) ?? str(event.item_id),
      };
    }
    case "turn.done": {
      const turn = rec(event.turn);
      if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.transcript !== "string") return null;
      return { kind: "transcript", role: turn.role, text: turn.transcript, final: true, item_id: str(turn.id) ?? str(turn.item_id) ?? str(event.item_id) };
    }
    case "output_audio_buffer.cleared":
      return { kind: "audio.cleared" };
    case "delegation.created": {
      const item = rec(event.item);
      if (!item || item.type !== "delegation" || item.target !== "client" || !str(item.id)) return null;
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map(rec)
        .filter((part): part is Rec => !!part && part.type === "input_text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      return { kind: "delegation", id: item.id as string, text };
    }
    case "error": {
      const error = rec(event.error) ?? event;
      const statusRaw = event.status ?? error.status;
      const status = typeof statusRaw === "number" ? statusRaw : typeof statusRaw === "string" && /^\d+$/.test(statusRaw) ? Number(statusRaw) : null;
      const code = str(error.code) ?? str(event.code);
      const message = str(error.message) ?? str(event.message) ?? "即時語音錯誤";
      const fatal = status === 401 || (!!code && (FATAL_ERROR_CODES as readonly string[]).includes(code.toLowerCase()));
      return { kind: "error", code, message, status, fatal };
    }
    default:
      return null;
  }
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export const APPEND_MAX_BYTES = 500;
export const APPEND_MAX_CHARS = 1800;
const TRUNCATED = " [truncated]";

/**
 * 把一段結果切成每段 ≤ maxBytes 的 UTF-8 片段，只在字元（code point）邊界切
 * （Codex methods_frameless_bidi.rs:11、OpenClaw wire.ts:21 都是 500）。
 * 總長先限制在 maxChars（OpenClaw：1,800），超過時截斷並加上 " [truncated]"。
 */
export function chunkForAppend(text: string, maxBytes = APPEND_MAX_BYTES, maxChars = APPEND_MAX_CHARS): string[] {
  let bounded = text;
  const points = [...text];
  if (points.length > maxChars) bounded = points.slice(0, maxChars - TRUNCATED.length).join("").trimEnd() + TRUNCATED;
  if (!bounded) return [];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of bounded) {
    const size = byteLength(char);
    if (current && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}
