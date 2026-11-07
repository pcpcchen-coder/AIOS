// HOME-1（George 2026-11-07）：畫面左上角的家中狀態（室內溫濕度、燈與插座開了幾個、冷氣）。
// 和右上角時鐘（shared/clock.ts）一樣是環境狀態角落：被動讀數，不是 Surface、Dashboard 或 App 入口；沒有按鈕、不能點、不能控制。
// 這裡只有型別、固定表與純函式（核心、頁面與測試都讀），沒有網址或檔案。
// - 資料只來自核心的 GET /api/home/overview（武陵居中控 GET /home 與 GET /integrations/aifa 的整理）；讀不到照實說。
// - 開關狀態只用中控回報的 state.power；沒有回報時是「—」，不猜。冷氣只有控制器回報（不是冷氣本身的狀態），帶上時間。
import { translate, type Locale } from "./i18n.mjs";

// ───────────── 設定（configDir/home-corner.json） ─────────────

export interface HomeCornerPrefs {
  /** Mac 主視窗（以及不帶 ?terminal= 的瀏覽器頁面）顯示（預設關）。 */
  main: boolean;
  /** 終端機頁面（Pi kiosk）顯示（預設開，同右上角時鐘）。 */
  terminal: boolean;
}

export type HomeCornerPrefsPatch = Partial<HomeCornerPrefs>;

export const DEFAULT_HOME_CORNER_PREFS: HomeCornerPrefs = { main: false, terminal: true };
export const HOME_CORNER_PREF_KEYS = Object.keys(DEFAULT_HOME_CORNER_PREFS) as (keyof HomeCornerPrefs)[];
export const HOME_CORNER_WRITE_PATH = "/api/settings/home-corner" as const;
export const HOME_OVERVIEW_PATH = "/api/home/overview" as const;

export class HomeCornerPatchError extends Error {}

/** 邊界驗證（HTTP body、home-corner.json 的每一個鍵）：不認得的鍵或不是 true／false 一律丟 HomeCornerPatchError（→ HTTP 400）。 */
export function parseHomeCornerPatch(input: unknown): HomeCornerPrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HomeCornerPatchError("家中狀態設定必須是 JSON 物件");
  const patch: HomeCornerPrefsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "main" && key !== "terminal") throw new HomeCornerPatchError(`未知的家中狀態設定：${key}`);
    if (typeof value !== "boolean") throw new HomeCornerPatchError(`${key} 必須是 true 或 false`);
    patch[key] = value;
  }
  return patch;
}

/** settings.home_corner：enabled＝這個頁面（依 X-Nous-Terminal 判斷 Mac 主視窗或終端機）要不要顯示。 */
export interface HomeCornerSettingsView {
  enabled: boolean;
  prefs: HomeCornerPrefs;
  write_path: typeof HOME_CORNER_WRITE_PATH;
}

/** 設定頁、選單列與角落共用的文字（中文是翻譯表的鍵；desktop/settings-menu.mjs 有同一份，tests/home-corner.test.ts 核對兩邊一致）。 */
export const HOME_CORNER_TEXT = {
  group: "左上角家中狀態",
  main: "Mac 視窗",
  mainNote: "在 Mac 的 Nous 視窗左上角顯示室內溫濕度、開著的燈與冷氣",
  terminal: "Pi 終端機",
  terminalNote: "在 Pi 等終端機畫面左上角顯示室內溫濕度、開著的燈與冷氣",
  note: "只顯示武陵居中控回報的狀態，不能點、不能控制；中控沒有回報的開關顯示「—」",
  aria: "家中狀態：{0}",
  notConfigured: "智慧家庭未設定",
  unreachable: "讀不到中控",
  coreDown: "核心沒有回應",
  timeout: "中控沒有回應（逾時）",
  refused: "連不上中控",
  auth: "中控拒絕了權杖",
  badResponse: "中控回應錯誤",
  empty: "中控沒有可顯示的設備",
  age: "{0} 分鐘前",
  ageHours: "{0} 小時前",
  snapshot: "快照",
  stale: "過期資料",
  lights: "燈 {0}／{1} 開著",
  lightsUnknown: "燈 —／{0}",
  switches: "插座開關 {0}／{1} 開著",
  switchesUnknown: "插座開關 —／{0}",
  unknownCount: "{0} 個未知",
  acOn: "開",
  acOff: "關",
  acReported: "控制器回報 · {0}",
  humidity: "濕度",
} as const;

// ───────────── GET /api/home/overview 的回應 ─────────────

export type HomeOverviewError = "timeout" | "unreachable" | "auth" | "bad_response";
export type HomeClimateKey = "temperature" | "humidity" | "co2" | "pm25";
export const HOME_CLIMATE_KEYS: readonly HomeClimateKey[] = ["temperature", "humidity", "co2", "pm25"];
export type HomeDataStatus = "live" | "snapshot" | "stale" | "missing";

/** 一種室內讀值（每種只取一台：即時優先、再取最新）。value null＝中控沒有讀值。age_s＝回應當下距離中控收到讀值的秒數。 */
export interface HomeClimateReading {
  key: HomeClimateKey;
  value: number | null;
  unit: string;
  precision: number;
  room: string | null;
  status: HomeDataStatus;
  age_s: number | null;
}

