import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_PREFS, type CameraSettings, type PointZone, type SensorState } from "../shared/sense.ts";
import { pageHeaders } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import {
  cameraShouldRun,
  distanceScale,
  matchCameraCommand,
  SenseController,
  zoneOf,
  type SenseTuning,
} from "../src/sense/controller.ts";

function setup(opts: { canAutoTalk?: boolean | (() => boolean); prefs?: SenseTuning } = {}) {
  let now = 0;
  let talking = false;
  const log: string[] = [];
  const state = { scale: 1, present: false, facing: false, zone: null as PointZone | null, sensor: "off" as SensorState };
  const c = new SenseController({
    now: () => now,
    isTalking: () => talking,
    canAutoTalk: () => (typeof opts.canAutoTalk === "function" ? opts.canAutoTalk() : (opts.canAutoTalk ?? true)),
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
    prefs: opts.prefs ? () => opts.prefs! : undefined,
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

  it("look-to-talk reads the user's seconds live: 2.5 s from facing → 2200 ms dwell, 5 s cooldown", () => {
    const prefs: SenseTuning = { ...DEFAULT_CAMERA_PREFS, look_to_talk_s: 2.5, look_to_talk_cooldown_s: 5 };
    const t = setup({ prefs });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "attention", facing: true });
    t.advance(2100);
    expect(t.log).toEqual([]);
    t.advance(100);
    expect(t.log).toEqual(["start"]);
    t.stopTalking();
    t.advance(4900);
    expect(t.log).toEqual(["start"]);
    prefs.look_to_talk_s = 0.5; // 設定改變，不重建控制器，下一次 tick 生效
    t.advance(100);
    t.advance(200);
    expect(t.log).toEqual(["start", "start"]);
  });

  it("look-to-talk off or not allowed: no dwell, no phantom cooldown; turning it on starts after one dwell", () => {
    const prefs: SenseTuning = { ...DEFAULT_CAMERA_PREFS, look_to_talk: false };
    const t = setup({ prefs });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "attention", facing: true });
    t.advance(3000);
    expect(t.log).toEqual([]);
    prefs.look_to_talk = true;
    t.advance(200); // 第一次可用的 tick 才開始計時
    t.advance(1100);
    expect(t.log).toEqual([]);
    t.advance(100);
    expect(t.log).toEqual(["start"]);

    let allowed = false;
    const u = setup({ canAutoTalk: () => allowed });
    u.c.handle({ type: "presence", present: true, distance_m: 2 });
    u.c.handle({ type: "attention", facing: true });
    u.advance(3000);
    allowed = true;
    u.advance(200);
    u.advance(1100);
    expect(u.log).toEqual([]);
    u.advance(100);
    expect(u.log).toEqual(["start"]);
  });

  it("stop gesture is ignored when the user turned palm-stop off", () => {
    const prefs: SenseTuning = { ...DEFAULT_CAMERA_PREFS, stop_gesture: false };
    const t = setup({ canAutoTalk: false, prefs });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "gesture", kind: "stop" });
    expect(t.log).toEqual([]);
    prefs.stop_gesture = true;
    t.c.handle({ type: "gesture", kind: "stop" });
    expect(t.log).toEqual(["interrupt"]);
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
    expect(matchCameraCommand("鏡頭關掉")).toEqual({ set: { active: false }, say: "鏡頭已關閉。" });
    expect(matchCameraCommand("幫我關閉鏡頭。")).toEqual({ set: { active: false }, say: "鏡頭已關閉。" });
    expect(matchCameraCommand("打開鏡頭")).toMatchObject({ set: { active: true } });
    expect(matchCameraCommand("鏡頭是什麼")).toBeNull();
  });

  it("preview phrases are view-only and win over camera off (「關閉鏡頭畫面」 contains 「關閉鏡頭」)", () => {
    expect(matchCameraCommand("關閉鏡頭畫面")).toEqual({ preview: false });
    expect(matchCameraCommand("收起鏡頭畫面")).toEqual({ preview: false });
    expect(matchCameraCommand("顯示鏡頭畫面")).toEqual({ preview: true });
    expect(matchCameraCommand("打開鏡頭畫面")).toEqual({ preview: true });
    expect(matchCameraCommand("看一下鏡頭影像")).toEqual({ preview: true });
  });

  it("look-to-talk and palm-stop switches; unrelated sentences do not match", () => {
    expect(matchCameraCommand("關閉看著說話")).toMatchObject({ set: { look_to_talk: false } });
    expect(matchCameraCommand("看著說話打開")).toMatchObject({ set: { look_to_talk: true } });
    expect(matchCameraCommand("關掉手掌停止")).toMatchObject({ set: { stop_gesture: false } });
    expect(matchCameraCommand("打開手掌停止播報")).toMatchObject({ set: { stop_gesture: true } });
    expect(matchCameraCommand("幫我寫一篇展開手勢研究的報告")).toBeNull();
    expect(matchCameraCommand("看著說話是什麼")).toBeNull();
  });

  it("cameraShouldRun: .env enabled, user active, no unconfirmed off, no unretried failure", () => {
    const camera = { enabled: true, active: true } as CameraSettings;
    expect(cameraShouldRun(camera, false, false)).toBe(true);
    expect(cameraShouldRun(undefined, false, false)).toBe(false);
    expect(cameraShouldRun({ ...camera, enabled: false }, false, false)).toBe(false);
    expect(cameraShouldRun({ ...camera, active: false }, false, false)).toBe(false);
    // 剛說「鏡頭關掉」、伺服器還沒保存時收到舊的 hello（active 仍是 true）：不重新打開。
    expect(cameraShouldRun(camera, true, false)).toBe(false);
    // 啟動失敗後，每次 hello／settings.updated 都不自動重試。
    expect(cameraShouldRun(camera, false, true)).toBe(false);
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
