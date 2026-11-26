import { afterEach, describe, expect, it } from "vitest";
import { DUCK_CATALOG, DUCK_STAGE1_TOOLS, DUCK_TOOL, DUCK_TOOLS, DuckAdapter } from "../server/integrations/adapters/duck.ts";
import { DUCK_REJECT_TEXT, DUCK_REJECT_TEXT_EN, DUCK_TEXT, DUCK_TEXT_EN } from "../server/duck/text.ts";
import { INTEGRATION_TOOL_ID, isToolResult, toWireName, WIRE_NAME_MAX } from "../shared/integrations.ts";
import { ACK_REASONS } from "../shared/duck-link.ts";
import { ctx, rig, sleep, until, type Rig } from "./fixtures/duck-rig.ts";

// DuckAdapter 對「標示 mock 的 TypeScript 鴨子」的完整流程（驗證層級：單元／整合測試；不是實機）。

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

type Data = Record<string, any>;
const data = (result: { data?: unknown }) => result.data as Data;

describe("工具定義符合 AIOS 契約", () => {
  it("17 個工具，ID、effect、時限、路徑、說明都合規", () => {
    expect(DUCK_TOOLS).toHaveLength(17);
    const ids = new Set<string>();
    for (const tool of DUCK_TOOLS) {
      expect(INTEGRATION_TOOL_ID.test(tool.id), tool.id).toBe(true);
      expect(tool.id.startsWith("app.duck.")).toBe(true);
      expect(toWireName(tool.id).length).toBeLessThanOrEqual(WIRE_NAME_MAX);
      expect(["read", "reversible_write"]).toContain(tool.effect);
      expect(tool.timeoutMs).toBeGreaterThanOrEqual(100);
      expect(tool.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(tool.supportedRoutes).toEqual(["api_key", "live"]);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.descriptionEn?.length ?? 0).toBeGreaterThan(10);
      expect(tool.catalog.examples.length).toBeGreaterThan(0);
      ids.add(tool.id);
    }
    expect(ids.size).toBe(17);
    expect(Object.values(DUCK_TOOL).sort()).toEqual([...ids].sort());
    expect(DUCK_CATALOG).toMatchObject({ id: "duck", service: "duck", mock: "config" });
  });

  it("第一階段只啟用六個工具；開發用選項才全開", async () => {
    expect(DUCK_TOOLS.filter((t) => t.enabled).map((t) => t.id).sort()).toEqual(["app.duck.express", "app.duck.gesture", "app.duck.look", "app.duck.status", "app.duck.stop", "app.duck.track"]);
    expect([...DUCK_STAGE1_TOOLS].every((id) => DUCK_TOOLS.some((t) => t.id === id))).toBe(true);
    r = await rig({ connect: false });
    expect(new DuckAdapter(r.hub).tools().filter((t) => t.enabled)).toHaveLength(6);
    expect(new DuckAdapter(r.hub, { enableAllTools: true }).tools().every((t) => t.enabled)).toBe(true);
  });

  it("沒有 external_commit，也沒有 presence／sound／resume／關扭力這類工具", () => {
    const actions = DUCK_TOOLS.map((t) => t.id.split(".")[2]);
    for (const banned of ["presence", "sound", "resume", "torque_off", "reboot", "estop_clear", "set_offset"]) expect(actions).not.toContain(banned);
    expect(DUCK_TOOLS.some((t) => t.effect === "external_commit")).toBe(false);
  });

  it("inputSchema 只用 AIOS 支援的子集（平面物件、純量、additionalProperties:false）", () => {
    const allowed: Record<string, string[]> = { string: ["type", "description", "enum", "minLength", "maxLength"], number: ["type", "description", "minimum", "maximum"], integer: ["type", "description", "minimum", "maximum"], boolean: ["type", "description"] };
    for (const tool of DUCK_TOOLS) {
      expect(Object.keys(tool.inputSchema).every((k) => ["type", "properties", "required", "additionalProperties"].includes(k))).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const [name, prop] of Object.entries(tool.inputSchema.properties)) {
        expect(/^[a-z][a-z0-9_]{0,31}$/.test(name), `${tool.id}.${name}`).toBe(true);
        expect(Object.keys(prop).every((k) => allowed[prop.type]!.includes(k)), `${tool.id}.${name}`).toBe(true);
      }
      for (const req of tool.inputSchema.required ?? []) expect(req in tool.inputSchema.properties).toBe(true);
    }
  });

  it("動作類工具的說明寫明 confirmed 不代表做完", () => {
    for (const id of [DUCK_TOOL.walk, DUCK_TOOL.look, DUCK_TOOL.gesture, DUCK_TOOL.goTo, DUCK_TOOL.findPerson, DUCK_TOOL.returnHome, DUCK_TOOL.followMe]) {
      const tool = DUCK_TOOLS.find((t) => t.id === id)!;
      expect(tool.description, id).toContain("只代表鴨子已接受並開始");
      expect(tool.descriptionEn, id).toContain("only means the duck accepted and started");
    }
  });

  it("固定句都有英文，拒絕原因涵蓋協定的每一個代碼", () => {
    expect(Object.keys(DUCK_TEXT_EN).sort()).toEqual(Object.keys(DUCK_TEXT).sort());
    expect(Object.keys(DUCK_REJECT_TEXT).sort()).toEqual([...ACK_REASONS].sort());
    expect(Object.keys(DUCK_REJECT_TEXT_EN).sort()).toEqual([...ACK_REASONS].sort());
  });
});

