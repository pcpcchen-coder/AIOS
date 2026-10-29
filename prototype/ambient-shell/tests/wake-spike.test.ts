import { describe, expect, it } from "vitest";
import { lowpass, mixAtSnr, parseWav, pcm16leToFloat32, prng, resample, syntheticMusic, whiteNoise } from "../spike/wake/audio.ts";
import { buildKeywordsText, CANDIDATES, formatSetting, hanziToTokens, parseKeywordSpec, parseTokens, splitPinyin } from "../spike/wake/keywords.ts";
import { findAudioLike, outputDirProblem, REPO_ROOT, RESULTS_IN_REPO } from "../spike/wake/report.ts";
import { AudioRing } from "../spike/wake/ring-buffer.ts";
import { cpuPercent, estimateKeywordSeconds, hourlyBuckets, matchDetections, percentile, perHour, PERSON_CODE, realTimeFactor, sampleWallMs, speechBounds, successRate, summarize, tokenSpan } from "../spike/wake/stats.ts";
import { join } from "node:path";

// WK-00 spike 的純邏輯（docs/validation/wk-00-spike-2026-10-29.md）。不載入模型、不碰麥克風，不證明偵測準確率。

describe("wake spike keywords", () => {
  it("splits pinyin into initial + toned final, as sherpa-onnx ppinyin expects", () => {
    expect(splitPinyin("hā")).toEqual(["h", "ā"]);
    expect(splitPinyin("zhōu")).toEqual(["zh", "ōu"]);
    expect(splitPinyin("ài")).toEqual(["ài"]);
    expect(hanziToTokens("哈囉努斯")).toEqual(["h", "ā", "l", "uō", "n", "ǔ", "s", "ī"]);
    expect(hanziToTokens("嘿努斯")).toEqual(["h", "ēi", "n", "ǔ", "s", "ī"]);
    expect(() => hanziToTokens("你好")).toThrow(/no pinyin/);
  });

  it("matches the unit counts in docs/17 §3.2 (8 for 哈囉努斯, 6 for 嘿努斯, 5 ARPAbet for Hey Nous)", () => {
    expect(CANDIDATES.map((c) => [c.label, c.tokens.length])).toEqual([
      ["哈囉努斯", 8],
      ["嘿努斯", 6],
      ["Hey Nous", 5],
    ]);
  });

  it("parses boost (:) and threshold (#) in either order and rejects bad input", () => {
    const s = parseKeywordSpec("哈囉努斯:1.5#0.35, 嘿努斯#0.3:2 ,Hey Nous");
    expect(s.map(formatSetting)).toEqual(["哈囉努斯:1.5#0.35", "嘿努斯:2#0.3", "Hey Nous"]);
    expect(parseKeywordSpec("HALUO_NUSI")[0]!.candidate.label).toBe("哈囉努斯");
    // 診斷用的替代念法與子詞（不是候選詞）
    expect(parseKeywordSpec("哈囉努斯(hā-lóu),努斯").map((s) => [s.candidate.id, s.candidate.tokens.join(" "), s.candidate.variantOf])).toEqual([
      ["HALOU_NUSI", "h ā l óu n ǔ s ī", "HALUO_NUSI"],
      ["NUSI", "n ǔ s ī", "HALUO_NUSI"],
    ]);
    expect(() => parseKeywordSpec("哈囉努斯#1.5")).toThrow(/threshold/);
    expect(() => parseKeywordSpec("哈囉努斯,哈囉努斯")).toThrow(/duplicate/);
    expect(() => parseKeywordSpec("Nous")).toThrow(/unknown keyword/);
    expect(() => parseKeywordSpec(" , ")).toThrow(/no keywords/);
  });

  it("builds keyword lines with tokens, :boost, #threshold and a space-free @phrase", () => {
    const tokens = parseTokens("<blk> 0\nh 1\nā 2\nl 3\nuō 4\nn 5\nǔ 6\ns 7\nī 8\nēi 9\nHH 10\nEY1 11\nN 12\nUW1 13\nS 14\n");
    const text = buildKeywordsText(parseKeywordSpec("哈囉努斯:1.5#0.35,嘿努斯,Hey Nous#0.4"), "zh-en-3M", tokens);
    expect(text).toBe("h ā l uō n ǔ s ī :1.5 #0.35 @HALUO_NUSI\nh ēi n ǔ s ī @HEI_NUSI\nHH EY1 N UW1 S #0.4 @HEY_NOUS\n");
    for (const line of text.trim().split("\n")) expect(line.split("@")[1]).toMatch(/^\S+$/);
  });

  it("refuses English on the Chinese-only model and tokens missing from tokens.txt", () => {
    expect(() => buildKeywordsText(parseKeywordSpec("Hey Nous"), "wenetspeech-3.3M")).toThrow(/not supported/);
    expect(() => buildKeywordsText(parseKeywordSpec("嘿努斯"), "zh-en-3M", new Set(["h", "n", "ǔ", "s", "ī"]))).toThrow(/ēi/);
  });
});

