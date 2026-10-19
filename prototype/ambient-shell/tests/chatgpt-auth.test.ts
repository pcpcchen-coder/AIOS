import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGPTAuth, ISSUER, PLAN_SCOPE, RESOURCE } from "../server/chatgpt-auth.ts";
import { ExecutionError } from "../server/runner.ts";

// 以本機產生的 RSA 金鑰簽 ID token、假的 OpenAI 端點，驗證 SIWC 流程的每個檢查。
// 這只證明實作符合文件，不代表已在真實 ChatGPT 帳號上登入成功。

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

function signIdToken(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${enc(claims)}`;
  const sig = createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url");
  return `${body}.${sig}`;
}

interface Call {
  url: string;
  form: URLSearchParams | null;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { nonceOverride?: string; scope?: string; refreshError?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nous-auth-"));
  dirs.push(dir);
  const calls: Call[] = [];
  let clock = Date.parse("2026-10-19T12:00:00Z");
  let lastNonce = "";
  let tokenCount = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, form });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` });
    }
    if (url.endsWith("/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/oauth/revoke")) return new Response("", { status: 200 });
    if (url.endsWith("/oauth/token")) {
      const grant = form?.get("grant_type");
      if (grant === "refresh_token" && opts.refreshError) return json({ error: opts.refreshError }, 400);
      tokenCount += 1;
      return json({
        access_token: `access-${tokenCount}`,
        refresh_token: `refresh-${tokenCount}`,
        id_token: signIdToken({
          iss: ISSUER,
          aud: form?.get("client_id"),
          sub: "user-sub-1",
          email: "user@example.com",
          exp: Math.floor(clock / 1000) + 3600,
          iat: Math.floor(clock / 1000),
          nonce: opts.nonceOverride ?? lastNonce,
        }),
        token_type: "Bearer",
        expires_in: 3600,
        scope: opts.scope ?? `chatgpt.tokens.use.direct email offline_access openid profile resource.invoke`,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const changes: number[] = [];
  const auth = new ChatGPTAuth({
    dir,
    callbackPort: 0,
    onChange: () => changes.push(1),
    fetch: fakeFetch as typeof fetch,
    now: () => clock,
  });
  return {
    auth,
    dir,
    calls,
    changes,
    advance: (ms: number) => (clock += ms),
    async login(mode: "auto" | "new", callbackParams: Record<string, string> = {}) {
      const { authorize_url } = await auth.startLogin(mode);
      const params = new URL(authorize_url).searchParams;
      lastNonce = params.get("nonce")!;
      const cb = new URL(params.get("redirect_uri")!);
      cb.searchParams.set("code", "auth-code");
      cb.searchParams.set("state", params.get("state")!);
      for (const [k, v] of Object.entries(callbackParams)) cb.searchParams.set(k, v);
      const res = await fetch(cb);
      return { params, status: res.status, page: await res.text() };
    },
  };
}

describe("Sign in with ChatGPT", () => {
  it("第一次登入：動態註冊參數、PKCE、loopback 回呼、驗證 ID token 後保存憑證", async () => {
    const t = setup();
    const { params, status, page } = await t.login("auto", { client_id: "oaiapp_123" });

    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("Nous");
    expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(params.get("scope")!.split(" ")).toEqual(
      expect.arrayContaining(["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE]),
    );
    expect(params.get("resource")).toBe(RESOURCE);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("response_type")).toBe("code");

    expect(status).toBe(200);
    expect(page).toContain("已登入 ChatGPT");
    const exchange = t.calls.find((c) => c.form?.get("grant_type") === "authorization_code")!.form!;
    expect(exchange.get("client_id")).toBe("oaiapp_123");
    expect(exchange.get("redirect_uri")).toBe(params.get("redirect_uri"));
    expect(exchange.get("resource")).toBe(RESOURCE);
    expect(exchange.get("code_verifier")).toBeTruthy();

    expect(t.auth.info()).toMatchObject({ signed_in: true, plan_usage: true, email: "user@example.com", pending_login: false });
    expect(await t.auth.getAccessToken()).toBe("access-1");

    const file = join(t.dir, "chatgpt-credentials.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.registrations[0]).toMatchObject({ client_id: "oaiapp_123", subject: "user-sub-1" });
    expect(saved.ext_agent_host_id).toBe(params.get("ext_agent_host_id"));
  });

  it("重新登入沿用已核發 client_id 與主機識別，帶 id_token_hint、不帶 agent_name_hint", async () => {
    const t = setup();
    const first = await t.login("auto", { client_id: "oaiapp_123" });
    const again = await t.login("auto");
    expect(again.params.get("client_id")).toBe("oaiapp_123");
    expect(again.params.get("agent_name_hint")).toBeNull();
    expect(again.params.get("id_token_hint")).toBeTruthy();
    expect(again.params.get("login_hint")).toBe("user@example.com");
    expect(again.params.get("ext_agent_host_id")).toBe(first.params.get("ext_agent_host_id"));
    expect(again.status).toBe(200);
  });

  it("state 不符、使用者拒絕、nonce 不符、未核發 client_id 都不保存憑證", async () => {
    const t = setup();
    await t.auth.startLogin("auto");
    const bad = await t.auth.handleCallback(new URL("http://127.0.0.1/auth/callback?code=x&state=wrong"));
    expect(bad.ok).toBe(false);

    const denied = await t.login("auto", { error: "access_denied" });
    expect(denied.status).toBe(400);
    expect(denied.page).toContain("取消了授權");

    const noClient = await t.login("auto");
    expect(noClient.page).toContain("沒有核發 client_id");

    const t2 = setup({ nonceOverride: "other" });
    const nonce = await t2.login("auto", { client_id: "oaiapp_123" });
    expect(nonce.page).toContain("nonce");
    expect(t.auth.info().signed_in).toBe(false);
    expect(t2.auth.info().signed_in).toBe(false);
  });

  it("沒有 chatgpt.tokens.use.direct 時保留登入但不允許推論", async () => {
    const t = setup({ scope: "openid profile email offline_access" });
    await t.login("auto", { client_id: "oaiapp_123" });
    expect(t.auth.info()).toMatchObject({ signed_in: true, plan_usage: false });
    expect(t.auth.usable).toBe(false);
    await expect(t.auth.getAccessToken()).rejects.toMatchObject({ action: "chatgpt_sign_in" });
  });

  it("接近到期時用已核發 client_id refresh，並替換輪替的 refresh token", async () => {
    const t = setup();
    await t.login("auto", { client_id: "oaiapp_123" });
    t.advance(56 * 60_000);
    expect(await t.auth.getAccessToken()).toBe("access-2");
    const refresh = t.calls.find((c) => c.form?.get("grant_type") === "refresh_token")!.form!;
    expect(refresh.get("client_id")).toBe("oaiapp_123");
    expect(refresh.get("refresh_token")).toBe("refresh-1");
    expect(refresh.get("resource")).toBe(RESOURCE);
    expect(refresh.has("scope")).toBe(false);
    const saved = JSON.parse(readFileSync(join(t.dir, "chatgpt-credentials.json"), "utf8"));
    expect(saved.registrations[0].refresh_token).toBe("refresh-2");
  });

  it("refresh token 失效時要求重新登入", async () => {
    const t = setup({ refreshError: "invalid_grant" });
    await t.login("auto", { client_id: "oaiapp_123" });
    t.advance(60 * 60_000);
    const err = await t.auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect(err).toMatchObject({ action: "chatgpt_sign_in" });
    expect(t.auth.info()).toMatchObject({ needs_reauth: true, signed_in: false });
  });

  it("登出時撤銷 refresh token 並清除本機 token，保留 client 與主機識別", async () => {
    const t = setup();
    await t.login("auto", { client_id: "oaiapp_123" });
    expect(await t.auth.logout()).toEqual({ revoked: true });
    const revoke = t.calls.find((c) => c.url.endsWith("/oauth/revoke"))!.form!;
    expect(revoke.get("token")).toBe("refresh-1");
    expect(revoke.get("token_type_hint")).toBe("refresh_token");
    expect(revoke.get("client_id")).toBe("oaiapp_123");
    expect(t.auth.info().signed_in).toBe(false);
    const saved = JSON.parse(readFileSync(join(t.dir, "chatgpt-credentials.json"), "utf8"));
    expect(saved.registrations[0]).toMatchObject({ client_id: "oaiapp_123", access_token: null, refresh_token: null });
  });
});
