// RPI-ID（George 2026-11-05）：Pi 終端機經 HTTP 的認人與「正在用 X 的記憶」。
// 全部是 fixture：合成的單位特徵向量（不是真的臉）、替身 SecretBox、假時鐘、假的核心埠與假的 fetch。
// 證明的是路由放行哪些操作、證據依頁面分開、頁面選哪個傳輸；不證明 Pi 的鏡頭、模型或實際辨識準確度（留給 Pi 實測）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { GalleryStore } from "../server/identity-store.ts";
import { IdentityService, type AmbientPrefs } from "../server/identity-service.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { terminalIdentity, terminalMemory, type TerminalIdentityPort, type TerminalMemoryPort } from "../server/terminal-routes.ts";
import { validateIdentityRequest as ipcValidateIdentity } from "../desktop/identity-ipc.mjs";
import { validateMemoryRequest as ipcValidateMemory } from "../desktop/memory-ipc.mjs";
import { IDENTITY_OPS, type FaceModelVersion, type IdentityResponse } from "../shared/identity.ts";
import { MEMORY_OPS, type MemoryPresenceResponse, type MemoryRequest, type MemoryResponse, type MemoryStatusView } from "../shared/memory.ts";
import { isTerminalId, MAIN_SOURCE, PAGE_PACE, pageSource, pageTerminal, TERMINAL_IDENTITY_OPS, TERMINAL_MEMORY_OPS } from "../shared/terminal.ts";
import { selectBridges } from "../src/identity-bridge.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";
import { enable, harness, selectProfile, type Harness } from "./fixtures/memory-service.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { RealtimeSessions, type RealtimeRoute, type RouteCall, type SessionContext } from "../server/realtime-routes.ts";
import { billingLine } from "../shared/realtime-route.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const GEORGE = unitFeature(1);
const MARY = unitFeature(2);
const CARD = "mc_0123456789abcdef01234567";
const id = (n: number) => `int_${n.toString(16).padStart(16, "0")}`;
const src = join(import.meta.dirname, "..", "src");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-terminal-id-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─────────────── 核心：證據依頁面分開 ───────────────

function core() {
  const clock = { now: 1_000_000 };
  const prefs: AmbientPrefs = { look_to_talk: true, look_to_talk_greet: true, look_to_talk_greet_name: true };
  const claims = new Map<string, { route: "api_key" | "live"; session_id: string }>();
  const svc = new IdentityService({
    claimGreeting: (interaction) => {
      const claim = claims.get(interaction) ?? null;
      claims.delete(interaction);
      return claim;
    },
    store: new GalleryStore({ dir: join(root, "identity"), secretBox: fakeSecretBox() }),
    confirm: async () => true,
    camera: () => true,
    ambient: () => prefs,
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    now: () => clock.now,
  });
  return { svc, clock, claims };
}
type Core = ReturnType<typeof core>;

async function enroll(c: Core, people: [string, Float32Array][]): Promise<void> {
  const opened = await c.svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!opened.ok || !("session" in opened)) throw new Error(JSON.stringify(opened));
  for (const [name, base] of people) {
    c.clock.now += 1000;
    const samples = Array.from({ length: 6 }, (_, i) => Array.from(near(base, i + 1)));
    const res = await c.svc.handle({ op: "enroll", session: opened.session, name, minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples });
    if (!res.ok) throw new Error(JSON.stringify(res));
  }
  await c.svc.handle({ op: "close_session", session: opened.session });
}

/** 兩個頁面交錯送畫格（各自的 track 計數器都從 1 開始）。 */
async function frames(c: Core, shots: { source: string; track: number; face: Float32Array | "multi" }[], rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const s of shots) {
      c.clock.now += 150;
      const body = s.face === "multi" ? { face_count: 2, quality: "multi_face" } : { face_count: 1, quality: "ok", feature: Array.from(near(s.face, (i * 7 + s.track) % 997, 0.03)) };
      const res = await c.svc.handle({ op: "ambient_probe", track: s.track, model: MODEL, ...body }, { source: s.source });
      expect(res).toEqual({ ok: true, op: "ambient_probe" });
    }
  }
}

async function greet(c: Core, interaction: string, track: number, source?: string): Promise<IdentityResponse> {
  c.claims.set(interaction, { route: "api_key", session_id: `rt_${interaction.slice(4)}` });
  return c.svc.handle({ op: "greeting", interaction, track, eligible: true, route: "api_key" }, source ? { source } : {});
}
const named = (res: IdentityResponse, name: string) => res.ok && res.op === "greeting" && typeof res.text === "string" && res.text.includes(name);

