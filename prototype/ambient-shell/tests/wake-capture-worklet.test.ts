import { afterEach, describe, expect, it, vi } from "vitest";

// 擷取用的 AudioWorklet（產品 src/audio/capture-worklet.ts 與 WK-00 spike/wake/capture-worklet.ts）在 Node 裡以假的
// AudioWorkletGlobalScope 載入。postMessage 以 structuredClone 真的轉移 ArrayBuffer，所以送出的那塊會 detached，和瀏覽器一樣。
// 2026-10-31 Mac：舊寫法在轉移後才讀 this.buf.length（已是 0），之後每塊都是長度 0，偵測器只收到第一塊 100 ms，喚醒永遠不會觸發。

type Posted = { data: Float32Array; transferred: boolean };

class FakePort {
  onmessage: ((event: { data: unknown; ports: FakePort[] }) => void) | null = null;
  readonly posted: Posted[] = [];
  postMessage(data: unknown, transfer: Transferable[] = []): void {
    const copy = structuredClone(data, { transfer }) as Float32Array;
    this.posted.push({ data: copy, transferred: transfer.length > 0 });
  }
  close(): void {}
}

interface Processor {
  readonly port: FakePort;
  process(inputs: Float32Array[][]): boolean;
}

async function loadProcessor(path: string): Promise<Processor> {
  vi.resetModules();
  let ctor: (new () => Processor) | null = null;
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = new FakePort();
    },
  );
  vi.stubGlobal("registerProcessor", (_name: string, c: new () => Processor) => {
    ctor = c;
  });
  await import(path);
  expect(ctor).not.toBeNull();
  return new ctor!();
}

/** 128 樣本一個 render quantum；第 i 個樣本的值是 i（方便核對順序）。 */
function feed(p: Processor, quanta: number, start = 0): void {
  for (let q = 0; q < quanta; q++) {
    const frame = Float32Array.from({ length: 128 }, (_, i) => start + q * 128 + i);
    expect(p.process([[frame]])).toBe(true);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("capture AudioWorklet keeps sending full 100 ms chunks after transferring each one", () => {
  it("product (src/audio/capture-worklet.ts): every chunk is 4800 samples at 48 kHz, in order, over its MessagePort", async () => {
    const p = await loadProcessor("../src/audio/capture-worklet.ts");
    const out = new FakePort();
    p.port.onmessage!({ data: { type: "port" }, ports: [out] });
    // 4 塊多一點（4 × 4800 = 19200 樣本 = 150 個 quantum）
    feed(p, 152);
    expect(out.posted.map((m) => m.data.length)).toEqual([4800, 4800, 4800, 4800]);
    expect(out.posted.every((m) => m.transferred)).toBe(true);
    // 每塊接續上一塊，沒有漏或重複
    out.posted.forEach((m, k) => {
      expect(m.data[0]).toBe(k * 4800);
      expect(m.data[4799]).toBe(k * 4800 + 4799);
    });
  });

  it("product: nothing is sent before the port arrives or after stop", async () => {
    const p = await loadProcessor("../src/audio/capture-worklet.ts");
    feed(p, 80);
    const out = new FakePort();
    p.port.onmessage!({ data: { type: "port" }, ports: [out] });
    feed(p, 40);
    expect(out.posted).toHaveLength(1);
    p.port.onmessage!({ data: { type: "stop" }, ports: [] });
    expect(p.process([[new Float32Array(128)]])).toBe(false);
    expect(out.posted).toHaveLength(1);
  });

  it("WK-00 spike (spike/wake/capture-worklet.ts): same chunking over its own port", async () => {
    const p = await loadProcessor("../spike/wake/capture-worklet.ts");
    feed(p, 152);
    expect(p.port.posted.map((m) => m.data.length)).toEqual([4800, 4800, 4800, 4800]);
    expect(p.port.posted[3]!.data[0]).toBe(3 * 4800);
  });
});
