// 感知事件 → Shell 行為（docs/11 §3、§5）。純邏輯，透過 hooks 操作畫面與語音，方便測試。
// 規則：鏡頭只提供指向與在場資訊；手勢與指向都不能觸發外部動作（確認只認語音固定語句）。

import {
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
export type SenseTuning = Pick<CameraPrefs, "look_to_talk" | "look_to_talk_s" | "look_to_talk_cooldown_s" | "stop_gesture">;

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
  setPresence(present: boolean): void;
  setFacing(facing: boolean): void;
  /** 指向的畫面區塊（使用者看到的左／中／右）；null 為清除。 */
  pointTo(zone: PointZone | null): void;
  setSensor(state: SensorState, detail: string): void;
  /** 目前的使用者設定；未提供時用 CAMERA_PREFS 的預設。 */
  prefs?(): SenseTuning;
}

/** 字級縮放範圍：1.5–3 m（docs/10、11）；超出範圍不再放大。 */
export function distanceScale(distanceM: number | null): number {
  if (distanceM === null) return 1;
  return Math.min(1.5, Math.max(0.75, Math.round((distanceM / 2) * 100) / 100));
}

export class SenseController {
  private present = false;
  private facing = false;
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
            this.hooks.onLeave();
          }
        }
        if (event.present) this.hooks.setScale(distanceScale(event.distance_m));
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
        this.hooks.setSensor(event.state, event.detail);
        if (event.state !== "ok" && event.state !== "starting") {
          this.present = false;
          this.facing = false;
          this.hooks.setPresence(false);
          this.hooks.setFacing(false);
          this.hooks.pointTo(null);
          this.hooks.setScale(1);
        }
        break;
    }
    this.tick();
  }

  /** 定期呼叫（約每 200 ms）：在場且面向螢幕夠久時，自動開始即時語音。 */
  tick(): void {
    const prefs = this.prefs();
    // 不能自動開始時不累計停留，也不設冷卻（否則重新打開後會有看不見的冷卻）。
    if (!prefs.look_to_talk || !this.hooks.canAutoTalk()) {
      this.look.reset();
      return;
    }
    const start = this.look.update(
      this.hooks.now(),
      { present: this.present, facing: this.facing, talking: this.hooks.isTalking() },
      lookTiming(prefs),
    );
    if (start) this.hooks.startTalk();
  }

  /** 對話結束時呼叫，避免說完「再見」又被立刻自動開啟。 */
  conversationEnded(): void {
    this.look.ended(this.hooks.now(), lookTiming(this.prefs()).cooldown_ms);
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
const ON = "(打開|開啟|啟用)";
const PREVIEW = "鏡頭(畫面|影像)";
const LOOK = "看著說話";
// 不收單獨的「手勢」：一般句子（「展開手勢研究」）太容易誤觸。
const PALM = "(手掌停止(播報)?|停止手勢)";

/** 使用者說的話是否在操作鏡頭（確定性規則，不經模型）。先比對「鏡頭畫面」，因為「關閉鏡頭畫面」包含「關閉鏡頭」。 */
export function matchCameraCommand(text: string): CameraCommand | null {
  const t = text.replace(/[\s，。！？!?,.、]/g, "");
  const has = (pattern: string) => new RegExp(pattern).test(t);
  if (has(`(收起|${OFF}|隱藏)${PREVIEW}|${PREVIEW}(收起來?|關掉|關閉|隱藏)`)) return { preview: false };
  if (has(`(顯示|${ON}|看一下|看看)${PREVIEW}|${PREVIEW}(顯示|打開|開啟)`)) return { preview: true };
  if (has(`${OFF}${LOOK}|${LOOK}(關掉|關閉|停用)`)) return { set: { look_to_talk: false }, say: "已關閉看著說話。" };
  if (has(`${ON}${LOOK}|${LOOK}(打開|開啟|啟用)`)) return { set: { look_to_talk: true }, say: "已打開看著說話。" };
  if (has(`${OFF}${PALM}|${PALM}(關掉|關閉|停用)`)) return { set: { stop_gesture: false }, say: "已關閉手掌停止。" };
  if (has(`${ON}${PALM}|${PALM}(打開|開啟|啟用)`)) return { set: { stop_gesture: true }, say: "已打開手掌停止。" };
  if (/(關掉|關閉|停用|關)鏡頭|鏡頭(關掉|關閉|關起來|停用)/.test(t)) return { set: { active: false }, say: "鏡頭已關閉。" };
  if (/(打開|開啟|啟用)鏡頭|鏡頭(打開|開啟|啟用)/.test(t)) return { set: { active: true }, say: "正在開啟鏡頭（狀態看右下角指示點）。" };
  return null;
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
