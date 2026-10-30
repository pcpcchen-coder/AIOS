import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalReport, HostCall, LiveCoreEvent, LiveInputKind } from "../shared/realtime-route.ts";
import type { HomeControlResult } from "../shared/home.ts";
import { LiveVoice, orphanStopReport, SPEAKING_OFF_MS, SPEAKING_ON_MS, SPEAKING_RMS, type LiveDeps } from "../src/live-voice.ts";
import { FallbackOfferError, openRealtime, type RealtimeSession } from "../src/realtime-session.ts";
import type { ApprovalOutcome, ApprovalRequest, HomeResult, RealtimePhase } from "../src/realtime.ts";

// ChatGPT 方案路徑的頁面模組：假的 WebRTC（資料通道送 frameless 事件）、假的核心（SSE 事件與 POST），
// 不需要麥克風、喇叭或網路。全部是 fixture。

class FakeChannel {
  readyState = "open";
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

class FakePeer {
  channel = new FakeChannel();
  connectionState = "new";
  remote: unknown = null;
  closed = false;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 fake-offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(desc: unknown) { this.remote = desc; }
  close() { this.closed = true; }
  connect() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }
}

const NEEDS_CONFIRM: HomeControlResult = { ok: true, status: "needs_confirmation", confirm_id: "home_c1", device: "書房燈", room: "書房", action: "關閉", expires_in_s: 90, message: "需要確認（fixture）" } as unknown as HomeControlResult;
const CONFIRMED: HomeResult = { ok: true, status: "confirmed", device: "書房燈", room: "書房", action: "關閉", message: "設備回讀已確認（fixture）" } as HomeResult;

