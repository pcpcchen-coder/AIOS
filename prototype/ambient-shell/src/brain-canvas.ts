import { DOMAINS, REGION_COLOR } from "../shared/domain.ts";
import { activityDescription } from "./region-activity.ts";
import { AMBER, CYAN, DEPTH_BUCKETS, PULSE_STRIDE, VIOLET, rgba, type BrainFrame, type RGB } from "./brain-frame.ts";

// 電子腦的 Canvas 2D 繪製（原本 brain.ts 的 draw()，畫面不變；docs/validation/brain-canvas-perf-2026-11-06.md 的像素比對仍適用）。
// WebGL 版（brain-webgl.ts）的區名也用這裡的 drawRegionLabels，畫在疊在上面的透明 2D 畫布上。

export type RendererKind = "canvas" | "webgl";

export interface BrainRenderer {
  readonly kind: RendererKind;
  /** CSS 像素與畫布解析度倍率（已套用效能設定的上限）。 */
  resize(width: number, height: number, dpr: number): void;
  draw(frame: BrainFrame): void;
  dispose(): void;
}

export class CanvasBrainRenderer implements BrainRenderer {
  readonly kind = "canvas";
  private readonly sprite = makeGlowSprite();
  private readonly keyCounts = new Map<number, number>();
  private nodeOrder = new Int32Array(0);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {}

  resize(width: number, height: number, dpr: number): void {
    sizeCanvas(this.canvas, width, height, dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  dispose(): void {
    clearCanvas(this.canvas, this.ctx);
  }

  draw(f: BrainFrame): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, f.width, f.height);
    const R = f.R;

    // 中心光暈
    const glow = ctx.createRadialGradient(f.cx, f.cy, 0, f.cx, f.cy, R * 1.9);
    glow.addColorStop(0, rgba(f.glowInner, f.glowInnerAlpha));
    glow.addColorStop(0.45, rgba(f.glowMid, f.glowMidAlpha));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(f.cx - R * 2, f.cy - R * 2, R * 4, R * 4);

    this.drawOrbits(f);
    ctx.globalCompositeOperation = "lighter";
    this.drawRegionGlow(f);
    this.drawEdges(f);
    this.drawRegionEdges(f);
    this.drawNodes(f);
    this.drawPulses(f);
    ctx.globalCompositeOperation = "source-over";
    drawRegionLabels(ctx, f);
    this.drawRings(f);
  }

