import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-generator";
import {
  MEMORIES_CACHE_CAP_BYTES,
  MEMORIES_GOOGLE_PATHS,
  MEMORIES_GOOGLE_REASON,
  MEMORIES_ID,
  MEMORIES_MEDIA_PREFIX,
  type GooglePickPhase,
  type MemoriesGoogleView,
  type MemoriesItem,
  type MemoriesKind,
} from "../shared/memories.ts";
import type { GogRunner } from "./integrations/gog/runner.ts";
import { MEMORIES_MAX_BYTES } from "./memories.ts";

// MEMO-2：Google 相簿（Picker API）。使用者在 Google 的畫面挑選，核心經 gog 下載到 Mac 的快取（<configDir>/memories/google）。
// - gog 自己管 OAuth 與權杖；Nous 不讀、不存 Google 權杖，也不保存 Google 的原始項目 id 或 baseUrl（磁碟上只有 id 的雜湊）。
// - gog 的 stdout（含 pickerUri、baseUrl）與 stderr 都不寫 log；錯誤只用 MEMORIES_GOOGLE_REASON 的固定文字。
// - 照片不送模型；Google 會拿掉地點，所以項目只有時間。

/**
 * 每次最多挑幾項（Google 上限 2000）。gog 的 download 每次都重新列出整個 session 找那一項（第 n 項要讀 n 項），
 * 2000 項的總成本約 200 萬次列出；300 項時一次挑選在幾分鐘內下載完。
 */
export const MEMORIES_GOOGLE_MAX_PICK = 300;
export const GOOGLE_POLL_MIN_MS = 3_000;
export const GOOGLE_POLL_MAX_MS = 30_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** 結束時刪除 session（盡力而為）最多等多久。 */
const DELETE_TIMEOUT_MS = 10_000;
/** list 的 JSON（300 項，每項約 0.5 KB）；留足空間，超過時 JSON 解析失敗而照實回報。 */
const LIST_MAX_STDOUT = 4 * 1024 ** 2;

// ───────────── 快取 ─────────────

interface CacheEntry {
  /** sha256(Google 項目 id) 的十六進位；重新挑選同一項時用來去重。 */
  media_id_hash: string;
  /** 快取資料夾裡的檔名（雜湊前 32 字元＋副檔名）。 */
  file: string;
  kind: MemoriesKind;
  mime: string;
  taken_at: number | null;
  picked_at: number;
  bytes: number;
}

interface CacheIndex {
  version: 1;
  items: CacheEntry[];
}

/** 只依檔案開頭判斷格式（不信 Google 給的 mimeType）：瀏覽器播不了的格式（例如 HEIC）不收。 */
const SNIFF: { test(head: Buffer): boolean; kind: MemoriesKind; mime: string; ext: string }[] = [
  { test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, kind: "photo", mime: "image/jpeg", ext: ".jpg" },
  { test: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), kind: "photo", mime: "image/png", ext: ".png" },
  { test: (b) => b.toString("latin1", 0, 4) === "GIF8", kind: "photo", mime: "image/gif", ext: ".gif" },
  { test: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP", kind: "photo", mime: "image/webp", ext: ".webp" },
  { test: (b) => b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12)), kind: "photo", mime: "image/avif", ext: ".avif" },
  { test: (b) => b.toString("latin1", 4, 8) === "ftyp" && b.toString("latin1", 8, 12) === "qt  ", kind: "video", mime: "video/quicktime", ext: ".mov" },
  { test: (b) => b.toString("latin1", 4, 8) === "ftyp" && /^(isom|iso[2-6]|mp4[12]|avc1|M4V |mmp4|dash)$/.test(b.toString("latin1", 8, 12)), kind: "video", mime: "video/mp4", ext: ".mp4" },
  { test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), kind: "video", mime: "video/webm", ext: ".webm" },
];

const HEX64 = /^[a-f0-9]{64}$/;
const CACHE_FILE = /^[a-f0-9]{32}\.[a-z0-9]{3,4}$/;

export type CacheAddResult = "added" | "unsupported" | "too_large";

/** Mac 上的 Google 相簿快取：index.json 記錄每一項；超過上限時刪最早挑選的。 */
export class GooglePhotosCache {
  private entries: CacheEntry[];
  private readonly cap: number;

