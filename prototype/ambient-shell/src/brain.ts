import { DOMAINS, REGION_COLOR, regionMap, regionOf, type Domain } from "../shared/domain.ts";
import type { RegionActivity } from "./region-activity.ts";
import { RENDER_BUDGETS, type FrameStats, type RenderBudget } from "./performance.ts";
import { AMBER, CYAN, DEPTH_BUCKETS, MINT, PULSE_STRIDE, VIOLET, depthAlpha, emptyRegionCenters, mix, rgbKey, type BrainFrame, type Pulse, type RGB } from "./brain-frame.ts";
import { CanvasBrainRenderer, rgbString, type BrainRenderer, type RendererKind } from "./brain-canvas.ts";
import { createWebGLRenderer } from "./brain-webgl.ts";
export { REGION_COLOR } from "../shared/domain.ts";

// 電子腦待機視覺：粒子與神經連線組成的雙半球腦，緩慢呼吸與旋轉。
// 光脈衝只由真實事件觸發（交辦、步驟開始／完成、串流輸出、成功、失敗），
// 不用循環動畫假裝任務仍在推進。

export type PulseKind = "submit" | "step" | "stream" | "stepDone" | "success" | "error";

export interface BrainVisualState {
  conversation: "idle" | "listening" | "thinking" | "speaking" | "error";
  listening: boolean;
  /** 有任務正在執行（真實任務狀態）。 */
  working: boolean;
  layout: "center" | "top";
  /** 前景任務的真實完成比例 0–1；未知時為 null，不畫進度環。 */
  progress: number | null;
  /** Independent task, topic and actual audio owners determine sustained region focus. */
  activity?: readonly RegionActivity[];
  /**
   * 即時語音的連線狀態：connecting 時外圈琥珀色虛線慢轉（還不能說話）；live 時整顆腦依腦區上色、外圈換成薄荷綠
   * （George 2026-10-31：只有右上角的字不夠明顯，不知道何時該說話）。沒有即時語音時為 off 或省略。
   */
  voice?: "off" | "connecting" | "live";
  /**
   * 背景處理中（George 2026-11-02）：有任務真的在執行（running）或即時語音的查詢還沒回來時為 true（src/processing-cue.ts）。
   * 整顆腦保持「思考中」的青色並緩慢呼吸；排隊或取消中不算。Nous 說話或錯誤時以那兩種樣子為準。
   */
  processing?: boolean;
}

/** 處理中的青色保持量：0.45 ± 0.1、週期 2 秒（減少動態時固定 0.45）；不在處理中、或正在說話／錯誤時為 0。 */
export const PROCESSING_TINT = { base: 0.45, swing: 0.1, periodS: 2, energy: 0.65 } as const;

export function processingHold(state: Pick<BrainVisualState, "processing" | "conversation">, time: number, reduced: boolean): number {
  if (!state.processing || state.conversation === "speaking" || state.conversation === "error") return 0;
  if (reduced) return PROCESSING_TINT.base;
  return PROCESSING_TINT.base + PROCESSING_TINT.swing * Math.sin((2 * Math.PI * time) / PROCESSING_TINT.periodS);
}

/** 處理中時的最低亮度：對話閒置或聆聽時至少和「思考中」一樣（0.65）。 */
export function processingEnergy(state: Pick<BrainVisualState, "processing" | "conversation">): number {
  return state.processing && (state.conversation === "idle" || state.conversation === "listening") ? PROCESSING_TINT.energy : 0;
}

interface Node3 {
  x: number;
  y: number;
  z: number;
  /** 0 左半球、1 右半球、2 小腦、3 腦幹。 */
  group: number;
  inner: boolean;
  /** 所屬腦區；小腦與腦幹不屬於任何區。 */
  region: Domain | null;
}

interface Part {
  group: number;
  c: readonly [number, number, number];
  r: readonly [number, number, number];
  count: number;
  fold: number;
}

/** 腦的組成：兩個大腦半球（含顳葉）、小腦與腦幹。z 為前（+）後（−）。 */
const PARTS: readonly Part[] = [
  { group: 0, c: [-0.36, 0.1, 0], r: [0.39, 0.6, 0.95], count: 300, fold: 0.07 },
  { group: 1, c: [0.36, 0.1, 0], r: [0.39, 0.6, 0.95], count: 300, fold: 0.07 },
  { group: 0, c: [-0.42, -0.3, 0.15], r: [0.3, 0.3, 0.6], count: 80, fold: 0.05 },
  { group: 1, c: [0.42, -0.3, 0.15], r: [0.3, 0.3, 0.6], count: 80, fold: 0.05 },
  { group: 2, c: [0, -0.5, -0.68], r: [0.5, 0.24, 0.3], count: 110, fold: 0.03 },
  { group: 3, c: [0, -0.78, -0.32], r: [0.13, 0.32, 0.13], count: 40, fold: 0 },
];

function insideEllipsoid(x: number, y: number, z: number, p: Part): boolean {
  return ((x - p.c[0]) / p.r[0]) ** 2 + ((y - p.c[1]) / p.r[1]) ** 2 + ((z - p.c[2]) / p.r[2]) ** 2 < 0.97;
}

/** 繪製方式的實際狀態：requested 是設定、active 是真的在用的；fallback 說明為什麼沒用 WebGL。 */
export type RendererFallback = "unavailable" | "context-lost";
export interface RendererStatus {
  requested: RendererKind;
  active: RendererKind;
  fallback: RendererFallback | null;
  /** 給開發者看的原因（console 與驗證文件）；不顯示在畫面上。 */
  detail: string | null;
}

