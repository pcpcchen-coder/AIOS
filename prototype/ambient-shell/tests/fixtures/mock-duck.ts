import { WebSocket } from "ws";
import { capabilitiesFor } from "../../shared/duck-capabilities.ts";
import { HEAD_JOINTS, PROTOCOL_VERSION, type AckMessage, type AckReason, type Capabilities, type CapabilityName, type CommandMessage, type DuckAction, type DuckEventName, type DuckMode, type HeadJoint, type PresenceState, type StateMessage } from "../../shared/duck-link.ts";
import { createValidator, type DuckLinkValidator } from "../../server/duck/schema.ts";

// ⚠️ DUCK-1：MOCK 鴨子（fixture）。只用來測 duck-link hub、DuckAdapter 與 presence。
// 它不連任何硬體、不代表真的鴨子做得到什麼：hello 與每一則 state 都帶 mock: true，
// 能力一律回報 "mock" 或 "unsupported"，數值（夾限範圍、速度、地點）都是測試用的固定值或合成 fixture。
// 鴨子端真正的實作是 Nous Duck repo（pcpcchen-coder/Open_Duck_Mini） 的 nous_duck/robot/duckd（Python）；兩者只共用 duck-link schema。

/** 頭部夾限範圍：Nous Duck 設計文件的初始值（未經實機驗證）。 */
export const MOCK_HEAD_LIMITS: Record<HeadJoint, readonly [number, number]> = {
  neck_pitch: [-0.34, 1.1],
  head_pitch: [-0.78, 0.3],
  head_yaw: [-0.5, 0.5],
  head_roll: [-0.5, 0.5],
};
/** 走路夾限：Nous Duck 設計文件的室內上限初始值。 */
export const MOCK_WALK_LIMITS = { vx: 0.1, vy: 0.1, yaw_rate: 0.6, duration_s: 3 } as const;
/** 合成的地點（fixture，不是任何真實的家）。 */
export const MOCK_PLACES = [
  { id: "living_room", kind: "room" },
  { id: "brother_room", kind: "room" },
  { id: "dock", kind: "dock" },
] as const;

export type AckMode = "normal" | "silent" | "disconnect";

export interface MockDuckOptions {
  url: string;
  duckId?: string;
  capabilities?: Capabilities;
  gestures?: string[];
  expressions?: string[];
  sounds?: string[];
  /** state 的間隔（協定至少每秒一次；測試會縮短）。 */
  stateIntervalMs?: number;
  /** 連線租約：多久沒收到 heartbeat 就停下並記 link_lost。 */
  leaseMs?: number;
  /** 每個指令怎麼回 ack：normal 正常；silent 不回（測逾時）；disconnect 收到就斷線。 */
  ackMode?: (command: CommandMessage) => AckMode;
  /** 強制拒絕某些指令（測拒絕原因）。 */
  reject?: (command: CommandMessage) => AckReason | null;
  /** 以暫停狀態啟動（第一個 walk 之前要 resume）。 */
  startPaused?: boolean;
  /** 模擬時間的倍率：動作、任務的時間除以它（測試用）。 */
  speed?: number;
  /** 任務怎麼結束。 */
  missionOutcome?: "done" | "failed" | "hold";
  /** 接受指令後不送 state（測「已接受但沒有回讀」）。 */
  muteState?: boolean;
  /** 事件編號怎麼編：unique（預設，不會撞號）或 counter（照 duckd：e_000001 起跳，行程重啟就從頭編）。 */
  eventIds?: "unique" | "counter";
  /** 不回 heartbeat 的回聲（測往返時間量不到）。 */
  muteHeartbeatEcho?: boolean;
  log?: (line: string) => void;
}

