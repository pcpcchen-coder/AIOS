// 背景處理中的提示（George 2026-11-02；docs/validation/brain-processing-cue-2026-11-02.md）。
// 有背景任務真的在執行（status === "running"）或即時語音的上網查詢還沒回來時，電子腦進入「處理中」的樣子；
// 同時播放輕聲的聲納提示音（src/processing-sound.ts），但有次數與時間上限，也會在以下情況暫停：
// Nous 正在說話（含結束後 1.5 秒）、麥克風正在收音、即時語音通話中（只有畫面）、主視窗看不到。
// 排隊（queued）與取消中（cancelling）不算；沒有真實的執行中來源就沒有動畫也沒有聲音。
// 這個檔案只有排程邏輯（時鐘可注入）；出聲由注入的 CueSound 負責，假時鐘與假 AudioContext 測試見 tests/processing-cue.test.ts。

import type { Task } from "../shared/types.ts";

/** 時間常數（毫秒）。數字與 docs/validation/brain-processing-cue-2026-11-02.md 一致，測試核對。 */
export const CUE_TIMING = {
  /** 兩次聲納提示音的間隔。 */
  pingIntervalMs: 2400,
  /** 一段處理開始（沒有→有執行中的來源）時，出聲的時間窗。 */
  episodeWindowMs: 20_000,
  /** 有新的步驟開始執行時，重新出聲的時間窗。 */
  rearmWindowMs: 6_000,
  /** 兩次重新出聲之間至少相隔。 */
  rearmMinGapMs: 15_000,
  /** 即時語音查詢最多算多久的「處理中」：請求一直沒有回來時，時間到就不再算（main.ts）。 */
  searchTimeoutMs: 30_000,
  /** 每個任務最多累計出聲多久（以提示音間隔計），之後只有畫面。 */
  taskCapMs: 60_000,
  /** Nous 說完話後再等多久才恢復（同 src/audio/guard.ts 的 SPEECH_TAIL_MS）。 */
  speechTailMs: 1_500,
  /** 每次提示音期間告訴喚醒防護不要接受喚醒詞（提示音加回聲約 440 ms）。 */
  guardMs: 450,
} as const;

export interface ProcessingSourceInput {
  tasks: Iterable<Task>;
  /** 還沒回來的即時語音查詢（每一次查詢一個遞增編號）。 */
  searches: Iterable<number>;
  /** 和核心的事件串流連著：斷線時畫面上的任務狀態可能已經過時，一律不算。 */
  connected: boolean;
  /** 即時語音通話還開著：通話結束後才回來的查詢不算。 */
  callOn: boolean;
}

/**
 * 處理中的真實來源：執行中的任務（task:<id>）與還沒回來的即時語音查詢（search:<編號>）。
 * 斷線時不算任務（狀態可能過時）；通話結束後不算查詢。
 */
export function processingSource(input: ProcessingSourceInput): string[] {
  const owners: string[] = [];
  if (input.connected) for (const task of input.tasks) if (task.status === "running") owners.push(`task:${task.task_id}`);
  if (input.callOn) for (const id of input.searches) owners.push(`search:${id}`);
  return owners;
}

export interface ProcessingInput {
  /** processingSource 的結果；空的＝沒有在處理。 */
  owners: readonly string[];
  /** 「處理中音效」開關（audio.json 的 processing_cue）。 */
  enabled: boolean;
  /** 即時語音通話中（含連線中）：只有畫面，不出聲。 */
  callOn: boolean;
  /** Nous 正在說話（語音合成或回覆播放）。 */
  speaking: boolean;
  /** 麥克風正在收音（按下說話、語音模式、即時語音）。 */
  capturing: boolean;
  /** 主視窗看不到。 */
  hidden: boolean;
}

/**
 * 一段處理期間的聲音（一個 AudioContext）。resume 淡入並導到選定的聲音輸出，pause 淡出並歸還，stop 關掉。
 * ping 回傳這一響會不會真的出聲：AudioContext 沒在執行（沒有使用者手勢時瀏覽器會暫停它）就不排音、回 false，
 * 這時也不畫波紋、不佔喚醒防護、不扣任務額度。
 */
