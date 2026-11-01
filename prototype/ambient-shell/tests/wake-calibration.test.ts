import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { settingsMenu } from "../desktop/settings-menu.mjs";
import { WakeCalibrationCore } from "../src/audio/calibration-core.ts";
import { WakeController, type WakeCalibrationEvents, type WakeHost } from "../src/audio/controller.ts";
import { kwsConfig, SherpaWasmDetector, type WakeDetector, type WakeScanner } from "../src/audio/detector.ts";
import { AudioFrontEnd } from "../src/audio/front-end.ts";
import { createRuntimeNet } from "../src/audio/runtime-net.ts";
import { WakeSettingsStore } from "../server/wake-settings.ts";
import { translate } from "../shared/i18n.mjs";
import type { SettingsView } from "../shared/types.ts";
import {
  CALIBRATION_PROMPTS,
  overridesFromAdvice,
  recommend,
  scoreCandidates,
  sweepCandidates,
  WAKE_MANIFEST,
  type ClipResult,
} from "../shared/wake-calibration.ts";
import {
  applyKeywordOverrides,
  isWakeWorkerOut,
  parseKeywordOverrides,
  parseSweepCandidates,
  parseWakePatch,
  WAKE_RELEASE_FILES,
  WAKE_TEXT,
  WakePatchError,
  wakeKeywordsText,
  type WakeKeywordOverrides,
  type WakeReport,
  type WakeSettingsView,
  type WakeWorkerOut,
} from "../shared/wake.ts";
import { FakeCapture, FakeClock, FakeEarcon, FakeMediaDevices, FakeStream, flush } from "./fixtures/wake.ts";
import { builtTestManifest, engineControls, fakeGlue, fakeScope, upstreamApiModule, type FakeKwsModule } from "./fixtures/wake-wasm.ts";

// 「矯正喚醒詞…」（George 2026-11-01）。假的麥克風、擷取圖與 Emscripten 模組都是 **fixture**：這些測試只證明流程、保存、
// 門檻覆寫與錄音清除的程式路徑，**不證明偵測準確度**；家人的實測數字見 docs/validation/。

const HEY: WakeKeywordOverrides = { groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "lion", at: null };

describe("keyword_overrides: validation and how they cover the manifest", () => {
  it("accepts a code of 1–4 letters/digits and per-group boost/threshold inside the calibration limits", () => {
    expect(parseKeywordOverrides(null)).toBeNull();
    expect(parseKeywordOverrides({ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "A1" })).toEqual({ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "A1", at: null });
    // 小數四捨五入到兩位
    expect(parseKeywordOverrides({ groups: { HEY_NOUS: { boost: 1.004, threshold: 0.2049 } }, code: "x" })!.groups.HEY_NOUS).toEqual({ boost: 1, threshold: 0.2 });
    expect(parseWakePatch({ keyword_overrides: null })).toEqual({ keyword_overrides: null });
  });

  it.each<[unknown, string]>([
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "" }, "empty code"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "lions" }, "code too long"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "小明" }, "a name instead of a code"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.01 } }, code: "a" }, "threshold below 0.05"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.9 } }, code: "a" }, "threshold above 0.5"],
    [{ groups: { HEY_NOUS: { boost: 9, threshold: 0.2 } }, code: "a" }, "boost above 3"],
    [{ groups: { hey: { boost: 1, threshold: 0.2 } }, code: "a" }, "bad group name"],
    [{ groups: {}, code: "a" }, "no groups"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2, extra: 1 } }, code: "a" }, "extra tuning key"],
    [{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 } }, code: "a", name: "George" }, "extra key"],
    ["HEY_NOUS:1.0#0.2", "a string"],
  ])("rejects %j (%s)", (value) => {
    expect(() => parseKeywordOverrides(value)).toThrow(WakePatchError);
    expect(() => parseWakePatch({ keyword_overrides: value })).toThrow(WakePatchError);
  });

  it("covers every line of a group (all three Nous pronunciations) and leaves other groups and the shipped manifest untouched", () => {
    const before = JSON.stringify(WAKE_MANIFEST.keywords);
    const k = applyKeywordOverrides(WAKE_MANIFEST.keywords, HEY);
    expect(JSON.stringify(WAKE_MANIFEST.keywords)).toBe(before);
    expect(wakeKeywordsText(k)).toBe(
      "HH AH0 L OW1 N OW1 S @HELLO_NOUS_OW\nHH AH0 L OW1 N AW1 S @HELLO_NOUS_AW\nHH AH0 L OW1 N UW1 S @HELLO_NOUS_UW\n"
        + "HH EY1 N OW1 S :1 #0.2 @HEY_NOUS_OW\nHH EY1 N AW1 S :1 #0.2 @HEY_NOUS_AW\nHH EY1 N UW1 S :1 #0.2 @HEY_NOUS_UW\n",
    );
    // Hello 三行沒有自己的值時用全域 1.5／0.15；矯正後三行都帶自己的值
    const hello = applyKeywordOverrides(WAKE_MANIFEST.keywords, { groups: { HELLO_NOUS: { boost: 1.5, threshold: 0.1 } }, code: "a", at: null });
    expect(hello.entries.filter((e) => e.id.startsWith("HELLO_")).map((e) => [e.boost, e.threshold])).toEqual([[1.5, 0.1], [1.5, 0.1], [1.5, 0.1]]);
    expect(kwsConfig(WAKE_MANIFEST, hello).keywordsBuf).toContain("HH AH0 L OW1 N OW1 S :1.5 #0.1 @HELLO_NOUS_OW");
    expect(applyKeywordOverrides(WAKE_MANIFEST.keywords, null)).toBe(WAKE_MANIFEST.keywords);
  });
});