describe("接受並回讀確認 → confirmed", () => {
  it("status：回最新 state、能力與清單，並標示 mock", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.status, {}, ctx());
    expect(isToolResult(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(result.message.startsWith("（模擬）")).toBe(true);
    expect(data(result)).toMatchObject({ mock: true, connected: true, capabilities: { head: "mock", antennas: "unsupported" }, gestures: ["nod", "shake", "tilt"], state: { mode: "standing", stale: false } });
    expect(r.adapter.mock).toBe(true);
  });

  it("look：頭到位 → confirmed，reached=true，回讀的角度符合", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.2, duration_s: 0.5 }, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(data(result).reached).toBe(true);
    expect(data(result).state.head.head_yaw).toBeCloseTo(0.2, 1);
    expect(r.duck.received[0]).toMatchObject({ action: "look", params: { head_yaw: 0.2, duration_s: 0.5 } });
  });

  it("look：時限內沒到位但已經在轉 → confirmed，reached=false", async () => {
    r = await rig({ duck: { speed: 1 } });
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.5, duration_s: 8 }, ctx());
    expect(result.status).toBe("confirmed");
    expect(data(result).reached).toBe(false);
    expect(result.message).toContain("還沒到位");
  });

  it("walk：state 讀到 walking → confirmed；ttl 蓋過整段時間", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.05, duration_s: 2 }, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(r.duck.received[0]).toMatchObject({ action: "walk", ttl_ms: 2500 });
  });

  it("stop：讀到停下 → confirmed", async () => {
    r = await rig();
    await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.05, duration_s: 3 }, ctx());
    const result = await r.adapter.execute(DUCK_TOOL.stop, {}, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(data(result).state.mode).toBe("standing");
  });

  it("gesture、express、track、wait_here", async () => {
    r = await rig();
    expect(await r.adapter.execute(DUCK_TOOL.gesture, { name: "nod" }, ctx())).toMatchObject({ status: "confirmed" });
    const express = await r.adapter.execute(DUCK_TOOL.express, { expression: "happy" }, ctx());
    expect(express.status).toBe("confirmed");
    expect(data(express).state.expression).toBe("happy");
    const track = await r.adapter.execute(DUCK_TOOL.track, { target: "face" }, ctx());
    expect(track.status).toBe("confirmed");
    expect(data(track).state.tracking).toBe("face");
    const wait = await r.adapter.execute(DUCK_TOOL.waitHere, {}, ctx());
    expect(wait.status).toBe("confirmed");
    expect(data(wait).state.mode).toBe("waiting");
  });

  it("where、places、mission_status（讀取）", async () => {
    r = await rig();
    const where = await r.adapter.execute(DUCK_TOOL.where, {}, ctx());
    expect(where.status).toBe("confirmed");
    expect(data(where).where).toMatchObject({ place: "living_room", mock: true });
    const places = await r.adapter.execute(DUCK_TOOL.places, {}, ctx());
    expect(data(places).places.places.map((p: Data) => p.id)).toContain("brother_room");
    expect((await r.adapter.execute(DUCK_TOOL.missionStatus, {}, ctx())).status).toBe("confirmed");
  });

  it("AIOS 的 requestId 當成 duck-link 的 request_id（idempotency key）", async () => {
    r = await rig();
    const c = ctx();
    await r.adapter.execute(DUCK_TOOL.status, {}, c);
    expect(r.duck.received[0]!.request_id).toBe(c.requestId);
  });
});

