// RPI-ID（George 2026-11-05）：終端機（Pi kiosk）頁面經 HTTP 用家人辨識與記憶的「認人」部分。
// - Pi 是一般 Chromium，沒有 App 的 preload，只能走 HTTP；George 決定一律允許（不需要 Mac 開關或配對）。terminal 識別碼只用來
//   分開各頁面的證據（identity-service.ts 的 source），不是安全機制。
// - 驗證和 IPC 共用同一份（shared/identity-validate.mjs、shared/memory-validate.mjs），之後只放行 shared/terminal.ts 列出的操作；
//   登記、刪除、校準、管理 session 與記憶管理一律 403（只在 Mac 的 App）。userInitiated 一律 false。
// - 終端機送來的只有頁面算好的特徵向量（臉 128 維、聲音 192 維）與和 IPC 相同的請求欄位；影像與錄音從不離開 Pi。
// - 記憶的回應用 allow-list 投影（presenceStatus）：只回「正在用 X 的記憶」「不是我」與本次人物選單用到的（狀態、本次人物、
//   人物的 ID 與名字、回條）；卡片內容、要送的聊天、記憶建議、記憶筆數、未成年與連結旗標、服務帳號與同意都不給。
// - 請求以終端機識別碼為來源交給核心（ctx.source）：記憶候選與「暫停本次人物」只作用在這個頁面。
// - 認人請求的信封可以帶 page（頁面的鏡頭回報，四個 boolean，多一個或少一個欄位都 400）：Pi 本機的看著說話三個設定與鏡頭是否在跑。
//   放在信封而不是請求裡，因為請求的形狀和 Mac App 的 IPC 共用。

import type { IdentityResponse } from "../shared/identity.ts";
import type { MemoryPresenceResponse, MemoryPresenceStatus, MemoryResponse, MemoryStatusView } from "../shared/memory.ts";
import { validateIdentityRequest } from "../shared/identity-validate.mjs";
import { validateMemoryRequest } from "../shared/memory-validate.mjs";
import { isTerminalId, parseTerminalPageReport, TERMINAL_IDENTITY_OPS, TERMINAL_MEMORY_OPS, type TerminalPageReport } from "../shared/terminal.ts";

export interface TerminalIdentityPort {
  handle(request: unknown, ctx: { userInitiated?: boolean; source?: string; page?: TerminalPageReport }): Promise<IdentityResponse>;
}

export interface TerminalMemoryPort {
  handle(request: unknown, ctx: { userInitiated?: boolean; source?: string }): Promise<MemoryResponse>;
  /** 卡片種類（只讀）；不存在或過期是 null。 */
  cardKind(id: unknown): string | null;
}

export type TerminalRouteResult<T> = { status: 200; body: T } | { status: 400 | 403; error: string };

const TERMINAL_INVALID = "terminal must be a lowercase id (a-z, 0-9, -; up to 32 characters)";
const REFUSED = "這個操作只在 Mac 的 Nous App 提供";
const PAGE_INVALID = "page must be an object with exactly the booleans camera_active, look_to_talk, look_to_talk_greet, look_to_talk_greet_name";

function terminalOf(body: Record<string, unknown>): string | null {
  return isTerminalId(body.terminal) ? body.terminal : null;
}

function requestOf(body: Record<string, unknown>): Record<string, unknown> | null {
  const req = body.request;
  return req && typeof req === "object" && !Array.isArray(req) ? (req as Record<string, unknown>) : null;
}

/** POST /api/terminal/identity 的 body：{ terminal, request, page? }；page 是頁面的鏡頭回報（shared/terminal.ts TerminalPageReport）。 */
export async function terminalIdentity(port: TerminalIdentityPort, body: Record<string, unknown>): Promise<TerminalRouteResult<IdentityResponse>> {
  const terminal = terminalOf(body);
  if (terminal === null) return { status: 400, error: TERMINAL_INVALID };
  // 先擋操作再驗形狀：管理操作不論形狀對不對一律 403。
  const op = requestOf(body)?.op;
  if (!(TERMINAL_IDENTITY_OPS as readonly unknown[]).includes(op)) return { status: 403, error: REFUSED };
  const page = body.page === undefined ? undefined : parseTerminalPageReport(body.page);
  if (page === null) return { status: 400, error: PAGE_INVALID };
  const checked = validateIdentityRequest(body.request);
  if (!checked.ok) return { status: 400, error: checked.error };
  return { status: 200, body: await port.handle(checked.request, { userInitiated: false, source: terminal, ...(page ? { page } : {}) }) };
}

/** POST /api/terminal/memory 的 body：{ terminal, request }。 */
export async function terminalMemory(port: TerminalMemoryPort, body: Record<string, unknown>): Promise<TerminalRouteResult<MemoryPresenceResponse>> {
  const terminal = terminalOf(body);
  if (terminal === null) return { status: 400, error: TERMINAL_INVALID };
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
  const res = await port.handle(req, { userInitiated: false, source: terminal });
  return { status: 200, body: presenceOnly(res) };
}

function presenceStatus(status: MemoryStatusView): MemoryPresenceStatus {
  return { state: status.state, presence: status.presence, profiles: status.profiles.map(({ id, name }) => ({ id, name })) };
}

/** 只挑出列出的欄位（新加到 MemoryResponse 的欄位不會自動流到終端機）；card_view 只留人物候選卡。 */
function presenceOnly(res: MemoryResponse): MemoryPresenceResponse {
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  switch (res.op) {
    case "status":
      return { ok: true, op: "status", ...presenceStatus(res) };
    case "suspend":
      return { ok: true, op: "suspend", presence: res.presence };
    case "card_view":
      return res.card.kind === "face_candidate"
        ? { ok: true, op: "card_view", card: { kind: "face_candidate", card: res.card.card, name: res.card.name }, origin: res.origin }
        : { ok: false, code: "unavailable", message: REFUSED };
    case "select":
    case "card_answer":
      return { ok: true, op: res.op, receipts: res.receipts, presence: res.presence, history_reset: res.history_reset, status: presenceStatus(res.status) };
    default:
      return { ok: false, code: "unavailable", message: REFUSED };
  }
}
