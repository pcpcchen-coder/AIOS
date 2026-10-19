import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ChatGPTAccountInfo } from "../shared/types.ts";
import { ExecutionError } from "./runner.ts";

// Sign in with ChatGPT（開源／本機 app 的 ChatGPT 方案用量流程）。
// 依 developers.openai.com/siwc/token-sharing-open-source 實作：
// 動態註冊（client_id=dynamic_agent_client）＋ PKCE ＋ 127.0.0.1 loopback 回呼，
// 驗證 ID token 與 chatgpt.tokens.use.direct 權限後，把憑證存成僅擁有者可讀的本機檔案。

export const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEFAULT_JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const DEFAULT_REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const AGENT_NAME = "Nous";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const CLOCK_SKEW_S = 120;

type Jwk = JsonWebKey & { kid?: string };

/** 已無法使用的 refresh token：清掉並要求重新登入（errors-and-recovery）。 */
const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

interface Registration {
  client_id: string;
  subject: string;
  email: string | null;
  id_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
  /** access token 到期時間（epoch ms）。 */
  expires_at: number | null;
  scopes: string[];
  saved_at: string;
}

interface CredentialFile {
  version: 1;
  issuer: string;
  /** 這台主機的穩定識別（urn:uuid:…），第一次登入前產生並沿用。 */
  ext_agent_host_id: string;
  active_client_id: string | null;
  registrations: Registration[];
  /** 已看過「正在使用 ChatGPT 方案」說明的 client。 */
  welcome_ack: string[];
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** 重新授權時沿用的已核發 client_id；新註冊為 null。 */
  clientId: string | null;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatGPTAuthOptions {
  /** 憑證目錄，例如 ~/.config/nous。 */
  dir: string;
  /** loopback 回呼埠；被占用時改用系統分配的埠。 */
  callbackPort: number;
  onChange(): void;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CallbackResult {
  ok: boolean;
  message: string;
}

export class ChatGPTAuth {
  private data: CredentialFile;
  private pending: PendingLogin | null = null;
  private refreshing: Promise<string> | null = null;
  private lastError: string | null = null;
  private needsReauth = false;
  private jwks: Jwk[] | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly file: string;

  constructor(private readonly options: ChatGPTAuthOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.file = join(options.dir, "chatgpt-credentials.json");
    this.data = this.load();
  }

  info(): ChatGPTAccountInfo {
    const reg = this.active();
    return {
      signed_in: Boolean(reg?.refresh_token || reg?.access_token),
      email: reg?.email ?? null,
      plan_usage: Boolean(reg?.scopes.includes(PLAN_SCOPE)),
      needs_reauth: this.needsReauth,
      welcome_ack: reg ? this.data.welcome_ack.includes(reg.client_id) : false,
      pending_login: this.pending !== null,
      last_error: this.lastError,
    };
  }

  /** 可以用 ChatGPT 方案推論：已登入且取得方案用量權限。 */
  get usable(): boolean {
    const i = this.info();
    return i.signed_in && i.plan_usage && !i.needs_reauth;
  }

  /**
   * 開始登入，回傳要在瀏覽器開啟的授權網址。
   * mode=auto：已有註冊就重新授權同一帳號；mode=new：註冊新帳號／工作區。
   */
  async startLogin(mode: "auto" | "new"): Promise<{ authorize_url: string }> {
    this.cancelPending();
    const reg = mode === "auto" ? this.active() : undefined;
    const { server, port } = await listenLoopback(this.options.callbackPort);
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const verifier = b64url(randomBytes(32));
    const pending: PendingLogin = {
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier,
      redirectUri,
      clientId: reg?.client_id ?? null,
      server,
      timer: setTimeout(() => this.cancelPending("登入逾時，請重新開始。"), LOGIN_TIMEOUT_MS),
    };
    pending.timer.unref?.();
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      void this.handleCallback(url).then((result) => {
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackPage(result));
      });
    });
    this.pending = pending;
    this.lastError = null;

