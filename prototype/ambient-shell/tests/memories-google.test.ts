// MEMO-2：Google 相簿（Picker API，經 gog）。gog 是測試裡的假執行器（mock）：回應形狀照 gogcli 的 JSON 輸出，
// 下載的「照片」「影片」是合成的最小 JPEG／MP4 開頭（mock 檔案，不是真的相片），時鐘與等待也是假的。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { parseMemoriesGoogle } from "../server/config.ts";
import { FolderMemoriesSource, memoriesFeature, MemoriesSettingsStore } from "../server/memories.ts";
import { GOOGLE_POLL_MAX_MS, GOOGLE_POLL_MIN_MS, googleMemories, GooglePhotosCache, GooglePicker, MEMORIES_GOOGLE_MAX_PICK, sipsConverter } from "../server/memories-google.ts";
import type { GogRunner } from "../server/integrations/gog/runner.ts";
import { MEMORIES_GOOGLE_REASON, type MemoriesItem } from "../shared/memories.ts";
import type { SettingsView } from "../shared/types.ts";

const GOG = "/opt/homebrew/bin/gog";
const ACCOUNT = "george@example.com";
const URI = "https://photos.google.com/picker/mock-session";
const JPEG = (n = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]);
const MP4 = (n = 64) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(n)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(32)]);

type Item = { id: string; type: "PHOTO" | "VIDEO"; createTime: string; status?: string; body?: Buffer; fail?: boolean };
const photo = (id: string, createTime = "2023-11-06T02:30:00Z", body = JPEG()): Item => ({ id, type: "PHOTO", createTime, body });
const video = (id: string, status = "READY"): Item => ({ id, type: "VIDEO", createTime: "2024-01-02T00:00:00Z", status, body: MP4() });

let root: string;
const servers: Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-memories-google-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  rmSync(root, { recursive: true, force: true });
});

/** 假的 gog：依子命令回應；記下每一次的參數與收到的 AbortSignal。 */
function fakeGog(opts: { items?: Item[]; pollsUntilSet?: number; createCode?: number; pollInterval?: string; timeoutIn?: string; expireTime?: string; onCall?(args: string[], signal: AbortSignal): Promise<void> | void } = {}) {
  const calls: { file: string; args: string[]; signal: AbortSignal; maxStdout?: number }[] = [];
  let polls = 0;
  const session = (set: boolean) => JSON.stringify({ session: { id: "sess_1", pickerUri: URI, expireTime: opts.expireTime ?? "2099-01-01T00:00:00Z", pollingConfig: { pollInterval: opts.pollInterval ?? "5s", timeoutIn: opts.timeoutIn ?? "1800s" }, mediaItemsSet: set } });
  const runner: GogRunner = async (file, args, { signal, maxStdout }) => {
    calls.push({ file, args, signal, ...(maxStdout ? { maxStdout } : {}) });
    await opts.onCall?.(args, signal);
    if (signal.aborted) throw new Error("aborted");
    const [, , cmd] = args;
    if (cmd === "create") return { code: opts.createCode ?? 0, stdout: opts.createCode ? "" : session(false) };
    if (cmd === "get") return { code: 0, stdout: session(++polls >= (opts.pollsUntilSet ?? 2)) };
    if (cmd === "list") {
      const mediaItems = (opts.items ?? []).map((i) => ({ id: i.id, createTime: i.createTime, type: i.type, mediaFile: { mimeType: i.type === "PHOTO" ? "image/jpeg" : "video/mp4", filename: `${i.id}.x`, mediaFileMetadata: { width: 1, height: 1, ...(i.type === "VIDEO" ? { videoMetadata: { processingStatus: i.status } } : {}) } } }));
      return { code: 0, stdout: JSON.stringify({ sessionId: "sess_1", mediaItems, mediaItemCount: mediaItems.length, nextPageToken: "" }) };
    }
    if (cmd === "download") {
      const item = (opts.items ?? []).find((i) => i.id === args[4]);
      const out = args.find((a) => a.startsWith("--out="))!.slice(6);
      if (!item || item.fail) return { code: 1, stdout: "" };
      writeFileSync(out, item.body!);
      return { code: 0, stdout: "" };
    }
    if (cmd === "delete") return { code: 0, stdout: "" };
    return { code: 2, stdout: "" };
  };
  return { runner, calls, commands: () => calls.map((c) => c.args[2]) };
}

