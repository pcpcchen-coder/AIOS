import { ALARM_SOON_MS, COUNTDOWN_S, COUNTDOWN_TICK_S, formatCountdown, matchRingSnooze, matchRingStop, spokenDuration, timerRemainingMs, type AlarmsView, type RingKind, type RingLogEntry, type RingTone, type RingView, type StopSource, type TimerView } from "../shared/alarm.ts";
import type { RingSound, TickSound } from "./alarm-sound.ts";
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
  /** 這台裝置現在的響鈴音量（0–1）；鬧鐘另有最低音量（ALARM-2）。 */
  peak(kind: RingKind, alarmMinPercent: number): number;
  /** 響鈴開始或結束（只算這個頁面要響的）。 */
  onRingingChange(ringing: boolean): void;
  /** ALARM-3：最後 10 秒的滴答聲。 */
  createTicks(): TickSound;
  /** ALARM-3：倒數畫面出現或消失、或試聽鈴聲開始或結束（喚醒防護、回憶收起）。 */
  onCountdownChange(active: boolean): void;
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
  if (ring.kind === "alarm") return ring.label ? t("鬧鐘：「{0}」", ring.label) : t("鬧鐘");
  return ring.label ? t("「{0}」時間到", ring.label) : t("定時器時間到");
}

export function lateText(lateMs: number): string | null {
  if (lateMs < 60_000) return null;
  return t("晚了 {0}（Mac 睡眠或 Nous 沒在執行）", spokenDuration(lateMs, getLocale()));
}