describe("IdentityService keeps evidence per page (Mac main window vs. terminal)", () => {
  it("the same track number on two pages does not collide: each page is greeted by its own face", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE], ["Mary", MARY]]);
    await frames(c, [{ source: "main", track: 1, face: GEORGE }, { source: "rpi4", track: 1, face: MARY }], 5);
    const pi = await greet(c, id(1), 1, "rpi4");
    expect(named(pi, "Mary")).toBe(true);
    expect(named(pi, "George")).toBe(false);
    const mac = await greet(c, id(2), 1);
    expect(named(mac, "George")).toBe(true);
  });

  it("evidence from one page never names the other page's greeting; a multi-face page does not spoil the other", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE]]);
    await frames(c, [{ source: "main", track: 3, face: GEORGE }, { source: "rpi4", track: 3, face: "multi" }], 5);
    // Pi 看到多張臉：Pi 的問候不稱名；Mac 的證據沒有被 Pi 的多臉作廢。
    expect(named(await greet(c, id(3), 3, "rpi4"), "George")).toBe(false);
    expect(named(await greet(c, id(4), 3), "George")).toBe(true);
    // 只有 Mac 有證據：Pi 用同一個 track 號碼也拿不到 Mac 的名字（問候決策每分鐘最多 3 次：先等一分鐘）。
    c.clock.now += 61_000;
    await frames(c, [{ source: "main", track: 4, face: GEORGE }], 6);
    expect(named(await greet(c, id(5), 4, "rpi4"), "George")).toBe(false);
    expect(named(await greet(c, id(6), 4), "George")).toBe(true);
  });

  it("the sampling rate limit is per page (two pages at full rate are both accepted)", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE]]);
    for (let i = 0; i < 6; i++) {
      for (const source of ["main", "rpi4"]) {
        const res = await c.svc.handle({ op: "ambient_probe", track: 1, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(GEORGE, i)) }, { source });
        expect(res, `${source} #${i}`).toEqual({ ok: true, op: "ambient_probe" });
      }
    }
    expect(await c.svc.handle({ op: "ambient_probe", track: 1, model: MODEL, face_count: 0, quality: "no_face" }, { source: "rpi4" })).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("memory candidates are scoped to the asking page: a Pi match never selects for the Mac, and the Mac's never for the Pi", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE], ["Mary", MARY]]);
    await frames(c, [{ source: "rpi4", track: 1, face: MARY }], 6);
    await greet(c, id(7), 1, "rpi4");
    expect(c.svc.memoryFaceCandidate("main")).toBeNull();
    expect(c.svc.memoryCandidate("main")).toBeNull();
    expect(c.svc.memoryFaceCandidate("rpi4")).toMatchObject({ name: "Mary", source: "face" });
    c.clock.now += 1000;
    await frames(c, [{ source: "main", track: 1, face: GEORGE }], 6);
    await greet(c, id(8), 1);
    expect(c.svc.memoryFaceCandidate("main")).toMatchObject({ name: "George" });
    expect(c.svc.memoryCandidate("rpi4")).toMatchObject({ name: "Mary" });
    expect(c.svc.memoryFaceCandidate("kitchen")).toBeNull();
  });

  it("a management session on the Mac still blocks every page", async () => {
    const c = core();
    await enroll(c, [["Mary", MARY]]);
    const opened = await c.svc.handle({ op: "open_session" }, { userInitiated: true });
    expect(opened.ok).toBe(true);
    c.clock.now += 1000;
    const blocked = await c.svc.handle({ op: "ambient_probe", track: 2, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(MARY, 1)) }, { source: "rpi4" });
    expect(blocked).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("rotating terminal ids cannot exceed the old core-wide sampling limits; the Mac keeps its own", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE]]);
    const probe = (source: string, n: number) => c.svc.handle({ op: "ambient_probe", track: 1, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(GEORGE, n)) }, { source });
    for (let i = 0; i < 6; i++) expect(await probe(`pi-${i}`, i), `pi-${i}`).toEqual({ ok: true, op: "ambient_probe" });
    expect(await probe("pi-6", 6)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await probe("main", 7)).toEqual({ ok: true, op: "ambient_probe" });
    // 喚醒聲音（每秒 4 次）與通話中聲音（每秒 2 次）也一樣是所有終端機合計。
    const voice = (source: string) => c.svc.handle({ op: "voice_probe", wake_id: id(1), segment: "keyword", voiced_ms: 100 }, { source });
    const calls = (source: string) => c.svc.handle({ op: "call_voice", voiced_ms: 100 }, { source });
    for (let i = 0; i < 4; i++) expect(await voice(`v-${i}`)).not.toMatchObject({ code: "rate_limited" });
    expect(await voice("v-4")).toMatchObject({ ok: false, code: "rate_limited" });
    for (let i = 0; i < 2; i++) expect(await calls(`c-${i}`)).not.toMatchObject({ code: "rate_limited" });
    expect(await calls("c-2")).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("malformed requests and invalid sources are refused before they create a page or use the rate limit", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE]]);
    for (let i = 0; i < 12; i++) {
      expect(await c.svc.handle({ op: "ambient_probe", track: -1, model: MODEL, face_count: 1, quality: "ok" }, { source: `bad-${i}` })).toMatchObject({ ok: false, code: "bad_request" });
    }
    for (const source of ["RPI4", "", "a b"]) expect(await c.svc.handle({ op: "ambient_status" }, { source })).toMatchObject({ ok: false, code: "bad_request" });
    for (let i = 0; i < 6; i++) {
      expect(await c.svc.handle({ op: "ambient_probe", track: 1, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(GEORGE, i)) }, { source: "rpi4" })).toEqual({ ok: true, op: "ambient_probe" });
    }
  });

  it("the Mac's evidence is never evicted by many terminals", async () => {
    const c = core();
    await enroll(c, [["George", GEORGE], ["Mary", MARY]]);
    await frames(c, [{ source: "main", track: 1, face: GEORGE }], 6);
    await greet(c, id(11), 1);
    for (let i = 0; i < 12; i++) {
      c.clock.now += 1000;
      await frames(c, [{ source: `pi-${i}`, track: 1, face: MARY }], 1);
    }
    expect(c.svc.memoryFaceCandidate("main")).toMatchObject({ name: "George" });
  });

  it("a wake greeting window relaxes look-to-talk sampling only on the page that woke", async () => {
    const wakeOn = new Set<string>();
    const clock = { now: 1_000_000 };
    const svc = new IdentityService({
      store: new GalleryStore({ dir: join(root, "identity"), secretBox: fakeSecretBox() }),
      confirm: async () => true,
      camera: () => true,
      ambient: () => ({ look_to_talk: false, look_to_talk_greet: false, look_to_talk_greet_name: true }),
      wakeGreetingOpen: (source) => wakeOn.has(source),
      runtime: { state: "ok", problems: [] },
      model: MODEL,
      now: () => clock.now,
    });
    const opened = await svc.handle({ op: "open_session" }, { userInitiated: true });
    if (!opened.ok || !("session" in opened)) throw new Error(JSON.stringify(opened));
    await svc.handle({ op: "enroll", session: opened.session, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: Array.from({ length: 6 }, (_, i) => Array.from(near(GEORGE, i + 1))) });
    await svc.handle({ op: "close_session", session: opened.session });
    wakeOn.add("rpi4");
    expect(await svc.handle({ op: "ambient_status" }, { source: "rpi4" })).toEqual({ ok: true, op: "ambient_status", ready: true });
    expect(await svc.handle({ op: "ambient_status" })).toEqual({ ok: true, op: "ambient_status", ready: false });
    expect(await svc.handle({ op: "ambient_probe", track: 1, model: MODEL, face_count: 0, quality: "no_face" })).toMatchObject({ ok: false, code: "unavailable" });
  });
});

