import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FBANK_BINS, fbankFrameCount, normalizeEmbedding, speakerFbank } from "../src/speaker/fbank.ts";

// SP-01：講者特徵的前處理要和 kaldi-native-fbank（sherpa-onnx 用的同一個函式庫）一致，否則登記與辨認的特徵會偏掉。
// 參考值由 kaldi-native-fbank 1.22.5 對同一個公式產生的訊號算出（tests/fixtures/speaker-fbank-knf.json，產生方式寫在檔內）。

interface Fixture {
  cases: { samples: number; frames: number; rows: Record<string, number[]> }[];
}
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/speaker-fbank-knf.json", import.meta.url), "utf8")) as Fixture;

function signal(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) =>
    0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.2 * Math.sin((2 * Math.PI * 1375 * i) / 16000 + 0.5) + 0.05 * Math.sin((2 * Math.PI * (300 + (2000 * i) / n) * i) / 16000),
  );
}

describe("speakerFbank matches kaldi-native-fbank", () => {
  for (const c of FIXTURE.cases) {
    it(`${c.samples} samples → ${c.frames} frames, every checked row within 2e-3`, () => {
      const { features, frames } = speakerFbank(signal(c.samples));
      expect(frames).toBe(c.frames);
      expect(fbankFrameCount(c.samples)).toBe(c.frames);
      expect(features.length).toBe(frames * FBANK_BINS);
      for (const [row, want] of Object.entries(c.rows)) {
        const got = features.subarray(Number(row) * FBANK_BINS, (Number(row) + 1) * FBANK_BINS);
        const worst = Math.max(...want.map((v, i) => Math.abs(v - got[i]!)));
        expect(worst, `row ${row}`).toBeLessThan(2e-3);
      }
    });
  }

  it("each dimension has zero mean (global-mean normalisation)", () => {
    const { features, frames } = speakerFbank(signal(4000));
    for (let b = 0; b < FBANK_BINS; b++) {
      let m = 0;
      for (let f = 0; f < frames; f++) m += features[f * FBANK_BINS + b]!;
      expect(Math.abs(m / frames)).toBeLessThan(1e-4);
    }
  });

  it("empty input gives no frames instead of NaN", () => {
    expect(speakerFbank(new Float32Array(0))).toEqual({ features: new Float32Array(0), frames: 0 });
  });
});

describe("normalizeEmbedding", () => {
  it("returns a unit vector, and null for zero or non-finite input", () => {
    const e = normalizeEmbedding([3, 4])!;
    expect(Array.from(e)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(normalizeEmbedding([0, 0])).toBeNull();
    expect(normalizeEmbedding([1, Number.NaN])).toBeNull();
  });
});