describe("夾限", () => {
  it("look 超出範圍：鴨子夾限，結果帶 applied 與 clamped", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 1.5, duration_s: 0.3 }, ctx());
    expect(result.status).toBe("confirmed");
    expect(data(result)).toMatchObject({ clamped: true, applied: { head_yaw: 0.5 }, reached: true });
    expect(result.message).toContain("夾限");
  });

  it("walk 超出鴨子的上限：實際值在 applied", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.15, duration_s: 8 }, ctx());
    expect(result.status).toBe("confirmed");
    expect(data(result)).toMatchObject({ clamped: true, applied: { vx: 0.1, duration_s: 3 } });
  });
});

describe("拒絕 → refused，帶鴨子的原因", () => {
  it("跌倒後的動作指令：duck_reason=fallen", async () => {
    r = await rig();
    r.duck.fall();
    await until(() => r!.hub.snapshot().state?.mode === "fallen");
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.1 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "refused", reason: "unavailable" });
    expect(data(result).duck_reason).toBe("fallen");
    expect(result.message).toContain("跌倒");
  });

  it("暫停中走路：duck_reason=paused", async () => {
    r = await rig({ duck: { startPaused: true } });
    const result = await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.05, duration_s: 1 }, ctx());
    expect(result.status).toBe("refused");
    expect(data(result).duck_reason).toBe("paused");
    expect((await r.adapter.resume()).status).toBe("confirmed");
    expect((await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.05, duration_s: 1 }, ctx())).status).toBe("confirmed");
  });

  it("不在地圖上的地點：invalid_arguments＋unknown_name", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.goTo, { place: "moon_base" }, ctx());
    expect(result).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(data(result).duck_reason).toBe("unknown_name");
  });

  it.each([
    ["estop_latched", "unavailable"],
    ["controller_active", "unavailable"],
    ["out_of_range", "invalid_arguments"],
    ["expired", "timeout"],
    ["overheat", "unavailable"],
  ] as const)("鴨子回 %s → refused／%s", async (duckReason, aiosReason) => {
    r = await rig({ duck: { reject: (c) => (c.action === "look" ? duckReason : null) } });
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.1 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "refused", reason: aiosReason });
    expect(data(result).duck_reason).toBe(duckReason);
  });

  it("不在清單上的動作名稱：不送出", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.gesture, { name: "backflip" }, ctx());
    expect(result).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(data(result)).toMatchObject({ sent: false, gestures: ["nod", "shake", "tilt"] });
    expect(r.duck.received).toHaveLength(0);
  });

  it("look 沒有給任何角度、名稱格式不對：不送出", async () => {
    r = await rig();
    expect(await r.adapter.execute(DUCK_TOOL.look, { duration_s: 1 }, ctx())).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await r.adapter.execute(DUCK_TOOL.goTo, { place: "Living Room!" }, ctx())).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(r.duck.received).toHaveLength(0);
  });

  it("不認得的工具 ID → refused／not_registered", async () => {
    r = await rig();
    expect(await r.adapter.execute("app.duck.torque_off", {}, ctx())).toMatchObject({ status: "refused", reason: "not_registered" });
  });
});