// ─────────────── 記憶：候選與暫停只作用在發問的頁面 ───────────────

const PERSON = "fam_000000000000000000000001";

describe.skipIf(!realLockAvailable)("MemoryService scopes face candidates and presence to the page", () => {
  const open: Harness[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((h) => h.close())); });

  /** hits：各頁面目前的臉部候選（替身，代表 IdentityService.memoryCandidate(page)）。 */
  async function linked(hits: Map<string, { person_id: string; name: string; at: number }>): Promise<Harness> {
    const identity = { candidate: (page: string) => hits.get(page) ?? null, faceCandidate: (page: string) => hits.get(page) ?? null, people: () => [{ person_id: PERSON, name: "George", minor: false }] };
    const h = harness({ dir: join(root, "memory"), key: Buffer.alloc(32, 7), identity });
    open.push(h);
    await enable(h, "George");
    const token = await h.call({ op: "list", manage: true }, { userInitiated: true });
    const george = (token.status as { profiles: { id: string }[] }).profiles[0]!.id;
    await h.call({ op: "link_face", profile: george, person: PERSON, token: token.manage });
    await selectProfile(h, null);
    return h;
  }

  it("typed chat on the Mac is not auto-selected by a face seen on the Pi; a same-page match still selects", async () => {
    const hits = new Map<string, { person_id: string; name: string; at: number }>();
    const h = await linked(hits);
    hits.set("rpi4", { person_id: PERSON, name: "George", at: h.clock.now });
    const mac = await h.turn("晚餐吃什麼");
    expect(mac.auto_selected).toBeUndefined();
    expect(mac.presence).toMatchObject({ state: "unselected" });
    hits.set("main", { person_id: PERSON, name: "George", at: h.clock.now + 1 });
    const same = await h.turn("晚餐吃什麼");
    expect(same.auto_selected).toBe(true);
    expect(same.presence).toMatchObject({ state: "selected", name: "George" });
  });

  it("a live call proposes only its own page's candidate (Pi call ignores the Mac's face, Mac call ignores the Pi's)", async () => {
    const hits = new Map<string, { person_id: string; name: string; at: number }>();
    const h = await linked(hits);
    hits.set("main", { person_id: PERSON, name: "George", at: h.clock.now });
    expect(h.service.liveFaceCandidate("rpi4")).toBeNull();
    hits.delete("main");
    hits.set("rpi4", { person_id: PERSON, name: "George", at: h.clock.now + 1 });
    expect(h.service.liveFaceCandidate("main")).toBeNull();
    const card = h.service.liveFaceCandidate("rpi4");
    expect(card).toMatchObject({ name: "George" });
    expect(await h.service.answerLiveCandidate(card!.card, true)).toBe("ok");
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected", name: "George" });
    const binding = h.service.openLive({ lookToTalk: true, rebuild: false, now: () => h.clock.now, page: "rpi4" });
    expect(binding.page).toBe("rpi4");
    expect(h.service.openLive({ lookToTalk: true, rebuild: false, now: () => h.clock.now }).page).toBe("main");
  });

  it("a suspend from another page does not suspend the current person; the page that selected it can", async () => {
    const h = await linked(new Map());
    const st = await h.call({ op: "status" });
    const george = (st.profiles as { id: string }[])[0]!.id;
    await selectProfile(h, george);
    expect(await h.call({ op: "suspend", reason: "tracking_lost" }, { source: "rpi4" })).toMatchObject({ ok: true, op: "suspend", presence: { state: "selected", name: "George" } });
    h.service.suspend("multi_face", "rpi4");
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected" });
    expect(await h.call({ op: "suspend", reason: "multi_face" })).toMatchObject({ presence: { state: "suspended" } });
    // Pi 選的人：Mac 的鏡頭事件不暫停，Pi 的會。
    const card = ((await h.call({ op: "status" })).presence as { select_card: string }).select_card;
    await h.call({ op: "select", profile: george, card }, { source: "rpi4" });
    expect(await h.call({ op: "suspend", reason: "tracking_lost" })).toMatchObject({ presence: { state: "selected" } });
    expect(await h.call({ op: "suspend", reason: "tracking_lost" }, { source: "rpi4" })).toMatchObject({ presence: { state: "suspended" } });
  });

  it("a disagreeing in-call voice on another page does not undo the Mac's default selection", async () => {
    const hits = new Map<string, { person_id: string; name: string; at: number }>();
    const h = await linked(hits);
    hits.set("main", { person_id: PERSON, name: "George", at: h.clock.now });
    expect((await h.turn("晚餐吃什麼")).auto_selected).toBe(true);
    h.service.voiceDisagrees("rpi4");
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected" });
    h.service.voiceDisagrees("main");
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
  });
});

