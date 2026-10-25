// 感知事件 → Shell 行為（docs/11 §3、§5）。純邏輯，透過 hooks 操作畫面與語音，方便測試。
// 規則：鏡頭只提供指向與在場資訊；手勢與指向都不能觸發外部動作（確認只認語音固定語句）。

import {
  BRAIN_ZOOM_FAR_M,
  BRAIN_ZOOM_NEAR_M,
  DEFAULT_CAMERA_PREFS,
  lookToTalkDwellMs,
  type CameraPrefs,
  type CameraPrefsPatch,
  type CameraSettings,
  type PointZone,
  type SenseEvent,
  type SensorState,
} from "../../shared/sense.ts";
import { AttentionTracker, LookToTalk, type LookTiming } from "./trackers.ts";

/** 控制器每次 tick／handle 都重新讀的使用者設定（不快取，設定改變下一次 tick 就生效）。 */
export type SenseTuning = Pick<CameraPrefs, "look_to_talk" | "look_to_talk_s" | "look_to_talk_cooldown_s" | "stop_gesture" | "brain_zoom_max">;

export interface SenseHooks {
  now(): number;
  /** 即時語音或語音模式是否正在進行。 */
  isTalking(): boolean;
  /** 現在能否不經點擊就開始即時語音（已授權、可用）；看著說話開關由 prefs() 決定。 */
  canAutoTalk(): boolean;
  startTalk(): void;
  /** 停止播報（停止手勢）；不取消任務、不送任何外部指令。 */
  interruptSpeech(): void;
  /** 有人在場 60 秒後離開：結束對話、收起畫面、待確認的動作一律不執行。 */
  onLeave(): void;
  /** 依實測距離縮放字級（docs/10 §2：× D ÷ 2.0 m）。 */
  setScale(scale: number): void;
  /** 電子腦待機圖形的靠近放大倍率（brainZoom；1 = 不放大）。和字級分開：靠近時放大。 */
  setBrainZoom(factor: number): void;
  setPresence(present: boolean): void;
  setFacing(facing: boolean): void;
  /** 指向的畫面區塊（使用者看到的左／中／右）；null 為清除。 */
  pointTo(zone: PointZone | null): void;
  setSensor(state: SensorState, detail: string): void;
  /** 目前的使用者設定；未提供時用 CAMERA_PREFS 的預設。 */
  prefs?(): SenseTuning;
  /**
   * 每次事件與 tick 之後的狀態（ID-02：看著說話時同步辨識依它決定取樣與追蹤世代）。只讀，不能影響看著說話的計時。
   */
  onSense?(snapshot: SenseSnapshot): void;
}

/** 給同步辨識的感知狀態（不含影像或座標）。 */
export interface SenseSnapshot {
  present: boolean;
  facing: boolean;
  /** 最近的實測距離（公尺）；未知為 null。 */
  distance_m: number | null;
  /** 鏡頭裝置事件為 ok（starting、degraded、error、off 都不是）。 */
  sensor_ok: boolean;
  /** 看著說話正在累計面向停留（在場、面向、沒有在對話、不在冷卻）：同步辨識只在這段 delay 內開始取樣。 */
  dwelling: boolean;
}

/** 字級縮放範圍：1.5–3 m（docs/10、11）；超出範圍不再放大。 */
export function distanceScale(distanceM: number | null): number {
  if (distanceM === null) return 1;
  return Math.min(1.5, Math.max(0.75, Math.round((distanceM / 2) * 100) / 100));
}

/**
 * 電子腦的靠近放大（George 2026-10-23，取代 docs/11 §57 對電子腦的距離比例；字級仍用 distanceScale）：
 * BRAIN_ZOOM_FAR_M（2.5 m）以外 1 倍，BRAIN_ZOOM_NEAR_M（0.6 m）以內 max 倍，中間依距離線性內插，四捨五入到 0.01。
 * 線性：每靠近 1 m 放大 (max − 1) ÷ 1.9 倍，整段都看得出變化。距離為空、max 不合法或 ≤ 1 時為 1。
 */
export function brainZoom(distanceM: number | null, max: number): number {
  if (distanceM === null || !Number.isFinite(distanceM) || !Number.isFinite(max) || max <= 1) return 1;
  const t = Math.min(1, Math.max(0, (BRAIN_ZOOM_FAR_M - distanceM) / (BRAIN_ZOOM_FAR_M - BRAIN_ZOOM_NEAR_M)));
  return Math.round((1 + (max - 1) * t) * 100) / 100;
}

