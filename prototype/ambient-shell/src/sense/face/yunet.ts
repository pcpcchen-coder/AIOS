// YuNet 人臉偵測的前後處理（純函式，不碰 DOM 或模型）。ID-00 spike 寫成、ID-01 搬進產品（docs/14、ADR-0001）：
// 家人辨識 worker（src/sense/identity-worker.ts）與 spike 頁共用這一份。
// 照 OpenCV 官方實作改寫：
// - 解碼與 padding：opencv/opencv modules/objdetect/src/face_detect.cpp（FaceDetectorYNImpl::postProcess、padWithDivisor），
//   查核 commit 048f050d5dca7385255583910af704c7c727ac9e。
// - NMS：同 repo modules/dnn/src/nms.cpp 與 nms.inl.hpp（NMSBoxes → NMSFast_，Rect2i 的 Jaccard 重疊）。
// - 模型：OpenCV Zoo face_detection_yunet（MIT）。2023mar 版輸入固定 1×3×640×640；2026may 版為動態高寬。

export interface Point {
  x: number;
  y: number;
}

/** 左上角＋寬高，單位為像素。 */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** OpenCV 輸出順序：右眼、左眼、鼻尖、右嘴角、左嘴角（以被拍者為準；在畫面上右眼位於較左側）。 */
export type FiveLandmarks = readonly [Point, Point, Point, Point, Point];

export interface YuNetFace {
  box: FaceBox;
  landmarks: FiveLandmarks;
  score: number;
}

/** 模型三個輸出尺度；順序同 OpenCV 的 output_names。 */
export const YUNET_STRIDES = [8, 16, 32] as const;
export const YUNET_DIVISOR = 32;

/** 每個 stride 的四組輸出（cls、obj 各 1 值，bbox 4 值，kps 10 值，皆為逐格展平）。 */
export interface YuNetStrideOutput {
  cls: ArrayLike<number>;
  obj: ArrayLike<number>;
  bbox: ArrayLike<number>;
  kps: ArrayLike<number>;
}

export interface YuNetOptions {
  /** OpenCV Zoo 範例預設 0.6（yunet.py confThreshold），不是本專案的校準值。 */
  scoreThreshold: number;
  /** OpenCV Zoo 範例預設 0.3。 */
  nmsThreshold: number;
  /** OpenCV Zoo 範例預設 5000。 */
  topK: number;
}

export const YUNET_DEFAULTS: YuNetOptions = { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 };

/** OpenCV：padW = ((inputW - 1) / divisor + 1) * divisor（整數除法）。 */
export function padToDivisor(size: number, divisor = YUNET_DIVISOR): number {
  return (Math.floor((size - 1) / divisor) + 1) * divisor;
}

/**
 * 原圖縮進固定輸入（2023mar 的 640×640）：等比縮放貼在左上角，右側與下方補 0。
 * 與 OpenCV「先 resize 到 inputSize，再 padWithDivisor 往右下補 0」的座標關係相同；回推原圖座標時除以 scale。
 */
export interface Letterbox {
  inputW: number;
  inputH: number;
  scale: number;
  drawnW: number;
  drawnH: number;
}

export function planLetterbox(srcW: number, srcH: number, inputW: number, inputH: number): Letterbox {
  if (srcW <= 0 || srcH <= 0) throw new Error(`invalid source size ${srcW}×${srcH}`);
  const scale = Math.min(inputW / srcW, inputH / srcH);
  return {
    inputW,
    inputH,
    scale,
    drawnW: Math.min(inputW, Math.round(srcW * scale)),
    drawnH: Math.min(inputH, Math.round(srcH * scale)),
  };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** FaceDetectorYNImpl::postProcess 的逐格解碼（NMS 前）。 */
export function decodeYuNet(outputs: readonly YuNetStrideOutput[], padW: number, padH: number, scoreThreshold: number): YuNetFace[] {
  if (outputs.length !== YUNET_STRIDES.length) throw new Error(`expected ${YUNET_STRIDES.length} stride outputs`);
  const faces: YuNetFace[] = [];
  YUNET_STRIDES.forEach((stride, i) => {
    const { cls, obj, bbox, kps } = outputs[i]!;
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
    if (cls.length < rows * cols) throw new Error(`stride ${stride}: expected ${rows * cols} cells, got ${cls.length}`);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(clamp01(cls[idx]!) * clamp01(obj[idx]!));
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]!) * stride;
        const cy = (r + bbox[idx * 4 + 1]!) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]!) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]!) * stride;
        const lm = [0, 1, 2, 3, 4].map((n) => ({
          x: (kps[idx * 10 + 2 * n]! + c) * stride,
          y: (kps[idx * 10 + 2 * n + 1]! + r) * stride,
        })) as unknown as FiveLandmarks;
        faces.push({ box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h }, landmarks: lm, score });
      }
    }
  });
  return faces;
}

