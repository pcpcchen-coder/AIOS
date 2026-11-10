import { locateSpokenPoint, pickToolOutput, SEARCH_ERRORS, type SearchCandidate } from "../shared/web-search.ts";
import type { RealtimePhase } from "./realtime.ts";

// 即時語音上網查詢的畫面狀態（George 2026-11-09）：列出編號候選 → 使用者選一則 → 顯示重點、助理念到的那一點亮起 →
// 念完後 N 秒收起。兩條即時語音路徑共用（main.ts 的 realtimeCallbacks）。這裡只有狀態與計時，畫面由 views.ts 畫，
// 收起由呼叫端核對同一張畫面還開著才做。

/** 查詢失敗的種類（畫面顯示翻譯過的固定句，不顯示核心回的中文原文）。 */
export type SearchErrorKind = "timeout" | "unavailable" | "auth" | "network" | "generic";

export type SearchPanel =
  | { mode: "candidates"; query: string; candidates: SearchCandidate[] }
  | { mode: "reading"; query: string; candidate: SearchCandidate; active: number | null }
  | { mode: "failed"; query: string; error: SearchErrorKind };

/** 畫面文字（經 t() 翻譯；src/messages.en.json 有英文）。 */
export const SEARCH_TEXT = {
  region: "查詢結果",
  candidatesEyebrow: "查詢結果 · 說「第二個」選一則",
  readingEyebrow: "查詢結果 · 第 {0} 則",
  failedEyebrow: "查詢失敗",
  badge: "第 {0} 則",
  source: "來源",
  uncited: "網址沒有經來源核對",
  unsummarized: "這則沒有摘要，只有來源",
  points: "重點",
  dismissHint: "也可以說「收起」",
} as const;

export const SEARCH_ERROR_TEXT: Record<SearchErrorKind, string> = {
  timeout: "上網查詢逾時，請稍後再問一次",
  unavailable: "上網查詢目前不可用",
  auth: "上網查詢的帳號或金鑰沒有授權",
  network: "連不上查詢服務",
  generic: "上網查詢失敗",
};

/** 依 HTTP 狀態與核心的錯誤訊息分類（訊息是核心的固定句，見 server/web-search.ts、server/app.ts、src/api.ts）。 */
export function classifySearchError(status: number | null, message: string): SearchErrorKind {
  if (status === 504 || /逾時|timed? ?out/i.test(message)) return "timeout";
  if (status === 401 || status === 403 || /401|未授權|無效|unauthori[sz]ed/i.test(message)) return "auth";
  if (status === 409 || /未啟用|尚未登入|尚未設定|not enabled|unavailable/i.test(message)) return "unavailable";
  if (status === 0 || /無法連線|無法連到|網路|network|fetch/i.test(message)) return "network";
  return "generic";
}

/** 進入念重點（或失敗）之後，在待命（listening）中這麼久都沒有開始播放，就不再等播放，直接開始收起倒數。 */
export const SPEECH_WAIT_MS = 15_000;

/**
 * 跟讀的估計語速（字元／秒，含標點）：只是估計值，不是量測。用來把逐字稿限制在「播放了這麼久大概念到哪裡」，
 * 因為 API key 路徑的逐字稿比聲音先到，整句 final 也可能在播放剛開始時就到。
 */
export const READ_ALONG_CHARS_PER_S = { "zh-TW": 5.5, en: 15 } as const;
/** 播放中多久重算一次亮起的那一點（播放時間增加，可比對的逐字稿跟著變長）。 */
export const READ_ALONG_TICK_MS = 250;

type Timer = ReturnType<typeof setTimeout>;

export interface SearchPanelDeps {
  /** 播放結束後幾毫秒收起（設定的 search_close_s）。 */
  closeAfterMs(): number;
  /** 畫面內容或亮起的那一點變了。 */
  changed(): void;
  /** 倒數到了；呼叫端只在同一張查詢畫面還開著時收起。 */
  autoClose(): void;
  /** 估計語速（字元／秒）；預設中文。 */
  charsPerSecond?(): number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(timer: Timer): void;
}

export class SearchPanelController {
  private current: SearchPanel | null = null;
  private candidates: SearchCandidate[] = [];
  private phase: RealtimePhase = "off";
  private visible = false;
  /** 每次換內容（enter）加一；畫面的重畫 key 帶著它，同一則重選也會重畫。 */
  private rev = 0;
  /** 進入念重點（或失敗）之後是否真的「開始」播放過（進入時已在播放的那段不算：那是選之前的話）。 */
  private spoke = false;
  private waited = false;
  private closeTimer: Timer | null = null;
  private waitTimer: Timer | null = null;
  private tickTimer: Timer | null = null;
  /** 進入之後真的播放了多久（只算進入後開始的播放）。 */
  private speakingMs = 0;
  private speakingSince: number | null = null;
  /** 念重點開始之後已經結束的助理逐字稿，和這一輪說到一半的片段。 */
  private spokenDone = "";
  private spokenPartial = "";
  /** 目前亮起那一點的詞在正規化逐字稿中的結尾位置；下一點要在這之後出現。 */
  private activeEnd = 0;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly now: () => number;

