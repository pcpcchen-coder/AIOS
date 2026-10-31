// 常駐喚醒聆聽的本機提示音（WK-01a；docs/17 §5.7 第 1 點）：WebAudio 合成約 350 ms 的兩個音，不讀檔、不連網。
// 播放期間可以取消（Esc、張掌停止、說「收起」）；取消時回傳 false，呼叫端不送出觸發。
// 背景視窗或沒有使用者手勢時 AudioContext 可能被瀏覽器暫停，聽不到聲音：Mac gate 要實際確認（docs/validation/wk-01a-2026-10-31.md）。

export const EARCON_MS = 350;

export interface EarconPlayback {
  /** 播完回 true，被取消回 false。 */
  readonly done: Promise<boolean>;
  cancel(): void;
}

export interface EarconPlayer {
  play(): EarconPlayback;
}

export function browserEarcon(): EarconPlayer {
  return {
    play(): EarconPlayback {
      let settle: (played: boolean) => void = () => {};
      const done = new Promise<boolean>((resolve) => (settle = resolve));
      let finished = false;
      const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      const ctx = AudioCtx ? new AudioCtx() : null;
      const finish = (played: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void ctx?.close().catch(() => undefined);
        settle(played);
      };
      // 不論 AudioContext 是否真的出聲，都只等 EARCON_MS（加一點餘裕），讓使用者有取消的時間。
      const timer = setTimeout(() => finish(true), EARCON_MS + 50);
      if (ctx) {
        void ctx.resume().catch(() => undefined);
        const start = ctx.currentTime + 0.01;
        for (const [offset, freq] of [[0, 880], [0.16, 1320]] as const) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, start + offset);
          gain.gain.linearRampToValueAtTime(0.18, start + offset + 0.02);
          gain.gain.linearRampToValueAtTime(0, start + offset + 0.17);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start + offset);
          osc.stop(start + offset + 0.18);
        }
      }
      return { done, cancel: () => finish(false) };
    },
  };
}
