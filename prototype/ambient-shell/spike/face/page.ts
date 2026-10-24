// ID-00 spike 頁（開發工具，不是產品畫面、不是 App launcher 或 Dashboard）。docs/validation/family-id-00-spike-2026-10-24.md。
// 兩種輸入：(a) 使用者選的靜態圖片，(b) 本機鏡頭。兩者都只畫到本頁畫布、在記憶體推論；不寫檔、不送網路、不保存影像。
// 量測腳本 prototype/ambient-shell/scripts/face-spike-bench.mjs 透過 window.faceSpike 呼叫同一套流程；回傳的只有數字（框、耗時、cosine），不含像素或特徵向量。

import { compareBoxes, summarize, type TimingSummary } from "./metrics.ts";
import {
  configureOrt,
  context2d,
  MediaPipeRunner,
  ortThreads,
  readFrame,
  SFaceRunner,
  YuNetRunner,
  type MediaPipeFace,
  type MediaPipeVariant,
  type StageTiming,
  type YuNetVariant,
} from "./runtime.ts";
import { cosineSimilarity } from "./sface.ts";
import type { FaceBox, YuNetFace } from "./yunet.ts";

const FRAME_W = 1280;
const FRAME_H = 720;
const BACKGROUND = "#3a3a3a";
const CAMERA_INTERVAL_MS = 250;
const ROLLING = 120;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>("view");
const out = $<HTMLPreElement>("out");

interface Models {
  yunet: Partial<Record<YuNetVariant, YuNetRunner>>;
  mp: Partial<Record<MediaPipeVariant, MediaPipeRunner>>;
  sface: SFaceRunner | null;
  loadMs: Record<string, number>;
  errors: Record<string, string>;
  threads: number;
  crossOriginIsolated: boolean;
}

let models: Models | null = null;
let images: { name: string; bitmap: ImageBitmap }[] = [];
const frame = new OffscreenCanvas(FRAME_W, FRAME_H);

async function loadModels(opts: { threads: number; mpDelegate: "CPU" | "GPU" }): Promise<Models> {
  configureOrt(opts.threads);
  const m: Models = { yunet: {}, mp: {}, sface: null, loadMs: {}, errors: {}, threads: ortThreads(), crossOriginIsolated: globalThis.crossOriginIsolated === true };
  const record = async <T>(key: string, load: () => Promise<{ runner: T; loadMs: number }>): Promise<T | null> => {
    try {
      const { runner, loadMs } = await load();
      m.loadMs[key] = loadMs;
      return runner;
    } catch (err) {
      m.errors[key] = err instanceof Error ? err.message : String(err);
      return null;
    }
  };
  for (const v of ["fixed640", "dynamic"] as const) {
    const r = await record(`yunet_${v}`, () => YuNetRunner.load(v));
    if (r) m.yunet[v] = r;
  }
  for (const v of ["short", "full"] as const) {
    const r = await record(`mediapipe_${v}`, () => MediaPipeRunner.load(v, opts.mpDelegate));
    if (r) m.mp[v] = r;
  }
  m.sface = await record("sface", () => SFaceRunner.load());
  models = m;
  return m;
}

const largest = <F extends { box: FaceBox }>(faces: F[]): F | null => faces.reduce<F | null>((a, f) => (!a || f.box.width > a.box.width ? f : a), null);

