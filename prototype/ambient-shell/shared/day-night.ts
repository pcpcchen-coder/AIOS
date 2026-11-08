// VOL-2（George 2026-11-07）：日間／夜間的對話音量。晚上不要吵到人，白天要夠大聲。
// 判斷是純函式：夜間時段內，或鏡頭量到的環境很暗（燈關了），就用夜間音量；兩者都不成立才用日間音量。
// 鏡頭會自動曝光：晚上開著燈時畫面仍然亮，所以「亮」不會把夜間時段改成白天，只有「暗」能把白天改成夜間。
// 鏡頭沒開、量不到或讀值太舊時只看時段，並照實標出來源。

export type DayNightMode = "day" | "night";
/** hours：在夜間時段內；camera_dark：鏡頭量到很暗；day：兩者都不成立；manual：手動切換（DN-2，到 override.until 為止）。 */
export type DayNightReason = "hours" | "camera_dark" | "day" | "manual";

export interface DayNightPrefs {
  /** 夜間時段開始與結束的整點（0–23）；開始等於結束時沒有夜間時段。 */
  night_start_h: number;
  night_end_h: number;
  /** 用鏡頭亮度判斷（鏡頭有開時）。 */
  use_camera: boolean;
  /**
   * DN-1（George 2026-11-08）：夜間模式一併套用畫面變暗、處理中音效靜音、回憶模式暫停。
   * 關閉時回到 VOL-2 的行為：夜間只換對話音量（這就是回退）。
   */
  night_effects: boolean;
  /** DN-3（George 2026-11-08）：Pi 等終端機在夜間閒置 SCREEN_IDLE_MS 後關螢幕（Pi 套件的 aios-display 執行；有人互動或喚醒就亮回來）。 */
  screen_off: boolean;
}

export const DEFAULT_DAY_NIGHT_PREFS: DayNightPrefs = { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true, screen_off: true };
/** 夜間音量的預設值（日間沿用 VOL-1 的對話音量，預設 100）。 */
export const NIGHT_VOLUME_DEFAULT = 40;

/**
 * 環境亮度（畫面平均亮度，Rec. 601，0–255）。低於 DARK_LUMA 連續 LIGHT_HOLD_MS 才算暗；高於 BRIGHT_LUMA
 * 連續 LIGHT_HOLD_MS 才回到亮（遲滯，開關燈或有人走過不會來回切換）。
 * 2026-11-07 George 在 Pi 實測：開燈約 130、關燈約 80（鏡頭自動曝光，關燈也不會很暗）。門檻取兩者之間：
 * 低於 95 算暗、高於 115 算亮，各離實測值 15，中間 20 是遲滯區。
 */
export const DARK_LUMA = 95;
export const BRIGHT_LUMA = 115;
export const LIGHT_HOLD_MS = 60_000;
/** 每多久量一次。 */
export const LIGHT_SAMPLE_MS = 30_000;
/** 超過這麼久沒有讀值（鏡頭關了、畫面不正常）就當成不知道。 */
export const LIGHT_STALE_MS = 3 * LIGHT_SAMPLE_MS;

export type LightLevel = "dark" | "bright";

export interface LightState {
  /** 目前認定的亮度；null 是還不知道。 */
  level: LightLevel | null;
  /** 最近一次讀值與時間。 */
  luma: number | null;
  at: number | null;
  /** 讀值和目前認定不同、開始等待的時間。 */
  pendingSince: number | null;
}

export const INITIAL_LIGHT: LightState = { level: null, luma: null, at: null, pendingSince: null };

function classify(luma: number, current: LightLevel | null): LightLevel | null {
  if (luma < DARK_LUMA) return "dark";
  if (luma > BRIGHT_LUMA) return "bright";
  return current;
}

/**
 * 收到一個讀值（純函式）。還不知道時（第一次或讀值太舊），「亮」直接定案，「暗」也要連續 LIGHT_HOLD_MS 才算：
 * 剛開鏡頭的一格可能是全黑或舊畫面，不能一格就切到夜間。已知之後要連續 LIGHT_HOLD_MS 都是另一邊才切換。
 */
