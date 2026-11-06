import { closeSync, openSync, readSync } from "node:fs";
import { WEATHER_PLACES } from "../shared/proactive.ts";
import type { MemoriesPlace } from "../shared/memories.ts";

// MEMO-1：照片與影片的拍攝時間、地點（只讀檔案自己的中繼資料，不連網、不猜）。
// 座標只在核心裡換成最近的城市名稱；座標本身不離開核心。

export interface MediaMeta {
  taken_at: number | null;
  lat: number | null;
  lon: number | null;
}

const NONE: MediaMeta = { taken_at: null, lat: null, lon: null };
export const JPEG_META_BYTES = 256 * 1024;

// ───────────── JPEG EXIF ─────────────

/** EXIF 的「YYYY:MM:DD HH:MM:SS」當本機時間。 */
export function parseExifDate(text: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const at = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(at) ? at : null;
}

/** JPEG 開頭（最多 JPEG_META_BYTES）裡 APP1 Exif 的 DateTimeOriginal（退回 DateTime）與 GPS。讀不懂就是 null。 */
export function parseJpegMeta(buf: Buffer): MediaMeta {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return NONE;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return NONE;
    const marker = buf[off + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return NONE;
    const len = buf.readUInt16BE(off + 2);
    const start = off + 4;
    if (marker === 0xe1 && start + 6 <= buf.length && buf.toString("latin1", start, start + 6) === "Exif\0\0") {
      try {
        return parseTiff(buf.subarray(start + 6, Math.min(buf.length, off + 2 + len)));
      } catch {
        return NONE;
      }
    }
    off += 2 + len;
  }
  return NONE;
}

function parseTiff(t: Buffer): MediaMeta {
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return NONE;
  const le = order === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return NONE;
  type Tag = { type: number; count: number; valueOffset: number };
  const ifd = (at: number): Map<number, Tag> => {
    const tags = new Map<number, Tag>();
    if (at + 2 > t.length) return tags;
    const n = Math.min(u16(at), 512);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      // 4 bytes 以內的值直接放在項目裡，否則是位移。
      tags.set(u16(e), { type, count, valueOffset: size * count <= 4 ? e + 8 : u32(e + 8) });
    }
    return tags;
  };
  const ascii = (tag: Tag | undefined) => (tag && tag.type === 2 && tag.valueOffset + tag.count <= t.length ? t.toString("latin1", tag.valueOffset, tag.valueOffset + tag.count).replace(/\0.*$/s, "") : null);
  const rationals = (tag: Tag | undefined): number[] | null => {
    if (!tag || tag.type !== 5 || tag.count < 3 || tag.valueOffset + 24 > t.length) return null;
    return [0, 1, 2].map((i) => {
      const den = u32(tag.valueOffset + i * 8 + 4);
      return den === 0 ? NaN : u32(tag.valueOffset + i * 8) / den;
    });
  };
  const ifd0 = ifd(u32(4));
  const exifAt = ifd0.get(0x8769);
  const exif = exifAt ? ifd(u32(exifAt.valueOffset)) : new Map<number, Tag>();
  const date = ascii(exif.get(0x9003)) ?? ascii(ifd0.get(0x0132));
  const gpsAt = ifd0.get(0x8825);
  let lat: number | null = null;
  let lon: number | null = null;
  if (gpsAt) {
    const gps = ifd(u32(gpsAt.valueOffset));
    const dms = (v: number[] | null) => (v && v.every(Number.isFinite) ? v[0]! + v[1]! / 60 + v[2]! / 3600 : null);
    const la = dms(rationals(gps.get(2)));
    const lo = dms(rationals(gps.get(4)));
    const laRef = ascii(gps.get(1));
    const loRef = ascii(gps.get(3));
    if (la !== null && lo !== null && la <= 90 && lo <= 180) {
      lat = laRef === "S" ? -la : la;
      lon = loRef === "W" ? -lo : lo;
    }
  }
  return { taken_at: date ? parseExifDate(date) : null, lat, lon };
}

// ───────────── MP4／MOV（mvhd 建立時間、選用的 ©xyz 位置） ─────────────

const MAC_EPOCH_S = 2_082_844_800;
const MAX_BOXES = 256;
const MAX_UDTA_BYTES = 64 * 1024;

type Reader = (offset: number, length: number) => Buffer;

