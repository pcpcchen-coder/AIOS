import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FaceTuningStore } from "../server/face-tuning-settings.ts";
import { checkFaceTuning, DEFAULT_FACE_TUNING, FaceTuningError, parseFaceTuningPatch, type FaceTuning } from "../shared/face-tuning.ts";
import { percentile, SpotRecorder, spotAdvice, spotUsable, suggestTuning, summarizeSpot, tuningChanges, type FrameSample } from "../src/face-calibration.ts";
import { assessQuality, faceMetrics, judgeMetrics, QUALITY_DEFAULTS, type FaceMetrics } from "../src/sense/face/quality.ts";
import type { YuNetFace } from "../src/sense/face/yunet.ts";

describe("face tuning values (shared/face-tuning.ts)", () => {
  it("defaults equal the constants used before calibration existed", () => {
    expect(DEFAULT_FACE_TUNING).toEqual({ near_min_m: 0.6, near_max_m: 1.5, facing_yaw_ratio: 0.2, facing_grace_ms: 800, min_face_px: 100, max_yaw_offset: 0.2 });
    expect(DEFAULT_FACE_TUNING.min_face_px).toBe(QUALITY_DEFAULTS.min_face_px);
    expect(DEFAULT_FACE_TUNING.max_yaw_offset).toBe(QUALITY_DEFAULTS.max_yaw_offset);
  });

  it("accepts known keys on the grid and rejects unknown keys, off-grid or out-of-range values", () => {
    expect(parseFaceTuningPatch({ near_max_m: 1.2, min_face_px: 85, max_yaw_offset: 0.25 })).toEqual({ near_max_m: 1.2, min_face_px: 85, max_yaw_offset: 0.25 });
    expect(parseFaceTuningPatch({ near_min_m: 0.1 + 0.2 + 0.15 })).toEqual({ near_min_m: 0.45 });
    for (const bad of [{ threshold: 0.4 }, { min_face_px: 40 }, { min_face_px: 87 }, { max_yaw_offset: 0.5 }, { near_max_m: "1.2" }, { facing_grace_ms: Number.NaN }, [], null]) {
      expect(() => parseFaceTuningPatch(bad), JSON.stringify(bad)).toThrow(FaceTuningError);
    }
  });

  it("the far end must be at least 0.3 m beyond the near end", () => {
    expect(() => checkFaceTuning({ ...DEFAULT_FACE_TUNING, near_min_m: 1.0, near_max_m: 1.2 })).toThrow(FaceTuningError);
    expect(() => checkFaceTuning({ ...DEFAULT_FACE_TUNING, near_min_m: 0.9, near_max_m: 1.2 })).not.toThrow();
  });
});