/** 把圖片放進 1280×720 灰底畫格。faceWidth 為 null 時整張等比置中；否則縮放到 YuNet 臉寬約為該值，臉置中。 */
async function compose(bitmap: ImageBitmap, faceWidth: number | null): Promise<{ scale: number } | { error: string }> {
  const ctx = context2d(frame);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  const fit = Math.min(FRAME_W / bitmap.width, FRAME_H / bitmap.height);
  const drawAt = (scale: number, cx: number, cy: number): void => {
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, cx - w / 2, cy - h / 2, w, h);
  };
  drawAt(fit, FRAME_W / 2, FRAME_H / 2);
  if (faceWidth === null) return { scale: fit };
  const ref = models?.yunet.dynamic ?? models?.yunet.fixed640;
  if (!ref) return { error: "YuNet 未載入，無法依臉寬縮放" };
  const face = largest((await ref.detect(frame)).faces);
  if (!face) return { error: "原尺寸置入時 YuNet 找不到臉，無法依臉寬縮放" };
  // 臉在原圖中的中心與寬度（原圖像素）
  const ox = (FRAME_W - bitmap.width * fit) / 2;
  const oy = (FRAME_H - bitmap.height * fit) / 2;
  const srcCx = (face.box.x + face.box.width / 2 - ox) / fit;
  const srcCy = (face.box.y + face.box.height / 2 - oy) / fit;
  const scale = faceWidth / (face.box.width / fit);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  drawAt(scale, FRAME_W / 2 + (bitmap.width / 2 - srcCx) * scale, FRAME_H / 2 + (bitmap.height / 2 - srcCy) * scale);
  return { scale };
}

interface FrameAnalysis {
  yunet: Partial<Record<YuNetVariant, { faces: number; widths: number[]; scores: number[] }>>;
  mediapipe: Partial<Record<MediaPipeVariant, { faces: number; widths: number[]; scores: number[] }>>;
  /** YuNet 2023mar vs MediaPipe short range 的框差異 */
  boxDiff: ReturnType<typeof compareBoxes> | null;
  boxDiffFull: ReturnType<typeof compareBoxes> | null;
}

const round = (v: number, d = 1): number => Number(v.toFixed(d));
const describe = (faces: { box: FaceBox; score: number }[]) => ({ faces: faces.length, widths: faces.map((f) => round(f.box.width)), scores: faces.map((f) => round(f.score, 3)) });

async function analyze(): Promise<{ analysis: FrameAnalysis; yunetFaces: YuNetFace[]; mpFaces: MediaPipeFace[] }> {
  if (!models) throw new Error("模型尚未載入");
  const analysis: FrameAnalysis = { yunet: {}, mediapipe: {}, boxDiff: null, boxDiffFull: null };
  const byYuNet: Partial<Record<YuNetVariant, YuNetFace[]>> = {};
  for (const [v, r] of Object.entries(models.yunet) as [YuNetVariant, YuNetRunner][]) {
    byYuNet[v] = (await r.detect(frame)).faces;
    analysis.yunet[v] = describe(byYuNet[v]!);
  }
  const byMp: Partial<Record<MediaPipeVariant, MediaPipeFace[]>> = {};
  for (const [v, r] of Object.entries(models.mp) as [MediaPipeVariant, MediaPipeRunner][]) {
    byMp[v] = r.detect(frame).faces;
    analysis.mediapipe[v] = describe(byMp[v]!);
  }
  const yunetFaces = byYuNet.fixed640 ?? byYuNet.dynamic ?? [];
  if (byMp.short) analysis.boxDiff = compareBoxes(yunetFaces.map((f) => f.box), byMp.short.map((f) => f.box));
  if (byMp.full) analysis.boxDiffFull = compareBoxes(yunetFaces.map((f) => f.box), byMp.full.map((f) => f.box));
  return { analysis, yunetFaces, mpFaces: byMp.short ?? [] };
}