/** 依序走過 [start, end) 的 box 標頭（每次只讀 16 bytes）。 */
function* boxes(read: Reader, start: number, end: number): Generator<{ type: string; body: number; end: number }> {
  let off = start;
  for (let i = 0; i < MAX_BOXES && off + 8 <= end; i++) {
    const head = read(off, 16);
    if (head.length < 8) return;
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header) return;
    yield { type, body: off + header, end: Math.min(end, off + size) };
    off += size;
  }
}

/** ISO 6709（「+25.0330+121.5654/」）。 */
export function parseIso6709(text: string): { lat: number; lon: number } | null {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function parseMp4Meta(read: Reader, size: number): MediaMeta {
  for (const top of boxes(read, 0, size)) {
    if (top.type !== "moov") continue;
    let taken_at: number | null = null;
    let lat: number | null = null;
    let lon: number | null = null;
    for (const child of boxes(read, top.body, top.end)) {
      if (child.type === "mvhd") {
        const b = read(child.body, 12);
        const version = b[0];
        const secs = version === 1 && b.length >= 12 ? Number(b.readBigUInt64BE(4)) : b.length >= 8 ? b.readUInt32BE(4) : 0;
        taken_at = secs > MAC_EPOCH_S ? (secs - MAC_EPOCH_S) * 1000 : null;
      } else if (child.type === "udta" && child.end - child.body <= MAX_UDTA_BYTES) {
        for (const u of boxes(read, child.body, child.end)) {
          if (u.type !== "©xyz") continue;
          const b = read(u.body, u.end - u.body);
          if (b.length < 4) continue;
          const len = b.readUInt16BE(0);
          const pos = parseIso6709(b.toString("latin1", 4, 4 + len));
          if (pos) ({ lat, lon } = pos);
        }
      }
    }
    return { taken_at, lat, lon };
  }
  return NONE;
}

/** 讀檔：JPEG 只讀開頭 JPEG_META_BYTES；MP4／MOV 只讀 box 標頭與 mvhd、udta。其他格式沒有中繼資料。 */
export function readMediaMeta(path: string, ext: string, size: number): MediaMeta {
  const jpeg = ext === ".jpg" || ext === ".jpeg";
  const mp4 = ext === ".mp4" || ext === ".m4v" || ext === ".mov";
  if (!jpeg && !mp4) return NONE;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const read: Reader = (offset, length) => {
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(n);
      const got = n > 0 ? readSync(fd!, buf, 0, n, offset) : 0;
      return buf.subarray(0, got);
    };
    return jpeg ? parseJpegMeta(read(0, JPEG_META_BYTES)) : parseMp4Meta(read, size);
  } catch {
    return NONE;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ───────────── 座標 → 城市名稱（離線、固定清單） ─────────────

export const PLACE_MATCH_KM = 25;

/** WEATHER_PLACES 加上幾個常見的地方（市府或縣治附近，取到小數兩位）。 */
export const MEMORIES_PLACES: readonly { zh: string; en: string; latitude: number; longitude: number }[] = [
  ...WEATHER_PLACES,
  { zh: "竹北", en: "Zhubei", latitude: 24.84, longitude: 121.01 },
  { zh: "苗栗", en: "Miaoli", latitude: 24.56, longitude: 120.82 },
  { zh: "彰化", en: "Changhua", latitude: 24.08, longitude: 120.54 },
  { zh: "南投", en: "Nantou", latitude: 23.91, longitude: 120.68 },
  { zh: "雲林", en: "Yunlin", latitude: 23.71, longitude: 120.54 },
  { zh: "屏東", en: "Pingtung", latitude: 22.67, longitude: 120.49 },
  { zh: "墾丁", en: "Kenting", latitude: 21.95, longitude: 120.80 },
  { zh: "澎湖", en: "Penghu", latitude: 23.57, longitude: 119.58 },
  { zh: "金門", en: "Kinmen", latitude: 24.43, longitude: 118.32 },
  { zh: "日月潭", en: "Sun Moon Lake", latitude: 23.86, longitude: 120.92 },
];

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** 最近的城市（PLACE_MATCH_KM 以內）；更遠就是 null，不猜。 */
export function nearestPlace(lat: number, lon: number): MemoriesPlace | null {
  let best: { place: MemoriesPlace; km: number } | null = null;
  for (const p of MEMORIES_PLACES) {
    const km = haversineKm(lat, lon, p.latitude, p.longitude);
    if (!best || km < best.km) best = { place: { zh: p.zh, en: p.en }, km };
  }
  return best && best.km <= PLACE_MATCH_KM ? best.place : null;
}
