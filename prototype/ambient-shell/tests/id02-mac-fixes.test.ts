import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCall, LiveCoreEvent, LiveInputKind } from "../shared/realtime-route.ts";
import { GREETING_PLAIN, greetingInstructions, strictGreetingInstructions } from "../shared/sense.ts";
import { CONNECTING_SPEECH_HINT, EARLY_SPEECH_ON_MS, EARLY_SPEECH_RMS, EarlySpeech, earlySpeechLogLine } from "../src/early-speech.ts";
import { loadConfig } from "../server/config.ts";
import { LiveVoice, type LiveDeps } from "../src/live-voice.ts";
import { greetingResponse, RealtimeVoice, type RealtimeCallbacks, type RealtimeCoreDeps, type RealtimeDeps } from "../src/realtime.ts";
import { GREETING_SETTLE_MS, GreetingOnce } from "../src/realtime-session.ts";
import en from "../src/messages.en.json" with { type: "json" };

// ID-02 Mac 驗收（2026-10-31）發現的 F1、F2、F7、F10 的頁面端修正。假的 WebRTC、假的麥克風音量、假的核心，全部是 fixture：
// 證明的是「什麼時候送出（或不送）哪個事件」，不是模型真的照念、或門檻在 George 家中合適（那要在 Mac 上重測）。
// 時間只用假時鐘推進，不比較牆上時間。

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function callbacks(record: { activity: string[]; delegated: string[]; searches: ReturnType<typeof deferred<Record<string, unknown>>>[] }): RealtimeCallbacks {
  return {
    onPhase: () => {},
    onUserTranscript: () => {},
    onAssistantTranscript: () => {},
    onDelegate: async (title) => (record.delegated.push(title), { ok: true, title, status: "running" }),
    onGetTasks: async () => ({ ok: true, tasks: [] }),
    onWebSearch: async () => {
      const d = deferred<Record<string, unknown>>();
      record.searches.push(d);
      return d.promise;
    },
    onHomeStatus: async () => ({ ok: true }),
    onHomeControl: async () => ({ ok: false, error: "fixture" }),
    onHomeConfirm: async () => ({ ok: false, error: "fixture" }),
    onApprovalPrompt: () => {},
    onApprovalResolved: () => {},
    onToolActivity: (text) => void record.activity.push(text),
    onClosed: () => {},
  };
}

/** 假的麥克風：記下交給 watchLevel 的串流；level() 模擬本機音量（每 50 ms 一格）。 */
function fakeMic() {
  const track = { stop: vi.fn(), readyState: "live" };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const watchers = new Map<MediaStream, (rms: number) => void>();
  const seen: unknown[] = [];
  const watchLevel = (s: MediaStream, onLevel: (rms: number) => void) => {
    watchers.set(s, onLevel);
    return () => void watchers.delete(s);
  };
  /** 本機麥克風持續 ms 毫秒的音量（只有數字：fixture 不產生任何聲音樣本）。 */
  const level = (rms: number, ms: number) => {
    for (let t = 0; t <= ms; t += 50) {
      seen.push(rms);
      watchers.get(stream)?.(rms);
      vi.advanceTimersByTime(50);
    }
  };
  return { stream, watchLevel, level, watching: () => watchers.has(stream), seen };
}

function apiKey(options: { greeting?: GreetingOnce | null; exchange?: Promise<string>; core?: Partial<RealtimeCoreDeps>; earlySpeechRms?: number } = {}) {
  vi.useFakeTimers();
  const peer = new FakePeer();
  const mic = fakeMic();
  const record = { activity: [] as string[], delegated: [] as string[], searches: [] as ReturnType<typeof deferred<Record<string, unknown>>>[] };
  let stopReplies = 0;
  const core: RealtimeCoreDeps | undefined = options.core
    ? {
        subscribe: () => () => {},
        hostResult: async () => {},
        approval: async () => {},
        stopped: async () => true,
        playback: async () => {},
        setMuted: () => {},
        audioPaused: () => true,
        cancelSpeech: () => {},
        speak: () => {},
        memoryEvent: () => {},
        revoked: () => {},
        coreTools: () => [],
        stopReply: async () => void stopReplies++,
        ...options.core,
      }
    : undefined;
  const deps: RealtimeDeps = {
    getMicrophone: async () => mic.stream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: () => options.exchange ?? Promise.resolve("v=0 fake-answer"),
    watchLevel: mic.watchLevel,
    ...(core ? { core } : {}),
  };
  const voice = new RealtimeVoice(callbacks(record), deps, { idleMs: 120_000, greeting: options.greeting ?? null, ...(options.earlySpeechRms !== undefined ? { earlySpeechRms: options.earlySpeechRms } : {}) });
  const ch = peer.channel;
  const responses = () => ch.events.filter((e) => e.type === "response.create");
  return { voice, peer, ch, mic, record, responses, stopReplies: () => stopReplies };
}

