// 「校正人臉辨識」畫面（George 2026-10-31）：在「家人辨識」Surface 裡，由選單列「校正人臉辨識…」或家人辨識畫面的按鈕打開。
// 依序到幾個常用位置、各面向螢幕約 6 秒，量測距離、看不看得到臉、品質與面向，已登記家人時順便試認；
// 最後建議一組校正值，使用者按「套用」才保存（核心 face-tuning.json）。只有數字，不存影像；收起就丟掉量測紀錄。

import { formatTuning, FACE_TUNING_KEYS, FACE_TUNING_SPEC, type FaceTuning, type FaceTuningView } from "../shared/face-tuning.ts";
import type { IdentityState } from "../shared/identity.ts";
import { CALIBRATION_SPOTS, SPOT_MEASURE_MS, SpotRecorder, spotAdvice, suggestTuning, summarizeSpot, tuningChanges, type SenseSample, type SpotSummary } from "./face-calibration.ts";
import { getLocale, msg, t } from "./i18n.ts";
import { QUALITY_LABEL } from "./sense/face/quality.ts";
import type { ClientFrame } from "./sense/identity-client.ts";
import type { FrameOptions } from "./sense/identity-protocol.ts";

/** 鏡頭畫面的畫布（與 SensePipeline.setPreview 的 PreviewTargets 同形）。 */
export interface CalibrationPreview {
  live: HTMLCanvasElement;
  diff: HTMLCanvasElement;
}

export interface CalibrationHost {
  /** 開始取樣（每一格帶量測值）；同一時間只有一個取樣器。 */
  startSampling(onFrame: (frame: ClientFrame) => void, options: () => FrameOptions): void;
  stopSampling(): void;
  /** 試認一格（只有品質合格、帶特徵的格）；沒有 session 或沒有家人時回 null。 */
  probe(frame: ClientFrame): Promise<IdentityState | null>;
  hasPeople(): boolean;
  /** 「載入辨識模型…」「鏡頭沒有在運作」之類的取樣器狀態；正常時為 null。 */
  clientLine(): string | null;
  /** 目前的感知狀態（在場、面向、距離）；鏡頭沒在運作時為 null。 */
  sense(): SenseSample | null;
  /** 顯示或收起鏡頭畫面。 */
  preview(targets: CalibrationPreview | null): void;
  /** 目前的校正值（核心 settings.face_tuning）；鏡頭未啟用時為 undefined。 */
  tuning(): FaceTuningView | undefined;
  /** 套用（patch）或還原預設（"reset"）；回傳錯誤說明，成功為 null。 */
  applyTuning(change: Partial<FaceTuning> | "reset", calibrated: boolean): Promise<string | null>;
  changed(): void;
  back(): void;
}

type Status = "ready" | "measuring" | "summary";

interface SpotResult {
  recorder: SpotRecorder;
  summary: SpotSummary;
}

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

const percent = (r: number) => `${Math.round(r * 100)}%`;

