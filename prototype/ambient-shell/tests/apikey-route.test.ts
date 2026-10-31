import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyCall } from "../server/apikey-call.ts";
import { RouteStartError } from "../server/realtime-routes.ts";
import { voicePersonaRules } from "../server/realtime.ts";
import { loadConfig } from "../server/config.ts";
import { claudeAccountKey, openaiRealtimeAccountKey, openaiRealtimeTarget } from "../server/providers.ts";
import { CORE_TOOLS } from "../shared/realtime-route.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import { gaRoute, makeCtx, until } from "./fixtures/apikey.ts";
import STORED from "./fixtures/apikey-request-baseline-658b97a.json" with { type: "json" };
import { startFakeGa, type FakeGa } from "./fixtures/fake-sideband.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CLAUDE, CODEX, enable, harness, manage, OPENAI_RT, type Harness } from "./fixtures/memory-service.ts";

// MEM-3：API key 路徑的連線（server/apikey-call.ts connectApiKey）在 Linux 上能驗的部分：假的 GA 伺服器（REST＋WebSocket 旁路）、
// 真的 RealtimeBridge 與 MemoryService。重點：記憶沒開時請求一個位元組都不差、記憶開著時的順序、旁路失敗與握手中撤銷。
// 不是 Mac gate：P1–P5（旁路真的能用 call ID 接上、收得到哪些事件）只能用真 key 驗證。全部是虛構人物與內容。

const MCP = [{ server_label: "fixture_mcp", server_url: "https://mcp.example.invalid/sse", require_approval: "always" as const }];

