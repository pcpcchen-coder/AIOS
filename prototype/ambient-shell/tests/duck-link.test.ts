import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLOSE } from "../server/duck/link.ts";
import { rig, sleep, until, type Rig } from "./fixtures/duck-rig.ts";

// duck-link hub 對「標示 mock 的 TypeScript 鴨子」的整合測試（驗證層級：單元／整合測試，全部在本機 loopback 的臨時埠）。

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

function rawClient(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket | null; status: number | null; messages: unknown[]; closed: Promise<number> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const messages: unknown[] = [];
    let closeCode: (code: number) => void = () => {};
    const closed = new Promise<number>((res) => (closeCode = res));
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("close", (code) => closeCode(code));
    ws.on("open", () => resolve({ ws, status: 101, messages, closed }));
    ws.on("unexpected-response", (_req, res) => resolve({ ws: null, status: res.statusCode ?? null, messages, closed }));
    ws.on("error", () => {});
  });
}

describe("連線與守門", () => {
  it("只聽 127.0.0.1", async () => {
    r = await rig({ connect: false });
    // hub 內部的 http server 只綁 loopback；用區網位址連不進來。
    const address = (r.hub as unknown as { http: { address(): { address: string } } }).http.address();
    expect(address.address).toBe("127.0.0.1");
  });

  it("路徑不是 /duck-link → 404", async () => {
    r = await rig({ connect: false });
    const c = await rawClient(r.url.replace("/duck-link", "/other"));
    expect(c.status).toBe(404);
  });

  it("帶 Origin 的請求（瀏覽器頁面）→ 403", async () => {
    r = await rig({ connect: false });
    const c = await rawClient(r.url, { Origin: "http://evil.example" });
    expect(c.status).toBe(403);
  });

  it("Host 不是 loopback 名稱 → 403", async () => {
    r = await rig({ connect: false });
    const c = await rawClient(r.url, { Host: "duck.example:8791" });
    expect(c.status).toBe(403);
  });

  it("一般 HTTP 請求 → 404，不提供狀態頁", async () => {
    r = await rig({ connect: false });
    const res = await fetch(r.url.replace("ws://", "http://"));
    expect(res.status).toBe(404);
  });

  it("連上後 hub 先送 hello（role nous），鴨子的 hello 帶 mock: true", async () => {
    r = await rig();
    const snap = r.hub.snapshot();
    expect(snap.connected).toBe(true);
    expect(snap.hello?.role).toBe("duck");
    expect(snap.hello?.mock).toBe(true);
    expect(snap.state?.mock).toBe(true);
  });

  it("第一則訊息不是鴨子的 hello → 關閉（4003）", async () => {
    r = await rig({ connect: false });
    const c = await rawClient(r.url);
    c.ws!.send(JSON.stringify({ protocol_version: "0.1", type: "heartbeat", sent_at_ms: 1, seq: 1 }));
    expect(await c.closed).toBe(CLOSE.badHello);
    expect(r.hub.snapshot().connected).toBe(false);
  });

  it("沒有送 hello → 逾時關閉", async () => {
    r = await rig({ connect: false, hub: { helloTimeoutMs: 80 } });
    const c = await rawClient(r.url);
    expect(await c.closed).toBe(CLOSE.badHello);
  });

  it("協定版本不合 → 關閉（4002），不猜測", async () => {
    r = await rig({ connect: false });
    const c = await rawClient(r.url);
    c.ws!.send(JSON.stringify({ protocol_version: "9.0", type: "hello", sent_at_ms: 1, role: "duck", software: "future duck" }));
    expect(await c.closed).toBe(CLOSE.version);
  });

  it("新的鴨子連線完成 hello 後取代舊的", async () => {
    r = await rig();
    const changes: string[] = [];
    r.hub.onLink((c) => changes.push(c.up ? "up" : `down:${c.reason}`));
    const c = await rawClient(r.url);
    c.ws!.send(JSON.stringify({ protocol_version: "0.1", type: "hello", sent_at_ms: 1, role: "duck", software: "second duck", mock: true }));
    await until(() => r!.hub.snapshot().hello?.software === "second duck");
    expect(changes).toEqual(["down:replaced", "up"]);
    c.ws!.terminate();
  });
});

