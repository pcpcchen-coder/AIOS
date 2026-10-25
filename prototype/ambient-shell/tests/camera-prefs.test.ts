import { describe, expect, it } from "vitest";
import {
  CAMERA_PREFS,
  CameraPatchError,
  DEFAULT_CAMERA_PREFS,
  lookToTalkDwellMs,
  parseCameraPatch,
  stepCameraPref,
} from "../shared/sense.ts";
import { AttentionTracker, LookToTalk } from "../src/sense/trackers.ts";

describe("CAMERA_PREFS", () => {
  it("defaults come from the table and keep today's timings (1.5 s total → 1200 ms dwell, 10 s cooldown)", () => {
    expect(DEFAULT_CAMERA_PREFS).toEqual({
      active: true,
      look_to_talk: true,
      look_to_talk_s: 1.5,
      look_to_talk_cooldown_s: 10,
      look_to_talk_greet: true,
      look_to_talk_greet_name: true,
      stop_gesture: true,
      brain_zoom_max: 2,
    });
    expect(LookToTalk.DWELL_MS).toBe(1200);
    expect(LookToTalk.COOLDOWN_MS).toBe(10_000);
  });

  it("perceived seconds include the 300 ms facing confirmation and never go negative", () => {
    expect(AttentionTracker.ON_MS).toBe(300);
    expect(lookToTalkDwellMs(1.5, AttentionTracker.ON_MS)).toBe(1200);
    expect(lookToTalkDwellMs(0.5, AttentionTracker.ON_MS)).toBe(200);
    expect(lookToTalkDwellMs(5, AttentionTracker.ON_MS)).toBe(4700);
    expect(lookToTalkDwellMs(0.2, AttentionTracker.ON_MS)).toBe(0);
    // 浮點：0.7 * 1000 = 700.0000000000001
    expect(lookToTalkDwellMs(0.7, 300)).toBe(400);
  });

  it("steppers move one step, stay in range and avoid float noise", () => {
    expect(stepCameraPref("look_to_talk_s", 1.5, 1)).toBe(1.6);
    expect(stepCameraPref("look_to_talk_s", 0.5, -1)).toBe(0.5);
    expect(stepCameraPref("look_to_talk_s", 5, 1)).toBe(5);
    expect(stepCameraPref("look_to_talk_cooldown_s", 10, -1)).toBe(9);
    expect(stepCameraPref("look_to_talk_cooldown_s", 60, 1)).toBe(60);
    expect(stepCameraPref("brain_zoom_max", 2, 1)).toBe(2.1);
    expect(stepCameraPref("brain_zoom_max", 1, -1)).toBe(1);
    expect(stepCameraPref("brain_zoom_max", 3, 1)).toBe(3);
    let z: number = CAMERA_PREFS.brain_zoom_max.min;
    while (z < CAMERA_PREFS.brain_zoom_max.max) {
      z = stepCameraPref("brain_zoom_max", z, 1);
      expect(parseCameraPatch({ brain_zoom_max: z })).toEqual({ brain_zoom_max: z });
    }
    let v: number = CAMERA_PREFS.look_to_talk_s.min;
    while (v < CAMERA_PREFS.look_to_talk_s.max) {
      v = stepCameraPref("look_to_talk_s", v, 1);
      expect(() => parseCameraPatch({ look_to_talk_s: v })).not.toThrow();
    }
  });
});

