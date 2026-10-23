import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { accountFromTokens, CODEX_CLIENT_ID, CodexAuth, CodexAuthError, CodexUnauthorized, type CodexRequestAuth } from "../server/codex-auth.ts";
import { accessToken, fakeJwt, scriptedFetch, SECRET_TOKEN_MARK, writeCredentials } from "./fixtures/fake-chatgpt.ts";

// Nous 自己的 Codex 登入（即時語音的 ChatGPT 方案路徑）。auth.openai.com 是假的（fixture），
// 1455／1457 用兩個臨時埠代替；token 都是假值。

const servers: Server[] = [];
const auths: CodexAuth[] = [];

afterEach(async () => {
  for (const a of auths.splice(0)) a.cancel();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    ports.push((s.address() as AddressInfo).port);
    await new Promise((r) => s.close(r));
  }
  return ports;
}

async function occupy(port: number): Promise<void> {
  const s = createServer((_req, res) => res.end("busy"));
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  servers.push(s);
}

function tokenResponse(access = accessToken(), refresh = `rt_${SECRET_TOKEN_MARK}_2`) {
  return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, id_token: null, expires_in: 3600 }), { status: 200 });
}

function setup(options: { ports?: number[]; handler?: Parameters<typeof scriptedFetch>[0]; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "nous-codex-"));
  let changes = 0;
  const { fetch, calls } = scriptedFetch(options.handler ?? (() => tokenResponse()));
  const auth = new CodexAuth({ dir, onChange: () => changes++, fetch, ports: options.ports, issuer: "https://auth.fixture", sleep: async () => {} });
  auths.push(auth);
  return { auth, dir, calls, changes: () => changes };
}

