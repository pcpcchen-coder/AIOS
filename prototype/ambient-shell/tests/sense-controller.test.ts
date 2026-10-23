import { describe, expect, it } from "vitest";
import { BRAIN_ZOOM_FAR_M, BRAIN_ZOOM_NEAR_M, DEFAULT_CAMERA_PREFS, type CameraSettings, type PointZone, type SensorState } from "../shared/sense.ts";
import { pageHeaders } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { classify } from "../src/intent.ts";
import {
  brainZoom,
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
  const zooms: number[] = [];
  const state = { scale: 1, zoom: 1, present: false, facing: false, zone: null as PointZone | null, sensor: "off" as SensorState };
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
    setBrainZoom: (z) => {
      state.zoom = z;
      zooms.push(z);
    },
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
    zooms,
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

  it("text scaling is unchanged by the brain zoom (docs/10 §2: D ÷ 2 m, farther → bigger)", () => {
    for (const [d, scale] of [[0.6, 0.75], [1.5, 0.75], [2, 1], [2.6, 1.3], [3, 1.5], [4, 1.5]] as const) expect(distanceScale(d)).toBe(scale);
    const t = setup({ prefs: { ...DEFAULT_CAMERA_PREFS, brain_zoom_max: 3 } });
    t.c.handle({ type: "presence", present: true, distance_m: 0.6 });
    expect(t.state).toMatchObject({ scale: 0.75, zoom: 3 });
    t.c.handle({ type: "presence", present: true, distance_m: 3 });
    expect(t.state).toMatchObject({ scale: 1.5, zoom: 1 });
  });

  it.each([1.5, 2, 3])("brainZoom with max %s: 1 at or beyond 2.5 m, max at or inside 0.6 m, linear between, 1 for null", (max) => {
    expect([BRAIN_ZOOM_NEAR_M, BRAIN_ZOOM_FAR_M]).toEqual([0.6, 2.5]);
    for (const far of [2.5, 3, 4]) expect(brainZoom(far, max)).toBe(1);
    for (const near of [0.6, 0.5]) expect(brainZoom(near, max)).toBe(max);
    expect(brainZoom(1.55, max)).toBeCloseTo(1 + (max - 1) / 2, 2); // 中點
    expect(brainZoom(1.5, max)).toBeGreaterThan(brainZoom(2, max));
    expect(brainZoom(null, max)).toBe(1);
    expect(brainZoom(Number.NaN, max)).toBe(1);
  });

  it("brainZoom: max 1 (off) or invalid max never zooms", () => {
    for (const max of [1, 0.5, Number.NaN]) expect(brainZoom(0.6, max)).toBe(1);
    expect(brainZoom(1.55, 2)).toBe(1.5);
    expect(brainZoom(1.55, 3)).toBe(2);
  });

  it("brain zoom follows real presence events and the live max; null, leaving and sensor stop reset it to 1", () => {
    const prefs: SenseTuning = { ...DEFAULT_CAMERA_PREFS };
    const t = setup({ canAutoTalk: false, prefs });
    expect(t.zooms).toEqual([]); // 沒有事件就沒有動畫
    t.c.handle({ type: "presence", present: true, distance_m: 0.6 });
    expect(t.state.zoom).toBe(2);
    prefs.brain_zoom_max = 3; // 設定改了，不重建控制器，下一次 tick 生效
    t.advance(200);
    expect(t.state.zoom).toBe(3);
    t.advance(200);
    expect(t.zooms).toEqual([2, 3]); // 倍率不變時不重複通知
    t.c.handle({ type: "presence", present: true, distance_m: null });
    expect(t.state.zoom).toBe(1);
    t.c.handle({ type: "presence", present: true, distance_m: 1 });
    expect(t.state.zoom).toBeGreaterThan(1);
    t.c.handle({ type: "presence", present: false, distance_m: null });
    expect(t.state.zoom).toBe(1);
    t.c.handle({ type: "presence", present: true, distance_m: 1 });
    t.c.handle({ type: "sensor", state: "starting", detail: "starting" });
    expect(t.state.zoom).toBeGreaterThan(1); // starting 保留最近的距離，和字級一樣
    for (const state of ["off", "error", "degraded"] as const) {
      t.c.handle({ type: "presence", present: true, distance_m: 1 });
      t.c.handle({ type: "sensor", state, detail: state });
      expect(t.state.zoom).toBe(1);
      prefs.brain_zoom_max = 3;
      t.advance(200);
      expect(t.state.zoom).toBe(1); // 沒有距離時改設定也不放大
    }
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

  it("lowering the cooldown during a pause takes effect at once: 60 s pause, end, lower to 3 s → eligible after 3 s", () => {
    const prefs: SenseTuning = { ...DEFAULT_CAMERA_PREFS, look_to_talk_s: 0.5, look_to_talk_cooldown_s: 60 };
    const t = setup({ prefs });
    t.c.handle({ type: "presence", present: true, distance_m: 2 });
    t.c.handle({ type: "attention", facing: true });
    t.advance(200);
    expect(t.log).toEqual(["start"]);
    t.stopTalking(); // 暫停從這裡起算
    prefs.look_to_talk_cooldown_s = 3; // 在 60 秒暫停中改短
    t.advance(2800);
    t.advance(100); // 2.9 s：仍在暫停
    expect(t.log).toEqual(["start"]);
    t.advance(100); // 3.0 s：可以開始累計停留（0.5 s − 0.3 s 確認 = 200 ms）
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
  // 整句短指令才算；否定、問句、敘述與「…設定」都不能改到保存的設定。
  it.each<[string, ReturnType<typeof matchCameraCommand>]>([
    ["鏡頭關掉", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["請幫我把鏡頭關掉", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["麻煩把鏡頭打開", { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" }],
    ["關掉鏡頭", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["關閉鏡頭", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["幫我關閉鏡頭。", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["麻煩關掉鏡頭吧", { set: { active: false }, say: "鏡頭已關閉。" }],
    ["打開鏡頭", { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" }],
    ["開啟鏡頭", { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" }],
    ["請打開鏡頭一下", { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" }],
    ["顯示鏡頭畫面", { preview: true }],
    ["打開鏡頭畫面", { preview: true }],
    ["看一下鏡頭影像", { preview: true }],
    ["收起鏡頭畫面", { preview: false }],
    ["關閉鏡頭畫面", { preview: false }],
    ["關閉看著說話", { set: { look_to_talk: false }, say: "已關閉看著說話。" }],
    ["看著說話關掉", { set: { look_to_talk: false }, say: "已關閉看著說話。" }],
    ["打開看著說話", { set: { look_to_talk: true }, say: "已打開看著說話。" }],
    ["看著說話打開", { set: { look_to_talk: true }, say: "已打開看著說話。" }],
    ["關掉手掌停止", { set: { stop_gesture: false }, say: "已關閉手掌停止。" }],
    ["關閉手掌停止", { set: { stop_gesture: false }, say: "已關閉手掌停止。" }],
    ["打開手掌停止", { set: { stop_gesture: true }, say: "已打開手掌停止。" }],
    ["打開手掌停止播報", { set: { stop_gesture: true }, say: "已打開手掌停止。" }],
    // 不得比對到的句子
    ["打開鏡頭設定", null],
    ["開啟鏡頭設定", null],
    ["不要打開鏡頭", null],
    ["別關鏡頭", null],
    ["幫我找相關鏡頭的資料", null],
    ["開關鏡頭在哪裡", null],
    ["我昨天把鏡頭關掉了", null],
    ["不要關掉看著說話", null],
    ["怎麼關閉手掌停止", null],
    ["可以關掉鏡頭嗎", null],
    ["鏡頭是什麼", null],
    ["看著說話是什麼", null],
    ["幫我寫一篇展開手勢研究的報告", null],
  ])("matchCameraCommand(「%s」)", (text, expected) => {
    expect(matchCameraCommand(text)).toEqual(expected);
  });

  it("「打開鏡頭設定」 falls through to the settings intent instead of turning the camera on", () => {
    expect(matchCameraCommand("打開鏡頭設定")).toBeNull();
    expect(classify("打開鏡頭設定")).toEqual({ kind: "settings" });
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
