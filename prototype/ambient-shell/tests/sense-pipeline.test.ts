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
interface FakeVideo {
  play(): Promise<void>;
  srcObject: unknown;
  readyState: number;
  videoWidth: number;
}
const videos: FakeVideo[] = [];
/** 設成 true 時，下一個 video.play() 會等到 releasePlay() 才完成。 */
let playGateOn = false;
let releasePlay: (() => void) | null = null;

beforeEach(() => {
  closed.length = 0;
  stopped.length = 0;
  videos.length = 0;
  gateOn = false;
  releaseModels = null;
  playGateOn = false;
  releasePlay = null;
  let opened = 0;
  const openStream = () => {
    const name = `track${++opened}`;
    const track = { stop: () => stopped.push(name), getSettings: () => ({ deviceId: "ccb" }) };
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "video") return { getContext: () => null };
      const gated = playGateOn;
      playGateOn = false;
      const video: FakeVideo = {
        play: () => (gated ? new Promise<void>((r) => (releasePlay = r)) : Promise.resolve()),
        srcObject: null,
        readyState: 0,
        videoWidth: 0,
      };
      videos.push(video);
      return video;
    },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => openStream(),
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
    expect(stopped).toEqual(["track1"]);
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

  it("quick off/on while the first video is still starting: the stale start releases its own stream and keeps the new video", async () => {
    const { pipeline, states } = await make();
    playGateOn = true;
    const first = pipeline.start();
    await vi.waitFor(() => expect(releasePlay).not.toBeNull());
    pipeline.stop(); // 關掉：釋放 track1
    const second = pipeline.start(); // 馬上又打開：track2、第二個 video
    await second;
    expect(pipeline.running).toBe(true);
    releasePlay!(); // 第一輪的 play() 現在才完成
    await first;
    const internal = pipeline as unknown as { video: unknown; stream: unknown };
    expect(internal.video).toBe(videos[1]);
    expect(videos[0].srcObject).toBeNull();
    expect(states()).toEqual(["starting", "off", "starting", "ok"]);
    expect(stopped).toEqual(["track1", "track1"]); // 只停舊串流（重複 stop 對真實 track 無害），新串流仍在用
    expect(closed).toEqual([]); // 第一輪沒有載入模型
    pipeline.stop();
    expect(stopped).toContain("track2");
    expect(closed.sort()).toEqual(["gesture", "pose", "pose"]);
  });

  it("stop when never started emits nothing", async () => {
    const { pipeline, events } = await make();
    pipeline.stop();
    expect(events).toEqual([]);
  });
});
