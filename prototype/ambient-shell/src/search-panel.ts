import { matchSpokenPoint, pickToolOutput, SEARCH_ERRORS, type SearchCandidate } from "../shared/web-search.ts";
import type { RealtimePhase } from "./realtime.ts";

// 即時語音上網查詢的畫面狀態（George 2026-11-09）：列出編號候選 → 使用者選一則 → 顯示重點、助理念到的那一點亮起 →
// 念完後 N 秒收起。兩條即時語音路徑共用（main.ts 的 realtimeCallbacks）。這裡只有狀態與計時，畫面由 views.ts 畫，
// 收起由呼叫端核對同一張畫面還開著才做。

export type SearchPanel =
  | { mode: "candidates"; query: string; candidates: SearchCandidate[] }
  | { mode: "reading"; query: string; candidate: SearchCandidate; active: number | null }
  | { mode: "failed"; query: string; error: string };

/** 畫面文字（經 t() 翻譯；src/messages.en.json 有英文）。 */
export const SEARCH_TEXT = {
  region: "查詢結果",
  candidatesEyebrow: "查詢結果 · 說「第二個」選一則",
  readingEyebrow: "查詢結果 · 第 {0} 則",
  failedEyebrow: "沒有查到",
  badge: "第 {0} 則",
  source: "來源",
  unsummarized: "這則沒有摘要，只有來源",
  points: "重點",
  dismissHint: "也可以說「收起」",
} as const;

/** 進入念重點（或失敗）之後這麼久還沒有開始播放，就不再等播放，直接開始收起倒數。 */
export const SPEECH_WAIT_MS = 15_000;

type Timer = ReturnType<typeof setTimeout>;

export interface SearchPanelDeps {
  /** 播放結束後幾毫秒收起（設定的 search_close_s）。 */
  closeAfterMs(): number;
  /** 畫面內容或亮起的那一點變了。 */
  changed(): void;
  /** 倒數到了；呼叫端只在同一張查詢畫面還開著時收起。 */
  autoClose(): void;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(timer: Timer): void;
}

export class SearchPanelController {
  private current: SearchPanel | null = null;
  private candidates: SearchCandidate[] = [];
  private phase: RealtimePhase = "off";
  private visible = false;
  /** 進入念重點（或失敗）之後是否真的播放過。 */
  private spoke = false;
  private waited = false;
  private closeTimer: Timer | null = null;
  private waitTimer: Timer | null = null;
  /** 念重點開始之後已經結束的助理逐字稿，和這一輪說到一半的片段。 */
  private spokenDone = "";
  private spokenPartial = "";
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly deps: SearchPanelDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get state(): SearchPanel | null {
    return this.current;
  }

  /** 查詢結果回來：兩則以上列出候選；只有一則直接念重點；沒有任何候選時不顯示（字幕照舊）。 */
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

  failed(query: string, error: string): SearchPanel {
    this.candidates = [];
    const panel: SearchPanel = { mode: "failed", query, error };
    this.enter(panel);
    return panel;
  }

  /** show_search_result：回傳交給模型的內容；成功時畫面換成那一則的重點。 */
  pick(index: number): Record<string, unknown> {
    if (!this.candidates.length) return { ok: false, error: SEARCH_ERRORS.none };
    const candidate = this.candidates.find((c) => c.n === index);
    if (!candidate) return { ok: false, error: SEARCH_ERRORS.outOfRange };
    const query = this.current && this.current.mode !== "failed" ? this.current.query : "";
    this.enter({ mode: "reading", query, candidate, active: null });
    return pickToolOutput(candidate);
  }

  setPhase(phase: RealtimePhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (phase === "speaking") {
      this.spoke = true;
      this.clearWait();
      this.follow();
    }
    this.sync();
  }

  /** 助理說到一半的片段：API key 路徑是增量，ChatGPT 方案路徑可能是整句到目前為止（以目前累積的開頭判斷）。 */
  assistantPartial(text: string): void {
    if (this.current?.mode !== "reading" || !text) return;
    this.spokenPartial = this.spokenPartial && text.startsWith(this.spokenPartial) ? text : this.spokenPartial + text;
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
    this.hidden();
  }

  private enter(panel: SearchPanel | null): void {
    this.current = panel;
    this.visible = panel !== null;
    this.spokenDone = "";
    this.spokenPartial = "";
    this.spoke = this.phase === "speaking";
    this.waited = false;
    this.clearTimers();
    if (panel && panel.mode !== "candidates" && !this.spoke) {
      this.waitTimer = this.setTimer(() => {
        this.waitTimer = null;
        this.waited = true;
        this.sync();
      }, SPEECH_WAIT_MS);
    }
    this.sync();
  }

  /** 只在真的在播放時換亮起的那一點；沒有比對到就維持原來的（不猜）。 */
  private follow(): void {
    const panel = this.current;
    if (panel?.mode !== "reading" || this.phase !== "speaking") return;
    const index = matchSpokenPoint(this.spokenDone + this.spokenPartial, panel.candidate.points);
    if (index === null || index === panel.active) return;
    this.current = { ...panel, active: index };
    this.deps.changed();
  }

  private sync(): void {
    const panel = this.current;
    const armed = this.visible && !!panel && panel.mode !== "candidates";
    if (!armed || this.phase === "speaking" || this.phase === "hearing") {
      this.clearClose();
      return;
    }
    if (!this.spoke && !this.waited) return;
    if (this.closeTimer) return;
    this.closeTimer = this.setTimer(() => {
      this.closeTimer = null;
      this.deps.autoClose();
    }, this.deps.closeAfterMs());
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
  }
}