function draw(source: CanvasImageSource, yunetFaces: YuNetFace[], mpFaces: MediaPipeFace[]): void {
  const ctx = view.getContext("2d")!;
  ctx.drawImage(source, 0, 0, FRAME_W, FRAME_H);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#39d98a";
  ctx.fillStyle = "#39d98a";
  for (const f of yunetFaces) {
    ctx.strokeRect(f.box.x, f.box.y, f.box.width, f.box.height);
    for (const p of f.landmarks) ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.strokeStyle = "#ffb020";
  for (const f of mpFaces) ctx.strokeRect(f.box.x, f.box.y, f.box.width, f.box.height);
}

type Samples = Record<string, number[]>;
const push = (s: Samples, key: string, v: number | undefined): void => {
  if (v === undefined) return;
  (s[key] ??= []).push(v);
};
const pushTiming = (s: Samples, key: string, t: StageTiming): void => {
  push(s, `${key}.total`, t.total);
  push(s, `${key}.pre`, t.pre);
  push(s, `${key}.infer`, t.infer);
  push(s, `${key}.post`, t.post);
};
const summarizeAll = (s: Samples): Record<string, TimingSummary> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (({ n, median, p95, min, max }) => ({ n, median: round(median, 2), p95: round(p95, 2), min: round(min, 2), max: round(max, 2) }))(summarize(v))]));

/** 同一畫格重複量測；先跑 warmup 次不計入。SFace 以 YuNet 2023mar（沒有時用 2026may）的最大臉對齊。 */
async function benchFrame(iterations: number, warmup: number): Promise<Record<string, TimingSummary>> {
  if (!models) throw new Error("模型尚未載入");
  const samples: Samples = {};
  for (let i = 0; i < warmup + iterations; i++) {
    const keep = i >= warmup;
    let anchor: YuNetFace | null = null;
    for (const [v, r] of Object.entries(models.yunet) as [YuNetVariant, YuNetRunner][]) {
      const res = await r.detect(frame);
      if (keep) pushTiming(samples, `yunet_${v}`, res.timing);
      if (v === "fixed640" || !anchor) anchor = largest(res.faces) ?? anchor;
    }
    for (const [v, r] of Object.entries(models.mp) as [MediaPipeVariant, MediaPipeRunner][]) {
      const res = r.detect(frame);
      if (keep) pushTiming(samples, `mediapipe_${v}`, res.timing);
    }
    if (models.sface && anchor) {
      const read = readFrame(frame);
      const res = await models.sface.embed(read.rgba, FRAME_W, FRAME_H, anchor);
      if (keep) {
        push(samples, "frame_readback", read.ms);
        pushTiming(samples, "sface", res.timing);
      }
    }
  }
  return summarizeAll(samples);
}

/** 目前畫格最大臉的 SFace 特徵；只留在本頁記憶體。 */
async function embedLargest(): Promise<Float32Array | null> {
  if (!models?.sface) return null;
  const det = models.yunet.fixed640 ?? models.yunet.dynamic;
  if (!det) return null;
  const face = largest((await det.detect(frame)).faces);
  if (!face) return null;
  const { rgba } = readFrame(frame);
  return (await models.sface.embed(rgba, FRAME_W, FRAME_H, face)).feature;
}

interface ImageRun {
  image: string;
  faceWidthTarget: number | null;
  composeError?: string;
  analysis?: FrameAnalysis;
  timings?: Record<string, TimingSummary>;
}

async function runImageBench(opts: { faceWidths: (number | null)[]; iterations: number; warmup: number }) {
  if (!models) throw new Error("模型尚未載入");
  const runs: ImageRun[] = [];
  const cosine: Record<string, Record<string, number | null>> = {};
  for (const faceWidth of opts.faceWidths) {
    const features: (Float32Array | null)[] = [];
    for (const { name, bitmap } of images) {
      const run: ImageRun = { image: name, faceWidthTarget: faceWidth };
      const composed = await compose(bitmap, faceWidth);
      if ("error" in composed) {
        run.composeError = composed.error;
        features.push(null);
        runs.push(run);
        continue;
      }
      const { analysis, yunetFaces, mpFaces } = await analyze();
      run.analysis = analysis;
      run.timings = await benchFrame(opts.iterations, opts.warmup);
      features.push(await embedLargest());
      draw(frame, yunetFaces, mpFaces);
      runs.push(run);
    }
    const table: Record<string, number | null> = {};
    for (let i = 0; i < images.length; i++)
      for (let j = i + 1; j < images.length; j++) {
        const a = features[i];
        const b = features[j];
        table[`${images[i]!.name} × ${images[j]!.name}`] = a && b ? round(cosineSimilarity(a, b), 4) : null;
      }
    cosine[faceWidth === null ? "native" : String(faceWidth)] = table;
  }
  return {
    environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated: models.crossOriginIsolated, ortThreads: models.threads },
    loadMs: Object.fromEntries(Object.entries(models.loadMs).map(([k, v]) => [k, round(v, 1)])),
    loadErrors: models.errors,
    frame: `${FRAME_W}x${FRAME_H}`,
    runs,
    cosine,
  };
}