describe("FaceTuningStore (configDir/face-tuning.json)", () => {
  function store(now = new Date("2026-10-31T02:30:00Z")) {
    const dir = mkdtempSync(join(tmpdir(), "nous-face-tuning-"));
    let changes = 0;
    const s = new FaceTuningStore({ dir, onChange: () => changes++, log: () => {}, now: () => now });
    return { dir, s, changes: () => changes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("starts at the defaults, saves only the changed keys with the calibration time, and resets", () => {
    const t = store();
    expect(t.s.view()).toEqual({ ...DEFAULT_FACE_TUNING, customized: false, calibrated_at: null });
    const view = t.s.update({ near_max_m: 1.1, min_face_px: 80 }, true);
    expect(view).toMatchObject({ near_max_m: 1.1, min_face_px: 80, near_min_m: 0.6, customized: true, calibrated_at: "2026-10-31T02:30:00.000Z" });
    const file = JSON.parse(readFileSync(join(t.dir, "face-tuning.json"), "utf8"));
    expect(file).toEqual({ schema_version: 1, prefs: { near_max_m: 1.1, min_face_px: 80, calibrated_at: "2026-10-31T02:30:00.000Z" } });
    expect(new FaceTuningStore({ dir: t.dir, onChange: () => {}, log: () => {} }).view()).toMatchObject({ near_max_m: 1.1, min_face_px: 80 });
    expect(t.s.reset()).toEqual({ ...DEFAULT_FACE_TUNING, customized: false, calibrated_at: null });
    expect(t.changes()).toBe(2);
    t.cleanup();
  });

  it("rejects a merged range that is too narrow without writing anything", () => {
    const t = store();
    expect(() => t.s.update({ near_min_m: 1.4 })).toThrow(FaceTuningError);
    expect(t.s.view().near_min_m).toBe(0.6);
    expect(t.changes()).toBe(0);
    t.cleanup();
  });

  it("an unreadable or hand-edited file falls back to the defaults", () => {
    const t = store();
    writeFileSync(join(t.dir, "face-tuning.json"), "{not json");
    expect(new FaceTuningStore({ dir: t.dir, onChange: () => {}, log: () => {} }).view()).toMatchObject(DEFAULT_FACE_TUNING);
    writeFileSync(join(t.dir, "face-tuning.json"), JSON.stringify({ schema_version: 1, prefs: { near_min_m: 1.4, near_max_m: 1.5, min_face_px: 20 } }));
    expect(new FaceTuningStore({ dir: t.dir, onChange: () => {}, log: () => {} }).view()).toEqual({ ...DEFAULT_FACE_TUNING, customized: false, calibrated_at: null });
    t.cleanup();
  });
});

describe("face metrics (src/sense/face/quality.ts)", () => {
  function face(over: Partial<YuNetFace> = {}, lm?: [number, number][]): YuNetFace {
    const pts = (lm ?? [[600, 300], [680, 300], [640, 340], [610, 380], [670, 380]]).map(([x, y]) => ({ x, y }));
    return { box: { x: 560, y: 220, width: 160, height: 200 }, score: 0.92, landmarks: pts as unknown as YuNetFace["landmarks"], ...over };
  }
  const mid = () => 120;

  it("judgeMetrics(faceMetrics(face)) gives the same reason as assessQuality", () => {
    const cases: [YuNetFace, () => number][] = [
      [face(), mid],
      [face({ box: { x: 560, y: 220, width: 99, height: 120 } }), mid],
      [face({ box: { x: 560, y: -10, width: 160, height: 200 } }), mid],
      [face({ score: 0.7 }), mid],
      [face({}, [[600, 300], [680, 300], [672, 340], [610, 380], [670, 380]]), mid],
      [face({}, [[600, 300], [670, 345], [640, 340], [600, 380], [650, 410]]), mid],
      [face(), () => 10],
    ];
    for (const [f, luma] of cases) expect(judgeMetrics(faceMetrics(f, 1280, 720, luma))).toBe(assessQuality([f], 1280, 720, luma).reason);
  });

  it("reports which edge the face crosses (for the 'move the camera up' hint) and a lower size limit lets a smaller face pass", () => {
    expect(faceMetrics(face({ box: { x: 560, y: -10, width: 160, height: 200 } }), 1280, 720, mid).edge).toBe("top");
    const small = faceMetrics(face({ box: { x: 560, y: 220, width: 80, height: 100 } }), 1280, 720, mid);
    expect(judgeMetrics(small)).toBe("too_small");
    expect(judgeMetrics(small, { ...QUALITY_DEFAULTS, min_face_px: 75 })).toBe("ok");
  });
});

describe("calibration measurements and suggestions (src/face-calibration.ts)", () => {
  const good = (face_px: number, yaw = 0.05): FrameSample => ({ quality: "ok", face_count: 1, metrics: { face_px, score: 0.9, yaw, pitch: 0.5, roll_deg: 2, luma: 120, edge: null } satisfies FaceMetrics });
  function spot(frames: FrameSample[], distance: number | null, facing = 1, present = 1, observations: ("matched" | "unknown")[] = []) {
    const rec = new SpotRecorder();
    for (const f of frames) rec.addFrame(f);
    for (let i = 0; i < 20; i++) rec.addSense({ present: i < 20 * present, facing: i < 20 * facing, distance_m: distance });
    for (const o of observations) rec.addObservation(o);
    return { recorder: rec, summary: summarizeSpot(rec) };
  }

  it("percentile uses the nearest rank", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.2)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 0.8)).toBe(4);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("Mac 2026-10-31: seated 0.8 m sees the face; standing 1.4 m sees a body but no face → advice and a range that covers the seat", () => {
    const seat = spot(Array.from({ length: 20 }, () => good(140)), 0.8, 0.9, 1, ["matched"]);
    const stand = spot(Array.from({ length: 20 }, () => ({ quality: "no_face", face_count: 0 }) as FrameSample), 1.4);
    expect(seat.summary).toMatchObject({ distance_m: 0.8, face_ratio: 1, ok_ratio: 1, recognized: "yes", face_px: 140 });
    expect(spotUsable(seat.summary)).toBe(true);
    expect(spotUsable(stand.summary)).toBe(false);
    expect(spotAdvice(stand.summary)[0]).toMatch(/找不到臉/);
    const next = suggestTuning([seat, stand], DEFAULT_FACE_TUNING);
    expect(next).toMatchObject({ near_min_m: 0.6, near_max_m: 1.05, min_face_px: 100, max_yaw_offset: 0.2, facing_yaw_ratio: 0.2, facing_grace_ms: 800 });
    expect(tuningChanges(DEFAULT_FACE_TUNING, next)).toEqual({ near_max_m: 1.05 });
  });

  it("small faces, turned faces and poor facing loosen the matching limits, within their bounds", () => {
    const frames = Array.from({ length: 20 }, (_, i) => good(70 + i, i < 10 ? 0.1 : 0.24));
    const far = spot(frames, 1.7, 0.6);
    const near = spot(Array.from({ length: 20 }, () => good(150)), 0.45, 0.4);
    const next = suggestTuning([far, near], DEFAULT_FACE_TUNING);
    expect(next.near_min_m).toBe(0.3);
    expect(next.near_max_m).toBe(1.95);
    expect(next.min_face_px).toBe(70); // 第 20 百分位 77 → ×0.9 = 69 → 對到 70（不低於 60）
    expect(next.max_yaw_offset).toBe(0.27);
    expect(next.facing_yaw_ratio).toBe(0.3);
    expect(next.facing_grace_ms).toBe(1500);
    expect(() => checkFaceTuning(next)).not.toThrow();
  });

  it("the face crossing the top edge, a second face, darkness and not being recognised each get their own advice", () => {
    const top = spot(Array.from({ length: 10 }, () => ({ quality: "out_of_frame", face_count: 1, metrics: { ...good(120).metrics!, edge: "top" } }) as FrameSample)
      .concat(Array.from({ length: 10 }, () => ({ quality: "no_face", face_count: 0 }) as FrameSample)), 1.2);
    expect(spotAdvice(top.summary).join(" ")).toMatch(/上緣/);
    const busy = spot(Array.from({ length: 10 }, (_, i) => (i < 4 ? { quality: "multi_face", face_count: 2 } : { quality: "too_dark", face_count: 1, metrics: good(130).metrics }) as FrameSample), 0.9, 1, 1, ["unknown"]);
    const advice = spotAdvice(busy.summary).join(" ");
    expect(advice).toMatch(/第二張臉/);
    expect(advice).toMatch(/太暗/);
    expect(busy.summary.recognized).toBe("no");
  });

  it("with no usable spot the current values stay as they are", () => {
    const custom: FaceTuning = { ...DEFAULT_FACE_TUNING, near_max_m: 1.2 };
    expect(suggestTuning([spot([], null)], custom)).toEqual(custom);
    expect(spotAdvice(spot([], null).summary)).toEqual(["沒有取到畫面：確認鏡頭有在運作"]);
  });
});

