// MEMO-1：回憶模式的畫面（假 DOM、假計時器；照片與影片只是 mock 網址，不載入真的檔案）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORIES_TIMING, MemoriesPresenter } from "../src/memories.ts";
import { DEFAULT_MEMORIES_PREFS, type MemoriesItem, type MemoriesPrefs } from "../shared/memories.ts";

class FakeEl {
  readonly tagName: string;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  dataset: Record<string, string> = {};
  hidden = false;
  className = "";
  textContent = "";
  muted = false;
  playsInline = false;
  preload = "";
  paused = true;
  loads = 0;
  playFails = 0;
  readonly attrs = new Map<string, string>();
  readonly styles = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = { add: (c: string) => this.classes.add(c) };
  readonly style = { setProperty: (k: string, v: string) => this.styles.set(k, v) };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...nodes: FakeEl[]) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: FakeEl[]) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  play() {
    if (this.playFails > 0) {
      this.playFails--;
      return Promise.reject(new Error("NotAllowedError"));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() { this.loads++; }
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const photo = (n: number): MemoriesItem => ({ id: `${n}`.padStart(32, "a"), kind: "photo", url: `/api/memories/media/p${n}`, taken_at: null, place: n === 1 ? { zh: "新竹", en: "Hsinchu" } : null });
const video = (n: number): MemoriesItem => ({ id: `${n}`.padStart(32, "b"), kind: "video", url: `/api/memories/media/v${n}`, taken_at: null, place: null });

let created: FakeEl[];
function rig(options: { reduced?: boolean; failUrls?: string[] } = {}) {
  created = [];
  const root = new FakeEl("div");
  const loaded: string[] = [];
  const onWake = vi.fn();
  const presenter = new MemoriesPresenter({
    root: root as unknown as HTMLElement,
    doc: { createElement: ((tag: string) => {
      const el = new FakeEl(tag);
      created.push(el);
      return el;
    }) as unknown as Document["createElement"] },
    random: () => 0.99, // 洗牌後維持原順序
    loadImage: (url) => {
      loaded.push(url);
      return options.failUrls?.includes(url) ? Promise.reject(new Error("decode")) : Promise.resolve();
    },
    reducedMotion: () => options.reduced ?? false,
    origin: () => ({ x: -400, y: 300 }),
    caption: (item) => (item.place ? `在${item.place.zh}` : null),
    onWake,
  });
  const slot = () => root.all().find((e) => e.className === "memories-slot")!;
  const caption = () => root.all().find((e) => e.className === "memories-caption")!;
  const media = () => slot().children[0] ?? null;
  return { root, presenter, slot, caption, media, loaded, onWake };
}

const prefs = (over: Partial<MemoriesPrefs> = {}): MemoriesPrefs => ({ ...DEFAULT_MEMORIES_PREFS, enabled: true, ...over });
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("photo cycle", () => {
  it("waits for the brain to move, then emerge → hold dwell → caption out → recede → next", async () => {
    const r = rig();
    r.presenter.show([photo(1), photo(2)], prefs());
    expect(r.root.hidden).toBe(false);
    expect(r.root.dataset.visibilityReason).toBe("memories_idle");
    expect(r.media()).toBeNull();
    await tick(MEMORIES_TIMING.brainMs);
    const first = r.media()!;
    expect(first.tagName).toBe("IMG");
    expect(first.getAttribute("src")).toBe("/api/memories/media/p1");
    expect(first.dataset.phase).toBe("emerging");
    expect(r.root.styles.get("--memories-origin-x")).toBe("-400px");
    expect(r.root.styles.get("--memories-origin-y")).toBe("300px");
    // 下一張先載好（不進畫面）。
    expect(r.loaded).toEqual(["/api/memories/media/p1", "/api/memories/media/p2"]);
    await tick(MEMORIES_TIMING.emergeMs);
    expect(first.dataset.phase).toBe("holding");
    expect(r.caption().dataset.visible).toBe("no");
    await tick(MEMORIES_TIMING.captionDelayMs);
    expect(r.caption()).toMatchObject({ textContent: "在新竹", dataset: { visible: "yes" } });
    await tick(8000 - MEMORIES_TIMING.captionDelayMs - 1);
    expect(first.dataset.phase).toBe("holding");
    await tick(1);
    expect(r.caption().dataset.visible).toBe("no");
    await tick(MEMORIES_TIMING.captionFadeMs);
    expect(first.dataset.phase).toBe("receding");
    await tick(MEMORIES_TIMING.recedeMs);
    const second = r.media()!;
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe("/api/memories/media/p2");
    expect(r.slot().children).toHaveLength(1);
    expect(r.loaded).toHaveLength(2); // 第二張用預先載好的
  });

  it("a photo that fails to decode is skipped", async () => {
    const r = rig({ failUrls: ["/api/memories/media/p1"] });
    r.presenter.show([photo(1), photo(2)], prefs());
    await tick(MEMORIES_TIMING.brainMs);
    expect(r.media()?.getAttribute("src")).toBe("/api/memories/media/p2");
  });

  it("tapping the overlay is a wake", () => {
    const r = rig();
    r.presenter.show([photo(1)], prefs());
    r.root.emit("click");
    expect(r.onWake).toHaveBeenCalledTimes(1);
  });
});

describe("video", () => {
  it("muted by default; holds until ended; only one <video> exists at a time and each is released", async () => {
    const r = rig();
    r.presenter.show([video(1), video(2)], prefs());
    await tick(MEMORIES_TIMING.brainMs);
    const v1 = r.media()!;
    expect(v1.tagName).toBe("VIDEO");
    expect(v1).toMatchObject({ muted: true, playsInline: true, preload: "auto" });
    v1.emit("loadeddata");
    await tick(0);
    expect(v1.paused).toBe(false);
    await tick(MEMORIES_TIMING.emergeMs + MEMORIES_TIMING.videoMaxMs - 1);
    expect(v1.dataset.phase).toBe("holding");
    v1.emit("ended");
    await tick(MEMORIES_TIMING.recedeMs);
    const v2 = r.media()!;
    expect(v2).not.toBe(v1);
    expect(v1.getAttribute("src")).toBeNull();
    expect(v1.loads).toBe(1);
    expect(r.root.all().filter((e) => e.tagName === "VIDEO")).toEqual([v2]);
  });

  it("video_sound plays with sound; a blocked autoplay retries muted", async () => {
    const r = rig();
    r.presenter.show([video(1)], prefs({ video_sound: true }));
    await tick(MEMORIES_TIMING.brainMs);
    const v = r.media()!;
    expect(v.muted).toBe(false);
    v.playFails = 1;
    v.emit("loadeddata");
    await tick(0);
    expect(v.muted).toBe(true);
    expect(v.paused).toBe(false);
  });

  it("a long video recedes after videoMaxMs", async () => {
    const r = rig();
    r.presenter.show([video(1), photo(2)], prefs());
    await tick(MEMORIES_TIMING.brainMs);
    const v = r.media()!;
    v.emit("loadeddata");
    await tick(MEMORIES_TIMING.emergeMs + MEMORIES_TIMING.videoMaxMs);
    expect(v.dataset.phase).toBe("receding");
  });
});

describe("stalls and errors", () => {
  it("a video error mid-playback moves on once; its old 30 s limit does not cut the next photo short", async () => {
    const r = rig();
    r.presenter.show([video(1), photo(1), photo(2)], prefs({ dwell_s: 60 as MemoriesPrefs["dwell_s"] }));
    await tick(MEMORIES_TIMING.brainMs);
    const v = r.media()!;
    v.emit("loadeddata");
    await tick(MEMORIES_TIMING.emergeMs + 1000);
    v.emit("error");
    await tick(0);
    const p1 = r.media()!;
    expect(p1.getAttribute("src")).toBe("/api/memories/media/p1");
    // 舊影片的 videoMaxMs 到期的時刻：p1 仍在停留，沒有被推到 p2。
    await tick(MEMORIES_TIMING.videoMaxMs);
    expect(r.media()).toBe(p1);
    expect(p1.dataset.phase).toBe("holding");
  });

  it("a video that never loads is skipped after loadTimeoutMs", async () => {
    const r = rig();
    r.presenter.show([video(1), photo(2)], prefs());
    await tick(MEMORIES_TIMING.brainMs);
    expect(r.media()!.tagName).toBe("VIDEO");
    await tick(MEMORIES_TIMING.loadTimeoutMs);
    expect(r.media()!.getAttribute("src")).toBe("/api/memories/media/p2");
    expect(r.root.all().filter((e) => e.tagName === "VIDEO")).toEqual([]);
  });
});

describe("hide", () => {
  it("is immediate: timers cancelled, video stopped and its src removed, collapsed within 250 ms", async () => {
    const r = rig();
    r.presenter.show([video(1)], prefs());
    await tick(MEMORIES_TIMING.brainMs);
    const v = r.media()!;
    v.emit("loadeddata");
    await tick(MEMORIES_TIMING.emergeMs);
    r.presenter.hide();
    expect(v.paused).toBe(true);
    expect(v.getAttribute("src")).toBeNull();
    expect(v.loads).toBe(1);
    expect(r.media()).toBeNull();
    expect(r.root.dataset.state).toBe("collapsing");
    expect(r.root.dataset.visibilityReason).toBeUndefined();
    await tick(MEMORIES_TIMING.collapseMs);
    expect(r.root.hidden).toBe(true);
    // 收起後舊的計時不會再放下一張。
    await tick(120_000);
    expect(r.media()).toBeNull();
    expect(created.filter((e) => e.tagName === "VIDEO")).toHaveLength(1);
  });

  it("showing again after a hide starts fresh", async () => {
    const r = rig();
    r.presenter.show([photo(1)], prefs());
    r.presenter.hide();
    r.presenter.show([photo(2)], prefs());
    expect(r.root.dataset.state).toBe("showing");
    await tick(MEMORIES_TIMING.brainMs);
    expect(r.media()?.getAttribute("src")).toBe("/api/memories/media/p2");
    await tick(MEMORIES_TIMING.collapseMs);
    expect(r.root.hidden).toBe(false);
  });
});

it("reduced motion: no wait for the brain, short fades, caption shown at once", async () => {
  const r = rig({ reduced: true });
  r.presenter.show([photo(1), photo(2)], prefs());
  expect(r.root.dataset.motion).toBe("reduced");
  await tick(1);
  const first = r.media()!;
  expect(first.dataset.phase).toBe("emerging");
  await tick(MEMORIES_TIMING.fadeMs);
  expect(first.dataset.phase).toBe("holding");
  expect(r.caption().dataset.visible).toBe("yes");
  await tick(8000);
  expect(first.dataset.phase).toBe("receding");
  await tick(MEMORIES_TIMING.fadeMs);
  expect(r.media()).not.toBe(first);
});
