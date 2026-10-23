import { DOMAINS, REGION_COLOR, regionMap, regionOf, type Domain } from "../shared/domain.ts";
import { activityDescription, type RegionActivity } from "./region-activity.ts";
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

interface Pulse {
  path: number[];
  t: number;
  speed: number;
  color: RGB;
  domain: Domain | null;
}

type RGB = readonly [number, number, number];

const CYAN: RGB = [92, 225, 255];
const VIOLET: RGB = [166, 139, 255];
const MINT: RGB = [92, 242, 176];
const AMBER: RGB = [255, 179, 92];

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
const FRAME_MS = 1000 / 30;
const MAX_PULSES = 70;
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
export const ZOOM_FIT_EXTENT = { body: { x: 1.25, y: 1.1 }, progress: { x: 1.5, y: 1.5 } } as const;

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
  const fit = layout === "center" && zoom > 1 ? ZOOM_FIT_EXTENT[progressRing ? "progress" : "body"] : { x: ORBIT_FIT_EXTENT, y: ORBIT_FIT_EXTENT };
  const room = Math.min(cx / fit.x, Math.min(cy, height - cy) / fit.y);
  return { cx, cy, r: Math.max(0, Math.min(requested, room)) };
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
  private sprite: HTMLCanvasElement;

  private state: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };
  private energy = 0.35;
  private listenLevel = 0;
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
  private shownProgress = 0;

  private width = 0;
  private height = 0;
  private lastFrame = 0;
  private raf = 0;
  private readonly reducedMotion: MediaQueryList;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2D 不可用");
    this.ctx = ctx;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.sprite = makeGlowSprite();
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
      // 減少動態時降到約 10 FPS 且不旋轉。
      const minFrame = this.reducedMotion.matches ? 100 : FRAME_MS;
      if (elapsed < minFrame) return;
      this.lastFrame = now;
      this.step(Math.min(elapsed, 100) / 1000);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
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

  /** 點擊座標（CSS 像素）是否落在電子腦上：貼著腦形的橢圓（HIT_EXTENT），上下分開。 */
  hitTest(x: number, y: number): boolean {
    const dy = y - this.cy;
    const rx = this.radius * HIT_EXTENT.x;
    const ry = this.radius * (dy < 0 ? HIT_EXTENT.up : HIT_EXTENT.down);
    if (rx <= 0 || ry <= 0) return false;
    return ((x - this.cx) / rx) ** 2 + (dy / ry) ** 2 < 1;
  }

  private target(layout = this.state.layout): { cx: number; cy: number; r: number } {
    return brainGeometry(this.width, this.height, layout, this.zoom, this.distanceScale, this.state.progress !== null);
  }

  /** 待機半徑發布到 CSS（--brain-r）：下方字幕、輸入框依它排位置。 */
  private publishAmbientRadius(r: number): void {
    this.ambientRadius = r;
    document.documentElement.style.setProperty("--brain-r", `${r}px`);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.publishAmbientRadius(this.target("center").r);
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
    for (const d of DOMAINS) this.regionEdges[d] = [];
    for (const [i, j] of this.edges) {
      const r = this.nodes[i].region;
      if (r && r === this.nodes[j].region) this.regionEdges[r].push([i, j]);
    }
  }

  /** 腦區的螢幕中心（投影後的平均位置）與前後深度。 */
  private regionCenter(d: Domain): { x: number; y: number; z: number } | null {
    const idx = this.regionNodes[d];
    if (!idx.length) return null;
    const p = this.projected;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const i of idx) {
      x += p[i * 3];
      y += p[i * 3 + 1];
      z += p[i * 3 + 2];
    }
    return { x: x / idx.length, y: y / idx.length, z: z / idx.length };
  }

  private drawRegionGlow(R: number): void {
    const { ctx } = this;
    for (const d of DOMAINS) {
      const a = this.activation[d];
      if (a < 0.02) continue;
      const c = this.regionCenter(d);
      if (!c) continue;
      const r = R * 0.62;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, rgba(REGION_COLOR[d], 0.32 * a));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    }
  }

  private drawRegionEdges(): void {
    const { ctx, projected: p } = this;
    ctx.lineWidth = 0.9;
    for (const d of DOMAINS) {
      const a = this.activation[d];
      if (a < 0.02) continue;
      ctx.strokeStyle = rgba(REGION_COLOR[d], 0.55 * a);
      ctx.beginPath();
      for (const [i, j] of this.regionEdges[d]) {
        if (p[i * 3 + 2] > 0.35 && p[j * 3 + 2] > 0.35) continue; // 背面的連線不加亮
        ctx.moveTo(p[i * 3], p[i * 3 + 1]);
        ctx.lineTo(p[j * 3], p[j * 3 + 1]);
      }
      ctx.stroke();
    }
  }

  /** 亮起的腦區旁標示名稱，讓人看得出現在處理的是哪一類內容。 */
  private drawRegionLabels(R: number): void {
    if (R < 60) return; // 縮小到頂端時不放字
    const { ctx } = this;
    const fontSize = Math.round(Math.max(12, R / 11));
    ctx.font = `500 ${fontSize}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const d of DOMAINS) {
      const a = this.activation[d];
      if (a < 0.25) continue;
      const c = this.regionCenter(d);
      if (!c) continue;
      // 標籤放在腦外側，以細線連回腦區中心
      const dx = c.x - this.cx;
      const dy = c.y - this.cy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const ex = this.cx + ux * R * 1.3;
      const ey = this.cy + uy * R * 1.2;
      const alpha = Math.min(1, (a - 0.2) * 1.6);
      ctx.strokeStyle = rgba(REGION_COLOR[d], 0.45 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.shadowColor = "rgba(2,6,16,0.9)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = rgba(REGION_COLOR[d], alpha);
      const descriptions = [...new Set(this.state.activity?.filter((a) => a.domain === d).map(activityDescription))];
      if (descriptions.length) {
        let text = descriptions.join(" / ");
        while (text.length > 1 && ctx.measureText(text).width > this.width - 24) text = `${text.slice(0, -2)}…`;
        const textWidth = ctx.measureText(text).width;
        const x = Math.max(12, Math.min(this.width - textWidth - 12, ux >= 0 ? ex + 6 : ex - textWidth - 6));
        const y = Math.max(fontSize, Math.min(this.height - fontSize, ey));
        ctx.fillText(text, x, y);
      }
      ctx.shadowBlur = 0;
    }
  }

  private spawnPulse(color: RGB, domain: Domain | null = null): void {
    if (this.pulses.length >= MAX_PULSES) this.pulses.shift();
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
    this.pulses.push({ path, t: 0, speed: 5 + Math.random() * 4, color, domain });
  }

  private step(dt: number): void {
    const reduced = this.reducedMotion.matches;
    this.time += dt;
    const phaseEnergy = { idle: 0.35, listening: 0.55, thinking: 0.65, speaking: 0.85, error: 0.3 }[this.state.conversation];
    const targetEnergy = Math.max(this.state.working ? 0.8 : 0, phaseEnergy);
    this.energy += (targetEnergy - this.energy) * Math.min(1, dt * 2.5);
    this.listenLevel += ((this.state.listening ? 1 : 0) - this.listenLevel) * Math.min(1, dt * 6);
    // 左右緩慢擺動（而非整圈旋轉），讓兩個半球與中間的縱裂保持可見。
    if (!reduced) this.swing += dt * (0.12 + 0.35 * this.energy);
    this.yaw = YAW_BASE + YAW_SWING * Math.sin(this.swing);
    this.tint.strength = Math.max(0, this.tint.strength - dt * 0.45);
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
    const ambient = this.target("center").r;
    if (ambient !== this.ambientRadius) {
      const next = this.ambientRadius + (ambient - this.ambientRadius) * k;
      this.publishAmbientRadius(Math.abs(ambient - next) < 0.5 ? ambient : next);
    }

    if (this.state.progress !== null) {
      this.shownProgress += (this.state.progress - this.shownProgress) * (reduced ? 1 : Math.min(1, dt * 4));
    } else {
      this.shownProgress = 0;
    }

    for (const p of this.pulses) p.t += dt * (reduced ? 30 : p.speed);
    this.pulses = this.pulses.filter((p) => p.t < p.path.length - 1);
  }

  private draw(): void {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);
    const reduced = this.reducedMotion.matches;
    const breath = reduced ? 1 : 1 + 0.018 * Math.sin(this.time * 0.9);
    const R = this.radius * breath;
    const bright = 0.55 + 0.6 * this.energy;

    // 中心光暈
    const glow = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, R * 1.9);
    glow.addColorStop(0, rgba(this.tinted(VIOLET), 0.16 * bright));
    glow.addColorStop(0.45, rgba(this.tinted(CYAN), 0.06 * bright));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(this.cx - R * 2, this.cy - R * 2, R * 4, R * 4);

    this.drawOrbits(R, bright);
    this.project(R);
    ctx.globalCompositeOperation = "lighter";
    this.drawRegionGlow(R);
    this.drawEdges(bright);
    this.drawRegionEdges();
    this.drawNodes(R, bright);
    this.drawPulses(R);
    ctx.globalCompositeOperation = "source-over";
    this.drawRegionLabels(R);
    this.drawRings(R);
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

  private depthAlpha(z: number): number {
    return Math.max(0.08, Math.min(1, 0.62 - z * 0.5));
  }

  private drawEdges(bright: number): void {
    const { ctx, projected: p } = this;
    const buckets: [number, number][][] = [[], [], [], []];
    for (const edge of this.edges) {
      const z = (p[edge[0] * 3 + 2] + p[edge[1] * 3 + 2]) / 2;
      const b = Math.min(3, Math.max(0, Math.floor((z + 1.2) / 0.6)));
      buckets[b].push(edge);
    }
    ctx.lineWidth = 0.7;
    buckets.forEach((edges, b) => {
      const z = -0.9 + b * 0.6;
      ctx.strokeStyle = rgba(this.tinted(CYAN), this.depthAlpha(z) * 0.4 * bright);
      ctx.beginPath();
      for (const [i, j] of edges) {
        ctx.moveTo(p[i * 3], p[i * 3 + 1]);
        ctx.lineTo(p[j * 3], p[j * 3 + 1]);
      }
      ctx.stroke();
    });
  }

  private drawNodes(R: number, bright: number): void {
    const { ctx, projected: p } = this;
    const size = Math.max(0.6, R / 140);
    for (let i = 0; i < this.nodes.length; i++) {
      const z = p[i * 3 + 2];
      const a = this.depthAlpha(z) * bright;
      const node = this.nodes[i];
      let color: RGB = node.inner ? VIOLET : (GROUP_COLOR[node.group] ?? mix(CYAN, VIOLET, (node.x + 1) / 2));
      const act = node.region ? this.activation[node.region] : 0;
      if (act > 0.01) color = mix(color, REGION_COLOR[node.region!], Math.min(1, act * 1.1));
      ctx.fillStyle = rgba(this.tinted(color), Math.min(1, a));
      const r = size * (node.inner ? 0.9 : 1.2) * (1.3 - z * 0.4);
      ctx.fillRect(p[i * 3] - r / 2, p[i * 3 + 1] - r / 2, r, r);
      if (z < -0.55 && !node.inner && i % 4 === 0) {
        const g = size * 7;
        ctx.globalAlpha = 0.25 * a;
        ctx.drawImage(this.sprite, p[i * 3] - g / 2, p[i * 3 + 1] - g / 2, g, g);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawPulses(R: number): void {
    const { ctx, projected: p } = this;
    const g = Math.max(6, R / 9);
    for (const pulse of this.pulses) {
      const seg = Math.floor(pulse.t);
      const frac = pulse.t - seg;
      const a = pulse.path[seg];
      const b = pulse.path[seg + 1];
      const x = p[a * 3] + (p[b * 3] - p[a * 3]) * frac;
      const y = p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * frac;
      const fade = 1 - pulse.t / (pulse.path.length - 1);
      ctx.strokeStyle = rgba(pulse.color, 0.55 * fade);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(p[a * 3], p[a * 3 + 1]);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 0.9 * fade;
      ctx.drawImage(tintSprite(this.sprite, pulse.color), x - g / 2, y - g / 2, g, g);
      ctx.globalAlpha = 1;
    }
  }

  private drawOrbits(R: number, bright: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.rotate((i === 0 ? 0.35 : -0.5) + (this.reducedMotion.matches ? 0 : this.time * (i === 0 ? 0.03 : -0.02)));
      ctx.strokeStyle = rgba(i === 0 ? CYAN : VIOLET, 0.09 * bright);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 1.62, R * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawRings(R: number): void {
    const { ctx } = this;
    // 聆聽光環
    if (this.listenLevel > 0.01) {
      ctx.strokeStyle = rgba(CYAN, 0.45 * this.listenLevel);
      ctx.lineWidth = 2;
      ctx.shadowColor = rgba(CYAN, 0.8 * this.listenLevel);
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R * 1.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // 前景任務的真實進度環（done / total）
    if (this.state.progress !== null) {
      const rr = R * 1.45;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (this.shownProgress > 0.001) {
        const grad = ctx.createLinearGradient(this.cx - rr, this.cy - rr, this.cx + rr, this.cy + rr);
        grad.addColorStop(0, rgba(CYAN, 0.95));
        grad.addColorStop(1, rgba(VIOLET, 0.95));
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.shownProgress);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
    }
  }

  private tinted(color: RGB): RGB {
    return this.tint.strength > 0 ? mix(color, this.tint.color, this.tint.strength * 0.7) : color;
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
}

function makeGlowSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(200,240,255,0.6)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

const tintCache = new Map<string, HTMLCanvasElement>();
function tintSprite(base: HTMLCanvasElement, color: RGB): HTMLCanvasElement {
  const key = color.join(",");
  let c = tintCache.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = base.width;
    const g = c.getContext("2d")!;
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = rgba(color, 1);
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-over";
    g.drawImage(base, 0, 0);
    tintCache.set(key, c);
  }
  return c;
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