  constructor(private readonly deps: SearchPanelDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = deps.now ?? (() => Date.now());
  }

  get state(): SearchPanel | null {
    return this.current;
  }

  /** 換內容的次數（畫面重畫 key 用）。 */
  get revision(): number {
    return this.rev;
  }

  /** 查詢結果回來：兩則以上列出候選；只有一則直接念重點；沒有任何候選時不顯示（回 null，呼叫端收起舊的查詢畫面）。 */
  results(query: string, candidates: SearchCandidate[]): SearchPanel | null {
    this.candidates = candidates;
    if (candidates.length === 0) {
      this.enter(null);
    } else if (candidates.length === 1) {
      this.enter({ mode: "reading", query, candidate: candidates[0], active: null });
    } else {
      this.enter({ mode: "candidates", query, candidates });
    }
    return this.current;
  }

  failed(query: string, error: SearchErrorKind): SearchPanel {
    this.candidates = [];
    const panel: SearchPanel = { mode: "failed", query, error };
    this.enter(panel);
    return panel;
  }

  /**
   * show_search_result：成功時畫面換成那一則的重點，再由 show() 真的顯示；回傳交給模型的內容
   * （show() 回 false 時告訴模型畫面沒有顯示）。
   */
  pick(index: number, show: () => boolean): Record<string, unknown> {
    if (!this.candidates.length) return { ok: false, error: SEARCH_ERRORS.none };
    const candidate = this.candidates.find((c) => c.n === index);
    if (!candidate) return { ok: false, error: SEARCH_ERRORS.outOfRange };
    const query = this.current && this.current.mode !== "failed" ? this.current.query : "";
    this.enter({ mode: "reading", query, candidate, active: null });
    return pickToolOutput(candidate, show());
  }

  setPhase(phase: RealtimePhase): void {
    if (phase === this.phase) return;
    const was = this.phase;
    this.phase = phase;
    if (was === "speaking" && this.speakingSince !== null) {
      this.speakingMs += this.now() - this.speakingSince;
      this.speakingSince = null;
    }
    if (phase === "speaking" && this.current) {
      this.spoke = true;
      this.speakingSince = this.now();
    }
    this.follow();
    this.sync();
  }

  /**
   * 助理說到一半的片段：API key 路徑是增量；ChatGPT 方案路徑是整句到目前為止，而且可能有兩個來源（channel 與核心）
   * 送同一句的累積版本、一個比另一個慢。所以：是目前累積的開頭（或一樣）→ 忽略；延伸了目前累積 → 換掉；其他 → 接在後面。
   */
  assistantPartial(text: string): void {
    if (this.current?.mode !== "reading" || !text) return;
    const acc = this.spokenPartial;
    if (acc && acc.startsWith(text)) return;
    this.spokenPartial = acc && text.startsWith(acc) ? text : acc + text;
    this.follow();
  }

  /** 助理說完一則（final 逐字稿）。 */
  assistantFinal(text: string): void {
    if (this.current?.mode !== "reading" || !text) return;
    this.spokenDone += text;
    this.spokenPartial = "";
    this.follow();
  }

  /** 查詢畫面被收起或換掉：停止倒數；結果留著，使用者之後仍可以選一則。 */
  hidden(): void {
    this.visible = false;
    this.clearTimers();
  }

  /** 通話結束：全部清掉（之後的 show_search_result 回「還沒有查詢結果」）。 */
  clear(): void {
    this.current = null;
    this.candidates = [];
    this.phase = "off";
    this.speakingSince = null;
    this.hidden();
  }

  private enter(panel: SearchPanel | null): void {
    this.current = panel;
    this.rev++;
    this.visible = panel !== null;
    this.spokenDone = "";
    this.spokenPartial = "";
    this.activeEnd = 0;
    // 進入時正在播放的是選之前的話（例如「好，我看看」）：不算播放時間，也不算「念過了」。
    this.spoke = false;
    this.speakingMs = 0;
    this.speakingSince = null;
    this.waited = false;
    this.clearTimers();
    this.sync();
  }

  /** 進入之後真的播放了多久（毫秒）。 */
  private elapsedSpeakingMs(): number {
    return this.speakingMs + (this.speakingSince === null ? 0 : this.now() - this.speakingSince);
  }

