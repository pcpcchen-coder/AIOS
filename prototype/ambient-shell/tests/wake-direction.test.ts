import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../shared/wake-runtime.json" with { type: "json" };
import { wakeKeywordsText, type WakeRuntimeManifest } from "../shared/wake.ts";
import {
  Chunker,
  averageMix,
  conditionLabel,
  emptyResults,
  nextCell,
  offsetKeywords,
  parseResults,
  pickSource,
  planVariants,
  plannedTrials,
  micSlug,
  skippedVariants,
  productDownmix,
  productMixRule,
  PRODUCT_CONDITION,
  rmsDbfs,
  summarize,
  toCsv,
  wilson,
  type Results,
  type Trial,
} from "../spike/wake/direction/logic.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DIRECTION_CSP, contentTypeFor, readVerifiedRuntime, runtimeFileFor } from "../spike/wake/direction/serve.ts";

// 喚醒方向性診斷（docs/validation/wake-direction-2026-11-08.md）。所有音訊都是程式產生的合成測試音（fixture），
// 不是錄音，也不代表 eMeet M0 Plus 的實機行為；這裡只驗證混音規則、門檻位移、統計公式與頁面的隱私邊界。

const app = join(import.meta.dirname, "..");
const dir = join(app, "spike", "wake", "direction");

/** fixture：48 kHz、0.1 秒、振幅 a 的 1 kHz 正弦波。 */
const tone = (a = 0.5, n = 4800) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * i) / 48_000));
const silence = (n = 4800) => new Float32Array(n);

describe("product mix rule (emulates the product AudioWorkletNode: channelCount 1, explicit, speakers)", () => {
  it("averages 2 and 4 channels, uses the 5.1 formula for 6, and keeps only channel 1 for other counts", () => {
    expect([1, 2, 3, 4, 5, 6, 8].map(productMixRule)).toEqual(["copy", "average", "first_only", "average", "first_only", "5.1", "first_only"]);
  });

  it("fixture: a voice that only reaches channel 3 of 4 is 12.04 dB quieter after the product mix (average of 4)", () => {
    const voice = tone();
    const input = [silence(), silence(), voice, silence()];
    // 20·log10(1/4) = −12.04 dB
    expect(rmsDbfs(productDownmix(input)) - rmsDbfs(voice)).toBeCloseTo(20 * Math.log10(0.25), 2);
    expect(rmsDbfs(pickSource(input, { kind: "channel", index: 2 }))).toBeCloseTo(rmsDbfs(voice), 6);
  });

  it("fixture: with 3 channels the product hears nothing from channels 2–3, the average still does", () => {
    const input = [silence(), tone(), tone()];
    expect(rmsDbfs(productDownmix(input))).toBe(-Infinity);
    // 平均：(0 + v + v)/3 → 20·log10(2/3) = −3.52 dB
    expect(rmsDbfs(averageMix(input)) - rmsDbfs(tone())).toBeCloseTo(20 * Math.log10(2 / 3), 2);
  });

  it("5.1 down-mix follows 0.7071·(L+R) + C + 0.5·(SL+SR) and ignores LFE", () => {
    const one = (v: number) => Float32Array.of(v);
    expect(productDownmix([one(1), one(1), one(1), one(9), one(1), one(1)])[0]).toBeCloseTo(2 * Math.SQRT1_2 + 1 + 1, 6);
  });

  it("mono and empty inputs", () => {
    expect([...productDownmix([Float32Array.of(0.1, 0.2)])]).toEqual([Float32Array.of(0.1)[0], Float32Array.of(0.2)[0]]);
    expect(productDownmix([]).length).toBe(0);
    expect(rmsDbfs(new Float32Array(0))).toBe(-Infinity);
    // 振幅 0.5 的正弦波 RMS = 0.5/√2 → −9.03 dBFS
    expect(rmsDbfs(tone())).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 2);
  });
});

