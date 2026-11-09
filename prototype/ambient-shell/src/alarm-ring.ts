import { formatCountdown, matchRingStop, spokenDuration, timerRemainingMs, type AlarmsView, type RingLogEntry, type RingView, type StopSource, type TimerView } from "../shared/alarm.ts";
import type { RingSound } from "./alarm-sound.ts";
import { getLocale, t } from "./i18n.ts";

// ALARM-1（George 2026-11-09）：頁面上的響鈴與倒數。真相在核心（settings.alarms，經 SSE 推來）；這裡只負責：
// - 這個頁面要響的鈴（here）出聲、漸強、顯示大字與「停止」；停止先在本機靜音再告訴核心（核心再推給其他畫面）。
// - 有定時器時在右下角按需顯示倒數（data-visibility-reason="timer_running"）；沒有就整個移除，不是常駐清單。
// - 自動停止或錯過時按需顯示一行說明，使用者按「知道了」清掉（核心記錄）。
// 鈴聲期間由 main.ts 暫停喚醒偵測、回憶模式、處理中音效，並把 Nous 的聲音靜音（通話不掛斷）。

export interface AlarmRingOptions {
  createSound(): RingSound;
  /** POST /api/alarms/*（失敗時丟錯）。 */
  post(path: string, body: Record<string, unknown>): Promise<void>;
  /** 這台裝置現在的響鈴音量（0–1）。 */
  peak(): number;
  /** 響鈴開始或結束（只算這個頁面要響的）。 */
  onRingingChange(ringing: boolean): void;
  host?: HTMLElement;
}

/** 核心時間與頁面時間的差（核心 − 頁面）；Pi 的時鐘可能和 Mac 不同。 */
export function clockOffset(view: Pick<AlarmsView, "server_now">, pageNow: number): number {
  return view.server_now - pageNow;
}

export function ringsHere(view: AlarmsView | null | undefined): RingView[] {
  return view?.prefs.enabled ? view.rings.filter((r) => r.here) : [];
}

/** 響鈴大字的第二行（「泡麵」時間到／晚了幾分鐘）。 */
export function ringTitle(ring: Pick<RingView, "label" | "kind">): string {
  return ring.label ? t("「{0}」時間到", ring.label) : t("定時器時間到");
}

export function lateText(lateMs: number): string | null {
  if (lateMs < 60_000) return null;
  return t("晚了 {0}（Mac 睡眠或 Nous 沒在執行）", spokenDuration(lateMs, getLocale()));
}

export function noticeText(entry: RingLogEntry): string {
  const name = entry.label ? t("「{0}」", entry.label) : t("定時器");
  if (entry.outcome === "missed") return t("{0} 錯過了：晚了 {1} 才發現，沒有補響", name, spokenDuration(entry.late_ms, getLocale()));
  return entry.heard ? t("{0} 響了一段時間沒人停，已自動停止", name) : t("{0} 已自動停止；沒有畫面回報真的出聲", name);
}