describe("能力 unsupported 要如實回報", () => {
  it("鴨子回報沒有天線：不送出，refused，帶能力名稱與鴨子給的原因", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.antennas, { left: 0.5 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "refused", reason: "unavailable" });
    expect(data(result)).toMatchObject({ duck_reason: "unsupported", capability: "antennas", sent: false });
    expect(data(result).capability_reason).toContain("antenna");
    expect(r.duck.received).toHaveLength(0);
  });

  it("沒有足底開關（walk unsupported）：walk 與 go_to 都不送", async () => {
    r = await rig({ duck: { capabilities: { walk: { status: "unsupported", reason: "feet switches not wired" } } } });
    for (const [tool, args] of [[DUCK_TOOL.walk, { duration_s: 1 }], [DUCK_TOOL.goTo, { place: "dock" }], [DUCK_TOOL.returnHome, {}]] as const) {
      const result = await r.adapter.execute(tool, args, ctx());
      expect(result.status, tool).toBe("refused");
      expect(data(result).capability, tool).toBe("walk");
    }
    expect(r.duck.received).toHaveLength(0);
  });

  it("能力中途變成 unsupported（capability_changed）之後也不送", async () => {
    r = await rig();
    expect((await r.adapter.execute(DUCK_TOOL.express, { expression: "happy" }, ctx())).status).toBe("confirmed");
    r.duck.setCapability("eyes", "unsupported", "panel unplugged");
    await until(() => r!.hub.snapshot().state?.capabilities.eyes?.status === "unsupported");
    const result = await r.adapter.execute(DUCK_TOOL.express, { expression: "neutral" }, ctx());
    expect(result.status).toBe("refused");
    expect(data(result).capability).toBe("eyes");
  });

  it("stop 不受能力檢查影響，任何時候都送", async () => {
    r = await rig({ duck: { capabilities: { walk: { status: "unsupported" }, head: { status: "unsupported" } } } });
    expect((await r.adapter.execute(DUCK_TOOL.stop, {}, ctx())).status).toBe("confirmed");
  });

  it("事前沒擋到、鴨子自己回 unsupported 也對應成 refused", async () => {
    r = await rig({ duck: { reject: (c) => (c.action === "express" ? "unsupported" : null) } });
    const result = await r.adapter.execute(DUCK_TOOL.express, { expression: "happy" }, ctx());
    expect(result.status).toBe("refused");
    expect(data(result).duck_reason).toBe("unsupported");
  });
});

describe("不回 ack、斷線、中止 → unknown；沒送出 → failed", () => {
  it("鴨子不回 ack → unknown／timeout（不能推定沒有執行）", async () => {
    r = await rig({ duck: { ackMode: (c) => (c.action === "look" ? "silent" : "normal") } });
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.1 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "unknown", reason: "timeout" });
    expect(result.message).toContain("結果不明");
  });

  it("送出後斷線 → unknown／unavailable", async () => {
    r = await rig({ duck: { ackMode: (c) => (c.action === "walk" ? "disconnect" : "normal") } });
    const result = await r.adapter.execute(DUCK_TOOL.walk, { vx: 0.05, duration_s: 1 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "unknown", reason: "unavailable" });
    expect(data(result).connected).toBe(false);
  });

  it("送出後呼叫端中止（AIOS Dispatcher 逾時）→ unknown／aborted", async () => {
    r = await rig({ duck: { ackMode: () => "silent" } });
    const controller = new AbortController();
    const pending = r.adapter.execute(DUCK_TOOL.stop, {}, ctx(controller.signal));
    await sleep(30);
    controller.abort();
    expect(await pending).toMatchObject({ status: "unknown", reason: "aborted" });
  });

  it("送出前就已經中止 → refused／aborted，沒有送出（和 AIOS Dispatcher 相同）", async () => {
    r = await rig();
    const controller = new AbortController();
    controller.abort();
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.1 }, ctx(controller.signal));
    expect(result).toMatchObject({ status: "refused", reason: "aborted" });
    expect(r.duck.received).toHaveLength(0);
  });

  it("沒有連線 → failed／unavailable，沒有送出", async () => {
    r = await rig({ connect: false });
    const result = await r.adapter.execute(DUCK_TOOL.look, { head_yaw: 0.1 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "failed", reason: "unavailable" });
    expect(result.message).toContain("沒有送出");
    expect((await r.adapter.execute(DUCK_TOOL.stop, {}, ctx())).message).toContain("無法確認");
  });

  it("斷線後的 status：failed，附最後一次的 state 並標示 stale", async () => {
    r = await rig();
    r.duck.disconnect();
    await until(() => !r!.hub.snapshot().connected);
    const result = await r.adapter.execute(DUCK_TOOL.status, {}, ctx());
    expect(result).toMatchObject({ status: "failed", reason: "unavailable" });
    expect(data(result)).toMatchObject({ connected: false, state: { stale: true } });
  });
});

