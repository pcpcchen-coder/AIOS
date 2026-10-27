import { localize } from "./localization.ts";
import type { Locale } from "../shared/i18n.mjs";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { LiveAccountInfo, UnavailableReason } from "../shared/realtime-route.ts";
import { unavailableText } from "../shared/realtime-route.ts";
import type { Readiness } from "./realtime-routes.ts";

// Nous 自己的 Codex 介面登入（即時語音的 ChatGPT 方案路徑）。和 Sign in with ChatGPT（chatgpt-auth.ts）分開，
// 也和 Codex CLI 的 ~/.codex 分開：Nous 從不讀、不更新、不寫 ~/.codex。
// 權杖只存在 configDir/codex-credentials.json（0600，原子寫入），只經 withAuth() 交給
// live-route.ts／codex-responses.ts 的請求標頭；不進瀏覽器、SSE、HTTP 回應或 log。
//
// 常數（對照 Codex login/src/server.rs:77-80、:586-600、:708；OpenClaw openai-chatgpt-oauth-*.runtime.ts）：
//  client_id  app_EMoamEEZ73f0CkXaXp7hrann（Codex 的公開 client）
//  authorize  {issuer}/oauth/authorize  token {issuer}/oauth/token
//  redirect   http://127.0.0.1:{1455|1457}/auth/callback（Codex 的 redirect 白名單只有這兩個埠，不能用 0）
//  device     {issuer}/api/accounts/deviceauth/usercode → …/deviceauth/token → /oauth/token（redirect_uri {issuer}/deviceauth/callback）
//  account id access token 的 "https://api.openai.com/auth".chatgpt_account_id，沒有時看 id_token；都沒有就拒絕

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
/** Codex redirect 白名單上僅有的兩個埠。不像 SIWC 的 listenLoopback，絕不退到 0。 */
export const CODEX_CALLBACK_PORTS = [1455, 1457] as const;
/** 送給 OpenAI 的 originator：Nous 用 Codex 介面，但不假裝是 Codex CLI（codex_cli_rs）。 */
export const NOUS_ORIGINATOR = "nous";
const SCOPE = "openid profile email offline_access";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const UNUSABLE_REFRESH = new Set(["invalid_refresh_token", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_grant"]);
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

interface CodexCredentialFile {
  version: 1;
  access_token: string;
  refresh_token: string;
  id_token: string | null;
  /** access token 到期時間（epoch ms）。 */
  expires_at: number;
  account_id: string;
  email: string | null;
  plan: string | null;
  obtained_at: number;
}

/**
 * 不透明的請求憑證：權杖離開這個模組的唯一形式，而且只在 fetch／WebSocket 的標頭裡展開。
 * 標頭由函式產生（不是可列舉的屬性），toJSON／toString／inspect 都只會印出 [redacted]，
 * 所以不小心 log、JSON.stringify 或廣播都帶不出權杖（tests/codex-auth.test.ts）。
 */
export interface CodexRequestAuth {
  headers(): Record<string, string>;
  toJSON(): "[redacted]";
  toString(): "[redacted]";
}

/** 上游回 401：withAuth 會更新一次權杖再試一次。 */
export class CodexUnauthorized extends Error {
  constructor() {
    super("ChatGPT 方案登入未被接受（401）");
  }
}

/** 登入無法使用（未登入、需要重新登入、沒有帳號 ID、無法更新）。 */
export class CodexAuthError extends Error {
  constructor(readonly reason: UnavailableReason, message?: string) {
    super(message ?? unavailableText(reason));
  }
}

export type LoginStart =
  | { method: "browser"; authorize_url: string; port: number }
  | { method: "device"; verification_url: string; user_code: string; note: string | null };

export interface CodexAuthOptions {
  /** configDir（例如 ~/.config/nous）。 */
  dir: string;
  /** 登入狀態改變時呼叫（→ SSE settings.updated）。 */
  onChange(): void;
  fetch?: typeof fetch;
  now?: () => number;
  /** 測試：用兩個臨時埠代替 1455／1457。 */
  ports?: readonly number[];
  /** 測試：假的 auth.openai.com。 */
  issuer?: string;
  /** 測試：裝置代碼輪詢的等待。 */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface PendingBrowser {
  method: "browser";
  state: string;
  verifier: string;
  redirectUri: string;
  port: number;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingDevice {
  method: "device";
  user_code: string;
  verification_url: string;
  cancelled: boolean;
}

export interface CallbackResult {
  ok: boolean;
  message: string;
}

const STALE_LOGIN = "登入期間已登出，這次登入沒有保存。";

export class CodexAuth {
  readonly file: string;
  private data: CodexCredentialFile | null;
  private needsReauth = false;
  private lastError: string | null = null;
  private pending: PendingBrowser | PendingDevice | null = null;
  /** 單一進行中的更新：所有呼叫者等同一個 promise（refresh token 會輪替，不能並行更新）。 */
  private refreshing: Promise<void> | null = null;
  /**
   * 登入的世代：登出或換了新的登入就加一。進行中的更新或換 token 在 await 之後先比對世代，
   * 不同就丟掉結果（不寫檔、不復活已登出的登入），並盡力撤銷拿到的 refresh token。
   */
  private generation = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;
  private readonly ports: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CodexAuthOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.issuer = (options.issuer ?? CODEX_ISSUER).replace(/\/+$/, "");
    this.ports = options.ports ?? CODEX_CALLBACK_PORTS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.file = join(options.dir, "codex-credentials.json");
    this.data = this.load();
  }

  info(): LiveAccountInfo {
    const pending = this.pending;
    return {
      signed_in: !!this.data && !this.needsReauth,
      email: this.data?.email ?? null,
      plan: this.data?.plan ?? null,
      needs_reauth: this.needsReauth,
      pending: !pending
        ? null
        : pending.method === "browser"
          ? { method: "browser", port: pending.port }
          : { method: "device", user_code: pending.user_code, verification_url: pending.verification_url },
      last_error: this.lastError,
    };
  }

  /** 本機、同步：有沒有可用的登入。不連網（每次設定畫面都會呼叫）。 */
  readiness(): Readiness {
    if (this.needsReauth) return { ready: false, reason: "needs_reauth", message: unavailableText("needs_reauth") };
    if (!this.data) return { ready: false, reason: "not_logged_in", message: unavailableText("not_logged_in") };
    if (!this.data.account_id) return { ready: false, reason: "no_account_id", message: unavailableText("no_account_id") };
    return { ready: true };
  }

  /**
   * 開始登入。browser：綁 127.0.0.1:1455，被占用就 :1457（SIWC、OpenClaw 或 Codex 可能正占著 1455），絕不綁 0；
   * 兩個都被占用時自動改用裝置代碼登入並說明原因。再按一次會取消前一次。
   */
  async startLogin(method: "browser" | "device", locale: Locale = "zh-TW"): Promise<LoginStart> {
    this.cancel();
    if (method === "browser") {
      const bound = await this.bindCallback();
      if (bound) return this.startBrowser(bound.server, bound.port, locale);
      const note = `${this.ports.join("、")} 都被占用（可能是 OpenClaw 或 Codex 正在登入）；改用裝置代碼登入`;
      return this.startDevice(note);
    }
    return this.startDevice(null);
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.method === "browser") {
      clearTimeout(pending.timer);
      // 讓目前的回應送完再關閉監聽。
      setTimeout(() => pending.server.close(), 300).unref?.();
    } else {
      pending.cancelled = true;
    }
    this.options.onChange();
  }

  /** 刪除 codex-credentials.json；盡力到 {issuer}/oauth/revoke 撤銷 refresh token（失敗不影響本機登出）。 */
  async logout(): Promise<{ revoked: boolean }> {
    this.cancel();
    this.generation++;
    const data = this.data;
    this.data = null;
    this.needsReauth = false;
    this.lastError = null;
    rmSync(this.file, { force: true });
    let revoked = !data;
    if (data) {
      revoked = await this.revoke(data.refresh_token);
      if (!revoked) this.lastError = "已在本機登出，但未確認遠端撤銷。";
    }
    this.options.onChange();
    return { revoked };
  }

  /**
   * 用新鮮的憑證跑一個上游請求。剩不到 5 分鐘就先更新；run 丟出 CodexUnauthorized 時更新一次（單一進行中）
   * 再試一次，仍然 401 就標記需要重新登入。不能用的 refresh token 也會標記需要重新登入並通知設定畫面。
   */
  async withAuth<T>(run: (auth: CodexRequestAuth) => Promise<T>): Promise<T> {
    const first = await this.fresh();
    try {
      return await run(requestAuth(first.access_token, first.account_id));
    } catch (err) {
      if (!(err instanceof CodexUnauthorized)) throw err;
    }
    // 別人已經更新過就直接用新的；否則自己更新一次。
    if (this.data?.access_token === first.access_token) await this.refreshOnce();
    const second = this.current();
    try {
      return await run(requestAuth(second.access_token, second.account_id));
    } catch (err) {
      if (err instanceof CodexUnauthorized) {
        this.markReauth("ChatGPT 方案登入未被接受（401），請重新登入。");
        throw new CodexAuthError("needs_reauth");
      }
      throw err;
    }
  }

  // ───────── 內部 ─────────

  private current(): CodexCredentialFile {
    const ready = this.readiness();
    if (!ready.ready) throw new CodexAuthError(ready.reason, ready.message);
    return this.data!;
  }

  private async fresh(): Promise<CodexCredentialFile> {
    const data = this.current();
    if (data.expires_at - this.now() > REFRESH_MARGIN_MS) return data;
    await this.refreshOnce();
    return this.current();
  }

  private refreshOnce(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<void> {
    const data = this.current();
    const generation = this.generation;
    let result: TokenResult;
    try {
      result = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: data.refresh_token, client_id: CODEX_CLIENT_ID });
    } catch {
      if (generation !== this.generation) this.current();
      throw new CodexAuthError("network", "無法更新 ChatGPT 方案登入（網路問題），請稍後再試。");
    }
    if (generation !== this.generation) {
      // 更新期間使用者登出（或換了登入）：這個結果屬於已經不存在的登入，丟掉。
      if (result.ok && typeof result.body.refresh_token === "string") void this.revoke(result.body.refresh_token);
      this.current();
      throw new CodexAuthError("not_logged_in");
    }
    if (!result.ok) {
      if (result.code && UNUSABLE_REFRESH.has(result.code)) {
        this.markReauth("ChatGPT 方案登入已失效，請重新登入。");
        throw new CodexAuthError("needs_reauth");
      }
      throw new CodexAuthError("upstream", `無法更新 ChatGPT 方案登入（${result.error}）`);
    }
    const t = result.body;
    if (typeof t.access_token !== "string") throw new CodexAuthError("upstream", "更新 ChatGPT 方案登入時沒有收到 access token。");
    const account = accountFromTokens(t.access_token, typeof t.id_token === "string" ? t.id_token : data.id_token);
    const next: CodexCredentialFile = {
      ...data,
      access_token: t.access_token,
      // refresh token 會輪替：先寫檔，再讓任何呼叫者繼續。
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : data.refresh_token,
      id_token: typeof t.id_token === "string" ? t.id_token : data.id_token,
      expires_at: this.now() + Number(t.expires_in ?? 3600) * 1000,
      account_id: account.account_id ?? data.account_id,
      plan: account.plan ?? data.plan,
      email: account.email ?? data.email,
    };
    this.write(next);
    this.data = next;
  }

  /** 盡力到 {issuer}/oauth/revoke 撤銷一個 refresh token；回傳是否確認撤銷。 */
  private async revoke(refreshToken: string): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: CODEX_CLIENT_ID }),
      });
      await res.text().catch(() => "");
      return res.ok;
    } catch {
      return false;
    }
  }

  private markReauth(message: string): void {
    this.needsReauth = true;
    this.lastError = message;
    this.options.onChange();
  }

  private async bindCallback(): Promise<{ server: Server; port: number } | null> {
    for (const port of this.ports) {
      const server = await new Promise<Server | null>((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(null));
        s.listen(port, "127.0.0.1", () => resolve(s));
      });
      if (server) return { server, port };
    }
    return null;
  }

  private startBrowser(server: Server, port: number, locale: Locale = "zh-TW"): LoginStart {
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const verifier = randomBytes(32).toString("base64url");
    const pending: PendingBrowser = {
      method: "browser",
      state: randomBytes(24).toString("base64url"),
      verifier,
      redirectUri,
      port,
      server,
      timer: setTimeout(() => this.failPending("登入逾時，請重新開始。"), LOGIN_TIMEOUT_MS),
    };
    pending.timer.unref?.();
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname === "/cancel") {
        // Codex 的登入會先打 /cancel 叫前一個登入伺服器讓出埠：照它的約定回應並取消這次登入。
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Login cancelled");
        if (this.pending === pending) this.failPending("另一個程式（Codex 或 OpenClaw）要使用登入埠，這次登入已取消。");
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      void this.handleCallback(url).then((result) => {
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackPage(result, locale));
      });
    });
    this.pending = pending;
    this.lastError = null;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: pending.state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: NOUS_ORIGINATOR,
    });
    this.options.onChange();
    return { method: "browser", authorize_url: `${this.issuer}/oauth/authorize?${params.toString()}`, port };
  }

  /** 瀏覽器回到 loopback：驗 state、換 token、取帳號 ID（沒有就拒絕，不存）、存檔。 */
  async handleCallback(url: URL): Promise<CallbackResult> {
    const pending = this.pending;
    if (!pending || pending.method !== "browser" || url.searchParams.get("state") !== pending.state) {
      return { ok: false, message: "登入狀態不符或已過期，請回到 Nous 重新登入。" };
    }
    this.finishBrowser(pending);
    const error = url.searchParams.get("error");
    if (error) return this.fail(error === "access_denied" ? "你取消了授權，ChatGPT 方案即時語音未啟用。" : `授權失敗：${error}`);
    const code = url.searchParams.get("code");
    if (!code) return this.fail("回呼缺少授權碼。");
    return this.exchange({ code, verifier: pending.verifier, redirectUri: pending.redirectUri });
  }

  private async startDevice(note: string | null): Promise<LoginStart> {
    let res: Response;
    try {
      res = await this.fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: { "Content-Type": "application/json", originator: NOUS_ORIGINATOR },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
    } catch {
      throw this.failError(`${note ? `${note}，但` : ""}無法連線到 auth.openai.com。`);
    }
    if (res.status === 404) throw this.failError(`${note ? `${note}，但` : ""}這個伺服器沒有開放裝置代碼登入；請關掉占用 1455／1457 的登入後改用瀏覽器登入。`);
    if (!res.ok) throw this.failError(`裝置代碼登入失敗（HTTP ${res.status}）。`);
    const body = (await res.json().catch(() => ({}))) as { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown };
    const userCode = typeof body.user_code === "string" ? body.user_code : typeof body.usercode === "string" ? body.usercode : null;
    if (typeof body.device_auth_id !== "string" || !userCode) throw this.failError("裝置代碼登入的回應格式不符。");
    const intervalS = Math.max(1, Number.parseInt(String(body.interval ?? "5"), 10) || 5);
    const pending: PendingDevice = { method: "device", user_code: userCode, verification_url: `${this.issuer}/codex/device`, cancelled: false };
    this.pending = pending;
    this.lastError = note;
    this.options.onChange();
    void this.pollDevice(pending, body.device_auth_id, intervalS * 1000);
    return { method: "device", verification_url: pending.verification_url, user_code: userCode, note };
  }

  private async pollDevice(pending: PendingDevice, deviceAuthId: string, intervalMs: number): Promise<void> {
    const started = this.now();
    while (!pending.cancelled && this.pending === pending) {
      let res: Response;
      try {
        res = await this.fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", originator: NOUS_ORIGINATOR },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: pending.user_code }),
        });
      } catch {
        this.failPending("裝置代碼登入失敗：無法連線到 auth.openai.com。");
        return;
      }
      if (pending.cancelled || this.pending !== pending) return;
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { authorization_code?: unknown; code_verifier?: unknown };
        this.pending = null;
        if (typeof body.authorization_code !== "string" || typeof body.code_verifier !== "string") {
          this.fail("裝置代碼登入的回應缺少授權碼。");
          return;
        }
        await this.exchange({ code: body.authorization_code, verifier: body.code_verifier, redirectUri: `${this.issuer}/deviceauth/callback` });
        return;
      }
      await res.text().catch(() => "");
      if (res.status !== 403 && res.status !== 404) {
        this.failPending(`裝置代碼登入失敗（HTTP ${res.status}）。`);
        return;
      }
      if (this.now() - started >= DEVICE_TIMEOUT_MS) {
        this.failPending("裝置代碼登入逾時（15 分鐘），請重新開始。");
        return;
      }
      await this.sleep(intervalMs);
    }
  }

  private async exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<CallbackResult> {
    const generation = this.generation;
    let result: TokenResult;
    try {
      result = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      });
    } catch {
      if (generation !== this.generation) return { ok: false, message: STALE_LOGIN };
      return this.fail("登入失敗：無法連線到 auth.openai.com。");
    }
    if (generation !== this.generation) {
      // 換 token 期間使用者登出了：不存這個登入，盡力撤銷。
      if (result.ok && typeof result.body.refresh_token === "string") void this.revoke(result.body.refresh_token);
      return { ok: false, message: STALE_LOGIN };
    }
    if (!result.ok) return this.fail(`換取 token 失敗：${result.error}`);
    const t = result.body;
    if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string") return this.fail("token 回應缺少 access_token 或 refresh_token。");
    const idToken = typeof t.id_token === "string" ? t.id_token : null;
    const account = accountFromTokens(t.access_token, idToken);
    // 沒有帳號 ID 就不能用方案額度：拒絕，不存成可用的登入（不會在沒有 chatgpt-account-id 的情況下送出請求）。
    if (!account.account_id) return this.fail(unavailableText("no_account_id"));
    const data: CodexCredentialFile = {
      version: 1,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      id_token: idToken,
      expires_at: this.now() + Number(t.expires_in ?? 3600) * 1000,
      account_id: account.account_id,
      email: account.email,
      plan: account.plan,
      obtained_at: this.now(),
    };
    // 新的登入：之前還在跑的更新屬於舊登入，結果一律丟掉。
    this.generation++;
    this.write(data);
    this.data = data;
    this.needsReauth = false;
    this.lastError = null;
    this.options.onChange();
    return { ok: true, message: "已登入 ChatGPT 方案（Codex），可以關閉這個分頁，回到 Nous。" };
  }

  private finishBrowser(pending: PendingBrowser): void {
    if (this.pending === pending) this.pending = null;
    clearTimeout(pending.timer);
    setTimeout(() => pending.server.close(), 1000).unref?.();
  }

  private failPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.method === "browser") this.finishBrowser(pending);
    else {
      pending.cancelled = true;
      this.pending = null;
    }
    this.fail(message);
  }

  private fail(message: string): CallbackResult {
    this.lastError = message;
    this.options.onChange();
    return { ok: false, message };
  }

  private failError(message: string): Error {
    this.fail(message);
    return new Error(message);
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResult> {
    const res = await this.fetch(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 非 JSON 回應
    }
    if (res.ok) return { ok: true, body };
    const err = body.error;
    const code = typeof err === "string" ? err : typeof (err as { code?: unknown })?.code === "string" ? ((err as { code: string }).code) : null;
    const description = typeof body.error_description === "string" ? body.error_description : null;
    // 錯誤說明只取伺服器的代碼與描述，不回傳原文（原文可能夾帶權杖）。
    return { ok: false, code, error: `HTTP ${res.status}${code ? ` ${code}` : ""}${description ? `：${description.slice(0, 120)}` : ""}` };
  }

  private load(): CodexCredentialFile | null {
    if (!existsSync(this.file)) return null;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CodexCredentialFile>;
      if (data.version !== 1 || typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.account_id !== "string") {
        throw new Error("格式不符");
      }
      return data as CodexCredentialFile;
    } catch (err) {
      this.lastError = `無法讀取 ChatGPT 方案登入（${(err as Error).message}），請重新登入。`;
      (this.options.log ?? console.warn)(`無法讀取 ${this.file}：${(err as Error).message}；ChatGPT 方案即時語音需要重新登入`);
      return null;
    }
  }

  private write(data: CodexCredentialFile): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows 不支援 POSIX 權限
    }
  }
}