describe("detector variants and threshold offsets", () => {
  const k = (manifest as WakeRuntimeManifest).keywords;

  it("offsets the global threshold and every explicit line threshold, keeps boosts, clamps to 0.01–0.99", () => {
    const up = offsetKeywords(k, 0.05);
    expect(up.keywords_threshold).toBe(0.2);
    expect(up.keywords_score).toBe(k.keywords_score);
    expect(up.entries.filter((e) => e.id.startsWith("HEY")).map((e) => [e.boost, e.threshold])).toEqual([[1, 0.3], [1, 0.3], [1, 0.3]]);
    expect(up.entries.filter((e) => e.id.startsWith("HELLO")).every((e) => e.threshold === null)).toBe(true);
    expect(wakeKeywordsText(up)).toContain("HH EY1 N OW1 S :1 #0.3 @HEY_NOUS_OW");
    expect(offsetKeywords(k, -0.5).keywords_threshold).toBe(0.01);
    expect(offsetKeywords(k, 0.95).entries.find((e) => e.id === "HEY_NOUS_OW")!.threshold).toBe(0.99);
    // 0 是產品設定本身；原物件不被修改
    expect(offsetKeywords(k, 0)).toEqual(k);
    expect(k.keywords_threshold).toBe(0.15);
  });

  it("plans product-mix detectors per offset, then per channel; adds an average only when the product would drop channels", () => {
    expect(planVariants(1, [0.1, 0.05, 0, -0.05], true).map((v) => v.id)).toEqual(["product+0.10", "product+0.05", "product+0.00", "product-0.05"]);
    expect(planVariants(4, [0], true).map((v) => v.id)).toEqual(["product+0.00", "ch1+0.00", "ch2+0.00", "ch3+0.00", "ch4+0.00"]);
    expect(planVariants(3, [0], false).map((v) => v.id)).toEqual(["product+0.00", "average+0.00"]);
    expect(planVariants(8, [0.1, 0.05, 0, -0.05], true).length).toBe(10);
    // 4 個門檻 + 平均 + 8 個聲道 = 13，上限 10 → 略過 3 個（畫面照實說）
    expect(skippedVariants(8, [0.1, 0.05, 0, -0.05], true)).toBe(3);
    expect(skippedVariants(1, [0.1, 0.05, 0, -0.05], true)).toBe(0);
    // 產品門檻一定有，即使沒有勾 0
    expect(planVariants(2, [], false).map((v) => v.id)).toEqual(["product+0.00"]);
    expect(planVariants(1, [0.05], false).map((v) => v.id)).toEqual(["product+0.05", "product+0.00"]);
    // 6 聲道：產品用 5.1 公式，和平均不同，所以也加平均
    expect(planVariants(6, [0], false).map((v) => v.id)).toEqual(["product+0.00", "average+0.00"]);
  });

  it("Chunker emits fixed 100 ms blocks in order, keeps working after the block is transferred, and zeroes the remainder on stop", () => {
    const out: Float32Array[] = [];
    const c = new Chunker(4800, (full) => out.push(structuredClone(full, { transfer: [full.buffer] })));
    for (let q = 0; q < 152; q++) c.push(Float32Array.from({ length: 128 }, (_, i) => q * 128 + i));
    expect(out.map((b) => b.length)).toEqual([4800, 4800, 4800, 4800]);
    expect(out[1]![0]).toBe(4800);
    c.stop();
    c.push(new Float32Array(4800 - 1));
    expect(out.length).toBe(4);
  });
});