function setup(options: { control?: () => HomeResult; exchange?: () => Promise<string>; approvalFails?: number } = {}) {
  vi.useFakeTimers();
  const peer = new FakePeer();
  const track = { stop: vi.fn(), readyState: "live" };
  let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
  let level: ((rms: number) => void) | null = null;
  const log: string[] = [];
  const phases: RealtimePhase[] = [];
  const user: string[] = [];
  const assistant: string[] = [];
  const closed: string[] = [];
  const spoken: string[] = [];
  const inputs: { kind: LiveInputKind; text: string }[] = [];
  const results: { id: string; output: Record<string, unknown> }[] = [];
  const approvalsPosted: string[] = [];
  const reports: ApprovalReport[] = [];
  const prompts: ApprovalRequest[] = [];
  const resolved: { id: string; approved: boolean; outcome: ApprovalOutcome }[] = [];
  const confirms: { id: string; approve: boolean }[] = [];
  const activity: string[] = [];
  const tools: string[] = [];
  let ended = 0;
  const deps: LiveDeps = {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: options.exchange ?? (async () => "v=0 live-answer"),
    input: async (kind, text) => void inputs.push({ kind, text }),
    hostResult: async (id, output) => {
      log.push(`result:${id}`);
      results.push({ id, output });
    },
    approval: async (report) => {
      reports.push(report);
      if (options.approvalFails && options.approvalFails-- > 0) throw new Error("approval POST failed（fixture）");
      log.push(`approval:${report.state}`);
      approvalsPosted.push(report.state);
    },
    end: async () => void ended++,
    subscribe: (h) => {
      handlers = h;
      return () => (handlers = null);
    },
    watchLevel: (_s, onLevel) => {
      level = onLevel;
      return () => (level = null);
    },
    setMuted: () => {},
    speak: (text) => void spoken.push(text),
  };
  const voice = new LiveVoice(
    {
      onPhase: (p) => phases.push(p),
      onUserTranscript: (t) => user.push(t),
      onAssistantTranscript: (t) => assistant.push(t),
      onDelegate: async (title) => (tools.push(`delegate:${title}`), { ok: true, title, status: "running" }),
      onGetTasks: async () => (tools.push("get_tasks"), { ok: true, tasks: [] }),
      onWebSearch: async (q) => (tools.push(`search:${q}`), { ok: true, answer: "多雲（fixture）", sources: ["fixture 氣象站"] }),
      onHomeStatus: async (target) => (tools.push(`status:${target}`), { ok: true, status: "ok" }),
      onHomeControl: async (args) => (tools.push(`control:${args.target}`), options.control?.() ?? NEEDS_CONFIRM),
      onHomeConfirm: async (id, approve) => (confirms.push({ id, approve }), approve ? CONFIRMED : ({ ok: true, status: "refused", reason: "declined", message: "沒有執行（fixture）", device: "書房燈", room: "書房" } as HomeResult)),
      onApprovalPrompt: (r) => prompts.push(r),
      onApprovalResolved: (r, approved, outcome) => resolved.push({ id: r.id, approved, outcome }),
      onToolActivity: (t) => activity.push(t),
      onClosed: (r) => closed.push(r),
    },
    deps,
    { idleMs: 120_000, approvalMs: 60_000 },
  );
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const host = (name: HostCall["name"], args: Record<string, unknown>, id = "hc_1") => handlers!.host({ call_id: id, name, arguments: JSON.stringify(args) });
  const core = (event: LiveCoreEvent) => handlers!.core(event);
  const sound = (rms: number, ms: number) => {
    for (let t = 0; t <= ms; t += 50) {
      level?.(rms);
      vi.advanceTimersByTime(50);
    }
  };
  async function live() {
    await voice.start();
    peer.ontrack?.({ streams: [{}] });
    peer.connect();
    peer.channel.emit({ type: "session.started", session: {} });
  }
  return { voice, peer, track, phases, user, assistant, closed, spoken, inputs, results, approvalsPosted, reports, prompts, resolved, confirms, activity, tools, log, flush, host, core, sound, live, ended: () => ended, subscribed: () => !!handlers };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("LiveVoice state comes from device evidence and real events", () => {
  it("listening needs mic track + connected peer + session.started; not the mode flag", async () => {
    const t = setup();
    await t.voice.start();
    expect(t.voice.current).toBe("connecting");
    t.peer.channel.emit({ type: "session.started", session: {} });
    expect(t.voice.current).toBe("connecting");
    t.peer.connect();
    expect(t.voice.current).toBe("listening");
  });

  it("session.updated alone never means started", async () => {
    const t = setup();
    await t.voice.start();
    t.peer.connect();
    t.peer.channel.emit({ type: "session.updated", session: {} });
    expect(t.voice.current).toBe("connecting");
    t.core({ kind: "started", expires_at: null });
    expect(t.voice.current).toBe("listening");
  });

  it("speaking only from measured remote audio level, and back to listening when quiet — no GA events needed", async () => {
    const t = setup();
    await t.live();
    t.peer.channel.emit({ type: "input_transcript.added", item: { text: "你" } });
    expect(t.voice.current).toBe("hearing");
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "你好" } });
    expect(t.voice.current).toBe("thinking");
    t.sound(SPEAKING_RMS * 5, SPEAKING_ON_MS);
    expect(t.voice.current).toBe("speaking");
    t.peer.channel.emit({ type: "turn.done", turn: { role: "assistant", transcript: "嗨" } });
    expect(t.voice.current).toBe("speaking");
    t.sound(0, SPEAKING_OFF_MS);
    expect(t.voice.current).toBe("listening");
    expect(t.user).toEqual(["你好"]);
    expect(t.assistant).toEqual(["嗨"]);
    expect(t.peer.channel.sent).toEqual([]); // 頁面不在資料通道上寫任何東西
  });

  it("transcripts from the data channel and the core are deduplicated by item id", async () => {
    const t = setup();
    await t.live();
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "客廳燈打開", id: "u1" } });
    t.core({ kind: "transcript", role: "user", text: "客廳燈打開", final: true, item_id: "u1" });
    t.core({ kind: "transcript", role: "assistant", text: "好，我請中控處理", final: true, item_id: null });
    t.peer.channel.emit({ type: "turn.done", turn: { role: "assistant", transcript: "好，我請中控處理" } });
    expect(t.user).toEqual(["客廳燈打開"]);
    expect(t.assistant).toEqual(["好，我請中控處理"]);
  });

  it("a user repeating the same words is not deduplicated; only the relay copy of the same event is", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    // 第一次：資料通道與核心各送一份（同一個事件，都沒有 item_id）。
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "取消吧" } });
    t.core({ kind: "transcript", role: "user", text: "取消吧", final: true, item_id: null });
    expect(t.user).toEqual(["取消吧"]);
    // 10 秒內同一個來源又說一次（真的又說了）：要算。
    vi.advanceTimersByTime(3_000);
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "確認執行" } });
    t.host("home_control", { target: "書房燈", command: "power", value: false }, "hc_2");
    await t.flush();
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "確認執行" } });
    await t.flush();
    expect(t.user).toEqual(["取消吧", "確認執行", "確認執行"]);
    expect(t.resolved.map((r) => r.outcome)).toEqual(["said_reject", "said_approve"]);
  });

  it("delegation.created on the data channel is ignored (the core owns it)", async () => {
    const t = setup();
    await t.live();
    t.peer.channel.emit({ type: "delegation.created", item: { type: "delegation", target: "client", id: "d", content: [{ type: "input_text", text: "開燈" }] } });
    await t.flush();
    expect(t.tools).toEqual([]);
    expect(t.results).toEqual([]);
  });
});

