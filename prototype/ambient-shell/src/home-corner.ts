import type { HomeCornerModel, HomeOverviewView } from "../shared/home-corner.ts";
import { HomeFeed } from "./home-feed.ts";
import { homeIconSvg } from "./home-icons.ts";
import type { Locale } from "./i18n.ts";

// HOME-1（George 2026-11-07）：畫面左上角的家中狀態（室內溫濕度、開著的燈與插座、冷氣）。
// 和右上角時鐘（src/clock-corner.ts）一樣是環境狀態角落，不是 Surface：沒有按鈕、不能點、不能控制、不搶焦點；
// data-visibility-reason="user_setting:home_corner"＝使用者在設定打開了這個角落（Mac 視窗／Pi 終端機各自一個開關）。
// - 資料與排程在 HomeFeed（src/home-feed.ts，不碰 DOM）；這裡只負責畫與事件。
// - 每 60 秒向核心讀一次（核心另有 30 秒快取），頁面隱藏時暫停；回到前景、取得焦點、pageshow 時立即重讀。
// - 小畫面（CSS）只省略房間與設備名稱；讀值的時間與「控制器回報」一律畫，舊資料不會看起來像即時的。

export interface HomeCornerOptions {
  /** 讀 GET /api/home/overview；失敗時丟錯。signal 在逾時時中止。 */
  fetchOverview(signal: AbortSignal): Promise<HomeOverviewView>;
  locale(): Locale;
  /** 預設 document.body。 */
  host?: HTMLElement;
  enlarged?: boolean;
}

type Els = Record<
  "refresh" | "climate" | "tempIcon" | "temp" | "humIcon" | "hum" | "climateDetail" | "climateRoom" | "climateMeta" | "climateOther" | "lines" | "note" | "noteDetail",
  HTMLElement
>;