function clock(start = Date.UTC(2026, 10, 6)) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => void (now += ms),
    sleeps,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("aborted");
      sleeps.push(ms);
      now += ms;
    },
  };
}

function setup(gog: ReturnType<typeof fakeGog>, c = clock(), capBytes?: number) {
  const cache = new GooglePhotosCache({ dir: join(root, "google"), ...(capBytes ? { capBytes } : {}) });
  let changes = 0;
  const picker = new GooglePicker({ gogPath: GOG, account: ACCOUNT, runner: gog.runner, cache, now: c.now, sleep: c.sleep, onChange: () => void changes++ });
  return { cache, picker, google: googleMemories(cache, picker), changes: () => changes };
}

describe("picker job", () => {
  it("happy path: create → two polls → list → downloads → delete → done; items carry the time and no place", async () => {
    const gog = fakeGog({ items: [photo("p1"), photo("p2", "2020-05-01T00:00:00Z"), video("v1")] });
    const { picker, google, changes } = setup(gog);
    const job = picker.pick()!;
    await job.ready;
    expect(google.view()).toMatchObject({ available: true, phase: "waiting_pick", picker_uri: URI });
    await job.done;
    expect(gog.commands()).toEqual(["create", "get", "get", "list", "download", "download", "download", "delete"]);
    expect(google.view()).toMatchObject({ phase: "done", picker_uri: null, expires_at: null, progress: { done: 3, total: 3, skipped: 0 }, error: null, photos: 2, videos: 1, cap_bytes: 2 * 1024 ** 3 });
    expect(google.view().bytes).toBe(2 * JPEG().length + MP4().length);
    expect(changes()).toBeGreaterThan(5);
    const items = google.items();
    expect(items.map((i) => [i.kind, i.taken_at, i.place])).toEqual([
      ["photo", Date.UTC(2023, 10, 6, 2, 30), null],
      ["photo", Date.UTC(2020, 4, 1), null],
      ["video", Date.UTC(2024, 0, 2), null],
    ]);
    for (const item of items) {
      expect(item.id).toMatch(/^[a-f0-9]{32}$/);
      expect(readFileSync(google.file(item.id)!.path).subarray(0, 3)).toEqual(item.kind === "photo" ? JPEG().subarray(0, 3) : MP4().subarray(0, 3));
    }
    expect(google.file(items[2]!.id)!.type).toBe("video/mp4");
  });

  it("exact gog args: no shell, --account= on every call, --json, --max-items=300, list with 4 MB stdout", async () => {
    const gog = fakeGog({ items: [photo("p1")] });
    await setup(gog).picker.pick()!.done;
    expect(MEMORIES_GOOGLE_MAX_PICK).toBe(300);
    expect(gog.calls.every((c) => c.file === GOG)).toBe(true);
    const out = gog.calls[4]!.args.find((a) => a.startsWith("--out="))!;
    expect(gog.calls.map((c) => c.args)).toEqual([
      ["photos", "picker", "create", "--max-items=300", "--json", `--account=${ACCOUNT}`],
      ["photos", "picker", "get", "sess_1", "--json", `--account=${ACCOUNT}`],
      ["photos", "picker", "get", "sess_1", "--json", `--account=${ACCOUNT}`],
      ["photos", "picker", "list", "sess_1", "--all", "--max=100", "--json", `--account=${ACCOUNT}`],
      ["photos", "picker", "download", "sess_1", "p1", out, "--overwrite", `--account=${ACCOUNT}`],
      ["photos", "picker", "delete", "sess_1", `--account=${ACCOUNT}`],
    ]);
    expect(out).toMatch(new RegExp(`^--out=${join(root, "google")}/[a-f0-9]{32}\\.part$`));
    expect(gog.calls[3]!.maxStdout).toBeGreaterThanOrEqual(4 * 1024 ** 2);
  });

  it("poll interval is clamped to 3–30 s", async () => {
    for (const [interval, expected] of [["1s", GOOGLE_POLL_MIN_MS], ["0.5s", GOOGLE_POLL_MIN_MS], ["7s", 7_000], ["120s", GOOGLE_POLL_MAX_MS]] as const) {
      const c = clock();
      await setup(fakeGog({ pollInterval: interval }), c).picker.pick()!.done;
      expect(c.sleeps).toEqual([expected, expected]);
    }
  });

  it("deadline (min of timeoutIn and expireTime) → failed 「挑選逾時」, session still deleted", async () => {
    const c = clock();
    const gog = fakeGog({ pollsUntilSet: 1_000, timeoutIn: "1800s", expireTime: new Date(c.now() + 60_000).toISOString() });
    const { picker, google } = setup(gog, c);
    const startedAt = c.now();
    const job = picker.pick()!;
    await job.ready;
    expect(google.view().expires_at).toBe(startedAt + 60_000);
    await job.done;
    expect(google.view()).toMatchObject({ phase: "failed", error: "挑選逾時" });
    expect(gog.commands().filter((x) => x === "get")).toHaveLength(12);
    expect(gog.commands().at(-1)).toBe("delete");
  });

  it("create exits non-zero → failed with the (possibly) not-authorized hint; no session to delete", async () => {
    const gog = fakeGog({ createCode: 1 });
    const { picker, google } = setup(gog);
    await picker.pick()!.done;
    expect(google.view()).toMatchObject({ phase: "failed", error: MEMORIES_GOOGLE_REASON.auth, picker_uri: null });
    expect(MEMORIES_GOOGLE_REASON.auth).toContain("可能尚未授權");
    expect(MEMORIES_GOOGLE_REASON.auth).toContain("gog auth add");
    expect(gog.commands()).toEqual(["create"]);
  });

  it("a video not READY, a failed download, an unsupported format (HEIC) count as skipped", async () => {
    const gog = fakeGog({ items: [photo("ok"), video("proc", "PROCESSING"), { ...photo("broken"), fail: true }, photo("heic", undefined, HEIC)] });
    const { picker, google } = setup(gog);
    await picker.pick()!.done;
    expect(google.view()).toMatchObject({ phase: "done", progress: { done: 4, total: 4, skipped: 3 }, photos: 1, videos: 0 });
    expect(gog.calls.filter((c) => c.args[2] === "download").map((c) => c.args[4])).toEqual(["ok", "broken", "heic"]);
    expect(readdirSync(join(root, "google")).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("with a photo converter (Mac sips), a HEIC photo becomes a JPEG and is kept; videos are not converted", async () => {
    const gog = fakeGog({ items: [photo("heic", undefined, HEIC), video("v1")] });
    const converted: string[] = [];
    const cache = new GooglePhotosCache({ dir: join(root, "google") });
    const c = clock();
    const picker = new GooglePicker({
      gogPath: GOG, account: ACCOUNT, runner: gog.runner, cache, now: c.now, sleep: c.sleep, onChange: () => undefined,
      convertPhoto: async (input, output) => {
        converted.push(input);
        writeFileSync(output, JPEG());
        return true;
      },
    });
    await picker.pick()!.done;
    expect(googleMemories(cache, picker).view()).toMatchObject({ phase: "done", photos: 1, videos: 1, progress: { skipped: 0 } });
    expect(converted).toHaveLength(1);
    expect(readdirSync(join(root, "google")).filter((f) => f.endsWith(".jpg"))).toHaveLength(1);
  });

  it("sipsConverter runs /usr/bin/sips without a shell: JPEG, quality 85, long side 2048", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const ok = await sipsConverter(async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: "" };
    })("/in.part", "/in.part.jpg", new AbortController().signal);
    expect(ok).toBe(true);
    expect(calls).toEqual([{ file: "/usr/bin/sips", args: ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "2048", "/in.part", "--out", "/in.part.jpg"] }]);
    expect(await sipsConverter(async () => ({ code: 1, stdout: "" }))("/a", "/b", new AbortController().signal)).toBe(false);
  });

  it("cancel mid-poll: the abort reaches the runner, the session is deleted, phase cancelled", async () => {
    let picker!: GooglePicker;
    const gog = fakeGog({ pollsUntilSet: 1_000, onCall: (args) => void (args[2] === "get" && picker.cancel()) });
    ({ picker } = setup(gog));
    const job = picker.pick()!;
    await job.done;
    const get = gog.calls.find((c) => c.args[2] === "get")!;
    expect(get.signal.aborted).toBe(true);
    expect(picker.state()).toEqual({ phase: "cancelled", progress: null });
    expect(gog.commands()).toEqual(["create", "get", "delete"]);
    expect(gog.calls.at(-1)!.signal.aborted).toBe(false);
    expect(picker.busy()).toBe(false);
  });

  it("cancel mid-download keeps what was downloaded, stops the rest", async () => {
    let picker!: GooglePicker;
    let downloads = 0;
    const gog = fakeGog({ items: [photo("a"), photo("b"), photo("c")], onCall: (args) => void (args[2] === "download" && ++downloads === 2 && picker.cancel()) });
    const s = setup(gog);
    picker = s.picker;
    await picker.pick()!.done;
    expect(picker.state()).toEqual({ phase: "cancelled", progress: { done: 1, total: 3, skipped: 0 } });
    expect(gog.commands()).toEqual(["create", "get", "get", "list", "download", "download", "delete"]);
    expect(gog.calls[5]!.signal.aborted).toBe(true);
    expect(s.google.view()).toMatchObject({ phase: "cancelled", photos: 1, progress: { done: 1, total: 3, skipped: 0 } });
  });

  it("a second pick while busy is rejected", async () => {
    const { picker, google } = setup(fakeGog());
    const first = picker.pick()!;
    expect(picker.pick()).toBeNull();
    expect(await google.pick()).toBe("busy");
    await first.done;
    expect(picker.pick()).not.toBeNull();
  });

  it("re-pick dedupes: already cached items are not downloaded again", async () => {
    const gog = fakeGog({ items: [photo("p1"), photo("p2")] });
    const { picker, google } = setup(gog);
    await picker.pick()!.done;
    await picker.pick()!.done;
    expect(gog.commands().filter((x) => x === "download")).toHaveLength(2);
    expect(google.view()).toMatchObject({ photos: 2, progress: { done: 2, total: 2, skipped: 0 } });
  });
});

