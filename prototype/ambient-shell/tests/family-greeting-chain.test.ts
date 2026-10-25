// 家人辨識 ID-02 的整條鏈（審查修正：取代只做字面比對的測試）。全部是 fixture：
// 假的頁面（真的 SSE 串流與 HTTP）→ server/app.ts → RealtimeSessions（真的發出互動 ID、真的記錄連線）→ LiveCall（假的 chatgpt.com、
// 假的 sideband，真的 WebSocket 握手）→ server/nous.ts 的接線函式（liveGreetingSource、greetingClaims）→ IdentityService
// （替身 SecretBox、真 AES-GCM、合成特徵）。頁面的 IPC 以直接呼叫 IdentityService.handle 代表（Electron 的 ipcMain 在 Mac 驗證）。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { CodexAuth } from "../server/codex-auth.ts";
import { GalleryStore } from "../server/identity-store.ts";
import { IdentityService } from "../server/identity-service.ts";
import { LiveRoute } from "../server/live-route.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { greetingClaims, liveGreetingSource } from "../server/nous.ts";
import { ProviderManager } from "../server/providers.ts";
import { RealtimeBridge } from "../server/realtime.ts";
import { ApiKeyRoute, GREETING_CLAIM_MS, RealtimeSessions, type RealtimeRoute, type RouteCall } from "../server/realtime-routes.ts";
import { RealtimeSettingsStore } from "../server/realtime-settings.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { FaceModelVersion, IdentityResponse } from "../shared/identity.ts";
import { billingLine, type StartDecision } from "../shared/realtime-route.ts";
import { GREETING_TEMPLATES } from "../shared/sense.ts";
import { GreetingPicker } from "../server/greeting-picker.ts";
import { scriptedFetch, writeCredentials } from "./fixtures/fake-chatgpt.ts";
import { startFakeSideband, type FakeConnection, type FakeSideband } from "./fixtures/fake-sideband.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const GEORGE = unitFeature(1);
/** 固定清單裡所有可能的句子（挑句是隨機的），放在「」裡比對。 */
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const said = (name: string | null) => new RegExp(`「(${GREETING_TEMPLATES.filter((t) => t.named === (name !== null)).map((t) => esc(t.render(name))).join("|")})」`);
const NAMED = said("George");
const PLAIN = said(null);

let server: Server | null = null;
let sideband: FakeSideband | null = null;
const aborts: AbortController[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = null;
  await sideband?.close();
  sideband = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** 假的頁面：只需要 SSE 的 client_id（live 路徑要求）。 */
async function sseClient(base: string): Promise<string> {
  const controller = new AbortController();
  aborts.push(controller);
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value } = await reader.read();
    buffer += decoder.decode(value, { stream: true });
    const i = buffer.indexOf("\n\n");
    if (i >= 0) return (JSON.parse(buffer.slice(6, i)) as { client_id: string }).client_id;
  }
}