  constructor(private readonly options: { dir: string; capBytes?: number; log?(message: string): void }) {
    this.cap = options.capBytes ?? MEMORIES_CACHE_CAP_BYTES;
    this.entries = this.load();
  }

  static hashMediaId(mediaId: string): string {
    return createHash("sha256").update(mediaId).digest("hex");
  }

  has(mediaIdHash: string): boolean {
    return this.entries.some((e) => e.media_id_hash === mediaIdHash);
  }

  /** 下載的暫存檔（同一個資料夾，rename 才不跨磁碟）。 */
  partPath(mediaIdHash: string): string {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    return join(this.options.dir, `${mediaIdHash.slice(0, 32)}.part`);
  }

  /** 收下載好的暫存檔：判斷格式、檢查大小、改名、記到 index，然後依上限刪最早挑選的（不刪剛加入的）。 */
  add(mediaIdHash: string, part: string, meta: { kind: MemoriesKind; taken_at: number | null; picked_at: number }): CacheAddResult {
    const sniffed = sniff(part);
    const bytes = statSync(part).size;
    if (!sniffed || sniffed.kind !== meta.kind) {
      rmSync(part, { force: true });
      return "unsupported";
    }
    if (bytes > MEMORIES_MAX_BYTES[sniffed.kind]) {
      rmSync(part, { force: true });
      return "too_large";
    }
    const file = `${mediaIdHash.slice(0, 32)}${sniffed.ext}`;
    renameSync(part, join(this.options.dir, file));
    const entry: CacheEntry = { media_id_hash: mediaIdHash, file, kind: sniffed.kind, mime: sniffed.mime, taken_at: meta.taken_at, picked_at: meta.picked_at, bytes };
    this.entries = [...this.entries.filter((e) => e.media_id_hash !== mediaIdHash), entry];
    let total = this.entries.reduce((sum, e) => sum + e.bytes, 0);
    while (total > this.cap) {
      const oldest = this.entries.filter((e) => e !== entry).sort((a, b) => a.picked_at - b.picked_at)[0];
      if (!oldest) break;
      rmSync(join(this.options.dir, oldest.file), { force: true });
      this.entries = this.entries.filter((e) => e !== oldest);
      total -= oldest.bytes;
    }
    this.save();
    return "added";
  }

  items(): MemoriesItem[] {
    return this.entries.map((e) => ({ id: pageId(e), kind: e.kind, url: `${MEMORIES_MEDIA_PREFIX}${pageId(e)}`, taken_at: e.taken_at, place: null }));
  }

  file(id: string): { path: string; type: string } | null {
    if (!MEMORIES_ID.test(id)) return null;
    const entry = this.entries.find((e) => pageId(e) === id);
    return entry ? { path: join(this.options.dir, entry.file), type: entry.mime } : null;
  }

  counts(): { photos: number; videos: number; bytes: number } {
    let photos = 0;
    let videos = 0;
    let bytes = 0;
    for (const e of this.entries) {
      e.kind === "photo" ? photos++ : videos++;
      bytes += e.bytes;
    }
    return { photos, videos, bytes };
  }

  /** 刪掉快取資料夾裡的所有檔案（含之前索引壞掉留下的檔案與暫存檔）。 */
  clear(): void {
    this.entries = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) rmSync(join(this.options.dir, name), { force: true, recursive: true });
  }

  private load(): CacheEntry[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.options.dir, "index.json"), "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CacheIndex>;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("bad index");
      return parsed.items.filter(validEntry);
    } catch {
      // 不寫內容到 log（可能是任何東西）；從空的開始，下次清除會刪掉留下的檔案。
      this.options.log?.("Google 相簿快取的索引讀不到，從空的開始");
      return [];
    }
  }

  private save(): void {
    const index: CacheIndex = { version: 1, items: this.entries };
    const target = join(this.options.dir, "index.json");
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
    renameSync(tmp, target);
  }
}

/** 頁面看到的 id：和資料夾來源同樣格式，但輸入加上 "google\0" 前綴，兩個來源的 id 不會相同。 */
function pageId(entry: CacheEntry): string {
  return createHash("sha256").update(`google\0${entry.media_id_hash}`).digest("hex").slice(0, 32);
}

function validEntry(e: unknown): e is CacheEntry {
  const x = e as CacheEntry;
  return !!x && typeof x === "object" && HEX64.test(x.media_id_hash) && CACHE_FILE.test(x.file) && (x.kind === "photo" || x.kind === "video")
    && SNIFF.some((s) => s.mime === x.mime) && (x.taken_at === null || Number.isFinite(x.taken_at)) && Number.isFinite(x.picked_at) && Number.isInteger(x.bytes) && x.bytes >= 0;
}