describe("CalibrationPanel (src/face-calibration-view.ts)", () => {
  class El {
    children: (El | string)[] = [];
    attributes = new Map<string, string>();
    listeners = new Map<string, (() => void)[]>();
    disabled = false;
    width = 0;
    height = 0;
    className = "";
    constructor(readonly tagName: string) {}
    setAttribute(k: string, v: string) { this.attributes.set(k, v); }
    append(...nodes: (El | string)[]) { this.children.push(...nodes); }
    addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
    click(label: string) {
      const b = this.all().find((e) => e.tagName === "button" && e.textContent === label);
      if (!b) throw new Error(`no button ${label}: ${this.all().filter((e) => e.tagName === "button").map((e) => e.textContent).join("/")}`);
      if (b.disabled) throw new Error(`button ${label} is disabled`);
      for (const fn of b.listeners.get("click") ?? []) fn();
    }
  }

  it("measures a spot for 6 s, skips the rest, and applies only the changed values as a calibration", async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
    try {
      const { CalibrationPanel } = await import("../src/face-calibration-view.ts");
      const clock = { now: 0 };
      const hooks: { tick: (() => void) | null; onFrame: ((f: import("../src/sense/identity-client.ts").ClientFrame) => void) | null; options: import("../src/sense/identity-protocol.ts").FrameOptions | null } = { tick: null, onFrame: null, options: null };
      const previews: unknown[] = [];
      const applied: unknown[] = [];
      let tuning = { ...DEFAULT_FACE_TUNING, customized: false, calibrated_at: null as string | null };
      const panel = new CalibrationPanel({
        startSampling: (fn, opts) => { hooks.onFrame = fn; hooks.options = opts(); },
        stopSampling: () => { hooks.onFrame = null; },
        probe: async () => "matched",
        hasPeople: () => true,
        clientLine: () => null,
        sense: () => ({ present: true, facing: true, distance_m: 0.8 }),
        preview: (t) => previews.push(t),
        tuning: () => tuning,
        applyTuning: async (change, calibrated) => { applied.push({ change, calibrated }); tuning = { ...tuning, ...(change as object), customized: true }; return null; },
        changed: () => {},
        back: () => {},
      }, { now: () => clock.now, setInterval: (fn) => { hooks.tick = fn; return 1; }, clearInterval: () => { hooks.tick = null; } });
      panel.open();
      expect(previews).toHaveLength(1);
      (panel.render() as unknown as El).click("開始量測");
      expect(hooks.options).toMatchObject({ metrics: true, quality: { min_face_px: 100, max_yaw_offset: 0.2 } });
      for (let i = 0; i < 30; i++) {
        clock.now += 200;
        hooks.onFrame?.({ gen: 1, t: clock.now, face_count: 1, quality: "ok", feature: new Float32Array(128).fill(0.1), metrics: { face_px: 140, score: 0.9, yaw: 0.05, pitch: 0.5, roll_deg: 2, luma: 120, edge: null } });
        await Promise.resolve();
        hooks.tick?.();
      }
      expect(hooks.tick).toBeNull(); // 6 秒到了自動停止
      const afterFirst = panel.render() as unknown as El;
      expect(afterFirst.textContent).toMatch(/位置 2／3/);
      expect(afterFirst.textContent).toMatch(/0\.80 m/);
      expect(afterFirst.textContent).toMatch(/認得/);
      afterFirst.click("跳過這個位置");
      (panel.render() as unknown as El).click("跳過這個位置");
      const summary = panel.render() as unknown as El;
      expect(summary.textContent).toMatch(/1\.05 m/);
      summary.click("套用建議");
      await Promise.resolve();
      await Promise.resolve();
      expect(applied).toEqual([{ change: { near_max_m: 1.05 }, calibrated: true }]);
      expect((panel.render() as unknown as El).textContent).toMatch(/已套用/);
      panel.close();
      expect(previews.at(-1)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
