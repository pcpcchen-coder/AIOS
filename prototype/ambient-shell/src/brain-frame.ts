import { regionMap, type Domain } from "../shared/domain.ts";
import type { RegionActivity } from "./region-activity.ts";

// 電子腦每一格的繪製輸入（brain.ts 算好，brain-canvas.ts 與 brain-webgl.ts 只負責畫）。
// 顏色、亮度與腦區活化只在 Brain 裡算一次；兩種繪製方式讀同一份資料，不各自重算。
// 整個物件與其中的 typed array 由 Brain 預先配置、每格覆寫，不在每格建立新的。

export type RGB = readonly [number, number, number];

export const CYAN: RGB = [92, 225, 255];
export const VIOLET: RGB = [166, 139, 255];
export const MINT: RGB = [92, 242, 176];
export const AMBER: RGB = [255, 179, 92];

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
}

export function rgbKey(c: RGB): number {
  return ((c[0] | 0) << 16) | ((c[1] | 0) << 8) | (c[2] | 0);
}

/** 光脈衝：沿著連線走的路徑。sprite 是 Canvas 繪製用的染色光點快取（第一次畫時取）。 */
export interface Pulse {
  path: number[];
  t: number;
  speed: number;
  color: RGB;
  domain: Domain | null;
  stroke: string;
  sprite: HTMLCanvasElement | null;
}

/** 每個光脈衝在 pulseGeom 裡佔幾個數：線段起點 x、y，光點 x、y，淡出 0–1。 */
export const PULSE_STRIDE = 5;

export interface RegionCenter {
  x: number;
  y: number;
  z: number;
  /** 腦區沒有任何外表面粒子、或這一格沒算（亮度 < 0.02）時為 false。 */
  valid: boolean;
}

export interface BrainFrame {
  /** CSS 像素。 */
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** 含呼吸的半徑。 */
  R: number;
  bright: number;
  time: number;
  reduced: boolean;
  liveLevel: number;
  /** 中心光暈的兩個色標（0 與 0.45；1 為透明），半徑 1.9 R，畫在 4R 見方內。 */
  glowInner: RGB;
  glowInnerAlpha: number;
  glowMid: RGB;
  glowMidAlpha: number;
  /** 兩條外圈軌道（青、紫）的旋轉角與透明度。 */
  orbitAngle: [number, number];
  orbitAlpha: number;

  nodeCount: number;
  /** [x, y, z] × nodeCount；x、y 為 CSS 像素，z 為 -1（近）… 1（遠）。 */
  projected: Float32Array;
  /** 1＝內部粒子。建腦後不變。 */
  nodeInner: Uint8Array;
  /** 這一格的粒子顏色 (r << 16) | (g << 8) | b，與 Canvas 版的 fillStyle 相同。 */
  nodeKey: Int32Array;
  /** 深度透明度 × 亮度（未截到 1）。 */
  nodeAlpha: Float64Array;
  /** 粒子方塊邊長（CSS 像素）。 */
  nodeSize: Float64Array;
  /** 每 glowEvery 個粒子檢查一次是否畫光暈（前方、外表面）。 */
  glowEvery: number;
  nodeGlowSize: number;

  /** 連線兩端的粒子編號 [i0, j0, i1, j1, …]；建腦後不變。 */
  edgeEnds: Int32Array;
  /** 依深度分四組後的連線順序與每組起點（edgeStarts[b]…edgeStarts[b + 1]）。 */
  edgeOrder: Int32Array;
  edgeStarts: Int32Array;
  edgeColor: RGB;
  /** 四組各自的透明度。 */
  edgeAlpha: Float64Array;

  activation: Record<Domain, number>;
  regionCenter: Record<Domain, RegionCenter>;
  /** 同一腦區兩端的連線；建腦後不變。 */
  regionEdges: Record<Domain, readonly (readonly [number, number])[]>;

  pulses: readonly Pulse[];
  /** PULSE_STRIDE × pulses.length 個數。 */
  pulseGeom: Float64Array;
  pulseGlowSize: number;

  /** 即時語音連線中的琥珀色虛線環（1.32 R）：透明度 0 時不畫；虛線長、間隔與位移（CSS 像素）。 */
  connectAlpha: number;
  connectDash: [number, number];
  connectDashOffset: number;
  /** 聆聽／通話光環（1.32 R）：透明度 0 時不畫；blur 0＝不模糊。 */
  listenColor: RGB;
  listenAlpha: number;
  listenWidth: number;
  listenShadowAlpha: number;
  listenBlur: number;
  cueRings: readonly number[];
  progress: number | null;
  shownProgress: number;
  /** 腦區標籤要不要加 shadowBlur（完整光暈時）。 */
  labelShadow: boolean;
  activity: readonly RegionActivity[] | undefined;
}

export function emptyRegionCenters(): Record<Domain, RegionCenter> {
  return regionMap(() => ({ x: 0, y: 0, z: 0, valid: false }));
}

export const DEPTH_BUCKETS = 4;

/** 和 Canvas 版相同的深度透明度。 */
export function depthAlpha(z: number): number {
  return Math.max(0.08, Math.min(1, 0.62 - z * 0.5));
}
