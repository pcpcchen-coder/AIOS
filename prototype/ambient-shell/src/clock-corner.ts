import { msUntilNextMinute, type ClockWeatherRow, type WeatherNowView } from "../shared/clock.ts";
import { ClockFeed } from "./clock-feed.ts";
import type { Locale } from "./i18n.ts";
import { weatherIconSvg } from "./weather-icons.ts";

// CLK-1（George 2026-11-07）：畫面右上角的時間、日期、星期、氣溫與天氣。
// 環境狀態角落（被動讀數，和 .status-line、鏡頭指示一樣），不是 Surface：沒有按鈕、不能點、不搶焦點；
// data-visibility-reason="user_setting:clock_corner"＝使用者在設定打開了這個角落（Mac 視窗／Pi 終端機各自一個開關）。
// - 資料、逾時、核心時間校正與換日檢查在 ClockFeed（src/clock-feed.ts，不碰 DOM）；這裡只負責畫與事件。
// - 每分鐘只重寫一次（對齊整分），不用每秒的計時器；回到前景、取得焦點、pageshow 時立即重畫並重讀（睡眠後不顯示舊時間）。
// - 天氣每 15 分鐘向核心讀一次（核心另有 30 分鐘快取），頁面隱藏時暫停。查不到照實說，不畫猜的天氣。

export interface ClockCornerOptions {
  /** 讀 GET /api/weather/now；失敗時丟錯。signal 在逾時時中止。 */
  fetchWeather(signal: AbortSignal): Promise<WeatherNowView>;
  locale(): Locale;
  /** 預設 document.body。 */
  host?: HTMLElement;
  enlarged?: boolean;
}

