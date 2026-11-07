// VOL-2（George 2026-11-07）：日間／夜間的對話音量。判斷（shared/day-night.ts）、亮度量測排程（src/light-meter.ts）、
// 兩組音量的頁面狀態（src/voice-volume.ts）與交給模型的結果。
import { describe, expect, it } from "vitest";
import {
  BRIGHT_LUMA, DARK_LUMA, currentLight, decideDayNight, DEFAULT_DAY_NIGHT_PREFS, frameLuma, inNightHours, INITIAL_LIGHT,
  LIGHT_HOLD_MS, LIGHT_STALE_MS, nextLight, parseDayNightPrefs,
} from "../shared/day-night.ts";
import { voiceVolumeOutput } from "../shared/voice-volume.ts";
import { LIGHT_REPLY_MS, LightMeter, type LightWorkerLike } from "../src/light-meter.ts";
import { DAY_NIGHT_KEY, NIGHT_VOLUME_KEY, VOICE_VOLUME_KEY, VoiceVolume } from "../src/voice-volume.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("night hours", () => {
  it("wraps past midnight, handles a same-day window, and start == end means no night", () => {
    const wrap = { night_start_h: 22, night_end_h: 7 };
    expect([21, 22, 23, 0, 6, 7, 12].map((h) => inNightHours(h, wrap))).toEqual([false, true, true, true, true, false, false]);
    const same = { night_start_h: 1, night_end_h: 5 };
    expect([0, 1, 4, 5].map((h) => inNightHours(h, same))).toEqual([false, true, true, false]);
    expect(inNightHours(3, { night_start_h: 3, night_end_h: 3 })).toBe(false);
  });

  it("parses saved prefs, falling back per field", () => {
    expect(parseDayNightPrefs(null)).toEqual(DEFAULT_DAY_NIGHT_PREFS);
    expect(parseDayNightPrefs({ night_start_h: 21, night_end_h: 24, use_camera: "yes" })).toEqual({ night_start_h: 21, night_end_h: 7, use_camera: true });
    expect(parseDayNightPrefs({ night_start_h: 0, night_end_h: 6.5, use_camera: false })).toEqual({ night_start_h: 0, night_end_h: 7, use_camera: false });
  });
});

describe("decideDayNight", () => {
  const prefs = DEFAULT_DAY_NIGHT_PREFS;
  it("night hours always win, even when the camera sees a lit room", () => {
    expect(decideDayNight(23, "bright", prefs)).toEqual({ mode: "night", reason: "hours", camera: true });
    expect(decideDayNight(23, null, prefs)).toEqual({ mode: "night", reason: "hours", camera: false });
  });
  it("a dark room switches daytime to night; bright or unknown stays day", () => {
    expect(decideDayNight(14, "dark", prefs)).toEqual({ mode: "night", reason: "camera_dark", camera: true });
    expect(decideDayNight(14, "bright", prefs)).toEqual({ mode: "day", reason: "day", camera: true });
    expect(decideDayNight(14, null, prefs)).toEqual({ mode: "day", reason: "day", camera: false });
  });
  it("with the camera setting off, the reading is ignored", () => {
    expect(decideDayNight(14, "dark", { ...prefs, use_camera: false })).toEqual({ mode: "day", reason: "day", camera: false });
  });
});