export class AlarmRing {
  private view: AlarmsView | null = null;
  private offset = 0;
  private sound: RingSound | null = null;
  private soundRing: string | null = null;
  private acked = new Set<string>();
  /** 本機已按停止、核心還沒推新狀態前，不再出聲（避免一閃又響）。 */
  private silenced = new Set<string>();
  private ringingNow = false;
  private overlay: HTMLElement | null = null;
  private chip: HTMLElement | null = null;
  private notice: HTMLElement | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: AlarmRingOptions) {}

  get ringing(): boolean {
    return this.ringingNow;
  }

  /** 設定推來時呼叫（hello、settings.updated、HTTP 回應）。 */
  sync(view: AlarmsView | undefined): void {
    this.view = view ?? null;
    if (view) this.offset = clockOffset(view, Date.now());
    const live = new Set(view?.rings.map((r) => r.id) ?? []);
    for (const id of this.silenced) if (!live.has(id)) this.silenced.delete(id);
    this.render();
  }

  /** 停止這個頁面正在響的鈴（按鈕、手掌、按鍵、打字或通話中說「停」）。回傳有沒有停到。 */
  stop(by: StopSource): boolean {
    const here = this.activeRings();
    if (!here.length) return false;
    for (const r of here) this.silenced.add(r.id);
    this.render();
    void this.options.post("/api/alarms/stop", { by }).catch(() => {
      // 核心沒收到：鈴在核心仍算響著，下次推來時照實再響（不假裝已停）。
      for (const r of here) this.silenced.delete(r.id);
      this.render();
    });
    return true;
  }

  /** 打字或逐字稿：正在響而且整句是停止的意思才停。 */
  stopByText(text: string, by: StopSource = "voice"): boolean {
    return this.ringing && matchRingStop(text) && this.stop(by);
  }

  /** 音量改變（日夜間、對話音量）。 */
  refreshVolume(): void {
    this.sound?.setPeak(this.options.peak());
  }

  /** 語言改變時重畫。 */
  refreshLocale(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.chip?.remove();
    this.chip = null;
    this.notice?.remove();
    this.notice = null;
    this.render();
  }

  private serverNow(): number {
    return Date.now() + this.offset;
  }

  private activeRings(): RingView[] {
    return ringsHere(this.view).filter((r) => !this.silenced.has(r.id));
  }

  private render(): void {
    const rings = this.activeRings();
    const ring = rings.at(-1) ?? null;
    const ringing = ring !== null;
    const changed = ringing !== this.ringingNow;
    this.ringingNow = ringing;
    this.renderSound(ring);
    this.renderOverlay(ring, rings.length);
    this.renderChip();
    this.renderNotice();
    const timers = this.view?.prefs.enabled ? this.view.timers.length : 0;
    if ((timers || ring) && this.ticker === null) this.ticker = setInterval(() => this.tick(), 1000);
    else if (!timers && !ring && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (changed) {
      document.body.classList.toggle("alarm-ringing", ringing);
      this.options.onRingingChange(ringing);
    }
  }

  private tick(): void {
    this.renderChip();
    const clock = this.overlay?.querySelector<HTMLElement>(".alarm-ring-time");
    if (clock) clock.textContent = this.clockText();
  }

  private renderSound(ring: RingView | null): void {
    if (!ring) {
      if (this.sound) {
        this.sound.stop();
        this.sound = null;
        this.soundRing = null;
      }
      return;
    }
    if (this.soundRing === ring.id && this.sound) return;
    this.sound?.stop();
    const sound = this.options.createSound();
    this.sound = sound;
    this.soundRing = ring.id;
    const rampS = this.view?.prefs.ramp_s ?? 30;
    const id = ring.id;
    void sound.start({ peak: this.options.peak(), rampS, elapsedMs: Math.max(0, this.serverNow() - ring.started_at) }).then((playing) => {
      if (this.acked.has(id)) return;
      this.acked.add(id);
      void this.options.post("/api/alarms/ack", { ring_id: id, playing, ...(playing ? {} : { reason: "audio_context_not_running" }) }).catch(() => undefined);
    });
  }

  private clockText(): string {
    const d = new Date(this.serverNow());
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  private renderOverlay(ring: RingView | null, count: number): void {
    if (!ring) {
      this.overlay?.remove();
      this.overlay = null;
      return;
    }
    if (!this.overlay) {
      const root = document.createElement("div");
      root.className = "alarm-ring";
      root.setAttribute("role", "alertdialog");
      root.setAttribute("aria-live", "assertive");
      root.dataset.visibilityReason = "alarm_ringing";
      const time = document.createElement("div");
      time.className = "alarm-ring-time";
      const title = document.createElement("div");
      title.className = "alarm-ring-title";
      title.id = "alarm-ring-title";
      root.setAttribute("aria-labelledby", title.id);
      const note = document.createElement("div");
      note.className = "alarm-ring-note";
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "alarm-ring-stop";
      stop.textContent = t("停止");
      stop.addEventListener("click", () => this.stop("button"));
      const hint = document.createElement("div");
      hint.className = "alarm-ring-hint";
      hint.textContent = t("也可以舉起手掌、按 Esc 或空白鍵，或在通話中說「停」");
      root.append(time, title, note, stop, hint);
      (this.options.host ?? document.body).append(root);
      this.overlay = root;
      stop.focus({ preventScroll: true });
    }
    const root = this.overlay;
    root.querySelector<HTMLElement>(".alarm-ring-time")!.textContent = this.clockText();
    root.querySelector<HTMLElement>(".alarm-ring-title")!.textContent = count > 1 ? `${ringTitle(ring)}${t("（還有 {0} 個）", count - 1)}` : ringTitle(ring);
    const late = lateText(ring.late_ms);
    const note = root.querySelector<HTMLElement>(".alarm-ring-note")!;
    note.textContent = late ?? "";
    note.hidden = !late;
  }

  private renderChip(): void {
    const view = this.view;
    const timers: TimerView[] = view?.prefs.enabled ? [...view.timers] : [];
    if (!timers.length) {
      this.chip?.remove();
      this.chip = null;
      return;
    }
    if (!this.chip) {
      const chip = document.createElement("div");
      chip.className = "timer-chip";
      chip.dataset.visibilityReason = "timer_running";
      chip.setAttribute("role", "status");
      chip.setAttribute("aria-label", t("定時器"));
      (this.options.host ?? document.body).append(chip);
      this.chip = chip;
    }
    const now = this.serverNow();
    timers.sort((a, b) => timerRemainingMs(a, now) - timerRemainingMs(b, now));
    const rows = timers.slice(0, 3).map((timer) => {
      const row = document.createElement("div");
      row.className = "timer-chip-row";
      row.dataset.state = timer.state;
      const name = document.createElement("span");
      name.className = "timer-chip-name";
      name.textContent = timer.label ?? t("定時器");
      const left = document.createElement("span");
      left.className = "timer-chip-left";
      left.textContent = `${timer.state === "paused" ? `${t("暫停")} ` : ""}${formatCountdown(timerRemainingMs(timer, now))}`;
      row.append(name, left);
      return row;
    });
    if (timers.length > 3) {
      const more = document.createElement("div");
      more.className = "timer-chip-more";
      more.textContent = t("還有 {0} 個", timers.length - 3);
      rows.push(more);
    }
    this.chip.replaceChildren(...rows);
  }

  private renderNotice(): void {
    const entry = this.view?.notice ?? null;
    if (!entry || this.ringingNow) {
      this.notice?.remove();
      this.notice = null;
      return;
    }
    if (!this.notice) {
      const box = document.createElement("div");
      box.className = "alarm-notice";
      box.dataset.visibilityReason = "alarm_missed_or_auto_stopped";
      box.setAttribute("role", "status");
      const text = document.createElement("span");
      text.className = "alarm-notice-text";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "alarm-notice-ok";
      ok.textContent = t("知道了");
      ok.addEventListener("click", () => void this.options.post("/api/alarms/notice/clear", {}).catch(() => undefined));
      box.append(text, ok);
      (this.options.host ?? document.body).append(box);
      this.notice = box;
    }
    this.notice.querySelector<HTMLElement>(".alarm-notice-text")!.textContent = noticeText(entry);
  }
}
