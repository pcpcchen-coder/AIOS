// MEMO-1：回憶模式的核心。照片、影片都是測試裡產生的 mock 檔案（合成的最小 JPEG／MP4，不是真的相片）。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
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
import { FolderMemoriesSource, memoriesFeature, MemoriesSettingsStore, MEMORIES_RESCAN_MS, parseByteRange } from "../server/memories.ts";
import { nearestPlace, parseJpegMeta, parseMp4Meta, PLACE_MATCH_KM } from "../server/memories-meta.ts";
import type { MemoriesItem } from "../shared/memories.ts";
import type { SettingsView } from "../shared/types.ts";

// ───────────── 合成的 mock 檔案 ─────────────

/** 最小的 JPEG：APP1 Exif（big-endian TIFF）裡有 DateTimeOriginal 與 GPS（度、分、秒）。 */
function mockJpeg(date: string | null, gps: { lat: [number, number, number]; latRef: string; lon: [number, number, number]; lonRef: string } | null): Buffer {
  const t = Buffer.alloc(178);
  t.write("MM", 0, "latin1");
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number | string) => {
    t.writeUInt16BE(tag, at);
    t.writeUInt16BE(type, at + 2);
    t.writeUInt32BE(count, at + 4);
    if (typeof value === "string") t.write(value, at + 8, "latin1");
    else t.writeUInt32BE(value, at + 8);
  };
  // IFD0（8）：Exif IFD 指標、GPS IFD 指標
  t.writeUInt16BE(2, 8);
  entry(10, 0x8769, 4, 1, 38);
  entry(22, 0x8825, 4, 1, gps ? 76 : 0);
  // Exif IFD（38）：DateTimeOriginal → 56
  t.writeUInt16BE(date ? 1 : 0, 38);
  if (date) {
    entry(40, 0x9003, 2, 20, 56);
    t.write(`${date}\0`, 56, "latin1");
  }
  // GPS IFD（76）：緯度 → 130、經度 → 154
  if (gps) {
    t.writeUInt16BE(4, 76);
    entry(78, 1, 2, 2, `${gps.latRef}\0`);
    entry(90, 2, 5, 3, 130);
    entry(102, 3, 2, 2, `${gps.lonRef}\0`);
    entry(114, 4, 5, 3, 154);
    const rationals = (at: number, [d, m, s]: [number, number, number]) => {
      for (const [i, v] of [d, m, s].entries()) {
        t.writeUInt32BE(Math.round(v * 100), at + i * 8);
        t.writeUInt32BE(100, at + i * 8 + 4);
      }
    };
    rationals(130, gps.lat);
    rationals(154, gps.lon);
  }
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from("Exif\0\0", "latin1"), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

const box = (type: string, ...body: Buffer[]) => {
  const payload = Buffer.concat(body);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};

/** 最小的 MP4：ftyp + moov（mvhd 建立時間、udta ©xyz 位置）+ mdat。 */
function mockMp4(createdUtcMs: number, xyz: string | null): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(createdUtcMs === 0 ? 0 : createdUtcMs / 1000 + 2_082_844_800, 4);
  const udta = xyz === null ? [] : [box("udta", box("©xyz", (() => {
    const b = Buffer.alloc(4 + xyz.length);
    b.writeUInt16BE(xyz.length, 0);
    b.write(xyz, 4, "latin1");
    return b;
  })()))];
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0", "latin1")), box("moov", box("mvhd", mvhd), ...udta), box("mdat", Buffer.alloc(64, 7))]);
}

const HSINCHU_GPS = { lat: [24, 48, 36] as [number, number, number], latRef: "N", lon: [120, 58, 12] as [number, number, number], lonRef: "E" };

