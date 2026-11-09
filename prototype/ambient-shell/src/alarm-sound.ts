import { RING_RAMP_START } from "../shared/alarm.ts";

// ALARM-1：響鈴的鈴聲。WebAudio 在本機合成（不讀檔、不連網、沒有外部素材）：一個 2 秒的循環
// （四聲短嗶、兩個音高交替，之後 1.2 秒安靜）放進 AudioBuffer 用 loop 播放，所以背景視窗的計時器被節流也不會斷音。
// 漸強交給 AudioParam 的自動化（音訊執行緒），不靠 JS 計時器。聲音從「聲音輸出」選定的裝置出來（同提示音）。

export interface RingSoundOutput {
  sink(ctx: AudioContext): Promise<void>;
  release(ctx: AudioContext): void;
}

export interface RingSoundStart {
  /** 最後的音量（0–1）。 */
  peak: number;
  /** 漸強的總長（秒）。 */
  rampS: number;
  /** 這次響鈴已經響了多久（頁面重新整理或晚加入時接著漸強，不從頭）。 */
  elapsedMs: number;
}

export interface RingSound {
  /** 開始出聲；回傳 AudioContext 是否真的在執行（false＝瀏覽器不讓出聲，例如沒有使用者手勢）。 */
  start(options: RingSoundStart): Promise<boolean>;
  /** 改最後的音量（日夜間或對話音量改變）；漸強中照比例接續。 */
  setPeak(peak: number): void;
  stop(): void;
}

const CYCLE_S = 2;
const BEEPS: readonly [start: number, freq: number][] = [[0, 1046.5], [0.2, 1318.5], [0.4, 1046.5], [0.6, 1318.5]];
const BEEP_S = 0.11;
const EDGE_S = 0.006;
/** 等聲音輸出導好的上限（同提示音）：導不好就從系統預設出聲。 */
const SINK_WAIT_MS = 1000;

/** 一個循環的樣本（純函式，測試用）：四聲短嗶，每聲有 6 ms 的淡入淡出避免爆音，振幅 0.5（加一點二倍頻讓小喇叭也清楚）。 */
export function ringCycleSamples(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(CYCLE_S * sampleRate));
  for (const [start, freq] of BEEPS) {
    const from = Math.round(start * sampleRate);
    const n = Math.round(BEEP_S * sampleRate);
    const edge = Math.max(1, Math.round(EDGE_S * sampleRate));
    for (let i = 0; i < n && from + i < out.length; i++) {
      const env = Math.min(1, i / edge, (n - 1 - i) / edge);
      const t = i / sampleRate;
      out[from + i] = 0.5 * env * (0.8 * Math.sin(2 * Math.PI * freq * t) + 0.2 * Math.sin(4 * Math.PI * freq * t));
    }
  }
  return out;
}

export function browserRingSound(output: RingSoundOutput | null = null): RingSound {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let plan: RingSoundStart | null = null;
  let startedAt = 0;

  const applyGain = () => {
    if (!ctx || !gain || !plan) return;
    const now = ctx.currentTime;
    const elapsed = plan.elapsedMs / 1000 + (now - startedAt);
    gain.gain.cancelScheduledValues(now);
    if (plan.rampS <= 0 || elapsed >= plan.rampS) {
      gain.gain.setValueAtTime(plan.peak, now);
      return;
    }
    const f = elapsed / plan.rampS;
    gain.gain.setValueAtTime(plan.peak * (RING_RAMP_START + (1 - RING_RAMP_START) * f), now);
    gain.gain.linearRampToValueAtTime(plan.peak, now + (plan.rampS - elapsed));
  };

  const stop = () => {
    const c = ctx;
    try {
      source?.stop();
    } catch {
      // 還沒開始或已經停了
    }
    source = null;
    gain = null;
    ctx = null;
    plan = null;
    if (c) {
      output?.release(c);
      void c.close().catch(() => undefined);
    }
  };

  return {
    async start(options) {
      stop();
      const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AudioCtx) return false;
      const c = new AudioCtx();
      ctx = c;
      plan = { ...options };
      if (output) {
        await Promise.race([output.sink(c).catch(() => undefined), new Promise((r) => setTimeout(r, SINK_WAIT_MS))]);
      }
      if (ctx !== c) return false;
      await c.resume().catch(() => undefined);
      if (ctx !== c) return false;
      const buffer = c.createBuffer(1, Math.round(CYCLE_S * c.sampleRate), c.sampleRate);
      buffer.copyToChannel(ringCycleSamples(c.sampleRate) as Float32Array<ArrayBuffer>, 0);
      const g = c.createGain();
      const s = c.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.connect(g).connect(c.destination);
      gain = g;
      source = s;
      startedAt = c.currentTime;
      applyGain();
      s.start();
      return c.state === "running";
    },
    setPeak(peak) {
      if (!plan) return;
      plan = { ...plan, peak, elapsedMs: plan.elapsedMs + ((ctx?.currentTime ?? startedAt) - startedAt) * 1000 };
      if (ctx) startedAt = ctx.currentTime;
      applyGain();
    },
    stop,
  };
}
