import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  DEFAULT_MEMORIES_PREFS,
  DWELL_OPTIONS_S,
  IDLE_OPTIONS_S,
  MEMORIES_ID,
  MEMORIES_MEDIA_PREFIX,
  MEMORIES_PREF_KEYS,
  MEMORIES_WRITE_PATH,
  parseMemoriesPatch,
  type MemoriesItem,
  type MemoriesKind,
  type MemoriesPrefs,
  type MemoriesPrefsPatch,
  type MemoriesSettingsView,
  type MemoriesSourceStatus,
} from "../shared/memories.ts";
import { PrefsFile } from "./prefs-file.ts";
import { nearestPlace, readMediaMeta } from "./memories-meta.ts";

// MEMO-1：回憶模式的設定（memories.json）與本機資料夾來源。資料夾路徑只來自 NOUS_MEMORIES_DIR 或預設值，
// 不接受 HTTP 指定；回應只有不透明的 id，不含檔名或路徑。

export class MemoriesSettingsStore {
  private readonly file: PrefsFile<MemoriesPrefs>;

  constructor(private readonly options: { dir: string; onChange(): void; log?(message: string): void }) {
    this.file = new PrefsFile<MemoriesPrefs>({
      dir: options.dir,
      name: "memories.json",
      version: 1,
      parse: parseMemoriesPatch,
      failClosed: { enabled: false },
      unreadable: "回憶模式保持關閉",
      log: options.log,
    });
  }

  view(): MemoriesPrefs {
    const saved = this.file.saved;
    return Object.fromEntries(MEMORIES_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_MEMORIES_PREFS[key]])) as unknown as MemoriesPrefs;
  }

  update(patch: MemoriesPrefsPatch): MemoriesPrefs {
    this.file.update(patch);
    this.options.onChange();
    return this.view();
  }
}

/** 第二個來源（MEMO-2 雲端相簿）實作同一個介面。 */
export interface MemoriesSource {
  readonly kind: "folder";
  items(): MemoriesItem[];
  file(id: string): { path: string; type: string } | null;
  status(): MemoriesSourceStatus;
}

const MEDIA_TYPES: Record<string, { kind: MemoriesKind; type: string }> = {
  ".jpg": { kind: "photo", type: "image/jpeg" },
  ".jpeg": { kind: "photo", type: "image/jpeg" },
  ".png": { kind: "photo", type: "image/png" },
  ".webp": { kind: "photo", type: "image/webp" },
  ".gif": { kind: "photo", type: "image/gif" },
  ".avif": { kind: "photo", type: "image/avif" },
  ".mp4": { kind: "video", type: "video/mp4" },
  ".m4v": { kind: "video", type: "video/mp4" },
  ".webm": { kind: "video", type: "video/webm" },
  ".mov": { kind: "video", type: "video/quicktime" },
};

export const MEMORIES_MAX_BYTES: Record<MemoriesKind, number> = { photo: 30 * 1024 ** 2, video: 200 * 1024 ** 2 };
export const MEMORIES_RESCAN_MS = 60_000;

interface Entry {
  item: MemoriesItem;
  path: string;
  type: string;
}

/**
 * 本機資料夾（例如「照片」App 匯出的資料夾）：掃第一層與下一層子資料夾，略過隱藏檔、指到資料夾外的連結與太大的檔案。
 * 最多每 MEMORIES_RESCAN_MS 重新掃一次（呼叫 items／status 時才掃）。
 */
export class FolderMemoriesSource implements MemoriesSource {
  readonly kind = "folder";
  private entries = new Map<string, Entry>();
  /** 每個 id 的拍攝時間與地點（id 含大小與修改時間，內容變了 id 就變）。 */
  private meta = new Map<string, Pick<MemoriesItem, "taken_at" | "place">>();
  private state: MemoriesSourceStatus["state"] = "missing";
  private scannedAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly options: { dir: string; create?: boolean; now?: () => number; log?(message: string): void }) {
    this.now = options.now ?? Date.now;
    if (options.create) {
      try {
        mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        options.log?.(`無法建立回憶資料夾（${(err as Error).message}）`);
      }
    }
  }

  items(): MemoriesItem[] {
    this.refresh();
    return [...this.entries.values()].map((e) => e.item);
  }

  file(id: string): { path: string; type: string } | null {
    if (!MEMORIES_ID.test(id)) return null;
    this.refresh();
    const entry = this.entries.get(id);
    return entry ? { path: entry.path, type: entry.type } : null;
  }

  status(): MemoriesSourceStatus {
    this.refresh();
    let photos = 0;
    let videos = 0;
    for (const { item } of this.entries.values()) item.kind === "photo" ? photos++ : videos++;
    return { state: this.state, photos, videos };
  }

  private refresh(): void {
    const now = this.now();
    if (this.scannedAt !== null && now - this.scannedAt < MEMORIES_RESCAN_MS) return;
    this.scannedAt = now;
    const next = new Map<string, Entry>();
    let root: string;
    try {
      root = realpathSync(this.options.dir);
      if (!statSync(root).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.state = code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
      this.entries = next;
      return;
    }
    try {
      this.scan(root, root, 0, next);
    } catch (err) {
      this.options.log?.(`讀不到回憶資料夾（${(err as Error).message}）`);
      this.state = "failed";
      this.entries = next;
      return;
    }
    this.entries = next;
    for (const id of this.meta.keys()) if (!next.has(id)) this.meta.delete(id);
    this.state = next.size > 0 ? "ok" : "empty";
  }

  private scan(root: string, dir: string, depth: number, out: Map<string, Entry>): void {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      let path = join(dir, name);
      let stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        // 連結只接受仍在資料夾內的目標（不能指到資料夾外的任何檔案）。
        try {
          path = realpathSync(path);
        } catch {
          continue;
        }
        if (!path.startsWith(root + sep)) continue;
        stat = statSync(path);
      }
      if (stat.isDirectory()) {
        if (depth < 1) this.scan(root, path, depth + 1, out);
        continue;
      }
      const media = MEDIA_TYPES[extname(name).toLowerCase()];
      if (!stat.isFile() || !media || stat.size > MEMORIES_MAX_BYTES[media.kind]) continue;
      const rel = relative(root, path);
      const id = createHash("sha256").update(`${rel}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 32);
      let meta = this.meta.get(id);
      if (!meta) {
        const raw = readMediaMeta(path, extname(name).toLowerCase(), stat.size);
        meta = { taken_at: raw.taken_at, place: raw.lat !== null && raw.lon !== null ? nearestPlace(raw.lat, raw.lon) : null };
        this.meta.set(id, meta);
      }
      out.set(id, { item: { id, kind: media.kind, url: `${MEMORIES_MEDIA_PREFIX}${id}`, ...meta }, path, type: media.type });
    }
  }
}

/** settings.memories 與 HTTP 路由用的組合（AppOptions.memories）。 */
export function memoriesFeature(settings: MemoriesSettingsStore, source: MemoriesSource) {
  return {
    view: (): MemoriesSettingsView => ({
      prefs: settings.view(),
      source: { kind: source.kind, ...source.status() },
      dwell_options: DWELL_OPTIONS_S,
      idle_options: IDLE_OPTIONS_S,
      write_path: MEMORIES_WRITE_PATH,
    }),
    update: (patch: MemoriesPrefsPatch) => settings.update(patch),
    items: () => source.items(),
    file: (id: string) => source.file(id),
  };
}

/**
 * HTTP Range（只支援單一範圍）：bytes=a-b、bytes=a-、bytes=-n。沒有 Range 時 null；格式不對或超出範圍時 "invalid"（→ 416）。
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}
