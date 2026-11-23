import { COUNTDOWN_TICK_S, RING_RAMP_START, type RingTone } from "../shared/alarm.ts";

// ALARM-1：響鈴的鈴聲。WebAudio 在本機合成（不讀檔、不連網、沒有外部素材）：一個 2 秒的循環
// （四聲短嗶、兩個音高交替，之後 1.2 秒安靜）放進 AudioBuffer 用 loop 播放，所以背景視窗的計時器被節流也不會斷音。
// 漸強交給 AudioParam 的自動化（音訊執行緒），不靠 JS 計時器。聲音從「聲音輸出」選定的裝置出來（同提示音）。

export interface RingSoundOutput {
  sink(ctx: AudioContext): Promise<void>;
  release(ctx: AudioContext): void;
}

export interface RingSoundStart {
  /** ALARM-3：哪一種鈴聲（預設 classic）。 */
  tone?: RingTone;
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

/**
 * ALARM-3：三種鈴聲的循環。classic：四聲短嗶後安靜（2 秒）；chime：三個下行的鐘聲、慢慢衰減（3 秒）；
 * pulse：八聲急促的高音短嗶後短暫安靜（1.5 秒）。
 */
interface ToneSpec {
  cycleS: number;
  notes: readonly { start: number; freq: number; dur: number; decay?: number }[];
}
const TONES: Record<RingTone, ToneSpec> = {
  classic: { cycleS: 2, notes: [0, 0.2, 0.4, 0.6].map((start, i) => ({ start, freq: i % 2 ? 1318.5 : 1046.5, dur: 0.11 })) },
  chime: { cycleS: 3, notes: [{ start: 0, freq: 1318.5, dur: 1.2, decay: 3.5 }, { start: 0.45, freq: 1046.5, dur: 1.2, decay: 3.5 }, { start: 0.9, freq: 784, dur: 1.8, decay: 2.5 }] },
  pulse: { cycleS: 1.5, notes: Array.from({ length: 8 }, (_, i) => ({ start: i * 0.1, freq: 2093, dur: 0.05 })) },
};
const EDGE_S = 0.006;
/** 等聲音輸出導好的上限（同提示音）：導不好就從系統預設出聲。 */
const SINK_WAIT_MS = 1000;

/** 一個循環的樣本（純函式，測試用）：每聲有 6 ms 的淡入淡出避免爆音（鐘聲另有指數衰減），振幅不超過 0.5（加一點二倍頻讓小喇叭也清楚）。 */
export function ringCycleSamples(sampleRate: number, tone: RingTone = "classic"): Float32Array {
  const spec = TONES[tone];
  const out = new Float32Array(Math.round(spec.cycleS * sampleRate));
  for (const note of spec.notes) {
    const from = Math.round(note.start * sampleRate);
    const n = Math.round(note.dur * sampleRate);
    const edge = Math.max(1, Math.round(EDGE_S * sampleRate));
    for (let i = 0; i < n && from + i < out.length; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, i / edge, (n - 1 - i) / edge) * (note.decay ? Math.exp(-note.decay * t) : 1);
      out[from + i] += 0.5 * env * (0.8 * Math.sin(2 * Math.PI * note.freq * t) + 0.2 * Math.sin(4 * Math.PI * note.freq * t));
    }
  }
  // 鐘聲重疊時可能超過 0.5：整體縮回去，不削波。
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.5) for (let i = 0; i < out.length; i++) out[i] = (out[i]! * 0.5) / peak;
  return out;
}

export function ringCycleSeconds(tone: RingTone = "classic"): number {
  return TONES[tone].cycleS;
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
      const tone = options.tone ?? "classic";
      const buffer = c.createBuffer(1, Math.round(ringCycleSeconds(tone) * c.sampleRate), c.sampleRate);
      buffer.copyToChannel(ringCycleSamples(c.sampleRate, tone) as Float32Array<ArrayBuffer>, 0);
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

/**
 * ALARM-3：到期前最後 10 秒每秒一聲「滴」（約 60 ms、1760 Hz）。用 AudioContext 的時間一次排好，背景視窗的計時器被節流也準時；
 * 到期那一刻不排（接著就是鈴聲）。stop() 立刻停（取消、暫停、停止或鈴聲開始時）。
 */
export interface TickSound {
  /** dueInMs：離到期還有多久。回傳 AudioContext 是否真的在執行。 */
  start(dueInMs: number, peak: number): Promise<boolean>;
  stop(): void;
}

/** 這一刻（距到期 dueInMs）之後要響的滴答：距到期 10、9…1 秒，各自離現在多少秒（純函式，測試用）。 */
export function tickOffsets(dueInMs: number, ticks = COUNTDOWN_TICK_S): number[] {
  const out: number[] = [];
  for (let k = ticks; k >= 1; k--) {
    const at = dueInMs / 1000 - k;
    if (at >= -0.05) out.push(Math.max(0, at));
  }
  return out;
}

export function browserTickSound(output: RingSoundOutput | null = null): TickSound {
  let ctx: AudioContext | null = null;
  const stop = () => {
    const c = ctx;
    ctx = null;
    if (c) {
      output?.release(c);
      void c.close().catch(() => undefined);
    }
  };
  return {
    async start(dueInMs, peak) {
      stop();
      const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AudioCtx) return false;
      const c = new AudioCtx();
      ctx = c;
      const asked = performance.now();
      if (output) await Promise.race([output.sink(c).catch(() => undefined), new Promise((r) => setTimeout(r, SINK_WAIT_MS))]);
      await c.resume().catch(() => undefined);
      if (ctx !== c) return false;
      const base = c.currentTime + 0.01;
      for (const off of tickOffsets(dueInMs - (performance.now() - asked))) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = "sine";
        osc.frequency.value = 1760;
        const t0 = base + off;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.35 * peak, t0 + 0.005);
        g.gain.linearRampToValueAtTime(0, t0 + 0.06);
        osc.connect(g).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + 0.07);
      }
      return c.state === "running";
    },
    stop,
  };
}