describe("direction-test statistics (formulas documented in the validation doc)", () => {
  it("plans 8 angles × 2 distances × 2 phrases × 5 = 160 trials", () => {
    expect(plannedTrials()).toBe(160);
  });

  it("Wilson 95% interval: 5/5 → 56.6–100 %, 0/5 → 0–43.4 %, 3/5 → 23.1–88.2 %", () => {
    const full = wilson(5, 5);
    expect(full.rate).toBe(1);
    expect(full.low).toBeCloseTo(0.5655, 3);
    expect(full.high).toBe(1);
    expect(wilson(0, 5).high).toBeCloseTo(0.4345, 3);
    expect(wilson(3, 5).low).toBeCloseTo(0.2307, 3);
    expect(wilson(3, 5).high).toBeCloseTo(0.8824, 3);
    expect(wilson(0, 0)).toEqual({ hits: 0, n: 0, rate: null, low: null, high: null });
  });

  const cond = conditionLabel(PRODUCT_CONDITION);
  const trial = (angle: Trial["angle"], hit: boolean, extra: Partial<Trial> = {}): Trial => ({ condition: cond, angle, distance: "1m", phrase: "hello", hits: { "product+0.00": hit, "product-0.05": true }, ...extra });

  it("summarizes per cell, per angle, overall, spread, worst angle and false triggers per hour", () => {
    const r: Results = emptyResults();
    for (let i = 0; i < 5; i++) r.trials.push(trial(0, true));
    for (let i = 0; i < 5; i++) r.trials.push(trial(180, i < 2));
    r.trials.push(trial(90, true, { distance: "3m", phrase: "hey" }));
    r.trials.push({ ...trial(90, true), condition: "ec0-ns0-agc0-ch:default-mic:default" });
    r.negatives.push({ condition: cond, kind: "tv", seconds: 1800, triggers: { "product+0.00": 2 } });
    const s = summarize(r, cond, "product+0.00");
    expect(cond).toBe("ec1-ns1-agc1-ch:default-mic:default");
    expect(conditionLabel(PRODUCT_CONDITION, "EMEET OfficeCore M0 Plus (328f:00a0)")).toBe("ec1-ns1-agc1-ch:default-mic:emeetofficecorem");
    expect(micSlug("MacBook Pro Microphone")).toBe("macbookpromicrop");
    expect(micSlug("  ")).toBe("default");
    expect(s.cells[0]!["1m"]!["hello"]).toMatchObject({ hits: 5, n: 5, rate: 1 });
    expect(s.byAngle[180]).toMatchObject({ hits: 2, n: 5, rate: 0.4 });
    expect(s.byAngle[90]).toMatchObject({ hits: 1, n: 1 });
    expect(s.byAngle[45]!.rate).toBeNull();
    expect(s.overall).toMatchObject({ hits: 8, n: 11 });
    // 有資料的方向：0° 100 %、90° 100 %、180° 40 % → 差距 60 個百分點，最差 180°
    expect(s.spread).toBeCloseTo(0.6, 9);
    expect(s.worstAngles).toEqual([180]);
    // 2 次 ÷ (1800 s ÷ 3600) = 4 次每小時
    expect(s.negatives.tv).toEqual({ seconds: 1800, triggers: 2, perHour: 4 });
    expect(s.negatives.chat!.perHour).toBeNull();
    expect(summarize(r, cond, "product-0.05").byAngle[180]).toMatchObject({ hits: 5, n: 5 });
  });

  it("walks the cells phrase → distance → angle and stops after 160", () => {
    const r = emptyResults();
    expect(nextCell(r, cond)).toEqual({ angle: 0, distance: "1m", phrase: "hello" });
    for (let i = 0; i < 5; i++) r.trials.push(trial(0, true));
    expect(nextCell(r, cond)).toEqual({ angle: 45, distance: "1m", phrase: "hello" });
    r.trials = [];
    for (const phrase of ["hello", "hey"] as const)
      for (const distance of ["1m", "3m"] as const)
        for (const angle of [0, 45, 90, 135, 180, 225, 270, 315] as const) for (let i = 0; i < 5; i++) r.trials.push(trial(angle, true, { distance, phrase }));
    expect(r.trials.length).toBe(160);
    expect(nextCell(r, cond)).toBeNull();
  });

  it("CSV has counts only; JSON export round-trips and rejects sample arrays or unknown cells", () => {
    const r = emptyResults();
    r.trials.push(trial(45, false));
    r.negatives.push({ condition: cond, kind: "chat", seconds: 600, triggers: { "product+0.00": 1 } });
    const csv = toCsv(r);
    expect(csv.split("\n")[0]).toBe("condition,variant,angle,distance,phrase,hits,trials,rate,wilson_low,wilson_high");
    expect(csv).toContain("ec1-ns1-agc1-ch:default-mic:default,product+0.00,45,1m,hello,0,1,0.000,0.000,0.793");
    expect(csv).toContain("negative:chat,1,600s,6.00/h");
    expect(parseResults(JSON.stringify(r))).toEqual(r);
    expect(() => parseResults(JSON.stringify({ ...r, trials: [{ ...r.trials[0], angle: 30 }] }))).toThrow();
    expect(() => parseResults(JSON.stringify({ ...r, trials: [{ ...r.trials[0], hits: { "product+0.00": [0.1, 0.2] } }] }))).toThrow();
    expect(() => parseResults(JSON.stringify({ ...r, negatives: [{ ...r.negatives[0], triggers: { x: -1 } }] }))).toThrow();
    expect(() => parseResults("[]")).toThrow();
  });
});

