// 雙目鏡頭的感知事件與設定（docs/11）。影像只在本機處理；離開感知管線的只有這些事件，不含任何影像或關鍵點座標。
// 使用者要求看鏡頭畫面時，管線把縮小的畫面直接畫到本頁畫布（不寫檔、不進 trace、不外傳）。
import { parsePrefsPatch, prefDefaults, stepPref, type PrefSpecs } from "./prefs.ts";

export type PointZone = "left" | "center" | "right";

export type SensorState = "off" | "starting" | "ok" | "degraded" | "error";

export type SenseEvent =
  /** 螢幕前有沒有人，以及實測距離（公尺，取中位數平滑）。 */
  | { type: "presence"; present: boolean; distance_m: number | null }
  /** 是否面向螢幕（以頭部方向估計，不是眼睛視線）。 */
  | { type: "attention"; facing: boolean }
  /** 停止手勢：舉起張開的手掌朝向螢幕。 */
  | { type: "gesture"; kind: "stop" }
  /** 手臂指向的螢幕區塊（使用者看到的左／中／右）；null 表示沒有穩定指向。 */
  | { type: "pointing"; zone: PointZone | null }
  /** 鏡頭狀態；detail 為可直接顯示的說明。 */
  | { type: "sensor"; state: SensorState; detail: string };

/** 安裝設定：只來自 .env，核心執行期間不變（決定頁面標頭、選哪支鏡頭與幾何）。 */
export interface CameraInstall {
  /** NOUS_CAMERA；決定 Permissions-Policy／CSP，改變需要重新啟動核心。 */
  enabled: boolean;
  /** 依裝置名稱挑選鏡頭（AR0144 在 macOS 上顯示為 CCB Camera）。 */
  label: string;
  /** 併排影像左半是否為左眼；實測確認前預設 true（docs/11、ADR-0005 待驗證）。 */
  left_first: boolean;
  /** 螢幕寬度（mm），18 吋 16:9 約 398。 */
  screen_width_mm: number;
  /** 鏡頭光心到螢幕中心的垂直距離（mm，鏡頭在上緣時為正）。 */
  screen_offset_mm: number;
}

/** 使用者設定：可在「設定」畫面或用語音改，保存在 configDir/camera.json。 */
export interface CameraPrefs {
  /** 使用者要不要開鏡頭；「鏡頭關掉」保存為 false，重新連線或重新啟動都不會自己打開。 */
  active: boolean;
  /** 看著說話：面向螢幕一段時間後自動開始即時語音（免手操作）。 */
  look_to_talk: boolean;
  /** 從開始面向螢幕算起，幾秒後開始對話（使用者感受到的秒數，含面向確認）。 */
  look_to_talk_s: number;
  /** 對話結束（或自動開始）後幾秒內不再自動開始。 */
  look_to_talk_cooldown_s: number;
  /**
   * 看著說話時先打招呼（George 2026-10-23）：看著說話開始的即時語音，連線完成後 Nous 先說一句招呼（每次對話最多一次）。
   * 按鈕、語音指令或打字開始的不打招呼；使用者先開口就不打。
   */
  look_to_talk_greet: boolean;
  /**
   * 問候時稱呼認出的家人（George 2026-10-25，ID-02；預設開）：macOS App 在看著說話的面向等待期間同步辨識已登記的家人，
   * 可靠認出時問候說「名字，我在」，名字會成為雲端語音供應商收到的短句。關掉：只說「我在」，看著說話時也不做辨識。
   * 門檻未校準；瀏覽器版不支援辨識，這個開關沒有作用。
   */
  look_to_talk_greet_name: boolean;
  /** 手掌停止播報：舉起張開的手掌停止 Nous 說話（不取消任務）。 */
  stop_gesture: boolean;
  /**
   * 靠近時電子腦的最大放大倍率（George 2026-10-23）：站在 BRAIN_ZOOM_NEAR_M 以內時電子腦放大到這個倍率，
   * BRAIN_ZOOM_FAR_M 以外是 1 倍（src/sense/controller.ts brainZoom）。1 = 不放大。字級不受影響（仍是 D ÷ 2 m）。
   */
  brain_zoom_max: number;
}

/** 問候的固定部分（docs/14 §1、§6）：沒有可靠姓名時的基本句，也是瀏覽器版與決策失敗時用的句子。 */
export const GREETING_PLAIN = "我在";

/** 本機時段（George 2026-10-25）：5–11 點早安、11–18 點午安、18 點以後晚上好（「晚安」在中文多指道晚安，不用）；0–4 點不加問候語。 */
export type DaySlot = "morning" | "afternoon" | "evening" | null;

export function daySlot(hour: number): DaySlot {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 18) return "afternoon";
  if (hour >= 18) return "evening";
  return null;
}

/**
 * 這台電腦（或指定時區）現在是幾點（0–23）。時區的取法同 server/home-bridge.ts：未指定就用這台電腦的時區。
 */
