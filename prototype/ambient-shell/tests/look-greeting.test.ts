import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraSettingsStore } from "../server/camera-settings.ts";
import { loadConfig } from "../server/config.ts";
import type { HostCall, LiveCoreEvent, LiveInputKind } from "../shared/realtime-route.ts";
import { CAMERA_PREFS, CameraPatchError, DEFAULT_CAMERA_PREFS, LOOK_TO_TALK_GREETING, parseCameraPatch } from "../shared/sense.ts";
import { LiveVoice, type LiveDeps } from "../src/live-voice.ts";
import { RealtimeVoice, type RealtimeCallbacks, type RealtimeDeps } from "../src/realtime.ts";
import { FallbackOfferError, greetingFor, GreetingOnce, openRealtime } from "../src/realtime-session.ts";
import { matchCameraCommand } from "../src/sense/controller.ts";

// 看著說話開始時先打招呼（George 2026-10-23）。假的 WebRTC、假的核心，全部是 fixture：
// 證明的是「什麼時候送出哪個事件」，不是模型真的說了招呼（那要在 George 家中實測）。

class FakeChannel {
  readyState = "open";
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  get events() { return this.sent.map((d) => JSON.parse(d) as Record<string, unknown>); }
}

class FakePeer {
  channel = new FakeChannel();
  connectionState = "new";
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 fake-offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
  connect() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }
}

const callbacks = (log: string[] = []): RealtimeCallbacks => ({
  onPhase: () => {},
  onUserTranscript: () => {},
  onAssistantTranscript: () => {},
  onDelegate: async () => ({ ok: true }),
  onGetTasks: async () => ({ ok: true }),
  onWebSearch: async () => ({ ok: true }),
  onHomeStatus: async () => ({ ok: true }),
  onHomeControl: async () => ({ ok: false, error: "fixture" }),
  onHomeConfirm: async () => ({ ok: false, error: "fixture" }),
  onApprovalPrompt: () => {},
  onApprovalResolved: () => {},
  onToolActivity: () => {},
  onClosed: (r) => void log.push(`closed:${r}`),
});

const mic = () => {
  const track = { stop: vi.fn(), readyState: "live" };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
};

function ga(greeting: GreetingOnce | null, log: string[] = []) {
  const peer = new FakePeer();
  const deps: RealtimeDeps = {
    getMicrophone: async () => mic(),
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 fake-answer",
  };
  const voice = new RealtimeVoice(callbacks(log), deps, { idleMs: 120_000, greeting });
  const responses = () => peer.channel.events.filter((e) => e.type === "response.create");
  return { voice, peer, ch: peer.channel, responses };
}