export class HomeCorner {
  private root: HTMLElement | null = null;
  private els: Els | null = null;
  private linesKey = "";
  private readonly feed: HomeFeed;
  private readonly onVisibility = () => this.wake();
  private readonly onResize = () => this.publishSize();
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly options: HomeCornerOptions) {
    this.feed = new HomeFeed({ fetchOverview: (signal) => options.fetchOverview(signal), onUpdate: () => this.render() });
  }

  get enabled(): boolean {
    return this.root !== null;
  }

  /** 設定（settings.home_corner.enabled）改變時呼叫；同樣的值再呼叫沒有作用。 */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (on) this.mount();
    else this.unmount();
  }

  /** 介面語言改變：立即重畫（文字都在頁面組，不必重讀）。 */
  refreshLocale(): void {
    this.render();
  }

  /** 家電控制有了結果：立即重讀、8 秒後再讀一次（核心看到控制結束也會跳過快取）。 */
  refreshSoon(): void {
    if (this.enabled) this.feed.afterControl();
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "home-corner";
    root.classList.toggle("home-corner--enlarged", this.options.enlarged === true);
    root.id = "home-corner";
    root.dataset.visibilityReason = "user_setting:home_corner";
    root.setAttribute("role", "group");
    root.hidden = true; // 核心回應後才顯示
    const el = (tag: string, cls: string, parent: HTMLElement = root) => {
      const node = document.createElement(tag);
      node.className = cls;
      parent.append(node);
      return node;
    };
    const refresh = el("div", "home-refresh");
    const climate = el("div", "home-climate");
    const tempIcon = el("span", "home-icon home-icon--temp", climate);
    const temp = el("span", "home-temp", climate);
    const humIcon = el("span", "home-icon home-icon--hum", climate);
    const hum = el("span", "home-hum", climate);
    // 圖示是程式裡的固定 SVG 字串（home-icons.ts），不含任何資料。
    tempIcon.innerHTML = homeIconSvg("thermometer");
    humIcon.innerHTML = homeIconSvg("droplet");
    const climateDetail = el("div", "home-climate-detail");
    const climateRoom = el("span", "home-climate-room", climateDetail);
    const climateMeta = el("span", "home-climate-meta", climateDetail);
    const climateOther = el("div", "home-climate-other");
    const lines = el("ul", "home-lines");
    const note = el("div", "home-note");
    const noteDetail = el("div", "home-note-detail");
    this.els = { refresh, climate, tempIcon, temp, humIcon, hum, climateDetail, climateRoom, climateMeta, climateOther, lines, note, noteDetail };
    this.root = root;
    (this.options.host ?? document.body).append(root);
    document.body.classList.add("has-home-corner");
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onVisibility);
    window.removeEventListener("pageshow", this.onVisibility);
    window.removeEventListener("resize", this.onResize);
    this.root?.remove();
    this.root = this.els = null;
    this.linesKey = "";
    document.body.classList.remove("has-home-corner");
    document.documentElement.style.removeProperty("--home-reserve");
  }

  private wake(): void {
    if (!this.enabled) return;
    if (document.visibilityState === "hidden") {
      this.feed.pause();
      return;
    }
    if (!this.feed.running) this.feed.resume();
    else if (!this.feed.loading) void this.feed.load();
    // 手上的資料太舊時，重讀完成前先標「更新中…」。
    this.render();
  }

  private render(): void {
    const root = this.root;
    const els = this.els;
    if (!root || !els) return;
    const model = this.feed.model(this.options.locale());
    if (model.kind === "none") {
      root.hidden = true;
      return;
    }
    this.renderModel(model, els);
    if (root.getAttribute("aria-label") !== model.label) root.setAttribute("aria-label", model.label);
    root.dataset.state = model.kind;
    root.classList.toggle("home-corner--refreshing", model.refreshing);
    root.hidden = false;
    this.publishSize();
  }

  private renderModel(model: HomeCornerModel, els: Els): void {
    const data = model.kind === "data";
    els.refresh.hidden = !data || !model.refreshNote;
    setText(els.refresh, model.refreshNote ?? "");
    els.climate.hidden = !data || (!model.temp && !model.humidity);
    els.tempIcon.hidden = els.temp.hidden = !model.temp;
    els.humIcon.hidden = els.hum.hidden = !model.humidity;
    setText(els.temp, model.temp ?? "");
    setText(els.hum, model.humidity ?? "");
    els.climateDetail.hidden = !data || (!model.climateRoom && !model.climateDetail);
    els.climateRoom.hidden = !model.climateRoom;
    setText(els.climateRoom, model.climateRoom ?? "");
    els.climateMeta.hidden = !model.climateDetail;
    setText(els.climateMeta, model.climateDetail ?? "");
    els.climateOther.hidden = !data || !model.climateOther.length;
    const otherKey = model.climateOther.join("\n");
    if (els.climateOther.dataset.key !== otherKey) {
      els.climateOther.dataset.key = otherKey;
      els.climateOther.replaceChildren(
        ...model.climateOther.map((text) => {
          const row = document.createElement("div");
          row.className = "home-climate-other-row";
          row.textContent = text;
          return row;
        }),
      );
    }
    els.note.hidden = model.kind !== "note";
    setText(els.note, model.note ?? "");
    els.noteDetail.hidden = model.kind !== "note" || !model.noteDetail;
    setText(els.noteDetail, model.noteDetail ?? "");
    els.lines.hidden = !data || !model.lines.length;
    const key = JSON.stringify(model.lines);
    if (key === this.linesKey) return;
    this.linesKey = key;
    els.lines.replaceChildren(
      ...model.lines.map((line) => {
        const li = document.createElement("li");
        li.className = `home-line${line.active ? " home-line--on" : ""}`;
        const icon = document.createElement("span");
        icon.className = "home-icon";
        icon.innerHTML = homeIconSvg(line.icon, line.active);
        const body = document.createElement("span");
        body.className = "home-line-body";
        const text = document.createElement("span");
        text.className = "home-line-text";
        // 後面的空白是唯一的換行點（.home-line-text 是 keep-all），「· 2 個未知」整段換到下一行。
        text.textContent = line.extra ? `${line.text} ` : line.text;
        if (line.extra) {
          const extra = document.createElement("span");
          extra.className = "home-line-extra";
          extra.textContent = `· ${line.extra}`;
          text.append(extra);
        }
        body.append(text);
        for (const [cls, value] of [
          ["home-line-detail", line.detail],
          ["home-line-qualifier", line.qualifier],
        ] as const) {
          if (!value) continue;
          const detail = document.createElement("span");
          detail.className = cls;
          detail.textContent = value;
          body.append(detail);
        }
        li.append(icon, body);
        return li;
      }),
    );
  }

  /** 置中的提示與腦區文字不壓到這個角落（CSS 變數 --home-reserve）。 */
  private publishSize(): void {
    const root = this.root;
    if (!root || root.hidden) return;
    const rect = root.getBoundingClientRect();
    const reserve = `${Math.ceil(rect.right + 16)}px`;
    const style = document.documentElement.style;
    if (style.getPropertyValue("--home-reserve") !== reserve) style.setProperty("--home-reserve", reserve);
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