const INNER_PER_HEMISPHERE = 30;
/** 小腦偏紫、腦幹偏青；半球依左右漸層（未列者）。 */
const GROUP_COLOR: Record<number, RGB | undefined> = { 2: mix(CYAN, VIOLET, 0.8), 3: CYAN };
/** 從左前上方的 3/4 角度觀看，左右擺動幅度。 */
const YAW_BASE = 1.95;
const YAW_SWING = 0.5;
const PITCH = -0.5;
/** 腦形本身比外圈光環略小；放大以填滿原本的半徑。 */
const SHAPE_SCALE = 1.18;
const NEIGHBORS = 3;
/** 實測每秒格數與繪製時間的視窗。 */
const STATS_WINDOW_MS = 2000;
/** 外圈軌道（1.62 R）加呼吸（1.018）與餘裕：不放大時整個圖形，包含淡淡的軌道，都留在視窗內。 */
export const ORBIT_FIT_EXTENT = 1.7;
/**
 * 靠近放大時要留在視窗內的範圍（相對於 R，水平 x／垂直 y）。只有淡淡的裝飾軌道可以超出視窗邊緣：
 * - 腦形本身：投影後最遠約水平 1.22 R（左；右 1.19 R）、往上 1.07 R、往下只有 0.78 R（含呼吸與粒子大小；
 *   tests/brain-distance.test.ts 檢查粒子不出視窗），取 1.25／1.1。上下不對稱：限制放大的是往上的 1.07 R，
 *   下緣離底邊還有空間（1920×1080、R = 461.5 時下緣約 865 px）。
 * - 有真實進度環時（progress 不是 null）：進度環 1.45 R 加呼吸與餘裕，取 1.5，進度的起點（正上方）不會被切掉。
 * 若仍用 ORBIT_FIT_EXTENT，16:9 視窗最多只能放大約 1.38 倍，看不出差別。聆聽光環（1.32 R）在放大很多時上下緣可能超出視窗，左右仍看得到。
 */
export const ZOOM_FIT_EXTENT = { body: { x: 1.25, y: 1.1, down: 0.85 }, progress: { x: 1.5, y: 1.5, down: 1.5 } } as const;

/**
 * 放大到原位（0.47 高）放不下時，往畫面正中間移（George 2026-10-25）：腦形可以用整個視窗高度，
 * 下緣可以延伸到「開始語音對話」按鈕、提示字、字幕與對話狀態的後面（它們是 DOM，疊在 Canvas 之上，仍點得到）。
 * - 腦形的框是往上 y、往下 down（相對於 R；腦形往下只有 0.78 R，取 0.85，和 HIT_EXTENT.down 相同）；
 *   框的中心（看起來的中心）在 cy + (down − y) ÷ 2 × R。
 * - 上限 R = min(cx ÷ x, h ÷ (y + down))：16:9 是 h ÷ 1.95（1920×1080 約 2.56 倍）。這時框貼齊上下緣，看起來的中心在 h ÷ 2。
 * - 3 倍在任何橫式視窗都放不完整：腦形高 1.95 × 0.6 h ≈ 1.17 h，比視窗還高。
 * 原位時沿用上下都 y 的舊規則（2 倍以內不變）。有真實進度環時不移動（進度環下方是任務字幕）。
 */
export function zoomCenter(height: number, homeCy: number, home: number, max: number, r: number, fit: { y: number; down: number }): number {
  const offset = (fit.down - fit.y) / 2;
  const t = max > home ? Math.min(1, Math.max(0, (r - home) / (max - home))) : 1;
  // 看起來的中心從原位走到 h ÷ 2，(1 − t)² 的曲線：一開始就離開頂端（比貼頂下滑快），最後平順停在正中間。
  const from = homeCy + offset * home;
  const visual = height / 2 - (height / 2 - from) * (1 - t) ** 2;
  return Math.min(Math.max(visual - offset * r, fit.y * r), height - fit.down * r);
}

/**
 * 點擊範圍（相對於 R）：腦形量到的範圍加一點餘裕。原本是 1.35 R 的圓，2 倍時半徑 583 px（1920×1080），
 * 幾乎蓋滿畫面，點腦形下方的空白也會開對話。腦形上下不對稱，所以上、下分開：
 * - 量到的腦形（tests/brain-distance.test.ts 用粒子範圍檢查）：左 1.22 R、右 1.19 R、上 1.07 R、下 0.78 R。
 * - 加 0.03–0.07 R 餘裕（1 倍時 R = 216 px，約 7–16 px）：水平 1.25、上 1.1、下 0.85。1 倍時點腦形邊緣仍點得到。
 */
export const HIT_EXTENT = { x: 1.25, up: 1.1, down: 0.85 } as const;

/** 與 CSS 共用的版面參數：中心高度比例與半徑（相對於 min(寬, 高)）。 */
export const LAYOUT = {
  center: { cy: 0.47, r: 0.2 },
  top: { cy: 0.12, r: 0.07 },
} as const;

/**
 * 電子腦的中心與半徑（CSS 像素）。兩個比例分開：
 * - 待機（center）只用 zoom：靠近放大（controller.ts brainZoom，George 2026-10-23）。不再跟字級的 D ÷ 2 m。
 * - 頂端縮略圖（top）仍用字級的 textScale：內容面板的位置（--surface-top × --distance-scale）跟著它，
 *   放大縮略圖會蓋住面板。
 * 半徑受視窗限制：不放大時整個軌道都在視窗內（ORBIT_FIT_EXTENT），放大時改以腦形或進度環為界（ZOOM_FIT_EXTENT）。
 * 放大到原位放不下時，中心往畫面正中間移（zoomCenter）：半徑與中心都只是 zoom 的連續函數，
 * 所以移動也只由真實距離事件驅動，Brain.step() 用同一個緩動移過去；倍率變小時照原路回到原位。
 */
