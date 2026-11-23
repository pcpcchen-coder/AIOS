import { afterEach, describe, expect, it, vi } from "vitest";
import { browserEarcon, EARCON_MS } from "../src/audio/earcon.ts";
import { playChime } from "../src/speaker/recorder.ts";
import { applySink, AudioDevices, MIC_CONSTRAINTS, openMic, type AudioDeviceEvent } from "../src/audio-devices.ts";
import {
  AUDIO_TEXT,
  DEFAULT_AUDIO_PREFS,
  DEVICE_LIST_MAX,
  inputStatus,
  labelBackfill,
  outputStatus,
  sanitizeAudioReport,
  type AudioPrefs,
  type AudioReport,
} from "../shared/audio-devices.ts";
import { FakeMediaDevices, FakeStream, flush } from "./fixtures/wake.ts";

// 聲音輸入／輸出裝置（George 2026-11-01）：假的 MediaDevices 與有 setSinkId 的假播放元素（fixture）。
// 證明的是「用哪個約束開、呼叫哪個 setSinkId、何時改用系統預設」，不是 Mac 上藍牙喇叭真的出聲（docs/validation/audio-devices-2026-11-01.md）。

/** 假播放元素／AudioContext：只有 sinkId 與 setSinkId；不在 available 的裝置丟 NotFoundError。 */
class FakeSink {
  sinkId = "";
  calls: string[] = [];
  constructor(readonly available: () => string[]) {}
  async setSinkId(id: string): Promise<void> {
    this.calls.push(id);
    if (id !== "" && !this.available().includes(id)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
    this.sinkId = id;
  }
}

const prefs = (patch: Partial<AudioPrefs>): AudioPrefs => ({ ...DEFAULT_AUDIO_PREFS, ...patch });

describe("openMic: exact → label → system default", () => {
  it("system default: exactly the constraints used before this feature (realtime and enrollment)", async () => {
    const media = new FakeMediaDevices();
    await openMic(media, { id: null, label: null });
    await openMic(media, { id: null, label: null }, { video: false });
    expect(media.calls).toEqual([
      { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
      { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
    ]);
    expect(media.enumerations).toBe(0);
  });

  it("chosen device present: exact deviceId, no fallback", async () => {
    const media = new FakeMediaDevices();
    const opened = await openMic(media, { id: "mic-b", label: "USB" });
    expect(media.calls).toEqual([{ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: "mic-b" } } }]);
    expect(opened.fallback).toBe(false);
  });

  it("deviceId changed but the same name is listed: opens that device by name, no fallback", async () => {
    const media = new FakeMediaDevices();
    media.devices = ["mic-a", "mic-b2"];
    media.names = { "mic-b2": "USB Mic" };
    const opened = await openMic(media, { id: "mic-b", label: "USB Mic" });
    expect(media.calls.map((c) => (c.audio as { deviceId?: unknown }).deviceId)).toEqual([{ exact: "mic-b" }, { exact: "mic-b2" }]);
    expect(opened.fallback).toBe(false);
  });

  it("chosen device missing: system default with fallback: true", async () => {
    const media = new FakeMediaDevices();
    media.devices = ["mic-a"];
    const opened = await openMic(media, { id: "mic-b", label: "USB Mic" });
    expect(media.calls.at(-1)).toEqual({ audio: { ...MIC_CONSTRAINTS } });
    expect(opened.fallback).toBe(true);
  });

  it("permission denied is not a missing device: the error is passed on, no fallback attempt", async () => {
    const media = new FakeMediaDevices();
    media.failWith = "NotAllowedError";
    await expect(openMic(media, { id: "mic-b", label: null })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(media.calls).toHaveLength(1);
  });
});

describe("applySink: setSinkId only when routing away from (or back to) the system default", () => {
  it("system default on a fresh element: no setSinkId call", async () => {
    const el = new FakeSink(() => ["spk-bt"]);
    expect(await applySink(el, { id: null, label: null })).toEqual({ id: null, fallback: false });
    expect(el.calls).toEqual([]);
  });

  it("chosen device: setSinkId(id); back to default later: setSinkId('')", async () => {
    const el = new FakeSink(() => ["spk-bt"]);
    expect(await applySink(el, { id: "spk-bt", label: "BT" })).toEqual({ id: "spk-bt", fallback: false });
    expect(await applySink(el, { id: null, label: null })).toEqual({ id: null, fallback: false });
    expect(el.calls).toEqual(["spk-bt", ""]);
  });

  it("chosen device missing from the list: never tried, falls back to the default (fallback: true)", async () => {
    const el = new FakeSink(() => []);
    el.sinkId = "spk-bt";
    const result = await applySink(el, { id: "spk-bt", label: "BT" }, [{ deviceId: "spk-mac", kind: "audiooutput", label: "Mac" }]);
    expect(result).toEqual({ id: null, fallback: true });
    expect(el.calls).toEqual([""]);
  });

  it("no setSinkId support: reported honestly as fallback", async () => {
    expect(await applySink({}, { id: "spk-bt", label: null })).toEqual({ id: null, fallback: true });
  });
});

function manager() {
  const media = new FakeMediaDevices();
  media.outputs = [{ id: "spk-mac", label: "MacBook Speakers" }, { id: "spk-bt", label: "JBL Flip" }];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const devices = new AudioDevices(() => media, {
    timer: (run, ms) => {
      const entry = { run, ms, cancelled: false };
      timers.push(entry);
      return () => (entry.cancelled = true);
    },
  });
  const events: AudioDeviceEvent[] = [];
  devices.on((e) => events.push(e));
  devices.start();
  const available = () => media.outputs.map((o) => o.id);
  /** 去彈跳時間到：執行還沒取消的計時器。 */
  const elapse = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.run();
  };
  return { media, devices, events, available, timers, elapse };
}

describe("AudioDevices: roster, in-use from device events, live re-routing", () => {
  it("reports devices without the browser aliases, the system default's name, and in-use from the real track", async () => {
    const h = manager();
    await flush();
    let report = h.devices.report();
    expect(report.inputs.map((d) => d.id)).toEqual(["mic-a", "mic-b"]);
    expect(report.outputs.map((d) => d.id)).toEqual(["spk-mac", "spk-bt"]);
    expect(report.default_input).toBe("Mic mic-a");
    expect(report.default_output).toBe("MacBook Speakers");
    expect(report.input_in_use).toBeNull();
    expect(report.output_in_use).toBeNull();
    const stream = (await h.devices.openInput()) as unknown as FakeStream;
    report = h.devices.report();
    expect(report.input_in_use).toEqual({ id: "mic-a", label: "Mic mic-a" });
    stream.tracks[0]!.stop();
    expect(h.devices.report().input_in_use).toBeNull();
  });

  it("changing the output applies immediately to live elements; releasing clears in-use", async () => {
    const h = manager();
    await flush();
    const el = new FakeSink(h.available);
    await h.devices.sink(el);
    expect(el.calls).toEqual([]); // 系統預設
    expect(h.devices.report().output_in_use).toEqual({ id: null, label: "MacBook Speakers" });
    h.devices.setPrefs(prefs({ output_device_id: "spk-bt", output_label: "JBL Flip" }));
    await flush();
    expect(el.calls).toEqual(["spk-bt"]);
    expect(h.devices.report().output_in_use).toEqual({ id: "spk-bt", label: "JBL Flip" });
    h.devices.release(el);
    expect(h.devices.report().output_in_use).toBeNull();
  });

  it("Bluetooth speaker disconnects: live element falls back to the default with output_lost; reconnect switches back with output_back", async () => {
    const h = manager();
    h.devices.setPrefs(prefs({ output_device_id: "spk-bt", output_label: "JBL Flip" }));
    await flush();
    const el = new FakeSink(h.available);
    await h.devices.sink(el);
    expect(el.sinkId).toBe("spk-bt");
    h.media.outputs = [{ id: "spk-mac", label: "MacBook Speakers" }];
    h.media.deviceChange();
    await flush();
    expect(el.sinkId).toBe("");
    expect(h.events.filter((e) => e.type === "output_lost")).toEqual([{ type: "output_lost", label: "JBL Flip" }]);
    expect(h.devices.report()).toMatchObject({ output_fallback: true, output_in_use: { id: null } });
    h.media.outputs = [{ id: "spk-mac", label: "MacBook Speakers" }, { id: "spk-bt", label: "JBL Flip" }];
    h.media.deviceChange();
    await flush();
    expect(el.sinkId).toBe("spk-bt");
    expect(h.events.filter((e) => e.type === "output_back")).toEqual([{ type: "output_back", label: "JBL Flip" }]);
    expect(h.devices.report().output_fallback).toBe(false);
  });

  it("missing input: one input_fallback per choice, input_returned when it is listed again", async () => {
    const h = manager();
    h.media.devices = ["mic-a"];
    await h.devices.refresh();
    h.devices.setPrefs(prefs({ input_device_id: "mic-b", input_label: "Mic mic-b" }));
    await h.devices.openInput();
    await h.devices.openInput();
    expect(h.events.filter((e) => e.type === "input_fallback")).toEqual([{ type: "input_fallback", label: "Mic mic-b" }]);
    h.media.devices = ["mic-a", "mic-b"];
    h.media.deviceChange();
    await flush();
    expect(h.events.some((e) => e.type === "input_returned")).toBe(false); // 去彈跳中
    h.elapse();
    expect(h.events.filter((e) => e.type === "input_returned")).toHaveLength(1);
  });

  it("input_returned: a burst of devicechange gives one event after the debounce; staying listed while exact-open fails never re-emits", async () => {
    const h = manager();
    h.media.devices = ["mic-a"];
    await h.devices.refresh();
    h.devices.setPrefs(prefs({ input_device_id: "mic-b", input_label: "Mic mic-b" }));
    await h.devices.openInput();
    h.media.devices = ["mic-a", "mic-b"];
    for (let i = 0; i < 5; i++) h.media.deviceChange();
    await flush();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(500);
    h.elapse();
    // 還沒重開成功（仍是 fallback）而裝置一直在清單裡：之後的 devicechange 不再通知
    for (let i = 0; i < 3; i++) h.media.deviceChange();
    await flush();
    h.elapse();
    expect(h.events.filter((e) => e.type === "input_returned")).toHaveLength(1);
    // 拔掉又在去彈跳時間內插回：只通知一次
    h.media.devices = ["mic-a"];
    h.media.deviceChange();
    await flush();
    h.media.devices = ["mic-a", "mic-b"];
    h.media.deviceChange();
    await flush();
    h.media.devices = ["mic-a"];
    h.media.deviceChange();
    await flush();
    h.elapse();
    expect(h.events.filter((e) => e.type === "input_returned")).toHaveLength(1); // 最後又不在：不通知
    h.media.devices = ["mic-a", "mic-b"];
    h.media.deviceChange();
    await flush();
    h.elapse();
    expect(h.events.filter((e) => e.type === "input_returned")).toHaveLength(2);
  });

  it("overlapping enumerations: a stale (slower) result is dropped", async () => {
    const h = manager();
    await flush();
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((r) => (releaseSlow = r));
    const original = h.media.enumerateDevices.bind(h.media);
    let calls = 0;
    h.media.enumerateDevices = async () => {
      calls++;
      if (calls === 1) {
        const snapshot = await original(); // 舊的清單：還有藍牙喇叭
        await slow;
        return snapshot;
      }
      return original();
    };
    const first = h.devices.refresh();
    h.media.outputs = [{ id: "spk-mac", label: "MacBook Speakers" }];
    await h.devices.refresh();
    releaseSlow();
    await first;
    expect(h.devices.report().outputs.map((o) => o.id)).toEqual(["spk-mac"]);
  });

  it("output_fallback is computed from all live sinks, not the last one applied", async () => {
    const h = manager();
    h.devices.setPrefs(prefs({ output_device_id: "spk-bt", output_label: "JBL Flip" }));
    await flush();
    const broken = new FakeSink(() => []); // 這個元素導不過去
    const good = new FakeSink(h.available);
    await h.devices.sink(broken);
    await h.devices.sink(good);
    expect(h.devices.report().output_fallback).toBe(true);
    h.devices.release(broken);
    expect(h.devices.report().output_fallback).toBe(false);
  });

  it("stopping a call's microphone track updates in-use immediately (changed event)", async () => {
    const h = manager();
    await flush();
    const stream = (await h.devices.openInput()) as unknown as FakeStream;
    const before = h.events.filter((e) => e.type === "changed").length;
    stream.tracks[0]!.stop();
    expect(h.events.filter((e) => e.type === "changed").length).toBe(before + 1);
    expect(h.devices.report().input_in_use).toBeNull();
  });

  it("labels are reported as missing before microphone permission", async () => {
    const h = manager();
    h.media.labels = false;
    await h.devices.refresh();
    expect(h.devices.report()).toMatchObject({ labels: false, default_input: null });
  });

  it("caps each list at 24 devices", async () => {
    const h = manager();
    h.media.devices = Array.from({ length: 40 }, (_, i) => `mic-${i}`);
    await h.devices.refresh();
    expect(h.devices.report().inputs).toHaveLength(DEVICE_LIST_MAX);
  });
});

describe("sanitizeAudioReport and status lines", () => {
  it("drops malformed entries, caps ids, labels and list sizes", () => {
    const long = "x".repeat(300);
    const r = sanitizeAudioReport({
      inputs: [{ id: "ok", label: "Mic\u0007 A" }, { id: long, label: "too long id" }, { id: "has space", label: "x" }, "junk", { id: "b", label: "y".repeat(200) }],
      outputs: Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })),
      input_in_use: { id: null, label: "Default" },
      output_in_use: { id: 5 },
      input_fallback: "yes",
      labels: true,
      samples: [1, 2, 3],
    })!;
    expect(r.inputs).toEqual([{ id: "ok", label: "Mic A" }, { id: "b", label: "y".repeat(128) }]);
    expect(r.outputs).toHaveLength(24);
    expect(r.input_in_use).toEqual({ id: null, label: "Default" });
    expect(r.output_in_use).toBeNull();
    expect(r.input_fallback).toBe(false);
    expect(r).not.toHaveProperty("samples");
    expect(sanitizeAudioReport("x")).toBeNull();
  });

  const report = (patch: Partial<AudioReport>): AudioReport => ({
    inputs: [{ id: "mic-a", label: "MacBook Mic" }], outputs: [{ id: "spk-mac", label: "MacBook Speakers" }],
    default_input: "MacBook Mic", default_output: "MacBook Speakers", input_in_use: null, output_in_use: null,
    input_fallback: false, output_fallback: false, labels: true, ...patch,
  });

  it("input: in use only from the real track; missing choice says it is using the default", () => {
    expect(inputStatus(DEFAULT_AUDIO_PREFS, null)).toEqual({ text: AUDIO_TEXT.notReported, values: [] });
    expect(inputStatus(DEFAULT_AUDIO_PREFS, report({}))).toEqual({ text: AUDIO_TEXT.noMic, values: [] });
    expect(inputStatus(DEFAULT_AUDIO_PREFS, report({ input_in_use: { id: "mic-a", label: "MacBook Mic" } }))).toEqual({ text: AUDIO_TEXT.inUse, values: ["MacBook Mic"] });
    const chosen = prefs({ input_device_id: "usb", input_label: "USB Mic" });
    expect(inputStatus(chosen, report({}))).toEqual({ text: AUDIO_TEXT.missing, values: ["USB Mic"] });
    expect(inputStatus(chosen, report({ input_fallback: true, input_in_use: { id: "mic-a", label: "MacBook Mic" } }))).toEqual({ text: AUDIO_TEXT.missing, values: ["USB Mic"] });
  });

  it("output: missing choice, in use, or where the next playback goes", () => {
    expect(outputStatus(DEFAULT_AUDIO_PREFS, report({}))).toEqual({ text: AUDIO_TEXT.nextPlayback, values: ["MacBook Speakers"] });
    const bt = prefs({ output_device_id: "spk-bt", output_label: "JBL Flip" });
    expect(outputStatus(bt, report({}))).toEqual({ text: AUDIO_TEXT.missing, values: ["JBL Flip"] });
    const listed = report({ outputs: [{ id: "spk-bt", label: "JBL Flip" }], output_in_use: { id: "spk-bt", label: "JBL Flip" } });
    expect(outputStatus(bt, listed)).toEqual({ text: AUDIO_TEXT.inUse, values: ["JBL Flip"] });
  });
});