describe("已接受但沒有回讀 → unconfirmed", () => {
  it("鴨子接受後不送 state → unconfirmed", async () => {
    r = await rig({ duck: { muteState: true, stateIntervalMs: 60_000 } });
    const result = await r.adapter.execute(DUCK_TOOL.express, { expression: "happy" }, ctx());
    expect(result).toMatchObject({ ok: false, status: "unconfirmed" });
  });

  it("antennas：v0 的 state 沒有天線位置，接受了也只能 unconfirmed", async () => {
    r = await rig({ duck: { capabilities: { antennas: { status: "mock" } } } });
    const result = await r.adapter.execute(DUCK_TOOL.antennas, { left: 0.5, right: -0.5 }, ctx());
    expect(result).toMatchObject({ ok: false, status: "unconfirmed" });
    expect(result.message).toContain("沒有可以回讀確認的欄位");
    expect(data(result).applied).toEqual({ left: 0.5, right: -0.5 });
  });

  it("接受後、回讀前斷線 → unconfirmed（已知被接受，不是 unknown）", async () => {
    r = await rig({ duck: { muteState: true, stateIntervalMs: 60_000 } });
    const pending = r.adapter.execute(DUCK_TOOL.track, { target: "face" }, ctx());
    await until(() => r!.duck.received.length === 1);
    await sleep(20);
    r.duck.disconnect();
    expect(await pending).toMatchObject({ status: "unconfirmed" });
  });
});

