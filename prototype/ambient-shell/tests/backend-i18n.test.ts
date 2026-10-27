import { describeMenuPrefs } from "../shared/seconds-menu.ts";
import { DEFAULT_CAMERA_PREFS } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ExecutionError, TaskRunner, type Executor } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { RealtimeBridge, buildLiveInstructions, buildRealtimeInstructions } from "../server/realtime.ts";
import { RealtimeSessions, RouteStartError, FallbackRequired, type RealtimeRoute, type SessionContext } from "../server/realtime-routes.ts";
import { isGreetingTurn } from "../server/live-route.ts";
import { buildCallerInstructions, liveCallerTools } from "../server/live-tool-caller.ts";
import { GreetingPicker } from "../server/greeting-picker.ts";
import { liveGreetingSource } from "../server/nous.ts";
import { localizeSettings } from "../server/localization.ts";
import { commandsPageHeaders, renderCommandsPage } from "../server/commands-page.ts";
import type { Locale } from "../shared/i18n.mjs";
import type { SettingsView, Task } from "../shared/types.ts";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "nous-locale-test-")); dirs.push(dir); return dir; }
async function start() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const store = new TaskStore(null), dir = temp();
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
  const runner = new TaskRunner(store, providers);
  const app = createApp({ store, runner, settings: providers, auth, chat: providers, port, devPort: 5173, distDir: null });
  servers.push(app);
  await new Promise<void>(resolve => app.listen(port, "127.0.0.1", resolve));
  const base = `http://localhost:${port}`;
  const post = (path: string, body: unknown, locale?: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(locale ? { "X-Nous-Locale": locale } : {}) }, body: JSON.stringify(body) });
  return { base, post, store, runner };
}
function view(): SettingsView {
  return { schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬", available: true, detail: "不呼叫任何模型，只展示流程" }], chatgpt: { signed_in: true, email: "模擬", plan_usage: true, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } };
}
function route(id: "live" | "api_key", seen: SessionContext[], failure?: Error): RealtimeRoute {
  return { id, readiness: () => ({ ready: true }),
    describe: () => ({ id, available: true, reason: null, billing_line: "fixture", model: "fixture-model", voice: "cove", voices: [], tools: "", detail: "fixture" }),
    baseInfo: () => ({ available: true, model: "fixture-model", detail: "fixture" }),
    async connect(_sdp, ctx) { seen.push(ctx); if (failure) throw failure; return { route: id, model: "fixture-model", answerSdp: "v=0 fixture", control: id === "live" ? { input: () => {} } : null, close: async () => {} }; },
  };
}

describe("backend locale isolation", () => {
  it("isolates concurrent chat requests and rejects locale injection without rewriting user text", async () => {
    const { post } = await start();
    const body = { request_id: "req_localechat", messages: [{ role: "user", content: "測試姓名" }] };
    const responses = await Promise.all([post("/api/chat", body, "en"), post("/api/chat", body), post("/api/chat", body, "en;ignore system")]);
    const streams = await Promise.all(responses.map(response => response.text()));
    const text = (stream: string) => stream.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).filter(event => event.type === "delta").map(event => event.text).join("");
    expect(text(streams[0])).toContain("(Mock) I heard “測試姓名”");
    expect(text(streams[1])).toContain("（模擬）我聽到你說「測試姓名」");
    expect(text(streams[2])).toContain("（模擬）");
  });
  it("localizes authored HTTP errors independently for each request", async () => {
    const { post } = await start();
    const english = await post("/api/settings/camera", {}, "en");
    const chinese = await post("/api/settings/camera", {});
    expect(english.status).toBe(409);
    expect(await english.json()).toEqual({ error: "Camera is not configured" });
    expect(await chinese.json()).toEqual({ error: "鏡頭未設定" });
  });
  it("retains the requested language on an isolated OAuth callback page", async () => {
    const auth = new ChatGPTAuth({ dir: temp(), callbackPort: 0, onChange: () => {} });
    const started = await auth.startLogin("auto", "en");
    try {
      const callback = new URL(started.authorize_url).searchParams.get("redirect_uri")!;
      const response = await fetch(callback + "?state=fixture-invalid-state");
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("Login state does not match or has expired");
      expect(html).not.toContain("<script");
    } finally { auth.cancelPending(); }
  });
  it("records selected task language and produces honest English mock artifacts", async () => {
    const { post, store, runner } = await start();
    const english = await (await post("/api/tasks", { text: "保留中文任務名稱", request_id: "req_english000" }, "en")).json() as Task;
    const chinese = await (await post("/api/tasks", { text: "原文", request_id: "req_chinese000" })).json() as Task;
    expect(english).toMatchObject({ title: "保留中文任務名稱", locale: "en" });
    expect(chinese).not.toHaveProperty("locale");
    await runner.idle();
    const result = store.getArtifact(store.get(english.task_id)!.artifact_id!)!;
    expect(result.content).toContain("**mock mode**");
    expect(result.content).toContain("保留中文任務名稱");
    expect(result.status).toBe("partial");
  });
  it("retains English through failure, storage reload, and retry", async () => {
    const dir = temp(), seen: (Locale | undefined)[] = [], mock = new MockExecutor(1);
    const executor: Executor = { mode: "mock", async run(input, reporter, signal) { seen.push(input.locale); if (seen.length === 1) throw new ExecutionError("API key 無效或未授權（401）"); return mock.run(input, reporter, signal); } };
    const store = new TaskStore(dir), runner = new TaskRunner(store, executor);
    const first = runner.submit({ title: "任務原文", request_id: "req_failure000", locale: "en" });
    await runner.idle();
    expect(store.get(first.task_id)!.error).toBe("API key is invalid or unauthorized (401)");
    const reloaded = new TaskStore(dir), next = new TaskRunner(reloaded, executor);
    const retry = next.retry(first.task_id, "req_retry0000")!;
    await next.idle();
    expect(retry).toMatchObject({ title: "任務原文", locale: "en", retry_of: first.task_id });
    expect(seen).toEqual(["en", "en"]);
    expect(reloaded.getArtifact(reloaded.get(retry.task_id)!.artifact_id!)!.content).toContain("Mock result");
  });
  it("localizes authored settings without translating account data or mutating canonical snapshots", async () => {
    const source = view(), en = localizeSettings(source, "en");
    expect(en.providers[0].label).toBe("Mock");
    expect(en.chatgpt.email).toBe("模擬");
    expect(source.providers[0].label).toBe("模擬");
    const canonical = { ...source, seconds: describeMenuPrefs({ camera: { ...DEFAULT_CAMERA_PREFS, enabled: true, label: "私人鏡頭名稱", left_first: true, screen_width_mm: 398, screen_offset_mm: 0 }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime: { available: false, model: "fixture-model", detail: "未設定 OPENAI_API_KEY" } }) };
    expect(JSON.stringify(localizeSettings(canonical, "en").seconds)).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(canonical.seconds.find(row => row.key === "look_to_talk")!.note).toContain("即時語音");
    const { base } = await start();
    const english = await (await fetch(base + "/api/settings", { headers: { "X-Nous-Locale": "en" } })).json() as SettingsView;
    const chinese = await (await fetch(base + "/api/settings")).json() as SettingsView;
    expect(english.providers.find(p => p.id === "mock")!.label).toBe("Mock");
    expect(chinese.providers.find(p => p.id === "mock")!.label).toBe("模擬");
  });
  it("serves English help with unchanged CSP and no scripts, keeping Chinese default intact", async () => {
    const { base } = await start(), response = await fetch(base + "/help/commands?lang=en");
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Nous voice command table");
    expect(html).toContain("confirm execution");
    expect(html).not.toContain("<script");
    expect(response.headers.get("content-security-policy")).toBe(commandsPageHeaders()["Content-Security-Policy"]);
    const now = new Date("2026-10-26T12:00:00Z");
    expect(renderCommandsPage(view(), now)).toBe(renderCommandsPage(view(), now, "zh-TW"));
  });
});