describe("LiveVoice runs the shared executor for the core's host calls", () => {
  it("home_control needs_confirmation: card shown and reported to the core before the result is posted; spoken 確認執行 confirms", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    expect(t.prompts).toMatchObject([{ kind: "home", id: "home_c1", device: "書房燈" }]);
    expect(t.log).toEqual(["approval:open", "result:hc_1"]);
    expect(t.results[0].output).toMatchObject({ status: "needs_confirmation" });
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "確認執行" } });
    await t.flush();
    expect(t.confirms).toEqual([{ id: "home_c1", approve: true }]);
    expect(t.resolved).toEqual([{ id: "home_c1", approved: true, outcome: "said_approve" }]);
    expect(t.approvalsPosted).toEqual(["open", "resolved"]);
    expect(t.inputs).toContainEqual({ kind: "notice", text: expect.stringContaining("書房燈") });
  });

  it("the card reports its own timeout on open and the outcome on resolve; a failed POST is retried once", async () => {
    const t = setup({ approvalFails: 1 });
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "確認執行" } });
    await t.flush();
    // 第一次 open 失敗（fixture）→ 再送一次成功。
    expect(t.reports).toEqual([
      { state: "open", timeout_ms: 60_000 },
      { state: "open", timeout_ms: 60_000 },
      { state: "resolved", outcome: "said_approve" },
    ]);
    expect(t.approvalsPosted).toEqual(["open", "resolved"]);
  });

  it("a card that times out reports outcome timeout (not an answer)", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    vi.advanceTimersByTime(60_000);
    await t.flush();
    expect(t.reports.at(-1)).toEqual({ state: "resolved", outcome: "timeout" });
  });

  it("the card button resolves it the same way", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    t.voice.resolveApproval(true, "said_approve");
    await t.flush();
    expect(t.confirms).toEqual([{ id: "home_c1", approve: true }]);
  });

  it("a second home_control while the card is open returns busy and releases the new id", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false }, "hc_1");
    await t.flush();
    t.host("home_control", { target: "客廳燈", command: "power", value: true }, "hc_2");
    await t.flush();
    expect(t.results.find((r) => r.id === "hc_2")!.output).toMatchObject({ status: "busy" });
    expect(t.confirms).toEqual([{ id: "home_c1", approve: false }]);
    expect(t.activity.some((a) => a.startsWith("沒有送出：另一張確認卡還開著"))).toBe(true);
    expect(t.voice.pendingApproval?.id).toBe("home_c1");
  });

  it("web_search and delegate_task run the same callbacks as GA; no result is posted after teardown", async () => {
    const t = setup();
    await t.live();
    t.host("web_search", { query: "新竹今天天氣" }, "hc_s");
    t.host("delegate_task", { title: "比較三家電信資費" }, "hc_d");
    await t.flush();
    expect(t.tools).toEqual(["search:新竹今天天氣", "delegate:比較三家電信資費"]);
    expect(t.activity).toContain("上網查詢：新竹今天天氣");
    expect(t.results.map((r) => r.id).sort()).toEqual(["hc_d", "hc_s"]);
    t.voice.stop();
    expect(t.subscribed()).toBe(false);
    expect(t.ended()).toBe(1);
  });

  it("end_conversation from the core ends after the goodbye has played", async () => {
    const t = setup();
    await t.live();
    t.host("end_conversation", {});
    await t.flush();
    expect(t.results[0].output).toEqual({ ok: true });
    t.sound(SPEAKING_RMS * 5, SPEAKING_ON_MS);
    t.peer.channel.emit({ type: "turn.done", turn: { role: "assistant", transcript: "再見！" } });
    vi.advanceTimersByTime(2_000);
    expect(t.voice.on).toBe(true); // 還在念
    t.sound(0, SPEAKING_OFF_MS + 1_600);
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual(["對話已結束。"]);
  });

  it("a whole-utterance 再見 is a local backup for ending", async () => {
    const t = setup();
    await t.live();
    t.peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: "再見。" } });
    t.peer.channel.emit({ type: "turn.done", turn: { role: "assistant", transcript: "掰掰" } });
    vi.advanceTimersByTime(1_600);
    expect(t.closed).toEqual(["對話已結束。"]);
  });

  it("typed text goes to the core as user_text and still answers an open card", async () => {
    const t = setup();
    await t.live();
    t.voice.sendText("把冷氣調 26 度");
    expect(t.inputs).toEqual([{ kind: "user_text", text: "把冷氣調 26 度" }]);
    expect(t.voice.current).toBe("thinking");
  });

  it("tool_unknown from the core shows 「結果不明，請確認」, never failure", async () => {
    const t = setup();
    await t.live();
    t.core({ kind: "tool_unknown", name: "home_control", message: "結果不明，請確認" });
    expect(t.activity.at(-1)).toContain("結果不明，請確認");
    expect(t.activity.at(-1)).not.toMatch(/失敗/);
  });

  it("a core closed event (sideband lost) tears down the peer and shows and speaks the reason; no fallback", async () => {
    const t = setup();
    await t.live();
    t.host("home_control", { target: "書房燈", command: "power", value: false });
    await t.flush();
    t.core({ kind: "closed", reason: "connection_lost", message: "與 ChatGPT 方案即時語音的控制連線中斷，即時語音已結束。" });
    expect(t.voice.on).toBe(false);
    expect(t.peer.closed).toBe(true);
    expect(t.track.stop).toHaveBeenCalled();
    expect(t.closed).toEqual(["與 ChatGPT 方案即時語音的控制連線中斷，即時語音已結束。"]);
    expect(t.spoken).toEqual(["與 ChatGPT 方案即時語音的控制連線中斷，即時語音已結束。"]);
    expect(t.resolved).toContainEqual({ id: "home_c1", approved: false, outcome: "closed" });
    expect(t.voice.fallbackOffer).toBeNull();
  });

  it("Esc mutes the playback (no response.cancel on this route) and says so", async () => {
    const t = setup();
    await t.live();
    t.sound(SPEAKING_RMS * 5, SPEAKING_ON_MS);
    t.voice.interrupt();
    expect(t.activity).toContain("已靜音這段回覆");
    expect(t.peer.channel.sent).toEqual([]);
  });
});

