import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUE_TIMING, ProcessingCue, processingSource, type CueSound, type ProcessingInput } from "../src/processing-cue.ts";
import { browserProcessingSound, gainToDb, PING_SPEC } from "../src/processing-sound.ts";
import { SPEECH_TAIL_MS } from "../src/audio/guard.ts";
import { makeTask } from "./fixtures.ts";

// 背景處理中的提示（George 2026-11-02；docs/validation/brain-processing-cue-2026-11-02.md）：
// 來源只有真的在執行的任務與還沒回來的即時語音查詢；聲音的時間窗、重新出聲限制、每個任務上限、暫停與停止。
// 假時鐘（vi.useFakeTimers）與假 AudioContext；真的聽得到與否要在 Mac 上確認。

const RUNNING: ProcessingInput = { owners: ["task:a"], enabled: true, callOn: false, speaking: false, capturing: false, hidden: false };

function harness(options: { suspended?: () => boolean } = {}) {
  const log: string[] = [];
  const rings: number[] = [];
  const guard = { begun: 0, ended: 0 };
  let sounds = 0;
  const cue = new ProcessingCue({
    clock: { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
    createSound: (): CueSound => {
      const n = ++sounds;
      return {
        resume: () => log.push(`resume#${n}`),
        ping: () => {
          if (options.suspended?.()) {
            log.push(`skip#${n}`);
            return false;
          }
          log.push(`ping#${n}`);
          return true;
        },
        pause: () => log.push(`pause#${n}`),
        stop: () => log.push(`stop#${n}`),
      };
    },
    guard: { begin: () => guard.begun++, end: () => guard.ended++ },
    onPing: () => rings.push(Date.now()),
  });
  const pings = () => log.filter((e) => e.startsWith("ping")).length;
  return { cue, log, guard, pings, rings, sounds: () => sounds };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("processingSource: only real running work", () => {
  const on = { tasks: [], searches: [], connected: true, callOn: true };

  it("counts running tasks and in-flight realtime searches; queued, cancelling and finished tasks do not count", () => {
    const tasks = [
      makeTask({ task_id: "run", status: "running" }),
      ...(["queued", "cancelling", "cancelled", "failed", "succeeded"] as const).map((status) => makeTask({ task_id: status, status })),
    ];
    expect(processingSource({ ...on, tasks })).toEqual(["task:run"]);
    expect(processingSource({ ...on, tasks: tasks.slice(1) })).toEqual([]);
    // 每一次查詢有自己遞增的編號（不是計數值）
    expect(processingSource({ ...on, searches: new Set([7, 9]) })).toEqual(["search:7", "search:9"]);
    expect(processingSource(on)).toEqual([]);
  });

  it("while the core connection is down, (possibly stale) tasks do not count; searches count only while the call is on", () => {
    const tasks = [makeTask({ task_id: "run", status: "running" })];
    expect(processingSource({ ...on, tasks, connected: false, searches: [1] })).toEqual(["search:1"]);
    expect(processingSource({ ...on, tasks, connected: false, callOn: false, searches: [1] })).toEqual([]);
    expect(processingSource({ ...on, tasks, callOn: false, searches: [1] })).toEqual(["task:run"]);
    expect(CUE_TIMING.searchTimeoutMs).toBe(30_000);
  });
});

describe("ProcessingCue: when the sonar pings", () => {
  it("nothing running: no sound object, no ping, not active", () => {
    const h = harness();
    h.cue.update({ ...RUNNING, owners: [] });
    vi.advanceTimersByTime(60_000);
    expect(h.cue.active).toBe(false);
    expect(h.sounds()).toBe(0);
    expect(h.log).toEqual([]);
  });

  it("episode start: pings every 2.4 s for the first 20 s (9 pings), then visual only", () => {
    const h = harness();
    h.cue.update(RUNNING);
    expect(h.log).toEqual(["resume#1", "ping#1"]);
    vi.advanceTimersByTime(CUE_TIMING.episodeWindowMs);
    // 0, 2.4, …, 19.2 秒：floor(20 / 2.4) + 1 = 9
    expect(h.pings()).toBe(Math.floor(CUE_TIMING.episodeWindowMs / CUE_TIMING.pingIntervalMs) + 1);
    expect(h.pings()).toBe(9);
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(9);
    expect(h.log.at(-1)).toBe("pause#1");
    expect(h.cue.active).toBe(true);
    expect(h.cue.quiet()).toBe("window");
  });

  it("a new running step re-arms 6 s (3 pings), at most once per 15 s", () => {
    const h = harness();
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(9);
    h.cue.rearm(); // t = 30 s → 6 s window: 30, 32.4, 34.8
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(12);
    h.cue.rearm(); // t = 40 s, only 10 s after the last re-arm: ignored
    vi.advanceTimersByTime(5_000);
    expect(h.pings()).toBe(12);
    h.cue.rearm(); // t = 45 s ≥ 30 + 15: accepted
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(15);
    // 同一個 AudioContext（一段處理一份）
    expect(h.sounds()).toBe(1);
  });

  it("a re-arm inside the episode window does not extend it or use up the 15 s allowance", () => {
    const h = harness();
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(5_000);
    h.cue.rearm(); // 5 + 6 < 20: nothing to extend
    vi.advanceTimersByTime(17_000); // t = 22 (window closed at 20, paused at the 21.6 s tick)
    expect(h.cue.quiet()).toBe("window");
    h.cue.rearm(); // accepted (the earlier one did not count)
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(9 + 3);
  });

  it("another task starting mid-episode gets its own 20 s start window, outside the 15 s re-arm limit", () => {
    const h = harness();
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(22_000);
    h.cue.rearm(); // t = 22: re-arm used
    vi.advanceTimersByTime(8_000); // t = 30
    expect(h.pings()).toBe(9 + 3);
    h.cue.update({ ...RUNNING, owners: ["task:a", "task:b"] }); // only 8 s after the re-arm
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(12 + 9);
    // 查詢（只在通話中）不給時間窗
    h.cue.update({ ...RUNNING, owners: ["task:a", "task:b", "search:3"] });
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(21);
  });

  it("two tasks: one at its 60 s cap, a new one starting inside the 15 s gap still pings for its own window", () => {
    const h = harness();
    h.cue.update(RUNNING);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(CUE_TIMING.rearmMinGapMs);
      h.cue.rearm();
    }
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(25);
    h.cue.rearm(); // t = now: last accepted re-arm long ago, but task:a is capped → no sound
    vi.advanceTimersByTime(5_000);
    expect(h.pings()).toBe(25);
    expect(h.cue.quiet()).toBe("cap");
    h.cue.update({ ...RUNNING, owners: ["task:a", "task:b"] }); // 5 s after a re-arm
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(25 + 9);
  });

  it("caps each task at 60 s of pings (25 pings), then visual only even when steps keep starting", () => {
    const h = harness();
    h.cue.update(RUNNING);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(CUE_TIMING.rearmMinGapMs);
      h.cue.rearm();
    }
    vi.advanceTimersByTime(30_000);
    // 每一響記 2.4 秒：0, 2.4, …, 57.6 秒的累計都還在 60 秒以內
    expect(h.pings()).toBe(Math.ceil(CUE_TIMING.taskCapMs / CUE_TIMING.pingIntervalMs));
    expect(h.pings()).toBe(25);
    h.cue.rearm();
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(25);
    expect(h.cue.active).toBe(true);
    // 新的任務有自己的額度與開始時間窗
    h.cue.update({ ...RUNNING, owners: ["task:a", "task:b"] });
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(25 + 9);
  });

  it("stops when nothing is running any more (and starts a fresh episode with a fresh 20 s next time)", () => {
    const h = harness();
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(3_000);
    h.cue.update({ ...RUNNING, owners: [] });
    expect(h.log.at(-1)).toBe("stop#1");
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(2);
    h.cue.update({ ...RUNNING, owners: ["task:z"] });
    expect(h.log.slice(-2)).toEqual(["resume#2", "ping#2"]);
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(2 + 9);
  });

  it("toggle off: no sound (the AudioContext is closed), the brain stays active; on again resumes inside the window", () => {
    const h = harness();
    h.cue.update({ ...RUNNING, enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(h.sounds()).toBe(0);
    expect(h.cue.active).toBe(true);
    expect(h.cue.quiet()).toBe("off");
    h.cue.update(RUNNING);
    expect(h.pings()).toBe(1);
    h.cue.update({ ...RUNNING, enabled: false });
    expect(h.log.slice(-2)).toEqual(["pause#1", "stop#1"]);
    vi.advanceTimersByTime(30_000);
    expect(h.pings()).toBe(1);
  });

  it.each([
    ["callOn", "call"],
    ["capturing", "capturing"],
    ["hidden", "hidden"],
  ] as const)("pauses while %s (visual only), resumes when it ends inside the window", (key, reason) => {
    const h = harness();
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(3_000); // 2 pings
    h.cue.update({ ...RUNNING, [key]: true });
    expect(h.log.at(-1)).toBe("pause#1");
    expect(h.cue.quiet()).toBe(reason);
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(2);
    expect(h.cue.active).toBe(true);
    h.cue.update(RUNNING); // t = 13 s
    expect(h.log.slice(-2)).toEqual(["resume#1", "ping#1"]);
    vi.advanceTimersByTime(10_000); // 13, 15.4, 17.8 (20.2 is past the window)
    expect(h.pings()).toBe(5);
  });

  it("resuming after a short pause waits until 2.4 s after the last ping (no double ping)", () => {
    const h = harness();
    h.cue.update(RUNNING); // ping at 0
    vi.advanceTimersByTime(1_000);
    h.cue.update({ ...RUNNING, capturing: true });
    vi.advanceTimersByTime(500);
    h.cue.update(RUNNING); // t = 1.5 s
    expect(h.pings()).toBe(1);
    vi.advanceTimersByTime(899);
    expect(h.pings()).toBe(1);
    vi.advanceTimersByTime(1); // t = 2.4 s
    expect(h.pings()).toBe(2);
    vi.advanceTimersByTime(2_400);
    expect(h.pings()).toBe(3);
  });

  it("a suspended AudioContext: no ring, no wake guard, no cap usage until it really sounds", () => {
    let suspended = true;
    const h = harness({ suspended: () => suspended });
    h.cue.update(RUNNING);
    vi.advanceTimersByTime(10_000);
    expect(h.pings()).toBe(0);
    expect(h.rings).toEqual([]);
    expect(h.guard).toEqual({ begun: 0, ended: 0 });
    expect(h.cue.pingCount).toBe(0);
    suspended = false;
    vi.advanceTimersByTime(10_000); // window ends at 20 s: 12, 14.4, 16.8, 19.2
    expect(h.pings()).toBe(4);
    expect(h.rings).toHaveLength(4);
  });

  it("a realtime call from the start: picture only, the sound object is never created", () => {
    const h = harness();
    h.cue.update({ ...RUNNING, owners: ["search:0"], callOn: true });
    vi.advanceTimersByTime(30_000);
    expect(h.cue.active).toBe(true);
    expect(h.sounds()).toBe(0);
  });

  it("pauses while Nous speaks and for 1.5 s after (same tail as the wake guard)", () => {
    expect(CUE_TIMING.speechTailMs).toBe(SPEECH_TAIL_MS);
    const h = harness();
    h.cue.update({ ...RUNNING, speaking: true });
    vi.advanceTimersByTime(4_000);
    expect(h.pings()).toBe(0);
    expect(h.cue.quiet()).toBe("speaking");
    h.cue.update(RUNNING); // t = 4 s: speech ended
    expect(h.cue.quiet()).toBe("speech_tail");
    vi.advanceTimersByTime(CUE_TIMING.speechTailMs - 1);
    expect(h.pings()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.pings()).toBe(1);
  });

  it("holds the wake guard ('cue') for 450 ms around every ping and releases it on stop", () => {
    const h = harness();
    h.cue.update(RUNNING);
    expect(h.guard).toEqual({ begun: 1, ended: 0 });
    vi.advanceTimersByTime(CUE_TIMING.guardMs);
    expect(h.guard).toEqual({ begun: 1, ended: 1 });
    vi.advanceTimersByTime(CUE_TIMING.pingIntervalMs - CUE_TIMING.guardMs + 100);
    expect(h.guard).toEqual({ begun: 2, ended: 1 });
    h.cue.update({ ...RUNNING, owners: [] });
    expect(h.guard).toEqual({ begun: 2, ended: 2 });
    vi.advanceTimersByTime(5_000);
    expect(h.guard).toEqual({ begun: 2, ended: 2 });
  });

  it("the sound timing numbers match the validation document", () => {
    expect(CUE_TIMING).toMatchObject({ pingIntervalMs: 2400, episodeWindowMs: 20_000, rearmWindowMs: 6_000, rearmMinGapMs: 15_000, taskCapMs: 60_000, speechTailMs: 1500, guardMs: 450 });
    // 一響（主音 180 ms ＋ 260 ms 後的回聲 180 ms）在防護時間內結束
    expect(PING_SPEC.echo.delayMs + PING_SPEC.echo.ms).toBeLessThanOrEqual(CUE_TIMING.guardMs);
  });
});

// ───────────── WebAudio：假 AudioContext ─────────────

interface Call {
  node: string;
  method: string;
  args: unknown[];
}

function fakeAudio(initialState = "running") {
  const calls: Call[] = [];
  const contexts: FakeContext[] = [];
  const param = (node: string) => {
    const p = { value: 0 } as Record<string, unknown>;
    for (const method of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "cancelScheduledValues"]) {
      p[method] = (...args: unknown[]) => {
        calls.push({ node, method, args });
        return p;
      };
    }
    return p;
  };
  class FakeContext {
    currentTime = 0;
    destination = { name: "destination" };
    closed = false;
    resumed = 0;
    state = initialState;
    constructor() {
      contexts.push(this);
    }
    resume() {
      this.resumed++;
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createGain() {
      const name = `gain${calls.filter((c) => c.method === "createGain").length}`;
      calls.push({ node: name, method: "createGain", args: [] });
      const node = { name, gain: param(name), connect: (to: { name: string }) => (calls.push({ node: name, method: "connect", args: [to.name] }), to) };
      return node;
    }
    createOscillator() {
      const name = `osc${calls.filter((c) => c.method === "createOscillator").length}`;
      calls.push({ node: name, method: "createOscillator", args: [] });
      return {
        name,
        type: "",
        frequency: param(`${name}.frequency`),
        connect: (to: { name: string }) => (calls.push({ node: name, method: "connect", args: [to.name] }), to),
        start: (t: number) => calls.push({ node: name, method: "start", args: [t] }),
        stop: (t: number) => calls.push({ node: name, method: "stop", args: [t] }),
      };
    }
  }
  return { calls, contexts, Ctor: FakeContext as unknown as new () => AudioContext };
}

describe("browserProcessingSound: soft sonar through the chosen speaker", () => {
  it("peak gain 0.05 is about −26 dBFS (echo 35% ≈ −35 dBFS), well under the wake earcon's 0.18 (≈ −14.9 dBFS)", () => {
    expect(PING_SPEC.peakGain).toBe(0.05);
    expect(gainToDb(PING_SPEC.peakGain)).toBeCloseTo(-26.02, 2);
    expect(gainToDb(PING_SPEC.peakGain * PING_SPEC.echo.ratio)).toBeCloseTo(-35.14, 2);
    expect(gainToDb(0.18)).toBeCloseTo(-14.89, 2);
  });

  it("sinks to the chosen output before the first ping, fades in over 1 s, schedules main tone and echo", async () => {
    const audio = fakeAudio();
    const output = { sink: vi.fn(() => Promise.resolve()), release: vi.fn() };
    const sound = browserProcessingSound(output, audio.Ctor);
    expect(audio.contexts).toHaveLength(1);
    expect(audio.calls).toContainEqual({ node: "gain0", method: "connect", args: ["destination"] });
    sound.resume();
    sound.ping();
    expect(output.sink).toHaveBeenCalledWith(audio.contexts[0]);
    // sink 完成之前不排音
    expect(audio.calls.some((c) => c.method === "createOscillator")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.calls).toContainEqual({ node: "gain0", method: "linearRampToValueAtTime", args: [1, PING_SPEC.fadeInS] });
    const ramps = audio.calls.filter((c) => c.method === "exponentialRampToValueAtTime" && c.node.endsWith(".frequency")).map((c) => c.args);
    expect(ramps).toEqual([[820, 0.01 + 0.18], [700, 0.01 + 0.26 + 0.18]]);
    const peaks = audio.calls.filter((c) => c.method === "linearRampToValueAtTime" && /^gain[12]$/.test(c.node)).map((c) => c.args[0]);
    expect(peaks).toEqual([0.05, 0.05 * 0.35]);
    const starts = audio.calls.filter((c) => c.method === "setValueAtTime" && c.node.endsWith(".frequency")).map((c) => c.args[0]);
    expect(starts).toEqual([1100, 880]);
    // 每個音都經過總音量（gain0）再到 destination
    expect(audio.calls.filter((c) => c.method === "connect" && c.args[0] === "gain0")).toHaveLength(2);
  });

  it("pause fades out over 0.4 s and then releases the output; resume sinks again; stop closes the context", async () => {
    const audio = fakeAudio();
    const output = { sink: vi.fn(() => Promise.resolve()), release: vi.fn() };
    const sound = browserProcessingSound(output, audio.Ctor);
    sound.resume();
    sound.pause();
    expect(audio.calls).toContainEqual({ node: "gain0", method: "linearRampToValueAtTime", args: [0, PING_SPEC.fadeOutS] });
    expect(output.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PING_SPEC.fadeOutS * 1000 + 50);
    expect(output.release).toHaveBeenCalledTimes(1);
    sound.resume();
    expect(output.sink).toHaveBeenCalledTimes(2);
    sound.stop();
    await vi.advanceTimersByTimeAsync(PING_SPEC.fadeOutS * 1000 + 50);
    expect(output.release).toHaveBeenCalledTimes(2);
    expect(audio.contexts[0]!.closed).toBe(true);
    // 停止後不再出聲
    const before = audio.calls.length;
    sound.resume();
    sound.ping();
    await vi.advanceTimersByTimeAsync(10);
    expect(audio.calls.length).toBe(before);
  });

  it("a sink that never answers does not block the ping for more than 1 s (system default)", async () => {
    const audio = fakeAudio();
    const output = { sink: vi.fn(() => new Promise<void>(() => {})), release: vi.fn() };
    const sound = browserProcessingSound(output, audio.Ctor);
    sound.resume();
    sound.ping();
    await vi.advanceTimersByTimeAsync(PING_SPEC.sinkWaitMs - 1);
    expect(audio.calls.some((c) => c.method === "createOscillator")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.calls.filter((c) => c.method === "createOscillator")).toHaveLength(2);
  });

  it("a suspended AudioContext (no user gesture): ping schedules nothing and returns false, tries resume once; pings again once running", async () => {
    const audio = fakeAudio("suspended");
    const output = { sink: vi.fn(() => Promise.resolve()), release: vi.fn() };
    const sound = browserProcessingSound(output, audio.Ctor);
    sound.resume();
    const ctx = audio.contexts[0]!;
    const resumedAfterStart = ctx.resumed;
    expect(sound.ping()).toBe(false);
    expect(sound.ping()).toBe(false);
    expect(ctx.resumed).toBe(resumedAfterStart + 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio.calls.some((c) => c.method === "createOscillator")).toBe(false);
    ctx.state = "running";
    expect(sound.ping()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.calls.filter((c) => c.method === "createOscillator")).toHaveLength(2);
  });

  it("without WebAudio nothing happens and nothing throws", () => {
    const output = { sink: vi.fn(() => Promise.resolve()), release: vi.fn() };
    const sound = browserProcessingSound(output, undefined);
    expect(() => {
      sound.resume();
      expect(sound.ping()).toBe(false);
      sound.pause();
      sound.stop();
    }).not.toThrow();
    expect(output.sink).not.toHaveBeenCalled();
  });
});