function sniff(path: string): (typeof SNIFF)[number] | null {
  const head = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return SNIFF.find((s) => s.test(head)) ?? null;
}

// ───────────── gog 的輸出（邊界解析） ─────────────

/** Google 的 id 只用安全字元；也擋掉 "-" 開頭（避免被 gog 當成旗標）。 */
const GOOGLE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/;

interface PickerSession {
  id: string;
  pickerUri: string;
  expiresAt: number | null;
  pollMs: number;
  timeoutMs: number;
  mediaItemsSet: boolean;
}

interface PickedItem {
  id: string;
  kind: MemoriesKind;
  takenAt: number | null;
  /** 影片在 Google 處理好（READY）才能下載。 */
  ready: boolean;
}

/** Go 的 duration 字串（"5s"、"1800s"）→ 毫秒。 */
export function parseGoDuration(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?s$/.test(value)) return null;
  return Math.round(Number(value.slice(0, -1)) * 1000);
}

function parseSession(stdout: string): PickerSession | null {
  try {
    const s = (JSON.parse(stdout) as { session?: Record<string, unknown> }).session;
    if (!s || typeof s.id !== "string" || !GOOGLE_ID.test(s.id) || typeof s.pickerUri !== "string" || !s.pickerUri.startsWith("https://")) return null;
    const polling = (s.pollingConfig ?? {}) as Record<string, unknown>;
    const expires = typeof s.expireTime === "string" ? Date.parse(s.expireTime) : NaN;
    return {
      id: s.id,
      pickerUri: s.pickerUri,
      expiresAt: Number.isFinite(expires) ? expires : null,
      pollMs: parseGoDuration(polling.pollInterval) ?? DEFAULT_POLL_MS,
      timeoutMs: parseGoDuration(polling.timeoutIn) ?? DEFAULT_TIMEOUT_MS,
      mediaItemsSet: s.mediaItemsSet === true,
    };
  } catch {
    return null;
  }
}

function parseList(stdout: string): PickedItem[] | null {
  try {
    const items = (JSON.parse(stdout) as { mediaItems?: unknown }).mediaItems ?? [];
    if (!Array.isArray(items)) return null;
    const out: PickedItem[] = [];
    for (const raw of items as Record<string, unknown>[]) {
      if (!raw || typeof raw.id !== "string" || !GOOGLE_ID.test(raw.id) || (raw.type !== "PHOTO" && raw.type !== "VIDEO")) continue;
      const created = typeof raw.createTime === "string" ? Date.parse(raw.createTime) : NaN;
      const file = (raw.mediaFile ?? {}) as { mediaFileMetadata?: { videoMetadata?: { processingStatus?: unknown } } };
      out.push({
        id: raw.id,
        kind: raw.type === "PHOTO" ? "photo" : "video",
        takenAt: Number.isFinite(created) ? created : null,
        ready: raw.type === "PHOTO" || file.mediaFileMetadata?.videoMetadata?.processingStatus === "READY",
      });
    }
    return out;
  } catch {
    return null;
  }
}

// ───────────── 挑選工作（狀態機） ─────────────

export type GooglePickState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting_pick"; picker_uri: string; expires_at: number }
  | { phase: "downloading"; progress: Progress }
  | { phase: "done"; progress: Progress }
  | { phase: "failed"; error: string }
  | { phase: "cancelled"; progress: Progress | null };

type Progress = { done: number; total: number; skipped: number };

class PickFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/** Mac 內建的 sips：HEIC／大張照片 → 長邊 2048 px 的 JPEG（不經 shell）。 */
export const SIPS_PATH = "/usr/bin/sips";
export const CONVERT_MAX_PX = 2048;
export function sipsConverter(runner: GogRunner, sipsPath = SIPS_PATH) {
  return async (input: string, output: string, signal: AbortSignal): Promise<boolean> => {
    try {
      const res = await runner(sipsPath, ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(CONVERT_MAX_PX), input, "--out", output], { signal, maxStdout: 4096 });
      return res.code === 0;
    } catch {
      return false;
    }
  };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface GooglePickerOptions {
  gogPath: string;
  account: string;
  runner: GogRunner;
  cache: GooglePhotosCache;
  onChange(): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * 照片轉檔（Mac 的 sips）：iPhone 原檔多半是 HEIC，瀏覽器與 Pi 都不能顯示；gog 只下載原檔（=d），不能要縮小的尺寸。
   * 轉成長邊 2048 px 的 JPEG，Pi 解碼也比較輕。沒有轉檔器或轉檔失敗時照原檔判斷（HEIC 會被略過）。
   */
  convertPhoto?: (input: string, output: string, signal: AbortSignal) => Promise<boolean>;
}