function live(options: { greeting?: GreetingOnce | null; exchange?: Promise<string> } = {}) {
  vi.useFakeTimers();
  const peer = new FakePeer();
  const mic = fakeMic();
  const record = { activity: [] as string[], delegated: [] as string[], searches: [] as ReturnType<typeof deferred<Record<string, unknown>>>[] };
  const inputs: { kind: LiveInputKind; text: string }[] = [];
  const muted: boolean[] = [];
  let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
  let stopReplies = 0;
  let ended = 0;
  const deps: LiveDeps = {
    getMicrophone: async () => mic.stream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: () => options.exchange ?? Promise.resolve("v=0 live-answer"),
    input: async (kind, text) => void inputs.push({ kind, text }),
    hostResult: async () => {},
    approval: async () => {},
    end: async () => void ended++,
    subscribe: (h) => {
      handlers = h;
      return () => (handlers = null);
    },
    watchLevel: mic.watchLevel,
    setMuted: (m) => void muted.push(m),
    speak: () => {},
    stopReply: async () => void stopReplies++,
  };
  const voice = new LiveVoice(callbacks(record), deps, { idleMs: 120_000, greeting: options.greeting ?? null });
  const ready = async () => {
    peer.connect();
    peer.channel.emit({ type: "session.started", session: {} });
    await flush();
  };
  return { voice, peer, mic, record, inputs, muted, ready, greetings: () => inputs.filter((i) => i.kind === "greeting"), core: (e: LiveCoreEvent) => handlers!.core(e), stopReplies: () => stopReplies, ended: () => ended };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("F2: speech while 「連線中」 cancels the greeting and asks to say it again (local level only)", () => {
  it("EarlySpeech needs sustained level above the threshold; a short knock or quiet room is not speech", () => {
    let now = 0;
    const d = new EarlySpeech(() => now);
    for (let t = 0; t < EARLY_SPEECH_ON_MS; t += 50, now += 50) expect(d.feed(EARLY_SPEECH_RMS / 2)).toBe(false);
    // 一聲短響：不到 EARLY_SPEECH_ON_MS 就斷掉。
    expect(d.feed(0.5)).toBe(false);
    now += 100;
    expect(d.feed(0.001)).toBe(false);
    for (let t = 0; t < EARLY_SPEECH_ON_MS; t += 50, now += 50) expect(d.feed(0.08)).toBe(false);
    expect(d.feed(0.08)).toBe(true);
    expect(d.detected).toBe(true);
    expect(d.feed(0.08)).toBe(false); // 只回報一次
    // 只留數字狀態：沒有任何聲音樣本被保存。
    for (const value of Object.values(d)) expect(["number", "boolean", "function", "object"]).toContain(typeof value);
    for (const value of Object.values(d)) if (typeof value === "object") expect(value).toBeNull();
  });

  it("API key: talking during connecting skips the greeting and shows the bilingual hint; nothing is sent for that speech", async () => {
    const answer = deferred<string>();
    const greeting = new GreetingOnce();
    const t = apiKey({ greeting, exchange: answer.promise });
    const started = t.voice.start();
    await flush();
    expect(t.voice.current).toBe("connecting");
    expect(t.mic.watching()).toBe(true);
    t.mic.level(0.1, EARLY_SPEECH_ON_MS + 100);
    expect(greeting.state).toBe("skipped");
    expect(t.record.activity).toEqual([CONNECTING_SPEECH_HINT]);
    expect(t.mic.watching()).toBe(false); // 判斷完就停止看音量
    answer.resolve("v=0 fake-answer");
    await started;
    t.ch.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS * 3);
    expect(t.responses()).toEqual([]);
    // 不代為猜內容：資料通道上沒有任何使用者項目或音訊。
    expect(t.ch.events.map((e) => e.type)).toEqual([]);
  });

  it("ChatGPT plan: same — no greeting input reaches the core, the hint is shown once", async () => {
    const answer = deferred<string>();
    const greeting = new GreetingOnce();
    const t = live({ greeting, exchange: answer.promise });
    const started = t.voice.start();
    await flush();
    expect(t.voice.current).toBe("connecting");
    t.mic.level(0.1, EARLY_SPEECH_ON_MS + 100);
    t.mic.level(0.1, EARLY_SPEECH_ON_MS + 100);
    expect(t.record.activity).toEqual([CONNECTING_SPEECH_HINT]);
    answer.resolve("v=0 live-answer");
    await started;
    await t.ready();
    expect(t.voice.current).toBe("listening");
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS * 3);
    expect(t.greetings()).toEqual([]);
    expect(t.inputs).toEqual([]);
  });

  it("a quiet room while connecting still greets once; the level watcher stops once the greeting is sent (its echo cannot cancel anything)", async () => {
    const answer = deferred<string>();
    const greeting = new GreetingOnce();
    const t = apiKey({ greeting, exchange: answer.promise });
    const started = t.voice.start();
    await flush();
    t.mic.level(0.005, 2_000);
    answer.resolve("v=0 fake-answer");
    await started;
    t.ch.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS);
    await flush();
    expect(t.responses()).toHaveLength(1);
    expect(greeting.state).toBe("sent");
    t.mic.level(0.2, 1_000); // 招呼本身的回音
    expect(t.mic.watching()).toBe(false);
    expect(t.record.activity).toEqual([]);
  });

  it("a session without a greeting (button start) only shows the hint while connecting and stops watching once listening", async () => {
    const answer = deferred<string>();
    const t = live({ exchange: answer.promise });
    const started = t.voice.start();
    await flush();
    answer.resolve("v=0 live-answer");
    await started;
    await t.ready();
    t.mic.level(0.2, 1_000);
    expect(t.record.activity).toEqual([]);
    expect(t.mic.watching()).toBe(false);
  });

  it("the hint is in the shared translation table; the detector never stores, logs or sends audio", () => {
    expect(CONNECTING_SPEECH_HINT).toBe("還在連線，請稍後再說一次");
    expect((en as Record<string, string>)[CONNECTING_SPEECH_HINT]).toBe("Still connecting — please say it again");
    const source = readFileSync(join(import.meta.dirname, "../src/early-speech.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/localStorage|indexedDB|fetch\(|writeFile|console\.|postMessage|MediaRecorder|Float32Array|push\(/);
  });
});