export class SenseController {
  private present = false;
  private facing = false;
  /** 最近一次在場事件的實測距離；離開、鏡頭停止時清成 null。設定改了在下一次 tick 重算放大倍率。 */
  private distance: number | null = null;
  private zoom = 1;
  private sensorOk = false;
  private readonly look = new LookToTalk();

  constructor(private readonly hooks: SenseHooks) {}

  handle(event: SenseEvent): void {
    switch (event.type) {
      case "presence":
        if (event.present !== this.present) {
          this.present = event.present;
          this.hooks.setPresence(event.present);
          if (!event.present) {
            this.facing = false;
            this.hooks.setFacing(false);
            this.hooks.pointTo(null);
            this.hooks.setScale(1);
            this.distance = null;
            this.hooks.onLeave();
          }
        }
        if (event.present) {
          this.hooks.setScale(distanceScale(event.distance_m));
          this.distance = event.distance_m;
        }
        break;
      case "attention":
        this.facing = event.facing && this.present;
        this.hooks.setFacing(this.facing);
        break;
      case "gesture":
        if (event.kind === "stop" && this.prefs().stop_gesture) this.hooks.interruptSpeech();
        break;
      case "pointing":
        this.hooks.pointTo(this.present ? event.zone : null);
        break;
      case "sensor":
        this.sensorOk = event.state === "ok";
        this.hooks.setSensor(event.state, event.detail);
        if (event.state !== "ok" && event.state !== "starting") {
          this.present = false;
          this.facing = false;
          this.hooks.setPresence(false);
          this.hooks.setFacing(false);
          this.hooks.pointTo(null);
          this.hooks.setScale(1);
          this.distance = null;
        }
        break;
    }
    this.tick(); // 也依新的距離套用電子腦放大倍率
  }

  /** 定期呼叫（約每 200 ms）：在場且面向螢幕夠久時，自動開始即時語音。 */
  tick(): void {
    const prefs = this.prefs();
    this.applyZoom(prefs);
    // 不能自動開始時不累計停留，也不設冷卻（否則重新打開後會有看不見的冷卻）。
    if (!prefs.look_to_talk || !this.hooks.canAutoTalk()) {
      this.look.reset();
      this.report();
      return;
    }
    const start = this.look.update(
      this.hooks.now(),
      { present: this.present, facing: this.facing, talking: this.hooks.isTalking() },
      lookTiming(prefs),
    );
    // 照原時間開始對話（辨識不延長、不阻擋開始），之後才回報狀態：startTalk 已建立互動，同步辨識接著為它取樣，不會在中間停一下。
    if (start) this.hooks.startTalk();
    this.report();
  }

  private report(): void {
    this.hooks.onSense?.({ present: this.present, facing: this.facing, distance_m: this.distance, sensor_ok: this.sensorOk, dwelling: this.look.dwelling });
  }

  /** 對話結束時呼叫，避免說完「再見」又被立刻自動開啟。 */
  conversationEnded(): void {
    this.look.ended(this.hooks.now());
  }

  /** 只在倍率改變時通知（tick 每 200 ms 呼叫一次，設定改了下一次 tick 就套用）。 */
  private applyZoom(prefs = this.prefs()): void {
    const zoom = brainZoom(this.distance, prefs.brain_zoom_max);
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.hooks.setBrainZoom(zoom);
  }

  private prefs(): SenseTuning {
    return this.hooks.prefs?.() ?? DEFAULT_CAMERA_PREFS;
  }
}

/** 使用者設定（秒）→ LookToTalk 的時間（毫秒）。 */
export function lookTiming(prefs: SenseTuning): LookTiming {
  return {
    dwell_ms: lookToTalkDwellMs(prefs.look_to_talk_s, AttentionTracker.ON_MS),
    cooldown_ms: Math.round(prefs.look_to_talk_cooldown_s * 1000),
  };
}

/**
 * 語音／打字的鏡頭指令。set：保存的使用者設定（與設定畫面同一條路徑），say 是保存後的字幕；
 * preview：只開關鏡頭畫面（不保存）。
 */
export type CameraCommand = { set: CameraPrefsPatch; say: string } | { preview: boolean };