describe("SherpaWasmDetector applies the saved overrides at load and scans clips with separate spotters (fixture engine)", () => {
  async function loaded(overrides: WakeKeywordOverrides | null) {
    const scope = fakeScope();
    const controls = engineControls();
    const seen: { options: unknown; module: FakeKwsModule | null } = { options: null, module: null };
    const modules: Record<string, unknown> = { [`/wake-runtime/${WAKE_RELEASE_FILES.glue}`]: fakeGlue(controls, seen as never), [`/wake-runtime/${WAKE_RELEASE_FILES.api}`]: await upstreamApiModule() };
    const manifest = builtTestManifest();
    const net = createRuntimeNet(scope, manifest.url_prefix, manifest.files.map((f) => f.name), async (path) => modules[path]);
    const detector = new SherpaWasmDetector(manifest, net, overrides);
    await detector.load();
    return { detector, controls, seen, manifest };
  }

  it("the always-on spotter gets the overridden boost/threshold on every line of the group", async () => {
    const r = await loaded({ groups: { TEST: { boost: 1.2, threshold: 0.35 } }, code: "a", at: null });
    expect(r.controls.seen!.keywordsBuf).toBe("n ǔ s ī :1.2 #0.35 @TEST_ONE\nHH EY1 N UW1 S :1.2 #0.35 @TEST_TWO\n");
    const plain = await loaded(null);
    expect(plain.controls.seen!.keywordsBuf).toBe("n ǔ s ī #0.2 @TEST_ONE\nHH EY1 N UW1 S :2 @TEST_TWO\n");
  });

  it("a scanner is its own spotter: returns the manifest index, zero-fills the wasm sample copy and frees its spotter and streams", async () => {
    const r = await loaded(null);
    const scanner = r.detector.scanner(applyKeywordOverrides(r.manifest.keywords, { groups: { TEST: { boost: 1, threshold: 0.4 } }, code: "a", at: null }))!;
    expect(r.controls.seen!.keywordsBuf).toBe("n ǔ s ī :1 #0.4 @TEST_ONE\nHH EY1 N UW1 S :1 #0.4 @TEST_TWO\n");
    r.controls.script.push("", "TEST_TWO");
    expect(scanner.scan(new Float32Array(4800).fill(0.3))).toBe(1);
    const heap = r.seen.module!.HEAPF32;
    const start = r.controls.lastSamplePtr / 4;
    expect([...heap.subarray(start, start + r.controls.lastSampleCount)].every((v) => v === 0)).toBe(true);
    expect(scanner.scan(new Float32Array(1600).fill(0.3))).toBeNull();
    scanner.free();
    scanner.free();
    // 常駐偵測器的 spotter 還在；scanner 的 spotter 與兩個串流都已釋放
    expect(r.controls.destroyed).toEqual({ spotter: 1, stream: 2 });
    expect(scanner.scan(new Float32Array(10))).toBeNull();
    r.detector.dispose();
    expect(r.controls.destroyed.spotter).toBe(2);
  });
});

/** 假偵測器（fixture）：每個 scanner 依關鍵詞組與門檻決定結果；記下收到的錄音段（只為了檢查之後有被 0 覆寫）。 */
class SweepDetector implements WakeDetector {
  seenClips: Float32Array[] = [];
  freed = 0;
  disposed = false;
  constructor(private readonly decide: (group: string, threshold: number, clip: Float32Array) => number | null) {}
  async load(): Promise<void> {}
  accept(): number | null {
    return null;
  }
  reset(): void {}
  dispose(): void {
    this.disposed = true;
  }
  scanner(keywords: { entries: { id: string; threshold: number | null }[] }): WakeScanner {
    const ids = keywords.entries.map((e) => e.id);
    const group = ids.every((id) => id.startsWith("HEY_")) ? "HEY_NOUS" : ids.every((id) => id.startsWith("HELLO_")) ? "HELLO_NOUS" : "ALL";
    const threshold = keywords.entries.find((e) => e.id.startsWith("HEY_"))?.threshold ?? keywords.entries[0]?.threshold ?? 0.15;
    return {
      scan: (clip) => {
        this.seenClips.push(clip);
        return this.decide(group, threshold ?? 0.15, clip);
      },
      free: () => void this.freed++,
    };
  }
}

