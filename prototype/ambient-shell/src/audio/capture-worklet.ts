// 常駐喚醒聆聽的 AudioWorklet（WK-01a）：只把麥克風樣本約每 100 ms 一塊、轉移給 worker（經主執行緒交來的 MessagePort），
// 不保存、不轉檔、不送到主執行緒。收到 stop 後不再送出。

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class WakeCaptureProcessor extends AudioWorkletProcessor {
  private out: MessagePort | null = null;
  private stopped = false;
  private buf = new Float32Array(Math.round(sampleRate / 10));
  private n = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "port" && event.ports[0] && !this.out) this.out = event.ports[0];
      if (event.data?.type === "stop") {
        this.stopped = true;
        this.buf.fill(0);
        this.out?.close();
        this.out = null;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const ch = inputs[0]?.[0];
    if (!ch || !this.out) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]!;
      if (this.n === this.buf.length) {
        // 先換一塊新的，再把滿的那塊轉移給 worker：轉移後 full 會 detached（length 0），不能再拿來決定新塊的大小。
        const full = this.buf;
        this.buf = new Float32Array(full.length);
        this.n = 0;
        this.out.postMessage(full, [full.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("nous-wake-capture", WakeCaptureProcessor);
