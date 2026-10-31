// WK-00：AudioWorklet 只把麥克風樣本依序交給主執行緒（約每 100 ms 一包），不保存、不轉檔。
// 主執行緒收到後轉 16 kHz、放進 2 秒環形緩衝並送進 KWS，用完以 0 覆寫。

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.round(sampleRate / 10));
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]!;
      if (this.n === this.buf.length) {
        // 先換一塊新的，再把滿的那塊轉移給主執行緒：轉移後 full 會 detached（length 0），不能再拿來決定新塊的大小。
        const full = this.buf;
        this.buf = new Float32Array(full.length);
        this.n = 0;
        this.port.postMessage(full, [full.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("wk00-capture", CaptureProcessor);