export function nextLight(prev: LightState, luma: number, now: number): LightState {
  const base = prev.at !== null && now - prev.at > LIGHT_STALE_MS ? INITIAL_LIGHT : prev;
  const seen = classify(luma, base.level);
  if (base.level === null && seen === "bright") return { level: "bright", luma, at: now, pendingSince: null };
  if (seen === null || seen === base.level) return { ...base, luma, at: now, pendingSince: null };
  const since = base.pendingSince ?? now;
  if (now - since >= LIGHT_HOLD_MS) return { level: seen, luma, at: now, pendingSince: null };
  return { ...base, luma, at: now, pendingSince: since };
}

/** 讀值夠新時的亮度，否則 null（不知道）。 */
export function currentLight(state: LightState, now: number): LightLevel | null {
  if (state.at === null || now - state.at > LIGHT_STALE_MS) return null;
  return state.level;
}

export function inNightHours(hour: number, prefs: Pick<DayNightPrefs, "night_start_h" | "night_end_h">): boolean {
  const { night_start_h: start, night_end_h: end } = prefs;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface DayNightDecision {
  mode: DayNightMode;
  reason: DayNightReason;
  /** 這次判斷有沒有用到鏡頭讀值（沒開、不知道或設定關閉時 false）。 */
  camera: boolean;
}

export function decideDayNight(hour: number, light: LightLevel | null, prefs: DayNightPrefs, override: DayNightOverride | null = null, now: number = Date.now()): DayNightDecision {
  const camera = prefs.use_camera && light !== null;
  if (override && now < override.until) return { mode: override.mode, reason: "manual", camera };
  if (inNightHours(hour, prefs)) return { mode: "night", reason: "hours", camera };
  if (camera && light === "dark") return { mode: "night", reason: "camera_dark", camera };
  return { mode: "day", reason: "day", camera };
}

export function isHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

/** 讀已保存的設定；不合法的欄位用預設值。 */
export function parseDayNightPrefs(raw: unknown): DayNightPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    night_start_h: isHour(o.night_start_h) ? o.night_start_h : DEFAULT_DAY_NIGHT_PREFS.night_start_h,
    night_end_h: isHour(o.night_end_h) ? o.night_end_h : DEFAULT_DAY_NIGHT_PREFS.night_end_h,
    use_camera: typeof o.use_camera === "boolean" ? o.use_camera : DEFAULT_DAY_NIGHT_PREFS.use_camera,
    night_effects: typeof o.night_effects === "boolean" ? o.night_effects : DEFAULT_DAY_NIGHT_PREFS.night_effects,
    screen_off: typeof o.screen_off === "boolean" ? o.screen_off : DEFAULT_DAY_NIGHT_PREFS.screen_off,
  };
}

/** DN-1：夜間模式要一併套用的行為（純函式；日間或 night_effects 關閉時全部是 false，只剩對話音量的切換）。 */
export interface NightEffects {
  /** 整個畫面變暗（CSS 疊一層半透明黑，約 3 秒漸變；不改電子腦腦區連動的事件來源）。 */
  dim: boolean;
  /** 處理中的聲納提示音不出聲（電子腦的「處理中」樣子照常）。 */
  muteProcessingCue: boolean;
  /** 回憶模式不開始播放；正在播放的收起。 */
  pauseMemories: boolean;
}

export const NO_NIGHT_EFFECTS: NightEffects = { dim: false, muteProcessingCue: false, pauseMemories: false };

export function nightEffects(mode: DayNightMode, prefs: Pick<DayNightPrefs, "night_effects">): NightEffects {
  if (mode !== "night" || !prefs.night_effects) return NO_NIGHT_EFFECTS;
  return { dim: true, muteProcessingCue: true, pauseMemories: true };
}

/** 畫面平均亮度（Rec. 601），每隔 step 個像素取一個；只回傳一個數字。 */
export function frameLuma(rgba: ArrayLike<number>, step = 1): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4 * step) {
    sum += 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
    n++;
  }
  return n ? sum / n : 0;
}

