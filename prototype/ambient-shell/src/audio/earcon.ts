// 常駐喚醒聆聽的本機提示音（WK-01a；docs/17 §5.7 第 1 點）：WebAudio 合成約 350 ms 的兩個音，不讀檔、不連網。
// 播放期間可以取消（Esc、張掌停止、說「收起」）；取消時回傳 false，呼叫端不送出觸發。
// 聲音從「聲音輸出」選定的裝置出來（output.sink，main.ts 注入 src/audio-devices.ts 的 audioDevices）。
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

/** 提示音的聲音輸出（main.ts 注入 audioDevices）：sink 導到「聲音輸出」選定的裝置，release 在結束時歸還。 */
export interface EarconOutput {
  sink(ctx: AudioContext): Promise<void>;
  release(ctx: AudioContext): void;
}

/** 等聲音輸出導好的上限：sink 一直沒有回應時，照系統預設出聲（不讓提示音卡住觸發）。 */
export const EARCON_SINK_WAIT_MS = 1000;

export function browserEarcon(output: EarconOutput | null = null): EarconPlayer {
  return {
    play(): EarconPlayback {
      let settle: (played: boolean) => void = () => {};
      const done = new Promise<boolean>((resolve) => (settle = resolve));
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let sinkWait: ReturnType<typeof setTimeout> | null = null;
      const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      const ctx = AudioCtx ? new AudioCtx() : null;
      const finish = (played: boolean) => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimeout(timer);
        if (sinkWait !== null) clearTimeout(sinkWait);
        if (ctx) output?.release(ctx);
        void ctx?.close().catch(() => undefined);
        settle(played);
      };
      // 播放時間從真的排音之後才開始算（藍牙等較慢的輸出導好之前不算），兩個音約 350 ms 播完後才關掉 AudioContext；
      // 不論是否真的出聲，排音後都只等 EARCON_MS（加一點餘裕），讓使用者有取消的時間。取消隨時有效。
      const startTimer = () => {
        if (!finished && timer === null) timer = setTimeout(() => finish(true), EARCON_MS + 50);
      };
      const schedule = (ctx: AudioContext) => {
        if (finished || timer !== null) return;
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
        startTimer();
      };
      if (ctx) {
        void ctx.resume().catch(() => undefined);
        // 先導到「聲音輸出」選定的裝置再出聲（系統預設時 sink 不呼叫 setSinkId，馬上完成）。
        if (output) {
          sinkWait = setTimeout(() => schedule(ctx), EARCON_SINK_WAIT_MS);
          void output.sink(ctx).catch(() => undefined).then(() => schedule(ctx));
        } else schedule(ctx);
      } else startTimer();
      return { done, cancel: () => finish(false) };
    },
  };
}
