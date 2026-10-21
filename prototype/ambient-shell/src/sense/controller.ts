// 感知事件 → Shell 行為（docs/11 §3、§5）。純邏輯，透過 hooks 操作畫面與語音，方便測試。
// 規則：鏡頭只提供指向與在場資訊；手勢與指向都不能觸發外部動作（確認只認語音固定語句）。

import type { PointZone, SenseEvent, SensorState } from "../../shared/sense.ts";
import { LookToTalk } from "./trackers.ts";

export interface SenseHooks {
  now(): number;
  /** 即時語音或語音模式是否正在進行。 */
  isTalking(): boolean;
  /** 現在能否不經點擊就開始即時語音（已授權、可用、使用者開啟了 look_to_talk）。 */
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
        if (event.kind === "stop") this.hooks.interruptSpeech();
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
    const start = this.look.update(this.hooks.now(), {
      present: this.present,
      facing: this.facing,
      talking: this.hooks.isTalking(),
    });
    if (start && this.hooks.canAutoTalk()) this.hooks.startTalk();
  }

  /** 對話結束時呼叫，避免說完「再見」又被立刻自動開啟。 */
  conversationEnded(): void {
    this.look.ended(this.hooks.now());
  }
}

/** 使用者說的話是否在開關鏡頭（確定性規則，與語音確認相同做法）。 */
export function matchCameraCommand(text: string): "on" | "off" | null {
  const t = text.replace(/[\s，。！？!?,.、]/g, "");
  if (/(關掉|關閉|停用|關)鏡頭|鏡頭(關掉|關閉|關起來|停用)/.test(t)) return "off";
  if (/(打開|開啟|啟用)鏡頭|鏡頭(打開|開啟|啟用)/.test(t)) return "on";
  return null;
}

/** 依元素中心落在畫面寬度的哪一個三分之一，判斷它屬於哪一區。 */
export function zoneOf(centerX: number, viewportWidth: number): PointZone {
  if (centerX < viewportWidth / 3) return "left";
  if (centerX > (viewportWidth * 2) / 3) return "right";
  return "center";
}
