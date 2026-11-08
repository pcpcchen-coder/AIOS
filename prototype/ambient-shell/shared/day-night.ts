// VOL-2（George 2026-11-07）：日間／夜間的對話音量。晚上不要吵到人，白天要夠大聲。
// 判斷是純函式：夜間時段內，或鏡頭量到的環境很暗（燈關了），就用夜間音量；兩者都不成立才用日間音量。
// 鏡頭會自動曝光：晚上開著燈時畫面仍然亮，所以「亮」不會把夜間時段改成白天，只有「暗」能把白天改成夜間。
// 鏡頭沒開、量不到或讀值太舊時只看時段，並照實標出來源。

export type DayNightMode = "day" | "night";
/** hours：在夜間時段內；camera_dark：鏡頭量到很暗；day：兩者都不成立。 */
export type DayNightReason = "hours" | "camera_dark" | "day";

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
}

export const DEFAULT_DAY_NIGHT_PREFS: DayNightPrefs = { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true };
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

export function decideDayNight(hour: number, light: LightLevel | null, prefs: DayNightPrefs): DayNightDecision {
  const camera = prefs.use_camera && light !== null;
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
