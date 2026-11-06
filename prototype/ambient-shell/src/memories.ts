import type { MemoriesItem, MemoriesPrefs } from "../shared/memories.ts";

// MEMO-1：回憶模式的畫面。一次只放一個媒體元素（照片或影片；Pi 4 只有一個影片解碼器），
// 每一張：浮現（從電子腦的位置放大）→ 停留 → 退回電子腦 → 下一張。hide() 立即收起並停掉影片。

export const MEMORIES_TIMING = {
  emergeMs: 1400,
  recedeMs: 1000,
  videoMaxMs: 30_000,
  fetchRetryMs: 60_000,
  /** 電子腦縮到角落的時間（CSS 1.2 s）；第一張等它到位才浮現，起點才準。 */
  brainMs: 1200,
  collapseMs: 250,
  /** 減少動態效果時只有淡入淡出。 */
  fadeMs: 400,
  /** 說明文字在浮現結束後多久淡入；退回前先淡出這麼久。 */
  captionDelayMs: 600,
  captionFadeMs: 400,
} as const;

export const MEMORIES_VISIBILITY_REASON = "memories_idle";

type Timer = ReturnType<typeof setTimeout>;

export interface MemoriesPresenterOptions {
  root: HTMLElement;
  doc?: Pick<Document, "createElement">;
  setTimeout?(fn: () => void, ms: number): Timer;
  clearTimeout?(id: Timer): void;
  random?(): number;
  /** 預先載入並解碼照片；失敗時 reject（跳過這張）。 */
  loadImage?(url: string): Promise<void>;
  reducedMotion?(): boolean;
  /** 電子腦中心相對畫面中心的位移（px）；照片從這裡浮現、退回這裡。 */
  origin?(): { x: number; y: number } | null;
  /** 這一張的時間與地點說明（只來自檔案的中繼資料）；null＝不顯示。 */
  caption?(item: MemoriesItem): string | null;
  /** 點照片＝喚醒（收起）。 */
  onWake(): void;
}

function browserLoadImage(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  return img.decode();
}

export class MemoriesPresenter {
  private readonly doc: Pick<Document, "createElement">;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (id: Timer) => void;
  private readonly random: () => number;
  private readonly loadImage: (url: string) => Promise<void>;
  private readonly slot: HTMLElement;
  private readonly captionEl: HTMLElement;
  private readonly timers = new Set<Timer>();
  private items: MemoriesItem[] = [];
  private queue: MemoriesItem[] = [];
  private prefs: MemoriesPrefs | null = null;
  private current: HTMLImageElement | HTMLVideoElement | null = null;
  private preloaded: { id: string; done: Promise<void> } | null = null;
  private failures = 0;
  /** 每次 show／hide 加一：舊的計時與載入結果一律作廢。 */
  private generation = 0;
  private running = false;