async function setImages(files: FileList | File[]): Promise<string[]> {
  for (const i of images) i.bitmap.close();
  images = [];
  for (const file of Array.from(files)) images.push({ name: file.name, bitmap: await createImageBitmap(file) });
  return images.map((i) => i.name);
}

// ── 鏡頭模式 ──────────────────────────────────────────────
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let generation = 0;
let reference: Float32Array | null = null;
let latestFeature: Float32Array | null = null;
let rolling: Samples = {};

function stopCamera(): void {
  generation++;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  reference = null;
  latestFeature = null;
  rolling = {};
  context2d(frame).clearRect(0, 0, FRAME_W, FRAME_H);
  view.getContext("2d")!.clearRect(0, 0, FRAME_W, FRAME_H);
  $("camera-status").textContent = "鏡頭已停止；畫格與參考特徵已清除";
}

async function startCamera(label: string): Promise<void> {
  stopCamera();
  const gen = generation;
  // 先開預設鏡頭取得權限（裝置名稱要有權限才看得到），名稱含 label 的鏡頭與預設不同時再關掉、改開那一支。
  // 所以按下後預設鏡頭會短暫亮起；同產品 pipeline.ts 的 openStereoCamera 做法。
  const constraints = (deviceId?: string): MediaStreamConstraints => ({ audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 2560 }, height: { ideal: 720 } } });
  let s = await navigator.mediaDevices.getUserMedia(constraints());
  const target = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "videoinput" && label && d.label.toLowerCase().includes(label.toLowerCase()));
  if (target && target.deviceId !== s.getVideoTracks()[0]?.getSettings().deviceId) {
    for (const t of s.getTracks()) t.stop();
    s = await navigator.mediaDevices.getUserMedia(constraints(target.deviceId));
  }
  if (gen !== generation) {
    for (const t of s.getTracks()) t.stop();
    return;
  }
  stream = s;
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = s;
  await video.play();
  $("camera-status").textContent = `鏡頭：${s.getVideoTracks()[0]?.label ?? "?"}（${video.videoWidth}×${video.videoHeight}${target ? "" : "；未找到指定名稱，使用預設鏡頭"}）`;
  void cameraLoop(gen);
}

