// SP-01 speaker worker 的行為：樣本經 MessagePort 進來、begin/end 之間收一段、算出特徵。模型以假 session 取代。
// 回歸：16 kHz 不用轉換時，曾在量音量與收進段落之前就把樣本覆寫成 0，每一段都變成「沒有聽到聲音」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeakerWorkerRequest, SpeakerWorkerResponse } from "../src/speaker/protocol.ts";

vi.mock("onnxruntime-web/wasm", () => ({
  env: { wasm: {} },
  Tensor: class {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
  InferenceSession: {
    create: async () => ({
      run: async () => ({ embedding: { data: Float32Array.from({ length: 192 }, (_, i) => (i % 2 ? 1 : -1)) } }),
      release: async () => {},
    }),
  },
}));

type Scope = { postMessage(m: SpeakerWorkerResponse): void; onmessage: ((e: { data: SpeakerWorkerRequest; ports: MessagePort[] }) => void) | null };
let scope: Scope;
let out: SpeakerWorkerResponse[];

beforeEach(async () => {
  vi.resetModules();
  out = [];
  scope = { postMessage: (m) => out.push(m), onmessage: null };
  (globalThis as { self?: unknown }).self = scope;
  await import("../src/speaker/worker.ts");
});
afterEach(() => {
  delete (globalThis as { self?: unknown }).self;
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
};

function chunks(seconds: number, amp: number, sr: number): Float32Array[] {
  const n = Math.round(seconds * sr);
  const all = Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr));
  const size = Math.round(sr / 10);
  const list: Float32Array[] = [];
  for (let o = 0; o < n; o += size) list.push(all.slice(o, o + size));
  return list;
}

async function recordSegment(sampleRate: number) {
  scope.onmessage!({ data: { type: "init", assets: { wasmPrefix: "/speaker-runtime/", model: "/speaker-runtime/m.onnx" } }, ports: [] });
  await until(() => out.some((m) => m.type === "ready"));
  const channel = new MessageChannel();
  scope.onmessage!({ data: { type: "port", sampleRate }, ports: [channel.port2] });
  scope.onmessage!({ data: { type: "begin", id: 1 }, ports: [] });
  // 0.5 s 安靜 + 1.5 s 聲音 + 0.5 s 安靜
  for (const c of [...chunks(0.5, 0, sampleRate), ...chunks(1.5, 0.2, sampleRate), ...chunks(0.5, 0, sampleRate)]) channel.port1.postMessage(c);
  await until(() => out.filter((m) => m.type === "level").length >= 24);
  scope.onmessage!({ data: { type: "end", id: 1, min_voiced_ms: 1000 }, ports: [] });
  await until(() => out.some((m) => m.type === "segment"));
  channel.port1.close();
  return out.find((m) => m.type === "segment") as Extract<SpeakerWorkerResponse, { type: "segment" }>;
}

describe("speaker worker", () => {
  for (const sr of [16000, 48000]) {
    it(`${sr} Hz: the level meter sees the voice and the segment gets a 192-d feature`, async () => {
      const seg = await recordSegment(sr);
      expect(seg.problem).toBeNull();
      expect(seg.voiced_ms).toBeGreaterThanOrEqual(1400);
      expect(seg.feature).toHaveLength(192);
      const levels = out.filter((m): m is Extract<SpeakerWorkerResponse, { type: "level" }> => m.type === "level").map((m) => m.rms);
      expect(Math.max(...levels)).toBeGreaterThan(0.1);
    });
  }
});