/** 一組可開關的設備。on／off 只算中控回報 state.power 的設備；其餘算 unknown。on_names 最多 4 個。 */
export interface HomeSwitchGroup {
  group: "light" | "switch";
  total: number;
  on: number;
  unknown: number;
  on_names: string[];
}

export type HomeAcMode = "auto" | "cool" | "dry";

/** AIFA 冷氣：控制器記得的設定（不是冷氣本身的狀態）。沒有回報或超過 2 小時時 power 與 age_s 都是 null。 */
export interface HomeAcState {
  name: string;
  room: string | null;
  power: boolean | null;
  mode: HomeAcMode | null;
  temperature: number | null;
  age_s: number | null;
}

export type HomeOverviewView =
  | { configured: false }
  | { configured: true; state: "unreachable"; error: HomeOverviewError; server_now: number }
  | { configured: true; state: "ok"; server_now: number; climate: HomeClimateReading[]; switches: HomeSwitchGroup[]; ac: HomeAcState[] };

export const HOME_ON_NAMES_MAX = 4;
/** 冷氣控制器回報超過這個年紀（ms）就當成不知道。 */
export const HOME_AC_REPORT_KEEP_MS = 2 * 60 * 60_000;

// ───────────── 頁面的排程 ─────────────

/** 頁面看得到時多久重讀一次（核心另有 30 秒快取）。 */
export const HOME_REFRESH_MS = 60_000;
/** 讀家中狀態的請求最多等這麼久（核心讀中控最多 8 秒）。 */
export const HOME_FETCH_TIMEOUT_MS = 15_000;
/** 室內讀值超過這個年紀（秒）就標「N 分鐘前」；快照與過期資料一律標。 */
export const HOME_CLIMATE_AGE_S = 10 * 60;

// ───────────── 角落要畫的內容（純函式；頁面照這個畫） ─────────────

export type HomeIconKind = "thermometer" | "droplet" | "bulb" | "plug" | "ac" | "home";

export interface HomeCornerLine {
  icon: HomeIconKind;
  text: string;
  /** 接在 text 後面、不拆行的補充：「2 個未知」。 */
  extra: string | null;
  /** 第二行灰字：開著的燈名稱、冷氣回報的時間。 */
  detail: string | null;
  /** 開著的設備：圖示亮起；都關著或不知道時灰色。 */
  active: boolean;
}

export interface HomeCornerModel {
  /** data：畫讀數；note：只畫一行灰字（未設定、讀不到）；none：還沒有回應，不畫。 */
  kind: "data" | "note" | "none";
  note: string | null;
  noteDetail: string | null;
  /** 室內大字：溫度、濕度；沒有時 null。 */
  temp: string | null;
  humidity: string | null;
  /** 溫度下方一行：房間、CO₂、PM2.5、資料時間。 */
  climateDetail: string | null;
  lines: HomeCornerLine[];
  label: string;
}

const tr = (locale: Locale, source: string, ...values: unknown[]) => translate(source, locale, ...values);

/** 「5 分鐘前」「2 小時前」；不到 1 分鐘算 1 分鐘。 */
export function homeAge(ageS: number, locale: Locale): string {
  const minutes = Math.max(1, Math.floor(ageS / 60));
  return minutes >= 120 ? tr(locale, HOME_CORNER_TEXT.ageHours, Math.floor(minutes / 60)) : tr(locale, HOME_CORNER_TEXT.age, minutes);
}

function numberText(value: number, precision: number): string {
  const p = Math.max(0, Math.min(1, Math.round(precision)));
  const fixed = value.toFixed(p);
  return fixed === "-0" || fixed === "-0.0" ? fixed.slice(1) : fixed;
}

function readingText(r: HomeClimateReading | undefined): string | null {
  if (!r) return null;
  if (r.value === null) return "—";
  switch (r.key) {
    case "temperature":
      return `${numberText(r.value, r.precision)}°`;
    case "humidity":
      return `${numberText(r.value, 0)}%`;
    case "co2":
      return `CO₂ ${numberText(r.value, 0)}${r.unit ? ` ${r.unit}` : ""}`;
    case "pm25":
      return `PM2.5 ${numberText(r.value, 0)}${r.unit ? ` ${r.unit}` : ""}`;
  }
}

/** 讀值的時間：快照、過期資料、或超過 10 分鐘的即時值；即時而且夠新、或沒有讀值（畫「—」）時 null。 */
function readingAge(r: HomeClimateReading, locale: Locale): string | null {
  if (r.status === "missing") return null;
  if (r.status === "live" && (r.age_s === null || r.age_s < HOME_CLIMATE_AGE_S)) return null;
  if (r.age_s !== null) return homeAge(r.age_s, locale);
  return r.status === "snapshot" ? tr(locale, HOME_CORNER_TEXT.snapshot) : r.status === "stale" ? tr(locale, HOME_CORNER_TEXT.stale) : null;
}