describe("WakeCalibrationCore (worker): audio only inside the prompt window, results only as numbers, cleared at the end", () => {
  const chunk = (v: number) => new Float32Array(1600).fill(v);

  async function core(decide: (group: string, threshold: number, clip: Float32Array) => number | null) {
    const out: WakeWorkerOut[] = [];
    const detector = new SweepDetector(decide);
    const c = new WakeCalibrationCore(detector, WAKE_MANIFEST.keywords, null, (m) => out.push(m), async () => {});
    await c.init(16_000);
    return { c, out, detector };
  }

  it("keeps samples only between clip_begin and clip_end, reports the current setting's result and zero-fills chunks outside the window", async () => {
    const { c, out, detector } = await core((_g, _t, clip) => (clip[0]! > 0.5 ? 3 : null));
    const outside = chunk(0.9);
    c.audio(outside);
    expect([...outside].every((v) => v === 0)).toBe(true);
    expect(c.heldSamples).toBe(0);
    c.beginClip();
    c.audio(chunk(0.9));
    c.audio(chunk(0.9));
    expect(c.heldSamples).toBe(3200);
    c.endClip();
    c.audio(chunk(0.9));
    c.beginClip();
    c.audio(chunk(0.1));
    c.endClip();
    expect(out).toEqual([{ type: "started" }, { type: "clip", clip: 0, keyword_index: 3 }, { type: "clip", clip: 1, keyword_index: -1 }]);
    expect(out.every(isWakeWorkerOut)).toBe(true);
    expect(c.heldSamples).toBe(3200 * 1 + 1600);
    // 第一段錄完時建立「目前設定」的 scanner（全部六行）
    expect(detector.seenClips).toHaveLength(2);
  });

  it("sweeps each candidate over its listed clips with its own scanner, then sweep_done; close() zero-fills every clip and frees everything", async () => {
    const { c, out, detector } = await core((group, threshold) => (group === "HEY_NOUS" && threshold <= 0.25 ? 3 : null));
    for (let i = 0; i < 3; i++) {
      c.beginClip();
      c.audio(chunk(0.4));
      c.endClip();
    }
    out.length = 0;
    await c.sweep([{ group: "HEY_NOUS", boost: 1, threshold: 0.2 }, { group: "HEY_NOUS", boost: 1, threshold: 0.3 }], [[0, 2], [1]]);
    expect(out).toEqual([
      { type: "scan", candidate: 0, clip: 0, keyword_index: 3 },
      { type: "scan", candidate: 0, clip: 2, keyword_index: 3 },
      { type: "scan", candidate: 1, clip: 1, keyword_index: -1 },
      { type: "sweep_done" },
    ]);
    expect(detector.freed).toBe(2);
    const held = [...detector.seenClips];
    expect(held.some((clip) => clip.some((v) => v !== 0))).toBe(true);
    c.close();
    expect(held.every((clip) => clip.every((v) => v === 0))).toBe(true);
    expect(c.heldSamples).toBe(0);
    expect(detector.disposed).toBe(true);
    expect(detector.freed).toBe(3); // 目前設定的 scanner 也釋放
    // 之後的樣本與指令一律不處理
    c.beginClip();
    c.audio(chunk(0.4));
    c.endClip();
    expect(c.heldSamples).toBe(0);
  });

  it("discard() stops a running sweep (no sweep_done) and drops the half-recorded clip too", async () => {
    let release: () => void = () => {};
    const out: WakeWorkerOut[] = [];
    const detector = new SweepDetector(() => null);
    const c = new WakeCalibrationCore(detector, WAKE_MANIFEST.keywords, null, (m) => out.push(m), () => new Promise<void>((r) => (release = r)));
    await c.init(16_000);
    c.beginClip();
    c.audio(chunk(0.4));
    c.endClip();
    const sweeping = c.sweep([{ group: "HEY_NOUS", boost: 1, threshold: 0.2 }], [[0]]);
    c.beginClip();
    c.audio(chunk(0.4));
    c.discard();
    release();
    await sweeping;
    expect(out.some((m) => m.type === "sweep_done" || m.type === "scan")).toBe(false);
    expect(c.heldSamples).toBe(0);
  });

  it("the worker protocol accepts only the scalar calibration shapes", () => {
    for (const ok of [{ type: "clip", clip: 0, keyword_index: -1 }, { type: "scan", candidate: 31, clip: 63, keyword_index: 5 }, { type: "sweep_done" }]) expect(isWakeWorkerOut(ok), JSON.stringify(ok)).toBe(true);
    for (const bad of [
      { type: "clip", clip: 0, keyword_index: -2 },
      { type: "clip", clip: 64, keyword_index: 0 },
      { type: "clip", clip: 0, keyword_index: 0, samples: [1, 2] },
      { type: "scan", candidate: 32, clip: 0, keyword_index: 0 },
      { type: "scan", candidate: 0, clip: 0, keyword_index: 0.5 },
      { type: "sweep_done", clip: new Float32Array(4) },
      { type: "clip", clip: 0, keyword_index: [0] },
    ]) expect(isWakeWorkerOut(bad), JSON.stringify(bad)).toBe(false);
    expect(parseSweepCandidates([{ group: "HEY_NOUS", boost: 1, threshold: 0.2 }])).toHaveLength(1);
    expect(parseSweepCandidates([{ group: "HEY_NOUS", boost: 1, threshold: 2 }])).toBeNull();
    expect(parseSweepCandidates([])).toBeNull();
  });
});

