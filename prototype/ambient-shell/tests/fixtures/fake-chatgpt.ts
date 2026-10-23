import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// （fixture）假的 chatgpt.com 與 auth.openai.com：可編排的 fetch，記錄每個請求（網址、標頭、內容）。
// 權杖與帳號 ID 都是測試用的假值；回應內容不代表 OpenAI 伺服器的真實行為。

export const SECRET_TOKEN_MARK = "SECRET";

export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig_${SECRET_TOKEN_MARK}`;
}

/** 帶 chatgpt_account_id 的假 access token。 */
export function accessToken(accountId = `acct_${SECRET_TOKEN_MARK}_1`, extra: Record<string, unknown> = {}): string {
  return fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "george@example.com" },
    exp: 4_102_444_800,
    ...extra,
  });
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function scriptedFetch(handler: (req: Recorded) => Response | Promise<Response>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    const req = { url: String(input), method: init.method ?? "GET", headers, body };
    calls.push(req);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const res = await handler(req);
    return res;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** text/event-stream 的回應。 */
export function sseResponse(events: Record<string, unknown>[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Codex /responses 的一輪：先 output_item.done（函式呼叫或訊息），再 completed。 */
export function codexTurn(input: { text?: string; calls?: { name: string; arguments: Record<string, unknown>; call_id?: string }[]; model?: string }): Response {
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { model: input.model ?? "gpt-fixture-codex" } }];
  for (const [i, call] of (input.calls ?? []).entries()) {
    events.push({ type: "response.output_item.done", item: { type: "function_call", call_id: call.call_id ?? `call_${i}`, name: call.name, arguments: JSON.stringify(call.arguments) } });
  }
  if (input.text) {
    events.push({ type: "response.output_text.delta", delta: input.text });
    events.push({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: input.text, annotations: [] }] } });
  }
  events.push({ type: "response.completed", response: { model: input.model ?? "gpt-fixture-codex" } });
  return sseResponse(events);
}

/** 寫一個已登入的 codex-credentials.json（fixture）。 */
export function writeCredentials(dir: string, overrides: Record<string, unknown> = {}): { access: string; refresh: string; account: string } {
  const account = `acct_${SECRET_TOKEN_MARK}_1`;
  const access = accessToken(account);
  const refresh = `rt_${SECRET_TOKEN_MARK}_refresh`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "codex-credentials.json"),
    JSON.stringify({
      version: 1,
      access_token: access,
      refresh_token: refresh,
      id_token: null,
      expires_at: Date.now() + 3_600_000,
      account_id: account,
      email: "george@example.com",
      plan: "plus",
      obtained_at: Date.now(),
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return { access, refresh, account };
}