export class ClockCorner {
  private root: HTMLElement | null = null;
  private els: Record<"time" | "date" | "mode" | "modeIcon" | "modeText" | "weather" | "icon" | "temp" | "cond" | "detail" | "age" | "note", HTMLElement> | null = null;
  /** VOL-2：日間／夜間（null＝還沒決定）；label 是已翻譯的文字，title 是原因。 */
  private dayNight: { mode: "day" | "night"; label: string; title: string } | null = null;
  private modeKey = "";
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private iconKey = "";
  private readonly feed: ClockFeed;
  private readonly onVisibility = () => this.wake();
  private readonly onResize = () => this.publishSize();
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly options: ClockCornerOptions) {
    this.feed = new ClockFeed({ fetchWeather: (signal) => options.fetchWeather(signal), onUpdate: () => this.render() });
  }

  get enabled(): boolean {
    return this.root !== null;
  }

  /** 設定（settings.clock.enabled）改變時呼叫；同樣的值再呼叫沒有作用。 */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (on) this.mount();
    else this.unmount();
  }

  /** 介面語言改變：立即重畫，並重新讀天氣（地點名稱依語言；請求進行中時，結束後再讀一次）。 */
  refreshLocale(): void {
    if (!this.enabled) return;
    this.render();
    void this.feed.load();
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "clock-corner";
    root.classList.toggle("clock-corner--enlarged", this.options.enlarged === true);
    root.id = "clock-corner";
    root.dataset.visibilityReason = "user_setting:clock_corner";
    root.setAttribute("role", "group");
    root.hidden = true; // 有核心給的時區才顯示
    const el = (tag: string, cls: string, parent: HTMLElement = root) => {
      const node = document.createElement(tag);
      node.className = cls;
      parent.append(node);
      return node;
    };
    const time = el("div", "clock-time");
    const date = el("div", "clock-date");
    // VOL-2：日間／夜間模式（太陽／月亮與文字）；只反映對話音量現在用哪一組，原因在 title。
    const mode = el("div", "clock-mode");
    mode.hidden = true;
    const modeIcon = el("span", "clock-mode-icon", mode);
    modeIcon.setAttribute("aria-hidden", "true");
    const modeText = el("span", "clock-mode-text", mode);
    const weather = el("div", "clock-weather");
    const icon = el("span", "clock-icon", weather);
    icon.setAttribute("aria-hidden", "true");
    const temp = el("span", "clock-temp", weather);
    const cond = el("span", "clock-cond", weather);
    const detail = el("div", "clock-detail");
    const age = el("div", "clock-age");
    const note = el("div", "clock-note");
    this.els = { time, date, mode, modeIcon, modeText, weather, icon, temp, cond, detail, age, note };
    this.root = root;
    (this.options.host ?? document.body).append(root);
    document.body.classList.add("has-clock");
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onVisibility);
    window.addEventListener("pageshow", this.onVisibility);
    window.addEventListener("resize", this.onResize);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.publishSize());
      this.resizeObserver.observe(root);
    }
    if (document.visibilityState !== "hidden") this.feed.resume();
  }

  private unmount(): void {
    this.feed.pause();
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    this.minuteTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onVisibility);
    window.removeEventListener("pageshow", this.onVisibility);
    window.removeEventListener("resize", this.onResize);
    this.root?.remove();
    this.root = this.els = null;
    this.iconKey = "";
    this.modeKey = "";
    document.body.classList.remove("has-clock");
    document.documentElement.style.removeProperty("--clock-h");
    document.documentElement.style.removeProperty("--clock-reserve");
  }

  /** visibilitychange、focus、pageshow：隱藏時暫停；看得到時立即重畫（睡眠後不顯示舊時間）並重讀。 */
  private wake(): void {
    if (!this.enabled) return;
    if (document.visibilityState === "hidden") {
      this.feed.pause();
      if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
      this.minuteTimer = null;
      return;
    }
    this.render();
    this.feed.resume();
  }

  private scheduleMinute(): void {
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    this.minuteTimer = null;
    if (!this.enabled || document.visibilityState === "hidden") return;
    this.minuteTimer = setTimeout(() => this.render(), msUntilNextMinute(this.feed.now()));
  }

  private render(): void {
    const root = this.root;
    const els = this.els;
    if (!root || !els) return;
    this.scheduleMinute();
    const snap = this.feed.snapshot(this.options.locale());
    if (!snap) {
      root.hidden = true;
      return;
    }
    setText(els.time, snap.time);
    setText(els.date, snap.date);
    this.renderMode();
    this.renderWeather(snap.row);
    if (root.getAttribute("aria-label") !== snap.label) root.setAttribute("aria-label", snap.label);
    root.dataset.weather = snap.row.kind;
    root.hidden = false;
    this.publishSize();
  }

  /** VOL-2：日間／夜間模式改變或換語言時呼叫（main.ts 依對話音量的判斷）。 */
  setDayNight(state: { mode: "day" | "night"; label: string; title: string } | null): void {
    this.dayNight = state;
    if (this.root && !this.root.hidden) {
      this.renderMode();
      this.publishSize();
    }
  }

  private renderMode(): void {
    const els = this.els;
    if (!els) return;
    const state = this.dayNight;
    els.mode.hidden = !state;
    if (!state) return;
    els.mode.dataset.mode = state.mode;
    if (state.mode !== this.modeKey) {
      // 固定的 SVG 字串（weather-icons.ts 的晴天／晴夜），不含任何資料。
      els.modeIcon.innerHTML = weatherIconSvg("clear", state.mode === "night");
      this.modeKey = state.mode;
    }
    setText(els.modeText, state.label);
    if (els.mode.title !== state.title) els.mode.title = state.title;
  }

  private renderWeather(row: ClockWeatherRow): void {
    const els = this.els!;
    const showWeather = row.kind === "weather";
    els.weather.hidden = !showWeather;
    els.detail.hidden = !showWeather || !row.detail;
    els.age.hidden = !showWeather || !row.age;
    els.note.hidden = row.kind !== "note";
    setText(els.note, row.note ?? "");
    if (!showWeather) return;
    const key = row.icon ? `${row.icon.kind}${row.icon.night ? "-n" : ""}` : "";
    if (key !== this.iconKey) {
      // 圖示是程式裡的固定 SVG 字串（weather-icons.ts），不含任何資料。
      els.icon.innerHTML = row.icon ? weatherIconSvg(row.icon.kind, row.icon.night) : "";
      els.icon.hidden = !row.icon;
      this.iconKey = key;
      els.weather.classList.remove("clock-weather--in");
      void els.weather.offsetWidth;
      els.weather.classList.add("clock-weather--in");
    }
    setText(els.temp, row.main);
    setText(els.cond, row.condition ?? "");
    els.cond.hidden = !row.condition;
    setText(els.detail, row.detail ?? "");
    setText(els.age, row.age ?? "");
  }

  /** 讓語音狀態膠囊排在時鐘下方、置中的提示不壓到時鐘（CSS 變數 --clock-h、--clock-reserve）。 */
  private publishSize(): void {
    const root = this.root;
    if (!root || root.hidden) return;
    const rect = root.getBoundingClientRect();
    const style = document.documentElement.style;
    const h = `${Math.ceil(rect.bottom)}px`;
    const reserve = `${Math.ceil(window.innerWidth - rect.left + 16)}px`;
    if (style.getPropertyValue("--clock-h") !== h) style.setProperty("--clock-h", h);
    if (style.getPropertyValue("--clock-reserve") !== reserve) style.setProperty("--clock-reserve", reserve);
  }
}

/** 只在內容改變時重寫（每分鐘一次的更新不讓整個角落重排）。 */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