describe("thresholds to compare, scoring and the recommendation", () => {
  it("sweeps ±0.10 around the shipped value: Hey 0.15–0.35 at boost 1.0, Hello 0.05–0.25 at boost 1.5; a saved off-grid value is added", () => {
    const list = sweepCandidates(null);
    expect(list.filter((c) => c.group === "HEY_NOUS").map((c) => [c.boost, c.threshold])).toEqual([[1, 0.15], [1, 0.2], [1, 0.25], [1, 0.3], [1, 0.35]]);
    expect(list.filter((c) => c.group === "HELLO_NOUS").map((c) => [c.boost, c.threshold])).toEqual([[1.5, 0.05], [1.5, 0.1], [1.5, 0.15], [1.5, 0.2], [1.5, 0.25]]);
    const withSaved = sweepCandidates({ groups: { HEY_NOUS: { boost: 1.2, threshold: 0.22 } }, code: "a", at: null });
    expect(withSaved.filter((c) => c.group === "HEY_NOUS")).toHaveLength(6);
    expect(withSaved).toContainEqual({ group: "HEY_NOUS", boost: 1.2, threshold: 0.22 });
  });

  /** 照 2026-11-01 George 的實測情境：0.15 會讓 Hey nurse 叫醒；0.20 多認出一次而且不誤叫醒。 */
  function georgeLike() {
    const candidates = sweepCandidates(null);
    const clips: ClipResult[] = CALIBRATION_PROMPTS.map((_p, prompt) => ({ prompt, keyword_index: -1 }));
    const scans = candidates.map((c) =>
      clips.map((clip, k) => {
        const p = CALIBRATION_PROMPTS[clip.prompt]!;
        if (c.group === "HEY_NOUS") {
          if (p.kind === "negative") return p.say === "Hey nurse" && c.threshold <= 0.15 ? 3 : -1;
          if (p.group !== "HEY_NOUS") return undefined;
          const heard = c.threshold <= 0.15 ? 10 : c.threshold <= 0.2 ? 9 : c.threshold <= 0.25 ? 8 : 5;
          return k < heard ? 3 : -1;
        }
        if (p.kind === "negative") return c.threshold <= 0.05 ? 0 : -1;
        if (p.group !== "HELLO_NOUS") return undefined;
        return 0;
      }));
    return { candidates, clips, scans };
  }

  it("picks the most positives among settings with zero false wakes; ties go to the higher (stricter) threshold", () => {
    const { candidates, clips, scans } = georgeLike();
    const scores = scoreCandidates(candidates, clips, scans);
    const hey = scores.filter((s) => s.group === "HEY_NOUS");
    expect(hey.map((s) => [s.threshold, s.hits, s.positives, s.false_wakes, s.negatives])).toEqual([[0.15, 10, 10, 1, 5], [0.2, 9, 10, 0, 5], [0.25, 8, 10, 0, 5], [0.3, 5, 10, 0, 5], [0.35, 5, 10, 0, 5]]);
    const advice = recommend(scores, null);
    expect(advice.find((a) => a.group === "HEY_NOUS")).toMatchObject({ status: "ok", changed: true, pick: { threshold: 0.2, hits: 9 } });
    // Hello：0.10–0.25 都是 5/5、0 次誤叫醒 → 選最高的 0.25；0.05 會被不該叫醒的句子叫醒
    expect(advice.find((a) => a.group === "HELLO_NOUS")).toMatchObject({ status: "ok", pick: { threshold: 0.25, hits: 5 } });
    expect(overridesFromAdvice(advice, "lion", null)).toEqual({ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 }, HELLO_NOUS: { boost: 1.5, threshold: 0.25 } }, code: "lion", at: null });
  });

  it("no recommendation when every setting false-wakes, when nothing is recognized, or when the sweep did not finish; same-as-default means null", () => {
    const candidates = sweepCandidates(null);
    const clips: ClipResult[] = CALIBRATION_PROMPTS.map((_p, prompt) => ({ prompt, keyword_index: -1 }));
    const allFalse = candidates.map(() => clips.map(() => 0));
    const a1 = recommend(scoreCandidates(candidates, clips, allFalse), HEY);
    expect(a1.map((a) => a.status)).toEqual(["all_false_wake", "all_false_wake"]);
    // 沒有建議時保留原本的矯正值
    expect(overridesFromAdvice(a1, "b", HEY)).toEqual({ ...HEY, code: "b" });
    const none = recommend(scoreCandidates(candidates, clips, candidates.map(() => clips.map(() => -1))), null);
    expect(none.map((a) => a.status)).toEqual(["no_hits", "no_hits"]);
    const half = recommend(scoreCandidates(candidates, clips, candidates.map(() => [])), null);
    expect(half.map((a) => a.status)).toEqual(["not_measured", "not_measured"]);
    // 建議值剛好是出貨的預設 → 套用等於回復預設（null）
    const defaults = recommend(scoreCandidates(candidates, clips, candidates.map((c) => clips.map((clip) => {
      const p = CALIBRATION_PROMPTS[clip.prompt]!;
      if (p.kind === "negative") return (c.group === "HEY_NOUS" && c.threshold < 0.25) || (c.group === "HELLO_NOUS" && c.threshold < 0.15) ? 0 : -1;
      return c.threshold <= (c.group === "HEY_NOUS" ? 0.25 : 0.15) ? 0 : -1;
    }))), HEY);
    expect(defaults.every((a) => a.status === "ok")).toBe(true);
    expect(overridesFromAdvice(defaults, "c", HEY)).toBeNull();
  });
});