describe("RealtimeSessions carries the starting page", () => {
  function sessions(seen: SessionContext[]) {
    const route = (id: "live" | "api_key"): RealtimeRoute => ({
      id,
      readiness: () => ({ ready: true }),
      describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, "m"), model: "m", voice: "cove", voices: [], tools: "", detail: "fixture" }),
      baseInfo: () => ({ available: true, model: "m", detail: "fixture" }),
      async connect(_sdp: string, ctx: SessionContext): Promise<RouteCall> {
        seen.push(ctx);
        return { route: id, answerSdp: "v=0 answer", model: "m", control: id === "live" ? { input: () => {} } : null, close: async () => {} };
      },
    });
    return new RealtimeSessions({ routes: { live: route("live"), api_key: route("api_key") }, preference: () => "auto", tasks: () => [], send: () => true, now: () => 1_000_000 });
  }

  it("the session context names the page (memory candidates use it) and the wake window is per page", async () => {
    const seen: SessionContext[] = [];
    const s = sessions(seen);
    const pi = s.start("sse_pi", "wake_word", "zh-TW", false, id(20), "rpi4");
    if (!pi.ok) throw new Error("start");
    expect(s.wakeGreetingOpen("rpi4")).toBe(true);
    expect(s.wakeGreetingOpen("main")).toBe(false);
    await s.call("v=0", pi.session_id, pi.owner);
    expect(seen.at(-1)?.page).toBe("rpi4");
    await s.end(pi.session_id, pi.owner);
    const mac = s.start("sse_mac", "user");
    if (!mac.ok) throw new Error("start");
    await s.call("v=0", mac.session_id, mac.owner);
    expect(seen.at(-1)?.page).toBe("main");
  });
});

// ─────────────── 路由：只放行認人與本次人物 ───────────────

function identityPort(): TerminalIdentityPort & { calls: { request: unknown; ctx: unknown }[] } {
  const calls: { request: unknown; ctx: unknown }[] = [];
  return { calls, handle: async (request, ctx) => { calls.push({ request, ctx }); return { ok: true, op: "ambient_status", ready: true } as IdentityResponse; } };
}

const FEATURE = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
const VOICE = Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0));
const SPEAKER = { speaker: "campplus-zh-en@abc", preproc: "fbank80-v1", dim: 192 };
const ALLOWED_IDENTITY: Record<string, Record<string, unknown>> = {
  ambient_status: { op: "ambient_status" },
  ambient_probe: { op: "ambient_probe", track: 3, face_count: 1, quality: "ok", model: MODEL, feature: FEATURE },
  greeting: { op: "greeting", interaction: id(9), track: 3, eligible: true, route: "live" },
  voice_probe: { op: "voice_probe", wake_id: id(10), segment: "keyword", voiced_ms: 600, model: SPEAKER, feature: VOICE },
  call_voice: { op: "call_voice", voiced_ms: 1500, model: SPEAKER, feature: VOICE },
};

describe("POST /api/terminal/identity (server/terminal-routes.ts)", () => {
  it("allows exactly the no-session recognition ops, with userInitiated false and the terminal as the source", async () => {
    expect([...TERMINAL_IDENTITY_OPS].sort()).toEqual(Object.keys(ALLOWED_IDENTITY).sort());
    for (const [op, request] of Object.entries(ALLOWED_IDENTITY)) {
      const port = identityPort();
      const out = await terminalIdentity(port, { terminal: "rpi4", request: { ...request, extra: "dropped" } });
      expect(out.status, op).toBe(200);
      const checked = ipcValidateIdentity(request);
      expect(checked.ok, op).toBe(true);
      expect(port.calls, op).toEqual([{ request: checked.ok ? checked.request : null, ctx: { userInitiated: false, source: "rpi4" } }]);
    }
  });

  it("every management, enrollment, deletion, calibration and session op is 403 and never reaches the core (even when well formed)", async () => {
    const refused = IDENTITY_OPS.filter((op) => !(TERMINAL_IDENTITY_OPS as readonly string[]).includes(op));
    expect(refused.sort()).toEqual(["ack_naming", "calib_apply", "calib_clear", "calib_status", "calib_trial", "clear_all", "close_session", "delete", "delete_voice", "enroll", "enroll_voice", "list", "open_session", "probe", "voice_test"]);
    for (const op of [...refused, "nope", undefined]) {
      const port = identityPort();
      const out = await terminalIdentity(port, { terminal: "rpi4", request: { op, session: `ids_${"0".repeat(32)}` } });
      expect(out.status, String(op)).toBe(403);
      expect(port.calls).toEqual([]);
    }
  });

  it("bad terminal ids are 400; bad shapes are rejected with the same error as the IPC filter", async () => {
    for (const terminal of [undefined, "", "RPI4", "-pi", "a".repeat(33), 4, "pi 4"]) {
      expect((await terminalIdentity(identityPort(), { terminal, request: { op: "ambient_status" } })).status, String(terminal)).toBe(400);
    }
    const bad = [
      { op: "ambient_probe", track: 1, face_count: 1, quality: "ok" },
      { op: "ambient_probe", track: -1, face_count: 1, quality: "ok", model: MODEL },
      { op: "ambient_probe", track: 1, face_count: 1, quality: "ok", model: MODEL, feature: [1, 2, 3] },
      { op: "greeting", interaction: "int_x", track: 1, eligible: true, route: "live" },
      { op: "greeting", interaction: id(1), track: 1, eligible: "yes", route: "live" },
      { op: "voice_probe", wake_id: id(1), segment: "song", voiced_ms: 600, model: SPEAKER },
      { op: "call_voice", voiced_ms: 1500, model: SPEAKER, feature: [Number.NaN, ...VOICE.slice(1)] },
    ];
    for (const request of bad) {
      const port = identityPort();
      const out = await terminalIdentity(port, { terminal: "rpi4", request });
      const ipc = ipcValidateIdentity(request);
      expect(ipc.ok).toBe(false);
      expect(out).toEqual({ status: 400, error: ipc.ok ? null : ipc.error });
      expect(port.calls).toEqual([]);
    }
  });
});