describe("wake spike ring buffer", () => {
  it("keeps only the latest 2 s at 16 kHz and returns samples in order", () => {
    const ring = new AudioRing();
    expect(ring.capacity).toBe(32000);
    const r = new AudioRing(0.001, 4000); // 4 個樣本
    r.push(Float32Array.from([1, 2, 3]));
    expect([...r.latest()]).toEqual([1, 2, 3]);
    r.push(Float32Array.from([4, 5]));
    expect([...r.latest()]).toEqual([2, 3, 4, 5]);
    expect([...r.latest(2)]).toEqual([4, 5]);
    r.push(Float32Array.from([6, 7, 8, 9, 10, 11]));
    expect([...r.latest()]).toEqual([8, 9, 10, 11]);
    expect(r.pushed).toBe(11);
    expect(r.length).toBe(4);
  });

  it("cannot be serialized and clear() zeroes it", () => {
    const r = new AudioRing(0.001, 4000);
    r.push(Float32Array.from([0.5, -0.5]));
    expect(() => JSON.stringify({ r })).toThrow(/must not be serialized/);
    expect(r.rms(2)).toBeCloseTo(0.5);
    r.clear();
    expect(r.length).toBe(0);
    expect([...r.latest()]).toEqual([]);
  });
});

describe("wake spike statistics", () => {
  it("nearest-rank percentiles and summaries", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(19);
    expect(percentile(v, 50)).toBe(10);
    expect(summarize(v)).toEqual({ n: 20, mean: 10.5, p50: 10, p95: 19, min: 1, max: 20 });
    expect(summarize([])).toBeNull();
  });

  it("rates: per hour, CPU %, RTF and success rate return null instead of a fake 0", () => {
    expect(perHour(3, 7200)).toBe(1.5);
    expect(perHour(0, 0)).toBeNull();
    expect(cpuPercent(250_000, 1_000_000)).toBe(25);
    expect(cpuPercent(1, 0)).toBeNull();
    expect(realTimeFactor(2, 100)).toBe(0.02);
    expect(successRate(29, 30)).toBeCloseTo(0.9667, 3);
    expect(successRate(0, 0)).toBeNull();
  });

  it("estimates keyword length from token timestamps", () => {
    expect(tokenSpan([0.64, 0.76, 0.96, 1.96])).toEqual({ first: 0.64, last: 1.96, span: expect.closeTo(1.32) });
    expect(estimateKeywordSeconds([0.6, 0.8, 1.0, 1.2])).toBeCloseTo(0.8);
    expect(estimateKeywordSeconds([1.0])).toBeNull();
  });

  it("finds speech bounds by frame energy", () => {
    const x = new Float32Array(16000);
    for (let i = 4000; i < 12000; i++) x[i] = Math.sin(i / 5) * 0.3;
    const b = speechBounds(x, 16000)!;
    expect(b.start).toBeCloseTo(0.25, 2);
    expect(b.end).toBeCloseTo(0.75, 2);
    expect(speechBounds(new Float32Array(100), 16000)).toBeNull();
  });

  it("matches detections to positives: first hit counts, wrong keyword or repeats are false alarms", () => {
    const m = matchDetections(
      [
        { keyword: "A", start: 1, end: 2 },
        { keyword: "A", start: 5, end: 6 },
        { keyword: "B", start: 9, end: 10 },
      ],
      [
        { at: 2.2, keyword: "A" },
        { at: 2.5, keyword: "A" },
        { at: 9.5, keyword: "A" },
        { at: 20, keyword: "B" },
      ],
    );
    expect(m.hits.map((h) => [h.expected.start, h.latency])).toEqual([[1, expect.closeTo(0.2)]]);
    expect(m.misses.map((e) => e.start)).toEqual([5, 9]);
    expect(m.falseAlarms.map((d) => d.at)).toEqual([2.5, 9.5, 20]);
  });

  it("maps a sample index to wall time from the latest arrival instead of the whole block's arrival", () => {
    // 一塊 4096 個樣本（256 ms）在 t=10,000 ms 到達、累計 160,000 個樣本：塊內第一個樣本約在 9,744 ms
    expect(sampleWallMs({ sample: 160_000, wall: 10_000 }, 160_000 - 4096, 16000)).toBeCloseTo(9744, 6);
    expect(sampleWallMs({ sample: 160_000, wall: 10_000 }, 160_000, 16000)).toBe(10_000);
  });

  it("accepts only short codes for family members, never names", () => {
    for (const ok of ["A", "B2", "kid1"]) expect(PERSON_CODE.test(ok)).toBe(true);
    for (const bad of ["", "George", "小明", "A B", "A-1"]) expect(PERSON_CODE.test(bad)).toBe(false);
  });

  it("buckets events per hour", () => {
    const h = 3_600_000;
    expect(hourlyBuckets([10, h + 5, h + 6, 3 * h - 1], 0, 3 * h)).toEqual([1, 2, 1]);
    expect(hourlyBuckets([], 0, 10)).toEqual([0]);
  });
});