export function noticeText(entry: RingLogEntry): string {
  const name = entry.label ? t("「{0}」", entry.label) : entry.kind === "alarm" ? t("鬧鐘") : t("定時器");
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
  private countdown: HTMLElement | null = null;
  private ticks: TickSound | null = null;
  private ticksFor: string | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAudible = false;
  private countdownActive = false;
  private preview: { sound: RingSound; timer: ReturnType<typeof setTimeout> } | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AlarmRingOptions) {}

  get ringing(): boolean {
    return this.ringingNow;
  }

  /** ALARM-3：到期前 30 秒的倒數畫面開著（或正在試聽鈴聲）。 */
  get countingDown(): boolean {
    return this.countdownActive;
  }

  /** ALARM-3：倒數的滴答排著或正在試聽鈴聲（只有這時要擋喚醒；前 20 秒還能用喚醒詞取消或延長）。 */
  get audible(): boolean {
    return this.ticks !== null || this.preview !== null;
  }

  /** ALARM-3：設定頁試聽一種鈴聲 4 秒（用這台裝置的鬧鐘音量；喚醒防護照樣生效）。 */
  previewTone(tone: RingTone): void {
    this.stopPreview();
    if (this.ringingNow || this.ticks) return;
    const sound = this.options.createSound();
    void sound.start({ tone, peak: this.peakFor("alarm"), rampS: 0, elapsedMs: 0 });
    this.preview = { sound, timer: setTimeout(() => this.stopPreview(), 4000) };
    this.syncCountdownActive();
  }

  private stopPreview(): void {
    if (!this.preview) return;
    clearTimeout(this.preview.timer);
    this.preview.sound.stop();
    this.preview = null;
    this.syncCountdownActive();
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

  /** ALARM-2：貪睡（只有鬧鐘；同時在響的定時器一起停）。回傳有沒有貪睡到。 */
  snooze(by: StopSource): boolean {
    const here = this.activeRings();
    if (!here.some((r) => r.kind === "alarm")) return false;
    for (const r of here) this.silenced.add(r.id);
    this.render();
    void this.options.post("/api/alarms/snooze", { by }).catch(() => {
      for (const r of here) this.silenced.delete(r.id);
      this.render();
    });
    return true;
  }

  /** 打字或逐字稿：正在響而且整句是停止（或鬧鐘的貪睡）的意思才處理。 */
  stopByText(text: string, by: StopSource = "voice"): boolean {
    if (!this.ringing) return false;
    if (matchRingSnooze(text) && this.snooze(by)) return true;
    return matchRingStop(text) && this.stop(by);
  }

  /** 音量改變（日夜間、對話音量）。 */
  refreshVolume(): void {
    const ring = this.activeRings().at(-1);
    if (ring) this.sound?.setPeak(this.peakFor(ring.kind));
  }

  private peakFor(kind: RingKind): number {
    return this.options.peak(kind, this.view?.prefs.alarm_min_volume ?? 30);
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
    this.renderOverlay(ring, rings);
    this.renderCountdown();
    this.renderChip();
    this.renderNotice();
    // 每秒更新只在有定時器、貪睡、響鈴或一小時內的鬧鐘時；更遠的鬧鐘只排一次「進入一小時內」的重畫。
    const view = this.view?.prefs.enabled ? this.view : null;
    const now = this.serverNow();
    const nextAlarms = view ? view.alarms.filter((a) => a.enabled && a.next_at !== null).map((a) => a.next_at!) : [];
    const soon = nextAlarms.some((at) => at - now <= ALARM_SOON_MS);
    const live = !!ring || !!view?.timers.length || !!view?.snoozes.length || soon;
    if (live && this.ticker === null) this.ticker = setInterval(() => this.tick(), 1000);
    else if (!live && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = null;
    if (!live && nextAlarms.length) {
      const wait = Math.min(...nextAlarms) - ALARM_SOON_MS - now;
      this.soonTimer = setTimeout(() => this.render(), Math.min(Math.max(1000, wait + 500), 2 ** 31 - 1));
    }
    if (changed) {
      document.body.classList.toggle("alarm-ringing", ringing);
      this.options.onRingingChange(ringing);
    }
  }

  private tick(): void {
    this.renderChip();
    this.renderCountdown();
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
    this.stopPreview();
    this.sound?.stop();
    const sound = this.options.createSound();
    this.sound = sound;
    this.soundRing = ring.id;
    const rampS = this.view?.prefs.ramp_s ?? 30;
    const id = ring.id;
    void sound.start({ tone: this.view?.prefs.ring_tone ?? "classic", peak: this.peakFor(ring.kind), rampS, elapsedMs: Math.max(0, this.serverNow() - ring.started_at) }).then((playing) => {
      // 被新的鈴或停止取代：這次的結果不代表能不能出聲，不回報。
      if (this.sound !== sound || this.acked.has(id)) return;
      // 同一個鈴聲代表這個頁面所有正在響的鈴（好幾個定時器同時到）。
      const ids = playing ? [...new Set([id, ...this.activeRings().map((r) => r.id)])] : [id];
      for (const ringId of ids) {
        if (this.acked.has(ringId)) continue;
        this.acked.add(ringId);
        void this.options.post("/api/alarms/ack", { ring_id: ringId, playing, ...(playing ? {} : { reason: "audio_context_not_running" }) }).catch(() => undefined);
      }
    });
  }

  /** 響鈴畫面的大字時間：用核心的時區（和鬧鐘時間一致，Pi 的瀏覽器時區不同時也一樣）。 */
  private clockText(): string {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: this.view?.time_zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(this.serverNow()));
    } catch {
      const d = new Date(this.serverNow());
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }

  private renderOverlay(ring: RingView | null, rings: readonly RingView[]): void {
    const count = rings.length;
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
      const snooze = document.createElement("button");
      snooze.type = "button";
      snooze.className = "alarm-ring-snooze";
      snooze.addEventListener("click", () => this.snooze("button"));
      const actions = document.createElement("div");
      actions.className = "alarm-ring-actions";
      actions.append(stop, snooze);
      const hint = document.createElement("div");
      hint.className = "alarm-ring-hint";
      root.append(time, title, note, actions, hint);
      (this.options.host ?? document.body).append(root);
      this.overlay = root;
      stop.focus({ preventScroll: true });
    }
    const root = this.overlay;
    root.querySelector<HTMLElement>(".alarm-ring-time")!.textContent = this.clockText();
    root.querySelector<HTMLElement>(".alarm-ring-title")!.textContent = count > 1 ? `${ringTitle(ring)}${t("（還有 {0} 個）", count - 1)}` : ringTitle(ring);
    // ALARM-2：只有鬧鐘有貪睡（按需出現）。
    const snooze = root.querySelector<HTMLButtonElement>(".alarm-ring-snooze")!;
    const canSnooze = rings.some((r) => r.kind === "alarm");
    snooze.hidden = !canSnooze;
    snooze.textContent = t("貪睡 {0} 分鐘", Math.round((this.view?.prefs.snooze_s ?? 540) / 60));
    root.querySelector<HTMLElement>(".alarm-ring-hint")!.textContent = canSnooze ? t("也可以舉起手掌、按 Esc 或空白鍵停止；通話中說「停」或「貪睡」") : t("也可以舉起手掌、按 Esc 或空白鍵，或在通話中說「停」");
    const late = lateText(ring.late_ms);
    const note = root.querySelector<HTMLElement>(".alarm-ring-note")!;
    note.textContent = late ?? "";
    note.hidden = !late;
  }

  /** 30 秒內要在這個頁面響的（定時器、鬧鐘、貪睡）中最早的一個；到期後 3 秒內仍算（等核心推響鈴）。 */
  private upcoming(now: number): { key: string; label: string; at: number; kind: RingKind } | null {
    const view = this.view;
    if (!view?.prefs.enabled) return null;
    const items = [
      ...view.timers.filter((x) => x.state === "running" && x.ends_at !== null && x.here !== false).map((x) => ({ key: `t:${x.id}:${x.ends_at}`, label: x.label ?? t("定時器"), at: x.ends_at!, kind: "timer" as const })),
      ...view.alarms.filter((x) => x.enabled && x.next_at !== null && x.here !== false).map((x) => ({ key: `a:${x.id}:${x.next_at}`, label: x.label ?? t("鬧鐘"), at: x.next_at!, kind: "alarm" as const })),
      ...view.snoozes.filter((x) => x.here !== false).map((x) => ({ key: `z:${x.id}:${x.due_at}`, label: x.label ?? t("鬧鐘"), at: x.due_at, kind: "alarm" as const })),
    ].filter((x) => x.at - now <= COUNTDOWN_S * 1000 && x.at - now > -3000);
    return items.sort((a, b) => a.at - b.at)[0] ?? null;
  }

  /** ALARM-3（George 2026-11-09）：到期前 30 秒在螢幕上倒數；最後 10 秒每秒一聲滴。響鈴開始後由響鈴畫面接手。 */
  private renderCountdown(): void {
    const now = this.serverNow();
    const item = this.ringingNow ? null : this.upcoming(now);
    if (!item) {
      if (this.tickTimer !== null) clearTimeout(this.tickTimer);
      this.tickTimer = null;
      this.countdown?.remove();
      this.countdown = null;
      this.ticks?.stop();
      this.ticks = null;
      this.ticksFor = null;
      this.syncCountdownActive();
      return;
    }
    if (!this.countdown) {
      const root = document.createElement("div");
      root.className = "alarm-countdown";
      root.dataset.visibilityReason = "alarm_countdown";
      // 秒數每秒變，不要每秒念：只有出現時的「快到了」那一句給報讀器（role=timer 預設不主動念）。
      root.setAttribute("role", "timer");
      const label = document.createElement("div");
      label.className = "alarm-countdown-label";
      const secs = document.createElement("div");
      secs.className = "alarm-countdown-secs";
      root.append(label, secs);
      (this.options.host ?? document.body).append(root);
      this.countdown = root;
    }
    const left = Math.max(0, item.at - now);
    this.countdown.querySelector<HTMLElement>(".alarm-countdown-label")!.textContent = t("「{0}」快到了", item.label);
    this.countdown.querySelector<HTMLElement>(".alarm-countdown-secs")!.textContent = String(Math.ceil(left / 1000));
    this.countdown.classList.toggle("alarm-countdown--final", left <= COUNTDOWN_TICK_S * 1000);
    if (left <= COUNTDOWN_TICK_S * 1000 + 500 && left > 0 && this.ticksFor !== item.key) {
      this.stopPreview();
      this.ticks?.stop();
      this.ticks = this.options.createTicks();
      this.ticksFor = item.key;
      void this.ticks.start(left, this.peakFor(item.kind));
    }
    // 背景視窗的每秒計時器可能被節流：另外排一個剛好在「剩 10.5 秒」的檢查，滴答準時開始。
    if (this.tickTimer !== null) clearTimeout(this.tickTimer);
    this.tickTimer = this.ticksFor === item.key ? null : setTimeout(() => this.renderCountdown(), Math.max(0, left - COUNTDOWN_TICK_S * 1000 - 500));
    this.syncCountdownActive();
  }

  private syncCountdownActive(): void {
    const active = this.countdown !== null || this.preview !== null;
    const audible = this.audible;
    if (active === this.countdownActive && audible === this.lastAudible) return;
    this.countdownActive = active;
    this.lastAudible = audible;
    this.options.onCountdownChange(active);
  }

  private renderChip(): void {
    const view = this.view;
    const timers: TimerView[] = view?.prefs.enabled ? [...view.timers] : [];
    const now0 = this.serverNow();
    // ALARM-2：貪睡中與一小時內的鬧鐘也按需顯示倒數（不是鬧鐘清單）。
    const extra = view?.prefs.enabled
      ? [
          ...view.snoozes.map((z) => ({ name: z.label ?? t("鬧鐘"), prefix: t("貪睡"), at: z.due_at, kind: "snooze" })),
          ...view.alarms.filter((a) => a.enabled && a.next_at !== null && a.next_at - now0 <= ALARM_SOON_MS).map((a) => ({ name: a.label ?? t("鬧鐘"), prefix: a.time, at: a.next_at!, kind: "alarm" })),
        ]
      : [];
    if (!timers.length && !extra.length) {
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
    this.chip.dataset.visibilityReason = timers.length ? "timer_running" : extra.some((x) => x.kind === "snooze") ? "alarm_snoozed" : "alarm_soon";
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
    for (const item of extra.sort((a, b) => a.at - b.at).slice(0, 2)) {
      const row = document.createElement("div");
      row.className = "timer-chip-row";
      row.dataset.state = item.kind;
      const name = document.createElement("span");
      name.className = "timer-chip-name";
      name.textContent = item.name;
      const left = document.createElement("span");
      left.className = "timer-chip-left";
      left.textContent = `${item.prefix} ${formatCountdown(item.at - now)}`;
      row.append(name, left);
      rows.push(row);
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