/** 約 4 Hz、一次只有一個推論；世代不符（已停止或重開）時丟棄結果。 */
async function cameraLoop(gen: number): Promise<void> {
  while (gen === generation && video && models) {
    const started = performance.now();
    const v = video;
    const stereo = v.videoWidth >= 2 * FRAME_W && v.videoHeight === FRAME_H;
    const ctx = context2d(frame);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    // AR0144 併排 2560×720 時取左半（同產品管線預設 left_first）；其他鏡頭等比置入。
    if (stereo) ctx.drawImage(v, 0, 0, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
    else {
      const fit = Math.min(FRAME_W / v.videoWidth, FRAME_H / v.videoHeight);
      ctx.drawImage(v, (FRAME_W - v.videoWidth * fit) / 2, (FRAME_H - v.videoHeight * fit) / 2, v.videoWidth * fit, v.videoHeight * fit);
    }
    const yunet = models.yunet.fixed640 ?? models.yunet.dynamic;
    const mp = models.mp.short;
    const y = yunet ? await yunet.detect(frame) : null;
    const m = mp ? mp.detect(frame) : null;
    const mFull = models.mp.full ? models.mp.full.detect(frame) : null;
    if (gen !== generation) return;
    if (y) pushTiming(rolling, `yunet_${yunet!.variant}`, y.timing);
    if (m) pushTiming(rolling, "mediapipe_short", m.timing);
    if (mFull) pushTiming(rolling, "mediapipe_full", mFull.timing);
    const face = y ? largest(y.faces) : null;
    let cos: number | null = null;
    if (face && models.sface) {
      const read = readFrame(frame);
      const emb = await models.sface.embed(read.rgba, FRAME_W, FRAME_H, face);
      if (gen !== generation) return;
      push(rolling, "frame_readback", read.ms);
      pushTiming(rolling, "sface", emb.timing);
      latestFeature = emb.feature;
      if (reference) cos = cosineSimilarity(reference, emb.feature);
    } else latestFeature = null;
    for (const k of Object.keys(rolling)) rolling[k] = rolling[k]!.slice(-ROLLING);
    draw(frame, y?.faces ?? [], m?.faces ?? []);
    out.textContent = JSON.stringify(
      {
        mode: "camera（只在記憶體）",
        yunetFaces: y?.faces.map((f) => ({ width: round(f.box.width), score: round(f.score, 3) })),
        mediapipeFaces: m?.faces.map((f) => ({ width: round(f.box.width), score: round(f.score, 3) })),
        mediapipeFullFaces: mFull?.faces.map((f) => ({ width: round(f.box.width), score: round(f.score, 3) })),
        boxDiff: y && m ? compareBoxes(y.faces.map((f) => f.box), m.faces.map((f) => f.box)) : null,
        cosineToReference: cos === null ? null : round(cos, 4),
        timingsLastN: summarizeAll(rolling),
      },
      null,
      2,
    );
    const wait = Math.max(0, CAMERA_INTERVAL_MS - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}
// ── 介面 ──────────────────────────────────────────────
$("load").addEventListener("click", async () => {
  $("load-status").textContent = "載入中…";
  const m = await loadModels({ threads: Number($<HTMLInputElement>("threads").value) || 1, mpDelegate: $<HTMLSelectElement>("mp-delegate").value as "CPU" | "GPU" });
  $("load-status").textContent = `完成（onnxruntime 執行緒 ${m.threads}，crossOriginIsolated=${m.crossOriginIsolated}）`;
  out.textContent = JSON.stringify({ loadMs: m.loadMs, errors: m.errors }, null, 2);
});
$<HTMLInputElement>("images").addEventListener("change", async (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) out.textContent = `已讀入：${(await setImages(files)).join("、")}`;
});
$("run-images").addEventListener("click", async () => {
  const fw = $<HTMLSelectElement>("face-width").value;
  const report = await runImageBench({ faceWidths: [fw ? Number(fw) : null], iterations: Number($<HTMLInputElement>("iterations").value) || 20, warmup: 3 });
  out.textContent = JSON.stringify(report, null, 2);
});
$("camera-start").addEventListener("click", () => {
  startCamera($<HTMLInputElement>("camera-label").value).catch((err) => {
    $("camera-status").textContent = `鏡頭錯誤：${err instanceof Error ? err.message : String(err)}`;
  });
});
$("camera-stop").addEventListener("click", stopCamera);
$("camera-ref").addEventListener("click", () => {
  reference = latestFeature;
  $("camera-status").textContent = reference ? "已設定參考（只在記憶體；停止鏡頭即清除）" : "目前沒有可用的臉";
});
window.addEventListener("pagehide", stopCamera);

declare global {
  interface Window {
    faceSpike: {
      loadModels: typeof loadModels;
      setImages: typeof setImages;
      runImageBench: typeof runImageBench;
    };
  }
}
window.faceSpike = { loadModels: (o) => loadModels(o), setImages, runImageBench };