// ───────────── DN-2：核心共用的設定與手動切換（George 2026-11-08） ─────────────
// 夜間時段、用鏡頭判斷、一併套用與手動切換存在核心（configDir/day-night.json），Mac 與 Pi 共用；
// 鏡頭亮度仍是各頁面自己量（只影響那台裝置）。手動切換一定有結束時間，到時自動回到依時段與鏡頭判斷。

/** 手動切換：mode 維持到 until（epoch 毫秒）。 */
export interface DayNightOverride {
  mode: DayNightMode;
  until: number;
  /** 使用者選的是哪一種（只用來標示按鈕；舊檔沒有時當成 now）。 */
  scope?: DayNightOverrideScope;
}

/** now：到下一次時段交界（夜間開始或結束）；tonight：到今晚（或現在這段夜間）結束。 */
export type DayNightOverrideScope = "now" | "tonight";

export const DAY_NIGHT_WRITE_PATH = "/api/settings/day-night" as const;

/** 沒有夜間時段（開始等於結束）時，手動切換維持多久。 */
export const OVERRIDE_FALLBACK_MS = { now: 12 * 3_600_000, tonight: 24 * 3_600_000 } as const;

const HOUR_MS = 3_600_000;

/** 從 now 往後找下一個整點交界，在那之後是否在夜間時段和現在不同（本機時區；找不到時 null）。 */
export function nextScheduledChange(now: number, prefs: Pick<DayNightPrefs, "night_start_h" | "night_end_h">): number | null {
  const current = inNightHours(new Date(now).getHours(), prefs);
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  let t = d.getTime() + HOUR_MS;
  for (let i = 0; i < 48; i++, t += HOUR_MS) {
    if (inNightHours(new Date(t).getHours(), prefs) !== current) return t;
  }
  return null;
}

/** 手動切換的結束時間（純函式）。 */
export function overrideUntil(now: number, scope: DayNightOverrideScope, prefs: Pick<DayNightPrefs, "night_start_h" | "night_end_h">): number {
  const next = nextScheduledChange(now, prefs);
  if (next === null) return now + OVERRIDE_FALLBACK_MS[scope];
  if (scope === "now" || inNightHours(new Date(now).getHours(), prefs)) return next;
  // 白天說「今晚」：跳過今晚開始，到今晚結束。
  return nextScheduledChange(next, prefs) ?? now + OVERRIDE_FALLBACK_MS.tonight;
}

/** 還有效的手動切換（過期時 null）。 */
export function activeOverride(override: DayNightOverride | null | undefined, now: number): DayNightOverride | null {
  return override && now < override.until ? override : null;
}

export class DayNightPatchError extends Error {}

/** HTTP body：設定欄位之外，override 是 day／night／auto（auto＝取消手動），scope 只能跟 override 一起送。 */
export interface DayNightPatch extends Partial<DayNightPrefs> {
  override?: DayNightMode | "auto";
  scope?: DayNightOverrideScope;
}

/** 邊界驗證（HTTP body）：不認得的鍵或型別不對一律丟 DayNightPatchError（→ HTTP 400）。 */
export function parseDayNightPatch(input: unknown): DayNightPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DayNightPatchError("日夜間設定必須是 JSON 物件");
  const patch: DayNightPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "night_start_h" || key === "night_end_h") {
      if (!isHour(value)) throw new DayNightPatchError(`${key} 必須是 0 到 23 的整數`);
      patch[key] = value;
    } else if (key === "use_camera" || key === "night_effects" || key === "screen_off") {
      if (typeof value !== "boolean") throw new DayNightPatchError(`${key} 必須是 true 或 false`);
      patch[key] = value;
    } else if (key === "override") {
      if (value !== "day" && value !== "night" && value !== "auto") throw new DayNightPatchError("override 只能是 day、night 或 auto");
      patch.override = value;
    } else if (key === "scope") {
      if (value !== "now" && value !== "tonight") throw new DayNightPatchError("scope 只能是 now 或 tonight");
      patch.scope = value;
    } else throw new DayNightPatchError(`未知的日夜間設定：${key}`);
  }
  if (patch.scope && (!patch.override || patch.override === "auto")) throw new DayNightPatchError("scope 只能和 override day／night 一起送");
  if (Object.keys(patch).length === 0) throw new DayNightPatchError("沒有要改的日夜間設定");
  return patch;
}

