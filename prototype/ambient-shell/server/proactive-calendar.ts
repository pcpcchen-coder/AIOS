import { randomUUID } from "node:crypto";
import type { Locale } from "../shared/i18n.mjs";
import type { IntegrationRegistry } from "./integrations/registry.ts";
import { scheduleSentence, type CalendarFetchState, type TodayEvent } from "../shared/proactive.ts";
import { CONFIRM_AFTER_MS, ECHO_WINDOW_MS, exactYesNo, normalizeSpoken } from "./memory/live.ts";

// PRO-2（George 2026-11-05）：今天的行程（經 CAL-1 讀）與「要不要我念今天的行程？」的語音是／否。
// - 行程只在核心記憶體裡（快取 10 分鐘），不寫檔、不進 log；設定頁只看得到狀態。
// - 回答沿用記憶的規則（server/memory/live.ts）：整句是肯定詞（YES 白名單）才算好；只在問句念完之後開口才算（readyAt）；
//   和剛念的問句或招呼重疊的逐字稿是回音，不算。其他回答、說不要或 20 秒沒回答：不念、今天不再問。

export const CALENDAR_TTL_MS = 10 * 60_000;
export const CALENDAR_READ_TIMEOUT_MS = 30_000;
/** 問句念完後多久沒有回答就放棄。 */
export const ASK_ANSWER_MS = 20_000;

/** 讀今天的行程（CAL-1 的 app.calendar.list_events range today）；失敗回 null。 */
export type CalendarReader = (signal: AbortSignal) => Promise<TodayEvent[] | null>;

export class CalendarToday {
  private cached: { date: string; events: TodayEvent[]; at: number } | null = null;
  private inflight: Promise<TodayEvent[] | null> | null = null;
  private last: { ok: boolean } | null = null;

  constructor(private readonly options: { read: CalendarReader | null; now: () => number; today: () => string; log?: (line: string) => void }) {}

  get connected(): boolean {
    return this.options.read !== null;
  }

  /** 快取裡今天的行程（不發請求）；沒有、過期或不是今天回 null。 */
  current(): TodayEvent[] | null {
    const c = this.cached;
    if (!c || c.date !== this.options.today() || this.options.now() - c.at > CALENDAR_TTL_MS) return null;
    return c.events;
  }

  /** 快取沒有（或過期）才讀；同時只讀一次。 */
  refresh(): Promise<TodayEvent[] | null> {
    const read = this.options.read;
    if (!read) return Promise.resolve(null);
    const c = this.current();
    if (c) return Promise.resolve(c);
    if (this.inflight) return this.inflight;
    const date = this.options.today();
    const started = this.options.now();
    const promise = read(AbortSignal.timeout(CALENDAR_READ_TIMEOUT_MS))
      .catch(() => null)
      .then((events) => {
        this.last = { ok: events !== null };
        if (events) this.cached = { date, events, at: this.options.now() };
        // 只記筆數與時間，不記行程內容。
        this.options.log?.(events ? `主動提醒：已讀今天的行程（${events.length} 個，${this.options.now() - started} ms）` : "主動提醒：讀今天的行程失敗，這次不提行程");
        return events;
      })
      .finally(() => {
        if (this.inflight === promise) this.inflight = null;
      });
    this.inflight = promise;
    return promise;
  }

  state(): CalendarFetchState {
    if (!this.options.read) return "not_connected";
    if (this.current()) return "ok";
    if (this.last && !this.last.ok) return "failed";
    return "none";
  }
}

/** 一通通話裡的語音事件（LiveCall、ApiKeyCall 照收到的順序交給它）。onUserFinal 回傳要請模型念的內容（或 null）。 */
export interface CallFollowUp {
  onUserSpeechStart(at: number): void;
  onUserFinal(text: string, at: number): string | null;
  onAssistantFinal(text: string, at: number): void;
  onAssistantAudioDone(at: number): void;
}

/** 請模型念行程的標記：live 路徑的說明（buildLiveInstructions）與 API key 的 speakInstructions 都認得。 */
export const SCHEDULE_MARKER = "（行程）";

/**
 * 問過「要不要我念今天的行程？」之後的一次是／否（每通最多一次）。
 * 念招呼（含問句）的助理逐字稿到了才開始算；使用者在問句念完前開口的那一句不算（不是回答，也不結束：只是還沒問完）。
 */