describe("light state", () => {
  it("a first bright reading decides at once; a change needs LIGHT_HOLD_MS of agreeing readings (hysteresis)", () => {
    let s = nextLight(INITIAL_LIGHT, 120, 0);
    expect(s.level).toBe("bright");
    s = nextLight(s, DARK_LUMA - 5, 30_000);
    expect(s.level).toBe("bright");
    s = nextLight(s, DARK_LUMA - 5, 30_000 + LIGHT_HOLD_MS - 1);
    expect(s.level).toBe("bright");
    s = nextLight(s, DARK_LUMA - 5, 30_000 + LIGHT_HOLD_MS);
    expect(s.level).toBe("dark");
    // 介於兩個門檻之間：維持目前認定，也取消等待。
    s = nextLight(s, (DARK_LUMA + BRIGHT_LUMA) / 2, 120_000);
    expect(s).toMatchObject({ level: "dark", pendingSince: null });
  });

  it("a first dark reading (for example a blank frame right after the camera starts) is not dark until it lasts LIGHT_HOLD_MS", () => {
    let s = nextLight(INITIAL_LIGHT, 0, 0);
    expect(s.level).toBeNull();
    expect(currentLight(s, 0)).toBeNull();
    s = nextLight(s, 120, 30_000);
    expect(s.level).toBe("bright");
    s = nextLight(INITIAL_LIGHT, 10, 0);
    s = nextLight(s, 12, 30_000);
    expect(s.level).toBeNull();
    s = nextLight(s, 12, LIGHT_HOLD_MS);
    expect(s.level).toBe("dark");
  });

  it("a passing bright moment cancels the wait for dark", () => {
    let s = nextLight(INITIAL_LIGHT, 200, 0);
    s = nextLight(s, 20, 30_000);
    s = nextLight(s, 200, 60_000);
    expect(s).toMatchObject({ level: "bright", pendingSince: null });
    s = nextLight(s, 20, 90_000);
    expect(s.pendingSince).toBe(90_000);
  });

  it("an in-between first reading is unknown; stale readings are unknown and start over", () => {
    expect(nextLight(INITIAL_LIGHT, (DARK_LUMA + BRIGHT_LUMA) / 2, 0).level).toBeNull();
    let s = nextLight(INITIAL_LIGHT, 200, 0);
    expect(currentLight(s, LIGHT_STALE_MS)).toBe("bright");
    expect(currentLight(s, LIGHT_STALE_MS + 1)).toBeNull();
    s = nextLight(s, 20, LIGHT_STALE_MS + 1);
    expect(s).toMatchObject({ level: null, pendingSince: LIGHT_STALE_MS + 1 });
  });

  it("George's Pi readings (2026-11-07): lights on ≈130 is bright, lights off ≈80 is dark after a minute", () => {
    expect(BRIGHT_LUMA).toBeLessThan(130);
    expect(DARK_LUMA).toBeGreaterThan(80);
    let s = nextLight(INITIAL_LIGHT, 130, 0);
    expect(s.level).toBe("bright");
    s = nextLight(s, 80, 30_000);
    s = nextLight(s, 80, 30_000 + LIGHT_HOLD_MS);
    expect(s.level).toBe("dark");
    // 介於中間（例如 105）不會來回切。
    expect(nextLight(s, 105, 120_000).level).toBe("dark");
  });

  it("frameLuma is the Rec. 601 mean", () => {
    expect(frameLuma([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(127.5);
    expect(frameLuma([100, 0, 0, 255])).toBeCloseTo(29.9);
    expect(frameLuma([])).toBe(0);
  });
});

describe("VoiceVolume day/night", () => {
  it("keeps the VOL-1 value as the day volume and defaults night to 40", () => {
    const v = new VoiceVolume(memoryStorage({ [VOICE_VOLUME_KEY]: "80" }));
    expect(v.current).toBe(80);
    expect(v.volumeFor("night")).toBe(40);
  });

  it("switching to night applies the night volume to players at once; changes go to the active period unless named", () => {
    const storage = memoryStorage();
    const v = new VoiceVolume(storage);
    const player = { volume: 1 };
    v.attach(player);
    v.setMode({ mode: "night", reason: "hours", camera: false });
    expect(player.volume).toBeCloseTo(0.4);
    expect(v.change({ change: "down" })).toMatchObject({ period: "night", active: "night", outcome: { volume: 20 } });
    expect(player.volume).toBeCloseTo(0.2);
    expect(storage.data.get(NIGHT_VOLUME_KEY)).toBe("20");
    expect(v.change({ level: 70, period: "day" })).toMatchObject({ period: "day", active: "night", outcome: { volume: 70 } });
    expect(player.volume).toBeCloseTo(0.2);
    expect(storage.data.get(VOICE_VOLUME_KEY)).toBe("70");
    expect(v.change({ change: "reset" }).outcome).toMatchObject({ volume: 40 });
    v.setMode({ mode: "day", reason: "day", camera: true });
    expect(player.volume).toBeCloseTo(0.7);
  });

  it("saves day/night prefs", () => {
    const storage = memoryStorage();
    const v = new VoiceVolume(storage);
    expect(v.setPrefs({ night_start_h: 21, use_camera: false })).toEqual({ night_start_h: 21, night_end_h: 7, use_camera: false });
    expect(new VoiceVolume(storage).prefs).toEqual({ night_start_h: 21, night_end_h: 7, use_camera: false });
    expect(JSON.parse(storage.data.get(DAY_NIGHT_KEY)!)).toEqual({ night_start_h: 21, night_end_h: 7, use_camera: false });
  });

  it("the tool output names the period and says when it is not the one in use", () => {
    const v = new VoiceVolume(memoryStorage());
    const r = v.change({ change: "down", period: "night" });
    expect(voiceVolumeOutput(r.outcome, { period: r.period, active: r.active })).toEqual({
      ok: true, status: "confirmed", volume: 20, previous: 40, period: "night", in_use_now: false, note: "調的是夜間音量；現在用的是日間音量，到夜間才會用到。",
    });
    const d = v.change({ level: 60 });
    expect(voiceVolumeOutput(d.outcome, { period: d.period, active: d.active })).toEqual({ ok: true, status: "confirmed", volume: 60, previous: 100, period: "day", in_use_now: true });
  });
});

describe("LightMeter", () => {
  function fakeWorker() {
    const posted: { id: number }[] = [];
    const worker: LightWorkerLike & { posted: typeof posted; terminated: boolean } = {
      posted,
      terminated: false,
      onmessage: null,
      postMessage(message) { posted.push({ id: message.id }); },
      terminate() { this.terminated = true; },
    };
    return worker;
  }
  const bitmap = () => {
    const b = { closed: false, close() { b.closed = true; } };
    return b as unknown as ImageBitmap & { closed: boolean };
  };

  it("samples only when a frame exists, transfers it, reports only the number, and never overlaps", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    let frame: (ImageBitmap & { closed: boolean }) | null = null;
    const lumas: number[] = [];
    let now = 0;
    const meter = new LightMeter({
      sampleFrame: async () => frame,
      createWorker: () => (workers.push(fakeWorker()), workers.at(-1)!),
      onLuma: (l) => lumas.push(l),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      now: () => now,
    });
    await meter.tick();
    expect(workers).toHaveLength(0);
    meter.start();
    await Promise.resolve();
    expect(workers).toHaveLength(0);
    frame = bitmap();
    await meter.tick();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(1);
    await meter.tick();
    expect(workers[0]!.posted).toHaveLength(1);
    workers[0]!.onmessage!({ data: { type: "luma", id: workers[0]!.posted[0]!.id, luma: 33 } });
    expect(lumas).toEqual([33]);
    await meter.tick();
    expect(workers[0]!.posted).toHaveLength(2);
    // worker 沒回：超過 LIGHT_REPLY_MS 換一個新的。
    now += LIGHT_REPLY_MS;
    await meter.tick();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    meter.stop();
    expect(workers[1]!.terminated).toBe(true);
    workers[1]!.onmessage!({ data: { type: "luma", id: workers[1]!.posted[0]!.id, luma: 99 } });
    expect(lumas).toEqual([33]);
  });

  it("a worker that fails to load is dropped so the next tick starts a new one", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const meter = new LightMeter({ sampleFrame: async () => bitmap(), createWorker: () => (workers.push(fakeWorker()), workers.at(-1)!), onLuma: () => {}, setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {}, now: () => 0 });
    meter.start();
    await new Promise((r) => setTimeout(r, 0));
    workers[0]!.onerror!(new Event("error"));
    expect(workers[0]!.terminated).toBe(true);
    await meter.tick();
    expect(workers).toHaveLength(2);
    meter.stop();
  });

  it("errors from the worker are not reported as readings", async () => {
    const w = fakeWorker();
    const lumas: number[] = [];
    const meter = new LightMeter({ sampleFrame: async () => bitmap(), createWorker: () => w, onLuma: (l) => lumas.push(l), setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} });
    meter.start();
    await new Promise((r) => setTimeout(r, 0));
    w.onmessage!({ data: { type: "error", id: w.posted[0]!.id, message: "boom" } });
    expect(lumas).toEqual([]);
  });
});
