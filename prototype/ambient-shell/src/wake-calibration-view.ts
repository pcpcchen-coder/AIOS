// 「矯正喚醒詞」畫面（George 2026-11-01）：選單列「鏡頭與語音設定 → 矯正喚醒詞…」在原生說明、使用者按「開始」之後打開。
// 輸入代號（1–4 個英文字母或數字，不記名字）→ 依提示念 Hey Nous 10 次、Hello Nous 5 次與 5 句不該叫醒的話；每次先「叮」一聲、
// 整個視窗變色，錄 5 秒，當場顯示目前的設定有沒有偵測到 → 用同一批錄音比較幾組門檻 → 表格顯示結果與建議，按「套用」才保存。
// 錄音只在喚醒 worker 的記憶體（這個畫面拿不到樣本，只有結果編號）；比較完、取消、收起、睡眠或鎖定時立即丟掉並恢復常駐聆聽。
// 這個檔案不載入 src/audio/（tests/audio-privacy.test.ts）：工作階段由 src/main.ts 經 host.start() 交來。

import {
  adviceChanges,
  CALIBRATION_PROMPTS,
  currentSummary,
  currentTuning,
  groupDefaults,
  groupLabel,
  groupOfIndex,
  overridesFromAdvice,
  PROMPT_WINDOW_MS,
  recommend,
  RESULT_PAUSE_MS,
  scoreCandidates,
  sweepCandidates,
  type CandidateScore,
  type ClipResult,
  type GroupAdvice,
} from "../shared/wake-calibration.ts";
import { WAKE_CALIBRATION_CODE, type WakeKeywordOverrides, type WakeKeywordTuning, type WakeSettingsView, type WakeSweepCandidate } from "../shared/wake.ts";
import { getLocale, msg, onLocaleChange, t } from "./i18n.ts";

/** 與 src/audio/controller.ts 的 WakeCalibrationEvents 同形（這裡不能載入 src/audio）。 */
export interface CalibrationSessionEvents {
  ready(): void;
  clip(clip: number, keywordIndex: number): void;
  scan(candidate: number, clip: number, keywordIndex: number): void;
  sweepDone(): void;
  aborted(reason: "runtime_missing" | "runtime_load_failed" | "sleep" | "lock"): void;
}

/** 與 src/audio/controller.ts 的 WakeCalibrationSession 同形。 */
export interface CalibrationSession {
  ding(): Promise<boolean>;
  beginClip(): void;
  endClip(): void;
  sweep(candidates: WakeSweepCandidate[], clips: number[][]): void;
  discard(): void;
  stop(): void;
}

export interface WakeCalibrationHost {
  /** 核心的 settings.wake（目前的矯正值、引擎狀態）；喚醒功能沒開時 undefined。 */
  settings(): WakeSettingsView | undefined;
  /** 開始一個工作階段（暫停常駐聆聽、開麥克風）；失敗時回傳說明文字（共用翻譯表原文）。 */
  start(events: CalibrationSessionEvents): Promise<CalibrationSession | string>;
  /** 保存矯正值（null＝回復預設）；回傳錯誤說明，成功為 null。 */
  apply(overrides: WakeKeywordOverrides | null): Promise<string | null>;
  /** 整個視窗的提示顏色：speak＝現在念、null＝收起。 */
  cue(state: "speak" | null): void;
  dismiss(): void;
}