/** OpenCV Rect2i：建構時各值以 int() 往 0 截斷。 */
function toIntRect(b: FaceBox): FaceBox {
  return { x: Math.trunc(b.x), y: Math.trunc(b.y), width: Math.trunc(b.width), height: Math.trunc(b.height) };
}

/** cv::jaccardDistance 的 1 - 距離；兩框面積和為 0 時 OpenCV 視為完全重疊。 */
export function rectOverlap(a: FaceBox, b: FaceBox): number {
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  if (areaA + areaB <= 0) return 1;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x1;
  const h = Math.min(a.y + a.height, b.y + b.height) - y1;
  const inter = w > 0 && h > 0 ? w * h : 0;
  return inter / (areaA + areaB - inter);
}

/**
 * cv::dnn::NMSBoxes（eta = 1）：分數嚴格大於門檻者依分數穩定排序（同分保留原順序），取前 topK，
 * 與任一已保留框重疊 > nmsThreshold 就丟棄。回傳保留的原始索引。框先截成整數，與 YuNet 呼叫時的 Rect2i 相同。
 */
export function nmsBoxes(boxes: readonly FaceBox[], scores: readonly number[], scoreThreshold: number, nmsThreshold: number, topK: number): number[] {
  if (boxes.length !== scores.length) throw new Error("boxes and scores length mismatch");
  const rects = boxes.map(toIntRect);
  let order = scores
    .map((score, index) => ({ score, index }))
    .filter((s) => s.score > scoreThreshold)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (topK > 0 && topK < order.length) order = order.slice(0, topK);
  const kept: number[] = [];
  for (const { index } of order) {
    if (kept.every((k) => rectOverlap(rects[index]!, rects[k]!) <= nmsThreshold)) kept.push(index);
  }
  return kept;
}

/** 解碼＋NMS；與 OpenCV 相同，只有一張以上候選時才跑 NMS。座標仍在模型輸入空間。 */
export function postProcessYuNet(outputs: readonly YuNetStrideOutput[], padW: number, padH: number, opts: YuNetOptions = YUNET_DEFAULTS): YuNetFace[] {
  const faces = decodeYuNet(outputs, padW, padH, opts.scoreThreshold);
  if (faces.length <= 1) return faces;
  const keep = nmsBoxes(
    faces.map((f) => f.box),
    faces.map((f) => f.score),
    opts.scoreThreshold,
    opts.nmsThreshold,
    opts.topK,
  );
  return keep.map((i) => faces[i]!);
}

/** 模型輸入座標 → 原畫格座標。 */
export function toSourceCoords(face: YuNetFace, scale: number): YuNetFace {
  const p = (q: Point): Point => ({ x: q.x / scale, y: q.y / scale });
  return {
    score: face.score,
    box: { x: face.box.x / scale, y: face.box.y / scale, width: face.box.width / scale, height: face.box.height / scale },
    landmarks: face.landmarks.map(p) as unknown as FiveLandmarks,
  };
}