  /**
   * 只在真的在播放時換亮起的那一點；比對的逐字稿限制在「播放時間 × 估計語速」個字以內（逐字稿比聲音先到）。
   * 只往後走、沒有比對到就維持原來的（不猜）。
   */
  private follow(): void {
    const panel = this.current;
    if (panel?.mode !== "reading" || this.phase !== "speaking") return;
    const rate = this.deps.charsPerSecond?.() ?? READ_ALONG_CHARS_PER_S["zh-TW"];
    const cap = Math.floor((this.elapsedSpeakingMs() / 1000) * rate);
    const heard = (this.spokenDone + this.spokenPartial).slice(0, cap);
    // 千分位逗號在前綴與全文的正規化結果可能差一個字，所以位置留 2 個字的餘裕。
    const found = locateSpokenPoint(heard, panel.candidate.points, { after: panel.active, headOnly: panel.active === null, fromPos: Math.max(0, this.activeEnd - 2) });
    if (!found || (panel.active !== null && found.index <= panel.active)) return;
    this.activeEnd = found.end;
    this.current = { ...panel, active: found.index };
    this.deps.changed();
  }

  private sync(): void {
    const panel = this.current;
    const reading = this.visible && panel?.mode === "reading";
    // 播放中定時重算亮起的那一點：播放時間增加，可比對的逐字稿就變長。
    if (reading && this.speakingSince !== null) {
      if (!this.tickTimer) this.scheduleTick();
    } else this.clearTick();
    const armed = this.visible && !!panel && panel.mode !== "candidates";
    // 只有待命（listening）才倒數：播放中、使用者開口、處理中（ChatGPT 方案路徑交辦中）都不算念完。
    if (!armed || this.phase !== "listening") {
      this.clearClose();
      this.clearWait();
      return;
    }
    if (!this.spoke && !this.waited) {
      if (!this.waitTimer) {
        this.waitTimer = this.setTimer(() => {
          this.waitTimer = null;
          this.waited = true;
          this.sync();
        }, SPEECH_WAIT_MS);
      }
      return;
    }
    if (this.closeTimer) return;
    this.closeTimer = this.setTimer(() => {
      this.closeTimer = null;
      this.deps.autoClose();
    }, this.deps.closeAfterMs());
  }

  private scheduleTick(): void {
    this.tickTimer = this.setTimer(() => {
      this.tickTimer = null;
      this.follow();
      this.sync();
    }, READ_ALONG_TICK_MS);
  }

  private clearTick(): void {
    if (this.tickTimer) this.clearTimer(this.tickTimer);
    this.tickTimer = null;
  }

  private clearClose(): void {
    if (this.closeTimer) this.clearTimer(this.closeTimer);
    this.closeTimer = null;
  }

  private clearWait(): void {
    if (this.waitTimer) this.clearTimer(this.waitTimer);
    this.waitTimer = null;
  }

  private clearTimers(): void {
    this.clearClose();
    this.clearWait();
    this.clearTick();
  }
}

/**
 * 使用者說完的每一句（final 逐字稿）登記一個 request id；打開查詢畫面時取用最新、還沒用過的那一個。
 * 沒有就不打開：查詢畫面是 user_request，必須對得上使用者真的說的一句話。
 */
export class UtteranceRequests {
  private latest: string | null = null;

  constructor(private readonly register: () => string) {}

  noted(): void {
    this.latest = this.register();
  }

  consume(): string | null {
    const id = this.latest;
    this.latest = null;
    return id;
  }

  clear(): void {
    this.latest = null;
  }
}

export interface SurfaceRef {
  kind: string;
  surface_id: string;
}

export type SearchSurfaceStep =
  | { action: "blocked" } // 確認卡開著：不換掉（換掉＝拒絕）
  | { action: "reuse" } // 同一張查詢畫面還開著：重畫內容
  | { action: "open"; requestId: string }
  | { action: "no_request" }; // 找不到使用者這一句話：不打開

/** 查詢結果（或選一則）之後畫面要怎麼做。確認卡開著時不取用 request id，留給之後選一則時用。 */
export function planSearchSurface(surface: SurfaceRef | null, searchSurfaceId: string | null, requests: UtteranceRequests): SearchSurfaceStep {
  if (surface?.kind === "confirm") return { action: "blocked" };
  const requestId = requests.consume();
  if (surface?.kind === "search" && surface.surface_id === searchSurfaceId) return { action: "reuse" };
  return requestId ? { action: "open", requestId } : { action: "no_request" };
}

/**
 * 查詢成功但沒有任何候選（results() 回 null）時，還開著的查詢畫面（上一次的結果）要收起：不留空白卡，
 * 由模型用說的回答 answer。
 */
export function dismissEmptySearch(panel: SearchPanel | null, surface: SurfaceRef | null): boolean {
  return panel === null && surface?.kind === "search";
}

/** 收起倒數到了：只收起同一張查詢畫面。 */
export function shouldAutoClose(surface: SurfaceRef | null, searchSurfaceId: string | null): boolean {
  return surface?.kind === "search" && surface.surface_id === searchSurfaceId;
}
