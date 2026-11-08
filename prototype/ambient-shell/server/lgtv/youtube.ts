// LGTV-2：YouTube 影片目標與官方搜尋（YouTube Data API v3 search.list）。
// - 解析與 TV 網址移植自 LGTVG3 youtube.py；`contentTarget: https://www.youtube.com/tv?v=<ID>` 已由 LGTVG3 在 OLED65G3PSA 實機驗證可直接播放。
// - 搜尋只用官方 API（George 2026-11-08 決定）；不解析 youtube.com 搜尋頁、不用 yt-dlp（YouTube 服務條款禁止 scraper）。
// - API key 只來自核心設定（NOUS_YOUTUBE_API_KEY）：不進 log、不放進錯誤訊息、不交給模型或頁面。
// - search.list 的配額：官方配額頁（2026-11-07 查核）寫 search.list 有自己的配額，每天約 100 次；相同的搜尋 1 小時內用快取。

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const PATH_ID = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/;

export interface YouTubeTarget {
  videoId: string | null;
  playlistId: string | null;
  startSeconds: number | null;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{1,6}$/.test(value)) return Number(value);
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/.exec(value);
  if (!m || !m.slice(1).some(Boolean)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** 影片 ID 或各種 YouTube 網址；不是 YouTube 的目標回 null。 */
export function parseYouTube(text: string): YouTubeTarget | null {
  let t = text.trim();
  if (VIDEO_ID.test(t)) return { videoId: t, playlistId: null, startSeconds: null };
  if (!t.includes("://") && /(^|\.)youtube\.com|youtu\.be/i.test(t)) t = `https://${t}`;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be")) return null;
  let videoId: string | null = null;
  if (host === "youtu.be") {
    const c = url.pathname.slice(1).split("/")[0] ?? "";
    videoId = VIDEO_ID.test(c) ? c : null;
  } else {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) videoId = v;
    else videoId = PATH_ID.exec(url.pathname)?.[1] ?? null;
  }
  const list = url.searchParams.get("list");
  const playlistId = list && PLAYLIST_ID.test(list) ? list : null;
  if (!videoId && !playlistId) return null;
  return { videoId, playlistId, startSeconds: parseTime(url.searchParams.get("t") ?? url.searchParams.get("start")) };
}

/** YouTube TV（leanback）可接受的網址。只由驗證過的 ID 組成。 */
export function tvUrl(target: YouTubeTarget): string {
  const parts: string[] = [];
  if (target.videoId) parts.push(`v=${target.videoId}`);
  if (target.playlistId) parts.push(`list=${target.playlistId}`);
  if (target.startSeconds) parts.push(`t=${target.startSeconds}`);
  return `https://www.youtube.com/tv?${parts.join("&")}`;
}

export interface VideoResult {
  video_id: string;
  title: string;
  channel: string;
  live: boolean;
}

export class YouTubeSearchError extends Error {
  constructor(
    message: string,
    readonly kind: "no_key" | "quota" | "denied" | "network" | "bad_reply",
  ) {
    super(message);
  }
}

export interface YouTubeSearchOptions {
  apiKey: string;
  fetch?: typeof fetch;
  regionCode?: string;
  relevanceLanguage?: string;
  now?: () => number;
  timeoutMs?: number;
}

const CACHE_MS = 60 * 60_000;
const INVISIBLE = /[​-‏⁠﻿‪-‮⁦-⁩]/g;

/** 標題與頻道只是資料：去掉控制與雙向覆寫字元、截長度。 */
function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** HTML 實體（API 的 snippet.title 會帶 &amp;、&#39; 等）。 */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _);
}

export class YouTubeSearch {
  private readonly cache = new Map<string, { at: number; results: VideoResult[] }>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: YouTubeSearchOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** 搜尋影片（最多 5 筆，依 YouTube 的相關性排序）。失敗丟 YouTubeSearchError（訊息不含金鑰）。 */
  async search(query: string, signal?: AbortSignal): Promise<VideoResult[]> {
    const q = query.trim().slice(0, 100);
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.results;
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      q,
      maxResults: "5",
      regionCode: this.options.regionCode ?? "TW",
      relevanceLanguage: this.options.relevanceLanguage ?? "zh-Hant",
    }).toString();
    let res: Response;
    // 自己的時限（8 秒）：搜尋卡住時回 failed（電視還沒動），不要拖到整合層逾時變成「結果不明」。
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 8_000);
    try {
      // key 放在 X-Goog-Api-Key 標頭（不放網址，避免出現在代理或 HTTP 紀錄的網址裡）。
      res = await this.fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error", headers: { accept: "application/json", "x-goog-api-key": this.options.apiKey } });
    } catch {
      throw new YouTubeSearchError("連不上 YouTube 搜尋", "network");
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const reasons = ((body as { error?: { errors?: { reason?: unknown }[] } } | null)?.error?.errors ?? []).map((e) => String(e?.reason ?? ""));
      if (res.status === 403 && reasons.some((r) => /quota|rateLimit/i.test(r))) throw new YouTubeSearchError("YouTube 搜尋額度用完", "quota");
      if (res.status === 400 || res.status === 403) throw new YouTubeSearchError("YouTube 拒絕了 API key", "denied");
      throw new YouTubeSearchError(`YouTube 搜尋回應錯誤（HTTP ${res.status}）`, "bad_reply");
    }
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new YouTubeSearchError("YouTube 搜尋的回覆看不懂", "bad_reply");
    const results: VideoResult[] = [];
    for (const item of items) {
      const it = item as { id?: { videoId?: unknown }; snippet?: { title?: unknown; channelTitle?: unknown; liveBroadcastContent?: unknown } };
      const id = it?.id?.videoId;
      if (typeof id !== "string" || !VIDEO_ID.test(id)) continue;
      results.push({ video_id: id, title: clean(unescape(String(it.snippet?.title ?? "")), 120), channel: clean(unescape(String(it.snippet?.channelTitle ?? "")), 60), live: it.snippet?.liveBroadcastContent === "live" });
      if (results.length >= 5) break;
    }
    // 找不到不快取（可能是暫時的狀況）。
    if (results.length) this.cache.set(key, { at: this.now(), results });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return results;
  }
}