export class CalendarAsk implements CallFollowUp {
  private doneAt: number | null = null;
  private audioDone: number | null = null;
  private speechStart: number | null = null;
  private finished = false;
  private readonly spoken: string;

  constructor(
    private readonly options: { greeting: string; events: readonly TodayEvent[]; locale: Locale; startedAt: number; log?: (line: string) => void },
  ) {
    this.spoken = normalizeSpoken(options.greeting);
  }

  /** 還在等回答（沒結束、沒過期）。 */
  open(now: number): boolean {
    if (this.finished) return false;
    const deadline = this.doneAt !== null ? this.readyAt() + ASK_ANSWER_MS : this.options.startedAt + ASK_ANSWER_MS * 2;
    if (now > deadline) {
      this.end("沒有回答");
      return false;
    }
    return true;
  }

  private end(why: string): void {
    if (this.finished) return;
    this.finished = true;
    this.options.log?.(`主動提醒：行程問句結束（${why}）`);
  }

  private readyAt(): number {
    const done = this.doneAt!;
    return this.audioDone !== null && this.audioDone >= done ? this.audioDone : done + CONFIRM_AFTER_MS;
  }

  /** 送出招呼後的第一則助理逐字稿就是念招呼（含問句）的那一輪：從它算問句念完。 */
  onAssistantFinal(_text: string, at: number): void {
    if (this.finished || this.doneAt !== null) return;
    this.doneAt = at;
  }

  onAssistantAudioDone(at: number): void {
    this.audioDone = this.audioDone === null ? at : Math.max(this.audioDone, at);
  }

  onUserSpeechStart(at: number): void {
    if (this.speechStart === null) this.speechStart = at;
  }

  onUserFinal(text: string, at: number): string | null {
    const started = this.speechStart ?? at;
    this.speechStart = null;
    if (!this.open(at) || this.doneAt === null) return null;
    if (started < this.readyAt()) return null;
    const norm = normalizeSpoken(text);
    if (!norm) return null;
    // 回音：被剛念的招呼／問句包含（一兩個字的話只有和整句相同才算，同記憶的規則）。
    if (at - this.doneAt <= ECHO_WINDOW_MS && (norm === this.spoken || (norm.length >= 3 && this.spoken.includes(norm)))) return null;
    if (exactYesNo(text) === "yes") {
      this.end("說好，念行程");
      return `${SCHEDULE_MARKER}${scheduleSentence(this.options.events, this.options.locale)}`;
    }
    this.end(exactYesNo(text) === "no" ? "說不要" : "回答不是好");
    return null;
  }
}

/** CAL-1 的讀行程工具 ID（server/integrations/adapters/google-calendar.ts CALENDAR_TOOL.list）。 */
const LIST_TOOL = "app.calendar.list_events" as const;

/**
 * 從整合層找 CAL-1 的讀行程工具，包成 CalendarReader（range today，唯讀）。google_calendar 沒有註冊或沒有啟用時回 null。
 * 直接呼叫 Adapter（核心自己的讀取，不經模型）；結果不是 confirmed 就當成讀不到。
 */
export function calendarReaderFrom(registry: Pick<IntegrationRegistry, "lookup" | "status"> | null | undefined): CalendarReader | null {
  const hit = registry?.lookup(LIST_TOOL);
  if (!hit || registry!.status(LIST_TOOL, "live") !== "available") return null;
  return async (signal) => {
    const res = await hit.adapter.execute(LIST_TOOL, { range: "today" }, { actor: "agent", route: "background", sessionId: "proactive", requestId: randomUUID(), signal });
    if (res.status !== "confirmed") return null;
    const list = (res.data as { events?: unknown } | undefined)?.events;
    if (!Array.isArray(list)) return null;
    return list.flatMap((e): TodayEvent[] => {
      if (!e || typeof e !== "object") return [];
      const v = e as Record<string, unknown>;
      if (typeof v.start !== "string") return [];
      return [{ summary: typeof v.summary === "string" ? v.summary : "", start: v.start, all_day: v.all_day === true, ...(typeof v.location === "string" && v.location ? { location: v.location } : {}) }];
    });
  };
}