describe("metadata parsers (mock files)", () => {
  it("JPEG: DateTimeOriginal as local time and GPS to decimal degrees", () => {
    const meta = parseJpegMeta(mockJpeg("2023:11:06 10:30:00", HSINCHU_GPS));
    expect(meta.taken_at).toBe(new Date(2023, 10, 6, 10, 30, 0).getTime());
    expect(meta.lat).toBeCloseTo(24.81, 4);
    expect(meta.lon).toBeCloseTo(120.97, 4);
    const south = parseJpegMeta(mockJpeg(null, { ...HSINCHU_GPS, latRef: "S", lonRef: "W" }));
    expect(south).toMatchObject({ taken_at: null });
    expect(south.lat).toBeCloseTo(-24.81, 4);
    expect(south.lon).toBeCloseTo(-120.97, 4);
  });

  it("JPEG without Exif or not a JPEG: nothing", () => {
    expect(parseJpegMeta(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toEqual({ taken_at: null, lat: null, lon: null });
    expect(parseJpegMeta(Buffer.from("not a jpeg"))).toEqual({ taken_at: null, lat: null, lon: null });
  });

  it("MP4: mvhd creation_time (1904 epoch) and ©xyz; 0 means unknown", () => {
    const created = Date.UTC(2024, 0, 2, 3, 4, 5);
    const file = mockMp4(created, "+25.0330+121.5654/");
    const read = (o: number, n: number) => file.subarray(o, o + n);
    const meta = parseMp4Meta(read, file.length);
    expect(meta.taken_at).toBe(created);
    expect(meta.lat).toBeCloseTo(25.033, 4);
    expect(meta.lon).toBeCloseTo(121.5654, 4);
    const zero = mockMp4(0, null);
    expect(parseMp4Meta((o, n) => zero.subarray(o, o + n), zero.length)).toEqual({ taken_at: null, lat: null, lon: null });
  });

  it("nearest city within 25 km, otherwise null", () => {
    expect(PLACE_MATCH_KM).toBe(25);
    expect(nearestPlace(24.81, 120.97)).toEqual({ zh: "新竹", en: "Hsinchu" });
    expect(nearestPlace(25.13, 121.56)).toEqual({ zh: "台北", en: "Taipei" }); // 約 10 km 北
    expect(nearestPlace(24.43, 118.32 + 0.2)).toEqual({ zh: "金門", en: "Kinmen" }); // 約 20 km
    expect(nearestPlace(24.43, 118.32 + 0.27)).toBeNull(); // 約 27 km
    expect(nearestPlace(35.68, 139.69)).toBeNull(); // 東京：清單上沒有
  });

  it("parseByteRange: a-b, a-, -n; bad or out of range is invalid", () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    for (const bad of ["bytes=100-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) expect(parseByteRange(bad, 100)).toBe("invalid");
  });
});

// ───────────── 資料夾來源與 HTTP ─────────────

let root: string;
const servers: Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-memories-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  rmSync(root, { recursive: true, force: true });
});

function fillLibrary(): string {
  const lib = join(root, "library");
  mkdirSync(join(lib, "2023"), { recursive: true });
  writeFileSync(join(lib, "a.jpg"), mockJpeg("2023:11:06 10:30:00", HSINCHU_GPS));
  writeFileSync(join(lib, "2023", "b.PNG"), Buffer.from("mock png bytes"));
  writeFileSync(join(lib, "c.mp4"), mockMp4(Date.UTC(2024, 0, 2), "+35.6800+139.6900/"));
  writeFileSync(join(lib, ".hidden.jpg"), Buffer.from("hidden"));
  writeFileSync(join(lib, "notes.txt"), "not media");
  writeFileSync(join(root, "secret.jpg"), Buffer.from("outside the library"));
  symlinkSync(join(root, "secret.jpg"), join(lib, "escape.jpg"));
  return lib;
}

async function start(withMemories: boolean, lib = join(root, "library")) {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir: root, preferred: "mock", onChange: () => {} });
  const memories = withMemories ? memoriesFeature(new MemoriesSettingsStore({ dir: join(root, "config"), onChange: () => {} }), new FolderMemoriesSource({ dir: lib })) : undefined;
  const app = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: null, ...(memories ? { memories } : {}) });
  servers.push(app);
  await new Promise<void>((r) => app.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = (path: string, body: unknown, locale = "zh-TW") => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Nous-Locale": locale }, body: JSON.stringify(body) });
  return { base, post };
}