describe("AudioDevices: no 'disconnected' caption for a speaker that was simply off when the App started", () => {
  it("first enumeration with the chosen output missing: status says missing, no output_lost event", async () => {
    const media = new FakeMediaDevices();
    const devices = new AudioDevices(() => media);
    const events: AudioDeviceEvent[] = [];
    devices.on((e) => events.push(e));
    devices.setPrefs(prefs({ output_device_id: "spk-bt", output_label: "JBL Flip" }));
    devices.start();
    await flush();
    expect(events.some((e) => e.type === "output_lost")).toBe(false);
    expect(devices.report().output_fallback).toBe(true);
  });
});

/** 假 AudioContext：記下排了幾個音、什麼時候關掉（不出聲）。 */
class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  currentTime = 0;
  destination = {};
  oscillators = 0;
  closed = false;
  constructor() {
    FakeAudioContext.created.push(this);
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  createOscillator() {
    this.oscillators++;
    const node = { type: "", frequency: { value: 0 }, connect: (x: unknown) => x, start() {}, stop() {} };
    return node;
  }
  createGain() {
    const gain = { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: unknown) => x };
    return gain;
  }
}

describe("earcon and enrollment chime on a slow output", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeAudioContext.created = [];
  });

  it("earcon: tones are scheduled only after the sink resolves; the context closes only after the tones (no clipping); cancel still works", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    let resolveSink: () => void = () => {};
    const released: unknown[] = [];
    const output = { sink: () => new Promise<void>((r) => (resolveSink = r)), release: (ctx: unknown) => released.push(ctx) };
    const playback = browserEarcon(output as never).play();
    let played: boolean | null = null;
    void playback.done.then((v) => (played = v));
    const ctx = FakeAudioContext.created[0]!;
    await vi.advanceTimersByTimeAsync(600); // 藍牙喇叭還沒導好：還沒排音、也沒有關掉
    expect(ctx.oscillators).toBe(0);
    expect(ctx.closed).toBe(false);
    expect(played).toBeNull();
    resolveSink();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.oscillators).toBe(2);
    await vi.advanceTimersByTimeAsync(EARCON_MS);
    expect(ctx.closed).toBe(false); // 兩個音約 350 ms：播完之前不關
    await vi.advanceTimersByTimeAsync(60);
    expect(ctx.closed).toBe(true);
    expect(played).toBe(true);
    expect(released).toEqual([ctx]);
    // 取消：導好之前就取消，回 false 並關掉
    const second = browserEarcon({ sink: () => new Promise<void>(() => {}), release: () => {} } as never).play();
    second.cancel();
    expect(await second.done).toBe(false);
    expect(FakeAudioContext.created[1]!.closed).toBe(true);
  });

  it("earcon: a sink that never answers still plays on the default after 1 s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const playback = browserEarcon({ sink: () => new Promise<void>(() => {}), release: () => {} } as never).play();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeAudioContext.created[0]!.oscillators).toBe(2);
    await vi.advanceTimersByTimeAsync(EARCON_MS + 50);
    expect(await playback.done).toBe(true);
  });

  it("enrollment chime: its own short-lived context is the only one registered as an output, released after the beep", async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const sunk: unknown[] = [];
    const released: unknown[] = [];
    const ctx = new FakeAudioContext();
    await playChime(
      { sink: async (c) => void sunk.push(c), release: (c) => void released.push(c) },
      () => ctx as unknown as AudioContext,
      (run, ms) => void timers.push({ run, ms }),
    );
    expect(sunk).toEqual([ctx]);
    expect(ctx.oscillators).toBe(1);
    expect(released).toEqual([]);
    for (const t of timers.filter((t) => t.ms === 300)) t.run();
    expect(released).toEqual([ctx]);
    expect(ctx.closed).toBe(true);
  });
});

describe("labelBackfill", () => {
  const report = (inputs: { id: string; label: string }[], labels = true): AudioReport => ({
    inputs, outputs: [], default_input: null, default_output: null, input_in_use: null, output_in_use: null, input_fallback: false, output_fallback: false, labels,
  });
  it("sends the device id together with its name, only once the device is listed with a name", () => {
    const chosen = prefs({ input_device_id: "mic-usb", input_label: null });
    expect(labelBackfill(chosen, report([], false))).toBeNull();
    expect(labelBackfill(chosen, report([{ id: "mic-mac", label: "Mac" }]))).toBeNull(); // 還沒出現：之後再補
    expect(labelBackfill(chosen, report([{ id: "mic-usb", label: "USB Mic" }]))).toEqual({ input_device_id: "mic-usb", input_label: "USB Mic" });
    expect(labelBackfill(prefs({ input_device_id: "mic-usb", input_label: "USB Mic" }), report([{ id: "mic-usb", label: "USB Mic" }]))).toBeNull();
  });
});
