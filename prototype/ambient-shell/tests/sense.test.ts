import { describe, expect, it } from "vitest";
import { AR0144_NOMINAL as CAL, isFacing, pointingZone, POSE, triangulate, type Landmark2, type Point3 } from "../src/sense/geometry.ts";
import { SenseProcessor } from "../src/sense/processor.ts";
import { LookToTalk, PresenceTracker, StopGestureDetector, ZoneStabilizer } from "../src/sense/trackers.ts";

// 合成的關鍵點：把已知 3D 點投影到左右眼，驗證幾何與時間濾波；不代表真實鏡頭或模型的表現。

const SCREEN = { width_mm: 398, offset_mm: 140 };

function project(p: Point3): { left: Landmark2; right: Landmark2 } {
  const u = CAL.cx + (CAL.fx * p.x) / p.z;
  const v = CAL.cy + (CAL.fy * p.y) / p.z;
  const d = (CAL.fx * CAL.baseline_mm) / p.z;
  return { left: { x: u, y: v, visibility: 0.9 }, right: { x: u - d, y: v, visibility: 0.9 } };
}

/** 2 m 外、面向鏡頭的人；可指定一隻手的手腕位置。 */
function person(opts: { z?: number; noseX?: number; wrist?: Point3 | null; raiseRight?: boolean } = {}) {
  const z = opts.z ?? 2000;
  const pts: Record<number, Point3> = {
    [POSE.nose]: { x: opts.noseX ?? 0, y: -200, z: z - 80 },
    [POSE.leftEye]: { x: 30, y: -220, z: z - 60 },
    [POSE.rightEye]: { x: -30, y: -220, z: z - 60 },
    [POSE.leftEar]: { x: 75, y: -210, z },
    [POSE.rightEar]: { x: -75, y: -210, z },
    [POSE.leftShoulder]: { x: 180, y: 0, z },
    [POSE.rightShoulder]: { x: -180, y: 0, z },
    [POSE.leftWrist]: { x: 200, y: 450, z },
    [POSE.rightWrist]: opts.raiseRight ? { x: -200, y: -250, z } : { x: -200, y: 450, z },
  };
  if (opts.wrist) pts[POSE.leftWrist] = opts.wrist;
  const left: Landmark2[] = [];
  const right: Landmark2[] = [];
  for (const [i, p] of Object.entries(pts)) {
    const pr = project(p);
    left[Number(i)] = pr.left;
    right[Number(i)] = pr.right;
  }
  return { left, right };
}

/** 手腕在肩膀往螢幕上 target 點方向 30% 的位置。 */
function wristToward(shoulder: Point3, target: Point3): Point3 {
  return { x: shoulder.x + 0.3 * (target.x - shoulder.x), y: shoulder.y + 0.3 * (target.y - shoulder.y), z: shoulder.z + 0.3 * (target.z - shoulder.z) };
}

describe("stereo geometry", () => {
  it("triangulates a point 2 m away back to its 3D position", () => {
    const p = { x: 100, y: -50, z: 2000 };
    const { left, right } = project(p);
    const q = triangulate(left, right)!;
    expect(q.z).toBeCloseTo(2000, 6);
    expect(q.x).toBeCloseTo(100, 6);
    expect(q.y).toBeCloseTo(-50, 6);
  });

  it("rejects tiny or negative disparity", () => {
    expect(triangulate({ x: 640, y: 360 }, { x: 635, y: 360 })).toBeNull();
    expect(triangulate({ x: 640, y: 360 }, { x: 660, y: 360 })).toBeNull();
  });

  it("pointing: camera +X is the user's left; thirds of the screen; arm must reach toward the screen", () => {
    const shoulder = { x: 180, y: 0, z: 2000 };
    expect(pointingZone(shoulder, wristToward(shoulder, { x: 0, y: 140, z: 0 }), SCREEN)).toBe("center");
    expect(pointingZone(shoulder, wristToward(shoulder, { x: 150, y: 140, z: 0 }), SCREEN)).toBe("left");
    expect(pointingZone(shoulder, wristToward(shoulder, { x: -150, y: 140, z: 0 }), SCREEN)).toBe("right");
    expect(pointingZone(shoulder, { x: 200, y: 450, z: 2000 }, SCREEN)).toBeNull();
    expect(pointingZone(shoulder, wristToward(shoulder, { x: 900, y: 140, z: 0 }), SCREEN)).toBeNull();
  });

  it("facing: nose near the midpoint of both visible ears", () => {
    const ear = (x: number, visibility = 0.9) => ({ x, y: 300, visibility });
    const lm = (noseX: number, earVis = 0.9): Landmark2[] => {
      const a: Landmark2[] = [];
      a[POSE.nose] = { x: noseX, y: 320, visibility: 0.9 };
      a[POSE.leftEar] = ear(680, earVis);
      a[POSE.rightEar] = ear(600);
      return a;
    };
    expect(isFacing(lm(640))).toBe(true);
    expect(isFacing(lm(670))).toBe(false);
    expect(isFacing(lm(640, 0.2))).toBe(false);
  });
});

