import { DOMAINS, REGION_COLOR } from "../shared/domain.ts";
import { RENDER_BUDGETS } from "./performance.ts";
import { AMBER, CYAN, DEPTH_BUCKETS, PULSE_STRIDE, VIOLET, type BrainFrame, type RGB } from "./brain-frame.ts";
import { clearCanvas, drawRegionLabels, sizeCanvas, type BrainRenderer } from "./brain-canvas.ts";

// 電子腦的 WebGL 1 繪製（方案 B；docs/validation/brain-webgl-2026-11-07.md）。輸入和 Canvas 版相同（BrainFrame），
// 顏色、透明度、大小都照 Canvas 版；不求逐像素相同。粒子、光暈與光脈衝是 point sprite，連線是 GL_LINES，
// 中心與腦區光暈、各種光環是畫在方形上的著色器。相加合成（ONE, ONE）對應 Canvas 的 lighter。
// 每格的頂點資料寫進預先配置的 Float32Array，以 bufferSubData 上傳整個陣列（WebGL 1 不能只傳一段而不建立新的 view）。
// 區名照舊用 Canvas 的 drawRegionLabels，畫在疊在上面的透明 2D 畫布（原本的 #brain）。

export const WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: true,
};

/** 這些 WebGL 實作是 CPU 軟體模擬，比 Canvas 還慢；沒有 allowSoftware 時視為沒有硬體 WebGL。 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software rasterizer/i;

export interface WebGLRendererOptions {
  /** 只給量測腳本用：無頭 Chromium 只有 SwiftShader。 */
  allowSoftware?: boolean;
  onContextLost?: () => void;
}

export type WebGLRendererResult = { ok: true; renderer: WebGLBrainRenderer } | { ok: false; reason: string };

export function createWebGLRenderer(overlay: HTMLCanvasElement, overlayCtx: CanvasRenderingContext2D, options: WebGLRendererOptions = {}): WebGLRendererResult {
  const canvas = document.createElement("canvas");
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { ...WEBGL_CONTEXT_ATTRIBUTES, failIfMajorPerformanceCaveat: !options.allowSoftware }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return { ok: false, reason: "WebGL context refused (no hardware WebGL, or major performance caveat)" };
  const name = rendererName(gl);
  if (!options.allowSoftware && name && SOFTWARE_RENDERER.test(name)) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: false, reason: `software WebGL renderer: ${name}` };
  }
  let renderer: WebGLBrainRenderer;
  try {
    renderer = new WebGLBrainRenderer(canvas, gl, overlay, overlayCtx, options.onContextLost ?? null);
  } catch (error) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: false, reason: `WebGL setup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  canvas.className = "brain-gl";
  canvas.setAttribute("aria-hidden", "true");
  overlay.parentNode?.insertBefore(canvas, overlay);
  return { ok: true, renderer };
}

function rendererName(gl: WebGLRenderingContext): string | null {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const value = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  return typeof value === "string" ? value : null;
}

const POINT_STRIDE = 7; // x, y, size, r, g, b, a
const LINE_STRIDE = 6; // x, y, r, g, b, a
const ORBIT_SEGMENTS = 96;
const TAU = Math.PI * 2;
export const MAX_PULSES = Math.max(...Object.values(RENDER_BUDGETS).map((b) => b.maxPulses));

const HIGHP = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n";

const POINT_VS = `
attribute vec2 a_pos;
attribute vec4 a_color;
attribute float a_size;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_maxPoint;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
  float s = a_size * u_dpr;
  v_color = vec4(a_color.rgb, a_color.a * min(1.0, s * s));
  gl_PointSize = clamp(s, 1.0, u_maxPoint);
}`;

// u_mode 0：實心方塊（粒子）；1：白色光暈（makeGlowSprite 的漸層）；2：染色光點（tintSprite：顏色疊在白色光暈上）。
const POINT_FS = `${HIGHP}
uniform float u_mode;
varying vec4 v_color;
void main() {
  vec4 c = v_color;
  if (u_mode < 0.5) { gl_FragColor = vec4(c.rgb * c.a, c.a); return; }
  float d = length(gl_PointCoord - 0.5) * 2.0;
  vec4 mid = vec4(0.784, 0.941, 1.0, 0.6);
  vec4 s = d < 0.25 ? mix(vec4(1.0), mid, d / 0.25) : mix(mid, vec4(0.0), clamp((d - 0.25) / 0.75, 0.0, 1.0));
  vec4 base = vec4(s.rgb * s.a, s.a);
  if (u_mode < 1.5) { gl_FragColor = base * c.a; return; }
  gl_FragColor = (vec4(c.rgb * s.a, s.a) + base * (1.0 - s.a)) * c.a;
}`;

const LINE_VS = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform vec2 u_res;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}`;