export function localHour(now: number, timeZone?: string): number {
  const hour = Number(new Date(now).toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone }));
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : new Date(now).getHours();
}

/**
 * 問候短句的固定清單（George 2026-10-25：要多一點變化，但不讓模型自由生成，也不改成提問）。
 * - id 只是編號，核心 log 只記它，不記句子；
 * - named：要有名字（名字必須是核心從受管理人物檔案取出、經 shared/identity.ts speakableName 驗證過的口語名稱）；
 * - slot：只在那個時段可以用（null＝任何時段）。
 * 全部都是短句、不是問句。頁面與客戶端傳來的文字不能走到這裡（server/greeting-picker.ts 挑句）。
 */
export interface GreetingTemplate {
  id: string;
  named: boolean;
  slot: DaySlot;
  render(name: string | null): string;
}

export const GREETING_TEMPLATES: readonly GreetingTemplate[] = [
  { id: "n0", named: true, slot: null, render: (n) => `${n}，我在` },
  { id: "n1", named: true, slot: null, render: (n) => `嗨，${n}` },
  { id: "n2", named: true, slot: null, render: (n) => `${n}，你好` },
  { id: "n3", named: true, slot: null, render: (n) => `我在這，${n}` },
  { id: "n4", named: true, slot: "morning", render: (n) => `早安，${n}` },
  { id: "n5", named: true, slot: "afternoon", render: (n) => `午安，${n}` },
  { id: "n6", named: true, slot: "evening", render: (n) => `晚上好，${n}` },
  { id: "p0", named: false, slot: null, render: () => GREETING_PLAIN },
  { id: "p1", named: false, slot: null, render: () => "嗨，我在" },
  { id: "p2", named: false, slot: null, render: () => "你好" },
  { id: "p3", named: false, slot: "morning", render: () => "早安" },
  { id: "p4", named: false, slot: "afternoon", render: () => "午安" },
  { id: "p5", named: false, slot: "evening", render: () => "晚上好" },
];

/** 這個時段可以用的模板（有名字或沒名字）。 */
export function greetingCandidates(named: boolean, slot: DaySlot): GreetingTemplate[] {
  return GREETING_TEMPLATES.filter((t) => t.named === named && (t.slot === null || t.slot === slot));
}

/**
 * 從固定清單隨機挑一句（亂數由呼叫端注入，測試可固定）。可選的不只一句時，避開上一次用過的模板。
 * name 為 null 時只挑不含名字的句子。
 */
export function pickGreeting(name: string | null, slot: DaySlot, last: string | null, random: () => number): { id: string; sentence: string } {
  const all = greetingCandidates(name !== null, slot);
  const pool = all.length > 1 ? all.filter((t) => t.id !== last) : all;
  const t = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
  return { id: t.id, sentence: t.render(name) };
}

/** 基本句（不分時段）：登記畫面預覽用（「George，我在」或「我在」）。 */
export function greetingSentence(name: string | null): string {
  return GREETING_TEMPLATES.find((t) => t.id === (name ? "n0" : "p0"))!.render(name);
}

/**
 * 看著說話開始的即時語音連上後，請模型照念的那一句（兩條路徑共用）。只知道使用者面向螢幕：
 * 不得說看到使用者、不得描述長相或環境（CLAUDE.md：沒有影像分析時不得宣稱正在觀看）；也不得自己猜名字。
 * 模型仍可能改寫：驗收要看實際逐字稿，不能只看這段指示（docs/validation/family-id-02-2026-10-25.md）。
 */
export function greetingInstructions(sentence: string): string {
  return (
    `你是 Nous。使用者剛面向螢幕開始語音對話：請用繁體中文只說這一句，一字不改，不要加字、不要提問：「${sentence}」。` +
    "你看不到畫面：不要說看到使用者，也不要提到長相、表情、穿著或周遭環境；除了這一句裡已有的名字，不要說出或猜測任何名字。"
  );
}

/** 沒有姓名、也沒有核心挑句時的問候指示（API key 路徑：瀏覽器版與決策失敗時用它）。 */
export const LOOK_TO_TALK_GREETING = greetingInstructions(GREETING_PLAIN);

/**
 * ChatGPT 方案路徑的招呼要放進 session.context.append speakable：前面加這個固定標記，
 * 語音層說明（server/realtime.ts buildLiveInstructions）才知道這段只是開場指示、不要念出來。
 */
export const GREETING_MARKER = "（開場）";

/** ChatGPT 方案路徑真正送給模型的招呼（核心組成；頁面送來的文字只是互動 ID，不會變成內容）。 */
export function liveGreetingText(sentence: string): string {
  return `${GREETING_MARKER}${greetingInstructions(sentence)}`;
}