describe("掛到既有的 http.Server（AIOS 核心的作法）", () => {
  it("attach：只接 /duck-link；Host 要在允許清單裡；stop 之後拿掉監聽、不關別人的 server", async () => {
    const { createServer } = await import("node:http");
    const { DuckLinkHub } = await import("../server/duck/link.ts");
    const { MockDuck } = await import("./fixtures/mock-duck.ts");
    const server = createServer((_req, res) => res.writeHead(200).end("core"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const hub = new DuckLinkHub({ heartbeatMs: 40 });
    hub.attach(server, { hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]) });
    try {
      expect((await rawClient(`ws://127.0.0.1:${port}/other`)).status).toBe(404);
      expect((await rawClient(`ws://127.0.0.1:${port}/duck-link`, { Host: `127.0.0.1:${port + 1}` })).status).toBe(403);
      expect((await rawClient(`ws://127.0.0.1:${port}/duck-link`, { Origin: `http://127.0.0.1:${port}` })).status).toBe(403);
      const duck = new MockDuck({ url: `ws://127.0.0.1:${port}/duck-link`, stateIntervalMs: 50 });
      await duck.connect();
      await until(() => hub.snapshot().connected);
      // 既有的 HTTP 路由不受影響。
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("core");
      await hub.stop();
      expect(server.listening).toBe(true);
      expect(server.listenerCount("upgrade")).toBe(0);
      duck.disconnect();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("心跳與往返時間", () => {
  it("定期送 heartbeat，並用回聲量到往返時間", async () => {
    r = await rig();
    await until(() => r!.hub.snapshot().rttMs !== null);
    expect(r.hub.snapshot().rttMs).toBeGreaterThanOrEqual(0);
    expect(r.hub.snapshot().rttMs).toBeLessThan(200);
  });

  it("鴨子不回任何訊息超過 staleMs → 關閉連線並通知", async () => {
    r = await rig({ connect: false, hub: { staleMs: 150 } });
    const c = await rawClient(r.url);
    c.ws!.send(JSON.stringify({ protocol_version: "0.1", type: "hello", sent_at_ms: 1, role: "duck", software: "silent duck", mock: true }));
    await until(() => r!.hub.snapshot().connected);
    expect(await c.closed).toBe(CLOSE.stale);
    expect(r.hub.snapshot().connected).toBe(false);
  });

  it("hub 停止送心跳（行程結束）→ mock 鴨子租約失效，回報 lease_ok=false", async () => {
    r = await rig({ hub: { heartbeatMs: 10_000 } });
    // heartbeatMs 很長＝連上後只送一次心跳；mock 鴨子的租約是 300 ms。
    const events: string[] = [];
    r.hub.onEvent((e) => events.push(e.event));
    await until(() => events.includes("link_lost"));
    await until(() => r!.hub.snapshot().state?.link?.lease_ok === false);
  });
});

describe("訊息驗證", () => {
  it("不合 schema 的訊息丟棄並計數，連線保留", async () => {
    r = await rig();
    r.duck.sendRaw("{not json");
    r.duck.sendRaw(JSON.stringify({ protocol_version: "0.1", type: "state", sent_at_ms: 1, mode: "flying", control_source: "none", capabilities: {}, faults: [] }));
    r.duck.sendRaw(JSON.stringify({ protocol_version: "0.1", type: "command", sent_at_ms: 1, request_id: "req_00000001", action: "stop", ttl_ms: 1000 }));
    await until(() => r!.hub.snapshot().counters.rxInvalid === 3);
    expect(r.hub.snapshot().connected).toBe(true);
    expect(r.hub.snapshot().state?.mode).toBe("standing");
  });

  it("要送出的指令不合 schema → 不送", async () => {
    r = await rig();
    const outcome = await r.hub.sendCommand("walk", { vx: 0.1 }, { ttlMs: 1000, ackTimeoutMs: 200 });
    expect(outcome.kind).toBe("not_sent");
    expect(r.duck.received).toHaveLength(0);
    expect(r.hub.snapshot().counters.txInvalid).toBe(1);
  });

  it("schema 沒有的操作（關扭力）送不出去", async () => {
    r = await rig();
    const outcome = await r.hub.sendCommand("torque_off" as never, undefined, { ttlMs: 1000, ackTimeoutMs: 200 });
    expect(outcome).toMatchObject({ kind: "not_sent", why: "invalid" });
  });
});

describe("指令、ack、state、event", () => {
  it("指令配對到 ack，帶 request_id 與夾限後的值", async () => {
    r = await rig();
    const outcome = await r.hub.sendCommand("look", { head_yaw: 2 }, { ttlMs: 2000, ackTimeoutMs: 300, requestId: "my_request_0001" });
    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.requestId).toBe("my_request_0001");
    expect(outcome.ack).toMatchObject({ status: "accepted", clamped: true, applied: { head_yaw: 0.5 } });
    expect(r.duck.received[0]).toMatchObject({ request_id: "my_request_0001", action: "look", ttl_ms: 2000 });
  });

  it("沒有連線 → not_sent", async () => {
    r = await rig({ connect: false });
    expect(await r.hub.sendCommand("status", undefined, { ttlMs: 1000, ackTimeoutMs: 100 })).toEqual({ kind: "not_sent", why: "not_connected" });
  });

  it("鴨子不回 ack → no_ack；之後才到的 ack 只計數", async () => {
    r = await rig({ duck: { ackMode: () => "silent" } });
    const outcome = await r.hub.sendCommand("status", undefined, { ttlMs: 1000, ackTimeoutMs: 80 });
    expect(outcome.kind).toBe("no_ack");
    r.duck.sendRaw(JSON.stringify({ protocol_version: "0.1", type: "ack", sent_at_ms: 1, request_id: (outcome as { requestId: string }).requestId, status: "accepted" }));
    await until(() => r!.hub.snapshot().counters.unmatchedAcks === 1);
  });

  it("等 ack 時斷線 → link_lost", async () => {
    r = await rig({ duck: { ackMode: () => "disconnect" } });
    const outcome = await r.hub.sendCommand("stop", undefined, { ttlMs: 1000, ackTimeoutMs: 1000 });
    expect(outcome.kind).toBe("link_lost");
    expect(r.hub.snapshot().connected).toBe(false);
  });

  it("呼叫端中止 → aborted", async () => {
    r = await rig({ duck: { ackMode: () => "silent" } });
    const controller = new AbortController();
    const pending = r.hub.sendCommand("stop", undefined, { ttlMs: 1000, ackTimeoutMs: 1000, signal: controller.signal });
    controller.abort();
    expect((await pending).kind).toBe("aborted");
  });

  it("保存最新 state，轉發 event，重複的 event_id 只轉一次", async () => {
    r = await rig();
    const events: string[] = [];
    r.hub.onEvent((e) => events.push(e.event));
    r.duck.emitEvent("battery_low");
    const dup = { protocol_version: "0.1", type: "event", sent_at_ms: 1, event: "picked_up", event_id: "dup_1" };
    r.duck.sendRaw(JSON.stringify(dup));
    r.duck.sendRaw(JSON.stringify(dup));
    await until(() => r!.hub.snapshot().counters.duplicateEvents === 1);
    expect(events).toEqual(["battery_low", "picked_up"]);
  });

  it("鴨子端程式重啟、事件編號從頭編：重啟後的事件照常轉發，不當成重複（2026-11-26 實機的 bug）", async () => {
    // 照 duckd 的編法：e_000001 起跳。第一個行程送 3 則後結束。
    r = await rig({ duck: { eventIds: "counter" } });
    const events: string[] = [];
    r.hub.onEvent((e) => events.push(`${e.event}:${e.event_id}`));
    for (const name of ["tracking_acquired", "tracking_lost", "gesture_done"] as const) r.duck.emitEvent(name);
    await until(() => events.length === 3);
    r.duck.disconnect();
    await until(() => !r!.hub.snapshot().connected);
    // 新的行程（同一個 duck_id、同一個 software）連上來，編號又從 e_000001 開始。
    const { MockDuck } = await import("./fixtures/mock-duck.ts");
    const restarted = new MockDuck({ url: r.url, stateIntervalMs: 50, eventIds: "counter" });
    await restarted.connect();
    await until(() => r!.hub.snapshot().connected);
    try {
      for (const name of ["tracking_acquired", "tracking_lost", "walk_done"] as const) restarted.emitEvent(name);
      await until(() => events.length === 6);
      expect(events).toEqual(["tracking_acquired:e_000001", "tracking_lost:e_000002", "gesture_done:e_000003", "tracking_acquired:e_000001", "tracking_lost:e_000002", "walk_done:e_000003"]);
      expect(r.hub.snapshot().counters.duplicateEvents).toBe(0);
      // 同一條連線內真的重送同一則，還是只轉一次。
      restarted.sendRaw(JSON.stringify({ protocol_version: "0.1", type: "event", sent_at_ms: 1, event: "walk_done", event_id: "e_000003" }));
      await until(() => r!.hub.snapshot().counters.duplicateEvents === 1);
      expect(events).toHaveLength(6);
    } finally {
      restarted.disconnect();
    }
  });

  it("waitFor：先看已經收到的，再等新的；逾時回 timeout", async () => {
    r = await rig();
    const since = r.hub.seq;
    r.duck.emitEvent("docked");
    await sleep(30);
    const found = await r.hub.waitFor((o) => o.kind === "event" && o.event.event === "docked", { sinceSeq: since, timeoutMs: 100 });
    expect(found).toMatchObject({ kind: "event" });
    expect(await r.hub.waitFor((o) => o.kind === "event" && o.event.event === "fell", { sinceSeq: r.hub.seq, timeoutMs: 60 })).toBe("timeout");
  });
});