describe("F10: the ChatGPT-plan route cancels the greeting when the user speaks first", () => {
  it("speech_started on the data channel after voice-ready but before the decision → no greeting", async () => {
    const greeting = new GreetingOnce();
    const t = live({ greeting });
    await t.voice.start();
    await t.ready();
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS / 3);
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS * 3);
    expect(greeting.state).toBe("skipped");
    expect(t.greetings()).toEqual([]);
    expect(t.voice.current).toBe("hearing");
  });

  it("the race inside the ~0.6 s settle window: the local level catches speech that has no upstream event yet", async () => {
    const greeting = new GreetingOnce();
    const t = live({ greeting });
    await t.voice.start();
    await t.ready();
    expect(greeting.state).toBe("pending");
    t.mic.level(0.1, EARLY_SPEECH_ON_MS + 50); // 在 GREETING_SETTLE_MS 之內
    expect(greeting.state).toBe("skipped");
    expect(t.record.activity).toEqual([]); // 聲音已經送到伺服器：不提示再說一次
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS * 3);
    expect(t.greetings()).toEqual([]);
  });

  it("speech during the decision (take() already asking the core) also drops the greeting", async () => {
    const decision = deferred<string>();
    const greeting = new GreetingOnce(() => true, { interaction: "int_0123456789abcdef", decide: () => decision.promise });
    const t = live({ greeting });
    await t.voice.start();
    await t.ready();
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS);
    expect(greeting.state).toBe("deciding");
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    decision.resolve("int_0123456789abcdef");
    await flush();
    expect(t.greetings()).toEqual([]);
  });
});