describe("任務（非同步）", () => {
  it("go_to：confirmed＝已出發，帶 mission_id；之後收到 progress 與 done 事件", async () => {
    r = await rig();
    const events: string[] = [];
    r.hub.onEvent((e) => events.push(e.event));
    const result = await r.adapter.execute(DUCK_TOOL.goTo, { place: "brother_room" }, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(data(result).mission_id).toMatch(/^mock_m_/);
    expect(result.message).toContain("還沒到");
    await until(() => events.includes("mission_done"));
    expect(events).toEqual(["mission_progress", "mission_done"]);
    const where = await r.adapter.execute(DUCK_TOOL.where, {}, ctx());
    expect(data(where).where.place).toBe("brother_room");
  });

  it("任務進行中再下任務 → refused／busy_mission；取消後 state 沒有任務 → confirmed", async () => {
    r = await rig({ duck: { missionOutcome: "hold" } });
    expect((await r.adapter.execute(DUCK_TOOL.findPerson, {}, ctx())).status).toBe("confirmed");
    const second = await r.adapter.execute(DUCK_TOOL.goTo, { place: "dock" }, ctx());
    expect(second.status).toBe("refused");
    expect(data(second).duck_reason).toBe("busy_mission");
    const status = await r.adapter.execute(DUCK_TOOL.missionStatus, {}, ctx());
    expect(data(status).mission).toMatchObject({ kind: "find_person" });
    const cancel = await r.adapter.execute(DUCK_TOOL.cancelMission, {}, ctx());
    expect(cancel).toMatchObject({ ok: true, status: "confirmed" });
    expect(data(cancel).state.mission).toBeNull();
  });

  it("沒有任務時取消：鴨子回 no_mission，state 也沒有任務 → confirmed（沒有進行中的任務）", async () => {
    r = await rig();
    const result = await r.adapter.execute(DUCK_TOOL.cancelMission, {}, ctx());
    expect(result.status).toBe("confirmed");
    expect(result.message).toContain("沒有進行中的任務");
    const wrongId = await r.adapter.execute(DUCK_TOOL.cancelMission, { mission_id: "nope" }, ctx());
    expect(wrongId.status).toBe("refused");
  });

  it("mission_status 沒有任務時鴨子回 rejected: no_mission（duckd 的行為）→ 仍是成功的讀取", async () => {
    r = await rig({ duck: { reject: (c) => (c.action === "mission_status" ? "no_mission" : null) } });
    const result = await r.adapter.execute(DUCK_TOOL.missionStatus, {}, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(data(result).mission).toBeNull();
    expect((await r.adapter.execute(DUCK_TOOL.missionStatus, { mission_id: "m_x" }, ctx())).status).toBe("refused");
  });

  it("任務失敗的事件帶原因代碼", async () => {
    r = await rig({ duck: { missionOutcome: "failed" } });
    const failed: Data[] = [];
    r.hub.onEvent((e) => e.event === "mission_failed" && failed.push(e));
    const result = await r.adapter.execute(DUCK_TOOL.goTo, { place: "brother_room" }, ctx());
    expect(result.status).toBe("confirmed");
    await until(() => failed.length === 1);
    expect(failed[0]).toMatchObject({ mission_id: data(result).mission_id, reason: "door_closed" });
  });

  it("return_home 與 follow_me：confirmed 只代表開始", async () => {
    r = await rig({ duck: { missionOutcome: "hold" } });
    const home = await r.adapter.execute(DUCK_TOOL.returnHome, {}, ctx());
    expect(home.status).toBe("confirmed");
    expect(home.message).toContain("開始回充電座");
    await r.adapter.execute(DUCK_TOOL.stop, {}, ctx());
    const follow = await r.adapter.execute(DUCK_TOOL.followMe, { distance_m: 1 }, ctx());
    expect(follow.status).toBe("confirmed");
    expect(r.duck.received.at(-1)).toMatchObject({ action: "follow_me", params: { target: "speaker", distance_m: 1 } });
  });
});

describe("AIOS Dispatcher 的限制", () => {
  it("每個工具的 data 都小於 4096 bytes（超過會被 AIOS 整個丟掉），message 不超過 500 字", async () => {
    r = await rig({ duck: { missionOutcome: "hold", capabilities: { antennas: { status: "mock" } } } });
    const calls: [string, Record<string, unknown>][] = [
      [DUCK_TOOL.status, {}], [DUCK_TOOL.look, { neck_pitch: 0.1, head_pitch: 0.1, head_yaw: 2, head_roll: 0.1, duration_s: 0.3 }], [DUCK_TOOL.gesture, { name: "nod" }],
      [DUCK_TOOL.gesture, { name: "backflip" }], [DUCK_TOOL.antennas, { left: 1, right: -1 }], [DUCK_TOOL.express, { expression: "happy" }], [DUCK_TOOL.track, { target: "face" }],
      [DUCK_TOOL.where, {}], [DUCK_TOOL.places, {}], [DUCK_TOOL.goTo, { place: "brother_room" }], [DUCK_TOOL.missionStatus, {}], [DUCK_TOOL.walk, { vx: 0.15, vy: 0.2, yaw_rate: 1, duration_s: 10 }],
      [DUCK_TOOL.cancelMission, {}], [DUCK_TOOL.walk, { vx: 0.15, vy: 0.2, yaw_rate: 1, duration_s: 10 }], [DUCK_TOOL.stop, {}], [DUCK_TOOL.waitHere, {}], [DUCK_TOOL.returnHome, {}], [DUCK_TOOL.followMe, {}], [DUCK_TOOL.findPerson, { person: "brother" }],
    ];
    let largest = 0;
    for (const [tool, args] of calls) {
      const result = await r.adapter.execute(tool as never, args, ctx());
      expect(isToolResult(result), tool).toBe(true);
      const bytes = Buffer.byteLength(JSON.stringify(result.data ?? null), "utf8");
      largest = Math.max(largest, bytes);
      expect(bytes, tool).toBeLessThan(4096);
      expect(result.message.length, tool).toBeLessThanOrEqual(500);
    }
    // 目前最大的是 status；留一半以上的餘裕給真的鴨子多回的欄位。
    expect(largest).toBeLessThan(2048);
  });
});

describe("health 與不給模型的操作", () => {
  it("health：連線且 state 新鮮 → available；斷線 → unavailable", async () => {
    r = await rig();
    expect(await r.adapter.health()).toEqual({ health: "available", reason: "ok" });
    r.duck.disconnect();
    await until(() => !r!.hub.snapshot().connected);
    expect(await r.adapter.health()).toEqual({ health: "unavailable", reason: "connection_closed" });
  });

  it("從沒連過 → unavailable／unreachable", async () => {
    r = await rig({ connect: false });
    expect(await r.adapter.health()).toEqual({ health: "unavailable", reason: "unreachable" });
  });

  it("presence（不是模型工具）：回讀 state.presence", async () => {
    r = await rig();
    const result = await r.adapter.presence("speaking", 0.4);
    expect(result.status).toBe("confirmed");
    expect(r.duck.received[0]).toMatchObject({ action: "presence", params: { state: "speaking", speech_level: 0.4 } });
    expect(r.hub.snapshot().state?.presence).toBe("speaking");
  });
});