const LINE_FS = `${HIGHP}
varying vec4 v_color;
void main() { gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a); }`;

const QUAD_VS = `
attribute vec2 a_corner;
uniform vec2 u_res;
uniform vec2 u_center;
uniform float u_extent;
varying vec2 v_pos;
void main() {
  v_pos = u_center + a_corner * u_extent;
  gl_Position = vec4(v_pos.x / u_res.x * 2.0 - 1.0, 1.0 - v_pos.y / u_res.y * 2.0, 0.0, 1.0);
}`;

// 徑向漸層：0 → u_c0、u_stop → u_c1、1 → 透明（未預乘內插，和 Canvas 漸層到 rgba(0,0,0,0) 相同）。
const GLOW_FS = `${HIGHP}
uniform vec2 u_center;
uniform float u_radius;
uniform vec4 u_c0;
uniform vec4 u_c1;
uniform float u_stop;
varying vec2 v_pos;
void main() {
  float t = length(v_pos - u_center) / u_radius;
  vec4 c = t >= 1.0 ? vec4(0.0) : t < u_stop ? mix(u_c0, u_c1, t / u_stop) : mix(u_c1, vec4(0.0), (t - u_stop) / (1.0 - u_stop));
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}`;

// 圓環：線寬、虛線、圓弧（圓頭）、對角線漸層與 shadowBlur 的近似（高斯衰減）。
const RING_FS = `${HIGHP}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_width;
uniform float u_aa;
uniform vec4 u_color;
uniform vec4 u_color2;
uniform float u_gradient;
uniform vec4 u_grad;
uniform vec4 u_shadow;
uniform float u_blur;
uniform vec3 u_dash;
uniform vec2 u_arc;
varying vec2 v_pos;
const float TAU = 6.2831853;
void main() {
  vec2 p = v_pos - u_center;
  float ang = mod(atan(p.y, p.x), TAU);
  float d = abs(length(p) - u_radius);
  if (u_arc.y < TAU && mod(ang - u_arc.x, TAU) > u_arc.y) {
    vec2 e0 = u_radius * vec2(cos(u_arc.x), sin(u_arc.x));
    vec2 e1 = u_radius * vec2(cos(u_arc.x + u_arc.y), sin(u_arc.x + u_arc.y));
    d = min(length(p - e0), length(p - e1));
  }
  float halfWidth = u_width * 0.5;
  float cov = clamp((halfWidth - d) / u_aa + 0.5, 0.0, 1.0);
  if (u_dash.x > 0.0) cov *= step(mod(ang * u_radius + u_dash.z, u_dash.x + u_dash.y), u_dash.x);
  vec4 col = u_color;
  if (u_gradient > 0.5) {
    vec2 g = u_grad.zw - u_grad.xy;
    col = mix(u_color, u_color2, clamp(dot(v_pos - u_grad.xy, g) / dot(g, g), 0.0, 1.0));
  }
  float a = col.a * cov;
  vec4 stroke = vec4(col.rgb * a, a);
  float sh = 0.0;
  if (u_blur > 0.0) {
    float sigma = u_blur * 0.5;
    float o = max(d - halfWidth, 0.0);
    sh = u_shadow.a * col.a * min(1.0, u_width / sigma) * exp(-o * o / (2.0 * sigma * sigma));
  }
  gl_FragColor = stroke + vec4(u_shadow.rgb * sh, sh) * (1.0 - stroke.a);
}`;

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Program {
  program: WebGLProgram;
  u: Uniforms;
}

const A_POS = 0;
const A_COLOR = 1;
const A_SIZE = 2;