describe("cache", () => {
  it("over the cap evicts the oldest pick, never the one just added", async () => {
    const c = clock();
    const big = (id: string) => photo(id, undefined, JPEG(1000));
    const { cache, picker } = setup(fakeGog({ items: [big("a"), big("b"), big("c")], onCall: () => c.advance(1) }), c, 2_100);
    await picker.pick()!.done;
    expect(cache.counts()).toEqual({ photos: 2, videos: 0, bytes: 2 * 1004 });
    const kept = (JSON.parse(readFileSync(join(root, "google", "index.json"), "utf8")) as { items: { media_id_hash: string }[] }).items.map((i) => i.media_id_hash);
    expect(kept).toEqual(["b", "c"].map(GooglePhotosCache.hashMediaId));
    expect(readdirSync(join(root, "google")).filter((f) => f !== "index.json")).toHaveLength(2);
    // 一項就超過上限：仍保留剛加入的那一項。
    const tiny = setup(fakeGog({ items: [big("z")] }), clock(), 10);
    tiny.cache.clear();
    await tiny.picker.pick()!.done;
    expect(tiny.cache.counts().photos).toBe(1);
  });

  it("clear removes every file and the index; the job is cancelled first", async () => {
    let s!: ReturnType<typeof setup>;
    const gog = fakeGog({ items: [photo("a")], pollsUntilSet: 1_000, onCall: (args) => void (args[2] === "get" && s.google.clear()) });
    s = setup(fakeGog({ items: [photo("a")] }));
    await s.picker.pick()!.done;
    expect(s.google.view().photos).toBe(1);
    s = setup(gog);
    const job = s.picker.pick()!;
    await job.done;
    expect(s.picker.state().phase).toBe("cancelled");
    expect(s.google.view()).toMatchObject({ photos: 0, videos: 0, bytes: 0 });
    expect(readdirSync(join(root, "google"))).toEqual([]);
  });

  it("a corrupt index starts empty and logs once without content", () => {
    mkdirSync(join(root, "google"), { recursive: true });
    writeFileSync(join(root, "google", "index.json"), "{ not json SECRET");
    const logs: string[] = [];
    const cache = new GooglePhotosCache({ dir: join(root, "google"), log: (m) => logs.push(m) });
    expect(cache.items()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("SECRET");
    // 指到資料夾外的檔名不收。
    writeFileSync(join(root, "google", "index.json"), JSON.stringify({ version: 1, items: [{ media_id_hash: "a".repeat(64), file: "../../etc/passwd", kind: "photo", mime: "image/jpeg", taken_at: null, picked_at: 1, bytes: 1 }] }));
    expect(new GooglePhotosCache({ dir: join(root, "google") }).items()).toEqual([]);
  });

  it("the index keeps only hashes (no raw Google ids, picker URI or account); a restart reads it back", async () => {
    const { cache, picker } = setup(fakeGog({ items: [photo("RAW_GOOGLE_ID_123")] }));
    await picker.pick()!.done;
    const index = readFileSync(join(root, "google", "index.json"), "utf8");
    expect(index).not.toMatch(/RAW_GOOGLE_ID_123|photos\.google|sess_1|example\.com/);
    expect(JSON.parse(index)).toMatchObject({ version: 1, items: [{ media_id_hash: GooglePhotosCache.hashMediaId("RAW_GOOGLE_ID_123"), kind: "photo", mime: "image/jpeg" }] });
    expect(new GooglePhotosCache({ dir: join(root, "google") }).items()).toEqual(cache.items());
  });

  it("ids never collide with folder ids for the same files", async () => {
    const lib = join(root, "library");
    mkdirSync(lib);
    writeFileSync(join(lib, "a.jpg"), JPEG());
    const { google, picker } = setup(fakeGog({ items: [photo("a_jpg")] }));
    await picker.pick()!.done;
    const folder = new FolderMemoriesSource({ dir: lib });
    const all = [...folder.items(), ...google.items()].map((i) => i.id);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(2);
  });
});

describe("config", () => {
  it("gog path and account come from the same env as CAL-1; bad values make it unavailable instead of failing startup", () => {
    expect(parseMemoriesGoogle(undefined, undefined, undefined)).toEqual({ gogPath: null, account: null, invalid: null });
    expect(parseMemoriesGoogle("/usr/local/bin/gog", undefined, ACCOUNT)).toEqual({ gogPath: "/usr/local/bin/gog", account: ACCOUNT, invalid: null });
    expect(parseMemoriesGoogle("gog", ACCOUNT, undefined).invalid).toBe("NOUS_GOG_PATH 必須是絕對路徑");
    expect(parseMemoriesGoogle(undefined, "not-an-email", undefined).invalid).toBe("NOUS_GOG_ACCOUNT 必須是一個 email 地址");
  });
});

// ───────────── HTTP ─────────────

async function start(google: "none" | "unavailable" | ReturnType<typeof fakeGog>) {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir: root, preferred: "mock", onChange: () => {} });
  const lib = join(root, "library");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "folder.jpg"), JPEG());
  const cache = new GooglePhotosCache({ dir: join(root, "google") });
  const c = clock();
  let picker: GooglePicker | null = null;
  const part = google === "none" ? undefined
    : google === "unavailable" ? googleMemories(cache, { unavailable: MEMORIES_GOOGLE_REASON.noGog })
    : googleMemories(cache, (picker = new GooglePicker({ gogPath: GOG, account: ACCOUNT, runner: google.runner, cache, now: c.now, sleep: c.sleep, onChange: () => {} })));
  const memories = memoriesFeature(new MemoriesSettingsStore({ dir: join(root, "config"), onChange: () => {} }), new FolderMemoriesSource({ dir: lib }), part);
  const app = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: null, memories });
  servers.push(app);
  await new Promise<void>((r) => app.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = (path: string, locale = "zh-TW") => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Nous-Locale": locale }, body: "{}" });
  return { base, post, picker: () => picker! };
}