export function brainGeometry(
  width: number,
  height: number,
  layout: BrainVisualState["layout"],
  zoom: number,
  textScale: number,
  progressRing = false,
): { cx: number; cy: number; r: number } {
  const l = LAYOUT[layout];
  const scale = layout === "center" ? zoom : textScale;
  const cx = width / 2;
  const cy = height * l.cy * (layout === "top" ? textScale : 1);
  const requested = Math.min(width, height) * l.r * scale;
  const zoomed = layout === "center" && zoom > 1;
  const fit = zoomed ? ZOOM_FIT_EXTENT[progressRing ? "progress" : "body"] : { x: ORBIT_FIT_EXTENT, y: ORBIT_FIT_EXTENT, down: ORBIT_FIT_EXTENT };
  const home = Math.max(0, Math.min(cx / fit.x, Math.min(cy, height - cy) / fit.y));
  if (!zoomed || requested <= home) return { cx, cy, r: Math.max(0, Math.min(requested, home)) };
  // 原位放不下：用整個視窗高度，中心跟著半徑往正中間移（zoomCenter）。進度環、受寬度限制的視窗留在原位。
  if (progressRing) return { cx, cy, r: home };
  const max = Math.min(cx / fit.x, height / (fit.y + fit.down));
  const r = Math.min(requested, max);
  if (r <= home) return { cx, cy, r: home };
  return { cx, cy: zoomCenter(height, cy, home, max, r, fit), r };
}

/**
 * 回憶模式的左下角（George 2026-11-07：原本整張 Canvas 用 CSS 縮成 0.32 倍、0.45 不透明度，線條變得又細又糊、幾乎看不見）。
 * 改成直接以角落的大小繪製：線條維持原本的 0.7–1.4 px，不經縮放取樣。
 * - 半徑 = 不放大時的待機半徑 × scale（1920×1080：216 × 0.5 = 108 px；1280×720：72 px；800×480：48 px）。
 * - 中心讓腦形左緣（HIT_EXTENT.x = 1.25 R）與下緣（HIT_EXTENT.down = 0.85 R）離視窗邊緣 margin（max(16 px, 1.6vw)）。
 *   腦形右緣約在 margin + 2.5 R（1920×1080 約 301 px；1280×720 約 200 px），在 3:2 橫式照片左緣（約 324／216 px）之外；
 *   照片最大 86vw × 78vh，更寬的照片（16:9）或 800×480 小螢幕上，照片左下角可能蓋到腦形右緣一小塊（照片在上層）。
 */
export const MEMORIES_CORNER = { scale: 0.5, marginPx: 16, marginVw: 0.016 } as const;

export function memoriesCornerGeometry(width: number, height: number): { cx: number; cy: number; r: number } {
  const r = brainGeometry(width, height, "center", 1, 1).r * MEMORIES_CORNER.scale;
  const margin = Math.max(MEMORIES_CORNER.marginPx, width * MEMORIES_CORNER.marginVw);
  return { cx: margin + r * HIT_EXTENT.x, cy: height - margin - r * HIT_EXTENT.down, r };
}

export class Brain {
  private ctx: CanvasRenderingContext2D;
  private nodes: Node3[] = [];
  private edges: [number, number][] = [];
  private adjacency: number[][] = [];
  private outerNodes: number[] = [];
  private regionNodes: Record<Domain, number[]> = regionMap(() => []);
  private regionEdges: Record<Domain, [number, number][]> = regionMap(() => []);
  /** 各腦區目前亮度（0–1），由真實事件推高、隨時間衰減。 */
  private activation: Record<Domain, number> = regionMap(() => 0);
  private pulses: Pulse[] = [];
  private projected = new Float32Array(0);
  /** 每個粒子不隨時間變的底色（RGB）。 */
  private nodeBase = new Float64Array(0);
  /** 連線每格分組用的暫存陣列（counting sort），每格不配置新陣列。 */
  private edgeBucket = new Uint8Array(0);
  private edgeNext = new Int32Array(DEPTH_BUCKETS);
  /** 每一格交給繪製的資料（src/brain-frame.ts）；預先配置、每格覆寫。 */
  private frame!: BrainFrame;
  private renderer: BrainRenderer;
  private readonly canvasRenderer: CanvasBrainRenderer;
  private requestedRenderer: RendererKind = "canvas";
  /** WebGL 建立失敗或中斷後，這次開啟的其餘時間都用 Canvas。 */
  private webglBlocked: { reason: RendererFallback; detail: string } | null = null;
  private allowSoftwareGL = false;
  /** 繪製方式真的變了（含 WebGL 中斷後自動改回 Canvas）時通知，設定頁的狀態列跟著更新。 */
  onRendererChange: ((status: RendererStatus) => void) | null = null;