function live(greeting: GreetingOnce | null, options: { exchange?: () => Promise<string> } = {}) {
  const peer = new FakePeer();
  const inputs: { kind: LiveInputKind; text: string }[] = [];
  let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
  const deps: LiveDeps = {
    getMicrophone: async () => mic(),
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: options.exchange ?? (async () => "v=0 live-answer"),
    input: async (kind, text) => void inputs.push({ kind, text }),
    hostResult: async () => {},
    approval: async () => {},
    end: async () => {},
    subscribe: (h) => {
      handlers = h;
      return () => (handlers = null);
    },
    watchLevel: () => () => {},
    setMuted: () => {},
    speak: () => {},
  };
  const voice = new LiveVoice(callbacks(), deps, { idleMs: 120_000, greeting });
  const greetings = () => inputs.filter((i) => i.kind === "greeting");
  return { voice, peer, inputs, greetings, core: (e: LiveCoreEvent) => handlers!.core(e) };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("look_to_talk_greet pref", () => {
  it("defaults to on, sits right after the look-to-talk prefs, and only accepts booleans", () => {
    expect(DEFAULT_CAMERA_PREFS.look_to_talk_greet).toBe(true);
    expect(CAMERA_PREFS.look_to_talk_greet).toMatchObject({ kind: "bool", label: "看著說話時先打招呼" });
    const keys = Object.keys(CAMERA_PREFS);
    expect(keys.indexOf("look_to_talk_greet")).toBe(keys.indexOf("look_to_talk_cooldown_s") + 1);
    expect(parseCameraPatch({ look_to_talk_greet: false })).toEqual({ look_to_talk_greet: false });
    expect(() => parseCameraPatch({ look_to_talk_greet: "off" })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_greet: 0 })).toThrow(CameraPatchError);
  });

  it("an older camera.json without the key loads with the default; a saved false is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-greet-"));
    writeFileSync(join(dir, "camera.json"), JSON.stringify({ schema_version: 1, prefs: { stop_gesture: false, look_to_talk_s: 2 } }));
    const make = () => new CameraSettingsStore({ base: loadConfig({ NOUS_CAMERA: "on" }).camera, dir, onChange: () => {} });
    expect(make().view()).toMatchObject({ look_to_talk_greet: true, stop_gesture: false, look_to_talk_s: 2 });
    make().update({ look_to_talk_greet: false });
    expect(make().view()).toMatchObject({ look_to_talk_greet: false, stop_gesture: false });
  });

  it("voice commands toggle it; bare 打招呼, negations and questions are not commands", () => {
    expect(matchCameraCommand("關閉打招呼")).toMatchObject({ set: { look_to_talk_greet: false } });
    expect(matchCameraCommand("打招呼關掉")).toMatchObject({ set: { look_to_talk_greet: false } });
    expect(matchCameraCommand("請把看著說話時先打招呼關掉")).toMatchObject({ set: { look_to_talk_greet: false } });
    expect(matchCameraCommand("打開打招呼")).toMatchObject({ set: { look_to_talk_greet: true } });
    expect(matchCameraCommand("打招呼打開")).toMatchObject({ set: { look_to_talk_greet: true } });
    expect(matchCameraCommand("關閉看著說話")).toMatchObject({ set: { look_to_talk: false } });
    for (const text of ["打招呼", "跟他打招呼", "不要關閉打招呼", "怎麼關閉打招呼"]) expect(matchCameraCommand(text)).toBeNull();
  });

  it("the greeting text asks for a short greeting and forbids claiming to see the user", () => {
    expect(LOOK_TO_TALK_GREETING).toContain("繁體中文");
    expect(LOOK_TO_TALK_GREETING).toContain("有什麼需要幫忙");
    expect(LOOK_TO_TALK_GREETING).toContain("不要說看到使用者");
    expect(Buffer.byteLength(LOOK_TO_TALK_GREETING)).toBeLessThanOrEqual(500); // 一段 session.context.append
  });
});

describe("greetingFor / GreetingOnce", () => {
  it("only a look-to-talk start with the pref on gets a greeting", () => {
    expect(greetingFor("look_to_talk", () => true, "hi")).toBeInstanceOf(GreetingOnce);
    expect(greetingFor("user", () => true, "hi")).toBeNull();
    expect(greetingFor("look_to_talk", () => false, "hi")).toBeNull();
  });

  it("take() hands out the instructions once; skip() before it cancels; the pref is re-read at take()", () => {
    const once = new GreetingOnce("hi");
    expect(once.take()).toBe("hi");
    expect(once.take()).toBeNull();
    once.skip();
    expect(once.state).toBe("sent");

    const skipped = new GreetingOnce("hi");
    skipped.skip();
    expect(skipped.take()).toBeNull();
    expect(skipped.state).toBe("skipped");

    let on = true;
    const live = new GreetingOnce("hi", () => on);
    on = false; // 連上之前在設定畫面關掉
    expect(live.take()).toBeNull();
    on = true;
    expect(live.take()).toBeNull();
  });
});

describe("API key route (RealtimeVoice)", () => {
  it("greets once with per-response instructions after session.created, never before, and adds no fake user message", async () => {
    const t = ga(new GreetingOnce(LOOK_TO_TALK_GREETING));
    await t.voice.start();
    expect(t.responses()).toHaveLength(0); // 連線中：還沒有 session.created
    t.ch.emit({ type: "session.created" });
    expect(t.responses()).toEqual([{ type: "response.create", response: { instructions: LOOK_TO_TALK_GREETING } }]);
    expect(t.ch.events.some((e) => e.type === "conversation.item.create")).toBe(false);
    // 招呼念完、再來一次 session.created（不該發生，仍防）也不會再打招呼。
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.done" });
    t.ch.emit({ type: "session.created" });
    expect(t.responses()).toHaveLength(1);
  });

  it("a manual start (no greeting) sends nothing on session.created — same sequence as before", async () => {
    const t = ga(null);
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    expect(t.ch.sent).toEqual([]);
  });

  it("pref switched off before the session is ready: no greeting", async () => {
    let on = true;
    const t = ga(new GreetingOnce(LOOK_TO_TALK_GREETING, () => on));
    await t.voice.start();
    on = false;
    t.ch.emit({ type: "session.created" });
    expect(t.responses()).toHaveLength(0);
  });

  it("the user speaks (or types) before the greeting is sent: skipped", async () => {
    const spoke = ga(new GreetingOnce(LOOK_TO_TALK_GREETING));
    await spoke.voice.start();
    spoke.ch.emit({ type: "input_audio_buffer.speech_started" });
    spoke.ch.emit({ type: "session.created" });
    expect(spoke.responses()).toHaveLength(0);

    const typed = ga(new GreetingOnce(LOOK_TO_TALK_GREETING));
    await typed.voice.start();
    typed.voice.sendText("幫我查天氣");
    typed.ch.emit({ type: "session.created" });
    expect(typed.responses()).toEqual([{ type: "response.create" }]); // 只有打字那一輪
  });
});