describe("realtime language is fixed at session start", () => {
  it("selects English transcription and instructions only for an English API-key connection", async () => {
    const sent: { session: { instructions: string; audio: { input: { transcription: { language: string } } } } }[] = [];
    const bridge = new RealtimeBridge({ apiKey: "fixture-key", model: "fixture-model", voice: "fixture-voice", fetch: async (_url, init) => {
      const body = String(init?.body);
      if (body.startsWith("{")) { sent.push(JSON.parse(body)); return new Response(JSON.stringify({ value: "fixture-secret" })); }
      return new Response("v=0 fixture-answer");
    } });
    await bridge.connect("v=0 fixture-offer", [], "en");
    await bridge.connect("v=0 fixture-offer", []);
    expect(sent.map(r => r.session.audio.input.transcription.language)).toEqual(["en", "zh"]);
    expect(sent[0].session.instructions).toContain("Speak English");
    expect(sent[1].session.instructions).toContain("一律用繁體中文");
  });
  it("retains English across live-to-API fallback and single-use core greeting claims", async () => {
    const seen: SessionContext[] = [];
    const sessions = new RealtimeSessions({ routes: { live: route("live", seen, new RouteStartError("network", 502, "fixture network failure", true)), api_key: route("api_key", seen) }, preference: () => "auto", tasks: () => [], send: () => true });
    const start = sessions.start("fixture-client", "look_to_talk", "en");
    if (!start.ok) throw new Error("fixture refused");
    let fallback: FallbackRequired | undefined;
    try { await sessions.call("v=0 offer", start.session_id, start.owner); } catch (error) { if (error instanceof FallbackRequired) fallback = error; else throw error; }
    expect(fallback).toBeDefined();
    await sessions.call("v=0 offer", fallback!.offer.fallback!.session_id, fallback!.offer.fallback!.owner);
    expect(seen.map(ctx => ctx.locale)).toEqual(["en", "en"]);
    expect(sessions.claimGreeting(start.interaction!)).toMatchObject({ route: "api_key", locale: "en" });
    expect(sessions.claimGreeting(start.interaction!)).toBeNull();
    expect(sessions.start("fixture-client", "user", "zh-TW").ok).toBe(true);
    expect(seen[0].locale).toBe("en");
  });
  it("keeps truthful tool rules and core-generated English greetings", () => {
    expect(buildLiveInstructions([], new Date(), { mcp: [] }, "en")).toContain("Speak English");
    expect(buildCallerInstructions({ webSearch: false, mcp: [] }, [], new Date(), "en")).toContain("sentences in English");
    const taskTool = liveCallerTools({ webSearch: false, mcp: [] }, "en").find(tool => tool.type === "function" && tool.name === "delegate_task")!;
    expect(JSON.stringify(taskTool)).toContain("requested output in one sentence in English");
    expect(isGreetingTurn("george, i'm here.", "George, I'm here")).toBe(true);
    expect(buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [] }, "en")).toContain("工具失敗或查不到時照實說");
    const picker = new GreetingPicker({ random: () => 0, now: () => Date.parse("2026-10-26T12:00:00Z") });
    expect(picker.pick("George", "en").sentence).toContain("George");
    const plain = liveGreetingSource(() => null, picker)("fixture-interaction", "fixture-session", "en");
    expect(plain.text).toContain("Do not claim to see");
    expect(plain.sentence).not.toMatch(/[\u4e00-\u9fff]/u);
  });
});