  private state: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };
  private energy = 0.35;
  private listenLevel = 0;
  /** 即時語音接通的程度 0–1（緩動），與連線中的程度。 */
  private liveLevel = 0;
  private connectLevel = 0;
  private yaw = 0;
  private swing = 0;
  private time = 0;
  private tint: { color: RGB; strength: number } = { color: CYAN, strength: 0 };
  private cx = 0;
  private cy = 0;
  private radius = 0;
  /** 字級的距離比例（D ÷ 2 m）；只用在頂端縮略圖。 */
  private distanceScale = 1;
  /** 待機圖形的靠近放大倍率（brainZoom）。 */
  private zoom = 1;
  /** 已發布到 CSS 的 --brain-r（跟著畫面上的半徑一起緩動，下方的字幕與輸入框才不會先跳）。 */
  private ambientRadius = 0;
  /** 已發布到 CSS 的 --brain-cy（待機中心的高度；放大往中間移時跟著緩動）。 */
  private ambientCy = 0;
  private shownProgress = 0;
  /** 回憶模式播放中：電子腦退到左下角（memoriesCornerGeometry）。 */
  private corner = false;
  /** 處理中提示音的波紋（0–1 的進度；每次真的排了提示音才有，減少動態時不畫）。 */
  private cueRings: number[] = [];

  private width = 0;
  private height = 0;
  private lastFrame = 0;
  private raf = 0;
  private readonly reducedMotion: MediaQueryList;
  /** 這台裝置的畫面效能（src/performance.ts）；預設 full＝調整前的畫面。 */
  private budget: RenderBudget = RENDER_BUDGETS.full;
  /** 最近約 2 秒每一格的時間（rAF 時間戳）與 step＋draw 花的毫秒。 */
  private frameSamples: { at: number; ms: number }[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2D 不可用");
    this.ctx = ctx;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.canvasRenderer = new CanvasBrainRenderer(canvas, ctx);
    this.renderer = this.canvasRenderer;
    this.buildBrain();
    this.resize();
    const target = this.target();
    this.cx = target.cx;
    this.cy = target.cy;
    this.radius = target.r;
    window.addEventListener("resize", () => this.resize());
  }

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const elapsed = now - this.lastFrame;
      // 減少動態時降到約 10 FPS 且不旋轉；效能設定的上限更低時取較低者。
      const minFrame = Math.max(this.reducedMotion.matches ? 100 : 0, 1000 / this.budget.maxFps);
      // 留 2 ms 餘裕：上限剛好是螢幕更新間隔的倍數時，時間戳的微小抖動不會讓這一格多等一次更新（60 Hz 下省電才能真的到 12 格）。
      if (elapsed < minFrame - 2) return;
      this.lastFrame = now;
      const started = performance.now();
      this.step(Math.min(elapsed, 100) / 1000);
      this.draw();
      this.recordFrame(now, performance.now() - started);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** 換效能設定：立即生效，不重新載入。 */
  setRenderBudget(budget: RenderBudget): void {
    const pixelRatioChanged = budget.pixelRatioCap !== this.budget.pixelRatioCap;
    this.budget = budget;
    if (this.pulses.length > budget.maxPulses) this.pulses.splice(0, this.pulses.length - budget.maxPulses);
    if (pixelRatioChanged) this.resize();
    this.frameSamples = [];
  }

  /**
   * 「使用 GPU 繪製（WebGL）」：立即切換，不重新載入。WebGL 畫在另一張插在原畫布下方的畫布上，原畫布改當區名的透明疊層
   * （一張畫布不能同時有 2D 與 WebGL）。建立失敗（沒有硬體 WebGL、只有軟體）或中斷後，這次開啟的其餘時間都用 Canvas。
   * allowSoftware 只給量測腳本用（無頭 Chromium 只有 SwiftShader 軟體 WebGL）。
   */
  setRendererPreference(gpu: boolean, options: { allowSoftware?: boolean } = {}): RendererStatus {
    this.requestedRenderer = gpu ? "webgl" : "canvas";
    this.allowSoftwareGL = options.allowSoftware ?? false;
    this.applyRenderer();
    return this.rendererStatus();
  }

  rendererStatus(): RendererStatus {
    return {
      requested: this.requestedRenderer,
      active: this.renderer.kind,
      fallback: this.requestedRenderer === "webgl" && this.webglBlocked ? this.webglBlocked.reason : null,
      detail: this.webglBlocked?.detail ?? null,
    };
  }

  private applyRenderer(): void {
    const want: RendererKind = this.requestedRenderer === "webgl" && !this.webglBlocked ? "webgl" : "canvas";
    if (want === this.renderer.kind) return;
    this.renderer.dispose();
    this.renderer = this.canvasRenderer;
    if (want === "webgl") {
      const result = createWebGLRenderer(this.canvas, this.ctx, { allowSoftware: this.allowSoftwareGL, onContextLost: () => this.blockWebGL("context-lost", "webglcontextlost") });
      if (result.ok) this.renderer = result.renderer;
      else this.webglBlocked = { reason: "unavailable", detail: result.reason };
    }
    this.resize();
    this.frameSamples = [];
    if (this.webglBlocked) console.info(`[brain] WebGL 不可用，改用 Canvas：${this.webglBlocked.detail}`);
    this.onRendererChange?.(this.rendererStatus());
  }

  private blockWebGL(reason: RendererFallback, detail: string): void {
    if (this.webglBlocked) return;
    this.webglBlocked = { reason, detail };
    this.applyRenderer();
  }

  /** 實測的每秒格數與平均每格繪製時間（最近約 2 秒）；少於兩格時為 null。 */
  frameStats(): FrameStats | null {
    const samples = this.frameSamples;
    if (samples.length < 2) return null;
    const span = samples[samples.length - 1].at - samples[0].at;
    if (span <= 0) return null;
    const drawMs = samples.reduce((sum, s) => sum + s.ms, 0) / samples.length;
    return { fps: ((samples.length - 1) * 1000) / span, drawMs };
  }

  private recordFrame(at: number, ms: number): void {
    this.frameSamples.push({ at, ms });
    while (this.frameSamples.length > 1 && at - this.frameSamples[0].at > STATS_WINDOW_MS) this.frameSamples.shift();
  }

  /** 字級的距離比例（SenseHooks.setScale）：只影響頂端縮略圖。 */
  setDistanceScale(scale: number): void {
    this.distanceScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /**
   * 待機圖形的靠近放大倍率（SenseHooks.setBrainZoom）。只由實測距離事件與使用者設定驅動；
   * 畫面在 step() 裡緩動到新的大小：每幀 k = min(1, dt × 5)，30 fps 時時間常數約 0.2 秒、約 0.55 秒到 95%
   * （tests/brain-distance.test.ts 的 easing 測試）；減少動態效果時直接跳到。
   */
  setProximityZoom(factor: number): void {
    this.zoom = Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  setState(state: BrainVisualState): void {
    if (this.state.conversation !== state.conversation) {
      if (state.conversation === "speaking") this.tint = { color: VIOLET, strength: 0.8 };
      if (state.conversation === "thinking") this.tint = { color: CYAN, strength: 0.5 };
      if (state.conversation === "error") this.pulse("error");
    }
    this.state = state;
    const active = new Set(state.activity?.map((a) => a.domain));
    for (const d of DOMAINS) if (!active.has(d)) this.activation[d] = 0;
    this.pulses = this.pulses.filter((pulse) => !pulse.domain || active.has(pulse.domain));
  }

  /** 由真實事件觸發的光脈衝。 */
  /** domain 指定時，光脈衝從該腦區出發、使用該區顏色，並讓該區亮起。 */
  pulse(kind: PulseKind, domain: Domain | null = null): void {
    const spec: Record<PulseKind, { count: number; color: RGB }> = {
      submit: { count: 12, color: CYAN },
      step: { count: 4, color: CYAN },
      stream: { count: 1, color: VIOLET },
      stepDone: { count: 8, color: VIOLET },
      success: { count: 26, color: MINT },
      error: { count: 10, color: AMBER },
    };
    const { count, color } = spec[kind];
    const pulseColor = domain ? mix(color, REGION_COLOR[domain], 0.75) : color;
    for (let i = 0; i < count; i++) this.spawnPulse(pulseColor, domain);
    if (domain) {
      const boost = kind === "stream" ? 0.15 : kind === "step" || kind === "submit" ? 0.6 : 0.4;
      this.activation[domain] = Math.min(1, this.activation[domain] + boost);
    }
    if (kind === "success") this.tint = { color: MINT, strength: 1 };
    if (kind === "error") this.tint = { color: AMBER, strength: 1 };
  }

  /**
   * 處理中提示音真的排了一次（src/processing-cue.ts 的 onPing）：畫一圈淡淡的波紋。減少動態時不畫。
   * 不看 state.processing：第一響發生在 main.ts 的 render() 把 processing 交給 setState 之前；
   * 不在處理中時 step() 會把波紋清掉。
   */
  cuePing(): void {
    if (this.reducedMotion.matches) return;
    if (this.cueRings.length >= 3) this.cueRings.shift();
    this.cueRings.push(0);
  }

  /** 點擊座標（CSS 像素）是否落在電子腦上：貼著腦形的橢圓（HIT_EXTENT），上下分開。 */
  hitTest(x: number, y: number): boolean {
    const dy = y - this.cy;
    const rx = this.radius * HIT_EXTENT.x;
    const ry = this.radius * (dy < 0 ? HIT_EXTENT.up : HIT_EXTENT.down);
    if (rx <= 0 || ry <= 0) return false;
    return ((x - this.cx) / rx) ** 2 + (dy / ry) ** 2 < 1;
  }

  /**
   * 回憶模式播放中退到左下角（true）或回到原位（false）。和其他大小變化一樣在 step() 裡緩動（約 0.55 秒到 95%），
   * 減少動態效果時直接跳到。CSS 的 --brain-r／--brain-cy 仍是待機的值（字幕與按鈕的位置不跟著跑）。
   */
  setMemoriesCorner(on: boolean): void {
    this.corner = on;
  }

  /** 角落的中心（CSS 像素）：照片從這裡浮現、退回這裡。 */
  memoriesCorner(): { x: number; y: number } {
    const c = memoriesCornerGeometry(this.width, this.height);
    return { x: c.cx, y: c.cy };
  }

  private target(layout?: BrainVisualState["layout"]): { cx: number; cy: number; r: number } {
    if (layout === undefined && this.corner) return memoriesCornerGeometry(this.width, this.height);
    return brainGeometry(this.width, this.height, layout ?? this.state.layout, this.zoom, this.distanceScale, this.state.progress !== null);
  }

  /**
   * 待機半徑與中心高度發布到 CSS（--brain-r、--brain-cy）：下方字幕、輸入框、按鈕依它們排位置。
   * 放大到要往畫面正中間移時（zoomCenter）中心才離開 47vh。
   */
  private publishAmbient(r: number, cy: number): void {
    this.ambientRadius = r;
    this.ambientCy = cy;
    document.documentElement.style.setProperty("--brain-r", `${r}px`);
    document.documentElement.style.setProperty("--brain-cy", `${cy}px`);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.budget.pixelRatioCap);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.resize(this.width, this.height, dpr);
    const ambient = this.target("center");
    this.publishAmbient(ambient.r, ambient.cy);
    // 回憶模式角落的位置給 CSS 的光暈（body::before）用；只隨視窗大小改變。
    const corner = memoriesCornerGeometry(this.width, this.height);
    const css = document.documentElement.style;
    css.setProperty("--brain-corner-x", `${corner.cx}px`);
    css.setProperty("--brain-corner-y", `${corner.cy}px`);
    css.setProperty("--brain-corner-r", `${corner.r}px`);
  }

  private buildBrain(): void {
    const rand = mulberry32(20261019);
    const golden = Math.PI * (3 - Math.sqrt(5));
    PARTS.forEach((part, index) => {
      for (let i = 0; i < part.count; i++) {
        // 在單位球上均勻取點，再加上腦回皺褶後伸縮成該部位的橢球。
        const y0 = 1 - (i / (part.count - 1)) * 2;
        const ring = Math.sqrt(1 - y0 * y0);
        const u = golden * i;
        const v = Math.acos(y0);
        const fold =
          1 + part.fold * (Math.sin(11 * u + 4 * v) * Math.sin(7 * v) + 0.5 * Math.sin(17 * v + 3 * u)) + (rand() - 0.5) * 0.02;
        const x = part.c[0] + Math.cos(u) * ring * part.r[0] * fold;
        const y = part.c[1] + y0 * part.r[1] * fold;
        const z = part.c[2] + Math.sin(u) * ring * part.r[2] * fold;
        // 落在其他部位內部的點捨棄，只留下聯集的外表面。
        if (PARTS.some((other, j) => j !== index && insideEllipsoid(x, y, z, other))) continue;
        this.nodes.push({ x, y, z, group: part.group, inner: false, region: null });
      }
    });
    for (const group of [0, 1]) {
      const hemi = PARTS[group];
      for (let i = 0; i < INNER_PER_HEMISPHERE; i++) {
        const u = rand() * 2 - 1;
        const t = rand() * Math.PI * 2;
        const r = 0.2 + rand() * 0.5;
        const s = Math.sqrt(1 - u * u);
        this.nodes.push({
          x: hemi.c[0] + Math.cos(t) * s * r * hemi.r[0],
          y: hemi.c[1] + u * r * hemi.r[1],
          z: hemi.c[2] + Math.sin(t) * s * r * hemi.r[2],
          group,
          inner: true,
          region: null,
        });
      }
    }

    // 置中並縮放到單位半徑。
    const axes = ["x", "y", "z"] as const;
    const mid = axes.map((a) => {
      const values = this.nodes.map((n) => n[a]);
      return (Math.max(...values) + Math.min(...values)) / 2;
    });
    const extent = Math.max(...this.nodes.map((n) => Math.hypot(n.x - mid[0], n.y - mid[1], n.z - mid[2])));
    for (const n of this.nodes) {
      n.x = (n.x - mid[0]) / extent;
      n.y = (n.y - mid[1]) / extent;
      n.z = (n.z - mid[2]) / extent;
    }
    this.outerNodes = this.nodes.flatMap((n, i) => (n.inner ? [] : [i]));
    for (const d of DOMAINS) this.regionNodes[d] = [];
    this.nodes.forEach((n, i) => {
      n.region = regionOf(n);
      if (n.region && !n.inner) this.regionNodes[n.region].push(i);
    });

    this.canvas.dataset.regionCounts = JSON.stringify(regionMap((d) => this.regionNodes[d].length));

    const n = this.nodes.length;
    const seen = new Set<string>();
    this.adjacency = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      const dists: [number, number][] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = this.nodes[j];
        // 只在同一部位內相連，保留左右半球之間的縱裂與小腦輪廓。
        if (a.group !== b.group) continue;
        dists.push([j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2]);
      }
      dists.sort((p, q) => p[1] - q[1]);
      for (const [j] of dists.slice(0, NEIGHBORS)) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.edges.push([i, j]);
        this.adjacency[i].push(j);
        this.adjacency[j].push(i);
      }
    }
    this.projected = new Float32Array(n * 3);
    this.edgeBucket = new Uint8Array(this.edges.length);
    this.nodeBase = new Float64Array(n * 3);
    this.nodes.forEach((node, i) => {
      const c = node.inner ? VIOLET : (GROUP_COLOR[node.group] ?? mix(CYAN, VIOLET, (node.x + 1) / 2));
      this.nodeBase.set(c, i * 3);
    });
    for (const d of DOMAINS) this.regionEdges[d] = [];
    for (const [i, j] of this.edges) {
      const r = this.nodes[i].region;
      if (r && r === this.nodes[j].region) this.regionEdges[r].push([i, j]);
    }
    const maxPulses = Math.max(...Object.values(RENDER_BUDGETS).map((b) => b.maxPulses));
    this.frame = {
      width: 0, height: 0, cx: 0, cy: 0, R: 0, bright: 0, time: 0, reduced: false, liveLevel: 0,
      glowInner: CYAN, glowInnerAlpha: 0, glowMid: CYAN, glowMidAlpha: 0, orbitAngle: [0, 0], orbitAlpha: 0,
      nodeCount: n,
      projected: this.projected,
      nodeInner: Uint8Array.from(this.nodes, (node) => (node.inner ? 1 : 0)),
      nodeKey: new Int32Array(n),
      nodeAlpha: new Float64Array(n),
      nodeSize: new Float64Array(n),
      glowEvery: 4,
      nodeGlowSize: 0,
      edgeEnds: Int32Array.from(this.edges.flat()),
      edgeOrder: new Int32Array(this.edges.length),
      edgeStarts: new Int32Array(DEPTH_BUCKETS + 1),
      edgeColor: CYAN,
      edgeAlpha: new Float64Array(DEPTH_BUCKETS),
      activation: this.activation,
      regionCenter: emptyRegionCenters(),
      regionEdges: this.regionEdges,
      pulses: this.pulses,
      pulseGeom: new Float64Array(maxPulses * PULSE_STRIDE),
      pulseGlowSize: 0,
      connectAlpha: 0, connectDash: [0, 0], connectDashOffset: 0,
      listenColor: CYAN, listenAlpha: 0, listenWidth: 0, listenShadowAlpha: 0, listenBlur: 0,
      cueRings: this.cueRings, progress: null, shownProgress: 0, labelShadow: true, activity: undefined,
    };
  }

  private spawnPulse(color: RGB, domain: Domain | null = null): void {
    while (this.pulses.length >= this.budget.maxPulses) this.pulses.shift();
    const pool = domain && this.regionNodes[domain].length ? this.regionNodes[domain] : this.outerNodes;
    let node = pool[Math.floor(Math.random() * pool.length)];
    const path = [node];
    const length = 7 + Math.floor(Math.random() * 8);
    for (let i = 0; i < length; i++) {
      const next = this.adjacency[node];
      if (next.length === 0) break;
      node = next[Math.floor(Math.random() * next.length)];
      path.push(node);
    }
    this.pulses.push({ path, t: 0, speed: 5 + Math.random() * 4, color, domain, stroke: rgbString(rgbKey(color)), sprite: null });
  }

  private step(dt: number): void {
    const reduced = this.reducedMotion.matches;
    this.time += dt;
    const phaseEnergy = { idle: 0.35, listening: 0.55, thinking: 0.65, speaking: 0.85, error: 0.3 }[this.state.conversation];
    const targetEnergy = Math.max(this.state.working ? 0.8 : 0, phaseEnergy, processingEnergy(this.state));
    this.energy += (targetEnergy - this.energy) * Math.min(1, dt * 2.5);
    this.listenLevel += ((this.state.listening ? 1 : 0) - this.listenLevel) * Math.min(1, dt * 6);
    this.liveLevel += ((this.state.voice === "live" ? 1 : 0) - this.liveLevel) * (reduced ? 1 : Math.min(1, dt * 3));
    this.connectLevel += ((this.state.voice === "connecting" ? 1 : 0) - this.connectLevel) * (reduced ? 1 : Math.min(1, dt * 4));
    // 左右緩慢擺動（而非整圈旋轉），讓兩個半球與中間的縱裂保持可見。
    if (!reduced) this.swing += dt * (0.12 + 0.35 * this.energy);
    this.yaw = YAW_BASE + YAW_SWING * Math.sin(this.swing);
    this.tint.strength = Math.max(0, this.tint.strength - dt * 0.45);
    // 背景處理中：青色保持在 0.35–0.55 之間緩慢呼吸；成功（薄荷綠）或失敗（琥珀）的閃色比它亮時先讓它們褪到這個水準。
    const hold = processingHold(this.state, this.time, reduced);
    if (hold > 0 && (this.tint.color === CYAN || this.tint.strength <= hold)) {
      this.tint = { color: CYAN, strength: this.tint.color === CYAN ? Math.max(hold, this.tint.strength) : hold };
    }
    this.cueRings = reduced || !this.state.processing ? [] : this.cueRings.map((t) => t + dt / 1.2).filter((t) => t < 1);
    // 腦區亮度：有持續焦點時維持在焦點水準，否則逐漸暗下。
    for (const d of DOMAINS) {
      const target = this.state.activity?.some((a) => a.domain === d) ? 0.75 : 0;
      const decayed = this.activation[d] - dt * 0.5;
      this.activation[d] = Math.max(target, decayed, 0);
    }

    const target = this.target();
    const k = reduced ? 1 : Math.min(1, dt * 5);
    this.cx += (target.cx - this.cx) * k;
    this.cy += (target.cy - this.cy) * k;
    this.radius += (target.r - this.radius) * k;
    // CSS 的待機半徑用同樣的緩動；差不到 0.5 px 時直接到位，避免每一幀都改樣式。
    const ambient = this.target("center");
    if (ambient.r !== this.ambientRadius || ambient.cy !== this.ambientCy) {
      const ease = (to: number, from: number) => {
        const next = from + (to - from) * k;
        return Math.abs(to - next) < 0.5 ? to : next;
      };
      this.publishAmbient(ease(ambient.r, this.ambientRadius), ease(ambient.cy, this.ambientCy));
    }

    if (this.state.progress !== null) {
      this.shownProgress += (this.state.progress - this.shownProgress) * (reduced ? 1 : Math.min(1, dt * 4));
    } else {
      this.shownProgress = 0;
    }

    for (const p of this.pulses) p.t += dt * (reduced ? 30 : p.speed);
    this.pulses = this.pulses.filter((p) => p.t < p.path.length - 1);
  }

  /** 算好這一格的繪製資料（BrainFrame），交給目前的繪製方式（Canvas 或 WebGL）。 */
  private draw(): void {
    const f = this.frame;
    const reduced = this.reducedMotion.matches;
    const breath = reduced ? 1 : 1 + 0.018 * Math.sin(this.time * 0.9);
    const R = this.radius * breath;
    const bright = 0.55 + 0.6 * this.energy;
    const live = this.liveLevel;
    f.width = this.width;
    f.height = this.height;
    f.cx = this.cx;
    f.cy = this.cy;
    f.R = R;
    f.bright = bright;
    f.time = this.time;
    f.reduced = reduced;
    f.liveLevel = live;
    f.glowInner = this.tinted(mix(VIOLET, MINT, 0.6 * live));
    f.glowInnerAlpha = (0.16 + 0.14 * live) * bright;
    f.glowMid = this.tinted(mix(CYAN, MINT, 0.5 * live));
    f.glowMidAlpha = (0.06 + 0.08 * live) * bright;
    f.orbitAngle[0] = 0.35 + (reduced ? 0 : this.time * 0.03);
    f.orbitAngle[1] = -0.5 + (reduced ? 0 : this.time * -0.02);
    f.orbitAlpha = 0.09 * bright;
    this.project(R);
    this.prepareRegions();
    this.prepareEdges(bright);
    this.prepareNodes(R, bright);
    this.preparePulses(R);
    this.prepareRings(R);
    f.activity = this.state.activity;
    this.renderer.draw(f);
  }

  /** 腦區的螢幕中心（投影後的平均位置）與前後深度；只算亮度 ≥ 0.02 的腦區。 */
  private prepareRegions(): void {
    const p = this.projected;
    for (const d of DOMAINS) {
      const center = this.frame.regionCenter[d];
      const idx = this.regionNodes[d];
      center.valid = this.activation[d] >= 0.02 && idx.length > 0;
      if (!center.valid) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const i of idx) {
        x += p[i * 3];
        y += p[i * 3 + 1];
        z += p[i * 3 + 2];
      }
      center.x = x / idx.length;
      center.y = y / idx.length;
      center.z = z / idx.length;
    }
  }

  /** 連線依前後深度分四組（counting sort，重複使用的陣列）。 */
  private prepareEdges(bright: number): void {
    const f = this.frame;
    const { projected: p, edgeEnds: ends, edgeOrder, edgeStarts: starts, edgeAlpha } = f;
    const { edgeBucket, edgeNext: next } = this;
    const count = ends.length / 2;
    starts.fill(0);
    for (let e = 0; e < count; e++) {
      const z = (p[ends[e * 2] * 3 + 2] + p[ends[e * 2 + 1] * 3 + 2]) / 2;
      const b = Math.min(3, Math.max(0, Math.floor((z + 1.2) / 0.6)));
      edgeBucket[e] = b;
      starts[b + 1]++;
    }
    for (let b = 1; b <= DEPTH_BUCKETS; b++) starts[b] += starts[b - 1];
    next.set(starts.subarray(0, DEPTH_BUCKETS));
    for (let e = 0; e < count; e++) edgeOrder[next[edgeBucket[e]]++] = e;
    f.edgeColor = this.tinted(mix(CYAN, MINT, 0.45 * this.liveLevel));
    for (let b = 0; b < DEPTH_BUCKETS; b++) edgeAlpha[b] = depthAlpha(-0.9 + b * 0.6) * (0.4 + 0.15 * this.liveLevel) * bright;
  }

  /** 每個粒子這一格的顏色（RGB 取整數）、透明度與大小。 */
  private prepareNodes(R: number, bright: number): void {
    const f = this.frame;
    const { projected: p, nodes } = this;
    const { nodeKey, nodeAlpha, nodeSize } = f;
    const size = Math.max(0.6, R / 140);
    const live = this.liveLevel > 0.01 ? 0.9 * this.liveLevel : 0;
    const tint = this.tint.strength > 0 ? this.tint.strength * 0.7 : 0;
    const [tr, tg, tb] = this.tint.color;
    const base = this.nodeBase;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let r = base[i * 3];
      let g = base[i * 3 + 1];
      let b = base[i * 3 + 2];
      // 即時語音接通：各腦區亮出自己的顏色，一眼看得出「腦子活起來了」。
      const region = node.region;
      if (region) {
        const rc = REGION_COLOR[region];
        if (live > 0) {
          r += (rc[0] - r) * live;
          g += (rc[1] - g) * live;
          b += (rc[2] - b) * live;
        }
        const act = this.activation[region];
        if (act > 0.01) {
          const t = Math.min(1, act * 1.1);
          r += (rc[0] - r) * t;
          g += (rc[1] - g) * t;
          b += (rc[2] - b) * t;
        }
      }
      if (tint > 0) {
        r += (tr - r) * tint;
        g += (tg - g) * tint;
        b += (tb - b) * tint;
      }
      nodeKey[i] = ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
      const z = p[i * 3 + 2];
      nodeAlpha[i] = depthAlpha(z) * bright;
      nodeSize[i] = size * (node.inner ? 0.9 : 1.2) * (1.3 - z * 0.4);
    }
    f.glowEvery = this.budget.glow === "full" ? 4 : 8;
    f.nodeGlowSize = size * 7;
  }

  private preparePulses(R: number): void {
    const f = this.frame;
    const p = this.projected;
    const geom = f.pulseGeom;
    f.pulses = this.pulses;
    f.pulseGlowSize = Math.max(6, R / 9) * (this.budget.glow === "full" ? 1 : 0.6);
    for (let k = 0; k < this.pulses.length; k++) {
      const pulse = this.pulses[k];
      const seg = Math.floor(pulse.t);
      const frac = pulse.t - seg;
      const a = pulse.path[seg];
      const b = pulse.path[seg + 1];
      const o = k * PULSE_STRIDE;
      geom[o] = p[a * 3];
      geom[o + 1] = p[a * 3 + 1];
      geom[o + 2] = p[a * 3] + (p[b * 3] - p[a * 3]) * frac;
      geom[o + 3] = p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * frac;
      geom[o + 4] = 1 - pulse.t / (pulse.path.length - 1);
    }
  }

  private prepareRings(R: number): void {
    const f = this.frame;
    const reduced = f.reduced;
    f.connectAlpha = this.connectLevel > 0.01 ? 0.6 * this.connectLevel : 0;
    f.connectDash[0] = R * 0.12;
    f.connectDash[1] = R * 0.08;
    f.connectDashOffset = reduced ? 0 : -this.time * R * 0.4;
    f.listenAlpha = 0;
    if (this.listenLevel > 0.01 || this.liveLevel > 0.01) {
      const level = Math.max(this.listenLevel, this.liveLevel);
      const beat = reduced ? 1 : 0.8 + 0.2 * Math.sin(this.time * 3);
      f.listenColor = mix(CYAN, MINT, this.liveLevel);
      f.listenAlpha = (0.45 + 0.35 * this.liveLevel) * level * beat;
      f.listenWidth = 2 + 2 * this.liveLevel;
      f.listenShadowAlpha = 0.8 * level;
      f.listenBlur = this.budget.ringBlur ? 18 + 14 * this.liveLevel : 0;
    }
    f.cueRings = this.cueRings;
    f.progress = this.state.progress;
    f.shownProgress = this.shownProgress;
    f.labelShadow = this.budget.glow === "full";
  }

  private project(R: number): void {
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const pitch = PITCH;
    const cosX = Math.cos(pitch);
    const sinX = Math.sin(pitch);
    const f = 3.4;
    const out = this.projected;
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      const x1 = p.x * cosY + p.z * sinY;
      const z1 = -p.x * sinY + p.z * cosY;
      const y2 = p.y * cosX - z1 * sinX;
      const z2 = p.y * sinX + z1 * cosX;
      const s = f / (f + z2);
      out[i * 3] = this.cx + x1 * R * s * SHAPE_SCALE;
      out[i * 3 + 1] = this.cy - y2 * R * s * SHAPE_SCALE;
      out[i * 3 + 2] = z2; // -1（近）… 1（遠）
    }
  }

  private tinted(color: RGB): RGB {
    return this.tint.strength > 0 ? mix(color, this.tint.color, this.tint.strength * 0.7) : color;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
