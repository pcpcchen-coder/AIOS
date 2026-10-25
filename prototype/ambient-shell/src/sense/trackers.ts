// 感知事件的時間濾波（docs/11 §2、docs/06 §4.4）：只在狀態穩定後才發出事件，避免畫面跳動與誤觸。
// 純邏輯，時間由呼叫端傳入（毫秒），方便測試。

import { CAMERA_PREFS, lookToTalkDwellMs, type PointZone } from "../../shared/sense.ts";
import { median } from "./geometry.ts";

/** 在場：連續偵測到人 500 ms 才算在場，60 秒沒看到才算離開；距離取最近 9 筆的中位數。 */
export class PresenceTracker {
  static readonly ENTER_MS = 500;
  static readonly LEAVE_MS = 60_000;
  static readonly MIN_MM = 500;
  static readonly MAX_MM = 4000;
  private present = false;
  private firstSeen: number | null = null;
  private lastSeen: number | null = null;
  private distances: number[] = [];
  private reported: number | null = null;

  /** 每一幀呼叫；回傳需要發出的事件（沒有變化時為 null）。 */
  update(now: number, detected: boolean, distanceMm: number | null): { present: boolean; distance_m: number | null } | null {
    const inRange = detected && (distanceMm === null || (distanceMm >= PresenceTracker.MIN_MM && distanceMm <= PresenceTracker.MAX_MM));
    if (inRange) {
      this.lastSeen = now;
      this.firstSeen ??= now;
      if (distanceMm !== null) {
        this.distances.push(distanceMm);
        if (this.distances.length > 9) this.distances.shift();
      }
    } else if (!this.present) {
      this.firstSeen = null;
    }

    if (!this.present && this.firstSeen !== null && now - this.firstSeen >= PresenceTracker.ENTER_MS) {
      this.present = true;
      return this.report(true);
    }
    if (this.present && this.lastSeen !== null && now - this.lastSeen >= PresenceTracker.LEAVE_MS) {
      this.present = false;
      this.firstSeen = null;
      this.distances = [];
      this.reported = null;
      return { present: false, distance_m: null };
    }
    if (this.present && inRange) {
      const d = this.distance();
      // 距離變化超過 10 cm 才更新，避免字級來回跳動。
      if (d !== null && (this.reported === null || Math.abs(d - this.reported) >= 0.1)) return this.report(true);
    }
    return null;
  }

  private distance(): number | null {
    const mm = median(this.distances);
    return mm === null ? null : Math.round(mm / 10) / 100;
  }

  private report(present: boolean): { present: boolean; distance_m: number | null } {
    const d = this.distance();
    this.reported = d;
    return { present, distance_m: d };
  }
}

/** 面向螢幕：持續 300 ms 才算面向，轉開 500 ms 才算離開（遲滯）。 */
export class AttentionTracker {
  static readonly ON_MS = 300;
  static readonly OFF_MS = 500;
  private facing = false;
  private since: number | null = null;

  update(now: number, facingNow: boolean): boolean | null {
    if (facingNow === this.facing) {
      this.since = null;
      return null;
    }
    this.since ??= now;
    const need = facingNow ? AttentionTracker.ON_MS : AttentionTracker.OFF_MS;
    if (now - this.since < need) return null;
    this.facing = facingNow;
    this.since = null;
    return facingNow;
  }

  get current(): boolean {
    return this.facing;
  }
}

/** 停止手勢：舉起張開的手掌持續 300 ms 觸發一次；放下後才能再觸發，兩次至少相隔 2 秒。 */
export class StopGestureDetector {
  static readonly HOLD_MS = 300;
  static readonly REFRACTORY_MS = 2000;
  private since: number | null = null;
  private armed = true;
  private lastFired = -Infinity;

  update(now: number, candidate: boolean): boolean {
    if (!candidate) {
      this.since = null;
      this.armed = true;
      return false;
    }
    this.since ??= now;
    if (!this.armed || now - this.since < StopGestureDetector.HOLD_MS || now - this.lastFired < StopGestureDetector.REFRACTORY_MS) return false;
    this.armed = false;
    this.lastFired = now;
    return true;
  }
}

/** 指向：同一區連續 450 ms 才發出；超過 1000 ms 沒有有效指向就清除（06 §4.4）。 */
export class ZoneStabilizer {
  static readonly STABLE_MS = 450;
  static readonly CLEAR_MS = 1000;
  private emitted: PointZone | null = null;
  private candidate: PointZone | null = null;
  private candidateSince = 0;
  private lastValid: number | null = null;

  /** 回傳 undefined 表示沒有變化；否則回傳新的指向區（可能為 null）。 */
  update(now: number, zone: PointZone | null): PointZone | null | undefined {
    if (zone === null) {
      if (this.emitted !== null && this.lastValid !== null && now - this.lastValid >= ZoneStabilizer.CLEAR_MS) {
        this.emitted = null;
        this.candidate = null;
        return null;
      }
      return undefined;
    }
    this.lastValid = now;
    if (zone !== this.candidate) {
      this.candidate = zone;
      this.candidateSince = now;
    }
    if (zone !== this.emitted && now - this.candidateSince >= ZoneStabilizer.STABLE_MS) {
      this.emitted = zone;
      return zone;
    }
    return undefined;
  }
}

export interface LookTiming {
  dwell_ms: number;
  cooldown_ms: number;
}

/**
 * 看向螢幕就能說話（免手）：有人在場且面向螢幕（確認後）再停留 dwell_ms，而即時語音沒開時，請求開始對話。
 * 自動開始或對話結束後 cooldown_ms 內不重新觸發，避免一說完「再見」又被自動開啟。
 * 只記暫停從何時開始，每次 update 都用當下的 cooldown_ms 比較，所以使用者調短暫停時立刻生效。
 * 時間由呼叫端每次傳入（使用者可在設定調整）；預設由 CAMERA_PREFS 推導：1.5 秒 − 面向確認 0.3 秒 = 1200 ms，冷卻 10 秒。
 */
export class LookToTalk {
  static readonly DWELL_MS = lookToTalkDwellMs(CAMERA_PREFS.look_to_talk_s.default, AttentionTracker.ON_MS);
  static readonly COOLDOWN_MS = CAMERA_PREFS.look_to_talk_cooldown_s.default * 1000;
  static readonly DEFAULT: LookTiming = { dwell_ms: LookToTalk.DWELL_MS, cooldown_ms: LookToTalk.COOLDOWN_MS };
  private since: number | null = null;
  /** 最近一次自動開始或對話結束的時間；null 表示沒有暫停。 */
  private pausedAt: number | null = null;

  /** 對話結束時呼叫：暫停從現在重新起算。 */
  ended(now: number): void {
    this.pausedAt = now;
    this.since = null;
  }

  update(now: number, state: { present: boolean; facing: boolean; talking: boolean }, timing: LookTiming = LookToTalk.DEFAULT): boolean {
    const paused = this.pausedAt !== null && now - this.pausedAt < timing.cooldown_ms;
    if (!state.present || !state.facing || state.talking || paused) {
      this.since = null;
      return false;
    }
    this.since ??= now;
    if (now - this.since < timing.dwell_ms) return false;
    this.since = null;
    this.pausedAt = now;
    return true;
  }

  /** 正在累計面向停留（ID-02 的同步辨識只在這段 delay 內開始取樣；它不影響停留的計時）。 */
  get dwelling(): boolean {
    return this.since !== null;
  }

  /** 看著說話不可用（關閉或無法自動開始）時呼叫：清掉累計中的停留，不設冷卻。 */
  reset(): void {
    this.since = null;
  }
}
