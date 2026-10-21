// 雙目鏡頭感知管線（docs/11 §4）：瀏覽器／Electron 內執行，影像只在本機。
// 2560×720 併排影像 → 切左右 1280×720 → MediaPipe Pose（左右各一）＋手勢辨識（左）→ SenseProcessor → 事件。
// 不保存、不上傳任何影像；離開這個模組的只有 SenseEvent。

import type { CameraSettings, SenseEvent } from "../../shared/sense.ts";
import { SenseProcessor } from "./processor.ts";

const EYE_W = 1280;
const EYE_H = 720;
/** 約 12 fps：足夠判斷在場、手勢與指向，CPU 負擔較低。 */
const FRAME_INTERVAL_MS = 80;
/** 超過這麼久沒有新影像就回報降級。 */
const STALE_MS = 1000;

/** 由 `npm run vision:setup` 放到前端 public 目錄（不進 git）。 */
export const VISION_ASSETS = {
  wasm: "/vision/wasm",
  pose: "/vision/models/pose_landmarker_full.task",
  gesture: "/vision/models/gesture_recognizer.task",
};

type Emit = (event: SenseEvent) => void;

interface Landmarker {
  detectForVideo(image: HTMLCanvasElement, ts: number): { landmarks: { x: number; y: number; visibility?: number }[][] };
  close(): void;
}
interface Recognizer {
  recognizeForVideo(image: HTMLCanvasElement, ts: number): { gestures: { categoryName: string; score: number }[][] };
  close(): void;
}

export class SensePipeline {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private poseL: Landmarker | null = null;
  private poseR: Landmarker | null = null;
  private gesture: Recognizer | null = null;
  private processor: SenseProcessor;
  private readonly canvasL = document.createElement("canvas");
  private readonly canvasR = document.createElement("canvas");
  private lastFrameAt = 0;
  private lastTs = 0;
  private degraded = false;
  private generation = 0;

  constructor(
    private readonly settings: CameraSettings,
    private readonly emit: Emit,
  ) {
    this.processor = new SenseProcessor({ width_mm: settings.screen_width_mm, offset_mm: settings.screen_offset_mm });
    for (const c of [this.canvasL, this.canvasR]) {
      c.width = EYE_W;
      c.height = EYE_H;
    }
  }

  get running(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    const generation = ++this.generation;
    this.emit({ type: "sensor", state: "starting", detail: "鏡頭啟動中" });
    try {
      const stream = await openStereoCamera(this.settings.label);
      if (generation !== this.generation) {
        stopStream(stream);
        return;
      }
      this.stream = stream;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this.video = video;
      await this.loadModels();
      if (generation !== this.generation) return;
      this.processor = new SenseProcessor({ width_mm: this.settings.screen_width_mm, offset_mm: this.settings.screen_offset_mm });
      this.timer = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
      this.lastFrameAt = performance.now();
      this.emit({ type: "sensor", state: "ok", detail: "鏡頭運作中（影像只在本機處理）" });
    } catch (err) {
      this.stop(false);
      this.emit({ type: "sensor", state: "error", detail: describeError(err) });
    }
  }

  /** 釋放鏡頭；回報 off，並清除在場、面向與指向狀態。 */
  stop(report = true): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.poseL?.close();
    this.poseR?.close();
    this.gesture?.close();
    this.poseL = this.poseR = null;
    this.gesture = null;
    if (report) {
      this.emit({ type: "sensor", state: "off", detail: "鏡頭已關閉" });
      this.emit({ type: "presence", present: false, distance_m: null });
      this.emit({ type: "attention", facing: false });
      this.emit({ type: "pointing", zone: null });
    }
  }

  private async loadModels(): Promise<void> {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(VISION_ASSETS.wasm);
    const poseOptions = {
      baseOptions: { modelAssetPath: VISION_ASSETS.pose, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numPoses: 1,
    };
    try {
      this.poseL = (await vision.PoseLandmarker.createFromOptions(fileset, poseOptions)) as unknown as Landmarker;
      this.poseR = (await vision.PoseLandmarker.createFromOptions(fileset, poseOptions)) as unknown as Landmarker;
      this.gesture = (await vision.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: VISION_ASSETS.gesture, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      })) as unknown as Recognizer;
    } catch (err) {
      throw new Error(`視覺模型載入失敗（請先執行 npm run vision:setup）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private tick(): void {
    const video = this.video;
    if (!video || !this.poseL || !this.poseR || !this.gesture) return;
    const now = performance.now();
    if (video.readyState < 2 || video.videoWidth < EYE_W * 2) {
      if (now - this.lastFrameAt > STALE_MS) this.setDegraded(true, "鏡頭沒有輸出 2560×720 併排影像");
      return;
    }
    this.lastFrameAt = now;
    this.setDegraded(false, "");

    // 切左右眼；左右順序依設定（ADR-0005 待驗證哪一半是左眼）。
    const [first, second] = this.settings.left_first ? [this.canvasL, this.canvasR] : [this.canvasR, this.canvasL];
    first.getContext("2d")!.drawImage(video, 0, 0, EYE_W, EYE_H, 0, 0, EYE_W, EYE_H);
    second.getContext("2d")!.drawImage(video, EYE_W, 0, EYE_W, EYE_H, 0, 0, EYE_W, EYE_H);

    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    const toPixels = (r: { landmarks: { x: number; y: number; visibility?: number }[][] }) =>
      r.landmarks[0]?.map((p) => ({ x: p.x * EYE_W, y: p.y * EYE_H, visibility: p.visibility })) ?? null;
    const left = toPixels(this.poseL.detectForVideo(this.canvasL, ts));
    const right = left ? toPixels(this.poseR.detectForVideo(this.canvasR, ts)) : null;
    const gestures = left ? this.gesture.recognizeForVideo(this.canvasL, ts).gestures : [];
    const palm = gestures
      .flat()
      .filter((g) => g.categoryName === "Open_Palm")
      .reduce<number | null>((best, g) => (best === null || g.score > best ? g.score : best), null);

    for (const event of this.processor.process({ t: now, left, right, openPalm: palm })) this.emit(event);
  }

  private setDegraded(value: boolean, detail: string): void {
    if (value === this.degraded) return;
    this.degraded = value;
    this.emit(value ? { type: "sensor", state: "degraded", detail } : { type: "sensor", state: "ok", detail: "鏡頭運作中（影像只在本機處理）" });
    if (value) {
      this.emit({ type: "attention", facing: false });
      this.emit({ type: "pointing", zone: null });
    }
  }
}

/** 依名稱找雙目鏡頭；找不到時不改用其他鏡頭（避免誤開筆電的前鏡頭）。 */
async function openStereoCamera(label: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("這個環境不支援鏡頭存取");
  const constraints = (deviceId?: string): MediaStreamConstraints => ({
    audio: false,
    video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: EYE_W * 2 }, height: { ideal: EYE_H } },
  });
  // 先取得權限，裝置名稱才會出現在清單中。
  const probe = await navigator.mediaDevices.getUserMedia(constraints());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const target = devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(label.toLowerCase()));
  const current = probe.getVideoTracks()[0]?.getSettings().deviceId;
  if (target && target.deviceId === current) return probe;
  stopStream(probe);
  if (!target) throw new Error(`找不到名稱含「${label}」的鏡頭（NOUS_CAMERA_LABEL）`);
  return navigator.mediaDevices.getUserMedia(constraints(target.deviceId));
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") return "鏡頭權限被拒絕";
  if (err instanceof DOMException && err.name === "NotReadableError") return "鏡頭被其他程式占用";
  return err instanceof Error ? err.message : String(err);
}