/** 核心沒有挑句時 ChatGPT 方案路徑送的招呼（LiveRoute 沒有接上 greeting 來源時的保底）。 */
export const LIVE_GREETING_TEXT = liveGreetingText(GREETING_PLAIN);

/** SettingsView.camera 的形狀。 */
export type CameraSettings = CameraInstall & CameraPrefs;

export type CameraPrefsPatch = Partial<CameraPrefs>;

/**
 * 電子腦靠近放大的距離端點（公尺）：FAR 以外 1 倍，NEAR 以內到使用者設定的最大倍率，中間依距離線性內插
 * （src/sense/controller.ts brainZoom）。PresenceTracker 只回報 0.5–4 m，NEAR 取 0.6 m 讓最大倍率實際到得了。
 */
export const BRAIN_ZOOM_NEAR_M = 0.6;
export const BRAIN_ZOOM_FAR_M = 2.5;

/**
 * 唯一的使用者設定清單：預設值、伺服器驗證、設定畫面都由此推導；順序就是設定畫面的順序。
 * `satisfies` 讓型別與清單不一致時編譯失敗。
 */
export const CAMERA_PREFS = {
  active: { kind: "bool", default: true, label: "鏡頭", hint: "實際狀態看右下角指示點" },
  look_to_talk: { kind: "bool", default: true, label: "看著說話", hint: "面向螢幕後自動開始即時語音" },
  look_to_talk_s: {
    kind: "seconds", default: 1.5, min: 0.5, max: 5, step: 0.1, presets: [1, 1.5, 2, 3],
    label: "面向螢幕幾秒後開始對話", hint: "從開始面向螢幕算起；系統約每 0.2 秒檢查一次",
  },
  look_to_talk_cooldown_s: {
    kind: "seconds", default: 10, min: 3, max: 60, step: 1, presets: [5, 10, 15, 20, 30, 60],
    label: "對話結束後暫停", hint: "這段時間內不再自動開始，避免說完再見又被打開",
  },
  look_to_talk_greet: {
    kind: "bool", default: true, label: "看著說話時先打招呼",
    hint: "看著說話開始的對話，連上後 Nous 先說「我在」；你先開口就不打招呼",
  },
  look_to_talk_greet_name: {
    kind: "bool", default: true, label: "打招呼時稱呼認出的家人",
    hint: "只在 macOS App：認出已登記的家人時說「名字，我在」，名字會送到雲端語音；關掉只說「我在」（門檻未校準）",
  },
  stop_gesture: { kind: "bool", default: true, label: "手掌停止播報", hint: "舉起張開的手掌停止 Nous 說話（不取消任務）" },
  brain_zoom_max: {
    kind: "factor", default: 2, min: 1, max: 3, step: 0.1, presets: [1, 1.5, 2, 2.5, 3],
    label: "靠近時電子腦放大倍率",
    hint: `站到 ${BRAIN_ZOOM_NEAR_M} m 以內放大到這個倍率，${BRAIN_ZOOM_FAR_M} m 以外不放大；1 倍＝不放大，字級不受影響`,
  },
} as const satisfies PrefSpecs<CameraPrefs>;

export type CameraPrefKey = keyof CameraPrefs;

/** 數值（秒數或倍率）的鏡頭設定鍵。 */
export type CameraNumberKey = { [K in CameraPrefKey]: CameraPrefs[K] extends number ? K : never }[CameraPrefKey];

export const CAMERA_PREF_KEYS = Object.keys(CAMERA_PREFS) as CameraPrefKey[];

export const DEFAULT_CAMERA_PREFS: CameraPrefs = prefDefaults<CameraPrefs>(CAMERA_PREFS);

export class CameraPatchError extends Error {}

/**
 * 邊界驗證（HTTP body、camera.json）：只接受 CAMERA_PREFS 裡的鍵；開關必須是 boolean；
 * 秒數與倍率必須在範圍內且落在 step 上。不默默夾住數值，錯誤一律丟 CameraPatchError（→ HTTP 400）。
 */
export function parseCameraPatch(input: unknown): CameraPrefsPatch {
  return parsePrefsPatch<CameraPrefs>(CAMERA_PREFS, input, { noun: "鏡頭設定", make: (m) => new CameraPatchError(m) });
}

/** 設定畫面的 −／+：移動一格並夾在範圍內。 */
export function stepCameraPref(key: CameraNumberKey, current: number, direction: 1 | -1): number {
  return stepPref(CAMERA_PREFS[key], current, direction);
}

/**
 * 「面向螢幕幾秒」換成 LookToTalk 的停留時間：面向本身要先由 AttentionTracker 確認（attentionOnMs），
 * 剩下的才是停留。1.5 秒、確認 300 ms → 1200 ms。
 */
export function lookToTalkDwellMs(lookToTalkS: number, attentionOnMs: number): number {
  return Math.max(0, Math.round(lookToTalkS * 1000) - attentionOnMs);
}