describe("parseCameraPatch", () => {
  it("accepts each key at its bounds and an empty patch", () => {
    expect(parseCameraPatch({})).toEqual({});
    expect(parseCameraPatch({ active: false, look_to_talk: true, stop_gesture: false })).toEqual({
      active: false,
      look_to_talk: true,
      stop_gesture: false,
    });
    expect(parseCameraPatch({ look_to_talk_s: 0.5 })).toEqual({ look_to_talk_s: 0.5 });
    expect(parseCameraPatch({ look_to_talk_s: 5 })).toEqual({ look_to_talk_s: 5 });
    expect(parseCameraPatch({ look_to_talk_s: 1.7 })).toEqual({ look_to_talk_s: 1.7 });
    expect(parseCameraPatch({ look_to_talk_cooldown_s: 3 })).toEqual({ look_to_talk_cooldown_s: 3 });
    expect(parseCameraPatch({ look_to_talk_cooldown_s: 60 })).toEqual({ look_to_talk_cooldown_s: 60 });
  });

  it("rejects non-objects, unknown keys, wrong types, out-of-range and off-step values", () => {
    for (const bad of [null, [], "x", 1, true]) expect(() => parseCameraPatch(bad)).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ enabled: true })).toThrow(/未知/);
    expect(() => parseCameraPatch({ label: "x" })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ __proto__: { active: true }, toString: 1 })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ active: "false" })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: "1.5" })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: 0.4 })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: 5.1 })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: 1.55 })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: Number.NaN })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_cooldown_s: 2 })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_cooldown_s: 10.5 })).toThrow(CameraPatchError);
  });

  it("brain_zoom_max (factor): 1–3 on a 0.1 step, strict like the seconds — no silent clamping", () => {
    expect(CAMERA_PREFS.brain_zoom_max).toMatchObject({ kind: "factor", default: 2, min: 1, max: 3, step: 0.1, presets: [1, 1.5, 2, 2.5, 3] });
    for (const ok of [1, 1.1, 2, 2.7, 3]) expect(parseCameraPatch({ brain_zoom_max: ok })).toEqual({ brain_zoom_max: ok });
    expect(parseCameraPatch({ brain_zoom_max: 2.3000000001 })).toEqual({ brain_zoom_max: 2.3 }); // onStep 容許誤差內存成格點
    for (const bad of [0.9, 3.1, 0, -2, 10]) expect(() => parseCameraPatch({ brain_zoom_max: bad })).toThrow(/brain_zoom_max 必須是 1–3 倍、間隔 0.1/);
    for (const bad of [1.25, 2.05]) expect(() => parseCameraPatch({ brain_zoom_max: bad })).toThrow(CameraPatchError);
    for (const bad of ["2", true, null, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => parseCameraPatch({ brain_zoom_max: bad })).toThrow(CameraPatchError);
  });

  it("range ends get the same float tolerance as the step: values are snapped before the range check (seconds too)", () => {
    // 審查舉例的 2.9 + 0.1、0.7 + 0.3 在 IEEE 754 雙精度剛好是 3 和 1；真正帶雜訊的端點值用字面值和 0.3 * 3 + 0.1。
    expect(2.9 + 0.1).toBe(3);
    expect(0.7 + 0.3).toBe(1);
    expect(0.3 * 3 + 0.1).toBe(0.9999999999999999);
    for (const [noisy, snapped] of [[2.9 + 0.1, 3], [0.7 + 0.3, 1], [3.0000000000000004, 3], [0.9999999999999999, 1], [0.3 * 3 + 0.1, 1]]) {
      expect(parseCameraPatch({ brain_zoom_max: noisy })).toEqual({ brain_zoom_max: snapped });
    }
    expect(parseCameraPatch({ brain_zoom_max: 1.1000000001 })).toEqual({ brain_zoom_max: 1.1 });
    // 秒數共用同一段程式：look_to_talk_s 0.5–5，兩端的浮點雜訊同樣存成端點。
    expect(parseCameraPatch({ look_to_talk_s: 0.4 + 0.1 })).toEqual({ look_to_talk_s: 0.5 });
    expect(parseCameraPatch({ look_to_talk_s: 4.9 + 0.1 })).toEqual({ look_to_talk_s: 5 });
    // 超出容許誤差的仍拒絕：不默默夾住。
    for (const bad of [3.0001, 0.9999, 3 + 0.1]) expect(() => parseCameraPatch({ brain_zoom_max: bad })).toThrow(CameraPatchError);
    expect(() => parseCameraPatch({ look_to_talk_s: 5.0001 })).toThrow(CameraPatchError);
  });
});
