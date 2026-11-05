// RPI-ID（George 2026-11-05）：終端機（Pi kiosk）頁面經 HTTP 用家人辨識與記憶的「認人」部分。
// - Pi 是一般 Chromium，沒有 App 的 preload，只能走 HTTP；George 決定一律允許（不需要 Mac 開關或配對）。terminal 識別碼只用來
//   分開各頁面的證據（identity-service.ts 的 source），不是安全機制。
// - 驗證和 IPC 共用同一份（shared/identity-validate.mjs、shared/memory-validate.mjs），之後只放行 shared/terminal.ts 列出的操作；
//   登記、刪除、校準、管理 session 與記憶管理一律 403（只在 Mac 的 App）。userInitiated 一律 false。
// - 終端機送來的只有頁面算好的特徵向量（臉 128 維、聲音 192 維）與和 IPC 相同的請求欄位；影像與錄音從不離開 Pi。
// - 記憶只回「正在用 X 的記憶」與「不是我」需要的（本次人物、人物名稱與狀態）；卡片內容、要送的聊天與記憶建議都拿掉。

import type { IdentityResponse } from "../shared/identity.ts";
import type { MemoryResponse } from "../shared/memory.ts";
import { validateIdentityRequest } from "../shared/identity-validate.mjs";
import { validateMemoryRequest } from "../shared/memory-validate.mjs";
import { isTerminalId, TERMINAL_IDENTITY_OPS, TERMINAL_MEMORY_OPS } from "../shared/terminal.ts";

export interface TerminalIdentityPort {
  handle(request: unknown, ctx: { userInitiated?: boolean; source?: string }): Promise<IdentityResponse>;
}

export interface TerminalMemoryPort {
  handle(request: unknown, ctx: { userInitiated?: boolean }): Promise<MemoryResponse>;
  /** 卡片種類（只讀）；不存在或過期是 null。 */
  cardKind(id: unknown): string | null;
}

export type TerminalRouteResult<T> = { status: 200; body: T } | { status: 400 | 403; error: string };

const TERMINAL_INVALID = "terminal must be a lowercase id (a-z, 0-9, -; up to 32 characters)";
const REFUSED = "這個操作只在 Mac 的 Nous App 提供";

function terminalOf(body: Record<string, unknown>): string | null {
  return isTerminalId(body.terminal) ? body.terminal : null;
}

function requestOf(body: Record<string, unknown>): Record<string, unknown> | null {
  const req = body.request;
  return req && typeof req === "object" && !Array.isArray(req) ? (req as Record<string, unknown>) : null;
}

/** POST /api/terminal/identity 的 body：{ terminal, request }。 */
export async function terminalIdentity(port: TerminalIdentityPort, body: Record<string, unknown>): Promise<TerminalRouteResult<IdentityResponse>> {
  const terminal = terminalOf(body);
  if (terminal === null) return { status: 400, error: TERMINAL_INVALID };
  // 先擋操作再驗形狀：管理操作不論形狀對不對一律 403。
  const op = requestOf(body)?.op;
  if (!(TERMINAL_IDENTITY_OPS as readonly unknown[]).includes(op)) return { status: 403, error: REFUSED };
  const checked = validateIdentityRequest(body.request);
  if (!checked.ok) return { status: 400, error: checked.error };
  return { status: 200, body: await port.handle(checked.request, { userInitiated: false, source: terminal }) };
}

/** POST /api/terminal/memory 的 body：{ terminal, request }。 */
export async function terminalMemory(port: TerminalMemoryPort, body: Record<string, unknown>): Promise<TerminalRouteResult<MemoryResponse>> {
  if (terminalOf(body) === null) return { status: 400, error: TERMINAL_INVALID };
  const raw = requestOf(body);
  if (!(TERMINAL_MEMORY_OPS as readonly unknown[]).includes(raw?.op)) return { status: 403, error: REFUSED };
  const checked = validateMemoryRequest(body.request);
  if (!checked.ok) return { status: 400, error: checked.error };
  const req = checked.request;
  // 本次人物選單只能用這個世代的 select_card，不能帶記憶管理的權杖。
  if (req.op === "select" && req.token !== undefined) return { status: 403, error: REFUSED };
  if (req.op === "card_answer" && req.choice !== "decline") return { status: 403, error: REFUSED };
  // 只有人物候選卡（內容只有名字）；記憶建議、語音確認等卡片的內容只給 Mac 的主視窗。
  if ((req.op === "card_view" || req.op === "card_answer") && port.cardKind(req.card) !== "face_candidate") return { status: 403, error: REFUSED };
  const res = await port.handle(req, { userInitiated: false });
  return { status: 200, body: withoutContent(res) };
}

/** 回應裡可能帶記憶內容的欄位一律拿掉；card_view 只留人物候選卡。 */
function withoutContent(res: MemoryResponse): MemoryResponse {
  if (!res.ok) return res;
  if (res.op === "card_view") return res.card.kind === "face_candidate" ? res : { ok: false, code: "unavailable", message: REFUSED };
  if (res.op === "select" || res.op === "card_answer") return { ...res, card: null, chat: null, suggestion: null };
  return res;
}