describe("trackers", () => {
  it("presence: enters after 500 ms, reports median distance, leaves after 60 s unseen", () => {
    const t = new PresenceTracker();
    expect(t.update(0, true, 2000)).toBeNull();
    expect(t.update(400, true, 2000)).toBeNull();
    expect(t.update(500, true, 2000)).toEqual({ present: true, distance_m: 2 });
    expect(t.update(600, true, 2020)).toBeNull();
    expect(t.update(30_000, false, null)).toBeNull();
    expect(t.update(60_600, false, null)).toEqual({ present: false, distance_m: null });
  });

  it("presence ignores people outside 0.5–4 m", () => {
    const t = new PresenceTracker();
    for (let ms = 0; ms <= 2000; ms += 100) expect(t.update(ms, true, 5200)).toBeNull();
  });

  it("pointing zone needs 450 ms stable and clears after 1000 ms without a valid zone", () => {
    const z = new ZoneStabilizer();
    expect(z.update(0, "left")).toBeUndefined();
    expect(z.update(400, "left")).toBeUndefined();
    expect(z.update(450, "left")).toBe("left");
    expect(z.update(500, "right")).toBeUndefined();
    expect(z.update(950, "right")).toBe("right");
    expect(z.update(1500, null)).toBeUndefined();
    expect(z.update(1950, null)).toBe(null);
  });

  it("stop gesture fires once per raise, with a 2 s refractory period", () => {
    const g = new StopGestureDetector();
    expect(g.update(0, true)).toBe(false);
    expect(g.update(300, true)).toBe(true);
    expect(g.update(600, true)).toBe(false);
    expect(g.update(700, false)).toBe(false);
    expect(g.update(800, true)).toBe(false);
    expect(g.update(1100, true)).toBe(false);
    expect(g.update(1200, false)).toBe(false);
    expect(g.update(2400, true)).toBe(false);
    expect(g.update(2700, true)).toBe(true);
  });

  it("look-to-talk: 1.2 s facing while present starts talking, then a 10 s cooldown", () => {
    const l = new LookToTalk();
    const s = { present: true, facing: true, talking: false };
    expect(l.update(0, s)).toBe(false);
    expect(l.update(1199, s)).toBe(false);
    expect(l.update(1200, s)).toBe(true);
    expect(l.update(2500, s)).toBe(false);
    expect(l.update(3000, { ...s, facing: false })).toBe(false);
    l.ended(5000);
    expect(l.update(14_000, s)).toBe(false);
    expect(l.update(15_000, s)).toBe(false);
    expect(l.update(16_200, s)).toBe(true);
  });
});

describe("SenseProcessor", () => {
  function run(frames: { t: number; p: ReturnType<typeof person> | null; palm?: number | null }[]) {
    const proc = new SenseProcessor(SCREEN);
    return frames.flatMap(({ t, p, palm }) =>
      proc.process({ t, left: p?.left ?? null, right: p?.right ?? null, openPalm: palm ?? null }).map((e) => ({ t, ...e })),
    );
  }

  it("a person 2 m away facing the screen: presence with distance, then attention", () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({ t: i * 80, p: person() }));
    const events = run(frames);
    const presence = events.find((e) => e.type === "presence");
    expect(presence).toMatchObject({ present: true });
    expect((presence as { distance_m: number }).distance_m).toBeGreaterThan(1.9);
    expect((presence as { distance_m: number }).distance_m).toBeLessThan(2.1);
    expect(events.some((e) => e.type === "attention" && e.facing)).toBe(true);
  });

  it("pointing at the user's left of the screen yields a stable 'left' zone", () => {
    const shoulder = { x: 180, y: 0, z: 2000 };
    const wrist = wristToward(shoulder, { x: 150, y: 140, z: 0 });
    const frames = Array.from({ length: 20 }, (_, i) => ({ t: i * 80, p: person({ wrist }) }));
    const pointing = run(frames).filter((e) => e.type === "pointing");
    expect(pointing).toEqual([expect.objectContaining({ type: "pointing", zone: "left" })]);
  });

  it("open palm with a raised hand stops speech once; without a raised hand it does nothing", () => {
    const raised = Array.from({ length: 15 }, (_, i) => ({ t: i * 80, p: person({ raiseRight: true }), palm: 0.9 }));
    expect(run(raised).filter((e) => e.type === "gesture")).toHaveLength(1);
    const lowered = Array.from({ length: 15 }, (_, i) => ({ t: i * 80, p: person(), palm: 0.9 }));
    expect(run(lowered).filter((e) => e.type === "gesture")).toHaveLength(0);
  });

  it("events never carry image data or coordinates", () => {
    const frames = Array.from({ length: 20 }, (_, i) => ({ t: i * 80, p: person({ raiseRight: true }), palm: 0.9 }));
    for (const e of run(frames)) {
      const keys = Object.keys(e).filter((k) => k !== "t");
      expect(keys.every((k) => ["type", "present", "distance_m", "facing", "kind", "zone", "state", "detail"].includes(k))).toBe(true);
    }
  });
});