let ga: FakeGa;
let dir: string, key: Buffer;
const open: Harness[] = [];
beforeEach(async () => {
  ga = await startFakeGa();
  dir = mkdtempSync(join(tmpdir(), "nous-apikey-route-"));
  key = randomBytes(32);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
  await ga.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(extra: Partial<Parameters<typeof harness>[0]> = {}): Harness {
  const h = harness({ dir, key, live: CODEX, apiKey: OPENAI_RT, release: { api_key: true }, ...extra });
  open.push(h);
  return h;
}

/** George（釘選：不吃香菜、喜歡藍色）＋全家共用（釘選：家裡週末吃素），允許的同意對象由 allow 決定。 */
async function george(extra: Partial<Parameters<typeof harness>[0]> = {}, allow = [CLAUDE, OPENAI_RT]): Promise<Harness> {
  const h = make(extra);
  await enable(h, "George", allow);
  await h.turn("記住，我不吃香菜");
  await h.turn("記住，我喜歡藍色");
  const token = await manage(h);
  await h.call({ op: "edit", id: null, subject: null, value: "家裡週末吃素", token });
  for (const subject of [undefined, null]) {
    const list = await h.call({ op: "list", token, ...(subject !== undefined ? { subject } : {}) });
    for (const f of list.facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
  }
  const status = (await h.call({ op: "status" })) as unknown as { profiles: { id: string; name: string }[] };
  await h.call({ op: "select", profile: status.profiles.find((p) => p.name === "George")!.id, token: await manage(h) });
  return h;
}

/**
 * 基準快照：MEM-2 之前（658b97a）的 RealtimeBridge 送出的請求，事先產生、存成檔案（不由這次修改過的 bridge 產生）。
 * 比對時把 instructions 的日期換成 <DATE>。之後唯一刻意的改變是 F11 的身分、旁人對話與繁體規則（voicePersonaRules），
 * 接在語言那一行之後；這裡把它們插進快照，其他部分仍要一個位元組都不差。
 */
async function baseline(options: { mcp?: typeof MCP } = {}) {
  const requests = (STORED.requests as Record<string, { body: string }[]>)[options.mcp ? "mcp" : "plain"]!;
  return requests.map((request) => {
    if (!request.body.startsWith("{")) return request;
    const body = JSON.parse(request.body) as { session: { instructions: string } };
    const lines = body.session.instructions.split("\n");
    lines.splice(lines.findIndex((line) => line.startsWith("一律用繁體中文")) + 1, 0, ...voicePersonaRules("zh-TW"));
    body.session.instructions = lines.join("\n");
    return { ...request, body: JSON.stringify(body) };
  });
}

/** 這次送出的請求（去掉主機、日期正規化），和基準快照比對。 */
function sent() {
  return ga.snapshot().map((r) => ({ ...r, body: r.body.replace(/今天日期：\d{4}-\d{2}-\d{2}。/, "今天日期：<DATE>。") }));
}

describe("MEM-3 memory off: the request is byte-for-byte unchanged and no sideband opens", () => {
  it("without a memory layer the request equals the stored 658b97a snapshot: client secret with the API key, then the SDP with the client secret", async () => {
    const { route } = gaRoute(ga, null);
    await route.connect("v=0 offer", makeCtx({ now: Date.now() }).ctx);
    expect(sent()).toEqual(await baseline());
    const snap = sent();
    expect(snap.map((r) => r.path)).toEqual(["/v1/realtime/client_secrets", "/v1/realtime/calls"]);
    expect(snap[0]!.authorization).toBe(`Bearer ${ga.apiKey}`);
    expect(snap[1]!.authorization).toBe("Bearer ek_fixture_ga");
    expect(snap[1]!.body).toBe("v=0 offer");
    expect(JSON.parse(snap[0]!.body).session.tools.map((t: { name?: string }) => t.name)).not.toContain("recall_memory");
    expect(ga.upgrades).toBe(0);
  });

  it.skipIf(!realLockAvailable).each([
    ["memory never set up", async () => make()],
    ["release flag off (NOUS_MEMORY_ROUTES without api_key)", async () => george({ release: undefined })],
    ["no openai_realtime consent (Claude and codex only)", async () => george({}, [CLAUDE, CODEX])],
    ["memory turned off", async () => {
      const h = await george();
      await h.call({ op: "setup", token: await manage(h), enabled: false, subject: { kind: "household" }, allow: [] });
      return h;
    }],
  ] as const)("%s", async (_name, build) => {
    const expected = await baseline({ mcp: MCP });
    const h = await build();
    const opensBefore = h.opens.count;
    const { route, bindings } = gaRoute(ga, h, { mcp: MCP });
    const call = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    expect(sent()).toEqual(expected);
    expect(ga.upgrades).toBe(0);
    expect(call.control).toBeNull();
    expect(call.coreTools).toEqual([]);
    expect(bindings[0]!.memoryActive).toBe(false);
    expect(bindings[0]!.carriesMemory()).toBe(false);
    // 放行旗標沒開：連 store 都不為這通打開（不碰 Keychain）。
    if (_name.startsWith("release")) {
      expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "route_off" });
      expect(h.opens.count).toBe(opensBefore);
    }
    if (_name.startsWith("no openai")) expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "no_consent" });
  });

  it.skipIf(!realLockAvailable)("a page without an SSE stream never gets memory (no binding, unchanged request)", async () => {
    const expected = await baseline();
    const h = await george();
    const { route, bindings } = gaRoute(ga, h);
    await route.connect("v=0 offer", makeCtx(h.clock, { events: false }).ctx);
    expect(bindings).toEqual([]);
    expect(sent()).toEqual(expected);
    expect(ga.upgrades).toBe(0);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 memory on: lease → session.update → ack → answer", () => {
  it("opens the sideband with the API key and the call ID, sends rules + recall_memory + pinned block without MCP, and answers only after session.updated", async () => {
    const h = await george();
    ga.autoAck = false;
    const { route, bindings } = gaRoute(ga, h, { mcp: MCP });
    let answered = false;
    const connecting = route.connect("v=0 offer", makeCtx(h.clock).ctx).then((call) => ((answered = true), call));
    const conn = await ga.next();
    expect(conn.path).toBe("/v1/realtime?call_id=rtc_test");
    expect(conn.headers.authorization).toBe(`Bearer ${ga.apiKey}`);
    const update = (await conn.waitFor((e) => e.type === "session.update")) as { session: { instructions: string; tools: { name?: string; type: string }[] } };
    // lease 已在送出前取得：binding 這時就算帶著記憶（撤銷適用）。
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false);
    expect(update.session.instructions).toContain("不吃香菜");
    expect(update.session.instructions).toContain("家裡週末吃素");
    expect(update.session.instructions).toContain("（記憶資料）");
    expect(update.session.tools.map((t) => t.name)).toContain("recall_memory");
    expect(update.session.tools.some((t) => t.type === "mcp")).toBe(false);
    // client secret 的請求不帶記憶，MCP 照舊（請求內容和 MEM-2 之前一樣）。
    const secret = JSON.parse(ga.requests[0]!.body) as { session: { instructions: string; tools: { type: string }[] } };
    expect(secret.session.instructions).not.toContain("不吃香菜");
    expect(secret.session.tools.some((t) => t.type === "mcp")).toBe(true);
    conn.send({ type: "session.updated", session: {} });
    const call = await connecting;
    expect(call).toBeInstanceOf(ApiKeyCall);
    expect(call.coreTools).toEqual(CORE_TOOLS);
    expect(call.memoryStatus?.()).toEqual({ used: 3, reason: null });
    expect(bindings[0]!.carriesMemory()).toBe(true);
  });

  it("revoked after session.update was sent but before the ack (the lease already holds): 409, hangup, no page event, no stop-report wait", async () => {
    const h = await george();
    ga.autoAck = false;
    const { route, bindings } = gaRoute(ga, h);
    const probe = makeCtx(h.clock);
    const connecting = route.connect("v=0 offer", probe.ctx);
    const conn = await ga.next();
    await conn.waitFor((e) => e.type === "session.update");
    expect(bindings[0]!.carriesMemory()).toBe(false);
    h.service.suspendAll();
    await expect(connecting).rejects.toMatchObject({ status: 409 });
    await until(() => ga.hangups.length > 0);
    expect(ga.hangups).toEqual(["rtc_test"]);
    await conn.waitClosed();
    // 握手中：頁面還沒有媒體，只掛斷；不送 closed、不等停播回報、不強制靜音。
    expect(probe.events.filter((e) => e.kind === "closed")).toEqual([]);
    expect(probe.stop.asked).toBe(0);
    expect(probe.silenced).toEqual([]);
  });

  it("session.update rejected (an error carrying its event_id): hangup and 409, the answer is never returned", async () => {
    const h = await george();
    ga.rejectUpdate = true;
    const { route } = gaRoute(ga, h);
    const probe = makeCtx(h.clock);
    const err = await route.connect("v=0 offer", probe.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteStartError);
    expect(err).toMatchObject({ status: 409, fallbackable: false });
    await until(() => ga.hangups.length > 0);
    expect(ga.hangups).toEqual(["rtc_test"]);
    const conn = ga.connections[0]!;
    const update = conn.received.find((e) => e.type === "session.update")!;
    expect(String(update.event_id)).toMatch(/^nous_core_/);
    await conn.waitClosed();
    expect(probe.events).toEqual([]);
  });

  it("an error for some other event does not fail the update; no ack within the limit does: hangup and 409", async () => {
    const h = await george();
    ga.autoAck = false;
    const { route } = gaRoute(ga, h, { updateAckMs: 80 });
    const connecting = route.connect("v=0 offer", makeCtx(h.clock).ctx);
    const conn = await ga.next();
    await conn.waitFor((e) => e.type === "session.update");
    ga.error(conn, "invalid_value", "evt_page_1");
    const err = await connecting.catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409 });
    expect((err as Error).message).toContain("記憶設定沒有被即時語音確認");
    await until(() => ga.hangups.length > 0);
    await conn.waitClosed();
  });

  it("the sideband drops while waiting for the ack: hangup and an honest 502 (not 「the page left」), no page event", async () => {
    const h = await george();
    ga.autoAck = false;
    const { route } = gaRoute(ga, h);
    const probe = makeCtx(h.clock);
    const connecting = route.connect("v=0 offer", probe.ctx);
    const conn = await ga.next();
    await conn.waitFor((e) => e.type === "session.update");
    conn.drop();
    const err = await connecting.catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502 });
    expect((err as Error).message).toContain("連線期間中斷");
    await until(() => ga.hangups.length > 0);
    expect(probe.events).toEqual([]);
  });

  it("a sideband that cannot connect: the call starts without any memory (no lease, no core tools)", async () => {
    const h = await george();
    const expected = await baseline();
    ga.refuse = 1;
    const { route, bindings } = gaRoute(ga, h);
    const call = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    expect(call).not.toBeInstanceOf(ApiKeyCall);
    expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "no_control" });
    expect(call.coreTools).toEqual([]);
    expect(bindings[0]!.carriesMemory()).toBe(false);
    expect(sent()).toEqual(expected);
  });

  it("no call ID in Location: no sideband attempt, no memory", async () => {
    const h = await george();
    ga.location = null;
    const { route } = gaRoute(ga, h);
    const call = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "no_control" });
    expect(ga.upgrades).toBe(0);
  });

  it("revoked during the handshake: aborts the request and answers 409 (no fallback, nothing returned)", async () => {
    const h = await george();
    const { route } = gaRoute(ga, h);
    ga.hang = true;
    const connecting = route.connect("v=0 offer", makeCtx(h.clock).ctx);
    await until(() => ga.upgrades > 0);
    h.service.suspendAll();
    const err = await connecting.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteStartError);
    expect(err).toMatchObject({ status: 409, fallbackable: false });
    await until(() => ga.hangups.length > 0);
  });

  it("memory active without pinned facts: rules and recall_memory only, no lease until something is recalled", async () => {
    const h = make();
    await enable(h, "George", [CLAUDE, OPENAI_RT]);
    await h.turn("記住，我不喝茶");
    const { route, bindings } = gaRoute(ga, h);
    const call = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    const conn = await ga.next();
    const update = (await conn.waitFor((e) => e.type === "session.update")) as { session: { instructions: string } };
    expect(update.session.instructions).not.toContain("不喝茶");
    expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "no_pinned" });
    expect(bindings[0]!.carriesMemory()).toBe(false);
    await call.close("ended");
  });
});