describe("CodexAuth login", () => {
  it("builds the Codex authorize URL on the first callback port and stores the login 0600 with the account id", async () => {
    const ports = await freePorts(2);
    const t = setup({ ports });
    const start = await t.auth.startLogin("browser");
    if (start.method !== "browser") throw new Error("expected browser login");
    expect(start.port).toBe(ports[0]);
    const url = new URL(start.authorize_url);
    expect(url.origin + url.pathname).toBe("https://auth.fixture/oauth/authorize");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`http://127.0.0.1:${ports[0]}/auth/callback`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("codex_cli_simplified_flow")).toBe("true");
    expect(p.get("id_token_add_organizations")).toBe("true");
    expect(p.get("originator")).toBe("nous");
    expect(p.get("scope")).toBe("openid profile email offline_access");
    expect(t.auth.info().pending).toEqual({ method: "browser", port: ports[0] });

    // 錯的 state 不換 token。
    const bad = await fetch(`http://127.0.0.1:${ports[0]}/auth/callback?state=wrong&code=c`);
    expect(bad.status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${ports[0]}/auth/callback?state=${p.get("state")}&code=code_fixture`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("已登入 ChatGPT 方案（Codex）");
    const exchange = t.calls.find((c) => c.url === "https://auth.fixture/oauth/token")!;
    const form = new URLSearchParams(exchange.body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", client_id: CODEX_CLIENT_ID, code: "code_fixture", redirect_uri: `http://127.0.0.1:${ports[0]}/auth/callback` });
    expect(form.get("code_verifier")).toBeTruthy();
    expect(t.auth.info()).toMatchObject({ signed_in: true, email: "george@example.com", plan: "plus", pending: null });
    expect(t.auth.readiness()).toEqual({ ready: true });
    expect(statSync(t.auth.file).mode & 0o777).toBe(0o600);
  });

  it("uses the second Codex port when the first is busy, and device code when both are (never port 0)", async () => {
    const ports = await freePorts(2);
    await occupy(ports[0]);
    const t = setup({ ports });
    const second = await t.auth.startLogin("browser");
    expect(second).toMatchObject({ method: "browser", port: ports[1] });
    t.auth.cancel();
    await new Promise((r) => setTimeout(r, 400));
    await occupy(ports[1]);
    const polls: string[] = [];
    const d = setup({
      ports,
      handler: (req) => {
        if (req.url.endsWith("/api/accounts/deviceauth/usercode")) return new Response(JSON.stringify({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "1" }), { status: 200 });
        if (req.url.endsWith("/api/accounts/deviceauth/token")) {
          polls.push(req.body);
          return polls.length < 2 ? new Response("", { status: 403 }) : new Response(JSON.stringify({ authorization_code: "dc_code", code_verifier: "dc_verifier", code_challenge: "x" }), { status: 200 });
        }
        return tokenResponse();
      },
    });
    const device = await d.auth.startLogin("browser");
    expect(device).toMatchObject({ method: "device", user_code: "ABCD-1234", verification_url: "https://auth.fixture/codex/device" });
    if (device.method === "device") expect(device.note).toContain("都被占用");
    await expect.poll(() => d.auth.info().signed_in).toBe(true);
    const exchange = new URLSearchParams(d.calls.find((c) => c.url.endsWith("/oauth/token"))!.body);
    expect(exchange.get("redirect_uri")).toBe("https://auth.fixture/deviceauth/callback");
    expect(exchange.get("code_verifier")).toBe("dc_verifier");
  });

  it("answers Codex's /cancel probe and gives the port back", async () => {
    const ports = await freePorts(2);
    const t = setup({ ports });
    await t.auth.startLogin("browser");
    const res = await fetch(`http://127.0.0.1:${ports[0]}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Login cancelled");
    expect(t.auth.info().pending).toBeNull();
    expect(t.auth.info().last_error).toContain("登入已取消");
  });

  it("refuses a login whose token has no ChatGPT account id, and stores nothing", async () => {
    const ports = await freePorts(2);
    const t = setup({ ports, handler: () => tokenResponse(fakeJwt({ sub: "user" })) });
    const start = await t.auth.startLogin("browser");
    if (start.method !== "browser") throw new Error("expected browser login");
    const state = new URL(start.authorize_url).searchParams.get("state");
    const res = await fetch(`http://127.0.0.1:${ports[0]}/auth/callback?state=${state}&code=c`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("沒有 ChatGPT 帳號 ID");
    expect(existsSync(t.auth.file)).toBe(false);
    expect(t.auth.readiness()).toMatchObject({ ready: false, reason: "not_logged_in" });
  });
});

describe("CodexAuth.withAuth", () => {
  it("single-flight refresh: five concurrent callers with an expiring token cause one refresh, and the rotated refresh token is on disk first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-"));
    writeCredentials(dir, { expires_at: Date.now() + 60_000 });
    const fresh = accessToken(`acct_${SECRET_TOKEN_MARK}_1`, { n: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ dir, handler: async () => (await gate, tokenResponse(fresh, `rt_${SECRET_TOKEN_MARK}_rotated`)) });
    const seen: string[] = [];
    const runs = Array.from({ length: 5 }, () =>
      t.auth.withAuth(async (auth) => {
        // 呼叫者繼續時，輪替後的 refresh token 已經寫入檔案。
        expect(JSON.parse(readFileSync(t.auth.file, "utf8")).refresh_token).toBe(`rt_${SECRET_TOKEN_MARK}_rotated`);
        seen.push(auth.headers().Authorization);
        return true;
      }),
    );
    release();
    await Promise.all(runs);
    expect(t.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(new URLSearchParams(t.calls[0].body).get("grant_type")).toBe("refresh_token");
    expect(new Set(seen)).toEqual(new Set([`Bearer ${fresh}`]));
  });

  it("logout during an in-flight refresh wins: the stale refresh result is discarded (and revoked), the file stays gone", async () => {
    // 審查的探針（probe-live/logout.mts）：舊的程式在登出後被更新的結果寫回檔案，登入又活過來。
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-"));
    writeCredentials(dir, { expires_at: Date.now() + 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ dir, handler: async (req) => (req.url.endsWith("/oauth/token") ? (await gate, tokenResponse(accessToken(), `rt_${SECRET_TOKEN_MARK}_stale`)) : new Response("", { status: 200 })) });
    const run = t.auth.withAuth(async () => "ran");
    await new Promise((r) => setTimeout(r, 10));
    await t.auth.logout();
    release();
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexAuthError);
    expect(existsSync(t.auth.file)).toBe(false);
    expect(t.auth.info().signed_in).toBe(false);
    expect(t.auth.readiness()).toMatchObject({ ready: false, reason: "not_logged_in" });
    await expect.poll(() => t.calls.filter((c) => c.url.endsWith("/oauth/revoke")).map((c) => new URLSearchParams(c.body).get("token"))).toContain(`rt_${SECRET_TOKEN_MARK}_stale`);
  });

  it("logout during a login's token exchange: the login is not saved", async () => {
    const ports = await freePorts(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ ports, handler: async (req) => (req.url.endsWith("/oauth/token") ? (await gate, tokenResponse()) : new Response("", { status: 200 })) });
    const start = await t.auth.startLogin("browser");
    if (start.method !== "browser") throw new Error("expected browser login");
    const state = new URL(start.authorize_url).searchParams.get("state");
    const callback = fetch(`http://127.0.0.1:${ports[0]}/auth/callback?state=${state}&code=code_fixture`);
    await expect.poll(() => t.calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(true);
    await t.auth.logout();
    release();
    const res = await callback;
    expect(res.status).toBe(400);
    expect(existsSync(t.auth.file)).toBe(false);
    expect(t.auth.info().signed_in).toBe(false);
  });

  it("a 401 refreshes once and retries; a second 401 marks needs_reauth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-"));
    writeCredentials(dir);
    const t = setup({ dir });
    let attempts = 0;
    expect(await t.auth.withAuth(async () => {
      if (attempts++ === 0) throw new CodexUnauthorized();
      return "ok";
    })).toBe("ok");
    expect(t.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    const err = await t.auth.withAuth(async () => {
      throw new CodexUnauthorized();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as CodexAuthError).reason).toBe("needs_reauth");
    expect(t.auth.readiness()).toMatchObject({ reason: "needs_reauth" });
  });

  it("an unusable refresh token (refresh_token_reused) marks needs_reauth and tells the settings page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-"));
    writeCredentials(dir, { expires_at: Date.now() - 1 });
    const t = setup({ dir, handler: () => new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 400 }) });
    const err = await t.auth.withAuth(async () => "never").catch((e: unknown) => e);
    expect((err as CodexAuthError).reason).toBe("needs_reauth");
    expect(t.auth.info()).toMatchObject({ needs_reauth: true, signed_in: false });
    expect(t.changes()).toBeGreaterThan(0);
  });

  it("request credentials never print: JSON, string and inspect all show [redacted]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-"));
    const { access, account } = writeCredentials(dir);
    const t = setup({ dir });
    let captured: CodexRequestAuth | null = null;
    await t.auth.withAuth(async (auth) => {
      captured = auth;
    });
    const auth = captured!;
    for (const shown of [JSON.stringify({ auth }), String(auth), `${auth}`, inspect(auth), inspect({ auth })]) {
      expect(shown).not.toContain(access);
      expect(shown).not.toContain(account);
      expect(shown).toContain("[redacted]");
    }
    expect(Object.keys(auth)).not.toContain("Authorization");
    expect(auth.headers()).toEqual({ Authorization: `Bearer ${access}`, "chatgpt-account-id": account });
  });
});