describe("wake.json keeps the applied thresholds (the core is the only writer)", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("saves with the core's timestamp, survives a reload, resets with null, and a broken value falls back to the shipped manifest", () => {
    root = mkdtempSync(join(tmpdir(), "nous-wake-cal-"));
    const store = () => new WakeSettingsStore({ dir: root, onChange: () => {}, log: () => {} }, () => new Date("2026-11-01T08:00:00.000Z"));
    store().update(parseWakePatch({ keyword_overrides: { ...HEY, at: "1999-01-01T00:00:00Z" } }));
    expect(store().view().keyword_overrides).toEqual({ ...HEY, at: "2026-11-01T08:00:00.000Z" });
    expect(store().view().wake_listen).toBe(false);
    store().update({ keyword_overrides: null });
    expect(store().view().keyword_overrides).toBeNull();
    writeFileSync(join(root, "wake.json"), JSON.stringify({ schema_version: 1, prefs: { wake_listen: true, keyword_overrides: { groups: { HEY_NOUS: { boost: 1, threshold: 0.001 } }, code: "a" } } }));
    const s = store();
    expect(s.view().keyword_overrides).toBeNull();
    expect(s.view().wake_listen).toBe(true);
    // 不寫進 repo 裡的出貨清單
    expect(readFileSync(join(import.meta.dirname, "..", "shared", "wake-runtime.json"), "utf8")).not.toMatch(/lion|keyword_overrides/);
  });
});

function controllerRig(overrides: WakeKeywordOverrides | null = null) {
  const clock = new FakeClock();
  const media = new FakeMediaDevices();
  const capture = new FakeCapture();
  const earcon = new FakeEarcon();
  const reports: WakeReport[] = [];
  const host: WakeHost = {
    now: clock.now,
    runtime: () => "ok",
    caption: () => {},
    visible: () => true,
    onVisible: () => () => {},
    state: (r) => reports.push(r),
    saveDeviceId: async () => {},
    newId: () => "int_0000000000000001",
  };
  const c = new WakeController(host, { mediaDevices: media, capture, earcon });
  const view = (listen: boolean, o = overrides): WakeSettingsView => ({ wake_listen: listen, device_id: null, wake_silence_s: 5, keyword_overrides: o, runtime: "ok" });
  const events = { ready: vi.fn(), clip: vi.fn(), scan: vi.fn(), sweepDone: vi.fn(), aborted: vi.fn() } satisfies WakeCalibrationEvents;
  return { c, media, capture, earcon, reports, view, events };
}