describe("MEM-3 release flag and consent key", () => {
  it("NOUS_MEMORY_ROUTES opens the API key route only when it lists api_key (default off); unknown values are refused", () => {
    expect(loadConfig({}).memoryRoutes).toEqual({ api_key: false, task: false, suggest: false, work_summary: false });
    expect(loadConfig({ NOUS_MEMORY_ROUTES: "live" }).memoryRoutes).toEqual({ api_key: false, task: false, suggest: false, work_summary: false });
    expect(loadConfig({ NOUS_MEMORY_ROUTES: " live, API_KEY " }).memoryRoutes).toEqual({ api_key: true, task: false, suggest: false, work_summary: false });
    // MEM-4a：task（背景任務自動帶記憶）同樣預設關閉。
    expect(loadConfig({ NOUS_MEMORY_ROUTES: "task" }).memoryRoutes).toEqual({ api_key: false, task: true, suggest: false, work_summary: false });
    // MEM-5a：suggest（記憶建議與全家共用的「由誰記下」）同樣預設關閉。
    expect(loadConfig({ NOUS_MEMORY_ROUTES: "suggest, task" }).memoryRoutes).toEqual({ api_key: false, task: true, suggest: true, work_summary: false });
    // MEM-5b：work_summary（工作決定連到任務）同樣預設關閉。
    expect(loadConfig({ NOUS_MEMORY_ROUTES: "task,work_summary" }).memoryRoutes).toEqual({ api_key: false, task: true, suggest: false, work_summary: true });
    expect(() => loadConfig({ NOUS_MEMORY_ROUTES: "live,chatgpt" })).toThrow(/NOUS_MEMORY_ROUTES/);
  });

  it("openai_realtime is its own consent key: an HMAC of the API key (never the key), different from Claude's, and a new key is a new account", () => {
    const key = "sk-fixture-ga";
    expect(openaiRealtimeAccountKey(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(openaiRealtimeAccountKey(key)).not.toBe(claudeAccountKey(key));
    expect(openaiRealtimeAccountKey("sk-fixture-other")).not.toBe(openaiRealtimeAccountKey(key));
    expect(openaiRealtimeTarget(key)).toEqual({ provider: "openai_realtime", account: openaiRealtimeAccountKey(key), label: "OpenAI API key 即時語音" });
    expect(JSON.stringify(openaiRealtimeTarget(key))).not.toContain(key);
    expect(openaiRealtimeTarget(null)).toBeNull();
  });
});