export interface CalibrationOptions {
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class CalibrationPanel {
  private status: Status = "ready";
  private spot = 0;
  private readonly results: (SpotResult | null)[] = CALIBRATION_SPOTS.map(() => null);
  private recorder: SpotRecorder | null = null;
  private startedAt = 0;
  private timer: unknown = null;
  private live: { quality: string | null; sense: SenseSample | null } = { quality: null, sense: null };
  private probing = false;
  private applying = false;
  private message: string | null = null;
  private error: string | null = null;
  private readonly canvas: CalibrationPreview;
  private readonly now: () => number;

  constructor(private readonly host: CalibrationHost, private readonly options: CalibrationOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    const live = document.createElement("canvas");
    live.width = 320;
    live.height = 180;
    live.className = "calibration-preview";
    const diff = document.createElement("canvas");
    diff.width = 2;
    diff.height = 2;
    this.canvas = { live, diff };
  }

  /** 打開：從第一個位置開始，顯示鏡頭畫面。 */
  open(): void {
    this.reset();
    this.host.preview(this.canvas);
  }

  /** 收起或返回：停止量測、收起鏡頭畫面、丟掉所有量測紀錄。 */
  close(): void {
    this.stopMeasuring();
    this.host.preview(null);
    this.reset();
  }

  private reset(): void {
    this.status = "ready";
    this.spot = 0;
    this.results.fill(null);
    this.recorder = null;
    this.message = this.error = null;
    this.applying = false;
  }

  /** 給宿主的畫面去重鍵（內容沒變就不重畫，量測中每 200 ms 也只在數字變了才重畫）。 */
  renderKey(): string {
    const elapsed = this.status === "measuring" ? Math.ceil((SPOT_MEASURE_MS - (this.now() - this.startedAt)) / 1000) : null;
    return JSON.stringify([
      getLocale(), this.status, this.spot, elapsed, this.live, this.results.map((r) => r?.summary ?? null),
      this.message, this.error, this.applying, this.host.tuning(), this.host.clientLine(),
    ]);
  }

  // ───────────── 量測 ─────────────

  private startMeasuring(): void {
    this.message = this.error = null;
    this.recorder = new SpotRecorder();
    this.startedAt = this.now();
    this.status = "measuring";
    const tuning = this.host.tuning();
    this.host.startSampling((frame) => this.onFrame(frame), () => ({
      metrics: true,
      ...(tuning ? { quality: { min_face_px: tuning.min_face_px, max_yaw_offset: tuning.max_yaw_offset } } : {}),
    }));
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = every(() => this.onTick(), 200);
    this.host.changed();
  }

  private onTick(): void {
    const rec = this.recorder;
    if (!rec || this.status !== "measuring") return;
    const sense = this.host.sense();
    if (sense) rec.addSense(sense);
    this.live.sense = sense;
    if (this.now() - this.startedAt >= SPOT_MEASURE_MS) this.finishSpot();
    this.host.changed();
  }

  private onFrame(frame: ClientFrame): void {
    const rec = this.recorder;
    if (!rec || this.status !== "measuring") {
      frame.feature?.fill(0);
      return;
    }
    rec.addFrame(frame);
    this.live.quality = QUALITY_LABEL[frame.quality];
    if (frame.feature && !this.probing && this.host.hasPeople()) {
      this.probing = true;
      const target = rec;
      void this.host.probe(frame).then((state) => {
        this.probing = false;
        if (state && target === this.recorder) target.addObservation(state);
      });
    } else {
      frame.feature?.fill(0);
    }
    this.host.changed();
  }

  private stopMeasuring(): void {
    if (this.timer !== null) (this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
    this.host.stopSampling();
    this.probing = false;
    this.live = { quality: null, sense: null };
  }

  private finishSpot(): void {
    const rec = this.recorder;
    this.stopMeasuring();
    if (rec) this.results[this.spot] = { recorder: rec, summary: summarizeSpot(rec) };
    this.recorder = null;
    this.advance();
  }

  private advance(): void {
    this.spot++;
    this.status = this.spot >= CALIBRATION_SPOTS.length ? "summary" : "ready";
    this.host.changed();
  }

  private skip(): void {
    this.results[this.spot] = null;
    this.advance();
  }

  private toSummary(): void {
    this.stopMeasuring();
    this.status = "summary";
    this.host.changed();
  }

  private measured(): SpotResult[] {
    return this.results.filter((r): r is SpotResult => r !== null);
  }

  private suggestion(): { current: FaceTuning; next: FaceTuning } | null {
    const view = this.host.tuning();
    if (!view) return null;
    const current = Object.fromEntries(FACE_TUNING_KEYS.map((k) => [k, view[k]])) as unknown as FaceTuning;
    return { current, next: suggestTuning(this.measured(), current) };
  }

  private async apply(change: Partial<FaceTuning> | "reset"): Promise<void> {
    this.applying = true;
    this.message = this.error = null;
    this.host.changed();
    const error = await this.host.applyTuning(change, change !== "reset");
    this.applying = false;
    if (error) this.error = error;
    else this.message = change === "reset" ? "已還原預設值。" : "已套用：之後看著說話的辨識就用這組值。";
    this.host.changed();
  }

  // ───────────── 畫面 ─────────────

  render(): HTMLElement {
    const parts: Child[] = [
      h("h3", {}, t("校正人臉辨識")),
      h("p", { class: "muted small" }, t("鏡頭換了位置或角度後做一次：依序到你常跟 Nous 說話的位置，各面向螢幕約 6 秒。只記錄數字（距離、臉的大小與角度），不存影像；收起畫面就丟掉。")),
      h("div", { class: "calibration-layout" }, h("div", { class: "calibration-main" }, ...this.mainPart()), h("figure", { class: "calibration-camera" }, this.canvas.live, h("figcaption", { class: "muted small" }, t("鏡頭畫面（左眼）· 只在本機")))),
      this.message ? h("p", { class: "notice" }, t(this.message)) : null,
      this.error ? h("p", { class: "error-text" }, t(this.error)) : null,
      this.resultsTable(),
    ];
    if (this.status === "summary") parts.push(this.summaryPart());
    return h("div", { class: "family-step calibration" }, ...parts);
  }

  private mainPart(): Child[] {
    const line = this.host.clientLine();
    if (this.status === "summary") return [h("p", {}, t("量測完成。下面是每個位置的結果與建議值。"))];
    const spot = CALIBRATION_SPOTS[this.spot]!;
    const step = msg`位置 ${this.spot + 1}／${CALIBRATION_SPOTS.length}：${t(spot.label)}`;
    if (this.status === "measuring") {
      const left = Math.max(0, Math.ceil((SPOT_MEASURE_MS - (this.now() - this.startedAt)) / 1000));
      const s = this.live.sense;
      const senseLine = !s ? t("鏡頭沒有在運作") : !s.present ? t("沒有看到人") : msg`距離 ${s.distance_m === null ? "—" : s.distance_m.toFixed(2)} m · ${s.facing ? t("面向螢幕") : t("沒有面向螢幕")}`;
      return [
        h("p", { class: "family-result" }, step),
        h("p", { "aria-live": "polite" }, line ?? msg`量測中…還有 ${left} 秒，請自然地面向螢幕`),
        h("p", { class: "muted small" }, senseLine),
        this.live.quality ? h("p", { class: "muted small" }, msg`臉：${t(this.live.quality)}`) : null,
        h("div", { class: "actions" }, button(t("停止"), () => this.toSummary(), "btn--ghost")),
      ];
    }
    return [
      h("p", { class: "family-result" }, step),
      h("p", { class: "muted small" }, t("到這個位置坐好或站好，像平常要跟 Nous 說話那樣面向螢幕，再按「開始量測」。")),
      h("div", { class: "actions" },
        button(t("開始量測"), () => this.startMeasuring(), "btn--primary", this.applying),
        button(t("跳過這個位置"), () => this.skip(), "btn--ghost"),
        this.measured().length > 0 ? button(t("結束，看建議"), () => this.toSummary(), "btn--ghost") : null,
        button(t("返回"), () => this.host.back(), "btn--ghost"),
      ),
    ];
  }

  private resultsTable(): HTMLElement | null {
    const rows = this.results.map((r, i) => (r ? { r, i } : null)).filter((x): x is { r: SpotResult; i: number } => x !== null);
    if (rows.length === 0) return null;
    const head = h("tr", {}, ...[t("位置"), t("距離"), t("看到臉"), t("品質合格"), t("面向"), t("認得")].map((c) => h("th", {}, c)));
    const body = rows.map(({ r, i }) => {
      const s = r.summary;
      const known = s.recognized === "yes" ? t("認得") : s.recognized === "no" ? t("不認得") : "—";
      return h("tr", {},
        h("td", {}, t(CALIBRATION_SPOTS[i]!.label)),
        h("td", {}, s.distance_m === null ? "—" : `${s.distance_m.toFixed(2)} m`),
        h("td", {}, percent(s.face_ratio)),
        h("td", {}, percent(s.ok_ratio)),
        h("td", {}, percent(s.facing_ratio)),
        h("td", {}, known),
      );
    });
    const advice = rows.flatMap(({ r, i }) => spotAdvice(r.summary).map((a) => h("li", {}, h("strong", {}, t(CALIBRATION_SPOTS[i]!.label)), " — ", t(a))));
    return h("div", { class: "calibration-results" },
      h("table", { class: "calibration-table" }, h("thead", {}, head), h("tbody", {}, ...body)),
      advice.length > 0 ? h("ul", { class: "calibration-advice" }, ...advice) : null,
    );
  }

  private summaryPart(): HTMLElement {
    const s = this.suggestion();
    const view = this.host.tuning();
    if (!s || !view) return h("p", { class: "error-text" }, t("鏡頭未啟用，無法保存校正值。"));
    const changes = tuningChanges(s.current, s.next);
    const rows = FACE_TUNING_KEYS.map((k) =>
      h("tr", { class: k in changes ? "calibration-changed" : "" },
        h("td", {}, t(FACE_TUNING_SPEC[k].label)),
        h("td", {}, formatTuning(k, s.current[k])),
        h("td", {}, formatTuning(k, s.next[k])),
      ));
    const none = this.measured().length === 0;
    return h("div", { class: "calibration-summary" },
      h("table", { class: "calibration-table" },
        h("thead", {}, h("tr", {}, h("th", {}, t("項目")), h("th", {}, t("目前")), h("th", {}, t("建議")))),
        h("tbody", {}, ...rows)),
      h("p", { class: "muted small" }, none
        ? t("沒有量測任何位置，無法建議。")
        : Object.keys(changes).length === 0 ? t("目前的值已經適合這些位置，不需要改。") : t("建議值只用「看得到臉」的位置推算；比對門檻不會改。")),
      view.calibrated_at ? h("p", { class: "muted small" }, msg`上次校正：${new Date(view.calibrated_at).toLocaleString(getLocale())}`) : null,
      h("div", { class: "actions" },
        button(t("套用建議"), () => void this.apply(changes), "btn--primary", this.applying || Object.keys(changes).length === 0),
        button(t("重新量測"), () => { this.reset(); this.host.changed(); }, "btn--ghost", this.applying),
        view.customized ? button(t("還原預設"), () => void this.apply("reset"), "btn--ghost", this.applying) : null,
        button(t("返回"), () => this.host.back(), "btn--ghost"),
      ),
    );
  }
}
