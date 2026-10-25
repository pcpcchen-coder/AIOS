import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { CameraSettingsStore } from "../server/camera-settings.ts";
import { VoiceSettingsStore } from "../server/voice-settings.ts";
import { loadConfig } from "../server/config.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { allowedHosts, checkRequest } from "../server/http-guard.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { WebSearch } from "../server/web-search.ts";
import { HomeBridge } from "../server/home-bridge.ts";
import { RealtimeBridge } from "../server/realtime.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { SettingsView, Task } from "../shared/types.ts";
import { commandSections } from "../shared/voice-commands.ts";
import { isNumberRow, type MenuNumberSetting } from "../shared/seconds-menu.ts";

/** 選單列的數值列（秒數與倍率）。 */
function numberRow(view: SettingsView, key: string): MenuNumberSetting {
  return view.seconds!.filter(isNumberRow).find((r) => r.key === key)!;
}

describe("checkRequest", () => {
  const hosts = allowedHosts(8787, 5173);
  const json = { "content-type": "application/json" };

  it("拒絕非本機 Host（DNS rebinding）", () => {
    expect(checkRequest("GET", { host: "evil.example:8787" }, hosts).ok).toBe(false);
    expect(checkRequest("GET", { host: "localhost:8787" }, hosts).ok).toBe(true);
  });

  it("拒絕跨站 Origin 的寫入", () => {
    expect(checkRequest("POST", { host: "localhost:8787", origin: "https://evil.example", ...json }, hosts).ok).toBe(false);
    expect(checkRequest("POST", { host: "localhost:8787", origin: "http://localhost:5173", ...json }, hosts).ok).toBe(true);
  });

  it("寫入必須是 JSON（跨站 simple request 無法帶這個 header）", () => {
    const r = checkRequest("POST", { host: "localhost:8787", "content-type": "text/plain" }, hosts);
    expect(r).toEqual({ ok: false, status: 415, message: expect.any(String) });
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function start(
  mockStepMs = 5,
  realtime?: RealtimeBridge,
  webSearch?: WebSearch,
  home?: HomeBridge,
  camera?: { env: NodeJS.ProcessEnv; dir?: string },
  voice?: { dir?: string },
) {
  const port = await freePort();
  const store = new TaskStore(null);
  const dir = camera?.dir ?? voice?.dir ?? mkdtempSync(join(tmpdir(), "nous-http-"));
  let notify = () => {};
  const cameraStore = camera
    ? new CameraSettingsStore({ base: loadConfig(camera.env).camera, dir, onChange: () => notify(), log: () => {} })
    : undefined;
  const voiceStore = voice ? new VoiceSettingsStore({ dir, onChange: () => notify(), log: () => {} }) : undefined;
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({
    claude: null,
    chatgpt: new ChatGPTExecutor(auth, { model: null }),
    mock: new MockExecutor(mockStepMs),
    auth,
    dir,
    preferred: "mock",
    onChange: () => {},
  });
  const runner = new TaskRunner(store, providers);
  const app = createApp({
    store,
    runner,
    settings: providers,
    auth,
    chat: providers,
    realtime,
    webSearch,
    home,
    camera: cameraStore,
    voice: voiceStore,
    port,
    devPort: 5173,
    distDir: null,
  });
  notify = app.notifySettings;
  server = app;
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, runner, store, dir };
}

describe("HTTP API", () => {
  it("交辦 → 完成 → 取回成果", async () => {
    const { base, post, runner } = await start();
    const res = await post("/api/tasks", { text: "  整理待辦  ", request_id: "req_test0001" });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    expect(task).toMatchObject({ title: "整理待辦", mode: "mock" });

    await runner.idle();
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    const done = list.find((t) => t.task_id === task.task_id)!;
    expect(done.status).toBe("succeeded");
    const artifact = await (await fetch(`${base}/api/artifacts/${done.artifact_id}`)).json();
    expect(artifact).toMatchObject({ task_id: task.task_id, mode: "mock" });
  });

  it("驗證輸入：缺文字、缺 request_id、非 JSON", async () => {
    const { base, post } = await start();
    expect((await post("/api/tasks", { text: "", request_id: "req_test0001" })).status).toBe(400);
    expect((await post("/api/tasks", { text: "hi" })).status).toBe(400);
    const bad = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(bad.status).toBe(400);
  });

  it("SSE 先送完整快照，之後推送真實任務事件", async () => {
    const { base, post, runner } = await start();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame.replace(/^data: /, ""));
    };

    expect(await next()).toMatchObject({ type: "hello", settings: { provider: "mock" }, tasks: [] });
    await post("/api/tasks", { text: "測試事件", request_id: "req_test0002" });
    const first = await next();
    expect(first).toMatchObject({ type: "task.updated", task: { title: "測試事件", status: "queued" } });
    await runner.idle();
    controller.abort();
  });

  it("切換引擎：Claude 未設定 key 時拒絕，ChatGPT 未登入時任務誠實失敗並提示登入", async () => {
    const { base, post, runner } = await start();
    expect((await post("/api/settings/provider", { provider: "claude" })).status).toBe(409);
    const ok = await post("/api/settings/provider", { provider: "chatgpt" });
    expect(((await ok.json()) as { provider: string }).provider).toBe("chatgpt");

    const res = await post("/api/tasks", { text: "寫一首詩", request_id: "req_test0003" });
    const task = (await res.json()) as Task;
    expect(task.mode).toBe("chatgpt");
    await runner.idle();
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    expect(list.find((t) => t.task_id === task.task_id)).toMatchObject({
      status: "failed",
      error_action: "chatgpt_sign_in",
      artifact_id: null,
    });
  });

  it("語音對話：串流回覆文字並以 done 結束（模擬引擎明示未接模型）", async () => {
    const { post } = await start();
    const res = await post("/api/chat", { request_id: "req_test0004", messages: [{ role: "user", content: "你好" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, "")));
    const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(text).toContain("模擬模式");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await post("/api/chat", { request_id: "req_test0005", messages: [] })).status).toBe(400);
  });

  it("多輪對話（5 輪）：每次交辦的工作都會開始處理，第三件起不會卡在排隊", async () => {
    // 任務要跑數秒，模擬真實引擎「交辦後還沒做完，使用者就繼續說下一件」的情境。
    const { base, post, runner } = await start(1000);
    const rounds = ["你好", "幫我寫一份專案進度報告", "再幫我整理會議紀錄", "幫我規劃下週行程", "幫我寫一封感謝客戶的信"];
    const history: { role: "user" | "assistant"; content: string }[] = [];
    const delegated: string[] = [];
    for (const [i, text] of rounds.entries()) {
      const requestId = `req_round${String(i).padStart(4, "0")}`;
      const res = await post("/api/chat", { request_id: requestId, messages: [...history, { role: "user", content: text }] });
      const events = (await res.text()).split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      expect(answer).not.toContain("⟦");
      for (const e of events.filter((e) => e.type === "delegate")) {
        const created = await post("/api/tasks", { text: e.title, request_id: requestId });
        expect(created.status).toBe(201);
        delegated.push(((await created.json()) as Task).task_id);
      }
      history.push({ role: "user", content: text }, { role: "assistant", content: answer.trim() });
    }

    expect(delegated).toHaveLength(4);
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    for (const id of delegated) expect(list.find((t) => t.task_id === id)?.status).toBe("running");

    await runner.idle();
    const done = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    for (const id of delegated) expect(done.find((t) => t.task_id === id)?.status).toBe("succeeded");
  }, 20_000);

  it("即時語音：設定顯示是否可用，SDP 經本機核心轉送，API key 不出現在回應中", async () => {
    const calls: string[] = [];
    const openai = (async (url: string) => {
      calls.push(url);
      return url.endsWith("/client_secrets")
        ? new Response(JSON.stringify({ value: "ek_fixture" }), { status: 200 })
        : new Response("v=0 answer", { status: 201 });
    }) as unknown as typeof fetch;
    const { base, post } = await start(5, new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: openai }));
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as { realtime?: { available: boolean } };
    expect(settings.realtime).toMatchObject({ available: true });

    expect((await post("/api/realtime/call", { sdp: "not sdp" })).status).toBe(400);
    const res = await post("/api/realtime/call", { sdp: "v=0 offer" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ sdp: "v=0 answer", model: "gpt-realtime" });
    expect(raw).not.toContain("sk-fixture");
    expect(raw).not.toContain("ek_fixture");
    expect(calls).toEqual(["https://api.openai.com/v1/realtime/client_secrets", "https://api.openai.com/v1/realtime/calls"]);
  });

  it("即時語音：沒有 OPENAI_API_KEY 時回 409 並說明", async () => {
    const { post } = await start(5, new RealtimeBridge({ apiKey: null, model: "gpt-realtime", voice: "marin" }));
    const res = await post("/api/realtime/call", { sdp: "v=0 offer" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("OPENAI_API_KEY");
  });

  it("即時語音上網查詢：驗證輸入、未設定 key 時 409、成功時回傳答案與來源且不外洩 key", async () => {
    const disabled = await start(5, undefined, new WebSearch({ apiKey: null, model: "m", country: "TW", timezone: "Asia/Taipei" }));
    expect((await disabled.post("/api/realtime/web-search", { query: "" })).status).toBe(400);
    expect((await disabled.post("/api/realtime/web-search", { query: "新竹天氣" })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const openai = (async () =>
      new Response(
        JSON.stringify({ model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "多雲（fixture）", annotations: [] }] }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { post } = await start(5, undefined, new WebSearch({ apiKey: "sk-fixture", model: "m", country: "TW", timezone: "Asia/Taipei", fetch: openai }));
    const res = await post("/api/realtime/web-search", { query: "新竹天氣" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ ok: true, answer: "多雲（fixture）", sources: [] });
    expect(raw).not.toContain("sk-fixture");
  });

  it("家電狀態：驗證輸入、未設定中控時 409、經本機核心查中控且不外洩權杖", async () => {
    const off = await start(5, undefined, undefined, new HomeBridge({ url: null, token: null }));
    expect((await off.post("/api/home/status", { target: "" })).status).toBe(400);
    expect((await off.post("/api/home/status", { target: "客廳" })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const seen: string[] = [];
    const hub = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${new Headers(init.headers).get("authorization")}`);
      return new Response(
        JSON.stringify({
          layout: { rooms: [{ id: "living", name: "客廳" }] },
          devices: [
            {
              id: "th",
              name: "溫濕度計",
              placement: { room_id: "living" },
              state: { available: true, fresh: true },
              telemetry: { metrics: [{ key: "temperature", label: "溫度", unit: "°C", precision: 1, value: 26.5 }], status: "live", received_at: 100, source_label: "fixture" },
            },
          ],
          server_time: 160,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { post } = await start(5, undefined, undefined, new HomeBridge({ url: "http://127.0.0.1:8788", token: "hub-secret", fetch: hub }));
    const res = await post("/api/home/status", { target: "客廳", metric: "temperature" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ status: "ok", devices: [{ device: "溫濕度計", minutes_ago: 1, readings: [{ value: 26.5 }] }] });
    expect(raw).not.toContain("hub-secret");
    // H1b：同時讀 AIFA 冷氣清單（這個假中控沒有，讀到的格式不符就當作讀不到，不影響查詢）。
    expect(seen).toEqual(["http://127.0.0.1:8788/api/v1/home Bearer hub-secret", "http://127.0.0.1:8788/api/v1/integrations/aifa Bearer hub-secret"]);
  });

  it("家電控制：驗證輸入、未設定中控時 409、經本機核心送出指令與確認卡，不外洩權杖", async () => {
    const off = await start(5, undefined, undefined, new HomeBridge({ url: null, token: null }));
    expect((await off.post("/api/home/control", { target: "書桌燈" })).status).toBe(400);
    expect((await off.post("/api/home/control", { target: "書桌燈", command: "power", value: { on: true } })).status).toBe(400);
    expect((await off.post("/api/home/control", { target: "書桌燈", command: "power", value: true })).status).toBe(409);
    expect((await off.post("/api/home/confirm", { confirm_id: "home_x" })).status).toBe(400);
    expect((await off.post("/api/home/confirm", { confirm_id: "other", approve: true })).status).toBe(400);
    expect((await off.post("/api/home/confirm", { confirm_id: "home_x", approve: true })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const seen: string[] = [];
    const hub = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push(`${init.method ?? "GET"} ${url} ${headers.get("authorization")} ${headers.get("idempotency-key") ?? ""} ${init.body ?? ""}`);
      if (url.endsWith("/api/v1/home")) {
        return new Response(
          JSON.stringify({
            layout: { rooms: [{ id: "study", name: "書房" }] },
            devices: [{ id: "desk", name: "書桌燈", placement: { room_id: "study" }, configured: true, state: { available: true, fresh: true } }],
            server_time: 160,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "c1", status: "confirmed", message: "設備回讀已確認" }), { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = new HomeBridge({ url: "http://127.0.0.1:8788", token: "hub-secret", fetch: hub, newId: () => "fixed", policyFor: (d) => (d.id === "desk" && seen.length > 2 ? "confirm" : "allow") });
    const { post } = await start(5, undefined, undefined, bridge);
    const res = await post("/api/home/control", { target: "書桌燈", command: "brightness", value: "60" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ status: "confirmed", device: "書桌燈", action: "亮度 60%" });
    expect(raw).not.toContain("hub-secret");
    expect(seen).toEqual([
      "GET http://127.0.0.1:8788/api/v1/home Bearer hub-secret  ",
      "GET http://127.0.0.1:8788/api/v1/integrations/aifa Bearer hub-secret  ",
      `POST http://127.0.0.1:8788/api/v1/devices/desk/commands Bearer hub-secret nous_fixed {"command":"brightness","value":60}`,
    ]);

    const asked = await (await post("/api/home/control", { target: "書桌燈", command: "power", value: false })).json();
    expect(asked).toMatchObject({ status: "needs_confirmation", confirm_id: "home_fixed" });
    const confirmed = await post("/api/home/confirm", { confirm_id: "home_fixed", approve: true });
    expect(await confirmed.json()).toMatchObject({ status: "confirmed", action: "關閉" });
    expect(await (await post("/api/home/confirm", { confirm_id: "home_gone", approve: true })).json()).toMatchObject({ status: "refused", reason: "expired" });
  });

  it("家電控制（H1b，fixture）：AIFA 冷氣設定與紅外線按鍵經本機核心送到中控的專用路徑，回應不含權杖", async () => {
    const seen: string[] = [];
    const caps = { modes: ["auto", "cool", "dry"], fan_modes: ["auto", "low", "medium", "high"], swing_modes: ["auto", "fixed_1", "fixed_2", "fixed_3", "fixed_4", "fixed_5"], features: ["normal"], min_temperature: 17, max_temperature: 30 };
    const hub = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? "GET"} ${url.replace("http://127.0.0.1:8788", "")} ${init.body ?? ""}`);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith("/api/v1/home")) {
        return json({
          layout: { rooms: [] },
          devices: [{ id: "ir-tv", name: "電視", kind: "remote", configured: false, config: { infrared_virtual: true }, infrared: { keys: [{ key: "Vol+", key_id: 2, label: "Vol+" }], ready: true } }],
          server_time: 1000,
        });
      }
      if (url.endsWith("/api/v1/integrations/aifa")) {
        return json({ connected: true, queried_at: 900, items: [{ id: "h1", online: true, children: [{ id: "c1", name: "冷氣", type: "0", sub_type: "0", device_code: "173", capabilities: caps }] }] });
      }
      if (url.endsWith("/status")) return json({ sent: false, status: { power: true, mode: "cool", temperature: 25, fan: "low", swing: "auto", feature: "normal" } });
      if (url.endsWith("/climate")) return json({ id: "a", status: "unconfirmed", message: "已透過 AIFA 連線送出（fixture）", controller_status: null });
      return json({ id: "i", status: "unconfirmed", transport_status: "accepted_by_cloud", message: "Tuya 已接受紅外線指令（fixture）" });
    }) as unknown as typeof fetch;
    const { post } = await start(5, undefined, undefined, new HomeBridge({ url: "http://127.0.0.1:8788", token: "hub-secret", fetch: hub, newId: () => "k" }));
    const swing = await post("/api/home/control", { target: "冷氣", command: "ac_swing", value: "fixed_3" });
    const raw = await swing.text();
    expect(JSON.parse(raw)).toMatchObject({ status: "unconfirmed", why: "one_way", sent_settings: "模式冷氣、25 度、風量低、擺風固定 3" });
    expect(raw).not.toContain("hub-secret");
    const press = await (await post("/api/home/control", { target: "電視", command: "press", value: "volume_up" })).json();
    expect(press).toMatchObject({ status: "unconfirmed", why: "one_way", key: "Vol+" });
    expect(seen.filter((x) => x.startsWith("POST"))).toEqual([
      "POST /api/v1/integrations/aifa/devices/h1/children/c1/status ",
      'POST /api/v1/integrations/aifa/devices/h1/children/c1/climate {"mode":"cool","temperature":25,"fan":"low","swing":"fixed_3","feature":"normal"}',
      'POST /api/v1/devices/ir-tv/infrared-commands {"key":"Vol+","key_id":2}',
    ]);
  });

  it("鏡頭設定：驗證輸入、保存到 camera.json、推送 settings.updated，重新啟動後仍保留", async () => {
    const none = await start();
    expect((await none.post("/api/settings/camera", { active: false })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const { base, post, dir } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } });
    const initial = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(initial.camera).toMatchObject({ enabled: true, label: "CCB Camera", active: true, look_to_talk: true, look_to_talk_s: 1.5, stop_gesture: true });

    expect((await post("/api/settings/camera", { enabled: false })).status).toBe(400);
    expect((await post("/api/settings/camera", { look_to_talk_s: 9 })).status).toBe(400);
    expect((await post("/api/settings/camera", { active: "no" })).status).toBe(400);

    const controller = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame.replace(/^data: /, ""));
    };
    expect(await next()).toMatchObject({ type: "hello" });

    const res = await post("/api/settings/camera", { active: false, look_to_talk_s: 2.5 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsView).camera).toMatchObject({ enabled: true, active: false, look_to_talk_s: 2.5, look_to_talk: true });
    expect(await next()).toMatchObject({ type: "settings.updated", settings: { camera: { active: false, look_to_talk_s: 2.5 } } });
    controller.abort();

    const file = join(dir, "camera.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schema_version: 1, prefs: { active: false, look_to_talk_s: 2.5 } });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await new Promise((r) => server!.close(r));

    // .env 改成關閉看著說話：使用者沒改過的鍵跟著 .env，改過的鍵以 camera.json 為準。
    const again = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on", NOUS_LOOK_TO_TALK: "off" }, dir });
    const after = (await (await fetch(`${again.base}/api/settings`)).json()) as SettingsView;
    expect(after.camera).toMatchObject({ active: false, look_to_talk_s: 2.5, look_to_talk: false, stop_gesture: true });
  });

  it("鏡頭設定寫檔失敗：回 500 與可讀原因，記憶體與畫面不變", async () => {
    const { base, post, dir } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } });
    mkdirSync(join(dir, "camera.json", "x"), { recursive: true }); // camera.json 被目錄佔住，rename 失敗
    const res = await post("/api/settings/camera", { active: false });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/^鏡頭設定沒有保存/);
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(view.camera?.active).toBe(true);
  });

  it("語音閒置秒數：驗證輸入、保存到 voice.json、推送 settings.updated，回應帶新的 seconds 列", async () => {
    const none = await start();
    const defaults = (await (await fetch(`${none.base}/api/settings`)).json()) as SettingsView;
    expect(defaults.voice).toEqual({ voice_idle_s: 90, realtime_idle_s: 120 });
    expect(defaults.seconds?.map((r) => r.key)).toEqual([
      "active", "look_to_talk", "look_to_talk_s", "look_to_talk_cooldown_s", "look_to_talk_greet", "look_to_talk_greet_name", "stop_gesture", "brain_zoom_max", "voice_idle_s", "realtime_idle_s",
    ]);
    expect(defaults.seconds?.filter((r) => r.group === "camera").every((r) => r.disabled_reason !== null)).toBe(true);
    expect(defaults.camera_preview_disabled_reason).toBe("鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）");
    expect((await none.post("/api/settings/voice", { voice_idle_s: 60 })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const { base, post, dir } = await start(5, undefined, undefined, undefined, undefined, {});
    expect((await post("/api/settings/voice", { voice_idle_s: 95 })).status).toBe(400);
    expect((await post("/api/settings/voice", { voice_idle_s: 20 })).status).toBe(400);
    expect((await post("/api/settings/voice", { active: false })).status).toBe(400);
    expect((await post("/api/settings/voice", { realtime_idle_s: "60" })).status).toBe(400);

    const controller = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame.replace(/^data: /, ""));
    };
    expect(await next()).toMatchObject({ type: "hello", settings: { voice: { voice_idle_s: 90 } } });

    const res = await post("/api/settings/voice", { voice_idle_s: 60 });
    expect(res.status).toBe(200);
    const view = (await res.json()) as SettingsView;
    expect(view.voice).toEqual({ voice_idle_s: 60, realtime_idle_s: 120 });
    const row = numberRow(view, "voice_idle_s");
    expect(row).toMatchObject({ value: 60, value_label: "1 分鐘", disabled_reason: null, write_path: "/api/settings/voice" });
    expect(row.options.filter((o) => o.checked).map((o) => o.value)).toEqual([60]);
    expect(await next()).toMatchObject({ type: "settings.updated", settings: { voice: { voice_idle_s: 60 } } });
    controller.abort();
    expect(JSON.parse(readFileSync(join(dir, "voice.json"), "utf8"))).toEqual({ schema_version: 1, prefs: { voice_idle_s: 60 } });

    // 在 onStep 容許誤差內的值存成格點上的值：選單不會同時出現「預設」與勾選的「（目前）」。
    const near = (await (await post("/api/settings/voice", { voice_idle_s: 90.000001 })).json()) as SettingsView;
    expect(near.voice?.voice_idle_s).toBe(90);
    const nearRow = numberRow(near, "voice_idle_s");
    expect(nearRow.options.map((o) => o.label)).toEqual(["30 秒", "1 分鐘", "1 分 30 秒（預設）", "2 分鐘", "3 分鐘", "5 分鐘"]);
    expect(JSON.parse(readFileSync(join(dir, "voice.json"), "utf8")).prefs).toEqual({ voice_idle_s: 90 });
    await post("/api/settings/voice", { voice_idle_s: 60 });
    await new Promise((r) => server!.close(r));

    const again = await start(5, undefined, undefined, undefined, undefined, { dir });
    expect(((await (await fetch(`${again.base}/api/settings`)).json()) as SettingsView).voice).toEqual({ voice_idle_s: 60, realtime_idle_s: 120 });
  });

  it("語音設定寫檔失敗：回 500 與可讀原因，記憶體不變", async () => {
    const { base, post, dir } = await start(5, undefined, undefined, undefined, undefined, {});
    mkdirSync(join(dir, "voice.json", "x"), { recursive: true });
    const res = await post("/api/settings/voice", { voice_idle_s: 60 });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/^語音設定沒有保存/);
    expect(((await (await fetch(`${base}/api/settings`)).json()) as SettingsView).voice?.voice_idle_s).toBe(90);
  });

  it("鏡頭秒數經 POST /api/settings/camera 改變時，回應的 seconds 列跟著更新（選單列直接套用回應）", async () => {
    const { post } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } });
    const view = (await (await post("/api/settings/camera", { look_to_talk_s: 1.6 })).json()) as SettingsView;
    const row = numberRow(view, "look_to_talk_s");
    expect(row).toMatchObject({ value: 1.6, disabled_reason: null, write_path: "/api/settings/camera" });
    expect(row.options.find((o) => o.checked)).toEqual({ value: 1.6, label: "1.6 秒（目前）", checked: true });
  });

  it("鏡頭開關也是選單列的列（kind bool）：/api/settings 帶出目前的值，POST /api/settings/camera 改了回應跟著更新", async () => {
    const { base, post, dir } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } });
    const before = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    const bools = before.seconds!.filter((r) => r.kind === "bool");
    expect(bools.map((r) => [r.key, r.value, r.disabled_reason, r.write_path])).toEqual([
      ["active", true, null, "/api/settings/camera"],
      ["look_to_talk", true, null, "/api/settings/camera"],
      ["look_to_talk_greet", true, null, "/api/settings/camera"],
      ["look_to_talk_greet_name", true, null, "/api/settings/camera"],
      ["stop_gesture", true, null, "/api/settings/camera"],
    ]);
    expect(before.camera_preview_disabled_reason).toBeNull();
    const off = (await (await post("/api/settings/camera", { active: false })).json()) as SettingsView;
    expect(off.camera_preview_disabled_reason).toMatch(/^鏡頭目前關閉/);
    await post("/api/settings/camera", { active: true });
    const view = (await (await post("/api/settings/camera", { look_to_talk: false })).json()) as SettingsView;
    const rows = Object.fromEntries(view.seconds!.map((r) => [r.key, r]));
    expect(rows.look_to_talk).toMatchObject({ kind: "bool", value: false, value_label: "關" });
    expect(rows.look_to_talk_greet).toMatchObject({ value: true, note: "看著說話目前關閉，這個開關暫時用不到" });
    expect(rows.look_to_talk_s).toMatchObject({ note: "看著說話目前關閉，這個秒數暫時用不到" });
    expect(JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")).prefs).toEqual({ active: true, look_to_talk: false });
  });

  it("靠近放大倍率經 POST /api/settings/camera 保存：嚴格驗證、寫入 camera.json、回應的倍率列跟著更新", async () => {
    const { post, dir } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } });
    for (const bad of [3.5, 0.5, 1.25, "2"]) expect((await post("/api/settings/camera", { brain_zoom_max: bad })).status).toBe(400);
    const view = (await (await post("/api/settings/camera", { brain_zoom_max: 2.7 })).json()) as SettingsView;
    expect(view.camera?.brain_zoom_max).toBe(2.7);
    const row = numberRow(view, "brain_zoom_max");
    expect(row).toMatchObject({ kind: "factor", value: 2.7, value_label: "2.7 倍", disabled_reason: null, write_path: "/api/settings/camera" });
    expect(row.options.find((o) => o.checked)).toEqual({ value: 2.7, label: "2.7 倍（目前）", checked: true });
    expect(JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")).prefs).toEqual({ brain_zoom_max: 2.7 });
  });

  it("語音指令表頁：在 SPA fallback 之前、沒有 script、CSP 只允許自己的 inline style，依目前設定標註前提", async () => {
    const off = await start();
    const res = await fetch(`${off.base}/help/commands`);
    expect(res.status).toBe(200); // 前端沒建置（distDir null）也能看，不走 serveStatic
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toMatch(/<script|javascript:|\son\w+=/i);
    const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    expect(csp).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
    for (const row of commandSections(null).flatMap((s) => s.rows)) expect(html).toContain(`data-row="${row.id}"`);
    expect(html).toContain("目前：鏡頭未啟用");
    expect(html).toContain("目前 1 分 30 秒（預設 1 分 30 秒）");
    expect(html).toMatch(/依 \d\d:\d\d:\d\d 打開時的設定產生/);
    const head = await fetch(`${off.base}/help/commands`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await fetch(`${off.base}/help/commands`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(405);
    await new Promise((r) => server!.close(r));

    const { base, post } = await start(5, undefined, undefined, undefined, { env: { NOUS_CAMERA: "on" } }, {});
    await post("/api/settings/voice", { realtime_idle_s: 300 });
    const live = await (await fetch(`${base}/help/commands`)).text();
    expect(live).not.toContain("目前：鏡頭未啟用");
    expect(live).toContain("目前 5 分鐘（預設 2 分鐘）");
    const { port } = server!.address() as AddressInfo;
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/help/commands", headers: { host: `evil.example:${port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(foreign).toBe(403);
  });

  it("前端未建置時回傳說明而不是空白頁", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm start");
  });
});
