import { isTerminalId } from "../shared/terminal.ts";

// 這台裝置的畫面效能（George 2026-11-05：Pi 4 終端機跑不順）。只調整電子腦的繪製與 CSS 背景模糊；
// 不碰收音、播放、即時語音與喚醒，所以不影響對話。設定只存在這個頁面的 localStorage，每台裝置各自保存，不送核心。

export type PerformanceProfile = "full" | "balanced" | "light";

export interface RenderBudget {
  maxFps: number;
  /** 畫布解析度相對於 CSS 像素的上限（裝置像素比超過時以此為準）。 */
  pixelRatioCap: number;
  maxPulses: number;
  glow: "full" | "reduced";
  backdropBlur: boolean;
  /** 聆聽／通話光環的 shadowBlur：大面積模糊，通話中每格都畫，代價最高。 */
  ringBlur: boolean;
}

export const PERFORMANCE_PROFILES: readonly PerformanceProfile[] = ["full", "balanced", "light"];

/** full 必須和調整前的畫面完全一樣（Mac 預設）。 */
export const RENDER_BUDGETS: Readonly<Record<PerformanceProfile, RenderBudget>> = {
  full: { maxFps: 30, pixelRatioCap: 2, maxPulses: 70, glow: "full", backdropBlur: true, ringBlur: true },
  balanced: { maxFps: 20, pixelRatioCap: 1, maxPulses: 40, glow: "full", backdropBlur: false, ringBlur: false },
  light: { maxFps: 12, pixelRatioCap: 0.75, maxPulses: 20, glow: "reduced", backdropBlur: false, ringBlur: false },
};

/**
 * 回憶模式播放時電子腦的繪製（MEMO-1；2026-11-07 調整）：每秒格數、光脈衝與光暈用「省電」，
 * 解析度維持這台裝置原本的設定——角落的電子腦直接以小尺寸繪製（brain.ts memoriesCornerGeometry），
 * 解析度降到 0.75 倍時會被放大回 1 倍而變糊；解析度不變也不必重配 Canvas。
 */
export function memoriesRenderBudget(budget: RenderBudget): RenderBudget {
  return { ...RENDER_BUDGETS.light, pixelRatioCap: budget.pixelRatioCap };
}

export const PERFORMANCE_KEY = "nous.performance.v1";
/**
 * 「使用 GPU 繪製（WebGL）」另存一個鍵（和完整／平衡／省電互不影響），所以舊的 nous.performance.v1 不必遷移：
 * 沒有這個鍵、或值不是 "on"／"off" 時一律視為關閉。每台裝置預設關閉。
 */
export const GPU_DRAWING_KEY = "nous.performance.gpu.v1";
export const NO_BLUR_CLASS = "perf-no-blur";

/** 設定頁的文字（原文；畫面上經 t() 翻譯，英文在 src/messages.en.json）。 */
export const PERFORMANCE_TEXT = {
  title: "這台裝置的畫面效能",
  group: "畫面效能",
  note: "只調整畫面，不改動對話的收音、播放與語音處理。",
  measured: "實測：每秒 {0} 格，每格主執行緒繪製 {1} 毫秒（不含 GPU 與背景模糊）",
  noSample: "實測：—",
  label: { full: "完整", balanced: "平衡", light: "省電" },
  detail: {
    full: "最多每秒 30 格、最高 2 倍解析度、完整光暈與背景模糊",
    balanced: "最多每秒 20 格、1 倍解析度、較少光脈衝、聆聽光環不模糊、關閉背景模糊",
    light: "最多每秒 12 格、0.75 倍解析度、較少光脈衝、簡化光暈、關閉背景模糊",
  },
  gpu: "使用 GPU 繪製（WebGL）",
  gpuNote: "預設關閉。和上面的設定可以一起用；這台裝置沒有硬體 WebGL 或 WebGL 中斷時，自動改回一般繪製。",
  renderer: {
    webgl: "目前：WebGL",
    canvas: "目前：一般繪製（Canvas）",
    unavailable: "此裝置沒有硬體 WebGL，已改用一般繪製",
    contextLost: "WebGL 中斷，這次開啟期間改用一般繪製",
  },
} as const;