export interface WakeCalibrationOptions {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

type Phase =
  | { kind: "intro" }
  | { kind: "starting" }
  | { kind: "prompt"; step: "ready" | "ding" | "speak" | "checking" | "result" }
  | { kind: "sweeping" }
  | { kind: "summary" }
  | { kind: "error"; message: string };

/** 每句開始前停一下（讓人看清楚下一句要念什麼）。 */
const READY_MS = 900;
/** 一段錄完、等偵測器回結果的上限。 */
const CLIP_TIMEOUT_MS = 15_000;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function button(label: string, onClick: () => void, variant = "", disabled = false): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${variant}`.trim() }, label);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

const fmt = (n: number): string => n.toFixed(2);
const tuningText = (x: WakeKeywordTuning): string => `${fmt(x.boost)}${getLocale() === "en" ? "/" : "／"}${fmt(x.threshold)}`;

export class WakeCalibrationView {
  readonly element: HTMLElement;
  private phase: Phase = { kind: "intro" };
  private code = "";
  private session: CalibrationSession | null = null;
  /** 每次開始、取消、收起加一：晚到的事件與計時器看到不同就丟掉。 */
  private run = 0;
  private prompt = 0;
  private paused = false;
  /** 已錄的段落：第幾句提示、目前設定的結果。clip 編號＝陣列位置。 */
  private clips: ClipResult[] = [];
  private candidates: WakeSweepCandidate[] = [];
  private scans: (number | undefined)[][] = [];
  private scanTotal = 0;
  private scanDone = 0;
  private scores: CandidateScore[] = [];
  private advice: GroupAdvice[] = [];
  /** 這次比較時的矯正值（建議與套用以它為準）。 */
  private baseline: WakeKeywordOverrides | null = null;
  private timer: unknown = null;
  private speakEnds = 0;
  private applying = false;
  private message: string | null = null;
  private error: string | null = null;
  private startButton: HTMLButtonElement | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly host: WakeCalibrationHost, options: WakeCalibrationOptions = {}) {
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? (() => performance.now());
    this.element = h("section", { class: "surface surface--wake-calibration", role: "region", "data-visibility-reason": "user_request" });
    onLocaleChange(() => this.render());
    this.render();
  }

  /** 打開：回到輸入代號（不自動開始錄音）。 */
  open(): void {
    this.reset();
    this.render();
  }

  /** 收起：停止錄音、丟掉 worker 的錄音與畫面上的結果、收起提示顏色、恢復常駐聆聽。 */
  close(): void {
    this.endSession();
    this.reset();
  }

  /** 測試與 main.ts 用：工作階段是否還開著（麥克風與錄音）。 */
  get active(): boolean {
    return this.session !== null;
  }

  private reset(): void {
    this.phase = { kind: "intro" };
    this.prompt = 0;
    this.paused = false;
    this.clips = [];
    this.candidates = [];
    this.scans = [];
    this.scanTotal = this.scanDone = 0;
    this.scores = [];
    this.advice = [];
    this.baseline = null;
    this.applying = false;
    this.message = this.error = null;
  }

  /** 停掉工作階段：worker 丟掉錄音、還麥克風、恢復常駐聆聽；取消計時器與提示顏色。 */
  private endSession(): void {
    this.run++;
    this.cancelTimer();
    const session = this.session;
    this.session = null;
    session?.stop();
    this.host.cue(null);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private later(ms: number, fn: () => void): void {
    this.cancelTimer();
    const run = this.run;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (run === this.run) fn();
    }, ms);
  }

  // ───────────── 流程 ─────────────

  private async start(): Promise<void> {
    if (!WAKE_CALIBRATION_CODE.test(this.code)) return;
    this.endSession();
    const keepCode = this.code;
    this.reset();
    this.code = keepCode;
    this.baseline = this.host.settings()?.keyword_overrides ?? null;
    this.phase = { kind: "starting" };
    this.render();
    const run = ++this.run;
    let ready = false;
    const result = await this.host.start({
      ready: () => {
        if (run !== this.run || ready) return;
        ready = true;
        this.nextPrompt();
      },
      clip: (clip, k) => { if (run === this.run) this.onClip(clip, k); },
      scan: (candidate, clip, k) => { if (run === this.run) this.onScan(candidate, clip, k); },
      sweepDone: () => { if (run === this.run) this.onSweepDone(); },
      aborted: (reason) => { if (run === this.run) this.fail(ABORT_TEXT[reason]); },
    });
    if (run !== this.run) {
      if (typeof result !== "string") result.stop();
      return;
    }
    if (typeof result === "string") {
      this.fail(result);
      return;
    }
    this.session = result;
    this.render();
  }

  private fail(message: string): void {
    this.endSession();
    this.phase = { kind: "error", message };
    this.render();
  }

  private nextPrompt(): void {
    if (this.prompt >= CALIBRATION_PROMPTS.length) {
      this.startSweep();
      return;
    }
    this.phase = { kind: "prompt", step: "ready" };
    this.render();
    if (this.paused) return;
    this.later(READY_MS, () => void this.ding());
  }

  private async ding(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const run = this.run;
    this.phase = { kind: "prompt", step: "ding" };
    this.render();
    const played = await session.ding();
    if (run !== this.run || !played) return;
    session.beginClip();
    this.host.cue("speak");
    this.speakEnds = this.now() + PROMPT_WINDOW_MS;
    this.phase = { kind: "prompt", step: "speak" };
    this.render();
    this.tickSpeak();
  }

  /** 錄音中每 0.5 秒更新倒數；時間到就結束這段、等結果。 */
  private tickSpeak(): void {
    const left = this.speakEnds - this.now();
    if (left <= 0) {
      this.host.cue(null);
      this.phase = { kind: "prompt", step: "checking" };
      this.render();
      this.session?.endClip();
      this.later(CLIP_TIMEOUT_MS, () => this.fail("偵測器沒有回應，已停止矯正。"));
      return;
    }
    this.render();
    this.later(Math.min(500, left), () => this.tickSpeak());
  }

  private onClip(clip: number, keywordIndex: number): void {
    if (this.phase.kind !== "prompt" || this.phase.step !== "checking" || clip !== this.clips.length) return;
    this.cancelTimer();
    this.clips.push({ prompt: this.prompt, keyword_index: keywordIndex });
    this.phase = { kind: "prompt", step: "result" };
    this.render();
    this.later(RESULT_PAUSE_MS, () => {
      this.prompt++;
      this.nextPrompt();
    });
  }

  private togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused && this.phase.kind === "prompt" && this.phase.step === "ready") this.later(READY_MS, () => void this.ding());
    this.render();
  }

  private startSweep(): void {
    const session = this.session;
    if (!session) return;
    this.candidates = sweepCandidates(this.baseline);
    const lists = this.candidates.map((c) =>
      this.clips.flatMap((clip, k) => {
        const p = CALIBRATION_PROMPTS[clip.prompt]!;
        return p.kind === "negative" || p.group === c.group ? [k] : [];
      }));
    this.scans = this.candidates.map(() => []);
    this.scanTotal = lists.reduce((n, l) => n + l.length, 0);
    this.scanDone = 0;
    this.phase = { kind: "sweeping" };
    this.render();
    session.sweep(this.candidates, lists);
  }

  private onScan(candidate: number, clip: number, keywordIndex: number): void {
    if (this.phase.kind !== "sweeping" || !this.scans[candidate] || clip >= this.clips.length) return;
    if (this.scans[candidate]![clip] === undefined) this.scanDone++;
    this.scans[candidate]![clip] = keywordIndex;
    this.render();
  }

  private onSweepDone(): void {
    if (this.phase.kind !== "sweeping") return;
    // 比較完就不再需要錄音：立即丟掉、還麥克風、恢復常駐聆聽，畫面只留數字。
    this.endSession();
    this.scores = scoreCandidates(this.candidates, this.clips, this.scans);
    this.advice = recommend(this.scores, this.baseline);
    this.phase = { kind: "summary" };
    this.render();
  }

  /** 取消：丟掉錄音與結果，回到輸入代號。 */
  private cancel(): void {
    this.endSession();
    const keepCode = this.code;
    this.reset();
    this.code = keepCode;
    this.render();
  }

  private async apply(next: WakeKeywordOverrides | null, reset: boolean): Promise<void> {
    this.applying = true;
    this.message = this.error = null;
    this.render();
    const error = await this.host.apply(next);
    this.applying = false;
    if (error) this.error = error;
    else this.message = reset ? "已回復預設門檻。" : next ? "已套用：之後的喚醒偵測就用這組門檻。" : "已套用：建議值和出貨的預設相同，已改回預設。";
    this.render();
  }

  // ───────────── 畫面 ─────────────

  render(): void {
    const speaking = this.phase.kind === "prompt" && this.phase.step === "speak";
    this.element.classList.toggle("wake-calibration--speak", speaking);
    const parts: Child[] = [
      h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, t("喚醒詞")), h("h2", {}, t("矯正喚醒詞"))),
      ...this.body(),
      this.message ? h("p", { class: "notice" }, t(this.message)) : null,
      this.error ? h("p", { class: "error-text" }, t(this.error)) : null,
    ];
    this.element.replaceChildren(...parts.filter((c): c is Node | string => !!c));
  }

  private body(): Child[] {
    switch (this.phase.kind) {
      case "intro":
        return this.introPart();
      case "starting":
        return [h("p", { "aria-live": "polite" }, t("正在準備麥克風與偵測器…")), h("div", { class: "actions" }, button(t("取消"), () => this.cancel(), "btn--ghost"))];
      case "prompt":
        return this.promptPart();
      case "sweeping":
        return [
          h("p", { "aria-live": "polite" }, msg`錄音完成，正在用同一批錄音比較 ${this.candidates.length} 組門檻…（${this.scanDone}／${this.scanTotal}）`),
          h("p", { class: "muted small" }, t("比較只在這台 Mac 的記憶體裡進行，完成後錄音立即丟掉。")),
          this.tallyPart(),
          h("div", { class: "actions" }, button(t("取消"), () => this.cancel(), "btn--ghost")),
        ];
      case "summary":
        return this.summaryPart();
      case "error":
        return [
          h("p", { class: "error-text" }, t(this.phase.message)),
          h("div", { class: "actions" }, button(t("重新開始"), () => this.cancel(), "btn--primary"), button(t("收起"), () => this.host.dismiss(), "btn--ghost")),
        ];
    }
  }

  private introPart(): Child[] {
    const view = this.host.settings();
    const input = h("input", { type: "text", maxlength: "4", autocomplete: "off", spellcheck: "false", "aria-label": t("代號"), placeholder: t("例如 A1") });
    input.value = this.code;
    input.addEventListener("input", () => {
      this.code = input.value.trim();
      if (this.startButton) this.startButton.disabled = !WAKE_CALIBRATION_CODE.test(this.code);
    });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") void this.start(); });
    const runtimeOk = view?.runtime === "ok";
    this.startButton = button(t("開始錄音測試"), () => void this.start(), "btn--primary", !runtimeOk || !WAKE_CALIBRATION_CODE.test(this.code));
    return [
      h("p", { class: "muted small" }, t("叫不太醒、或常被誤叫醒時做一次：依提示念「Hey Nous」10 次、「Hello Nous」5 次，再念 5 句不該叫醒的話，約 3 分鐘。每次聽到「叮」、整個畫面變色時開始念。")),
      h("p", { class: "muted small" }, t("錄音只放在這台 Mac 的記憶體裡，用來比較幾組門檻；不寫檔、不上傳、不進紀錄，比較完或取消時立即丟掉。進行中會暫停常駐喚醒聆聽，結束後自動恢復。")),
      this.currentPart(),
      h("div", { class: "family-step" },
        h("label", {}, t("代號（1–4 個英文字母或數字，不用寫名字）")),
        h("div", {}, input),
      ),
      runtimeOk ? null : h("p", { class: "error-text" }, t("喚醒引擎可以使用後才能矯正")),
      h("div", { class: "actions" }, this.startButton, button(t("收起"), () => this.host.dismiss(), "btn--ghost")),
    ];
  }

  /** 目前每一組的值（預設或矯正值）。 */
  private currentPart(): HTMLElement {
    const overrides = this.host.settings()?.keyword_overrides ?? null;
    const rows = groupDefaults().map((d) => {
      const own = overrides?.groups[d.group];
      return h("tr", {},
        h("td", {}, groupLabel(d.group)),
        h("td", {}, tuningText(d)),
        h("td", {}, own ? tuningText(own) : t("（用預設）")),
      );
    });
    return h("div", { class: "calibration-results" },
      h("table", { class: "calibration-table" },
        h("thead", {}, h("tr", {}, h("th", {}, t("喚醒詞")), h("th", {}, t("預設（提升分數／門檻）")), h("th", {}, t("目前的矯正值")))),
        h("tbody", {}, ...rows)),
      overrides ? h("p", { class: "muted small" }, msg`上次矯正：代號 ${overrides.code}`, overrides.at ? ` · ${new Date(overrides.at).toLocaleString(getLocale())}` : "") : null,
    );
  }

  private promptPart(): Child[] {
    const step = this.phase.kind === "prompt" ? this.phase.step : "ready";
    const p = CALIBRATION_PROMPTS[this.prompt]!;
    const counter = msg`第 ${this.prompt + 1}／${CALIBRATION_PROMPTS.length} 句`;
    const kindLine = p.kind === "negative" ? t("這句不該叫醒 Nous：照平常的語氣念") : t("像平常要叫 Nous 那樣念");
    let status: Child;
    if (step === "ready") status = h("p", { class: "muted" }, this.paused ? t("已暫停。按「繼續」念下一句。") : t("準備…聽到「叮」再念"));
    else if (step === "ding") status = h("p", { class: "muted" }, t("叮…"));
    else if (step === "speak") status = h("p", { class: "wake-calibration-now", "aria-live": "assertive" }, msg`現在念！（還有 ${Math.max(0, Math.ceil((this.speakEnds - this.now()) / 1000))} 秒）`);
    else if (step === "checking") status = h("p", { class: "muted" }, t("檢查中…"));
    else status = this.resultLine(this.clips.at(-1)!);
    return [
      h("p", { class: "muted small" }, counter),
      h("p", { class: "wake-calibration-say" }, p.say),
      h("p", { class: "muted small" }, kindLine),
      status,
      this.tallyPart(),
      h("div", { class: "actions" },
        button(t(this.paused ? "繼續" : "暫停"), () => this.togglePause(), "btn--ghost"),
        button(t("取消"), () => this.cancel(), "btn--ghost"),
      ),
    ];
  }

  private resultLine(clip: ClipResult): HTMLElement {
    const p = CALIBRATION_PROMPTS[clip.prompt]!;
    const hit = clip.keyword_index >= 0;
    const good = p.kind === "negative" ? !hit : hit;
    const by = hit ? groupOfIndex(clip.keyword_index) : null;
    const text = p.kind === "negative"
      ? hit ? msg`會叫醒（被 ${groupLabel(by ?? "")} 認出）` : t("沒有叫醒 ✓")
      : hit ? msg`偵測到了 ✓（${groupLabel(by ?? "")}）` : t("沒有偵測到");
    return h("p", { class: good ? "wake-calibration-good" : "wake-calibration-bad", "aria-live": "polite" }, text);
  }

  /** 目前設定的累計（錄音當下的結果）。 */
  private tallyPart(): HTMLElement | null {
    const rows = currentSummary(this.clips);
    if (rows.length === 0) return null;
    return h("p", { class: "muted small" }, t("目前的設定："), rows.map((r) => (r.group === null ? msg`不該叫醒 ${r.hits}／${r.total} 次被叫醒` : `${r.say} ${r.hits}/${r.total}`)).join(getLocale() === "en" ? "; " : "；"));
  }

  private summaryPart(): Child[] {
    const overrides = this.host.settings()?.keyword_overrides ?? null;
    const body = this.scores.map((s) => {
      const d = groupDefaults().find((g) => g.group === s.group);
      const cur = currentTuning(s.group, this.baseline);
      const advice = this.advice.find((a) => a.group === s.group);
      const picked = advice?.status === "ok" && advice.pick.boost === s.boost && advice.pick.threshold === s.threshold;
      const tags = [
        d && d.boost === s.boost && d.threshold === s.threshold ? t("預設") : null,
        cur && cur.boost === s.boost && cur.threshold === s.threshold ? t("目前") : null,
        picked ? t("建議") : null,
      ].filter(Boolean).join("、");
      return h("tr", { class: picked ? "calibration-changed" : "" },
        h("td", {}, groupLabel(s.group)),
        h("td", {}, tuningText(s)),
        h("td", {}, `${s.hits}/${s.positives}`),
        h("td", {}, `${s.false_wakes}/${s.negatives}`),
        h("td", {}, tags),
      );
    });
    const notes = this.advice.map((a) => h("li", {}, h("strong", {}, groupLabel(a.group)), " — ", this.adviceText(a)));
    const changes = adviceChanges(this.advice);
    const next = overridesFromAdvice(this.advice, this.code, this.baseline);
    return [
      h("p", {}, msg`代號 ${this.code} 的結果：每一列是同一批錄音用那組門檻重掃的成績。「不該叫醒」必須是 0，再選認得最多次的。`),
      h("div", { class: "calibration-summary" },
        h("table", { class: "calibration-table" },
          h("thead", {}, h("tr", {}, ...[t("喚醒詞"), t("提升分數／門檻"), t("認出"), t("不該叫醒卻叫醒"), ""].map((c) => h("th", {}, c)))),
          h("tbody", {}, ...body)),
        h("ul", { class: "calibration-advice" }, ...notes),
        h("p", { class: "muted small" }, t("門檻越低越容易叫醒，也越容易被電視或聊天誤叫醒；一樣多次時建議選門檻較高的。錄音已經丟掉，畫面只留數字。")),
      ),
      h("div", { class: "actions" },
        button(t("套用"), () => void this.apply(next, false), "btn--primary", this.applying || !changes),
        button(t("重新測試"), () => void this.start(), "btn--ghost", this.applying),
        overrides ? button(t("回復預設"), () => void this.apply(null, true), "btn--ghost", this.applying) : null,
        button(t("收起"), () => this.host.dismiss(), "btn--ghost"),
      ),
    ];
  }

  private adviceText(a: GroupAdvice): string {
    if (a.status === "ok") {
      return a.changed
        ? msg`建議改成 ${tuningText(a.pick)}（目前 ${tuningText(a.current)}）：認出 ${a.pick.hits}/${a.pick.positives}，不該叫醒 0/${a.pick.negatives}`
        : msg`目前的 ${tuningText(a.current)} 已經是最適合的，不需要改`;
    }
    if (a.status === "all_false_wake") return t("每一組門檻都會被不該叫醒的句子叫醒，維持目前的值；可以換個安靜的環境再測一次。");
    if (a.status === "no_hits") return t("每一組門檻都沒有認出，維持目前的值；可以靠近麥克風、照提示的念法再測一次。");
    return t("這組沒有錄到，維持目前的值。");
  }
}

const ABORT_TEXT: Record<CalibrationSessionEvents["aborted"] extends (reason: infer R) => void ? R & string : never, string> = {
  runtime_missing: "喚醒引擎尚未安裝，無法矯正。",
  runtime_load_failed: "喚醒引擎載入失敗，已停止矯正。",
  sleep: "系統睡眠，已停止矯正並丟掉錄音。",
  lock: "螢幕已鎖定，已停止矯正並丟掉錄音。",
};
