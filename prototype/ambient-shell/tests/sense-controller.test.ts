import { describe, expect, it } from "vitest";
import type { PointZone, SensorState } from "../shared/sense.ts";
import { pageHeaders } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { distanceScale, matchCameraCommand, SenseController, zoneOf } from "../src/sense/controller.ts";

function setup(opts: { canAutoTalk?: boolean } = {}) {
  let now = 0;
  let talking = false;
  const log: string[] = [];
  const state = { scale: 1, present: false, facing: false, zone: null as PointZone | null, sensor: "off" as SensorState };
  const c = new SenseController({
    now: () => now,
    isTalking: () => talking,
    canAutoTalk: () => opts.canAutoTalk ?? true,
    startTalk: () => {
      log.push("start");
      talking = true;
    },
    interruptSpeech: () => log.push("interrupt"),
    onLeave: () => log.push("leave"),
    setScale: (s) => (state.scale = s),
    setPresence: (p) => (state.present = p),
    setFacing: (f) => (state.facing = f),
    pointTo: (z) => (state.zone = z),
    setSensor: (s) => (state.sensor = s),
  });
  return {
    c,
    log,
    state,
    advance: (ms: number) => {
      now += ms;
      c.tick();
    },
    stopTalking: () => {
      talking = false;
      c.conversationEnded();
    },
  };
}

describe("SenseController", () => {
  it("scales the UI with measured distance, clamped to 1.5–3 m", () => {
    expect(distanceScale(2)).toBe(1);
    expect(distanceScale(2.5)).toBe(1.25);
    expect(distanceScale(5)).toBe(1.5);
    expect(distanceScale(0.8)).toBe(0.75);
    expect(distanceScale(null)).toBe(1);
    const t = setup();
    t.c.handle({ type: "presence", present: true, distance_m: 2.6 });
    expect(t.state).toMatchObject({ present: true, scale: 1.3 });
  });

  it("look-to-talk: present and facing for 1.2 s starts realtime once, then cools down after it ends", () => {
    const t = setup();
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "attention", facing: true });
    t.advance(1000);
    expect(t.log).toEqual([]);
    t.advance(300);
    expect(t.log).toEqual(["start"]);
    t.stopTalking();
    t.advance(5000);
    expect(t.log).toEqual(["start"]);
    t.advance(6500);
    t.advance(1300);
    expect(t.log).toEqual(["start", "start"]);
  });

  it("does not auto-start when not allowed (no consent / look_to_talk off)", () => {
    const t = setup({ canAutoTalk: false });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "attention", facing: true });
    t.advance(3000);
    expect(t.log).toEqual([]);
  });

  it("stop gesture only interrupts speech; pointing only selects", () => {
    const t = setup({ canAutoTalk: false });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "gesture", kind: "stop" });
    t.c.handle({ type: "pointing", zone: "left" });
    expect(t.log).toEqual(["interrupt"]);
    expect(t.state.zone).toBe("left");
  });

  it("leaving clears facing, pointing and scale and calls onLeave", () => {
    const t = setup({ canAutoTalk: false });
    t.c.handle({ type: "presence", present: true, distance_m: 3 });
    t.c.handle({ type: "attention", facing: true });
    t.c.handle({ type: "pointing", zone: "right" });
    t.c.handle({ type: "presence", present: false, distance_m: null });
    expect(t.state).toMatchObject({ present: false, facing: false, zone: null, scale: 1 });
    expect(t.log).toEqual(["leave"]);
  });

  it("a sensor fault clears presence-derived state without inventing a leave", () => {
    const t = setup({ canAutoTalk: false });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "pointing", zone: "center" });
    t.c.handle({ type: "sensor", state: "degraded", detail: "沒有影像" });
    expect(t.state).toMatchObject({ present: false, zone: null, sensor: "degraded" });
  });
});

describe("camera helpers", () => {
  it("matches spoken camera on/off commands deterministically", () => {
    expect(matchCameraCommand("鏡頭關掉")).toBe("off");
    expect(matchCameraCommand("幫我關閉鏡頭。")).toBe("off");
    expect(matchCameraCommand("打開鏡頭")).toBe("on");
    expect(matchCameraCommand("鏡頭是什麼")).toBeNull();
  });

  it("maps element centers to the user's left/center/right third", () => {
    expect(zoneOf(100, 1200)).toBe("left");
    expect(zoneOf(600, 1200)).toBe("center");
    expect(zoneOf(1100, 1200)).toBe("right");
  });

  it("page headers allow the camera and wasm only when the camera is enabled", () => {
    const off = pageHeaders(false);
    expect(off["Permissions-Policy"]).toContain("camera=()");
    expect(off["Content-Security-Policy"]).not.toContain("wasm-unsafe-eval");
    const on = pageHeaders(true);
    expect(on["Permissions-Policy"]).toContain("camera=(self)");
    expect(on["Content-Security-Policy"]).toContain("'wasm-unsafe-eval'");
    expect(on["Content-Security-Policy"]).toContain("connect-src 'self'");
  });

  it("camera config defaults to off and the AR0144 label", () => {
    expect(loadConfig({}).camera).toMatchObject({ enabled: false, label: "CCB Camera", left_first: true, look_to_talk: true, screen_width_mm: 398 });
    expect(loadConfig({ NOUS_CAMERA: "on", NOUS_LOOK_TO_TALK: "off" }).camera).toMatchObject({ enabled: true, look_to_talk: false });
  });
});
