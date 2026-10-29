// WK-00 雲端可做的離線評估（docs/validation/wk-00-spike-2026-10-29.md）。
//
//   npx tsx spike/wake/bench.ts --negatives <資料夾,…> [--models zh-en-3M,wenetspeech-3.3M] [--engines node@2.0.1]
//        [--boosts 1.0,1.5,2.0] [--thresholds 0.15,0.25,0.35] [--precisions int8] [--negative-hours 6]
//        [--noise-minutes 15] [--music-minutes 15] [--speakers 30] [--jobs 4] [--set main|variants] [--out <資料夾>]
//
// 主程序以 TTS 在記憶體合成正例與困難負例（合成語音，不是真人），再為每一組設定 fork 一個子程序：
// 子程序只載入一個引擎（兩個版本的 addon 同名，不能共存），以 100 ms 分塊依序送入正例、困難負例、
// 公開語料負例（WAV，從 --negatives 讀）與合成白噪音／音樂，回傳偵測與 CPU、記憶體數字。音訊只在記憶體與 IPC，不寫檔。
// 結果只代表「雲端容器、合成或公開語料」，不是 Mac 或客廳。

import { fork } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mixAtSnr, parseWav, resample, syntheticMusic, whiteNoise } from "./audio.ts";
import { createSpotter, DEFAULT_OPTIONS, type EngineId } from "./engines.ts";
import { buildKeywordsText, CANDIDATES, candidateById, parseTokens, VARIANTS, type Candidate, type KeywordSetting, type ModelId } from "./keywords.ts";
import { modelPaths, tokensText, type Precision } from "./models.ts";
import { defaultOutputDir, writeReport } from "./report.ts";
import { feed, SAMPLE_RATE, type TimedDetection } from "./run.ts";
import { estimateKeywordSeconds, matchDetections, perHour, realTimeFactor, speechBounds, summarize, tokenSpan, type Expected } from "./stats.ts";
import { HARD_NEGATIVES_EN, HARD_NEGATIVES_ZH, Synth, TTS_TEXT, type TtsVoice } from "./tts.ts";

const PRE_S = 1.0;
const POST_S = 1.5;
const SNR_DB = 10;

export interface Clip {
  /** 候選 id（正例）或 null（負例）。 */
  keyword: string | null;
  context: "isolated" | "sentence" | "white_noise_10dB" | "music_10dB" | "hard_negative";
  voice: TtsVoice;
  sid: number;
  speed: number;
  samples: Float32Array;
  /** 正例：喚醒詞在 clip 內的能量端點（秒）；句子正例只有整句範圍。 */
  wordStart: number;
  wordEnd: number;
}

interface Job {
  model: ModelId;
  engine: EngineId;
  precision: Precision;
  boost: number;
  threshold: number;
  negatives: string[];
  negativeHours: number;
  noiseMinutes: number;
  musicMinutes: number;
  /** main：三個候選詞；variants：替代念法與子詞（正例沿用原候選詞的合成片段）。 */
  set: "main" | "variants";
}

type Args = Record<string, string>;
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith("--")) a[argv[i]!.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
  return a;
}
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const round = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** 合成正例：aishell3 取 speakers 位平均分散的語者（速度 1.0），melo 取 5 種速度。 */
function synthesize(speakers: number): { positives: Clip[]; hardNegatives: Clip[]; lengths: Record<string, ReturnType<typeof summarize>> } {
  const synth = new Synth();
  const total = synth.speakers("aishell3");
  const sids = Array.from({ length: Math.min(speakers, total) }, (_, i) => Math.floor((i * total) / Math.min(speakers, total)));
  const voices: { voice: TtsVoice; sid: number; speed: number }[] = [
    ...sids.map((sid) => ({ voice: "aishell3" as const, sid, speed: 1 })),
    ...[0.8, 0.9, 1.0, 1.1, 1.2].map((speed) => ({ voice: "melo-zh-en" as const, sid: 0, speed })),
  ];
  const noise = whiteNoise(10, 0.05, 7);
  const music = syntheticMusic(10, 0.05, 11);
  const positives: Clip[] = [];
  const lengths: Record<string, number[]> = {};
  for (const c of CANDIDATES) {
    const text = TTS_TEXT[c.id]!;
    for (const v of voices) {
      const t = v.voice === "aishell3" ? text.zh : (text.en ?? text.zh);
      if (!t) continue;
      const word = synth.say(v.voice, t.word, v.sid, v.speed);
      const b = speechBounds(word, SAMPLE_RATE);
      if (!b) continue;
      (lengths[c.id] ??= []).push(b.duration);
      const base = { keyword: c.id, voice: v.voice, sid: v.sid, speed: v.speed, wordStart: b.start, wordEnd: b.end };
      positives.push({ ...base, context: "isolated", samples: word });
      positives.push({ ...base, context: "white_noise_10dB", samples: mixAtSnr(word, noise, SNR_DB) });
      positives.push({ ...base, context: "music_10dB", samples: mixAtSnr(word, music, SNR_DB) });
      const sentence = synth.say(v.voice, t.sentence, v.sid, v.speed);
      const sb = speechBounds(sentence, SAMPLE_RATE);
      if (sb) positives.push({ ...base, context: "sentence", samples: sentence, wordStart: sb.start, wordEnd: sb.end });
    }
  }
  const hardNegatives: Clip[] = [];
  for (const v of voices.filter((_, i) => i % 3 === 0)) {
    const texts = v.voice === "aishell3" ? HARD_NEGATIVES_ZH : [...HARD_NEGATIVES_ZH, ...HARD_NEGATIVES_EN];
    for (const text of texts) {
      const samples = synth.say(v.voice, text, v.sid, v.speed);
      hardNegatives.push({ keyword: null, context: "hard_negative", voice: v.voice, sid: v.sid, speed: v.speed, samples, wordStart: 0, wordEnd: samples.length / SAMPLE_RATE });
    }
  }
  return { positives, hardNegatives, lengths: Object.fromEntries(Object.entries(lengths).map(([k, v]) => [k, summarize(v)])) };
}

function wavFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? wavFiles(p) : extname(f).toLowerCase() === ".wav" ? [p] : [];
    });
}

/** 子程序：只載入一個引擎，依序送入各組音訊。 */
async function worker(): Promise<void> {
  const msg = await new Promise<{ job: Job; positives: Clip[]; hardNegatives: Clip[] }>((resolve) => process.once("message", (m) => resolve(m as never)));
  const { job } = msg;
  const paths = modelPaths(job.model, job.precision);
  const candidates = (job.set === "variants" ? VARIANTS : CANDIDATES).filter((c) => c.models.includes(job.model));
  const source = (c: Candidate) => c.variantOf ?? c.id;
  const settings: KeywordSetting[] = candidates.map((candidate) => ({ candidate, boost: job.boost, threshold: job.threshold }));
  const keywordsText = buildKeywordsText(settings, job.model, parseTokens(tokensText(paths)));
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const spotter = createSpotter(job.engine, paths, keywordsText, { ...DEFAULT_OPTIONS, keywordsThreshold: job.threshold, keywordsScore: job.boost });
  const loadMs = performance.now() - t0;
  const rssAfterLoad = process.memoryUsage().rss;

  // 1. 正例：每個情境各自一條連續串流，clip 之間有 PRE_S／POST_S 靜音
  const positives = msg.positives.filter((p) => candidates.some((c) => source(c) === p.keyword));
  const byContext = new Map<string, Clip[]>();
  for (const p of positives) byContext.set(p.context, [...(byContext.get(p.context) ?? []), p]);
  const positiveResults: Record<string, unknown> = {};
  const lengthEstimates: Record<string, number[]> = {};
  const spans: Record<string, number[]> = {};
  for (const [context, clips] of byContext) {
    spotter.restart();
    const expected: Expected[] = [];
    const detections: TimedDetection[] = [];
    let t = 0;
    for (const clip of clips) {
      detections.push(...feed(spotter, new Float32Array(Math.round(PRE_S * SAMPLE_RATE)), t).detections);
      t += PRE_S;
      for (const c of candidates) if (source(c) === clip.keyword) expected.push({ keyword: c.id, start: t + clip.wordStart, end: t + clip.wordEnd });
      detections.push(...feed(spotter, clip.samples, t).detections);
      t += clip.samples.length / SAMPLE_RATE;
      detections.push(...feed(spotter, new Float32Array(Math.round(POST_S * SAMPLE_RATE)), t).detections);
      t += POST_S;
    }
    detections.push(...spotter.finish().map((d) => ({ ...d, at: t })));
    const m = matchDetections(expected, detections.map((d) => ({ at: d.at, keyword: d.keyword })));
    const perKeyword: Record<string, unknown> = {};
    for (const c of candidates) {
      const exp = expected.filter((e) => e.keyword === c.id);
      if (!exp.length) continue;
      const hits = m.hits.filter((h) => h.expected.keyword === c.id);
      perKeyword[c.label] = {
        n: exp.length,
        hits: hits.length,
        recall: round(hits.length / exp.length),
        // 只有單獨念喚醒詞時，詞尾位置是能量端點；句子情境的詞尾不明，不報延遲
        latency_after_word_end_s: context === "sentence" ? null : summarize(hits.map((h) => h.latency)),
      };
    }
    for (const d of detections) {
      const est = estimateKeywordSeconds(d.timestamps);
      if (est !== null && context === "isolated") (lengthEstimates[d.keyword] ??= []).push(est);
      const sp = tokenSpan(d.timestamps);
      if (sp && context === "isolated") (spans[d.keyword] ??= []).push(sp.span);
    }
    positiveResults[context] = { keywords: perKeyword, false_alarms: m.falseAlarms.length };
  }

  // 2. 困難負例（合成句子）
  spotter.restart();
  const hardFa: Record<string, number> = {};
  let hardSeconds = 0;
  for (const clip of msg.hardNegatives) {
    for (const d of feed(spotter, clip.samples, 0).detections) hardFa[d.keyword] = (hardFa[d.keyword] ?? 0) + 1;
    for (const d of feed(spotter, new Float32Array(SAMPLE_RATE), 0).detections) hardFa[d.keyword] = (hardFa[d.keyword] ?? 0) + 1;
    hardSeconds += clip.samples.length / SAMPLE_RATE + 1;
  }

  // 3. 公開語料與合成雜訊／音樂（每小時誤報；這段也量 CPU）
  const sources: { name: string; seconds: number; falseAlarms: Record<string, number>; examples: { file: string; keyword: string }[] }[] = [];
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const chunkMs: number[] = [];
  let negSeconds = 0;
  for (const dir of job.negatives) {
    spotter.restart();
    const src = { name: basename(dir), seconds: 0, falseAlarms: {} as Record<string, number>, examples: [] as { file: string; keyword: string }[] };
    for (const file of wavFiles(dir)) {
      if (src.seconds >= job.negativeHours * 3600) break;
      const wav = parseWav(readFileSync(file));
      const samples = resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
      const r = feed(spotter, samples, 0);
      chunkMs.push(...r.chunkMs);
      for (const d of r.detections) {
        src.falseAlarms[d.keyword] = (src.falseAlarms[d.keyword] ?? 0) + 1;
        if (src.examples.length < 10) src.examples.push({ file: basename(file), keyword: candidateById(d.keyword)?.label ?? d.keyword });
      }
      src.seconds += samples.length / SAMPLE_RATE;
    }
    negSeconds += src.seconds;
    sources.push(src);
  }
  for (const [name, minutes, make] of [
    ["white_noise", job.noiseMinutes, (s: number) => whiteNoise(60, 0.05, s)],
    ["synthetic_music", job.musicMinutes, (s: number) => syntheticMusic(60, 0.05, s)],
  ] as const) {
    if (!(minutes > 0)) continue;
    spotter.restart();
    const src = { name, seconds: 0, falseAlarms: {} as Record<string, number>, examples: [] as { file: string; keyword: string }[] };
    for (let i = 0; i < minutes; i++) {
      const r = feed(spotter, make(1000 + i), 0);
      chunkMs.push(...r.chunkMs);
      for (const d of r.detections) src.falseAlarms[d.keyword] = (src.falseAlarms[d.keyword] ?? 0) + 1;
      src.seconds += 60;
    }
    negSeconds += src.seconds;
    sources.push(src);
  }
  const cpu = process.cpuUsage(cpu0);
  const wall = (performance.now() - wall0) / 1000;
  spotter.free();

  const label = (id: string) => candidateById(id)?.label ?? id;
  const totalFa = (id: string) => sources.reduce((n, s) => n + (s.falseAlarms[id] ?? 0), 0);
  process.send!({
    job: { ...job, negatives: job.negatives.map((d) => basename(d)) },
    package_version: spotter.packageVersion,
    keywords_text: keywordsText.trim().split("\n"),
    load_ms: round(loadMs, 1),
    rss_mb: { before_load: round(rssBefore / 1048576, 1), after_load: round(rssAfterLoad / 1048576, 1), engine_delta: round((rssAfterLoad - rssBefore) / 1048576, 1), peak: round(process.resourceUsage().maxRSS / 1024, 1) },
    positives: positiveResults,
    estimated_length_s: Object.fromEntries(Object.entries(lengthEstimates).map(([k, v]) => [label(k), summarize(v)])),
    token_span_s: Object.fromEntries(Object.entries(spans).map(([k, v]) => [label(k), summarize(v)])),
    hard_negatives: { utterances: msg.hardNegatives.length, seconds: round(hardSeconds, 1), false_alarms: Object.fromEntries(Object.entries(hardFa).map(([k, v]) => [label(k), v])) },
    negatives: {
      seconds: round(negSeconds, 1),
      hours: round(negSeconds / 3600, 3),
      sources: sources.map((s) => ({ name: s.name, hours: round(s.seconds / 3600, 3), false_alarms: Object.fromEntries(Object.entries(s.falseAlarms).map(([k, v]) => [label(k), v])), examples: s.examples })),
      per_hour: Object.fromEntries(candidates.map((c) => [c.label, round(perHour(totalFa(c.id), negSeconds), 3)])),
      false_alarms: Object.fromEntries(candidates.map((c) => [c.label, totalFa(c.id)])),
    },
    perf: {
      cpu_seconds_per_audio_second: round((cpu.user + cpu.system) / 1e6 / negSeconds, 4),
      single_core_percent_at_realtime: round(((cpu.user + cpu.system) / 1e6 / negSeconds) * 100, 2),
      rtf: round(realTimeFactor(wall, negSeconds), 4),
      chunk_ms: summarize(chunkMs),
    },
  });
  process.exit(0);
}

