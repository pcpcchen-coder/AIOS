// 背景處理中的聲納提示音（George 2026-11-02；docs/validation/brain-processing-cue-2026-11-02.md）。
// WebAudio 合成，不讀檔、不連網、不開麥克風。一段處理期間一個 AudioContext；排程（什麼時候響、什麼時候停）在 src/processing-cue.ts。
// 聲音從「聲音輸出」選定的裝置出來：每次開始出聲前先 output.sink(ctx)（main.ts 注入 audioDevices），暫停或結束時 release。
// 背景視窗或沒有使用者手勢時 AudioContext 可能被瀏覽器暫停而聽不到：Mac 上要實際確認（驗收文件的 Mac 步驟）。

import type { CueSound } from "./processing-cue.ts";

/** 聲音規格（數字與驗收文件一致；分貝換算在 tests/processing-cue.test.ts）。 */
export const PING_SPEC = {
  /** 主音的最大增益（約 −26 dBFS）。 */
  peakGain: 0.05,
  /** 主音：正弦波由 1100 Hz 滑到 820 Hz，180 ms。 */
  main: { from: 1100, to: 820, ms: 180 },
  /** 回聲：260 ms 後，主音的 35%，880 → 700 Hz。 */
  echo: { delayMs: 260, ratio: 0.35, from: 880, to: 700, ms: 180 },
  /** 起音 10 ms，之後指數衰減。 */
  attackMs: 10,
  /** 開始出聲時的淡入、暫停或結束時的淡出（秒）。 */
  fadeInS: 1,
  fadeOutS: 0.4,
  /** 等聲音輸出導好的上限（同提示音 EARCON_SINK_WAIT_MS）：sink 沒回應時照系統預設出聲。 */
  sinkWaitMs: 1000,
} as const;

/** 聲音輸出（main.ts 注入 audioDevices）：sink 導到選定的裝置，release 在暫停或結束時歸還。 */
export interface CueOutput {
  sink(ctx: AudioContext): Promise<void>;
  release(ctx: AudioContext): void;
}

type AudioContextCtor = new () => AudioContext;

/** 線性增益換成 dBFS（20·log10）。 */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain);
}

export function browserProcessingSound(output: CueOutput, Ctor: AudioContextCtor | undefined = (globalThis as { AudioContext?: AudioContextCtor }).AudioContext): CueSound {
  const ctx = Ctor ? new Ctor() : null;
  const master = ctx ? ctx.createGain() : null;
  if (ctx && master) {
    master.gain.value = 0;
    master.connect(ctx.destination);
  }
  let sunk = false;
  let ready: Promise<void> = Promise.resolve();
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** 沒在執行時已經試過一次 resume（沒有使用者手勢時不會成功，不必每一響都試）。 */
  let retried = false;
  const running = () => !!ctx && (ctx as { state?: string }).state === "running";

  const fade = (to: number, seconds: number) => {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(to, t + seconds);
  };
  const tone = (start: number, from: number, to: number, ms: number, peak: number) => {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + ms / 1000);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + PING_SPEC.attackMs / 1000);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + ms / 1000 + 0.01);
  };
  const cancelRelease = () => {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
  };

  return {
    resume() {
      if (!ctx || closed) return;
      cancelRelease();
      void ctx.resume().catch(() => undefined);
      if (!sunk) {
        sunk = true;
        // 先導到「聲音輸出」選定的裝置再出聲；等太久就照系統預設（不讓提示音卡住）。
        ready = Promise.race([output.sink(ctx).catch(() => undefined), new Promise<void>((r) => setTimeout(r, PING_SPEC.sinkWaitMs))]);
      }
      fade(1, PING_SPEC.fadeInS);
    },
    ping() {
      if (!ctx || closed) return false;
      // AudioContext 被瀏覽器暫停（沒有使用者手勢）：不排音。排在暫停的時間軸上的音會在恢復時一起響出來。
      if (!running()) {
        if (!retried) {
          retried = true;
          void ctx.resume().catch(() => undefined);
        }
        return false;
      }
      retried = false;
      void ready.then(() => {
        if (closed || !sunk || !running()) return;
        const start = ctx.currentTime + 0.01;
        const { main, echo } = PING_SPEC;
        tone(start, main.from, main.to, main.ms, PING_SPEC.peakGain);
        tone(start + echo.delayMs / 1000, echo.from, echo.to, echo.ms, PING_SPEC.peakGain * echo.ratio);
      });
      return true;
    },
    pause() {
      if (!ctx || closed) return;
      fade(0, PING_SPEC.fadeOutS);
      cancelRelease();
      // 淡出完才歸還輸出（「使用中」只在真的出聲時顯示）。
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!sunk) return;
        sunk = false;
        output.release(ctx);
      }, PING_SPEC.fadeOutS * 1000 + 50);
    },
    stop() {
      if (!ctx || closed) return;
      fade(0, PING_SPEC.fadeOutS);
      cancelRelease();
      closed = true;
      setTimeout(() => {
        if (sunk) output.release(ctx);
        sunk = false;
        void ctx.close().catch(() => undefined);
      }, PING_SPEC.fadeOutS * 1000 + 50);
    },
  };
}