describe("F7: a palm stop drops this turn's late tool result on both routes; tasks are not cancelled", () => {
  it("API key: cancels the reply; the late web_search result is handed back silently (no response.create); a delegated task still runs; later notices still speak", async () => {
    const t = apiKey({ core: {} });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    // 使用者問天氣：模型說「我查一下」，同時呼叫 web_search 與 delegate_task。
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "call_search", arguments: JSON.stringify({ query: "新竹天氣" }) });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_task", arguments: JSON.stringify({ title: "整理週報" }) });
    t.ch.emit({ type: "output_audio_buffer.started" });
    await flush();
    expect(t.voice.current).toBe("speaking");
    const before = t.ch.events.length;

    t.voice.stopReply();
    expect(t.ch.events.slice(before).map((e) => e.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(t.stopReplies()).toBe(1);
    expect(t.voice.on).toBe(true); // 不結束對話
    t.ch.emit({ type: "response.done" });
    t.ch.emit({ type: "output_audio_buffer.cleared" });
    await flush();

    t.record.searches[0]!.resolve({ ok: true, answer: "多雲（fixture）" });
    await flush();
    const outputs = t.ch.events.filter((e) => e.type === "conversation.item.create" && (e.item as { type: string }).type === "function_call_output");
    expect(outputs.map((e) => (e.item as { call_id: string }).call_id).sort()).toEqual(["call_search", "call_task"]);
    expect(t.responses()).toEqual([]); // 沒有請模型念出
    expect(t.record.delegated).toEqual(["整理週報"]); // 背景任務照常交辦，沒有被取消

    // 被取消那一輪晚到的工具呼叫（cancel 之前已在路上）也不會排接續回應。
    t.ch.emit({ type: "response.function_call_arguments.done", name: "get_tasks", call_id: "call_late", arguments: "{}" });
    await flush();
    expect(t.responses()).toEqual([]);

    // 之後的系統通知（例如任務完成）不屬於那一輪：照常轉告。
    t.voice.notify("任務「整理週報」完成了");
    expect(t.responses()).toHaveLength(1);
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.done" });

    // 使用者再開口是新的一輪：新的工具結果照常念出。
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "call_search2", arguments: JSON.stringify({ query: "台北天氣" }) });
    t.ch.emit({ type: "response.done" });
    t.record.searches[1]!.resolve({ ok: true, answer: "晴（fixture）" });
    await flush();
    expect(t.responses()).toHaveLength(2);
  });

  it("ChatGPT plan: mutes the reply and tells the core (which turns the late result into silent commentary); the call keeps going", async () => {
    const t = live();
    await t.voice.start();
    await t.ready();
    t.core({ kind: "delegation", id: "del_1", state: "started" });
    expect(t.voice.current).toBe("thinking");
    // 「我查一下」念到一半舉手。
    t.peer.ontrack?.({ streams: [{}] });
    t.voice.stopReply();
    expect(t.stopReplies()).toBe(1);
    expect(t.ended()).toBe(0);
    expect(t.voice.on).toBe(true);
    expect(t.inputs).toEqual([]); // 頁面不送任何內容給模型
  });

  it("a palm stop while connecting or off does nothing here (main.ts ends a connecting session instead)", async () => {
    const answer = deferred<string>();
    const t = live({ exchange: answer.promise });
    t.voice.stopReply();
    const started = t.voice.start();
    await flush();
    t.voice.stopReply();
    expect(t.stopReplies()).toBe(0);
    answer.resolve("v=0 live-answer");
    await started;
  });

  it("main.ts routes the palm gesture to stopReply while speaking or thinking, never to stop/cancel a task", () => {
    const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
    const hook = main.slice(main.indexOf("interruptSpeech: () => {"), main.indexOf("onLeave: () => {"));
    expect(hook).toContain('realtime.current === "speaking" || realtime.current === "thinking") realtime.stopReply();');
    expect(hook).not.toMatch(/cancelTask|task\.cancel|stopTask/);
  });
});