export interface CueSound {
  resume(): void;
  ping(): boolean;
  pause(): void;
  stop(): void;
}

export interface CueClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface ProcessingCueOptions {
  clock?: CueClock;
  /** 每段處理建立一份聲音（第一次要出聲時才建立）。 */
  createSound(): CueSound;
  /** 喚醒防護：提示音期間 begin，guardMs 後 end（main.ts 接到 wake?.begin("cue")）。 */
  guard?: { begin(): void; end(): void };
  /** 每次真的排了提示音（電子腦畫一圈淡淡的波紋）。 */
  onPing?(): void;
}

/** 為什麼現在沒有出聲（測試與畫面說明用）。 */
export type CueQuiet = "idle" | "off" | "call" | "speaking" | "speech_tail" | "capturing" | "hidden" | "window" | "cap";

const realClock: CueClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

const IDLE: ProcessingInput = { owners: [], enabled: true, callOn: false, speaking: false, capturing: false, hidden: false };

export class ProcessingCue {
  private readonly clock: CueClock;
  private input: ProcessingInput = IDLE;
  private episode = false;
  private sound: CueSound | null = null;
  private audible = false;
  private soundUntil = 0;
  private lastRearmAt = Number.NEGATIVE_INFINITY;
  private speechTailUntil = 0;
  private readonly seen = new Set<string>();
  private readonly usage = new Map<string, number>();
  private tick: unknown = null;
  private wakeAt: unknown = null;
  private readonly guards = new Set<unknown>();
  private pings = 0;
  private lastPingAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: ProcessingCueOptions) {
    this.clock = options.clock ?? realClock;
  }

  /** 有真實的執行中來源（電子腦的「處理中」樣子只看這個，不看聲音）。 */
  get active(): boolean {
    return this.input.owners.length > 0;
  }

  /** 這段處理到目前為止排了幾次提示音。 */
  get pingCount(): number {
    return this.pings;
  }

  /** 狀態改變時呼叫（main.ts 的 render、念話開始／結束、視窗顯示／隱藏）。 */
  update(input: ProcessingInput): void {
    const now = this.clock.now();
    if (this.input.speaking && !input.speaking) this.speechTailUntil = now + CUE_TIMING.speechTailMs;
    this.input = { ...input, owners: [...input.owners] };
    if (input.owners.length === 0) {
      this.endEpisode();
      return;
    }
    if (!this.episode) {
      this.episode = true;
      this.pings = 0;
      this.lastPingAt = Number.NEGATIVE_INFINITY;
      this.soundUntil = now + CUE_TIMING.episodeWindowMs;
      this.lastRearmAt = Number.NEGATIVE_INFINITY;
      this.seen.clear();
      this.usage.clear();
      for (const owner of input.owners) this.seen.add(owner);
    } else {
      // 處理中途又有另一個任務開始執行：它有自己的開始時間窗（20 秒，不受 15 秒限制，也不用掉重新出聲的次數）；
      // 每個任務的 60 秒上限照算。查詢（search:）只會在通話中出現，通話中不出聲，不給時間窗。
      for (const owner of input.owners) {
        if (this.seen.has(owner)) continue;
        this.seen.add(owner);
        if (owner.startsWith("task:")) this.soundUntil = Math.max(this.soundUntil, now + CUE_TIMING.episodeWindowMs);
      }
    }
    this.evaluate();
  }

  /** 有步驟開始執行（main.ts firePulses 的真實步驟事件）：重新出聲 6 秒，每 15 秒最多一次。 */
  rearm(): void {
    if (!this.episode) return;
    if (this.extend(this.clock.now())) this.evaluate();
  }

  /** 現在不出聲的原因；正在出聲時 null。 */
  quiet(): CueQuiet | null {
    const now = this.clock.now();
    const i = this.input;
    if (!this.episode || i.owners.length === 0) return "idle";
    if (!i.enabled) return "off";
    if (i.callOn) return "call";
    if (i.speaking) return "speaking";
    if (now < this.speechTailUntil) return "speech_tail";
    if (i.capturing) return "capturing";
    if (i.hidden) return "hidden";
    if (now >= this.soundUntil) return "window";
    if (!i.owners.some((owner) => (this.usage.get(owner) ?? 0) < CUE_TIMING.taskCapMs)) return "cap";
    return null;
  }

  dispose(): void {
    this.input = IDLE;
    this.endEpisode();
  }

  // ───────────── 內部 ─────────────

  private extend(now: number): boolean {
    if (now - this.lastRearmAt < CUE_TIMING.rearmMinGapMs) return false;
    const until = now + CUE_TIMING.rearmWindowMs;
    if (until <= this.soundUntil) return false;
    this.soundUntil = until;
    this.lastRearmAt = now;
    return true;
  }

  private evaluate(): void {
    this.clearWake();
    const quiet = this.quiet();
    if (quiet === null) {
      if (!this.audible) {
        this.audible = true;
        this.sound ??= this.options.createSound();
        this.sound.resume();
        // 暫停後恢復：離上一響不到 2.4 秒時等到滿 2.4 秒再響（不連響）。
        const wait = this.lastPingAt + CUE_TIMING.pingIntervalMs - this.clock.now();
        if (wait <= 0) this.ping();
        else this.scheduleTick(wait);
      }
      return;
    }
    if (this.audible) {
      this.audible = false;
      this.clearTick();
      this.sound?.pause();
    }
    // 關掉「處理中音效」：這段處理的聲音整個結束（AudioContext 關掉）；畫面照舊。
    if (quiet === "off" && this.sound) {
      this.sound.stop();
      this.sound = null;
    }
    // 只差說話後的尾巴：時間到了再看一次（其他原因都會隨狀態改變再呼叫 update）。
    if (quiet === "speech_tail") {
      this.wakeAt = this.clock.setTimeout(() => {
        this.wakeAt = null;
        this.evaluate();
      }, Math.max(0, this.speechTailUntil - this.clock.now()));
    }
  }

  private ping(): void {
    this.lastPingAt = this.clock.now();
    // 只有真的出聲（AudioContext 在執行）才扣額度、佔喚醒防護、畫波紋。
    if (this.sound?.ping()) {
      for (const owner of this.input.owners) {
        const used = this.usage.get(owner) ?? 0;
        if (used < CUE_TIMING.taskCapMs) this.usage.set(owner, used + CUE_TIMING.pingIntervalMs);
      }
      this.pings++;
      const guard = this.options.guard;
      if (guard) {
        guard.begin();
        const id = this.clock.setTimeout(() => {
          this.guards.delete(id);
          guard.end();
        }, CUE_TIMING.guardMs);
        this.guards.add(id);
      }
      this.options.onPing?.();
    }
    this.scheduleTick(CUE_TIMING.pingIntervalMs);
  }

  private scheduleTick(ms: number): void {
    this.clearTick();
    this.tick = this.clock.setTimeout(() => {
      this.tick = null;
      if (this.quiet() === null) this.ping();
      else this.evaluate();
    }, ms);
  }

  private endEpisode(): void {
    this.clearTick();
    this.clearWake();
    this.audible = false;
    this.episode = false;
    this.sound?.stop();
    this.sound = null;
    // 還沒結束的防護立即結束（計數不留在喚醒防護裡）。
    for (const id of this.guards) {
      this.clock.clearTimeout(id);
      this.options.guard?.end();
    }
    this.guards.clear();
  }

  private clearTick(): void {
    if (this.tick !== null) this.clock.clearTimeout(this.tick);
    this.tick = null;
  }

  private clearWake(): void {
    if (this.wakeAt !== null) this.clock.clearTimeout(this.wakeAt);
    this.wakeAt = null;
  }
}