/** 讀已保存的手動切換（day-night.json 的 override 鍵）；不合法時丟錯。 */
export function parseStoredOverride(value: unknown): DayNightOverride | null {
  if (value === null) return null;
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!o || (o.mode !== "day" && o.mode !== "night") || typeof o.until !== "number" || !Number.isFinite(o.until)) throw new DayNightPatchError("override 格式不對");
  return { mode: o.mode, until: o.until, ...(o.scope === "tonight" || o.scope === "now" ? { scope: o.scope } : {}) };
}

/** settings.day_night：核心保存的設定、還有效的手動切換，以及核心依時段與手動切換算出的模式（不含鏡頭）。 */
export interface DayNightSettingsView {
  prefs: DayNightPrefs;
  override: DayNightOverride | null;
  /** 有沒有保存過（false 時頁面可以把舊的頁面設定搬過來一次）。 */
  saved: boolean;
  /** 核心的判斷（時段＋手動，不含各裝置的鏡頭）：輕聲語氣看這個。 */
  core_mode: DayNightMode;
  write_path: typeof DAY_NIGHT_WRITE_PATH;
}

/** 時間顯示成 HH:MM（本機時區）。 */
export function clockText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ───────────── DN-2：語音工具 set_day_night ─────────────

export interface DayNightToolRequest {
  mode: DayNightMode | "auto";
  scope?: DayNightOverrideScope;
}

/** 模型給的參數（不合法的 mode 當成 null，由呼叫端回錯）。 */
export function parseDayNightToolArgs(args: Record<string, unknown>): DayNightToolRequest | null {
  const mode = args.mode;
  if (mode !== "day" && mode !== "night" && mode !== "auto") return null;
  const scope = args.scope === "tonight" ? "tonight" : args.scope === "now" ? "now" : undefined;
  return mode === "auto" ? { mode } : { mode, ...(scope ? { scope } : {}) };
}

/** 交給模型的結果：現在的模式、原因與手動切換維持到幾點（照實；不說成功以外的事）。 */
export function dayNightToolOutput(decision: DayNightDecision, override: DayNightOverride | null): Record<string, unknown> {
  const base = { ok: true, status: "confirmed", mode: decision.mode, reason: decision.reason };
  if (decision.reason === "manual" && override) return { ...base, until: clockText(override.until), note: `手動切換，${clockText(override.until)} 之後自動回到依時段判斷。` };
  return { ...base, note: "已恢復自動：依夜間時段與鏡頭亮度判斷。" };
}

// ───────────── DN-3：Pi 深夜關螢幕（George 2026-11-08） ─────────────
// 終端機頁面依「夜間模式＋閒置」算出螢幕要開或關，回報給核心（POST /api/terminal/display）；Pi 套件的 aios-display 每 2 秒
// 經 SSH 通道讀（GET /api/terminal/display?terminal=rpi4），照著開關螢幕。讀不到、讀值太舊或頁面沒回報時一律開（不會卡在黑畫面）。

export const TERMINAL_DISPLAY_PATH = "/api/terminal/display" as const;
/** 夜間閒置多久關螢幕。 */
export const SCREEN_IDLE_MS = 5 * 60_000;
/** 頁面多久重新回報一次（狀態沒變也送，讓核心知道頁面還活著）。 */
export const SCREEN_REPORT_MS = 10_000;
/** 核心超過這麼久沒收到回報就當成「開」。 */
export const SCREEN_STALE_MS = 30_000;

export type ScreenState = "on" | "off";

export function isScreenState(value: unknown): value is ScreenState {
  return value === "on" || value === "off";
}

/** 螢幕要開或關（純函式）：夜間、設定開著、沒有在忙、閒置夠久才關。 */
export function screenWanted(input: { mode: DayNightMode; prefs: Pick<DayNightPrefs, "screen_off">; busy: boolean; idleMs: number }): ScreenState {
  return input.mode === "night" && input.prefs.screen_off && !input.busy && input.idleMs >= SCREEN_IDLE_MS ? "off" : "on";
}