    const params = new URLSearchParams({
      client_id: reg?.client_id ?? DYNAMIC_CLIENT,
      ext_agent_host_id: this.data.ext_agent_host_id,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    });
    if (reg) {
      if (reg.id_token) params.set("id_token_hint", reg.id_token);
      if (reg.email) params.set("login_hint", reg.email);
    } else {
      params.set("agent_name_hint", AGENT_NAME);
    }
    this.options.onChange();
    return { authorize_url: `${AUTHORIZE_URL}?${params.toString()}` };
  }

  /** 處理瀏覽器回到 loopback 的回呼：驗 state、換 token、驗 ID token 與權限、存檔。 */
  async handleCallback(url: URL): Promise<CallbackResult> {
    const pending = this.pending;
    if (!pending || url.searchParams.get("state") !== pending.state) {
      return { ok: false, message: "登入狀態不符或已過期，請回到 Nous 重新登入。" };
    }
    this.finishPending();
    try {
      const error = url.searchParams.get("error");
      if (error) {
        const message =
          error === "access_denied" ? "你取消了授權，ChatGPT 方案用量未啟用。" : `授權失敗：${error}`;
        return this.fail(message);
      }
      const code = url.searchParams.get("code");
      if (!code) return this.fail("回呼缺少授權碼。");
      const returnedClient = url.searchParams.get("client_id");
      let clientId: string;
      if (pending.clientId) {
        if (returnedClient && returnedClient !== pending.clientId) {
          return this.fail("回呼的 client_id 與選定帳號不符，已拒絕。");
        }
        clientId = pending.clientId;
      } else {
        if (!returnedClient || returnedClient === DYNAMIC_CLIENT) return this.fail("註冊未完成：回呼沒有核發 client_id。");
        clientId = returnedClient;
      }

      const tokens = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: RESOURCE,
      });
      if (!tokens.ok) return this.fail(`換取 token 失敗：${tokens.error}`);
      const t = tokens.body;
      if (typeof t.id_token !== "string" || typeof t.access_token !== "string") {
        return this.fail("token 回應缺少 id_token 或 access_token。");
      }
      const claims = await this.validateIdToken(t.id_token, clientId, pending.nonce);
      const existing = this.data.registrations.find((r) => r.client_id === clientId);
      if (pending.clientId && existing && existing.subject !== claims.sub) {
        return this.fail("登入的帳號與選定的帳號不同，未更新憑證。");
      }
      const scopes = String(t.scope ?? url.searchParams.get("scope") ?? "")
        .split(/[\s+]+/)
        .filter(Boolean);
      const reg: Registration = {
        client_id: clientId,
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : (existing?.email ?? null),
        id_token: t.id_token,
        access_token: t.access_token,
        refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : null,
        expires_at: this.now() + Number(t.expires_in ?? 3600) * 1000,
        scopes,
        saved_at: new Date(this.now()).toISOString(),
      };
      this.data.registrations = [...this.data.registrations.filter((r) => r.client_id !== clientId), reg];
      this.data.active_client_id = clientId;
      this.needsReauth = false;
      this.lastError = scopes.includes(PLAN_SCOPE) ? null : "已登入，但沒有取得 ChatGPT 方案用量權限。";
      this.save();
      this.options.onChange();
      return scopes.includes(PLAN_SCOPE)
        ? { ok: true, message: "已登入 ChatGPT。可以關閉這個分頁，回到 Nous。" }
        : { ok: true, message: "已登入，但未授權使用 ChatGPT 方案；回到 Nous 的設定可重新授權。" };
    } catch (err) {
      const network = err instanceof TypeError && /fetch failed/i.test(err.message);
      return this.fail(network ? "登入失敗：無法連線到 auth.openai.com。" : `登入失敗：${(err as Error).message}`);
    }
  }

  /** 取得可用的 access token；接近到期時先 refresh（同一時間只跑一個）。 */
  async getAccessToken(): Promise<string> {
    const reg = this.active();
    if (!reg || (!reg.access_token && !reg.refresh_token)) {
      throw new ExecutionError("尚未登入 ChatGPT，請在設定中按「Continue with ChatGPT」。", { action: "chatgpt_sign_in" });
    }
    if (!reg.scopes.includes(PLAN_SCOPE)) {
      throw new ExecutionError("這個 ChatGPT 登入沒有授權使用方案額度，請在設定中重新授權。", {
        action: "chatgpt_sign_in",
      });
    }
    if (reg.access_token && reg.expires_at !== null && reg.expires_at - this.now() > REFRESH_MARGIN_MS) {
      return reg.access_token;
    }
    this.refreshing ??= this.refresh(reg).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** 遠端請求確認 token 已失效（例如使用者在 ChatGPT 設定中斷開）時呼叫。 */
  invalidate(message: string): void {
    const reg = this.active();
    if (reg) {
      reg.access_token = null;
      reg.refresh_token = null;
      reg.expires_at = null;
      this.save();
    }
    this.needsReauth = true;
    this.lastError = message;
    this.options.onChange();
  }

  /** 登出：先撤銷 refresh token，再清除本機 token；保留 client 與主機識別供下次登入。 */
  async logout(): Promise<{ revoked: boolean }> {
    this.cancelPending();
    const reg = this.active();
    if (!reg) return { revoked: true };
    let revoked = !reg.refresh_token;
    if (reg.refresh_token) {
      const endpoint = await this.discover("revocation_endpoint", DEFAULT_REVOKE_URL);
      for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
        try {
          const res = await this.fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: reg.refresh_token,
              token_type_hint: "refresh_token",
              client_id: reg.client_id,
            }),
          });
          if (res.ok) revoked = true;
          else if (res.status < 500) break;
        } catch {
          // 網路錯誤：退避後重試
        }
        if (!revoked) await sleep(400 * 2 ** attempt);
      }
    }
    reg.access_token = null;
    reg.refresh_token = null;
    reg.id_token = null;
    reg.expires_at = null;
    this.needsReauth = false;
    this.lastError = revoked ? null : "已在本機登出，但未確認遠端撤銷；可到 ChatGPT 設定中斷開 Nous。";
    this.save();
    this.options.onChange();
    return { revoked };
  }

  ackWelcome(): void {
    const reg = this.active();
    if (!reg || this.data.welcome_ack.includes(reg.client_id)) return;
    this.data.welcome_ack.push(reg.client_id);
    this.save();
    this.options.onChange();
  }

  cancelPending(reason?: string): void {
    if (!this.pending) return;
    this.finishPending();
    if (reason) this.lastError = reason;
    this.options.onChange();
  }

  // ───────── 內部 ─────────

  private active(): Registration | undefined {
    return this.data.registrations.find((r) => r.client_id === this.data.active_client_id);
  }

  private finishPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    // 讓目前的回應送完再關閉監聽。
    setTimeout(() => p.server.close(), 1000).unref?.();
  }

  private fail(message: string): CallbackResult {
    this.lastError = message;
    this.options.onChange();
    return { ok: false, message };
  }

  private async refresh(reg: Registration): Promise<string> {
    if (!reg.refresh_token) {
      this.invalidate("ChatGPT 登入已過期，請重新登入。");
      throw new ExecutionError("ChatGPT 登入已過期，請重新登入。", { action: "chatgpt_sign_in" });
    }
    let result: Awaited<ReturnType<ChatGPTAuth["tokenRequest"]>>;
    try {
      result = await this.tokenRequest({
        grant_type: "refresh_token",
        client_id: reg.client_id,
        refresh_token: reg.refresh_token,
        resource: RESOURCE,
      });
    } catch (err) {
      throw new ExecutionError("無法更新 ChatGPT 登入（網路問題），請稍後再試。", { cause: err });
    }
    if (!result.ok) {
      if (result.code && UNUSABLE_REFRESH.has(result.code)) {
        this.invalidate("ChatGPT 登入已失效，請重新登入。");
        throw new ExecutionError("ChatGPT 登入已失效，請重新登入。", { action: "chatgpt_sign_in" });
      }
      if (result.code === "invalid_client") {
        throw new ExecutionError("ChatGPT 用戶端設定無效（invalid_client），請重新登入或改用其他帳號。", {
          action: "chatgpt_sign_in",
        });
      }
      throw new ExecutionError(`無法更新 ChatGPT 登入：${result.error}`);
    }
    const t = result.body;
    if (typeof t.access_token !== "string") throw new ExecutionError("更新 ChatGPT 登入時沒有收到 access token。");
    reg.access_token = t.access_token;
    if (typeof t.refresh_token === "string") reg.refresh_token = t.refresh_token;
    reg.expires_at = this.now() + Number(t.expires_in ?? 3600) * 1000;
    if (typeof t.scope === "string" && t.scope.trim()) reg.scopes = t.scope.split(/\s+/).filter(Boolean);
    reg.saved_at = new Date(this.now()).toISOString();
    this.save();
    return t.access_token;
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: string | null; error: string }> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 非 JSON 回應，保留原文作診斷
    }
    if (res.ok) return { ok: true, body };
    const code = typeof body.error === "string" ? body.error : null;
    const detail =
      (typeof body.error_description === "string" && body.error_description) ||
      code ||
      (typeof body.detail === "string" && body.detail) ||
      text.slice(0, 200);
    return { ok: false, code, error: `HTTP ${res.status} ${detail}` };
  }

  private async validateIdToken(idToken: string, clientId: string, nonce: string): Promise<Record<string, unknown> & { sub: string }> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("ID token 格式錯誤");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "RS256") throw new Error(`ID token 演算法不支援：${header.alg}`);
    const key = await this.findKey(header.kid);
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!ok) throw new Error("ID token 簽章驗證失敗");
    if (claims.iss !== ISSUER) throw new Error("ID token issuer 不符");
    const aud = claims.aud;
    if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) throw new Error("ID token audience 不符");
    const nowS = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw new Error("ID token 已過期");
    if (claims.nonce !== nonce) throw new Error("ID token nonce 不符");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ID token 缺少 sub");
    return claims as Record<string, unknown> & { sub: string };
  }

  private async findKey(kid: string | undefined): Promise<Jwk> {
    const pick = () => this.jwks?.find((k) => !kid || k.kid === kid);
    if (!pick()) {
      const url = await this.discover("jwks_uri", DEFAULT_JWKS_URL);
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`無法取得 JWKS（HTTP ${res.status}）`);
      this.jwks = ((await res.json()) as { keys: Jwk[] }).keys;
    }
    const key = pick();
    if (!key) throw new Error("找不到對應的簽章金鑰");
    return key;
  }

  private async discover(field: "jwks_uri" | "revocation_endpoint", fallback: string): Promise<string> {
    try {
      const res = await this.fetch(DISCOVERY_URL);
      if (res.ok) {
        const doc = (await res.json()) as Record<string, unknown>;
        if (typeof doc[field] === "string") return doc[field] as string;
      }
    } catch {
      // 使用文件記載的預設端點
    }
    return fallback;
  }

  private load(): CredentialFile {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as CredentialFile;
      data.welcome_ack ??= [];
      return data;
    }
    const data: CredentialFile = {
      version: 1,
      issuer: ISSUER,
      ext_agent_host_id: `urn:uuid:${randomUUID()}`,
      active_client_id: null,
      registrations: [],
      welcome_ack: [],
    };
    this.write(data);
    return data;
  }

  private save(): void {
    this.write(this.data);
  }

  private write(data: CredentialFile): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows 不支援 POSIX 權限
    }
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 在 127.0.0.1 開回呼監聽；指定埠被占用時改用系統分配的埠（文件允許只變更埠號）。 */
async function listenLoopback(port: number): Promise<{ server: Server; port: number }> {
  const tryListen = (p: number) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => resolve(server));
    });
  let server: Server;
  try {
    server = await tryListen(port);
  } catch {
    server = await tryListen(0);
  }
  return { server, port: (server.address() as AddressInfo).port };
}

function callbackPage(result: CallbackResult): string {
  const text = result.message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><title>Nous</title>
<body style="background:#03050b;color:#e6f4ff;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<p style="font-size:18px">${text}</p></body></html>`;
}