describe("folder source", () => {
  it("lists photos and videos one level deep; skips hidden, non-media and links escaping the folder", () => {
    const lib = fillLibrary();
    const source = new FolderMemoriesSource({ dir: lib });
    const items = source.items();
    expect(items.map((i) => i.kind).sort()).toEqual(["photo", "photo", "video"]);
    expect(source.status()).toEqual({ state: "ok", photos: 2, videos: 1 });
    for (const item of items) {
      expect(item.id).toMatch(/^[a-f0-9]{32}$/);
      expect(item.url).toBe(`/api/memories/media/${item.id}`);
    }
    expect(items.map((i) => source.file(i.id)?.path)).not.toContain(join(root, "secret.jpg"));
  });

  it("metadata: time and nearest city name only (Tokyo is not in the table → no place)", () => {
    const source = new FolderMemoriesSource({ dir: fillLibrary() });
    const byType = Object.fromEntries(source.items().map((i) => [source.file(i.id)!.type, i])) as Record<string, MemoriesItem>;
    expect(byType["image/jpeg"]).toMatchObject({ taken_at: new Date(2023, 10, 6, 10, 30).getTime(), place: { zh: "新竹", en: "Hsinchu" } });
    expect(byType["image/png"]).toMatchObject({ taken_at: null, place: null });
    expect(byType["video/mp4"]).toMatchObject({ taken_at: Date.UTC(2024, 0, 2), place: null });
  });

  it("missing folder, empty folder (created on request), and lazy rescan at most once a minute", () => {
    let now = 0;
    const lib = join(root, "lib2");
    expect(new FolderMemoriesSource({ dir: lib }).status().state).toBe("missing");
    const source = new FolderMemoriesSource({ dir: lib, create: true, now: () => now });
    expect(source.status()).toEqual({ state: "empty", photos: 0, videos: 0 });
    writeFileSync(join(lib, "new.webp"), Buffer.from("mock"));
    expect(source.items()).toEqual([]);
    now += MEMORIES_RESCAN_MS;
    expect(source.items()).toHaveLength(1);
  });

  it("a file whose content changes gets a new id", () => {
    const lib = fillLibrary();
    const before = new FolderMemoriesSource({ dir: lib }).items().map((i) => i.id).sort();
    utimesSync(join(lib, "a.jpg"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const after = new FolderMemoriesSource({ dir: lib }).items().map((i) => i.id).sort();
    expect(after).not.toEqual(before);
  });
});

describe("HTTP", () => {
  it("settings.memories, POST saves to memories.json and refuses bad values with 400 (English too)", async () => {
    fillLibrary();
    const { base, post } = await start(true);
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(view.memories).toEqual({ prefs: { enabled: false, dwell_s: 8, idle_s: 60, video_sound: false }, source: { kind: "folder", state: "ok", photos: 2, videos: 1 }, dwell_options: [5, 8, 12, 20], idle_options: [30, 60, 180, 300], write_path: "/api/settings/memories" });
    const saved = await post("/api/settings/memories", { enabled: true, dwell_s: 12 });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SettingsView).memories?.prefs).toEqual({ enabled: true, dwell_s: 12, idle_s: 60, video_sound: false });
    expect(JSON.parse(readFileSync(join(root, "config", "memories.json"), "utf8"))).toEqual({ schema_version: 1, prefs: { enabled: true, dwell_s: 12 } });
    for (const bad of [{ dwell_s: 9 }, { idle_s: "60" }, { dir: "/etc" }]) expect((await post("/api/settings/memories", bad)).status).toBe(400);
    expect(((await (await post("/api/settings/memories", { idle_s: 61 }, "en")).json()) as { error: string }).error).toBe("idle_s must be one of 30、60、180、300");
  });

  it("items carry no paths, file names or coordinates", async () => {
    fillLibrary();
    const { base } = await start(true);
    const body = await (await fetch(`${base}/api/memories/items`)).text();
    const { items } = JSON.parse(body) as { items: MemoriesItem[] };
    expect(items).toHaveLength(3);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(["id", "kind", "place", "taken_at", "url"]);
    expect(body).not.toMatch(/library|a\.jpg|c\.mp4|24\.81|120\.97|35\.68|139\.69|lat|lon/);
  });

  it("media: bytes with the right type, HEAD, single Range 206, bad range 416, unknown or malformed id 404", async () => {
    const lib = fillLibrary();
    const { base } = await start(true);
    const { items } = (await (await fetch(`${base}/api/memories/items`)).json()) as { items: MemoriesItem[] };
    const video = items.find((i) => i.kind === "video")!;
    const bytes = readFileSync(join(lib, "c.mp4"));
    const full = await fetch(base + video.url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);
    const head = await fetch(base + video.url, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const part = await fetch(base + video.url, { headers: { Range: "bytes=4-11" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(4, 12))).toBe(true);
    expect((await fetch(base + video.url, { headers: { Range: `bytes=${bytes.length}-` } })).status).toBe(416);
    for (const path of ["/api/memories/media/" + "0".repeat(32), "/api/memories/media/..%2F..%2Fsecret.jpg", "/api/memories/media/escape.jpg", "/api/memories/media/"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(root);
    }
  });

  it("without the memories option: no settings key and every route 404", async () => {
    fillLibrary();
    const { base, post } = await start(false);
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect("memories" in view).toBe(false);
    expect((await post("/api/settings/memories", { enabled: true })).status).toBe(404);
    expect((await fetch(`${base}/api/memories/items`)).status).toBe(404);
    expect((await fetch(`${base}/api/memories/media/${"a".repeat(32)}`)).status).toBe(404);
  });
});