describe("brain regions pulse only from executed tools", () => {
  it("main.ts pulses in the executed tool callbacks, never from the assistant's words", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const assistant = main.slice(main.indexOf("onAssistantTranscript:"), main.indexOf("onDelegate:"));
    expect(assistant).not.toContain("brain.pulse");
    const user = main.slice(main.indexOf("onUserTranscript:"), main.indexOf("onAssistantTranscript:"));
    expect(user).not.toContain("brain.pulse");
    for (const fn of ["async function webSearchFromRealtime(", "async function homeStatusFromRealtime(", "async function homeControlFromRealtime("]) {
      const body = main.slice(main.indexOf(fn), main.indexOf("\n}\n", main.indexOf(fn)));
      expect(body).toMatch(/brain\.pulse\("step", classifyDomain\(/);
    }
    // LiveVoice 本身沒有腦區動畫：只有共用的 callbacks（實際執行的工具）會觸發。
    expect(readFileSync(new URL("../src/live-voice.ts", import.meta.url), "utf8")).not.toContain("pulse");
  });
});

describe("openRealtime", () => {
  function fakeSession(fallback = false): RealtimeSession & { started: number } {
    const s = {
      started: 0,
      current: "off" as RealtimePhase,
      on: false,
      capturing: false,
      playing: false,
      pendingApproval: null,
      fallbackOffer: fallback ? { error: "額度已用完", fallback: { session_id: "rt_b", owner: "own_b", route: "api_key" as const, model: "gpt-realtime", billing_line: "OpenAI API key 計費 · gpt-realtime", notice: "這次改用 OpenAI API key（依用量計費）：ChatGPT 方案額度已用完" } } : null,
      start: async () => void s.started++,
      stop() {}, interrupt() {}, sendText() {}, addContext() {}, notify() {}, setIdleMs() {}, resolveApproval() {},
    };
    return s;
  }

  it("speaks the auto notice before the session (and its mic) starts", async () => {
    const order: string[] = [];
    const session = fakeSession();
    await openRealtime({
      start: async () => ({ ok: true, session_id: "rt_a", owner: "own_a", route: "api_key", model: "gpt-realtime", billing_line: "OpenAI API key 計費 · gpt-realtime", notice: "這次改用 OpenAI API key（依用量計費）：ChatGPT 方案路徑尚未登入" }),
      makeSession: () => (order.push("make"), { ...session, start: async () => void order.push("start") }),
      announce: async (n) => void order.push(`announce:${n}`),
      refused: () => order.push("refused"),
      began: () => order.push("began"),
    });
    expect(order).toEqual(["announce:這次改用 OpenAI API key（依用量計費）：ChatGPT 方案路徑尚未登入", "make", "began", "start"]);
  });

  it("a live failure with a fallback offer: the live mic is already closed, so announce, then start the api_key session once", async () => {
    const order: string[] = [];
    const sessions = [fakeSession(true), fakeSession(false)];
    const result = await openRealtime({
      start: async () => ({ ok: true, session_id: "rt_a", owner: "own_a", route: "live", model: "gpt-live-1-codex", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex", notice: null }),
      makeSession: (d) => (order.push(`make:${d.route}`), sessions.shift()!),
      announce: async (n) => void order.push(`announce:${n}`),
      refused: () => order.push("refused"),
      began: (_s, d) => order.push(`began:${d.route}`),
    });
    expect(order).toEqual(["make:live", "began:live", "announce:這次改用 OpenAI API key（依用量計費）：ChatGPT 方案額度已用完", "make:api_key", "began:api_key"]);
    expect(result).not.toBeNull();
  });

  it("Esc / collapse / presence-leave during the start awaits cancels it: no session, no mic opened later", async () => {
    const decisionAuto = { ok: true as const, session_id: "rt_a", owner: "own_a", route: "api_key" as const, model: "gpt-realtime", billing_line: "b", notice: "通知" };
    for (const stage of ["start", "announce", "session", "fallback-announce"] as const) {
      const order: string[] = [];
      const abort = new AbortController();
      const sessions = [fakeSession(stage === "fallback-announce"), fakeSession(false)];
      const result = await openRealtime(
        {
          start: async () => {
            if (stage === "start") abort.abort();
            return stage === "fallback-announce" || stage === "session" ? { ...decisionAuto, route: "live", notice: null } : decisionAuto;
          },
          makeSession: (d) => {
            order.push(`make:${d.route}`);
            const s = sessions.shift()!;
            return {
              ...s,
              start: async () => {
                order.push(`start:${d.route}`);
                if (stage === "session") abort.abort();
              },
              stop: () => void order.push(`stop:${d.route}`),
            };
          },
          announce: async () => {
            order.push("announce");
            if (stage === "announce" || stage === "fallback-announce") abort.abort();
          },
          refused: () => order.push("refused"),
          began: (_s, d) => order.push(`began:${d.route}`),
        },
        abort.signal,
      );
      expect(result, stage).toBeNull();
      if (stage === "start") expect(order).toEqual([]);
      if (stage === "announce") expect(order).toEqual(["announce"]);
      // 已經開始的那個立刻停掉（麥克風關閉）；不會再開下一個。
      if (stage === "session") expect(order).toEqual(["make:live", "began:live", "start:live", "stop:live"]);
      if (stage === "fallback-announce") expect(order).toEqual(["make:live", "began:live", "start:live", "announce"]);
    }
  });

  it("refuses with the exact reasons when neither route works", async () => {
    const refused: string[] = [];
    await openRealtime({
      start: async () => ({ ok: false, message: "即時語音無法開始：ChatGPT 方案路徑尚未登入；未設定 OPENAI_API_KEY", reasons: {} }),
      makeSession: () => fakeSession(),
      announce: async () => {},
      refused: (m) => refused.push(m),
      began: () => {},
    });
    expect(refused).toEqual(["即時語音無法開始：ChatGPT 方案路徑尚未登入；未設定 OPENAI_API_KEY"]);
  });

  it("LiveVoice turns a FallbackOfferError into a silent teardown with fallbackOffer set", async () => {
    const offer = { error: "x", fallback: { session_id: "rt_b", owner: "own_b", route: "api_key" as const, model: "gpt-realtime", billing_line: "b", notice: "n" } };
    const t = setup({ exchange: async () => { throw new FallbackOfferError(offer); } });
    await t.voice.start();
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual([]);
    expect(t.voice.fallbackOffer).toEqual(offer);
    expect(t.track.stop).toHaveBeenCalled();
  });
});

describe("MEM-2: reliable stop on memory revocation (fixture peer and audio)", () => {
  function revocable() {
    vi.useFakeTimers();
    const order: string[] = [];
    const remote = { readyState: "live", stop() { this.readyState = "ended"; order.push("remote-track.stop"); } };
    class Peer extends FakePeer {
      getReceivers() { return [{ track: remote }]; }
      close() { order.push("peer.close"); this.connectionState = "closed"; super.close(); }
    }
    const peer = new Peer();
    const mic = { stop: () => void order.push("mic.stop"), readyState: "live" };
    let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
    let paused = false;
    const stopped: unknown[] = [];
    const revoked: { message: string; rebuild: boolean; accepted?: boolean }[] = [];
    const accept = { value: true };
    const spoken: string[] = [];
    const memory: LiveCoreEvent[] = [];
    const muted: boolean[] = [];
    const closed: string[] = [];
    let ended = 0;
    const deps: LiveDeps = {
      getMicrophone: async () => ({ getAudioTracks: () => [mic], getTracks: () => [mic] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      playRemote: () => () => { order.push("audio.pause+srcObject=null"); paused = true; },
      exchange: async () => "v=0 live-answer",
      input: async () => {},
      hostResult: async () => {},
      approval: async () => {},
      end: async () => void ended++,
      subscribe: (h) => { handlers = h; return () => (handlers = null); },
      watchLevel: () => () => {},
      setMuted: (m) => { muted.push(m); order.push(`muted:${m}`); },
      speak: (text) => void spoken.push(text),
      stopped: async (evidence) => { stopped.push(evidence); return accept.value; },
      audioPaused: () => paused,
      cancelSpeech: () => void order.push("speechSynthesis.cancel"),
      memoryEvent: (event) => void memory.push(event),
      revoked: (message, rebuild, accepted) => void revoked.push({ message, rebuild, accepted }),
    };
    const noop = async () => ({ ok: true });
    const voice = new LiveVoice({
      onPhase: () => {}, onUserTranscript: () => {}, onAssistantTranscript: () => {}, onDelegate: noop, onGetTasks: noop, onWebSearch: noop,
      onHomeStatus: noop, onHomeControl: noop as never, onHomeConfirm: noop as never, onApprovalPrompt: () => {}, onApprovalResolved: () => {}, onToolActivity: () => {}, onClosed: (r) => void closed.push(r),
    }, deps, { idleMs: 120_000 });
    const start = async () => {
      await voice.start();
      peer.ontrack?.({ streams: [{}] });
      peer.connect();
      handlers!.core({ kind: "started", expires_at: null });
    };
    const core = (event: LiveCoreEvent) => handlers?.core(event);
    return { voice, peer, order, stopped, revoked, spoken, memory, muted, closed, start, core, accept, ended: () => ended, subscribed: () => !!handlers };
  }

  it("mutes and pauses before closing the peer, stops remote tracks, never speaks the old content, reports evidence, then asks for one rebuild", async () => {
    const t = revocable();
    await t.start();
    t.core({ kind: "closed", reason: "memory_revoked", message: "記憶已更新，對話已重新開始", rebuild: true });
    await vi.runAllTimersAsync();
    expect(t.order.slice(0, 4)).toEqual(["muted:true", "audio.pause+srcObject=null", "remote-track.stop", "peer.close"]);
    expect(t.order).toContain("mic.stop");
    expect(t.order.at(-1)).toBe("speechSynthesis.cancel");
    expect(t.muted).toEqual([true]);
    expect(t.spoken).toEqual([]);
    expect(t.stopped).toEqual([{ paused: true, peer_closed: true, tracks_ended: true, ms: expect.any(Number) }]);
    expect(t.revoked).toEqual([{ message: "記憶已更新，對話已重新開始", rebuild: true, accepted: true }]);
    expect(t.voice.on).toBe(false);
    // 核心已經結束工作階段：頁面不再叫 end，也不走一般的 onClosed（不會說出原因）。
    expect(t.ended()).toBe(0);
    expect(t.closed).toEqual([]);
    // 舊工作階段的事件之後全部丟掉（不再訂閱），也不會重建第二次。
    expect(t.subscribed()).toBe(false);
    t.core({ kind: "closed", reason: "memory_revoked", message: "again", rebuild: true });
    t.core({ kind: "transcript", role: "assistant", text: "你喜歡藍色", final: true, item_id: "late" });
    await vi.runAllTimersAsync();
    expect(t.revoked).toHaveLength(1);
  });

  it("does not ask for a rebuild when the core did not accept the stop report (waits for the core's notice instead)", async () => {
    const t = revocable();
    t.accept.value = false;
    await t.start();
    t.core({ kind: "closed", reason: "memory_revoked", message: "記憶已更新，對話已重新開始", rebuild: true });
    await vi.runAllTimersAsync();
    expect(t.stopped).toHaveLength(1);
    expect(t.revoked).toEqual([{ message: "記憶已更新，對話已重新開始", rebuild: false, accepted: false }]);
  });

  it("a revocation that arrives after the page already left the call is still reported (no false route disable)", () => {
    const tickets = new Map([["rt_old", { session_id: "rt_old", owner: "own_x" }]]);
    const revoked = { session_id: "rt_old", event: { kind: "closed", reason: "memory_revoked", message: "m", rebuild: true } as LiveCoreEvent };
    expect(orphanStopReport(revoked, null, tickets, true)).toEqual({ ticket: { session_id: "rt_old", owner: "own_x" }, evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 0 } });
    // 還在這通上：交給 LiveVoice.revoke；其他事件或不認得的工作階段：不回報。
    expect(orphanStopReport(revoked, "rt_old", tickets, true)).toBeNull();
    expect(orphanStopReport({ ...revoked, session_id: "rt_unknown" }, null, tickets, true)).toBeNull();
    expect(orphanStopReport({ session_id: "rt_old", event: { kind: "closed", reason: "ended", message: "m" } }, null, tickets, true)).toBeNull();
  });

  it("OS lock ends without rebuild", async () => {
    const t = revocable();
    await t.start();
    t.core({ kind: "closed", reason: "memory_revoked", message: "即時語音已結束（電腦已鎖定）", rebuild: false });
    await vi.runAllTimersAsync();
    expect(t.revoked).toEqual([{ message: "即時語音已結束（電腦已鎖定）", rebuild: false, accepted: true }]);
  });

  it("hold mutes playback immediately and releases only when the core says so", async () => {
    const t = revocable();
    await t.start();
    t.core({ kind: "hold", active: true });
    expect(t.muted).toEqual([true]);
    t.core({ kind: "hold", active: false });
    expect(t.muted).toEqual([true, false]);
  });

  it("forwards memory events (ids, counts and fixed sentences only) to the page", async () => {
    const t = revocable();
    await t.start();
    t.core({ kind: "memory", used: 2, reason: null, epoch: 3 });
    t.core({ kind: "memory_card", card: "mc_000000000000000000000001", open: true });
    t.core({ kind: "delegate_blocked", title: "幫我寫一份晚餐菜單報告" });
    expect(t.memory.map((e) => e.kind)).toEqual(["memory", "memory_card", "delegate_blocked"]);
  });
});

describe("MEM-2: openRealtime rebuild", () => {
  it("a rebuild start goes to the core once with rebuild:true and no greeting; no API key fallback is offered", async () => {
    const starts: unknown[] = [];
    const began: string[] = [];
    const session = { start: async () => {}, stop: () => {}, fallbackOffer: null } as unknown as RealtimeSession;
    const result = await openRealtime({
      start: async () => { starts.push({ rebuild: true }); return { ok: true, session_id: "rt_1", owner: "own_x", route: "live", model: "m", billing_line: "b", notice: null, interaction: null }; },
      makeSession: () => session,
      announce: async () => {},
      refused: () => {},
      began: (_s, d) => void began.push(d.route),
    });
    expect(result).toBe(session);
    expect(starts).toEqual([{ rebuild: true }]);
    expect(began).toEqual(["live"]);
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("const greeting = rebuild ? null : greetingFor(");
    expect(main).toContain("api.realtimeStart(sseClientId, source, realtimeLocale, rebuild)");
  });
});