describe("F1: the API key greeting request carries the strict wording (request snapshot)", () => {
  it("the response.create the page sends is exactly greetingResponse(strict instructions): audio only, no tools", async () => {
    const instructions = strictGreetingInstructions("George，我在。");
    const greeting = new GreetingOnce(() => true, { decide: async () => instructions });
    const t = apiKey({ greeting });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS);
    await flush();
    expect(t.responses()).toEqual([{ type: "response.create", event_id: "greet_1", response: greetingResponse(instructions) }]);
    expect(t.responses()).toMatchInlineSnapshot(`
      [
        {
          "event_id": "greet_1",
          "response": {
            "instructions": "你是 Nous。這一輪不是使用者的請求，不需要回應、也不需要確認收到：你說出的全部內容，就是下面「」裡的那一句本身。請用繁體中文只說這一句，一字不改：「George，我在。」。前後都不要加任何字：不要說「好的」「我明白了」「我會照您說的來」，也不要加開場白、說明或提問；不要換成別的句子；說完這一句就停。你看不到畫面：不要說看到使用者，也不要提到長相、表情、穿著或周遭環境；除了這一句裡已有的名字，不要說出或猜測任何名字。",
            "output_modalities": [
              "audio",
            ],
            "tool_choice": "none",
          },
          "type": "response.create",
        },
      ]
    `);
  });

  it("strict wording in both languages; the ChatGPT-plan text is unchanged and still one ≤500-byte append", () => {
    const zh = strictGreetingInstructions("George，我在。");
    for (const phrase of ["這一輪不是使用者的請求", "只說這一句，一字不改", "「George，我在。」", "不要說「好的」「我明白了」「我會照您說的來」", "不要換成別的句子", "說完這一句就停", "不要說看到使用者"]) expect(zh).toContain(phrase);
    const enText = strictGreetingInstructions("George, I'm here.", "en");
    for (const phrase of ["not a user request", "exactly the one English sentence", "「George, I'm here.」", "I'll do as you say", "Do not replace it", "Stop right after it", "Do not claim to see"]) expect(enText).toContain(phrase);
    expect(Buffer.byteLength(`（開場）${greetingInstructions(GREETING_PLAIN)}`)).toBeLessThanOrEqual(500);
    expect(greetingInstructions(GREETING_PLAIN)).not.toContain("這一輪不是使用者的請求");
  });
});