const AC_MODE: Record<HomeAcMode, { zh: string; en: string }> = { auto: { zh: "自動", en: "Auto" }, cool: { zh: "冷氣", en: "Cool" }, dry: { zh: "除濕", en: "Dry" } };

function switchLine(g: HomeSwitchGroup, locale: Locale): HomeCornerLine {
  const light = g.group === "light";
  const known = g.total - g.unknown;
  const text =
    known === 0
      ? tr(locale, light ? HOME_CORNER_TEXT.lightsUnknown : HOME_CORNER_TEXT.switchesUnknown, g.total)
      : tr(locale, light ? HOME_CORNER_TEXT.lights : HOME_CORNER_TEXT.switches, g.on, g.total);
  const extra = known > 0 && g.unknown > 0 ? tr(locale, HOME_CORNER_TEXT.unknownCount, g.unknown) : null;
  const sep = locale === "en" ? ", " : "、";
  const names = g.on_names.length ? g.on_names.join(sep) + (g.on > g.on_names.length ? "…" : "") : null;
  return { icon: light ? "bulb" : "plug", text, extra, detail: names, active: g.on > 0 };
}

function acLine(a: HomeAcState, locale: Locale): HomeCornerLine {
  if (a.power === null || a.age_s === null) return { icon: "ac", text: `${a.name} —`, extra: null, detail: null, active: false };
  const settings = a.power ? [a.temperature !== null ? `${a.temperature}°` : null, a.mode ? AC_MODE[a.mode][locale === "en" ? "en" : "zh"] : null].filter((p): p is string => !!p) : [];
  const text = `${a.name} ${tr(locale, a.power ? HOME_CORNER_TEXT.acOn : HOME_CORNER_TEXT.acOff)}` + (settings.length ? ` · ${settings.join(" ")}` : "");
  return { icon: "ac", text, extra: null, detail: tr(locale, HOME_CORNER_TEXT.acReported, homeAge(a.age_s, locale)), active: a.power };
}

const ERROR_TEXT: Record<HomeOverviewError, string> = {
  timeout: HOME_CORNER_TEXT.timeout,
  unreachable: HOME_CORNER_TEXT.refused,
  auth: HOME_CORNER_TEXT.auth,
  bad_response: HOME_CORNER_TEXT.badResponse,
};

/**
 * 角落的內容。view：最近一次 GET /api/home/overview 的回應；null＝還沒回應過。coreDown：上一次向核心讀失敗。
 * 讀不到時只說讀不到，不沿用舊的數字。
 */
export function homeCornerModel(input: { view: HomeOverviewView | null; coreDown: boolean; locale: Locale }): HomeCornerModel {
  const { view, coreDown, locale } = input;
  const base: HomeCornerModel = { kind: "none", note: null, noteDetail: null, temp: null, humidity: null, climateDetail: null, lines: [], label: "" };
  const note = (text: string, detail: string | null): HomeCornerModel => ({
    ...base,
    kind: "note",
    note: tr(locale, text),
    noteDetail: detail ? tr(locale, detail) : null,
    label: tr(locale, HOME_CORNER_TEXT.aria, [tr(locale, text), detail ? tr(locale, detail) : null].filter(Boolean).join(locale === "en" ? ", " : "，")),
  });
  if (coreDown) return note(HOME_CORNER_TEXT.unreachable, HOME_CORNER_TEXT.coreDown);
  if (!view) return base;
  if (!view.configured) return note(HOME_CORNER_TEXT.notConfigured, null);
  if (view.state === "unreachable") return note(HOME_CORNER_TEXT.unreachable, ERROR_TEXT[view.error]);

  const byKey = new Map(view.climate.map((r) => [r.key, r]));
  const temperature = byKey.get("temperature");
  const humidity = byKey.get("humidity");
  const main = temperature ?? humidity;
  const extras = [readingText(byKey.get("co2")), readingText(byKey.get("pm25"))].filter((p): p is string => !!p);
  const ages = [...new Set(view.climate.map((r) => readingAge(r, locale)).filter((p): p is string => !!p))];
  const climateDetail = [main?.room ?? null, ...extras, ...ages].filter((p): p is string => !!p);
  const lines = [...view.switches.filter((g) => g.total > 0).map((g) => switchLine(g, locale)), ...view.ac.map((a) => acLine(a, locale))];
  const temp = readingText(temperature);
  const hum = readingText(humidity);
  if (!temp && !hum && !extras.length && !lines.length) return note(HOME_CORNER_TEXT.empty, null);
  const sep = locale === "en" ? ", " : "，";
  const spoken = [
    temp,
    hum ? `${tr(locale, HOME_CORNER_TEXT.humidity)} ${hum}` : null,
    climateDetail.length ? climateDetail.join(" · ") : null,
    ...lines.map((l) => [l.text, l.extra, l.detail].filter(Boolean).join(" · ")),
  ].filter((p): p is string => !!p);
  return {
    ...base,
    kind: "data",
    temp,
    humidity: hum,
    climateDetail: climateDetail.length ? climateDetail.join(" · ") : null,
    lines,
    label: tr(locale, HOME_CORNER_TEXT.aria, spoken.join(sep)),
  };
}
