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
      stop_gesture: true,
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
});