/**
 * 一次只有一個挑選工作：
 * idle／done／failed／cancelled →pick→ starting →create→ waiting_pick →（每 clamp(pollInterval, 3 s, 30 s) get 一次）
 * → mediaItemsSet → list → downloading（逐項）→ done；最後一律盡力刪除 session。
 * cancel() 中止 AbortController（gog 子行程跟著結束）→ cancelled。
 */
export class GooglePicker {
  private current: GooglePickState = { phase: "idle" };
  private job: { controller: AbortController; done: Promise<void> } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: GooglePickerOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  state(): GooglePickState {
    return this.current;
  }

  busy(): boolean {
    return this.job !== null;
  }

  /**
   * 開始挑選；忙碌中回 null。ready：建立挑選連結之後（成功或失敗）才 resolve，HTTP 回應因此帶得到 picker_uri；
   * done：整個工作（含刪除 session）結束。
   */
  pick(): { ready: Promise<void>; done: Promise<void> } | null {
    if (this.job) return null;
    const controller = new AbortController();
    let markReady = () => {};
    const ready = new Promise<void>((r) => (markReady = r));
    const done = this.run(controller.signal, markReady).finally(() => {
      markReady();
      this.job = null;
      this.options.onChange();
    });
    this.job = { controller, done };
    return { ready, done };
  }

  cancel(): void {
    if (!this.job || this.job.controller.signal.aborted) return;
    this.job.controller.abort();
    const progress = this.current.phase === "downloading" ? this.current.progress : null;
    this.set({ phase: "cancelled", progress });
  }

  private set(next: GooglePickState): void {
    this.current = next;
    this.options.onChange();
  }

  private gog(args: string[], signal: AbortSignal, maxStdout?: number) {
    return this.options.runner(this.options.gogPath, [...args, `--account=${this.options.account}`], { signal, ...(maxStdout ? { maxStdout } : {}) });
  }

  private async run(signal: AbortSignal, markReady: () => void): Promise<void> {
    let sessionId: string | null = null;
    try {
      this.set({ phase: "starting" });
      const created = await this.gog(["photos", "picker", "create", `--max-items=${MEMORIES_GOOGLE_MAX_PICK}`, "--json"], signal).catch((err) => {
        if (signal.aborted) throw err;
        return { code: 1, stdout: "" };
      });
      const session = created.code === 0 ? parseSession(created.stdout) : null;
      if (!session) throw new PickFailed(MEMORIES_GOOGLE_REASON.auth);
      sessionId = session.id;
      const start = this.now();
      const deadline = Math.min(start + session.timeoutMs, session.expiresAt ?? Infinity);
      this.set({ phase: "waiting_pick", picker_uri: session.pickerUri, expires_at: Number.isFinite(deadline) ? deadline : start + session.timeoutMs });
      markReady();

      const interval = Math.min(GOOGLE_POLL_MAX_MS, Math.max(GOOGLE_POLL_MIN_MS, session.pollMs));
      for (let picked = session.mediaItemsSet; !picked; ) {
        if (this.now() >= deadline) throw new PickFailed(MEMORIES_GOOGLE_REASON.timeout);
        await this.sleep(interval, signal);
        const got = await this.gog(["photos", "picker", "get", session.id, "--json"], signal);
        const polled = got.code === 0 ? parseSession(got.stdout) : null;
        if (!polled) throw new PickFailed(MEMORIES_GOOGLE_REASON.list);
        picked = polled.mediaItemsSet;
      }

      const listed = await this.gog(["photos", "picker", "list", session.id, "--all", "--max=100", "--json"], signal, LIST_MAX_STDOUT);
      const items = listed.code === 0 ? parseList(listed.stdout) : null;
      if (!items) throw new PickFailed(MEMORIES_GOOGLE_REASON.list);

      const progress: Progress = { done: 0, total: items.length, skipped: 0 };
      this.set({ phase: "downloading", progress: { ...progress } });
      for (const item of items) {
        const ok = await this.download(session.id, item, signal);
        if (signal.aborted) throw abortError();
        progress.done++;
        if (!ok) progress.skipped++;
        this.set({ phase: "downloading", progress: { ...progress } });
      }
      this.set({ phase: "done", progress });
    } catch (err) {
      // 取消：cancel() 已經把階段設成 cancelled，這裡不覆寫。
      if (!signal.aborted) this.set({ phase: "failed", error: err instanceof PickFailed ? err.reason : MEMORIES_GOOGLE_REASON.download });
    } finally {
      if (sessionId) await this.deleteSession(sessionId);
    }
  }