describe("WakeController/AudioFrontEnd: calibration pauses always-on listening and resumes it afterwards", () => {
  it("listening → paused/calibrating on a clone of the same source; stop() discards the worker's recording, stops that clone and resumes listening", async () => {
    const r = controllerRig(HEY);
    r.c.applySettings(r.view(false));
    r.c.applySettings(r.view(true));
    await flush();
    r.capture.last!.events.started();
    expect(r.c.state).toEqual({ state: "listening_local", reason: null });
    expect(r.capture.last!.options).toEqual({ overrides: HEY });
    const listenGraph = r.capture.last!;
    const session = await r.c.startCalibration(r.events);
    const cal = r.capture.last!;
    expect(cal).not.toBe(listenGraph);
    expect(listenGraph.stopped).toBe(true); // 常駐偵測的擷取圖停了
    expect(cal.options).toMatchObject({ overrides: HEY });
    expect(cal.options?.calibrate).toBeDefined();
    expect(r.c.state).toEqual({ state: "paused", reason: "calibrating" });
    expect(r.media.calls).toHaveLength(1); // 用來源的複製品，沒有另開 getUserMedia
    cal.events.started();
    expect(r.events.ready).toHaveBeenCalledOnce();
    session.beginClip();
    session.endClip();
    cal.options!.calibrate!.clip(0, -1);
    expect(r.events.clip).toHaveBeenCalledWith(0, -1);
    session.sweep([{ group: "HEY_NOUS", boost: 1, threshold: 0.2 }], [[0]]);
    expect(cal.commands).toEqual(["clip_begin", "clip_end", "sweep:1:1"]);
    const clone = (cal.stream as unknown as FakeStream).tracks[0]!;
    session.stop();
    expect(cal.commands.at(-1)).toBe("discard");
    expect(cal.stopped).toBe(true);
    expect(clone.stopped).toBe(true);
    await flush();
    // 恢復常駐聆聽（新的擷取圖，同樣帶矯正值）
    expect(r.capture.last).not.toBe(cal);
    expect(r.capture.last!.options).toEqual({ overrides: HEY });
    r.capture.last!.events.started();
    expect(r.c.state).toEqual({ state: "listening_local", reason: null });
    // 結束後的指令與事件一律忽略
    session.beginClip();
    cal.options!.calibrate!.clip(1, 0);
    expect(r.events.clip).toHaveBeenCalledTimes(1);
  });

  it("with listening off it opens its own microphone and leaves the state off; sleep aborts, discards and releases the microphone", async () => {
    const r = controllerRig();
    r.c.applySettings(r.view(false));
    await r.c.startCalibration(r.events);
    expect(r.media.calls).toHaveLength(1);
    expect(r.c.state).toEqual({ state: "off", reason: null });
    const cal = r.capture.last!;
    r.c.power("suspend");
    expect(r.events.aborted).toHaveBeenCalledWith("sleep");
    expect(cal.commands).toEqual(["discard"]);
    expect(cal.stopped).toBe(true);
    expect(r.media.liveTracks()).toEqual([]);
    expect(r.c.frontEnd.isCalibrating).toBe(false);
  });

  it("a second start is refused (busy); a microphone error is reported, and dispose() ends a running calibration", async () => {
    const r = controllerRig();
    r.c.applySettings(r.view(false));
    await r.c.startCalibration(r.events);
    await expect(r.c.startCalibration(r.events)).rejects.toMatchObject({ reason: "busy" });
    r.c.dispose();
    expect(r.capture.last!.stopped).toBe(true);
    expect(r.media.liveTracks()).toEqual([]);
    const denied = controllerRig();
    denied.c.applySettings(denied.view(false));
    denied.media.failWith = "NotAllowedError";
    await expect(denied.c.startCalibration(denied.events)).rejects.toMatchObject({ reason: "permission_denied" });
    expect(denied.c.frontEnd.isCalibrating).toBe(false);
  });

  it("applying or restoring overrides while listening reloads the detector with the new thresholds", async () => {
    const r = controllerRig(null);
    r.c.applySettings(r.view(false));
    r.c.applySettings(r.view(true));
    await flush();
    r.capture.last!.events.started();
    const first = r.capture.last!;
    r.c.applySettings(r.view(true, HEY));
    await flush();
    expect(first.stopped).toBe(true);
    expect(r.capture.last!.options).toEqual({ overrides: HEY });
    r.c.applySettings(r.view(true, null));
    await flush();
    expect(r.capture.last!.options).toEqual({ overrides: null });
    // 沒在聽時只記下，不開麥克風
    const idle = controllerRig(null);
    idle.c.applySettings(idle.view(false));
    idle.c.applySettings(idle.view(false, HEY));
    await flush();
    expect(idle.media.calls).toEqual([]);
  });

  it("AudioFrontEnd refuses calibration when the engine is not ok, without opening the microphone", async () => {
    const media = new FakeMediaDevices();
    const fe = new AudioFrontEnd({ mediaDevices: media, capture: new FakeCapture(), runtime: () => "missing" }, { state: () => {}, detected: () => {}, listening: () => {} });
    await expect(fe.calibrate({ started() {}, detected() {}, failed() {} }, { clip() {}, scan() {}, sweepDone() {} })).rejects.toMatchObject({ reason: "runtime_missing" });
    expect(media.calls).toEqual([]);
  });
});

// ───────────── 畫面（最小的 DOM 替身） ─────────────