type TokenResult = { ok: true; body: Record<string, unknown> } | { ok: false; code: string | null; error: string };

function requestAuth(token: string, accountId: string): CodexRequestAuth {
  const auth = {
    headers: () => ({ Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId }),
    toJSON: () => "[redacted]" as const,
    toString: () => "[redacted]" as const,
    [Symbol.for("nodejs.util.inspect.custom")]: () => "[redacted]",
  };
  return auth;
}

function decodeJwt(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 純函式：從 claims 取帳號 ID、方案與 email。不驗簽章：只用來決定請求標頭與顯示，不當成身分證明
 * （OpenClaw provider-openai-chatgpt-auth.ts:34-44 也是這樣）。
 */
export function accountFromTokens(accessToken: string, idToken: string | null): { account_id: string | null; plan: string | null; email: string | null } {
  const access = decodeJwt(accessToken);
  const id = decodeJwt(idToken);
  const auth = (claims: Record<string, unknown> | null) => (claims?.[AUTH_CLAIM] ?? null) as Record<string, unknown> | null;
  const pick = (key: string) => {
    for (const source of [auth(access), auth(id)]) {
      const value = source?.[key];
      if (typeof value === "string" && value) return value;
    }
    return null;
  };
  const profile = (access?.[PROFILE_CLAIM] ?? null) as Record<string, unknown> | null;
  const email = [profile?.email, id?.email, access?.email].find((v): v is string => typeof v === "string" && !!v) ?? null;
  return { account_id: pick("chatgpt_account_id"), plan: pick("chatgpt_plan_type"), email };
}

function callbackPage(result: CallbackResult, locale: Locale = "zh-TW"): string {
  const text = localize(result.message, locale).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="${locale === "en" ? "en" : "zh-Hant-TW"}"><meta charset="utf-8"><title>Nous</title>
<body style="background:#03050b;color:#e6f4ff;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<p style="font-size:18px">${text}</p></body></html>`;
}