describe("wake spike audio helpers", () => {
  function wav(samples: number[], rate: number, channels = 1): Uint8Array {
    const data = new Int16Array(samples.map((s) => Math.round(s * 32767)));
    const buf = new ArrayBuffer(44 + data.byteLength);
    const v = new DataView(buf);
    const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF");
    v.setUint32(4, 36 + data.byteLength, true);
    w(8, "WAVE");
    w(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2 * channels, true);
    v.setUint16(32, 2 * channels, true);
    v.setUint16(34, 16, true);
    w(36, "data");
    v.setUint32(40, data.byteLength, true);
    new Uint8Array(buf, 44).set(new Uint8Array(data.buffer));
    return new Uint8Array(buf);
  }

  it("parses 16-bit PCM WAV and averages stereo to mono", () => {
    const m = parseWav(wav([0.5, -0.5, 0.25], 16000));
    expect(m.sampleRate).toBe(16000);
    expect([...m.samples].map((x) => Number(x.toFixed(2)))).toEqual([0.5, -0.5, 0.25]);
    const st = parseWav(wav([0.5, 0.1, -0.5, -0.1], 8000, 2));
    expect([...st.samples].map((x) => Number(x.toFixed(2)))).toEqual([0.3, -0.3]);
    expect(() => parseWav(new Uint8Array(12))).toThrow(/RIFF/);
  });

  it("converts s16le PCM and resamples with the right length", () => {
    expect([...pcm16leToFloat32(Uint8Array.from([0x00, 0x40, 0x00, 0xc0, 0x01]))]).toEqual([0.5, -0.5]);
    expect(resample(new Float32Array(8000), 8000, 16000).length).toBe(16000);
    expect(resample(new Float32Array(44100), 44100, 16000).length).toBe(16000);
    const x = new Float32Array(10).fill(1);
    expect(resample(x, 16000, 16000)).toBe(x);
  });

  it("lowpass keeps DC and removes a tone above the cutoff", () => {
    const dc = lowpass(new Float32Array(400).fill(1), 0.1);
    expect(dc[200]).toBeCloseTo(1, 3);
    const hi = Float32Array.from({ length: 400 }, (_, i) => Math.sin(Math.PI * 0.9 * i));
    expect(Math.abs(lowpass(hi, 0.1)[200]!)).toBeLessThan(0.01);
  });

  it("synthetic noise and music are deterministic and hit the requested RMS; mixing respects SNR", () => {
    expect(prng(1)()).toBe(prng(1)());
    const n = whiteNoise(1, 0.05, 3);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    expect(rms(n)).toBeCloseTo(0.05, 2);
    expect(rms(syntheticMusic(2, 0.05, 4))).toBeCloseTo(0.05, 3);
    expect([...whiteNoise(0.01, 0.1, 9)]).toEqual([...whiteNoise(0.01, 0.1, 9)]);
    const s = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 3) * 0.2);
    const mixed = mixAtSnr(s, n, 10);
    const noiseOnly = mixed.map((v, i) => v - s[i]!);
    expect(20 * Math.log10(rms(s) / rms(noiseOnly))).toBeCloseTo(10, 1);
  });
});

describe("wake spike report guard", () => {
  it("rejects typed arrays, buffers and long numeric arrays anywhere in a report", () => {
    expect(findAudioLike({ a: 1, b: [1, 2, 3], c: { d: "x" } })).toBeNull();
    expect(findAudioLike({ a: { b: new Float32Array(4) } })).toBe("$.a.b");
    expect(findAudioLike({ a: [{ x: Buffer.from("hi") }] })).toBe("$.a[0].x");
    expect(findAudioLike({ samples: Array.from({ length: 4000 }, () => 0.1) })).toBe("$.samples");
    expect(findAudioLike({ s: new ArrayBuffer(8) })).toBe("$.s");
  });

  it("only allows output outside the repo or under the gitignored spike/wake/results", () => {
    expect(outputDirProblem("/tmp/aios-wake-spike")).toBeNull();
    expect(outputDirProblem(RESULTS_IN_REPO)).toBeNull();
    expect(outputDirProblem(join(RESULTS_IN_REPO, "run1"))).toBeNull();
    expect(outputDirProblem(join(REPO_ROOT, "docs"))).toMatch(/results/);
    expect(outputDirProblem(REPO_ROOT)).toMatch(/results/);
  });
});