async function start() {
  sideband = await startFakeSideband();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "nous-greet-chain-"));
  dirs.push(dir);
  writeCredentials(dir);
  const store = new TaskStore(null);
  const siwc = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(siwc, { model: null }), mock: new MockExecutor(5), auth: siwc, dir, preferred: "mock", onChange: () => {} });
  const codexAuth = new CodexAuth({ dir, onChange: () => {}, fetch: scriptedFetch(() => new Response("{}", { status: 500 })).fetch });
  const prefs = new RealtimeSettingsStore({ dir, defaults: { route: "live", live_voice: "cove" }, onChange: () => {}, log: () => {} });
  // 和 server/nous.ts 同樣的接線：identity 在 app 之後才建立，閉包在呼叫時才讀；開場句挑選共用一個。
  let identity: IdentityService | null = null;
  const picker = new GreetingPicker();
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => "cove",
    model: { display: "gpt-live-1-codex", send: null },
    caller: () => ({ run: async () => ({ ok: true, channel: "speakable", text: "（fixture）", tools: [] }) }),
    instructions: () => "你是 Nous 的語音層（fixture）",
    capabilities: () => ({ webSearch: false, home: false }),
    clientVersion: "0.1.0",
    fetch: scriptedFetch(() => new Response("v=0 live-answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_chain" } })).fetch,
    urls: { call: "https://chatgpt.fixture/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas", sideband: (id) => sideband!.url(id) },
    sleep: async () => {},
    greeting: liveGreetingSource(() => identity, picker),
  });
  const bridge = new RealtimeBridge({
    apiKey: "sk-fixture",
    model: "gpt-realtime",
    voice: "marin",
    fetch: (async (url: string) => (String(url).endsWith("/client_secrets") ? new Response(JSON.stringify({ value: "ek_fixture" })) : new Response("v=0 ga-answer", { status: 201 }))) as unknown as typeof fetch,
  });
  const app = createApp({
    store,
    runner: new TaskRunner(store, providers),
    settings: providers,
    auth: siwc,
    chat: providers,
    realtime: bridge,
    realtimeRoutes: { live, api_key: new ApiKeyRoute(bridge, true, "marin") },
    realtimePrefs: prefs,
    codexAuth,
    port,
    devPort: 5173,
    distDir: null,
  });
  server = app;
  const clock = { now: Date.now() };
  const svc = new IdentityService({
    store: new GalleryStore({ dir: join(dir, "identity"), secretBox: fakeSecretBox() }),
    confirm: async () => true,
    camera: () => true,
    ambient: () => ({ look_to_talk: true, look_to_talk_greet: true, look_to_talk_greet_name: true }),
    claimGreeting: greetingClaims(() => app.realtimeSessions),
    picker,
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    now: () => clock.now,
  });
  identity = svc;
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: JSON.parse((await res.text()) || "{}") as Record<string, unknown> };
  };
  // 登記 George（管理畫面，使用者從選單列打開）。
  const opened = await svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!opened.ok || !("session" in opened)) throw new Error(JSON.stringify(opened));
  const samples = Array.from({ length: 6 }, (_, i) => Array.from(near(GEORGE, i + 1)));
  const enrolled = await svc.handle({ op: "enroll", session: opened.session, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples });
  if (!enrolled.ok) throw new Error(JSON.stringify(enrolled));
  await svc.handle({ op: "close_session", session: opened.session });
  /** 看著說話的面向等待期間：3 格 George（跨 500 ms）。 */
  const look = async (track: number) => {
    clock.now += 21_000; // 每次看著說話相隔 21 秒（問候決策每分鐘最多 3 次）；核心時鐘只影響身分證據，工作階段用真的時間
    for (let i = 0; i < 3; i++) {
      clock.now += 250;
      await svc.handle({ op: "ambient_probe", track, face_count: 1, quality: "ok", model: MODEL, feature: Array.from(near(GEORGE, 50 + i, 0.03)) });
    }
  };
  const greet = (interaction: string, track: number, route: "api_key" | "live"): Promise<IdentityResponse> =>
    svc.handle({ op: "greeting", interaction, track, eligible: true, route });
  return { base, post, svc, prefs, look, greet, clock };
}

type T = Awaited<ReturnType<typeof start>>;

async function startLive(t: T, clientId: string, source?: "look_to_talk"): Promise<{ d: Extract<StartDecision, { ok: true }>; conn: FakeConnection }> {
  const d = (await t.post("/api/realtime/start", { client_id: clientId, ...(source ? { source } : {}) })).json as StartDecision;
  if (!d.ok) throw new Error(d.message);
  expect((await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: d.session_id, owner: d.owner })).status).toBe(200);
  return { d, conn: await sideband!.next() };
}

async function spokenGreeting(t: T, d: Extract<StartDecision, { ok: true }>, conn: FakeConnection, text: string): Promise<string> {
  expect((await t.post("/api/realtime/input", { session_id: d.session_id, owner: d.owner, kind: "greeting", text })).status).toBe(200);
  const append = await conn.waitFor((e) => e.type === "session.context.append");
  return (append.content as { text: string }[])[0]!.text;
}

describe("ID-02 整條鏈：ChatGPT 方案（live）", () => {
  it("look_to_talk start → core-issued interaction → connected live session → greeting decision → POST greeting with only the ID → sideband gets 「George，我在」", async () => {
    const t = await start();
    const clientId = await sseClient(t.base);
    const { d, conn } = await startLive(t, clientId, "look_to_talk");
    expect(d.interaction).toMatch(/^int_[0-9a-f]{16}$/);
    await t.look(1);
    expect(await t.greet(d.interaction!, 1, "live")).toEqual({ ok: true, op: "greeting", text: null });
    expect(await spokenGreeting(t, d, conn, d.interaction!)).toMatch(NAMED);
    // 同一個 ID 不能再決策一次
    expect(await t.greet(d.interaction!, 1, "live")).toMatchObject({ ok: false, code: "already" });
  });

  it("a page-made ID, or a start that was not look_to_talk, never gets the name — the sideband hears 「我在」", async () => {
    const t = await start();
    const clientId = await sseClient(t.base);
    const { d, conn } = await startLive(t, clientId); // 按鈕開始：沒有互動 ID
    expect(d.interaction).toBeNull();
    const forged = "int_0123456789abcdef";
    await t.look(1);
    expect(await t.greet(forged, 1, "live")).toMatchObject({ ok: true, text: null });
    expect(await spokenGreeting(t, d, conn, forged)).toMatch(PLAIN);
  });
});