export class WebGLBrainRenderer implements BrainRenderer {
  readonly kind = "webgl";
  private readonly points: Program;
  private readonly lines: Program;
  private readonly glow: Program;
  private readonly ring: Program;
  private readonly pointBuffer: WebGLBuffer;
  private readonly lineBuffer: WebGLBuffer;
  private readonly quadBuffer: WebGLBuffer;
  /** 預先配置的頂點資料；容量由建腦後的粒子數、連線數與最多光脈衝數決定。 */
  private pointData = new Float32Array(0);
  private lineData = new Float32Array(0);
  private readonly orbitCos = new Float32Array(ORBIT_SEGMENTS);
  private readonly orbitSin = new Float32Array(ORBIT_SEGMENTS);
  private readonly maxPointSize: number;
  private dpr = 1;
  private overlayDirty = false;
  private lost = false;
  private readonly onLost: () => void;
  /** 測試與量測看的：上一格各類別畫了幾個。 */
  readonly lastCounts = { nodes: 0, glows: 0, pulses: 0, edgeVertices: 0, regionEdgeVertices: 0, rings: 0, labels: false };

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private readonly overlay: HTMLCanvasElement,
    private readonly overlayCtx: CanvasRenderingContext2D,
    onContextLost: (() => void) | null,
  ) {
    this.points = program(gl, POINT_VS, POINT_FS, ["u_res", "u_dpr", "u_maxPoint", "u_mode"]);
    this.lines = program(gl, LINE_VS, LINE_FS, ["u_res"]);
    const quadUniforms = ["u_res", "u_center", "u_extent"];
    this.glow = program(gl, QUAD_VS, GLOW_FS, [...quadUniforms, "u_radius", "u_c0", "u_c1", "u_stop"]);
    this.ring = program(gl, QUAD_VS, RING_FS, [...quadUniforms, "u_radius", "u_width", "u_aa", "u_color", "u_color2", "u_gradient", "u_grad", "u_shadow", "u_blur", "u_dash", "u_arc"]);
    this.pointBuffer = buffer(gl);
    this.lineBuffer = buffer(gl);
    this.quadBuffer = buffer(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (let i = 0; i < ORBIT_SEGMENTS; i++) {
      this.orbitCos[i] = Math.cos((i / ORBIT_SEGMENTS) * TAU);
      this.orbitSin[i] = Math.sin((i / ORBIT_SEGMENTS) * TAU);
    }
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.maxPointSize = range && range[1] > 0 ? range[1] : 64;
    this.onLost = () => {
      this.lost = true;
      onContextLost?.();
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    sizeCanvas(this.canvas, width, height, dpr);
    sizeCanvas(this.overlay, width, height, dpr);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayDirty = false;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    if (!this.lost) this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove?.();
    clearCanvas(this.overlay, this.overlayCtx);
  }

  /** 依這次建腦的大小配置一次；之後每格只覆寫。 */
  private ensureCapacity(f: BrainFrame): void {
    const edges = f.edgeEnds.length / 2;
    const points = (f.nodeCount + Math.ceil(f.nodeCount / 4) + MAX_PULSES) * POINT_STRIDE;
    const lines = (2 * ORBIT_SEGMENTS + 4 * edges + 2 * MAX_PULSES) * LINE_STRIDE;
    const { gl } = this;
    if (this.pointData.length !== points) {
      this.pointData = new Float32Array(points);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.pointData.byteLength, gl.DYNAMIC_DRAW);
    }
    if (this.lineData.length !== lines) {
      this.lineData = new Float32Array(lines);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  draw(f: BrainFrame): void {
    if (this.lost) return;
    const { gl } = this;
    this.ensureCapacity(f);
    const pulses = Math.min(f.pulses.length, MAX_PULSES);

    // 頂點資料：粒子、粒子光暈、光脈衝光點（點）；軌道、連線、腦區連線、光脈衝尾巴（線）。
    const pts = this.pointData;
    let pv = 0;
    const p = f.projected;
    for (let i = 0; i < f.nodeCount; i++) {
      const key = f.nodeKey[i];
      pv = putPoint(pts, pv, p[i * 3], p[i * 3 + 1], f.nodeSize[i], (key >>> 16) / 255, ((key >>> 8) & 255) / 255, (key & 255) / 255, Math.min(1, f.nodeAlpha[i]));
    }
    const glowStart = pv;
    for (let i = 0; i < f.nodeCount; i += f.glowEvery) {
      if (p[i * 3 + 2] < -0.55 && !f.nodeInner[i]) pv = putPoint(pts, pv, p[i * 3], p[i * 3 + 1], f.nodeGlowSize, 1, 1, 1, Math.min(1, 0.25 * f.nodeAlpha[i]));
    }
    const pulseStart = pv;
    for (let k = 0; k < pulses; k++) {
      const c = f.pulses[k].color;
      const o = k * PULSE_STRIDE;
      pv = putPoint(pts, pv, f.pulseGeom[o + 2], f.pulseGeom[o + 3], f.pulseGlowSize, (c[0] | 0) / 255, (c[1] | 0) / 255, (c[2] | 0) / 255, 0.9 * f.pulseGeom[o + 4]);
    }

    const ln = this.lineData;
    const dpr = this.dpr;
    let lv = 0;
    for (let i = 0; i < 2; i++) {
      const angle = f.orbitAngle[i];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const c = i === 0 ? CYAN : VIOLET;
      const a = lineAlpha(f.orbitAlpha, 1, dpr);
      for (let s = 0; s < ORBIT_SEGMENTS; s++) {
        const ex = f.R * 1.62 * this.orbitCos[s];
        const ey = f.R * 0.42 * this.orbitSin[s];
        lv = putLine(ln, lv, f.cx + ex * cos - ey * sin, f.cy + ex * sin + ey * cos, c, a);
      }
    }
    const edgeStart = lv;
    const ends = f.edgeEnds;
    for (let b = 0; b < DEPTH_BUCKETS; b++) {
      const a = lineAlpha(f.edgeAlpha[b], 0.7, dpr);
      for (let k = f.edgeStarts[b]; k < f.edgeStarts[b + 1]; k++) {
        const e = f.edgeOrder[k];
        const i = ends[e * 2] * 3;
        const j = ends[e * 2 + 1] * 3;
        lv = putLine(ln, lv, p[i], p[i + 1], f.edgeColor, a);
        lv = putLine(ln, lv, p[j], p[j + 1], f.edgeColor, a);
      }
    }
    const regionStart = lv;
    for (const d of DOMAINS) {
      const act = f.activation[d];
      if (act < 0.02) continue;
      const a = lineAlpha(0.55 * act, 0.9, dpr);
      for (const [i, j] of f.regionEdges[d]) {
        if (p[i * 3 + 2] > 0.35 && p[j * 3 + 2] > 0.35) continue;
        lv = putLine(ln, lv, p[i * 3], p[i * 3 + 1], REGION_COLOR[d], a);
        lv = putLine(ln, lv, p[j * 3], p[j * 3 + 1], REGION_COLOR[d], a);
      }
    }
    const trailStart = lv;
    for (let k = 0; k < pulses; k++) {
      const c = f.pulses[k].color;
      const o = k * PULSE_STRIDE;
      const a = lineAlpha(0.55 * f.pulseGeom[o + 4], 1.4, dpr);
      lv = putLine(ln, lv, f.pulseGeom[o], f.pulseGeom[o + 1], c, a);
      lv = putLine(ln, lv, f.pulseGeom[o + 2], f.pulseGeom[o + 3], c, a);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pts);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ln);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);

    // 一般疊加（source-over）：中心光暈、軌道。
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.useQuad(this.glow, f);
    this.radial(f.cx, f.cy, f.R * 2, f.R * 1.9, f.glowInner, f.glowInnerAlpha, f.glowMid, f.glowMidAlpha, 0.45);
    this.useLines(f);
    const L = (at: number) => at / LINE_STRIDE;
    const P = (at: number) => at / POINT_STRIDE;
    gl.drawArrays(gl.LINE_LOOP, 0, ORBIT_SEGMENTS);
    gl.drawArrays(gl.LINE_LOOP, ORBIT_SEGMENTS, ORBIT_SEGMENTS);

    // 相加（Canvas 的 lighter）：腦區光暈、連線、粒子、光脈衝。
    gl.blendFunc(gl.ONE, gl.ONE);
    this.useQuad(this.glow, f);
    for (const d of DOMAINS) {
      const a = f.activation[d];
      const c = f.regionCenter[d];
      if (a < 0.02 || !c.valid) continue;
      const r = f.R * 0.62;
      this.radial(c.x, c.y, r, r, REGION_COLOR[d], 0.32 * a, REGION_COLOR[d], 0, 1);
    }
    this.useLines(f);
    if (trailStart > edgeStart) gl.drawArrays(gl.LINES, L(edgeStart), L(trailStart - edgeStart));
    this.usePoints(f);
    gl.uniform1f(this.points.u.u_mode, 0);
    gl.drawArrays(gl.POINTS, 0, P(glowStart));
    gl.uniform1f(this.points.u.u_mode, 1);
    if (pulseStart > glowStart) gl.drawArrays(gl.POINTS, P(glowStart), P(pulseStart - glowStart));
    if (pulses > 0) {
      this.useLines(f);
      gl.drawArrays(gl.LINES, L(trailStart), L(lv - trailStart));
      this.usePoints(f);
      gl.uniform1f(this.points.u.u_mode, 2);
      gl.drawArrays(gl.POINTS, P(pulseStart), P(pv - pulseStart));
    }

    // 一般疊加：光環。
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.useQuad(this.ring, f);
    let rings = 0;
    const R = f.R;
    if (f.connectAlpha > 0) {
      this.drawRing(f, R * 1.32, 2, AMBER, f.connectAlpha, { dash: f.connectDash, dashOffset: f.connectDashOffset });
      rings++;
    }
    if (f.listenAlpha > 0) {
      this.drawRing(f, R * 1.32, f.listenWidth, f.listenColor, f.listenAlpha, { blur: f.listenBlur, shadowAlpha: f.listenShadowAlpha });
      rings++;
    }
    for (const t of f.cueRings) {
      this.drawRing(f, R * (1.1 + 0.4 * t), 1.5, CYAN, 0.22 * (1 - t), {});
      rings++;
    }
    if (f.progress !== null) {
      const rr = R * 1.45;
      this.drawRing(f, rr, 3, WHITE, 0.08, {});
      rings++;
      if (f.shownProgress > 0.001) {
        this.drawRing(f, rr, 3, CYAN, 0.95, { arc: [-Math.PI / 2, TAU * f.shownProgress], gradientTo: VIOLET });
        rings++;
      }
    }

    // 區名：上層的 2D 畫布。沒有要畫的字、上一格也沒畫時不清畫布。
    let labels = false;
    if (f.R >= 60) for (const d of DOMAINS) labels ||= f.activation[d] >= 0.25 && f.regionCenter[d].valid;
    if (labels || this.overlayDirty) {
      this.overlayCtx.clearRect(0, 0, f.width, f.height);
      if (labels) drawRegionLabels(this.overlayCtx, f);
      this.overlayDirty = labels;
    }

    const counts = this.lastCounts;
    counts.nodes = glowStart / POINT_STRIDE;
    counts.glows = (pulseStart - glowStart) / POINT_STRIDE;
    counts.pulses = pulses;
    counts.edgeVertices = (regionStart - edgeStart) / LINE_STRIDE;
    counts.regionEdgeVertices = (trailStart - regionStart) / LINE_STRIDE;
    counts.rings = rings;
    counts.labels = labels;
  }

  private useQuad(prog: Program, f: BrainFrame): void {
    const { gl } = this;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.u.u_res, f.width, f.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(A_POS);
    gl.vertexAttribPointer(A_POS, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(A_COLOR);
    gl.disableVertexAttribArray(A_SIZE);
  }

  private useLines(f: BrainFrame): void {
    const { gl } = this;
    gl.useProgram(this.lines.program);
    gl.uniform2f(this.lines.u.u_res, f.width, f.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.enableVertexAttribArray(A_POS);
    gl.enableVertexAttribArray(A_COLOR);
    gl.disableVertexAttribArray(A_SIZE);
    gl.vertexAttribPointer(A_POS, 2, gl.FLOAT, false, LINE_STRIDE * 4, 0);
    gl.vertexAttribPointer(A_COLOR, 4, gl.FLOAT, false, LINE_STRIDE * 4, 8);
  }

  private usePoints(f: BrainFrame): void {
    const { gl } = this;
    const u = this.points.u;
    gl.useProgram(this.points.program);
    gl.uniform2f(u.u_res, f.width, f.height);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform1f(u.u_maxPoint, this.maxPointSize);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.enableVertexAttribArray(A_POS);
    gl.enableVertexAttribArray(A_COLOR);
    gl.enableVertexAttribArray(A_SIZE);
    gl.vertexAttribPointer(A_POS, 2, gl.FLOAT, false, POINT_STRIDE * 4, 0);
    gl.vertexAttribPointer(A_SIZE, 1, gl.FLOAT, false, POINT_STRIDE * 4, 8);
    gl.vertexAttribPointer(A_COLOR, 4, gl.FLOAT, false, POINT_STRIDE * 4, 12);
  }

  private radial(x: number, y: number, extent: number, radius: number, c0: RGB, a0: number, c1: RGB, a1: number, stop: number): void {
    const { gl } = this;
    const u = this.glow.u;
    gl.uniform2f(u.u_center, x, y);
    gl.uniform1f(u.u_extent, extent);
    gl.uniform1f(u.u_radius, radius);
    gl.uniform4f(u.u_c0, (c0[0] | 0) / 255, (c0[1] | 0) / 255, (c0[2] | 0) / 255, a0);
    gl.uniform4f(u.u_c1, a1 > 0 ? (c1[0] | 0) / 255 : 0, a1 > 0 ? (c1[1] | 0) / 255 : 0, a1 > 0 ? (c1[2] | 0) / 255 : 0, a1);
    gl.uniform1f(u.u_stop, stop);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawRing(
    f: BrainFrame,
    radius: number,
    width: number,
    color: RGB,
    alpha: number,
    o: { dash?: readonly number[]; dashOffset?: number; blur?: number; shadowAlpha?: number; arc?: [number, number]; gradientTo?: RGB },
  ): void {
    const { gl } = this;
    const u = this.ring.u;
    const blur = o.blur ?? 0;
    gl.uniform2f(u.u_center, f.cx, f.cy);
    gl.uniform1f(u.u_extent, radius + width + blur * 1.5 + 2);
    gl.uniform1f(u.u_radius, radius);
    gl.uniform1f(u.u_width, width);
    gl.uniform1f(u.u_aa, 1 / this.dpr);
    gl.uniform4f(u.u_color, (color[0] | 0) / 255, (color[1] | 0) / 255, (color[2] | 0) / 255, alpha);
    const to = o.gradientTo ?? color;
    gl.uniform4f(u.u_color2, (to[0] | 0) / 255, (to[1] | 0) / 255, (to[2] | 0) / 255, alpha);
    gl.uniform1f(u.u_gradient, o.gradientTo ? 1 : 0);
    gl.uniform4f(u.u_grad, f.cx - radius, f.cy - radius, f.cx + radius, f.cy + radius);
    gl.uniform4f(u.u_shadow, (color[0] | 0) / 255, (color[1] | 0) / 255, (color[2] | 0) / 255, o.shadowAlpha ?? 0);
    gl.uniform1f(u.u_blur, blur);
    gl.uniform3f(u.u_dash, o.dash?.[0] ?? 0, o.dash?.[1] ?? 0, o.dashOffset ?? 0);
    gl.uniform2f(u.u_arc, o.arc ? ((o.arc[0] % TAU) + TAU) % TAU : 0, o.arc ? o.arc[1] : TAU);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

const WHITE: RGB = [255, 255, 255];

/** GL 線固定 1 個裝置像素寬：以透明度補回 Canvas 線寬（CSS 像素 × 裝置像素比）的亮度。 */
function lineAlpha(alpha: number, cssWidth: number, dpr: number): number {
  return Math.min(1, alpha * cssWidth * dpr);
}

function putPoint(out: Float32Array, at: number, x: number, y: number, size: number, r: number, g: number, b: number, a: number): number {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = size;
  out[at + 3] = r;
  out[at + 4] = g;
  out[at + 5] = b;
  out[at + 6] = a;
  return at + POINT_STRIDE;
}

function putLine(out: Float32Array, at: number, x: number, y: number, c: RGB, a: number): number {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = (c[0] | 0) / 255;
  out[at + 3] = (c[1] | 0) / 255;
  out[at + 4] = (c[2] | 0) / 255;
  out[at + 5] = a;
  return at + LINE_STRIDE;
}

function buffer(gl: WebGLRenderingContext): WebGLBuffer {
  const b = gl.createBuffer();
  if (!b) throw new Error("createBuffer failed");
  return b;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(prog, A_POS, vs.includes("a_corner") ? "a_corner" : "a_pos");
  gl.bindAttribLocation(prog, A_COLOR, "a_color");
  gl.bindAttribLocation(prog, A_SIZE, "a_size");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog) ?? "unknown"}`);
  const u: Uniforms = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { program: prog, u };
}

function shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("createShader failed");
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`compile: ${gl.getShaderInfoLog(s) ?? "unknown"}`);
  return s;
}
