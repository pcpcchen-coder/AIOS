import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlarmCenter, type SchedulerClock } from "../server/alarms.ts";
import { DEFAULT_ALARM_PREFS, parseAlarmPrefsPatch, RING_TONES } from "../shared/alarm.ts";
import { ringCycleSamples, ringCycleSeconds, tickOffsets } from "../src/alarm-sound.ts";

// ALARM-3（George 2026-11-09）：到期前 30 秒倒數、最後 10 秒每秒一聲滴、三種鈴聲與響鈴長度。

const clock = (t: number): SchedulerClock => ({ now: () => t, setTimeout: () => 0, clearTimeout: () => undefined });

describe("ring tones and length settings", () => {
  it("three tones; classic is the default; unknown tones are refused", () => {
    expect(RING_TONES).toEqual(["classic", "chime", "pulse"]);
    expect(DEFAULT_ALARM_PREFS.ring_tone).toBe("classic");
    expect(parseAlarmPrefsPatch({ ring_tone: "chime", ring_s: 600 })).toEqual({ ring_tone: "chime", ring_s: 600 });
    expect(() => parseAlarmPrefsPatch({ ring_tone: "siren" })).toThrow();
  });

  it("each tone is a distinct, unclipped loop that starts silent", () => {
    const rate = 16_000;
    const loud = (s: Float32Array, from: number, to: number) => s.slice(Math.round(from * rate), Math.round(to * rate)).some((v) => Math.abs(v) > 0.05);
    for (const tone of RING_TONES) {
      const s = ringCycleSamples(rate, tone);
      expect(s.length, tone).toBe(Math.round(ringCycleSeconds(tone) * rate));
      expect(Math.max(...s.map(Math.abs)), tone).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(s[0], tone).toBe(0);
    }
    const classic = ringCycleSamples(rate, "classic");
    const chime = ringCycleSamples(rate, "chime");
    const pulse = ringCycleSamples(rate, "pulse");
    expect(loud(classic, 0.72, 2)).toBe(false); // 四聲之後安靜
    expect(loud(chime, 1.0, 1.4)).toBe(true); // 鐘聲還在衰減
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => loud(pulse, i * 0.1, i * 0.1 + 0.05))).toEqual(Array(8).fill(true));
    expect(loud(pulse, 0.8, 1.5)).toBe(false);
  });

  it("a saved tone and length survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-alarm3-"));
    new AlarmCenter({ dir, clock: clock(0) }).updatePrefs({ ring_tone: "pulse", ring_s: 900 });
    expect(new AlarmCenter({ dir, clock: clock(0) }).prefs()).toMatchObject({ ring_tone: "pulse", ring_s: 900 });
  });
});

describe("countdown ticks", () => {
  it("one tick per second for the last 10 seconds, none at the due moment", () => {
    expect(tickOffsets(10_000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tickOffsets(10_400).map((x) => Math.round(x * 10) / 10)).toEqual([0.4, 1.4, 2.4, 3.4, 4.4, 5.4, 6.4, 7.4, 8.4, 9.4]);
    // 晚加入（剩 3.5 秒）：只排剩下的 3、2、1。
    expect(tickOffsets(3_500).map((x) => Math.round(x * 10) / 10)).toEqual([0.5, 1.5, 2.5]);
    expect(tickOffsets(0)).toEqual([]);
  });
});

describe("the countdown shows only on the page that will ring", () => {
  it("timers, alarms and snoozes carry here for the asking page", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-alarm3-"));
    const online = new Set(["rpi4"]);
    const c = new AlarmCenter({ dir, clock: clock(Date.UTC(2026, 10, 9, 12)), isConnected: (s) => online.has(s), timeZone: () => "Asia/Taipei" });
    c.startTimer({ duration_s: 20, origin: "rpi4" });
    c.setAlarm({ time: "21:00", days: [], origin: "main" });
    expect(c.view("rpi4").timers[0]!.here).toBe(true);
    expect(c.view("main").timers[0]!.here).toBe(false);
    // Mac 主視窗沒有連線：建立在 main 的鬧鐘照「全部響」，每頁都倒數。
    expect(c.view("rpi4").alarms[0]!.here).toBe(true);
    online.delete("rpi4");
    expect(c.view("main").timers[0]!.here).toBe(true);
  });
});