const DEFAULT_CAPABILITIES: Capabilities = {
  head: { status: "mock" },
  walk: { status: "mock" },
  eyes: { status: "mock" },
  navigation: { status: "mock" },
  dock: { status: "mock" },
  camera: { status: "mock" },
  tracking_face: { status: "mock" },
  antennas: { status: "unsupported", reason: "mock: antenna servos not installed" },
  speaker: { status: "unsupported", reason: "mock: no audio output" },
  tracking_sound: { status: "unsupported", reason: "mock: no microphone array" },
  microphone: { status: "unsupported", reason: "mock: no microphone" },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class MockDuck {
  readonly mock = true;
  private ws: WebSocket | null = null;
  private readonly validator: DuckLinkValidator = createValidator();
  private readonly options: MockDuckOptions;
  private readonly speed: number;
  private capabilities: Capabilities;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private lastHeartbeatAt = 0;
  private leaseOk = true;
  private eventSeq = 0;
  private missionSeq = 0;
  private readonly acks = new Map<string, AckMessage>();

  // 模擬的鴨子狀態
  mode: DuckMode;
  private controlSource: StateMessage["control_source"] = "none";
  private presence: PresenceState = "idle";
  private expression = "neutral";
  private tracking: "none" | "face" | "sound" = "none";
  private readonly head: Record<HeadJoint, number> = { neck_pitch: 0, head_pitch: 0, head_yaw: 0, head_roll: 0 };
  private headMove: { from: Record<HeadJoint, number>; to: Record<HeadJoint, number>; startedAt: number; durationMs: number } | null = null;
  private walk: { vx: number; vy: number; yaw_rate: number; until: number; requestId: string } | null = null;
  private mission: { mission_id: string; kind: "go_to" | "find_person" | "return_home" | "follow_me"; phase: string; progress: number } | null = null;
  private place: string | null = "living_room";
  private onDock = false;
  /** 收到的每一則指令（測試檢查用）。 */
  readonly received: CommandMessage[] = [];

  constructor(options: MockDuckOptions) {
    this.options = options;
    this.speed = options.speed ?? 1;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.mode = options.startPaused ? "paused" : "standing";
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;
      ws.once("error", reject);
      ws.once("open", () => {
        ws.off("error", reject);
        ws.on("error", () => {});
        this.lastHeartbeatAt = Date.now();
        this.leaseOk = true;
        this.send({
          type: "hello",
          role: "duck",
          software: "mock-duck-ts 0.1.0",
          duck_id: this.options.duckId ?? "mock_duck",
          mock: true,
          capabilities: this.capabilities,
          gestures: this.options.gestures ?? ["nod", "shake", "tilt"],
          expressions: this.options.expressions ?? ["neutral", "happy", "curious", "sleepy"],
          sounds: this.options.sounds ?? [],
        });
        this.sendState();
        this.stateTimer = setInterval(() => this.sendState(), this.options.stateIntervalMs ?? 1_000);
        const lease = this.options.leaseMs ?? 1_500;
        this.leaseTimer = setInterval(() => this.checkLease(lease), Math.max(10, Math.floor(lease / 5)));
        resolve();
      });
      ws.on("message", (raw) => this.onMessage(raw.toString()));
      ws.on("close", () => this.clearTimers());
    });
  }

  disconnect(): void {
    this.clearTimers();
    this.ws?.terminate();
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.stateTimer = null;
    this.leaseTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms / this.speed);
    this.timers.add(t);
  }

  // ---- 測試用的注入 ----

  /** 送一個事件（例如 fell、battery_low）。 */
  emitEvent(event: DuckEventName, extra: { request_id?: string; mission_id?: string; reason?: string; data?: Record<string, unknown> } = {}): void {
    const n = ++this.eventSeq;
    const event_id = this.options.eventIds === "counter" ? `e_${String(n).padStart(6, "0")}` : `mock_e_${n}_${Date.now().toString(36)}`;
    this.send({ type: "event", event, event_id, ...extra });
  }

  /** 模擬跌倒：模式變 fallen，之後的動作指令都被拒絕。 */
  fall(): void {
    this.mode = "fallen";
    this.walk = null;
    this.failMission("fell");
    this.emitEvent("fell");
    this.sendState();
  }

  setCapability(name: CapabilityName, status: "mock" | "unsupported" | "degraded", reason?: string): void {
    this.capabilities = { ...this.capabilities, [name]: { status, ...(reason ? { reason } : {}) } };
    this.emitEvent("capability_changed", { data: { capability: name, status } });
    this.sendState();
  }

  /** 送一段原始文字（測 hub 對壞訊息的處理）。 */
  sendRaw(text: string): void {
    this.ws?.send(text);
  }

  // ---- 協定 ----

  private send(body: Record<string, unknown>): void {
    const message = { protocol_version: PROTOCOL_VERSION, sent_at_ms: Date.now(), ...body };
    const check = this.validator.validate(message);
    if (!check.ok) throw new Error(`mock 鴨子要送出不合 schema 的訊息：${check.errors.join("；")}`);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private onMessage(text: string): void {
    const result = this.validator.parse(text);
    if (!result.ok) {
      this.options.log?.(`mock 鴨子收到不合 schema 的訊息：${result.errors.join("；")}`);
      return;
    }
    const message = result.message;
    if (message.type === "heartbeat") {
      this.lastHeartbeatAt = Date.now();
      if (!this.leaseOk) {
        this.leaseOk = true;
        this.emitEvent("link_restored");
      }
      if (!this.options.muteHeartbeatEcho) this.send({ type: "heartbeat", seq: message.seq, echo_of: message.seq });
      return;
    }
    if (message.type === "command") this.onCommand(message);
  }

  private checkLease(leaseMs: number): void {
    if (!this.leaseOk || Date.now() - this.lastHeartbeatAt <= leaseMs) return;
    // 租約失效：停下動作、記 link_lost；恢復後不自動繼續。
    this.leaseOk = false;
    this.walk = null;
    this.headMove = null;
    if (this.mode === "walking") this.mode = "standing";
    this.failMission("link_lost");
    this.emitEvent("link_lost");
    this.sendState();
  }

  private onCommand(command: CommandMessage): void {
    this.received.push(command);
    const mode = this.options.ackMode?.(command) ?? "normal";
    if (mode === "disconnect") return this.disconnect();
    if (mode === "silent") return;
    // 重複的 request_id：回原本的 ack，不重做。
    const previous = this.acks.get(command.request_id);
    if (previous) return this.send({ ...previous });
    const ack = this.handle(command);
    const full = { type: "ack", request_id: command.request_id, ...ack } as const;
    this.acks.set(command.request_id, full as unknown as AckMessage);
    this.send(full);
    if (ack.status === "accepted" && !this.options.muteState) this.sendState();
  }

  private reject(reason: AckReason, detail?: string): Omit<AckMessage, "protocol_version" | "type" | "sent_at_ms" | "request_id"> {
    return { status: "rejected", reason, ...(detail ? { detail: `mock: ${detail}` } : {}) };
  }

  private handle(command: CommandMessage): Omit<AckMessage, "protocol_version" | "type" | "sent_at_ms" | "request_id"> {
    const forced = this.options.reject?.(command);
    if (forced) return this.reject(forced, "forced by test scenario");
    const params = command.params ?? {};
    const action: DuckAction = command.action;
    for (const cap of capabilitiesFor(action, params)) {
      if ((this.capabilities[cap]?.status ?? "unsupported") === "unsupported") return this.reject("unsupported", `${action}: capability ${cap}`);
    }
    const moving: readonly DuckAction[] = ["walk", "look", "gesture", "track", "go_to", "find_person", "return_home", "follow_me"];
    if (moving.includes(action)) {
      if (this.mode === "fallen") return this.reject("fallen");
      if (this.mode === "estop") return this.reject("estop_latched");
      if (!this.leaseOk) return this.reject("link_degraded");
    }
    switch (action) {
      case "status":
        return { status: "accepted", data: { mode: this.mode, mock: true } };
      case "stop":
        this.walk = null;
        this.headMove = null;
        this.tracking = "none";
        this.failMission("stopped");
        if (this.mode === "walking" || this.mode === "waiting") this.mode = "standing";
        this.controlSource = "duck_link";
        return { status: "accepted" };
      case "resume":
        if (this.mode === "paused") this.mode = "standing";
        return { status: "accepted" };
      case "walk": {
        if (this.mode === "paused") return this.reject("paused");
        if (this.mission) return this.reject("busy_mission");
        const want = { vx: Number(params.vx ?? 0), vy: Number(params.vy ?? 0), yaw_rate: Number(params.yaw_rate ?? 0), duration_s: Number(params.duration_s) };
        const applied = {
          vx: clamp(want.vx, -MOCK_WALK_LIMITS.vx, MOCK_WALK_LIMITS.vx),
          vy: clamp(want.vy, -MOCK_WALK_LIMITS.vy, MOCK_WALK_LIMITS.vy),
          yaw_rate: clamp(want.yaw_rate, -MOCK_WALK_LIMITS.yaw_rate, MOCK_WALK_LIMITS.yaw_rate),
          duration_s: Math.min(want.duration_s, MOCK_WALK_LIMITS.duration_s),
        };
        const clamped = (Object.keys(applied) as (keyof typeof applied)[]).some((k) => applied[k] !== want[k]);
        const requestId = command.request_id;
        this.walk = { ...applied, until: Date.now() + (applied.duration_s * 1000) / this.speed, requestId };
        this.mode = "walking";
        this.controlSource = "duck_link";
        this.later(applied.duration_s * 1000, () => {
          if (this.walk?.requestId !== requestId) return;
          this.walk = null;
          this.mode = "standing";
          this.emitEvent("walk_done", { request_id: requestId });
          this.sendState();
        });
        return { status: "accepted", applied, clamped };
      }
      case "look": {
        this.settleHead();
        const to = { ...this.head };
        const applied: Record<string, number> = {};
        let clamped = false;
        for (const joint of HEAD_JOINTS) {
          const v = params[joint];
          if (typeof v !== "number") continue;
          const [lo, hi] = MOCK_HEAD_LIMITS[joint];
          to[joint] = clamp(v, lo, hi);
          applied[joint] = to[joint];
          if (to[joint] !== v) clamped = true;
        }
        const duration = typeof params.duration_s === "number" ? params.duration_s : 0.5;
        applied.duration_s = duration;
        this.headMove = { from: { ...this.head }, to, startedAt: Date.now(), durationMs: (duration * 1000) / this.speed };
        this.controlSource = "duck_link";
        return { status: "accepted", applied, clamped };
      }
      case "track":
        this.tracking = params.target as "none" | "face" | "sound";
        this.controlSource = "duck_link";
        return { status: "accepted", applied: { target: this.tracking } };
      case "gesture": {
        const name = String(params.name);
        if (!(this.options.gestures ?? ["nod", "shake", "tilt"]).includes(name)) return this.reject("unknown_name", "gesture not in whitelist");
        const requestId = command.request_id;
        this.controlSource = "duck_link";
        this.later(800, () => this.emitEvent("gesture_done", { request_id: requestId }));
        return { status: "accepted", applied: { name } };
      }
      case "express": {
        const expression = String(params.expression);
        if (!(this.options.expressions ?? ["neutral", "happy", "curious", "sleepy"]).includes(expression)) return this.reject("unknown_name", "expression not in list");
        this.expression = expression;
        return { status: "accepted", applied: { expression } };
      }
      case "antennas":
        return { status: "accepted", applied: { ...params } };
      case "sound":
        if (!(this.options.sounds ?? []).includes(String(params.name))) return this.reject("unknown_name", "sound not in list");
        return { status: "accepted" };
      case "presence":
        this.presence = params.state as PresenceState;
        return { status: "accepted", applied: { state: this.presence } };
      case "where":
        return { status: "accepted", data: { place: this.place, localized: true, uncertainty_m: 0.2, on_dock: this.onDock, mock: true } };
      case "places":
        return { status: "accepted", data: { places: MOCK_PLACES, map_version: "mock_fixture_1", mock: true } };
      case "mission_status":
        return { status: "accepted", data: { mission: this.mission, mock: true } };
      case "go_to": {
        const place = String(params.place);
        if (!MOCK_PLACES.some((p) => p.id === place)) return this.reject("unknown_name", "place not on map");
        return this.startMission("go_to", () => {
          this.place = place;
        });
      }
      case "find_person":
        return this.startMission("find_person", () => {});
      case "return_home":
        return this.startMission("return_home", () => {
          this.place = "dock";
          this.onDock = true;
          this.mode = "docked";
          this.emitEvent("docked");
        });
      case "follow_me":
        return this.startMission("follow_me", () => {});
      case "wait_here":
        this.walk = null;
        this.failMission("stopped");
        this.mode = "waiting";
        this.controlSource = "duck_link";
        return { status: "accepted" };
      case "cancel_mission":
        if (!this.mission) return this.reject("no_mission");
        if (typeof params.mission_id === "string" && params.mission_id !== this.mission.mission_id) return this.reject("no_mission", "mission_id does not match");
        this.failMission("cancelled");
        return { status: "accepted" };
    }
  }

  private startMission(kind: "go_to" | "find_person" | "return_home" | "follow_me", onDone: () => void): Omit<AckMessage, "protocol_version" | "type" | "sent_at_ms" | "request_id"> {
    if (this.mode === "paused") return this.reject("paused");
    if (this.mission) return this.reject("busy_mission");
    const mission_id = `mock_m_${++this.missionSeq}`;
    this.mission = { mission_id, kind, phase: "starting", progress: 0 };
    this.mode = "walking";
    this.onDock = false;
    this.controlSource = "mission";
    const outcome = this.options.missionOutcome ?? "done";
    this.later(400, () => {
      if (this.mission?.mission_id !== mission_id) return;
      this.mission = { ...this.mission, phase: "moving", progress: 0.5 };
      this.emitEvent("mission_progress", { mission_id, data: { progress: 0.5, phase: "moving" } });
      this.sendState();
    });
    if (outcome !== "hold") {
      this.later(800, () => {
        if (this.mission?.mission_id !== mission_id) return;
        this.mission = null;
        this.mode = "standing";
        if (outcome === "done") {
          onDone();
          this.emitEvent("mission_done", { mission_id });
        } else {
          this.emitEvent("mission_failed", { mission_id, reason: "door_closed" });
        }
        this.sendState();
      });
    }
    return { status: "accepted", mission_id };
  }

  private failMission(reason: string): void {
    if (!this.mission) return;
    const mission_id = this.mission.mission_id;
    this.mission = null;
    if (this.mode === "walking") this.mode = "standing";
    this.emitEvent("mission_failed", { mission_id, reason });
  }

  private settleHead(): void {
    const move = this.headMove;
    if (!move) return;
    const t = move.durationMs <= 0 ? 1 : clamp((Date.now() - move.startedAt) / move.durationMs, 0, 1);
    for (const joint of HEAD_JOINTS) this.head[joint] = move.from[joint] + (move.to[joint] - move.from[joint]) * t;
    if (t >= 1) this.headMove = null;
  }

  sendState(): void {
    this.settleHead();
    const state: Record<string, unknown> = {
      type: "state",
      mock: true,
      mode: this.mode,
      control_source: this.controlSource,
      capabilities: this.capabilities,
      faults: [],
      presence: this.presence,
      expression: this.expression,
      tracking: this.tracking,
      head: { ...this.head, age_ms: 0 },
      velocity_cmd: this.walk ? { vx: this.walk.vx, vy: this.walk.vy, yaw_rate: this.walk.yaw_rate, remaining_s: Math.max(0, ((this.walk.until - Date.now()) * this.speed) / 1000) } : { vx: 0, vy: 0, yaw_rate: 0, remaining_s: 0 },
      battery: { source: "none", charging: null },
      mission: this.mission,
      location: { place: this.place, localized: true, uncertainty_m: 0.2, on_dock: this.onDock },
      link: { lease_ok: this.leaseOk, rtt_ms: null },
    };
    this.send(state);
  }
}