function runJob(job: Job, positives: Clip[], hardNegatives: Clip[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["worker"], { serialization: "advanced", execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let result: Record<string, unknown> | null = null;
    child.on("message", (m) => (result = m as Record<string, unknown>));
    child.on("exit", (code) => (result ? resolve(result) : reject(new Error(`worker for ${job.model} ${job.engine} b${job.boost} t${job.threshold} exited with ${code}`))));
    child.send({ job, positives, hardNegatives });
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "worker") return worker();
  const a = parseArgs(process.argv.slice(2));
  const models = list(a.models, "zh-en-3M,wenetspeech-3.3M") as ModelId[];
  const engines = list(a.engines, "node@2.0.1") as EngineId[];
  const precisions = list(a.precisions, "int8") as Precision[];
  const boosts = list(a.boosts, "1.0").map(Number);
  const thresholds = list(a.thresholds, "0.25").map(Number);
  const negatives = list(a.negatives, "");
  const jobsN = Number(a.jobs ?? 2);
  const set = (a.set ?? "main") as Job["set"];
  if (set !== "main" && set !== "variants") throw new Error("--set must be main or variants");
  const base = { set, negatives, negativeHours: Number(a["negative-hours"] ?? 6), noiseMinutes: Number(a["noise-minutes"] ?? 15), musicMinutes: Number(a["music-minutes"] ?? 15) };
  const jobs: Job[] = models.flatMap((model) => engines.flatMap((engine) => precisions.flatMap((precision) => boosts.flatMap((boost) => thresholds.map((threshold) => ({ ...base, model, engine, precision, boost, threshold }))))));
  console.error(`合成正例中（TTS，合成語音不是真人）/ synthesizing positives (TTS, not human speech)…`);
  const t0 = performance.now();
  const { positives, hardNegatives, lengths } = synthesize(Number(a.speakers ?? 30));
  console.error(`正例 ${positives.length} 段、困難負例 ${hardNegatives.length} 段（${round((performance.now() - t0) / 1000, 1)} s）；共 ${jobs.length} 組設定 / configs`);
  const results: Record<string, unknown>[] = [];
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.max(1, jobsN) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const r = await runJob(job, positives, hardNegatives);
        results.push(r);
        console.error(`完成 / done: ${job.model} ${job.engine} ${job.precision} boost ${job.boost} threshold ${job.threshold}`);
      }
    }),
  );
  const report = {
    kind: "wk00-bench",
    environment: "cloud container, synthetic TTS positives and public corpora; not a Mac and not a living room / 雲端容器、合成或公開語料，不是 Mac、不是客廳",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    positives: { clips: positives.length, contexts: [...new Set(positives.map((p) => p.context))], voices: [...new Set(positives.map((p) => `${p.voice}`))], speakers_aishell3: new Set(positives.filter((p) => p.voice === "aishell3").map((p) => p.sid)).size, melo_speeds: [0.8, 0.9, 1.0, 1.1, 1.2] },
    tts_word_length_s: Object.fromEntries(Object.entries(lengths).map(([k, v]) => [CANDIDATES.find((c: Candidate) => c.id === k)?.label ?? k, v])),
    results: results.sort((x, y) => JSON.stringify(x.job).localeCompare(JSON.stringify(y.job))),
  };
  const file = writeReport(a.out ?? defaultOutputDir(), `wk00-bench-${Date.now()}.json`, report);
  console.error(`report / 報告: ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