const presence = { state: "selected" as const, epoch: 3, select_card: "mc_000000000000000000000003", profile: "profile_0123456789abcdef", name: "George", reason: null };
const status: MemoryStatusView = {
  state: "ready", reason: null, enabled: true, setup_done: true, presence,
  profiles: [{ id: "profile_0123456789abcdef", name: "George", minor: false, linked: true, facts: 2 }],
  target: { provider: "claude", account: "fp0000claude0001", label: "Claude", allowed: true, household_allowed: true },
  targets: [{ provider: "claude", account: "fp0000claude0001", label: "Claude", allowed: true, household_allowed: true }],
  active_facts: 2, limits: { facts: 1000, profiles: 20, value_chars: 512 }, suggestions: { available: true, enabled: true },
};

function memoryPort(kind: string | null = "face_candidate", reply?: (req: Record<string, unknown>) => MemoryResponse): TerminalMemoryPort & { calls: { request: unknown; ctx: unknown }[] } {
  const calls: { request: unknown; ctx: unknown }[] = [];
  return {
    calls,
    cardKind: () => kind,
    handle: async (request, ctx) => {
      calls.push({ request, ctx });
      const req = request as Record<string, unknown>;
      if (reply) return reply(req);
      switch (req.op) {
        case "status": return { ok: true, op: "status", ...status };
        case "suspend": return { ok: true, op: "suspend", presence };
        case "card_view": return { ok: true, op: "card_view", card: { kind: "face_candidate", card: CARD, name: "George" }, origin: "live" };
        default:
          // 假設核心回了內容（卡片、聊天與建議）：路由必須拿掉。
          return { ok: true, op: req.op as "select", receipts: [], card: { kind: "setup", card: CARD, text: "私人內容" }, chat: { text: "私人內容", memory_turn: null }, presence, history_reset: false, notice: null, suggestion: { card: CARD }, status };
      }
    },
  };
}

describe("POST /api/terminal/memory (server/terminal-routes.ts)", () => {
  it("allows status, suspend, select (household or a profile, with this generation's select_card) and the face-candidate card; userInitiated false, the terminal as the source", async () => {
    expect([...TERMINAL_MEMORY_OPS]).toEqual(["status", "suspend", "select", "card_view", "card_answer"]);
    const ok: MemoryRequest[] = [
      { op: "status" },
      { op: "suspend", reason: "multi_face" },
      { op: "select", profile: null, card: presence.select_card },
      { op: "select", profile: "profile_0123456789abcdef", card: presence.select_card },
      { op: "card_view", card: CARD },
      { op: "card_answer", card: CARD, choice: "decline" },
    ];
    for (const request of ok) {
      const port = memoryPort();
      const out = await terminalMemory(port, { terminal: "rpi4", request });
      expect(out.status, request.op).toBe(200);
      expect(port.calls, request.op).toEqual([{ request, ctx: { userInitiated: false, source: "rpi4" } }]);
    }
  });

  it("returns only the presence projection: no memory content, fact counts, minor or face-link flags, accounts, consents or suggestion flags", async () => {
    const projected = { state: "ready", presence, profiles: [{ id: "profile_0123456789abcdef", name: "George" }] };
    const st = await terminalMemory(memoryPort(), { terminal: "rpi4", request: { op: "status" } });
    expect(st).toEqual({ status: 200, body: { ok: true, op: "status", ...projected } });
    for (const request of [{ op: "select", profile: null }, { op: "card_answer", card: CARD, choice: "decline" }]) {
      const out = await terminalMemory(memoryPort(), { terminal: "rpi4", request });
      if (out.status !== 200 || !out.body.ok || (out.body.op !== "select" && out.body.op !== "card_answer")) throw new Error(JSON.stringify(out));
      expect(out.body).toEqual({ ok: true, op: request.op, receipts: [], presence, history_reset: false, status: projected });
      expect(JSON.stringify(out.body)).not.toContain("私人內容");
    }
    expect(await terminalMemory(memoryPort(), { terminal: "rpi4", request: { op: "suspend", reason: "tracking_lost" } })).toEqual({ status: 200, body: { ok: true, op: "suspend", presence } });
    // 核心萬一回了別種卡（例如卡在檢查與取用之間換了），card_view 也不交出去。
    const leaky = memoryPort("face_candidate", () => ({ ok: true, op: "card_view", card: { kind: "suggestion", card: CARD, text: "私人內容", value: "私人內容", subject_name: null }, origin: "typed" }));
    const out = await terminalMemory(leaky, { terminal: "rpi4", request: { op: "card_view", card: CARD } });
    expect(JSON.stringify(out)).not.toContain("私人內容");
    expect(out).toMatchObject({ status: 200, body: { ok: false } });
  });

  it("everything else is 403 before reaching the core: other ops, other card kinds, other choices, the manage token", async () => {
    const refusedOps = MEMORY_OPS.filter((op) => !(TERMINAL_MEMORY_OPS as readonly string[]).includes(op));
    expect(refusedOps).toEqual(["setup", "turn", "list", "receipt", "edit", "forget", "pin", "profile_delete", "link_face", "profile_minor", "suggestions"]);
    const cases: [string | null, Record<string, unknown>][] = [
      ...refusedOps.map((op): [string | null, Record<string, unknown>] => ["face_candidate", { op, text: "記住我不吃香菜", request_id: "req_fixture01" }]),
      ["suggestion", { op: "card_view", card: CARD }],
      ["voice_confirm", { op: "card_view", card: CARD }],
      [null, { op: "card_view", card: CARD }],
      ["suggestion", { op: "card_answer", card: CARD, choice: "decline" }],
      ["face_candidate", { op: "card_answer", card: CARD, choice: "accept" }],
      ["face_candidate", { op: "card_answer", card: CARD, choice: "confirm" }],
      ["face_candidate", { op: "select", profile: null, token: `mm_${"0".repeat(32)}` }],
    ];
    for (const [kind, request] of cases) {
      const port = memoryPort(kind);
      const out = await terminalMemory(port, { terminal: "rpi4", request });
      expect(out.status, JSON.stringify(request)).toBe(403);
      expect(port.calls).toEqual([]);
    }
  });

  it("bad terminal ids are 400; bad shapes are rejected with the same error as the IPC filter", async () => {
    expect((await terminalMemory(memoryPort(), { terminal: "Pi", request: { op: "status" } })).status).toBe(400);
    for (const request of [{ op: "suspend", reason: "bored" }, { op: "select", profile: "george" }, { op: "card_view", card: "mc_1" }, { op: "card_answer", card: CARD, choice: "maybe" }]) {
      const ipc = ipcValidateMemory(request);
      expect(ipc.ok).toBe(false);
      expect(await terminalMemory(memoryPort(), { terminal: "rpi4", request })).toEqual({ status: 400, error: ipc.ok ? null : ipc.error });
    }
  });
});