describe("Codex CLI files", () => {
  it("never reads or writes ~/.codex: a sentinel auth.json there stays byte-for-byte and is never sent", async () => {
    const home = mkdtempSync(join(tmpdir(), "nous-home-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir);
    const sentinel = JSON.stringify({ tokens: { access_token: "CODEX_CLI_SENTINEL", refresh_token: "CODEX_CLI_SENTINEL_RT" } });
    writeFileSync(join(codexDir, "auth.json"), sentinel);
    const before = statSync(join(codexDir, "auth.json"));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = join(home, ".config", "nous");
      writeCredentials(dir, { expires_at: Date.now() - 1 });
      const t = setup({ dir });
      await t.auth.withAuth(async (auth) => expect(auth.headers().Authorization).not.toContain("CODEX_CLI_SENTINEL"));
      await t.auth.logout();
      for (const call of t.calls) expect(call.body + JSON.stringify(call.headers)).not.toContain("CODEX_CLI_SENTINEL");
    } finally {
      process.env.HOME = oldHome;
    }
    expect(readFileSync(join(codexDir, "auth.json"), "utf8")).toBe(sentinel);
    expect(statSync(join(codexDir, "auth.json")).mtimeMs).toBe(before.mtimeMs);
    // 原始碼本身也不碰 ~/.codex（只在註解裡提到）。
    const source = readFileSync(new URL("../server/codex-auth.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/homedir|\.codex["'/]/);
  });
});

describe("accountFromTokens", () => {
  it("reads the account id and plan from the access token, then the id token", () => {
    expect(accountFromTokens(accessToken("acct_x"), null)).toEqual({ account_id: "acct_x", plan: "plus", email: "george@example.com" });
    const id = fakeJwt({ email: "id@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_id" } });
    expect(accountFromTokens(fakeJwt({}), id)).toEqual({ account_id: "acct_id", plan: null, email: "id@example.com" });
    expect(accountFromTokens("not-a-jwt", null).account_id).toBeNull();
  });
});