describe("ID-02 整條鏈：API key", () => {
  it("named only for the core-issued ID of a connected session; forged IDs and ended sessions get 「我在」", async () => {
    const t = await start();
    t.prefs.update({ route: "api_key" });
    const clientId = await sseClient(t.base);
    const d = (await t.post("/api/realtime/start", { client_id: clientId, source: "look_to_talk" })).json as Extract<StartDecision, { ok: true }>;
    expect(d).toMatchObject({ ok: true, route: "api_key", interaction: expect.stringMatching(/^int_/) });
    await t.look(1);
    // 還沒交換 SDP（沒有真的連上）：不給名字，而且這個 ID 之後也不能再用。
    expect(await t.greet(d.interaction!, 1, "api_key")).toMatchObject({ ok: true, text: expect.stringMatching(PLAIN) });

    const d2 = (await t.post("/api/realtime/start", { client_id: clientId, source: "look_to_talk" })).json as Extract<StartDecision, { ok: true }>;
    expect((await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: d2.session_id, owner: d2.owner })).json).toMatchObject({ route: "api_key" });
    await t.look(2);
    expect(await t.greet("int_00000000deadbeef", 2, "api_key")).toMatchObject({ ok: true, text: expect.stringMatching(PLAIN) });
    await t.look(3);
    expect(await t.greet(d2.interaction!, 3, "api_key")).toMatchObject({ ok: true, text: expect.stringMatching(NAMED) });

    const d3 = (await t.post("/api/realtime/start", { client_id: clientId, source: "look_to_talk" })).json as Extract<StartDecision, { ok: true }>;
    await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: d3.session_id, owner: d3.owner });
    await t.post("/api/realtime/end", { session_id: d3.session_id, owner: d3.owner });
    await t.look(4);
    expect(await t.greet(d3.interaction!, 4, "api_key")).toMatchObject({ ok: true, text: expect.stringMatching(PLAIN) });
  });
});

describe("RealtimeSessions.claimGreeting（假時鐘）", () => {
  function route(id: "live" | "api_key", fail = false): RealtimeRoute {
    return {
      id,
      readiness: () => ({ ready: true }),
      describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, "m"), model: "m", voice: "cove", voices: [], tools: "", detail: "fixture" }),
      baseInfo: () => ({ available: true, model: "m", detail: "fixture" }),
      async connect(): Promise<RouteCall> {
        if (fail) {
          const { RouteStartError } = await import("../server/realtime-routes.ts");
          throw new RouteStartError("usage_limit", 429, "額度已用完（fixture）", true);
        }
        return { route: id, answerSdp: "v=0 answer", model: "m", control: id === "live" ? { input: () => {} } : null, close: async () => {} };
      },
    };
  }
  function sessions(liveFails = false) {
    const clock = { now: 1_000_000 };
    const s = new RealtimeSessions({ routes: { live: route("live", liveFails), api_key: route("api_key") }, preference: () => "auto", tasks: () => [], send: () => true, now: () => clock.now });
    return { s, clock };
  }

  it("issued only for look_to_talk; usable once, only after the call connected and within GREETING_CLAIM_MS, only while the session is active", async () => {
    const { s, clock } = sessions();
    const user = s.start("sse_a");
    expect(user).toMatchObject({ ok: true, interaction: null });
    if (!user.ok) throw new Error("start");
    await s.end(user.session_id, user.owner);

    const d = s.start("sse_a", "look_to_talk");
    if (!d.ok || !d.interaction) throw new Error("start");
    expect(s.claimGreeting(d.interaction)).toBeNull(); // 還沒連上
    await s.call("v=0", d.session_id, d.owner);
    clock.now += GREETING_CLAIM_MS + 1;
    expect(s.claimGreeting(d.interaction)).toBeNull(); // 連上超過 20 秒
    await s.end(d.session_id, d.owner);

    const e = s.start("sse_a", "look_to_talk");
    if (!e.ok || !e.interaction) throw new Error("start");
    await s.call("v=0", e.session_id, e.owner);
    expect(s.claimGreeting("int_0123456789abcdef")).toBeNull(); // 核心沒發過
    expect(s.claimGreeting(e.interaction)).toEqual({ route: "live", session_id: e.session_id });
    expect(s.claimGreeting(e.interaction)).toBeNull(); // 只能一次
    await s.end(e.session_id, e.owner);

    const f = s.start("sse_a", "look_to_talk");
    if (!f.ok || !f.interaction) throw new Error("start");
    await s.call("v=0", f.session_id, f.owner);
    await s.end(f.session_id, f.owner);
    expect(s.claimGreeting(f.interaction)).toBeNull(); // 工作階段已結束
  });

  it("live → API key fallback keeps the same interaction ID and binds it to the API key session", async () => {
    const { s } = sessions(true);
    const d = s.start("sse_a", "look_to_talk");
    if (!d.ok || !d.interaction) throw new Error("start");
    const err = (await s.call("v=0", d.session_id, d.owner).catch((e: unknown) => e)) as { offer: { fallback: { session_id: string; owner: string } } };
    expect(s.claimGreeting(d.interaction)).toBeNull(); // live 沒有連上
    await s.call("v=0", err.offer.fallback.session_id, err.offer.fallback.owner);
    expect(s.claimGreeting(d.interaction)).toEqual({ route: "api_key", session_id: err.offer.fallback.session_id });
  });
});