  /** 一項：已在快取就略過下載；影片還沒處理好、下載失敗、格式不支援或太大都算略過（回 false）。 */
  private async download(sessionId: string, item: PickedItem, signal: AbortSignal): Promise<boolean> {
    const hash = GooglePhotosCache.hashMediaId(item.id);
    if (this.options.cache.has(hash)) return true;
    if (!item.ready) return false;
    const part = this.options.cache.partPath(hash);
    try {
      const res = await this.gog(["photos", "picker", "download", sessionId, item.id, `--out=${part}`, "--overwrite"], signal);
      if (res.code !== 0 || signal.aborted) return false;
      if (item.kind === "photo" && this.options.convertPhoto) {
        const converted = `${part}.jpg`;
        try {
          if (await this.options.convertPhoto(part, converted, signal)) renameSync(converted, part);
        } finally {
          rmSync(converted, { force: true });
        }
        if (signal.aborted) return false;
      }
      return this.options.cache.add(hash, part, { kind: item.kind, taken_at: item.takenAt, picked_at: this.now() }) === "added";
    } catch (err) {
      if (signal.aborted) throw err;
      return false;
    } finally {
      rmSync(part, { force: true });
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
    timer.unref?.();
    try {
      await this.gog(["photos", "picker", "delete", sessionId], controller.signal);
    } catch {
      // 盡力而為：session 會在 Google 那邊自己過期。
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───────────── 組合（memoriesFeature 的 google 部分） ─────────────

export interface MemoriesGooglePart {
  view(): MemoriesGoogleView;
  /** unavailable：沒有 gog 或帳號；busy：已有挑選工作。started 時已建立挑選連結（或已失敗）。 */
  pick(): Promise<"started" | "busy" | "unavailable">;
  cancel(): void;
  clear(): void;
  /** waiting_pick 時挑選連結的 QR code（SVG）；其他時候 null。 */
  qrSvg(): string | null;
  items(): MemoriesItem[];
  file(id: string): { path: string; type: string } | null;
}

/** picker 為 null 時（找不到 gog、沒有帳號）：之前下載的快取照樣播放，挑選回 unavailable。 */
export function googleMemories(cache: GooglePhotosCache, picker: GooglePicker | { unavailable: string }): MemoriesGooglePart {
  const live = picker instanceof GooglePicker ? picker : null;
  const state = (): GooglePickState => live?.state() ?? { phase: "idle" };
  return {
    view() {
      const s = state();
      const counts = cache.counts();
      return {
        available: live !== null,
        unavailable_reason: live ? null : (picker as { unavailable: string }).unavailable,
        phase: s.phase satisfies GooglePickPhase,
        picker_uri: s.phase === "waiting_pick" ? s.picker_uri : null,
        expires_at: s.phase === "waiting_pick" ? s.expires_at : null,
        progress: "progress" in s ? s.progress : null,
        error: s.phase === "failed" ? s.error : null,
        ...counts,
        cap_bytes: MEMORIES_CACHE_CAP_BYTES,
        paths: MEMORIES_GOOGLE_PATHS,
      };
    },
    async pick() {
      if (!live) return "unavailable";
      const job = live.pick();
      if (!job) return "busy";
      await job.ready;
      return "started";
    },
    cancel: () => live?.cancel(),
    clear() {
      live?.cancel();
      cache.clear();
    },
    qrSvg() {
      const s = state();
      if (s.phase !== "waiting_pick") return null;
      const qr = qrcode(0, "M");
      qr.addData(s.picker_uri);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    },
    items: () => cache.items(),
    file: (id) => cache.file(id),
  };
}