class El {
  children: (El | string)[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, ((e: { key?: string }) => void)[]>();
  dataset: Record<string, string> = {};
  disabled = false;
  value = "";
  hidden = false;
  classes = new Set<string>();
  classList = { toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)) };
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  append(...nodes: (El | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (El | string)[]) { this.children = nodes; }
  addEventListener(type: string, cb: (e: { key?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  get textContent(): string { return this.children.map((n) => (typeof n === "string" ? n : n.textContent)).join(""); }
  all(): El[] { return this.children.flatMap((n) => (typeof n === "string" ? [] : [n, ...n.all()])); }
  fire(type: string, e: { key?: string } = {}) { for (const cb of this.listeners.get(type) ?? []) cb(e); }
}

describe("WakeCalibrationView: prompts with a ding and full-window cue, live result per prompt, table, apply only on press", () => {
  const original = globalThis.document;
  beforeAll(() => vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) }));
  afterAll(() => { vi.unstubAllGlobals(); if (original) globalThis.document = original; });

  async function viewRig(overrides: WakeKeywordOverrides | null = null) {
    const { WakeCalibrationView } = await import("../src/wake-calibration-view.ts");
    let t = 0;
    const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
    const cues: (string | null)[] = [];
    const applied: (WakeKeywordOverrides | null)[] = [];
    let events: WakeCalibrationEvents | null = null;
    const session = { ding: vi.fn(async () => true), beginClip: vi.fn(), endClip: vi.fn(), sweep: vi.fn(), discard: vi.fn(), stop: vi.fn() };
    const settings: WakeSettingsView = { wake_listen: true, device_id: null, wake_silence_s: 5, keyword_overrides: overrides, runtime: "ok" };
    const dismiss = vi.fn();
    const view = new WakeCalibrationView({
      settings: () => settings,
      start: async (e) => { events = e; return session; },
      apply: async (o) => { applied.push(o); return null; },
      cue: (s) => cues.push(s),
      dismiss,
    }, {
      now: () => t,
      setTimeout: (fn, ms) => { const entry = { fn, at: t + ms, cancelled: false }; timers.push(entry); return entry; },
      clearTimeout: (h) => { (h as { cancelled: boolean }).cancelled = true; },
    });
    const el = view.element as unknown as El;
    const advance = async (ms: number) => {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.cancelled && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        t = due.at;
        due.fn();
        await flush();
      }
      t = end;
    };
    const press = (label: string) => el.all().find((x) => x.tagName === "button" && x.textContent === label)!.fire("click");
    return { view, el, session, cues, applied, dismiss, advance, press, events: () => events!, settings };
  }

  it("runs all 20 prompts, sweeps, stops the session (recording gone) and applies the suggestion only when 套用 is pressed", async () => {
    const r = await viewRig();
    r.view.open();
    const input = r.el.all().find((x) => x.tagName === "input")!;
    const start = () => r.el.all().find((x) => x.tagName === "button" && x.textContent === "開始錄音測試")!;
    input.value = "小明";
    input.fire("input");
    expect(start().disabled).toBe(true); // 名字不行，只能是代號
    input.value = "lion";
    input.fire("input");
    expect(start().disabled).toBe(false);
    start().fire("click");
    await flush();
    r.events().ready();
    for (let i = 0; i < CALIBRATION_PROMPTS.length; i++) {
      await r.advance(900);
      expect(r.session.ding).toHaveBeenCalledTimes(i + 1);
      expect(r.session.beginClip).toHaveBeenCalledTimes(i + 1);
      expect(r.cues.at(-1)).toBe("speak");
      expect(r.el.classes.has("wake-calibration--speak")).toBe(true);
      expect(r.el.textContent).toContain(CALIBRATION_PROMPTS[i]!.say);
      await r.advance(5000);
      expect(r.cues.at(-1)).toBeNull();
      expect(r.session.endClip).toHaveBeenCalledTimes(i + 1);
      const p = CALIBRATION_PROMPTS[i]!;
      r.events().clip(i, p.group === "HEY_NOUS" && i < 7 ? 3 : p.group === "HELLO_NOUS" ? 0 : -1);
      expect(r.el.textContent).toMatch(p.kind === "negative" ? /沒有叫醒/ : /偵測到了|沒有偵測到/);
      await r.advance(1200);
    }
    expect(r.session.sweep).toHaveBeenCalledOnce();
    const [candidates, lists] = r.session.sweep.mock.calls[0]! as [{ group: string; threshold: number }[], number[][]];
    expect(candidates).toEqual(sweepCandidates(null));
    // 清單順序是 Hello 再 Hey：Hello 候選掃 5 段加 5 句不該叫醒；Hey 候選掃 10 + 5
    expect(lists.map((l) => l.length)).toEqual([10, 10, 10, 10, 10, 15, 15, 15, 15, 15]);
    expect(r.el.textContent).toContain("比較");
    candidates.forEach((c, ci) => lists[ci]!.forEach((k) => {
      const p = CALIBRATION_PROMPTS[k]!;
      const hit = p.kind === "negative" ? (c.group === "HEY_NOUS" && c.threshold <= 0.15 ? 3 : -1) : c.group === "HEY_NOUS" ? (k < (c.threshold <= 0.2 ? 9 : 7) ? 3 : -1) : 0;
      r.events().scan(ci, k, hit);
    }));
    r.events().sweepDone();
    // 比較完：工作階段（麥克風與 worker 的錄音）立即結束
    expect(r.session.stop).toHaveBeenCalledOnce();
    expect(r.applied).toEqual([]);
    expect(r.el.textContent).toContain("建議改成 1.00／0.20（目前 1.00／0.25）");
    r.press("套用");
    await flush();
    expect(r.applied).toEqual([{ groups: { HEY_NOUS: { boost: 1, threshold: 0.2 }, HELLO_NOUS: { boost: 1.5, threshold: 0.25 } }, code: "lion", at: null }]);
    expect(r.el.textContent).toContain("已套用");
  });

  it("closing mid-prompt stops the session and the cue; restore defaults saves null", async () => {
    const r = await viewRig(HEY);
    r.view.open();
    const input = r.el.all().find((x) => x.tagName === "input")!;
    input.value = "A1";
    input.fire("input");
    r.press("開始錄音測試");
    await flush();
    r.events().ready();
    await r.advance(900);
    expect(r.view.active).toBe(true);
    r.view.close();
    expect(r.session.stop).toHaveBeenCalledOnce();
    expect(r.cues.at(-1)).toBeNull();
    expect(r.view.active).toBe(false);
    // 晚到的事件不會再改畫面
    r.events().clip(0, 3);
    expect(r.el.textContent).not.toContain("偵測到了");
    r.view.open();
    expect(r.el.textContent).toContain("上次矯正：代號 lion");
    const summary = await viewRig(HEY);
    summary.view.open();
    const i2 = summary.el.all().find((x) => x.tagName === "input")!;
    i2.value = "A1";
    i2.fire("input");
    summary.press("開始錄音測試");
    await flush();
    summary.events().aborted("lock");
    expect(summary.session.stop).toHaveBeenCalledOnce();
    expect(summary.el.textContent).toContain("螢幕已鎖定，已停止矯正並丟掉錄音。");
  });
});