describe("ChatGPT plan route (LiveVoice)", () => {
  async function connect(t: ReturnType<typeof live>) {
    await t.voice.start();
    t.peer.connect();
  }

  it("greets once through the core (kind greeting) only after mic + peer + session.started", async () => {
    const t = live(new GreetingOnce(LOOK_TO_TALK_GREETING));
    await connect(t);
    expect(t.greetings()).toHaveLength(0); // peer 連上，但還沒有 session.started
    t.peer.channel.emit({ type: "session.started", session: {} });
    expect(t.voice.current).toBe("listening");
    expect(t.greetings()).toEqual([{ kind: "greeting", text: LOOK_TO_TALK_GREETING }]);
    t.core({ kind: "started", expires_at: null });
    t.peer.channel.emit({ type: "session.started", session: {} });
    expect(t.greetings()).toHaveLength(1);
    expect(t.inputs.filter((i) => i.kind === "notice")).toHaveLength(0);
  });

  it("no greeting for a manual start or with the pref off", async () => {
    for (const greeting of [null, new GreetingOnce(LOOK_TO_TALK_GREETING, () => false)]) {
      const t = live(greeting);
      await connect(t);
      t.peer.channel.emit({ type: "session.started", session: {} });
      expect(t.voice.current).toBe("listening");
      expect(t.inputs).toEqual([]);
    }
  });

  it("a user transcript (even partial) before listening skips the greeting", async () => {
    const t = live(new GreetingOnce(LOOK_TO_TALK_GREETING));
    await connect(t);
    t.core({ kind: "transcript", role: "user", text: "嗨", final: false, item_id: null });
    t.peer.channel.emit({ type: "session.started", session: {} });
    expect(t.voice.current).toBe("listening");
    expect(t.greetings()).toHaveLength(0);
  });
});

describe("exactly once across the live → API key fallback", () => {
  it("the live session never reached listening; the API key session greets once, after the billing notice", async () => {
    const greeting = greetingFor("look_to_talk", () => true, LOOK_TO_TALK_GREETING)!;
    const order: string[] = [];
    const fallback = { session_id: "rt_b", owner: "own_b", route: "api_key" as const, model: "gpt-realtime", billing_line: "OpenAI API key 計費", notice: "這次改用 OpenAI API key（fixture）" };
    const first = live(greeting, { exchange: async () => { throw new FallbackOfferError({ error: "額度已用完", fallback }); } });
    const second = ga(greeting);
    const sessions = [first.voice, second.voice];
    const result = await openRealtime({
      start: async () => ({ ok: true, session_id: "rt_a", owner: "own_a", route: "live", model: "gpt-live-1-codex", billing_line: "ChatGPT 方案", notice: null }),
      makeSession: (d) => (order.push(`make:${d.route}`), sessions.shift()!),
      announce: async (n) => void order.push(`announce:${n}`),
      refused: () => order.push("refused"),
      began: () => {},
    });
    expect(result).toBe(second.voice);
    expect(order).toEqual(["make:live", `announce:${fallback.notice}`, "make:api_key"]);
    expect(first.greetings()).toHaveLength(0);
    expect(second.responses()).toHaveLength(0);
    second.ch.emit({ type: "session.created" });
    expect(second.responses()).toEqual([{ type: "response.create", response: { instructions: LOOK_TO_TALK_GREETING } }]);
    expect(greeting.state).toBe("sent");
    // 同一個招呼物件再給新的工作階段（例如之後又改路徑）也不會再打。
    const third = ga(greeting);
    await third.voice.start();
    third.ch.emit({ type: "session.created" });
    expect(third.responses()).toHaveLength(0);
  });
});
