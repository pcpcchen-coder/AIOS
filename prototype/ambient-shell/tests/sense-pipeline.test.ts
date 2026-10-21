import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SenseEvent } from "../shared/sense.ts";

// 假的鏡頭、video、畫布與 MediaPipe（fixture，不是實機）：只驗證 start／stop 的狀態轉換與事件。

const closed: string[] = [];
let gateOn = false;
let releaseModels: (() => void) | null = null;

vi.mock("@mediapipe/tasks-vision", () => {
  const model = (name: string) => ({
    close: () => closed.push(name),
    detectForVideo: () => ({ landmarks: [] }),
    recognizeForVideo: () => ({ gestures: [] }),
  });
  const gate = () => (gateOn ? new Promise<void>((r) => (releaseModels = r)) : Promise.resolve());
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    PoseLandmarker: { createFromOptions: async () => (await gate(), model("pose")) },
    GestureRecognizer: { createFromOptions: async () => model("gesture") },
  };
});

const stopped: string[] = [];

beforeEach(() => {
  closed.length = 0;
  stopped.length = 0;
  gateOn = false;
  releaseModels = null;
  const track = { stop: () => stopped.push("track"), getSettings: () => ({ deviceId: "ccb" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal("document", {
    createElement: (tag: string) =>
      tag === "video" ? { play: async () => {}, readyState: 0, videoWidth: 0 } : { getContext: () => null },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => stream,
      enumerateDevices: async () => [{ kind: "videoinput", label: "CCB Camera", deviceId: "ccb" }],
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function make() {
  const { SensePipeline } = await import("../src/sense/pipeline.ts");
  const events: SenseEvent[] = [];
  const pipeline = new SensePipeline(
    { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 140 },
    (e) => events.push(e),
  );
  const states = () => events.filter((e) => e.type === "sensor").map((e) => (e as { state: string }).state);
  return { pipeline, events, states };
}

describe("SensePipeline start/stop (fixture camera)", () => {
  it("repeated start while starting or running emits nothing; stop reports off once", async () => {
    const { pipeline, states } = await make();
    const first = pipeline.start();
    await pipeline.start(); // 啟動中再呼叫（每次 settings.updated 的 syncCamera）
    await first;
    expect(states()).toEqual(["starting", "ok"]);
    expect(pipeline.running).toBe(true);
    await pipeline.start();
    expect(states()).toEqual(["starting", "ok"]);
    pipeline.stop();
    pipeline.stop();
    expect(states()).toEqual(["starting", "ok", "off"]);
    expect(stopped).toEqual(["track"]);
    expect(closed.sort()).toEqual(["gesture", "pose", "pose"]);
  });

  it("stop while models load reports off once and closes the models created afterwards", async () => {
    const { pipeline, states } = await make();
    gateOn = true;
    const starting = pipeline.start();
    await vi.waitFor(() => expect(releaseModels).not.toBeNull());
    pipeline.stop();
    expect(states()).toEqual(["starting", "off"]);
    gateOn = false;
    releaseModels!();
    await starting;
    expect(states()).toEqual(["starting", "off"]);
    expect(pipeline.running).toBe(false);
    expect(closed.sort()).toEqual(["gesture", "pose", "pose"]);
  });

  it("stop when never started emits nothing", async () => {
    const { pipeline, events } = await make();
    pipeline.stop();
    expect(events).toEqual([]);
  });
});