describe("menu, native consent and translations", () => {
  const base = (wake: WakeSettingsView | undefined): SettingsView => ({
    schema_version: "proto-0.1", provider: "mock", providers: [], seconds: [],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
    ...(wake ? { wake } : {}),
  } as unknown as SettingsView);
  const wakeView = (runtime: "ok" | "missing", o: WakeKeywordOverrides | null = null): WakeSettingsView => ({ wake_listen: false, device_id: null, wake_silence_s: 5, keyword_overrides: o, runtime });

  it("「矯正喚醒詞…」 sits in the wake section, is enabled only when the engine is ok, and its click goes to the main process", () => {
    const calibrateWake = vi.fn();
    const items = (w: WakeSettingsView) => settingsMenu(base(w), { command: () => {}, setMenuPref: () => {}, calibrateWake });
    const off = items(wakeView("missing")).find((i) => i.label === "矯正喚醒詞…")!;
    expect(off).toMatchObject({ enabled: false, sublabel: "喚醒引擎可以使用後才能矯正" });
    const on = items(wakeView("ok")).find((i) => i.label === "矯正喚醒詞…")!;
    expect(on).toMatchObject({ enabled: true, sublabel: "依提示念幾次，替這個家重新選門檻" });
    on.click!();
    expect(calibrateWake).toHaveBeenCalledOnce();
    expect(items(wakeView("ok", HEY)).find((i) => i.label === "矯正喚醒詞…")!.sublabel).toBe("目前用代號 lion 的矯正值");
    expect(JSON.stringify(settingsMenu(base(undefined), { command: () => {}, setMenuPref: () => {} }))).not.toContain("矯正喚醒詞");
  });

  it("main.mjs shows the native explanation before opening the flow; the page command does not start recording by itself", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
    const fn = main.slice(main.indexOf("async function calibrateWake()"), main.indexOf("function rebuildMenu()"));
    expect(fn.indexOf("showMessage(")).toBeGreaterThan(0);
    expect(fn.indexOf("showMessage(")).toBeLessThan(fn.indexOf('command("calibrate-wake")'));
    expect(fn).toMatch(/if \(response === 0\) command\("calibrate-wake"\);/);
    expect(fn).toMatch(/不寫檔、不上傳、不進紀錄/);
    const page = readFileSync(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    expect(page).toMatch(/calibrateWake: \(\) => \{\s*if \(settings\?\.wake\) dispatch\(\{ type: "show\.wake_calibration", request_id: userRequest\(\) \}\);\s*\}/);
  });

  it("every new string has an English translation (menu, dialog, view, errors)", () => {
    const view = readFileSync(join(import.meta.dirname, "..", "src", "wake-calibration-view.ts"), "utf8");
    const sources = new Set<string>([
      ...[...view.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!),
      ...[...view.matchAll(/\bmsg`((?:[^`\\]|\\.)*)`/g)].map((m) => { let i = 0; return m[1]!.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${i++}}`); }),
      ...[...view.matchAll(/^\s+(?:runtime_missing|runtime_load_failed|sleep|lock): "([^"]+)",$/gm)].map((m) => m[1]!),
      ...["已回復預設門檻。", "已套用：之後的喚醒偵測就用這組門檻。", "已套用：建議值和出貨的預設相同，已改回預設。", "偵測器沒有回應，已停止矯正。"],
      ...[WAKE_TEXT.calibrate, WAKE_TEXT.calibrateNote, WAKE_TEXT.calibratedNote, WAKE_TEXT.calibrateUnavailable, "正在矯正喚醒詞，結束後自動恢復", "要開始矯正喚醒詞嗎？", "開始"],
      ...["已經在矯正中。", "已取消。", "常駐喚醒聆聽沒有載入，無法矯正。"],
    ]);
    const missing = [...sources].filter((s) => /[一-鿿]/.test(s) && translate(s, "en") === s);
    expect(missing).toEqual([]);
    const main = readFileSync(join(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
    const detail = /detail: t\("(接下來會請你[^"]+)"\)/.exec(main)![1]!;
    expect(translate(detail, "en")).toMatch(/not written to disk, uploaded or logged/);
    // 參數化的錯誤也翻得到
    expect(translate("HEY_NOUS 的門檻必須在 0.05–0.5 之間", "en")).toBe("HEY_NOUS: threshold must be between 0.05 and 0.5");
  });
});