  constructor(private readonly options: MemoriesPresenterOptions) {
    this.doc = options.doc ?? document;
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => clearTimeout(id));
    this.random = options.random ?? Math.random;
    this.loadImage = options.loadImage ?? browserLoadImage;
    const root = options.root;
    root.classList.add("memories");
    root.hidden = true;
    root.dataset.state = "hidden";
    const stage = this.doc.createElement("figure");
    stage.className = "memories-stage";
    this.slot = this.doc.createElement("div");
    this.slot.className = "memories-slot";
    this.captionEl = this.doc.createElement("figcaption");
    this.captionEl.className = "memories-caption";
    this.captionEl.dataset.visible = "no";
    stage.append(this.slot, this.captionEl);
    root.append(stage);
    root.addEventListener("click", () => options.onWake());
  }

  get showing(): boolean {
    return this.running;
  }

  /** 開始（或更新）播放。已在播放時只更新清單與設定，不打斷這一張。 */
  show(items: readonly MemoriesItem[], prefs: MemoriesPrefs): void {
    this.prefs = prefs;
    this.items = [...items];
    const known = new Set(this.items.map((i) => i.id));
    this.queue = this.queue.filter((i) => known.has(i.id));
    if (this.current?.tagName === "VIDEO") (this.current as HTMLVideoElement).muted = !prefs.video_sound;
    if (this.running || this.items.length === 0) return;
    this.cancel();
    this.running = true;
    this.failures = 0;
    const root = this.options.root;
    const reduced = this.reduced();
    root.hidden = false;
    root.dataset.state = "showing";
    root.dataset.motion = reduced ? "reduced" : "full";
    root.dataset.visibilityReason = MEMORIES_VISIBILITY_REASON;
    // 第一張也走計時器（呼叫端的 render 先完成）。
    this.after(reduced ? 1 : MEMORIES_TIMING.brainMs, () => this.advance());
  }

  /** 立即收起：停掉計時與影片（拿掉 src），短暫收合後隱藏。 */
  hide(): void {
    if (!this.running && this.options.root.dataset.state !== "showing") return;
    this.cancel();
    this.running = false;
    this.teardown();
    this.preloaded = null;
    const root = this.options.root;
    root.dataset.state = "collapsing";
    delete root.dataset.visibilityReason;
    this.after(MEMORIES_TIMING.collapseMs, () => {
      root.hidden = true;
      root.dataset.state = "hidden";
      this.slot.replaceChildren();
    });
  }

  dispose(): void {
    this.cancel();
    this.running = false;
    this.teardown();
    this.options.root.hidden = true;
    this.options.root.dataset.state = "hidden";
  }

  private reduced(): boolean {
    return this.options.reducedMotion?.() ?? false;
  }

  private after(ms: number, fn: () => void): void {
    if (ms <= 0) return fn();
    const generation = this.generation;
    const id = this.setTimer(() => {
      this.timers.delete(id);
      if (generation === this.generation) fn();
    }, ms);
    this.timers.add(id);
  }

  private cancel(): void {
    this.generation++;
    for (const id of this.timers) this.clearTimer(id);
    this.timers.clear();
  }

  private teardown(): void {
    const el = this.current;
    this.current = null;
    this.captionEl.dataset.visible = "no";
    if (el && el.tagName === "VIDEO") {
      const video = el as HTMLVideoElement;
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    el?.remove();
  }

  private nextItem(): MemoriesItem | null {
    if (!this.queue.length) {
      // 每一輪洗牌一次（Fisher–Yates）。
      const order = [...this.items];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      this.queue = order;
    }
    return this.queue.shift() ?? null;
  }

  private advance(): void {
    this.teardown();
    const item = this.nextItem();
    if (!item || !this.prefs) return;
    if (item.kind === "photo") this.showPhoto(item);
    else this.showVideo(item);
  }

  /** 跳過壞掉的一張；整輪都失敗時等一段時間再試（不空轉）。 */
  private skip(): void {
    this.failures++;
    if (this.failures >= Math.max(1, this.items.length)) {
      this.failures = 0;
      this.after(MEMORIES_TIMING.fetchRetryMs, () => this.advance());
    } else this.advance();
  }

  private load(item: MemoriesItem): Promise<void> {
    const ready = this.preloaded?.id === item.id ? this.preloaded.done : this.loadImage(item.url);
    this.preloaded = null;
    return ready;
  }

  private showPhoto(item: MemoriesItem): void {
    const generation = this.generation;
    this.load(item).then(
      () => {
        if (generation !== this.generation) return;
        const img = this.doc.createElement("img");
        img.className = "memories-item";
        img.setAttribute("alt", "");
        img.setAttribute("src", item.url);
        this.present(img, item, (done) => this.after(this.prefs!.dwell_s * 1000, done));
        const next = this.queue[0];
        if (next?.kind === "photo") this.preloaded = { id: next.id, done: this.loadImage(next.url) };
        this.preloaded?.done.catch(() => undefined);
      },
      () => {
        if (generation === this.generation) this.skip();
      },
    );
  }

  private showVideo(item: MemoriesItem): void {
    const generation = this.generation;
    const video = this.doc.createElement("video");
    video.className = "memories-item";
    video.muted = !this.prefs!.video_sound;
    video.playsInline = true;
    video.preload = "auto";
    let started = false;
    const fail = () => {
      if (generation !== this.generation || this.current !== video) return;
      this.skip();
    };
    video.addEventListener("error", fail);
    video.addEventListener("loadeddata", () => {
      if (started || generation !== this.generation || this.current !== video) return;
      started = true;
      this.present(video, item, (done) => {
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          done();
        };
        video.addEventListener("ended", end);
        this.after(MEMORIES_TIMING.videoMaxMs, end);
      });
      video.play().catch(() => {
        // 有聲自動播放被擋：改靜音再試一次；仍失敗就跳過。
        if (generation !== this.generation || this.current !== video) return;
        if (!video.muted) {
          video.muted = true;
          video.play().catch(fail);
        } else fail();
      });
    });
    this.current = video;
    video.setAttribute("src", item.url);
    this.slot.replaceChildren(video);
    video.dataset.phase = "loading";
  }

  /** 浮現 → hold(done) → 說明淡出 → 退回 → 下一張。 */
  private present(el: HTMLImageElement | HTMLVideoElement, item: MemoriesItem, hold: (done: () => void) => void): void {
    const reduced = this.reduced();
    const emergeMs = reduced ? MEMORIES_TIMING.fadeMs : MEMORIES_TIMING.emergeMs;
    const recedeMs = reduced ? MEMORIES_TIMING.fadeMs : MEMORIES_TIMING.recedeMs;
    this.failures = 0;
    this.current = el;
    // 起點在每一張浮現時才量（電子腦縮到角落後才準）。
    const origin = this.options.origin?.() ?? null;
    const root = this.options.root;
    root.style.setProperty("--memories-origin-x", `${Math.round(origin?.x ?? 0)}px`);
    root.style.setProperty("--memories-origin-y", `${Math.round(origin?.y ?? 0)}px`);
    el.style.setProperty("--memories-dwell", `${this.prefs!.dwell_s}s`);
    el.dataset.phase = "emerging";
    if (el.parentNode !== this.slot) this.slot.replaceChildren(el);
    const caption = this.options.caption?.(item) ?? null;
    this.captionEl.textContent = caption ?? "";
    this.captionEl.dataset.visible = "no";
    this.after(emergeMs, () => {
      el.dataset.phase = "holding";
      if (caption) this.after(reduced ? 0 : MEMORIES_TIMING.captionDelayMs, () => (this.captionEl.dataset.visible = "yes"));
      hold(() => {
        this.captionEl.dataset.visible = "no";
        this.after(caption && !reduced ? MEMORIES_TIMING.captionFadeMs : 0, () => {
          el.dataset.phase = "receding";
          this.after(recedeMs, () => this.advance());
        });
      });
    });
  }
}