/**
 * 整個畫格的 RGBA → YuNet 640 的輸入張量（NCHW、BGR、0–255）。照 OpenCV 的做法：先 cv::resize（INTER_LINEAR）
 * 到 drawnW×drawnH（8 位元輸出），再貼左上角、右下補 0。
 * ID-00 的 spike 用 canvas drawImage 縮放，插值和 OpenCV 不同、也沒有核對（ADR-0001 §10）；產品 worker 改用這個函式，
 * 不再依賴瀏覽器的縮放演算法，也少讀一次像素。
 * 座標對應同 cv::resize：sx = (dx + 0.5)·(srcW / dstW) − 0.5，超出邊界時夾到第一或最後一格。
 * 權重照 OpenCV 8U 線性插值的定點算法（imgproc/src/resize.cpp：11 位元係數，水平整數相乘，
 * 垂直 VResizeLinearVec_32s8u 的 ((S0>>4)·b0>>16) + ((S1>>4)·b1>>16) + 2 >> 2）。縮小時與 cv2.resize 逐像素相同
 * （tests/face-letterbox.test.ts）；放大時個別像素差 1（產品只會縮小）。
 */
export function letterboxToChw(rgba: ArrayLike<number>, srcW: number, srcH: number, lb: Letterbox, order: "rgb" | "bgr" = "bgr"): Float32Array {
  if (rgba.length < srcW * srcH * 4) throw new Error("rgba buffer too small");
  const plane = lb.inputW * lb.inputH;
  const out = new Float32Array(plane * 3);
  const xs = resizeAxis(lb.drawnW, srcW);
  const ys = resizeAxis(lb.drawnH, srcH);
  const [c0, c2] = order === "rgb" ? [0, 2] : [2, 0];
  const channels = [c0, 1, c2] as const;
  for (let y = 0; y < lb.drawnH; y++) {
    const r0 = ys.i0[y]! * srcW;
    const r1 = ys.i1[y]! * srcW;
    const b0 = ys.w0[y]!;
    const b1 = ys.w1[y]!;
    for (let x = 0; x < lb.drawnW; x++) {
      const p = xs.i0[x]!;
      const q = xs.i1[x]!;
      const a0 = xs.w0[x]!;
      const a1 = xs.w1[x]!;
      const o = y * lb.inputW + x;
      for (let k = 0; k < 3; k++) {
        const ch = channels[k]!;
        const s0 = rgba[(r0 + p) * 4 + ch]! * a0 + rgba[(r0 + q) * 4 + ch]! * a1;
        const s1 = rgba[(r1 + p) * 4 + ch]! * a0 + rgba[(r1 + q) * 4 + ch]! * a1;
        const v = ((((s0 >> 4) * b0) >> 16) + (((s1 >> 4) * b1) >> 16) + 2) >> 2;
        out[k * plane + o] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/** cv::resize INTER_LINEAR 一個軸的來源索引與 11 位元係數（OpenCV 以 float 計算 fx，這裡用 Math.fround 對齊）。 */
function resizeAxis(dst: number, src: number): { i0: Int32Array; i1: Int32Array; w0: Int32Array; w1: Int32Array } {
  const scale = src / dst;
  const i0 = new Int32Array(dst);
  const i1 = new Int32Array(dst);
  const w0 = new Int32Array(dst);
  const w1 = new Int32Array(dst);
  for (let d = 0; d < dst; d++) {
    const s = Math.fround((d + 0.5) * scale - 0.5);
    let s0 = Math.floor(s);
    let f = Math.fround(s - s0);
    if (s0 < 0) {
      s0 = 0;
      f = 0;
    }
    if (s0 >= src - 1) {
      s0 = src - 1;
      f = 0;
    }
    i0[d] = s0;
    i1[d] = Math.min(s0 + 1, src - 1);
    // OpenCV 是 saturate_cast<short>（cvRound：剛好 .5 時取偶數）；Math.round 是 .5 進位。兩者只在乘積剛好落在 .5 時差 1，
    // 2048 倍的權重落在 .5 需要 f 是 1/4096 的奇數倍，產品的 0.5 倍縮小不會遇到（golden 逐像素相同）。
    w0[d] = Math.round(Math.fround(Math.fround(1 - f) * 2048));
    w1[d] = 2048 - w0[d]!;
  }
  return { i0, i1, w0, w1 };
}