  private drawRegionGlow(f: BrainFrame): void {
    const { ctx } = this;
    for (const d of DOMAINS) {
      const a = f.activation[d];
      if (a < 0.02) continue;
      const c = f.regionCenter[d];
      if (!c.valid) continue;
      const r = f.R * 0.62;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, rgba(REGION_COLOR[d], 0.32 * a));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    }
  }

  private drawRegionEdges(f: BrainFrame): void {
    const { ctx } = this;
    const p = f.projected;
    ctx.lineWidth = 0.9;
    for (const d of DOMAINS) {
      const a = f.activation[d];
      if (a < 0.02) continue;
      ctx.strokeStyle = rgba(REGION_COLOR[d], 0.55 * a);
      ctx.beginPath();
      for (const [i, j] of f.regionEdges[d]) {
        if (p[i * 3 + 2] > 0.35 && p[j * 3 + 2] > 0.35) continue; // 背面的連線不加亮
        ctx.moveTo(p[i * 3], p[i * 3 + 1]);
        ctx.lineTo(p[j * 3], p[j * 3 + 1]);
      }
      ctx.stroke();
    }
  }

  /** 連線依前後深度分四組（Brain 已排好），每組一條路徑。 */
  private drawEdges(f: BrainFrame): void {
    const { ctx } = this;
    const { projected: p, edgeEnds: ends, edgeOrder, edgeStarts: starts } = f;
    ctx.lineWidth = 0.7;
    for (let b = 0; b < DEPTH_BUCKETS; b++) {
      ctx.strokeStyle = rgba(f.edgeColor, f.edgeAlpha[b]);
      ctx.beginPath();
      for (let k = starts[b]; k < starts[b + 1]; k++) {
        const e = edgeOrder[k];
        const i = ends[e * 2] * 3;
        const j = ends[e * 2 + 1] * 3;
        ctx.moveTo(p[i], p[i + 1]);
        ctx.lineTo(p[j], p[j + 1]);
      }
      ctx.stroke();
    }
  }

  /**
   * 透明度用 globalAlpha（數字），粒子依顏色分組後同組只設一次 fillStyle：每格不為每個粒子建立、解析 rgba() 字串。
   * 這一段在 lighter（相加）合成下畫，換順序不改結果（docs/validation/brain-canvas-perf-2026-11-06.md）。
   */
  private drawNodes(f: BrainFrame): void {
    const { ctx } = this;
    const { projected: p, nodeKey, nodeAlpha, nodeSize, nodeInner, nodeCount: n } = f;
    if (this.nodeOrder.length !== n) this.nodeOrder = new Int32Array(n);
    const order = this.nodeOrder;
    const counts = this.keyCounts;
    counts.clear();
    for (let i = 0; i < n; i++) counts.set(nodeKey[i], (counts.get(nodeKey[i]) ?? 0) + 1);
    let offset = 0;
    for (const [key, count] of counts) {
      counts.set(key, offset);
      offset += count;
    }
    for (let i = 0; i < n; i++) {
      const slot = counts.get(nodeKey[i])!;
      order[slot] = i;
      counts.set(nodeKey[i], slot + 1);
    }
    let current = -1;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const key = nodeKey[i];
      if (key !== current) {
        current = key;
        ctx.fillStyle = rgbString(key);
      }
      ctx.globalAlpha = Math.min(1, nodeAlpha[i]);
      const r = nodeSize[i];
      ctx.fillRect(p[i * 3] - r / 2, p[i * 3 + 1] - r / 2, r, r);
    }
    const g = f.nodeGlowSize;
    for (let i = 0; i < n; i += f.glowEvery) {
      if (p[i * 3 + 2] < -0.55 && !nodeInner[i]) {
        ctx.globalAlpha = 0.25 * nodeAlpha[i];
        ctx.drawImage(this.sprite, p[i * 3] - g / 2, p[i * 3 + 1] - g / 2, g, g);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawPulses(f: BrainFrame): void {
    const { ctx } = this;
    const geom = f.pulseGeom;
    const g = f.pulseGlowSize;
    ctx.lineWidth = 1.4;
    for (let k = 0; k < f.pulses.length; k++) {
      const pulse = f.pulses[k];
      const o = k * PULSE_STRIDE;
      const x = geom[o + 2];
      const y = geom[o + 3];
      const fade = geom[o + 4];
      ctx.strokeStyle = pulse.stroke;
      ctx.globalAlpha = 0.55 * fade;
      ctx.beginPath();
      ctx.moveTo(geom[o], geom[o + 1]);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 0.9 * fade;
      ctx.drawImage((pulse.sprite ??= tintSprite(this.sprite, pulse.color)), x - g / 2, y - g / 2, g, g);
    }
    ctx.globalAlpha = 1;
  }

  private drawOrbits(f: BrainFrame): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.rotate(f.orbitAngle[i]);
      ctx.strokeStyle = rgba(i === 0 ? CYAN : VIOLET, f.orbitAlpha);
      ctx.beginPath();
      ctx.ellipse(0, 0, f.R * 1.62, f.R * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawRings(f: BrainFrame): void {
    const { ctx } = this;
    const R = f.R;
    // 即時語音連線中：琥珀色虛線慢轉，表示還在接通、先別說話。
    if (f.connectAlpha > 0) {
      ctx.save();
      ctx.strokeStyle = rgba(AMBER, f.connectAlpha);
      ctx.lineWidth = 2;
      ctx.setLineDash(f.connectDash);
      ctx.lineDashOffset = f.connectDashOffset;
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, R * 1.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 聆聽光環；即時語音接通後換成較粗、會呼吸的薄荷綠，表示可以說話了。
    if (f.listenAlpha > 0) {
      ctx.strokeStyle = rgba(f.listenColor, f.listenAlpha);
      ctx.lineWidth = f.listenWidth;
      if (f.listenBlur > 0) {
        ctx.shadowColor = rgba(f.listenColor, f.listenShadowAlpha);
        ctx.shadowBlur = f.listenBlur;
      }
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, R * 1.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // 處理中提示音的波紋：每次真的排了提示音才有一圈，由 1.1 R 擴散到 1.5 R 並淡出。
    for (const t of f.cueRings) {
      ctx.strokeStyle = rgba(CYAN, 0.22 * (1 - t));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, R * (1.1 + 0.4 * t), 0, Math.PI * 2);
      ctx.stroke();
    }
    // 前景任務的真實進度環（done / total）
    if (f.progress !== null) {
      const rr = R * 1.45;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (f.shownProgress > 0.001) {
        const grad = ctx.createLinearGradient(f.cx - rr, f.cy - rr, f.cx + rr, f.cy + rr);
        grad.addColorStop(0, rgba(CYAN, 0.95));
        grad.addColorStop(1, rgba(VIOLET, 0.95));
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.arc(f.cx, f.cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f.shownProgress);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
    }
  }
}

export function clearCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** 畫布的 CSS 大小與實際解析度。 */
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

/** 亮起的腦區旁標示名稱，讓人看得出現在處理的是哪一類內容。兩種繪製方式共用（WebGL 版畫在上層的 2D 畫布）。 */
export function drawRegionLabels(ctx: CanvasRenderingContext2D, f: BrainFrame): void {
  const R = f.R;
  if (R < 60) return; // 縮小到頂端時不放字
  const fontSize = Math.round(Math.max(12, R / 11));
  ctx.font = `500 ${fontSize}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  for (const d of DOMAINS) {
    const a = f.activation[d];
    if (a < 0.25) continue;
    const c = f.regionCenter[d];
    if (!c.valid) continue;
    // 標籤放在腦外側，以細線連回腦區中心
    const dx = c.x - f.cx;
    const dy = c.y - f.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const ex = f.cx + ux * R * 1.3;
    const ey = f.cy + uy * R * 1.2;
    const alpha = Math.min(1, (a - 0.2) * 1.6);
    ctx.strokeStyle = rgba(REGION_COLOR[d], 0.45 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.textAlign = "left";
    // 簡化光暈時不用 shadowBlur（Pi 上很貴）；字仍照畫。
    if (f.labelShadow) {
      ctx.shadowColor = "rgba(2,6,16,0.9)";
      ctx.shadowBlur = 6;
    }
    ctx.fillStyle = rgba(REGION_COLOR[d], alpha);
    const descriptions = [...new Set(f.activity?.filter((x) => x.domain === d).map(activityDescription))];
    if (descriptions.length) {
      let text = descriptions.join(" / ");
      while (text.length > 1 && ctx.measureText(text).width > f.width - 24) text = `${text.slice(0, -2)}…`;
      const textWidth = ctx.measureText(text).width;
      const x = Math.max(12, Math.min(f.width - textWidth - 12, ux >= 0 ? ex + 6 : ex - textWidth - 6));
      const y = Math.max(fontSize, Math.min(f.height - fontSize, ey));
      ctx.fillText(text, x, y);
    }
    ctx.shadowBlur = 0;
  }
}

const rgbCache = new Map<number, string>();
/** 長時間運作時 liveLevel／activation／tint 連續變化會累積不同顏色（審查模擬約 3 萬種後持平）；超過上限就整個清掉重建。 */
const RGB_CACHE_MAX = 50_000;
/** key 是 (r << 16) | (g << 8) | b；字串留著重複使用。 */
export function rgbString(key: number): string {
  let s = rgbCache.get(key);
  if (!s) {
    if (rgbCache.size >= RGB_CACHE_MAX) rgbCache.clear();
    s = `rgb(${key >>> 16},${(key >>> 8) & 255},${key & 255})`;
    rgbCache.set(key, s);
  }
  return s;
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