describe("ID-02 review follow-ups (2026-10-31)", () => {
  it("minor 5：NOUS_EARLY_SPEECH_RMS is validated to 0.005–0.3; NOUS_PALM_QUIET_DELEGATION defaults off", () => {
    expect(loadConfig({}).earlySpeechRms).toBeNull();
    expect(loadConfig({ NOUS_EARLY_SPEECH_RMS: "0.05" }).earlySpeechRms).toBe(0.05);
    for (const bad of ["0", "0.001", "0.5", "loud", "-1"]) expect(() => loadConfig({ NOUS_EARLY_SPEECH_RMS: bad })).toThrow(/NOUS_EARLY_SPEECH_RMS/);
    expect(loadConfig({}).palmQuietDelegation).toBe(false);
    expect(loadConfig({ NOUS_PALM_QUIET_DELEGATION: "on" }).palmQuietDelegation).toBe(true);
  });

  it("minor 5：the threshold override reaches the page detector; the one log line has only the event, phase and peak RMS", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const answer = deferred<string>();
    const greeting = new GreetingOnce();
    const t = apiKey({ greeting, exchange: answer.promise, earlySpeechRms: 0.2 });
    const started = t.voice.start();
    await flush();
    t.mic.level(0.1, 1_000); // 低於覆寫的門檻
    expect(greeting.state).toBe("pending");
    t.mic.level(0.25, EARLY_SPEECH_ON_MS + 100);
    expect(greeting.state).toBe("skipped");
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[early-speech]"));
    expect(lines).toEqual([earlySpeechLogLine("connecting", 0.25)]);
    expect(lines[0]).toBe("[early-speech] detected phase=connecting peak_rms=0.250");
    info.mockRestore();
    answer.resolve("v=0 fake-answer");
    await started;
  });

  it("minor 4a：a palm while thinking before response.created cancels the next untagged response when it is created; a new user turn clears it", async () => {
    const t = apiKey({ core: {} });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    expect(t.voice.current).toBe("thinking");
    t.voice.stopReply();
    const before = t.ch.events.length;
    t.ch.emit({ type: "response.created", response: { id: "resp_vad" } });
    expect(t.ch.events.slice(before)).toEqual([{ type: "response.cancel", response_id: "resp_vad" }, { type: "output_audio_buffer.clear" }]);
    // 被取消的那個回應晚到的工具呼叫：只交回、不念。
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "call_late", response_id: "resp_vad", arguments: JSON.stringify({ query: "x" }) });
    t.ch.emit({ type: "response.done", response: { id: "resp_vad" } });
    t.record.searches[0]!.resolve({ ok: true });
    await flush();
    expect(t.responses()).toEqual([]);
    // 新的一輪：不再取消。
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    const after = t.ch.events.length;
    t.ch.emit({ type: "response.created", response: { id: "resp_next" } });
    expect(t.ch.events.slice(after)).toEqual([]);
  });

  it("minor 4b：a late function call from the cancelled response is silent even after the user already spoke again (decided by response_id)", async () => {
    const t = apiKey({ core: {} });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created", response: { id: "resp_1" } });
    t.ch.emit({ type: "output_audio_buffer.started" });
    t.voice.stopReply();
    t.ch.emit({ type: "input_audio_buffer.speech_started" }); // 使用者說「停」
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "call_old", response_id: "resp_1", arguments: JSON.stringify({ query: "新竹天氣" }) });
    t.ch.emit({ type: "response.done", response: { id: "resp_1" } });
    t.record.searches[0]!.resolve({ ok: true, answer: "多雲（fixture）" });
    await flush();
    expect(t.responses()).toEqual([]);
    // 新回應的工具照常念。
    t.ch.emit({ type: "response.created", response: { id: "resp_2" } });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "call_new", response_id: "resp_2", arguments: JSON.stringify({ query: "台北天氣" }) });
    t.ch.emit({ type: "response.done", response: { id: "resp_2" } });
    t.record.searches[1]!.resolve({ ok: true, answer: "晴（fixture）" });
    await flush();
    expect(t.responses()).toHaveLength(1);
  });

  it("minor 4c：answering a confirmation card after the palm is a new turn (resolveApproval said_* clears the stop)", async () => {
    const t = apiKey({ core: {} });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.voice.stopReply();
    t.voice.resolveApproval(true, "said_approve");
    const before = t.ch.events.length;
    t.ch.emit({ type: "response.created", response: { id: "resp_after_confirm" } });
    expect(t.ch.events.slice(before)).toEqual([]); // 沒有被取消
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "c", arguments: JSON.stringify({ query: "x" }) });
    t.ch.emit({ type: "response.done", response: { id: "resp_after_confirm" } });
    t.record.searches[0]!.resolve({ ok: true });
    await flush();
    expect(t.responses()).toHaveLength(1);
  });

  it("minor 6：if upstream rejects output_modalities/tool_choice on the greeting, it is resent once with only instructions and warned once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instructions = strictGreetingInstructions("我在");
    const greeting = new GreetingOnce(() => true, { decide: async () => instructions });
    const t = apiKey({ greeting });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS);
    await flush();
    expect(t.responses()).toHaveLength(1);
    t.ch.emit({ type: "error", error: { code: "unknown_parameter", param: "response.tool_choice", event_id: "greet_1", message: "x" } });
    expect(t.responses().at(-1)).toEqual({ type: "response.create", event_id: "greet_2", response: { instructions } });
    // 第二次被拒絕不再重送。
    t.ch.emit({ type: "error", error: { code: "unknown_parameter", param: "response.output_modalities", event_id: "greet_2", message: "x" } });
    expect(t.responses()).toHaveLength(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("問候的 response.create 參數被拒絕"))).toHaveLength(1);
    // 其他錯誤（不是這個 event_id 或不是這些參數）不重送。
    warn.mockRestore();
  });

  it("minor 6：an unrelated error for the greeting is not retried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const greeting = new GreetingOnce(() => true, { decide: async () => strictGreetingInstructions("我在") });
    const t = apiKey({ greeting });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(GREETING_SETTLE_MS);
    await flush();
    t.ch.emit({ type: "error", error: { code: "rate_limit", param: "response.instructions", event_id: "greet_1", message: "x" } });
    expect(t.responses()).toHaveLength(1);
    warn.mockRestore();
  });
});