describe("direction AudioWorklet (Node harness with real structuredClone transfers)", () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakePort {
    onmessage: ((event: { data: unknown; ports: FakePort[] }) => void) | null = null;
    readonly posted: unknown[] = [];
    closed = false;
    postMessage(data: unknown, transfer: Transferable[] = []): void {
      this.posted.push(structuredClone(data, { transfer }));
    }
    close(): void {
      this.closed = true;
    }
  }

  it("reports channel count and levels to the page (numbers only) and sends each detector its own source", async () => {
    vi.resetModules();
    let Ctor: (new () => { port: FakePort; process(i: Float32Array[][]): boolean }) | null = null;
    vi.stubGlobal("sampleRate", 48_000);
    vi.stubGlobal("AudioWorkletProcessor", class { readonly port = new FakePort(); });
    vi.stubGlobal("registerProcessor", (_n: string, c: typeof Ctor) => (Ctor = c));
    await import("../spike/wake/direction/worklet.ts");
    const p = new Ctor!();
    const product = new FakePort();
    const ch2 = new FakePort();
    p.port.onmessage!({ data: { type: "routes", sources: [{ kind: "product" }, { kind: "channel", index: 1 }] }, ports: [product, ch2] });
    // fixture：2 聲道，聲道 1 靜音、聲道 2 是常數 0.4
    for (let q = 0; q < 40; q++) p.process([[new Float32Array(128), new Float32Array(128).fill(0.4)]]);
    const levels = p.port.posted as { type: string; channels: number; rmsDb: number[]; peaks: number[] }[];
    expect(levels[0]!.type).toBe("levels");
    expect(levels[0]!.channels).toBe(2);
    expect(levels[0]!.rmsDb[0]).toBe(-120);
    expect(levels[0]!.rmsDb[1]).toBeCloseTo(20 * Math.log10(0.4), 4);
    expect(levels.every((m) => Object.values(m).every((v) => !ArrayBuffer.isView(v)))).toBe(true);
    // 40 × 128 = 5120 樣本 → 每個偵測器 1 塊 4800；產品混音 = 平均 0.2，聲道 2 = 0.4
    expect((product.posted[0] as Float32Array)[0]).toBeCloseTo(0.2, 6);
    expect((ch2.posted[0] as Float32Array)[0]).toBeCloseTo(0.4, 6);
    p.port.onmessage!({ data: { type: "stop" }, ports: [] });
    expect(product.closed && ch2.closed).toBe(true);
    expect(p.process([[new Float32Array(128)]])).toBe(false);
  });
});

describe("direction page privacy boundary (static)", () => {
  it("serves only listed engine files under /wake-runtime/", () => {
    const listed = (manifest as WakeRuntimeManifest).files[0]!.name;
    expect(runtimeFileFor(`/wake-runtime/${listed}`, "/x")).toBe(`/x/${listed}`);
    expect(runtimeFileFor(`/wake-runtime/${listed}?v=1`, "/x")).toBe(`/x/${listed}`);
    for (const bad of ["/wake-runtime/../package.json", "/wake-runtime/secret.txt", "/wake-runtime/", "/other/" + listed, `/wake-runtime/sub/${listed}`]) expect(runtimeFileFor(bad, "/x")).toBeNull();
    expect(contentTypeFor("a.mjs")).toMatch(/javascript/);
    // 和核心一樣每次讀取都核對雜湊：內容被換掉就 404（worker 的 import() 重新讀取時也受保護）
    const tmp = mkdtempSync(join(tmpdir(), "wake-direction-"));
    writeFileSync(join(tmp, listed), "tampered");
    expect(readVerifiedRuntime(`/wake-runtime/${listed}`, tmp)).toBeNull();
    expect(readVerifiedRuntime("/wake-runtime/not-listed.txt", tmp)).toBeNull();
    expect(contentTypeFor("a.wasm")).toBe("application/wasm");
  });

  it("is local only: 127.0.0.1:5184 and a same-origin CSP", () => {
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toMatch(/(^|; )connect-src 'self' ws:\/\/127\.0\.0\.1:5184(;|$)/);
    expect(csp).toMatch(/(^|; )default-src 'self'(;|$)/);
    const vite = readFileSync(join(dir, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/host: "127\.0\.0\.1", port: 5184/);
    // meta CSP 只管頁面；開發伺服器對每個回應（含 worker 腳本）都送同一組 CSP
    expect(vite).toMatch(/headers: \{ "Content-Security-Policy": DIRECTION_CSP \}/);
    expect(DIRECTION_CSP).toMatch(/(^|; )connect-src 'self' ws:\/\/127\.0\.0\.1:5184(;|$)/);
    expect(DIRECTION_CSP).toMatch(/(^|; )default-src 'self'(;|$)/);
  });

  it("the page thread never receives samples: only levels from the worklet and WakeWorkerOut events from workers", () => {
    const page = readFileSync(join(dir, "page.ts"), "utf8");
    expect(page).toMatch(/event\.data\?\.type !== "levels"/);
    expect(page).toMatch(/!isWakeWorkerOut\(event\.data\)/);
    // 主執行緒沒有自己的 AudioWorkletNode port 以外的樣本來源，也不 new Float32Array
    expect(page).not.toMatch(/Float32Array/);
    const worker = readFileSync(join(dir, "worker.ts"), "utf8");
    expect(worker).toMatch(/new SherpaWasmDetector\(runtime, net\)/);
    // worker 只送兩種東西給主執行緒：WakeWorkerCore 的事件（out）與 closed
    expect([...worker.matchAll(/\bpostMessage\(([^;]*)\);/g)].map((m) => m[1])).toEqual(["out)", '{ type: "closed" }']);
  });
});