describe("HTTP", () => {
  it("not wired: no google key and every route 404", async () => {
    const { base, post } = await start("none");
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(view.memories && "google" in view.memories).toBe(false);
    for (const path of ["pick", "cancel", "clear"]) expect((await post(`/api/memories/google/${path}`)).status).toBe(404);
    expect((await fetch(`${base}/api/memories/google/qr.svg`)).status).toBe(404);
  });

  it("unavailable: the view says why and pick is 409 (English too)", async () => {
    const { base, post } = await start("unavailable");
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(view.memories?.google).toMatchObject({ available: false, unavailable_reason: "Mac 上找不到 gog", phase: "idle", paths: { pick: "/api/memories/google/pick", qr: "/api/memories/google/qr.svg" } });
    const res = await post("/api/memories/google/pick", "en");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("gog was not found on the Mac");
  });

  it("pick returns settings with the picker URI; qr.svg while waiting; busy 409; cancel; settings carry no account", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gog = fakeGog({ items: [photo("p1")], onCall: (args) => (args[2] === "get" ? gate : undefined) });
    const { base, post, picker } = await start(gog);
    expect((await fetch(`${base}/api/memories/google/qr.svg`)).status).toBe(404);
    const picked = await post("/api/memories/google/pick");
    expect(picked.status).toBe(200);
    const body = await picked.text();
    expect((JSON.parse(body) as SettingsView).memories?.google).toMatchObject({ phase: "waiting_pick", picker_uri: URI });
    expect(body).not.toContain(ACCOUNT);
    const qr = await fetch(`${base}/api/memories/google/qr.svg`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
    expect(qr.headers.get("cache-control")).toBe("no-store");
    expect(await qr.text()).toMatch(/^<svg[^>]*>.*<\/svg>$/s);
    expect((await post("/api/memories/google/pick")).status).toBe(409);
    const cancelled = (await (await post("/api/memories/google/cancel")).json()) as SettingsView;
    expect(cancelled.memories?.google?.phase).toBe("cancelled");
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(picker().busy()).toBe(false);
    expect(gog.commands().at(-1)).toBe("delete");
  });

  it("combined items list and media; clear empties the Google part only", async () => {
    const { base, post, picker } = await start(fakeGog({ items: [photo("p1")] }));
    await picker().pick()!.done;
    const { items } = (await (await fetch(`${base}/api/memories/items`)).json()) as { items: MemoriesItem[] };
    expect(items).toHaveLength(2);
    const fromGoogle = items.find((i) => i.taken_at === Date.UTC(2023, 10, 6, 2, 30))!;
    const media = await fetch(base + fromGoogle.url);
    expect(media.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await media.arrayBuffer()).equals(JPEG())).toBe(true);
    const cleared = (await (await post("/api/memories/google/clear")).json()) as SettingsView;
    expect(cleared.memories?.google).toMatchObject({ photos: 0, videos: 0, bytes: 0 });
    expect(((await (await fetch(`${base}/api/memories/items`)).json()) as { items: MemoriesItem[] }).items).toHaveLength(1);
    expect((await fetch(base + fromGoogle.url)).status).toBe(404);
    expect(existsSync(join(root, "library", "folder.jpg"))).toBe(true);
  });
});