export function isPerformanceProfile(value: unknown): value is PerformanceProfile {
  return typeof value === "string" && (PERFORMANCE_PROFILES as readonly string[]).includes(value);
}

export interface PerformanceEnv {
  /** location.search */
  search: string;
  /** 有 App preload（window.nousDesktop）。 */
  desktop: boolean;
}

/** 沒選過時：Pi 這類終端機（?terminal= 合法且不是 App）用平衡，其餘（Mac）維持完整。 */
export function defaultProfile(env: PerformanceEnv): PerformanceProfile {
  if (env.desktop) return "full";
  return isTerminalId(new URLSearchParams(env.search).get("terminal")) ? "balanced" : "full";
}

type ProfileStorage = Pick<Storage, "getItem" | "setItem">;

function pageStorage(): ProfileStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadProfile(env: PerformanceEnv, storage: ProfileStorage | null = pageStorage()): PerformanceProfile {
  try {
    const saved = storage?.getItem(PERFORMANCE_KEY);
    if (isPerformanceProfile(saved)) return saved;
  } catch {}
  return defaultProfile(env);
}

/** 保存失敗（無痕、封鎖儲存）時只影響下次開啟，這次仍照選擇套用。 */
export function saveProfile(profile: PerformanceProfile, storage: ProfileStorage | null = pageStorage()): boolean {
  try {
    storage?.setItem(PERFORMANCE_KEY, profile);
    return !!storage;
  } catch {
    return false;
  }
}

export function loadGpuDrawing(storage: ProfileStorage | null = pageStorage()): boolean {
  try {
    return storage?.getItem(GPU_DRAWING_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveGpuDrawing(on: boolean, storage: ProfileStorage | null = pageStorage()): boolean {
  try {
    storage?.setItem(GPU_DRAWING_KEY, on ? "on" : "off");
    return !!storage;
  } catch {
    return false;
  }
}

/** 繪製方式的實際狀態（Brain.rendererStatus 的子集；放在這裡讓設定頁不必 import brain.ts）。 */
export interface RendererReadout {
  active: "canvas" | "webgl";
  fallback: "unavailable" | "context-lost" | null;
}

/** 設定頁的「目前」狀態列：照實說真的在用哪一種；開了開關卻沒用上 WebGL 時說原因。 */
export function rendererText(status: RendererReadout | null): string {
  if (!status) return PERFORMANCE_TEXT.renderer.canvas;
  if (status.active === "webgl") return PERFORMANCE_TEXT.renderer.webgl;
  if (status.fallback === "unavailable") return PERFORMANCE_TEXT.renderer.unavailable;
  if (status.fallback === "context-lost") return PERFORMANCE_TEXT.renderer.contextLost;
  return PERFORMANCE_TEXT.renderer.canvas;
}

export interface PerformanceTargets {
  setRenderBudget(budget: RenderBudget): void;
  root: { classList: { toggle(name: string, force?: boolean): unknown } } | null;
}

export function applyProfile(profile: PerformanceProfile, targets: PerformanceTargets): RenderBudget {
  const budget = RENDER_BUDGETS[profile];
  targets.setRenderBudget(budget);
  targets.root?.classList.toggle(NO_BLUR_CLASS, !budget.backdropBlur);
  return budget;
}

/** 電子腦實測的每秒格數與每格繪製時間（最近約 2 秒）；還沒有樣本時為 null。 */
export interface FrameStats {
  fps: number;
  drawMs: number;
}

export function frameStatsText(stats: FrameStats | null): { source: string; values: string[] } {
  if (!stats) return { source: PERFORMANCE_TEXT.noSample, values: [] };
  return { source: PERFORMANCE_TEXT.measured, values: [String(Math.round(stats.fps)), stats.drawMs.toFixed(1)] };
}
