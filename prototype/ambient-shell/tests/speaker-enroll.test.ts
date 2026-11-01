// SP-01 家人聲音登記：音量判斷（vad）、講者模型的清單與提供（/speaker-runtime/）、src/speaker 的隱私界線。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import manifest from "../shared/speaker-runtime.json" with { type: "json" };
import face from "../shared/face-runtime.json" with { type: "json" };
import { SPEAKER_FEATURE_DIM } from "../shared/identity.ts";
import { checkSpeakerRuntime, readVerifiedSpeakerRuntime, SPEAKER_MODEL_VERSION, speakerRuntimePath } from "../server/speaker-runtime.ts";
import { voicedSegments, VAD_FRAME } from "../src/speaker/vad.ts";
import { VOICE_PROMPTS } from "../src/family-view.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-speaker-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tone(seconds: number, amp: number, sr = 16000): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr));
}

describe("voicedSegments (volume, not a speech model)", () => {
  it("keeps the loud part with 100 ms padding and reports voiced ms; silence around it is dropped", () => {
    const x = new Float32Array(16000 * 3);
    x.set(tone(1, 0.3), 16000); // 1 s 的聲音在中間
    const r = voicedSegments(x);
    expect(r.voiced_ms).toBeGreaterThanOrEqual(980);
    expect(r.voiced_ms).toBeLessThanOrEqual(1020);
    expect(r.samples.length).toBeGreaterThanOrEqual(16000);
    expect(r.samples.length).toBeLessThanOrEqual(16000 + 2 * 5 * VAD_FRAME + VAD_FRAME);
    expect(r.peak_rms).toBeGreaterThan(0.2);
  });

  it("near-silence gives no voiced audio (too_quiet), empty input gives nothing", () => {
    const quiet = tone(2, 0.002);
    expect(voicedSegments(quiet).voiced_ms).toBe(0);
    expect(voicedSegments(new Float32Array(0))).toEqual({ samples: new Float32Array(0), voiced_ms: 0, peak_rms: 0 });
  });
});

describe("speaker runtime manifest and serving", () => {
  it("pins CAM++ zh_en advanced (SP-00 choice) and reuses face-runtime's onnxruntime wasm hashes", () => {
    expect(manifest.url_prefix).toBe("/speaker-runtime/");
    const model = manifest.files.find((f) => f.role === "speaker")!;
    expect(model.name).toBe("3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx");
    expect(model.sha256).toBe("aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2");
    expect(model.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/speaker-recongition-models\//);
    const ort = manifest.files.filter((f) => f.role === "runtime");
    expect(ort.map((f) => [f.name, f.sha256])).toEqual(face.files.filter((f) => f.role === "runtime").map((f) => [f.name, f.sha256]));
    expect(SPEAKER_MODEL_VERSION).toEqual({ speaker: "campplus-zh_en-advanced@aa3cfc16", preproc: "kaldi-fbank80-globalmean-v1", dim: SPEAKER_FEATURE_DIM });
  });

  it("check: not_configured / missing / hash_mismatch; reads re-verify; only listed names resolve", () => {
    expect(checkSpeakerRuntime(null).state).toBe("not_configured");
    const dir = join(root, "rt");
    mkdirSync(dir);
    expect(checkSpeakerRuntime(dir)).toMatchObject({ state: "missing" });
    writeFileSync(join(dir, manifest.files[0]!.name), "not the model");
    expect(checkSpeakerRuntime(dir)).toMatchObject({ state: "hash_mismatch", problems: [manifest.files[0]!.name] });
    expect(readVerifiedSpeakerRuntime(join(dir, manifest.files[0]!.name))).toBeNull();
    expect(speakerRuntimePath(dir, `/speaker-runtime/${manifest.files[0]!.name}`)).toBe(join(dir, manifest.files[0]!.name));
    expect(speakerRuntimePath(dir, "/speaker-runtime/../gallery.v1.json")).toBeNull();
    expect(speakerRuntimePath(dir, "/speaker-runtime/other.onnx")).toBeNull();
    expect(speakerRuntimePath(null, `/speaker-runtime/${manifest.files[0]!.name}`)).toBeNull();
  });
});

describe("enrollment prompts", () => {
  it("are 5 wake words (both Hey Nous and Hello Nous) then 3 sentences, with sane windows", () => {
    expect(VOICE_PROMPTS.filter((p) => p.kind === "keyword").map((p) => p.text)).toEqual(["Hey Nous", "Hello Nous", "Hey Nous", "Hello Nous", "Hey Nous"]);
    expect(VOICE_PROMPTS.filter((p) => p.kind === "utterance")).toHaveLength(3);
    for (const p of VOICE_PROMPTS) expect(p.min_ms).toBeLessThan(p.window_ms);
  });
});

describe("src/speaker privacy (static)", () => {
  const dir = new URL("../src/speaker/", import.meta.url).pathname;
  const sources = readdirSync(dir).map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

  it("has exactly these files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["fbank.ts", "protocol.ts", "recorder.ts", "vad.ts", "wake-voice.ts", "worker.ts"]);
  });

  it("never stores, uploads or sends audio over IPC", () => {
    for (const { file, text } of sources) {
      for (const pattern of [/\bfetch\s*\(/, /localStorage|sessionStorage|indexedDB|caches\./, /XMLHttpRequest|WebSocket|sendBeacon|EventSource/, /nousDesktop|ipcRenderer/, /console\.(log|info|debug|warn|error)/]) {
        expect(pattern.test(text), `${file}: ${pattern}`).toBe(false);
      }
    }
  });

  it("the worker only posts ready / level / segment / keyword / error; segment and keyword carry a feature, never samples", () => {
    const worker = sources.find((s) => s.file === "worker.ts")!.text;
    const types = [...worker.matchAll(/postMessage\(\{\s*type:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(["ready", "level", "segment", "keyword", "error"]));
    const posts = [...worker.matchAll(/postMessage\(\{[^}]*\}/g)].map((m) => m[0]);
    for (const p of posts) expect(p, p).not.toMatch(/samples|chunk|pcm|all\b/);
  });

  it("only family-view and main.ts reach src/speaker", () => {
    const app = new URL("..", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const importers = ["src", "server", "shared", "desktop"]
      .flatMap((d) => walk(join(app, d)))
      .filter((f) => !f.includes(`${"/"}speaker${"/"}`) && /\.(ts|mjs|cjs)$/.test(f))
      .filter((f) => /from\s+["'][^"']*\/speaker\/[\w-]+\.ts["']|new URL\(\s*["'][^"']*speaker\/worker\.ts/.test(readFileSync(f, "utf8")))
      .map((f) => relative(app, f));
    expect(importers.sort()).toEqual([join("src", "family-view.ts"), join("src", "main.ts")]);
  });
});