const OFF = "(關掉|關閉|停用|關)";
const OFF_AFTER = "(關掉|關閉|關起來|停用)";
const ON = "(打開|開啟|啟用)";
const PREVIEW = "鏡頭(畫面|影像)";
const LOOK = "看著說話";
/** 「看著說話時先打招呼」：「關閉打招呼」「打招呼打開」「關閉看著說話時先打招呼」。單獨說「打招呼」不是指令。 */
const GREET = "(看著說話時?)?先?打招呼";
// 不收單獨的「手勢」：一般句子（「展開手勢研究」）太容易誤觸。
const PALM = "(手掌停止(播報)?|停止手勢)";
/** 可省略的客氣前後綴：「請幫我關掉鏡頭吧」＝「關掉鏡頭」。 */
const POLITE_PREFIX = /^(請你?|麻煩你?|幫我|幫忙|可以|我要|我想)*把?/;
const POLITE_SUFFIX = /(吧|一下|謝謝)+$/;
/** 否定與問句一律不當指令：「不要打開鏡頭」「別關鏡頭」「怎麼關閉手掌停止」「開關鏡頭在哪裡」。 */
const NEGATION_OR_QUESTION = /(不要|別|不用|不必|怎麼|怎樣|如何|為什麼|嗎|呢|在哪|哪裡|什麼)/;

/** 「動詞＋對象」或「對象＋動詞」，必須是整句（錨定頭尾），所以「相關鏡頭」「開關鏡頭」不會被當成動詞。 */
function whole(verbBefore: string, target: string, verbAfter: string): RegExp {
  return new RegExp(`^(${verbBefore}${target}|${target}${verbAfter})$`);
}

/** 鏡頭指令規則；指令表（shared/voice-commands.ts）每條規則一列，由測試對照。 */
export const CAMERA_RULES: readonly { pattern: RegExp; command: CameraCommand }[] = [
  // 先比對「鏡頭畫面」：「關閉鏡頭畫面」只收起畫面，不關鏡頭。
  { pattern: whole(`(收起|${OFF}|隱藏)`, PREVIEW, "(收起來?|關掉|關閉|隱藏)"), command: { preview: false } },
  { pattern: whole(`(顯示|${ON}|看一下|看看)`, PREVIEW, "(顯示|打開|開啟)"), command: { preview: true } },
  { pattern: whole(OFF, LOOK, "(關掉|關閉|停用)"), command: { set: { look_to_talk: false }, say: "已關閉看著說話。" } },
  { pattern: whole(ON, LOOK, ON), command: { set: { look_to_talk: true }, say: "已打開看著說話。" } },
  { pattern: whole(OFF, GREET, "(關掉|關閉|停用)"), command: { set: { look_to_talk_greet: false }, say: "已關閉看著說話時先打招呼。" } },
  { pattern: whole(ON, GREET, ON), command: { set: { look_to_talk_greet: true }, say: "已打開看著說話時先打招呼。" } },
  { pattern: whole(OFF, PALM, "(關掉|關閉|停用)"), command: { set: { stop_gesture: false }, say: "已關閉手掌停止。" } },
  { pattern: whole(ON, PALM, ON), command: { set: { stop_gesture: true }, say: "已打開手掌停止。" } },
  { pattern: whole(OFF, "鏡頭", OFF_AFTER), command: { set: { active: false }, say: "鏡頭已關閉。" } },
  { pattern: whole(ON, "鏡頭", ON), command: { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" } },
];

/**
 * 使用者說的話是否在操作鏡頭（確定性規則，不經模型）。只收整句的短指令：去掉標點、空白與客氣前後綴後，
 * 整句必須剛好是一條規則；否定、問句、敘述（「我昨天把鏡頭關掉了」）與「打開鏡頭設定」都回傳 null，
 * 後者交給 classify 的設定意圖。
 */
export function matchCameraCommand(text: string): CameraCommand | null {
  const t = text.replace(/[\s，。！？!?,.、~～…]/g, "");
  if (NEGATION_OR_QUESTION.test(t)) return null;
  const command = t.replace(POLITE_PREFIX, "").replace(POLITE_SUFFIX, "");
  return CAMERA_RULES.find((rule) => rule.pattern.test(command))?.command ?? null;
}

/**
 * 鏡頭該不該開：.env 允許、使用者設定開、這個視窗沒有尚未被伺服器確認的「關掉」，
 * 而且上次啟動沒有失敗（失敗後只在使用者再次開啟或 active 改變時重試，不在每次 hello 重試）。
 */
export function cameraShouldRun(camera: CameraSettings | undefined, offPending: boolean, failed: boolean): boolean {
  return !!camera?.enabled && camera.active && !offPending && !failed;
}

/** 依元素中心落在畫面寬度的哪一個三分之一，判斷它屬於哪一區。 */
export function zoneOf(centerX: number, viewportWidth: number): PointZone {
  if (centerX < viewportWidth / 3) return "left";
  if (centerX > (viewportWidth * 2) / 3) return "right";
  return "center";
}