// ─────────────── HTTP（createApp） ───────────────

let server: (Server & { notifyMemoryPresence(): void }) | null = null;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function startApp(options: { identity?: Parameters<typeof createApp>[0]["identity"]; memory?: Parameters<typeof createApp>[0]["memory"] } = {}): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(5), auth, dir: root, preferred: "mock", onChange: () => {} });
  server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: dist, ...options });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  return `http://localhost:${port}`;
}
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const AVAILABLE = { available: true, disabled_reason: null, limited_reason: null };

describe("HTTP routes", () => {
  it("404 when this core has no identity or memory (browser `npm start`), same as before", async () => {
    const base = await startApp({ identity: { status: () => AVAILABLE } });
    expect((await post(base, "/api/terminal/identity", { terminal: "rpi4", request: { op: "ambient_status" } })).status).toBe(404);
    expect((await post(base, "/api/terminal/memory", { terminal: "rpi4", request: { op: "status" } })).status).toBe(404);
  });

  it("with identity and memory: recognition goes through, management is 403, a bad terminal is 400", async () => {
    const id = identityPort();
    const mem = memoryPort();
    const base = await startApp({ identity: { status: () => AVAILABLE, handle: id.handle }, memory: { settingsStatus: () => ({ available: true, enabled: true }), withChat: (_r, run) => run(null as never), handle: mem.handle, cardKind: mem.cardKind } });
    const ok = await post(base, "/api/terminal/identity", { terminal: "rpi4", request: { op: "ambient_status" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, op: "ambient_status", ready: true });
    expect(id.calls).toEqual([{ request: { op: "ambient_status" }, ctx: { userInitiated: false, source: "rpi4" } }]);
    expect((await post(base, "/api/terminal/identity", { terminal: "rpi4", request: { op: "open_session" } })).status).toBe(403);
    expect((await post(base, "/api/terminal/identity", { terminal: "nope!", request: { op: "ambient_status" } })).status).toBe(400);
    const st = await post(base, "/api/terminal/memory", { terminal: "rpi4", request: { op: "status" } });
    expect(await st.json()).toMatchObject({ ok: true, op: "status", presence: { name: "George" } });
    expect((await post(base, "/api/terminal/memory", { terminal: "rpi4", request: { op: "list", manage: true } })).status).toBe(403);
    expect(id.calls).toHaveLength(1);
  });

  it("memory presence changes go out on SSE to every page as a content-free event", async () => {
    const base = await startApp();
    const res = await fetch(`${base}/api/events`);
    const reader = res.body!.getReader();
    await reader.read(); // hello
    server!.notifyMemoryPresence();
    const { value } = await reader.read();
    await reader.cancel();
    const event = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
    expect(Object.keys(event).sort()).toEqual(["sequence", "type"]);
    expect(event.type).toBe("memory.presence_changed");
  });
});

// ─────────────── 頁面：傳輸選擇與效能保護 ───────────────

describe("page bridges (src/identity-bridge.ts)", () => {
  const http = () => ({ identity: vi.fn(async () => ({ ok: true, op: "ambient_status", ready: true }) as IdentityResponse), memory: vi.fn(async () => ({ ok: true, op: "status", state: "ready", presence, profiles: [] }) as MemoryPresenceResponse) });

  it("desktop uses IPC (even with ?terminal=), a terminal page uses HTTP, a plain browser gets null", async () => {
    const ipc = { identity: vi.fn(async () => ({ ok: true, op: "ambient_status", ready: false }) as IdentityResponse), memory: vi.fn(async () => ({ ok: true, op: "status", ...status }) as MemoryResponse) };
    const h = http();
    const desktop = selectBridges({ desktop: ipc, search: "?terminal=rpi4", http: h });
    expect(desktop.terminal).toBeNull();
    await desktop.identity!({ op: "ambient_status" });
    await desktop.memory!({ op: "status" });
    expect(ipc.identity).toHaveBeenCalledTimes(1);
    expect(ipc.memory).toHaveBeenCalledTimes(1);
    expect(h.identity).not.toHaveBeenCalled();

    const pi = selectBridges({ desktop: undefined, search: "?lang=en&terminal=rpi4", http: h });
    expect(pi.terminal).toBe("rpi4");
    await pi.identity!({ op: "ambient_status" });
    await pi.memory!({ op: "select", profile: null, card: presence.select_card });
    expect(h.identity).toHaveBeenCalledWith("rpi4", { op: "ambient_status" });
    expect(h.memory).toHaveBeenCalledWith("rpi4", { op: "select", profile: null, card: presence.select_card });

    for (const search of ["", "?terminal=", "?terminal=RPI4", "?lang=en"]) {
      expect(selectBridges({ desktop: undefined, search, http: h }), search).toEqual({ terminal: null, identity: null, memory: null });
    }
    // 舊版 App 沒有 identity／memory：仍是 null（不改走 HTTP）。
    expect(selectBridges({ desktop: {}, search: "?terminal=rpi4", http: h })).toEqual({ terminal: null, identity: null, memory: null });
  });

  it("an HTTP failure becomes an honest unavailable response instead of a thrown error", async () => {
    const pi = selectBridges({ desktop: undefined, search: "?terminal=rpi4", http: { identity: async () => { throw new Error("無法連到本機核心（伺服器未啟動或已停止）"); }, memory: async () => { throw new Error("這個操作只在 Mac 的 Nous App 提供"); } } });
    expect(await pi.identity!({ op: "ambient_status" })).toEqual({ ok: false, code: "unavailable", message: "無法連到本機核心（伺服器未啟動或已停止）" });
    expect(await pi.memory!({ op: "status" })).toEqual({ ok: false, code: "unavailable", message: "這個操作只在 Mac 的 Nous App 提供" });
  });

  it("goes through the page's API helpers: JSON POST with the terminal id and the unchanged request", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, op: "ambient_status", ready: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const { api } = await import("../src/api.ts");
      const pi = selectBridges({ desktop: undefined, search: "?terminal=rpi4", http: { identity: api.terminalIdentity, memory: api.terminalMemory } });
      await pi.identity!({ op: "ambient_status" });
      await pi.memory!({ op: "card_answer", card: CARD, choice: "decline" });
      const calls = fetch.mock.calls as unknown as [string, RequestInit][];
      expect(calls.map(([path, init]) => [path, init.method, JSON.parse(String(init.body))])).toEqual([
        ["/api/terminal/identity", "POST", { terminal: "rpi4", request: { op: "ambient_status" } }],
        ["/api/terminal/memory", "POST", { terminal: "rpi4", request: { op: "card_answer", card: CARD, choice: "decline" } }],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a terminal page sends X-Nous-Terminal on every API call; the Mac window and plain browsers do not", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const { api, pageHeaders } = await import("../src/api.ts");
      vi.stubGlobal("location", { search: "?terminal=rpi4" });
      expect(pageHeaders()).toEqual({ "X-Nous-Terminal": "rpi4" });
      await api.realtimeStart("sse_x", "user");
      await api.terminalHeartbeat("rpi4");
      const headers = (fetch.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => (init.headers as Record<string, string>)["X-Nous-Terminal"]);
      expect(headers.length).toBeGreaterThan(0);
      expect(new Set(headers)).toEqual(new Set(["rpi4"]));
      vi.stubGlobal("nousDesktop", {});
      expect(pageHeaders()).toEqual({});
      vi.stubGlobal("nousDesktop", undefined);
      vi.stubGlobal("location", { search: "?lang=en" });
      expect(pageHeaders()).toEqual({});
      vi.stubGlobal("location", { search: "?terminal=main" });
      expect(pageHeaders()).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pageSource: only a valid terminal id names a page; anything else (including \"main\") is the Mac window", () => {
    expect(pageSource("rpi4")).toBe("rpi4");
    for (const h of [undefined, "", "RPI4", "main", ["rpi4"], "a".repeat(33)]) expect(pageSource(h), String(h)).toBe(MAIN_SOURCE);
    expect(isTerminalId("main")).toBe(false);
  });

  it("pageTerminal: only without the App preload and with a valid id", () => {
    expect(pageTerminal("?terminal=rpi4", false)).toBe("rpi4");
    expect(pageTerminal("?terminal=rpi4", true)).toBeNull();
    expect(pageTerminal("?terminal=Pi", false)).toBeNull();
  });

  it("main.ts wires the bridges: ambient, wake voice, presence notice, person picker and presence label use them; enrollment and memory management stay desktop-only", () => {
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toContain("const bridges = selectBridges({ desktop: window.nousDesktop, search: location.search, http: { identity: api.terminalIdentity, memory: api.terminalMemory } });");
    expect(main).toMatch(/const ambient = new AmbientIdentity\(\{\n {2}bridge: identityBridge \? \{ identity: identityBridge \} : null,/);
    expect(main).toMatch(/return !!identityBridge && !!cam\?\.enabled/);
    expect(main).toMatch(/const sendIdentity = identityBridge;\n {4}if \(sendIdentity && !wakeVoice\) \{/);
    expect(main).toMatch(/const presenceNotice = new PresenceNotice\(\{\n {2}bridge: presenceBridge \? \{ memory: presenceBridge \} : null,/);
    expect(main).toMatch(/onPresenceBreak: \(reason\) => void presenceBridge\?\.\(\{ op: "suspend", reason \}\)/);
    expect(main).toMatch(/async function refreshMemoryStatus\(\): Promise<void> \{\n {2}const bridge = presenceBridge;/);
    expect(main).toMatch(/memoryPerson\.addEventListener\("change", \(\) => \{\n {2}const bridge = presenceBridge;/);
    // 登記、記憶管理、記憶建議與打字聊天的記憶仍只看 App 的 IPC。
    expect(main).toMatch(/const familyView = new FamilyView\(\{\n {2}bridge: window\.nousDesktop\?\.identity \?/);
    expect(main).toMatch(/const memoryView = new MemoryView\(\{\n {2}bridge: window\.nousDesktop\?\.memory \?/);
    expect(main).toMatch(/const suggestionPrompt = new SuggestionPrompt\(\{\n {2}bridge: window\.nousDesktop\?\.memory \?/);
    expect(main).toMatch(/const bridge = window\.nousDesktop\?\.memory;\n {4}if \(bridge && source === "typed"\) \{/);
  });

  it("the content-free SSE presence event makes a terminal page re-read the status (the Mac keeps its IPC push)", () => {
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toMatch(/if \(event\.type === "memory\.presence_changed"\) \{\n[^\n]*\n {4}if \(!window\.nousDesktop\) void refreshMemoryStatus\(\);\n {4}return;\n {2}\}/);
    expect(main).toContain("window.nousDesktop?.onMemoryChange?.(() => void refreshMemoryStatus());");
  });

  it("terminal pages halve the sense loop and identity sampling; the Mac and plain browsers keep 80 ms / 4 Hz", () => {
    expect(PAGE_PACE).toEqual({ main: { senseFrameMs: 80, identitySampleMs: 250 }, terminal: { senseFrameMs: 160, identitySampleMs: 500 } });
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toContain("const pagePace = bridges.terminal !== null ? PAGE_PACE.terminal : PAGE_PACE.main;");
    expect(main).toContain("intervalMs: pagePace.identitySampleMs,");
    expect(main).toContain("new SensePipeline(settings.camera, (event) => sense.handle(event), { frameIntervalMs: pagePace.senseFrameMs })");
  });
});

describe("memory labels on a terminal page never imply memory was used when it was not", () => {
  const george = { ...presence };
  it("conversation replies on the Pi say 「未用記憶」 instead of the current person (Pi chat never goes through memory)", async () => {
    const { conversationPersonLabel } = await import("../src/memory-view.ts");
    expect(conversationPersonLabel(george, { bridge: true, enabled: true, terminal: true })).toBe("未用記憶");
    expect(conversationPersonLabel(george, { bridge: true, enabled: true, terminal: false })).toBe("本次人物：George");
    expect(conversationPersonLabel(george, { bridge: true, enabled: false, terminal: true })).toBe("");
    expect(conversationPersonLabel(george, { bridge: false, enabled: true, terminal: false })).toBe("");
  });

  it("live-call labels follow the core's per-call memory status, the same on the Pi as on the Mac", async () => {
    const { liveMemoryLabel } = await import("../src/memory-view.ts");
    const reasonText = (_route: string, reason: string) => (reason === "no_consent" ? "未用記憶（ChatGPT 方案即時語音尚未允許）" : reason);
    const base = { route: "live" as const, presence: george, bridge: true, enabled: true, reasonText };
    expect(liveMemoryLabel({ ...base, live: { used: 2, reason: null } })).toBe("本次人物：George · 記憶 2 筆｜");
    expect(liveMemoryLabel({ ...base, live: { used: 0, reason: null } })).toBe("本次人物：George · 未用記憶｜");
    expect(liveMemoryLabel({ ...base, live: { used: 0, reason: "no_consent" } })).toBe("本次人物：George · 未用記憶（ChatGPT 方案即時語音尚未允許）｜");
    expect(liveMemoryLabel({ ...base, presence: { ...george, state: "unselected", name: null }, live: { used: 0, reason: null } })).toBe("本次人物：未選定 · 未用記憶｜");
    expect(liveMemoryLabel({ ...base, live: { used: 0, reason: "route_off" } })).toBe("此路徑未啟用記憶｜");
    expect(liveMemoryLabel({ ...base, route: "api_key", live: null })).toBe("此路徑未啟用記憶｜");
    expect(liveMemoryLabel({ ...base, bridge: false, live: { used: 2, reason: null } })).toBe("");
    expect(liveMemoryLabel({ ...base, route: null, live: { used: 2, reason: null } })).toBe("");
  });
});

// ─────────────── 「不是我」走終端機的記憶路由（DOM 替身） ───────────────

class El {
  children: (El | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  dataset: Record<string, string> = {};
  disabled = false;
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  append(...n: (El | string)[]) { this.children.push(...n); }
  replaceChildren(...n: (El | string)[]) { this.children = n; }
  addEventListener(type: string, cb: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(v: string) { this.children = [v]; }
  all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  click() { this.listeners.get("click")?.forEach((cb) => cb()); }
}

describe("「不是我」 on a terminal page", () => {
  const originalDocument = globalThis.document;
  beforeAll(() => vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) }));
  afterAll(() => { vi.unstubAllGlobals(); if (originalDocument) globalThis.document = originalDocument; });

  /** 經真的路由投影（server/terminal-routes.ts）：頁面只拿到投影後的欄位也照常顯示。 */
  function projectedHttp(reply?: (req: Record<string, unknown>) => MemoryResponse) {
    const port = memoryPort("face_candidate", reply);
    return {
      identity: vi.fn(),
      memory: vi.fn(async (terminal: string, request: MemoryRequest) => {
        const out = await terminalMemory(port, { terminal, request });
        if (out.status !== 200) throw new Error(out.error);
        return out.body;
      }),
    };
  }

  it("shows 「即將用 X 的記憶」 from the projected face-candidate card", async () => {
    const { PresenceNotice } = await import("../src/memory-view.ts");
    const pi = selectBridges({ desktop: undefined, search: "?terminal=rpi4", http: projectedHttp() });
    const n = new PresenceNotice({ bridge: { memory: pi.memory! }, applied: vi.fn(), changed: () => {}, presence: () => presence });
    await n.propose(CARD);
    expect((n.render() as unknown as El).textContent).toContain("即將用 George 的記憶");
  });

  it("calls POST /api/terminal/memory with select household and this generation's select_card", async () => {
    const { PresenceNotice } = await import("../src/memory-view.ts");
    const unselected = { ...presence, state: "unselected" as const, profile: null, name: null };
    const http = projectedHttp((req) => ({ ok: true, op: req.op as "select", receipts: [], card: null, chat: null, presence: unselected, history_reset: true, notice: null, suggestion: null, status: { ...status, presence: unselected } }));
    const pi = selectBridges({ desktop: undefined, search: "?terminal=rpi4", http });
    const applied = vi.fn();
    const n = new PresenceNotice({ bridge: { memory: pi.memory! }, applied, changed: () => {}, presence: () => presence });
    n.selected(presence);
    const box = n.render() as unknown as El;
    expect(box.textContent).toContain("正在用 George 的記憶");
    box.all().find((e) => e.tagName === "button" && e.textContent === "不是我")!.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(http.memory).toHaveBeenCalledWith("rpi4", { op: "select", profile: null, card: presence.select_card });
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.mock.calls[0]![0]).toMatchObject({ history_reset: true, presence: unselected, status: { profiles: [{ id: "profile_0123456789abcdef", name: "George" }] } });
    expect(n.render()).toBeNull();
  });
});
