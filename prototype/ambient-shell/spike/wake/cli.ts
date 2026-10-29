#!/usr/bin/env -S npx tsx
// WK-00 喚醒詞 spike 的 Node CLI（開發工具，不接進產品）。docs/validation/wk-00-spike-2026-10-29.md。
//
//   npm run wake:spike -- eval  [選項] <WAV 檔或資料夾…>     離線評估：讀 WAV、以 100 ms 分塊送進引擎
//   npm run wake:spike -- listen [選項]                       即時：從 stdin 讀 16-bit little-endian 單聲道 PCM
//        --mode plain   偵測到就印一行（預設）
//        --mode tv      電視負例：只計數、不錄音，--hours N 後自動結束；--program "節目名稱"（可在終端機打字＋Enter 更新）
//        --mode family  家人正例：引導念 --trials 30 次「哈囉努斯」，統計成功率與延遲；--person 只填代號（例如 A）
//
// 麥克風在 macOS 上以 sox 擷取並經管線送進來（sox 是使用者另裝的獨立程式，不是本專案依賴，見驗證文件）：
//   rec -q -t raw -r 16000 -e signed -b 16 -c 1 - | npm run wake:spike -- listen --mode tv --hours 8 --program "新聞台"
//
// 隱私：麥克風音訊只在記憶體——stdin 的每一塊轉成 float 後送進引擎與 2 秒環形緩衝（ring-buffer.ts），用完即丟；
// 不寫檔、不進 log、不外傳。偵測時只輸出時間、關鍵詞、分數（sherpa-onnx 不提供，固定為 null）、推估長度與當下 CPU。
// 結果 JSON 只含這些數字（report.ts 會拒絕音訊形狀的資料），預設寫到 repo 外。

import { readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseWav, pcm16leToFloat32, resample } from "./audio.ts";
import { createSpotter, DEFAULT_OPTIONS, ENGINE_IDS, type Detection, type EngineId, type Spotter, type SpotterOptions } from "./engines.ts";
import { buildKeywordsText, candidateById, formatSetting, MODEL_IDS, parseKeywordSpec, parseTokens, type KeywordSetting, type ModelId } from "./keywords.ts";
import { modelPaths, tokensText, type Precision } from "./models.ts";
import { defaultOutputDir, writeReport } from "./report.ts";
import { AudioRing } from "./ring-buffer.ts";
import { feed, SAMPLE_RATE } from "./run.ts";
import { cpuPercent, estimateKeywordSeconds, hourlyBuckets, perHour, realTimeFactor, PERSON_CODE, sampleWallMs, speechBounds, successRate, summarize } from "./stats.ts";

const HELP = `WK-00 wake-word spike / 喚醒詞 spike（不是產品功能 / not a product feature）

eval   [options] <wav|dir>...   offline WAV evaluation / 離線 WAV 評估
listen [options]                live s16le mono PCM on stdin / 從 stdin 讀即時 PCM
       --mode plain|tv|family   (tv: --hours N --program NAME; family: --trials 30 --person CODE)
       --rate 16000             stdin sample rate / stdin 取樣率

common / 共用:
  --model wenetspeech-3.3M|zh-en-3M   (default zh-en-3M)
  --engine ${ENGINE_IDS.join("|")}    (default node@2.0.1; 1.13.8 needs WAKE_SHERPA_V1_DIR)
  --precision int8|fp32               (default int8)
  --keywords "哈囉努斯:1.5#0.35,嘿努斯"  (":" boost, "#" threshold)
  --keywords-file <file>              raw sherpa-onnx keyword lines / 直接用關鍵詞檔
  --threshold 0.25 --score 1.0        engine defaults / 引擎預設門檻與提升分數
  --threads 1  --out <dir>            (default ${defaultOutputDir()}; inside the repo only spike/wake/results/)
`;

type Args = { _: string[]; [k: string]: string | string[] | boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

const str = (args: Args, key: string, fallback: string): string => (typeof args[key] === "string" ? (args[key] as string) : fallback);
const num = (args: Args, key: string, fallback: number): number => {
  const v = typeof args[key] === "string" ? Number(args[key]) : fallback;
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
};

interface Setup {
  model: ModelId;
  engine: EngineId;
  precision: Precision;
  settings: KeywordSetting[];
  keywordsText: string;
  options: SpotterOptions;
  spotter: Spotter;
  loadMs: number;
  rssBeforeLoad: number;
  rssAfterLoad: number;
}

function setup(args: Args): Setup {
  const model = str(args, "model", "zh-en-3M") as ModelId;
  if (!MODEL_IDS.includes(model)) throw new Error(`--model must be one of ${MODEL_IDS.join(", ")}`);
  const engine = str(args, "engine", "node@2.0.1") as EngineId;
  if (!ENGINE_IDS.includes(engine)) throw new Error(`--engine must be one of ${ENGINE_IDS.join(", ")}`);
  const precision = str(args, "precision", "int8") as Precision;
  if (precision !== "int8" && precision !== "fp32") throw new Error("--precision must be int8 or fp32");
  const paths = modelPaths(model, precision);
  const fallback = model === "zh-en-3M" ? "哈囉努斯,嘿努斯,Hey Nous" : "哈囉努斯,嘿努斯";
  // --keywords-file：直接用 sherpa-onnx 格式的關鍵詞檔（例如試其他念法或上游測試詞），單元仍須在 tokens.txt 裡
  const file = typeof args["keywords-file"] === "string" ? (args["keywords-file"] as string) : null;
  const settings = file ? [] : parseKeywordSpec(str(args, "keywords", fallback));
  const keywordsText = file ? checkedKeywordsFile(readFileSync(file, "utf8"), parseTokens(tokensText(paths))) : buildKeywordsText(settings, model, parseTokens(tokensText(paths)));
  const options: SpotterOptions = {
    ...DEFAULT_OPTIONS,
    threads: num(args, "threads", DEFAULT_OPTIONS.threads),
    keywordsThreshold: num(args, "threshold", DEFAULT_OPTIONS.keywordsThreshold),
    keywordsScore: num(args, "score", DEFAULT_OPTIONS.keywordsScore),
  };
  const rssBeforeLoad = process.memoryUsage().rss;
  const t0 = performance.now();
  const spotter = createSpotter(engine, paths, keywordsText, options);
  const loadMs = performance.now() - t0;
  return { model, engine, precision, settings, keywordsText, options, spotter, loadMs, rssBeforeLoad, rssAfterLoad: process.memoryUsage().rss };
}

/** 檢查自訂關鍵詞檔：每行的發音單元（`:`、`#`、`@` 開頭的除外）都要在 tokens.txt。 */
function checkedKeywordsFile(text: string, tokens: ReadonlySet<string>): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("keywords file is empty");
  for (const line of lines) {
    const missing = line.split(/\s+/).filter((t) => !/^[:#@]/.test(t) && !tokens.has(t));
    if (missing.length) throw new Error(`unknown token(s) ${missing.join(" ")} in: ${line}`);
  }
  return lines.join("\n") + "\n";
}

function describe(s: Setup) {
  return {
    model: s.model,
    engine: s.engine,
    package_version: s.spotter.packageVersion,
    precision: s.precision,
    keywords: s.settings.length ? s.settings.map(formatSetting) : s.keywordsText.trim().split("\n"),
    engine_defaults: { threshold: s.options.keywordsThreshold, score: s.options.keywordsScore, threads: s.options.threads },
    load_ms: round(s.loadMs, 1),
    rss_mb: { before_load: mb(s.rssBeforeLoad), after_load: mb(s.rssAfterLoad) },
  };
}

const round = (v: number | null | undefined, d = 3): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const mb = (bytes: number) => round(bytes / 1048576, 1);
const label = (d: Detection) => candidateById(d.keyword)?.label ?? d.keyword;
const settingFor = (settings: KeywordSetting[], id: string) => settings.find((s) => s.candidate.id === id);

function wavFiles(paths: string[]): string[] {
  return paths.flatMap((p) => (statSync(p).isDirectory() ? wavFiles(readdirSync(p).sort().map((f) => join(p, f))) : extname(p).toLowerCase() === ".wav" ? [p] : []));
}

function evalCommand(args: Args): void {
  const files = wavFiles(args._.slice(1));
  if (files.length === 0) throw new Error("no .wav files given / 沒有 WAV 檔");
  const s = setup(args);
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  let audioSeconds = 0;
  const chunkMs: number[] = [];
  const perFile = files.map((file) => {
    const wav = parseWav(readFileSync(file));
    const samples = resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
    s.spotter.restart();
    const r = feed(s.spotter, samples);
    const tail = s.spotter.finish().map((d) => ({ ...d, at: samples.length / SAMPLE_RATE }));
    audioSeconds += samples.length / SAMPLE_RATE;
    chunkMs.push(...r.chunkMs);
    samples.fill(0);
    return {
      file: basename(file),
      seconds: round(wav.samples.length / wav.sampleRate, 2),
      detections: [...r.detections, ...tail].map((d) => ({ at: round(d.at, 2), keyword: label(d), estimated_length_s: round(estimateKeywordSeconds(d.timestamps), 2) })),
    };
  });
  const wall = (performance.now() - wall0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const report = {
    kind: "wk00-eval",
    note: "offline WAV evaluation; numbers depend on this machine / 離線評估，數字只代表執行的這台機器",
    ...describe(s),
    files: perFile,
    totals: {
      audio_seconds: round(audioSeconds, 1),
      detections: perFile.reduce((n, f) => n + f.detections.length, 0),
      rtf: round(realTimeFactor(wall, audioSeconds), 4),
      cpu_seconds_per_audio_second: round((cpu.user + cpu.system) / 1e6 / audioSeconds, 4),
      chunk_ms: summarize(chunkMs),
      rss_peak_mb: round(process.resourceUsage().maxRSS / 1024, 1),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.out !== undefined || args.save) console.error(`report / 報告: ${writeReport(str(args, "out", defaultOutputDir()), `wk00-eval-${Date.now()}.json`, report)}`);
  s.spotter.free();
}

/** 每秒取一次 CPU 比例（單核 = 100%）。 */
function cpuSampler() {
  let last = process.cpuUsage();
  let lastWall = process.hrtime.bigint();
  let percent: number | null = null;
  const samples: number[] = [];
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const used = process.cpuUsage(last);
    percent = cpuPercent(used.user + used.system, Number(now - lastWall) / 1000);
    if (percent !== null) samples.push(percent);
    last = process.cpuUsage();
    lastWall = now;
  }, 1000);
  timer.unref();
  return { current: () => percent, summary: () => summarize(samples), stop: () => clearInterval(timer) };
}

async function listenCommand(args: Args): Promise<void> {
  const mode = str(args, "mode", "plain");
  if (!["plain", "tv", "family"].includes(mode)) throw new Error("--mode must be plain, tv or family");
  const rate = num(args, "rate", SAMPLE_RATE);
  // 報告只放代號，不放名字（17 §13.3 S11 的精神）
  const person = str(args, "person", "X");
  if (!PERSON_CODE.test(person)) throw new Error("--person must be a 1–4 character code such as A / --person 只能填 1–4 個英數字代號");
  const s = setup(args);
  const ring = new AudioRing();
  const cpu = cpuSampler();
  const startedMs = Date.now();
  const hours = num(args, "hours", mode === "tv" ? 8 : 0);
  const maxSeconds = num(args, "max-seconds", hours > 0 ? hours * 3600 : 0);
  let program = str(args, "program", "");
  const programs: { name: string; from: string }[] = program ? [{ name: program, from: new Date(startedMs).toISOString() }] : [];
  const events: Record<string, unknown>[] = [];
  const eventMs: number[] = [];
  // 最近一塊到達時的樣本序號與牆鐘；較早的樣本依即時取樣率往回推算（sampleWallMs），
  // 不用「整塊到達的時間」代表塊內每個樣本，避免低估延遲（審查指出最多約 256 ms）。
  let lastArrival: { sample: number; wall: number } | null = null;
  let leftover = new Uint8Array(0);

  // family 模式的狀態
  const trials = num(args, "trials", 30);
  if (mode === "family" && s.settings.length === 0) throw new Error("family mode needs --keywords / 家人模式需要 --keywords");
  const target = s.settings[0]!;
  const results: { trial: number; success: boolean; latency_from_speech_end_ms: number | null; latency_from_last_token_ms: number | null; other_detections: number }[] = [];
  let trial = 0;
  let trialDeadline = 0;
  let trialOther = 0;
  let pauseUntil = 0;
  const nextTrial = () => {
    trial += 1;
    trialOther = 0;
    pauseUntil = 0;
    trialDeadline = Date.now() + 6000;
    console.error(`\n第 ${trial}/${trials} 次：請說「${target.candidate.label}」 / Trial ${trial}/${trials}: say "${target.candidate.label}"`);
  };

  if (mode === "tv" && process.stdin.isTTY !== true) {
    // stdin 是音訊管線，節目名稱改從終端機讀：打字後按 Enter 就更新。
    try {
      const input = createReadStream("/dev/tty");
      // 沒有終端機（例如背景執行）時開檔是非同步失敗，不能讓它中止聆聽
      input.on("error", () => console.error("無法讀取終端機，節目名稱只能用 --program 指定 / cannot read the terminal; use --program"));
      const tty = createInterface({ input });
      tty.on("error", () => undefined);
      tty.on("line", (line) => {
        const name = line.trim();
        if (!name) return;
        program = name;
        programs.push({ name, from: new Date().toISOString() });
        console.error(`節目更新為 / program set to: ${name}`);
      });
      process.on("exit", () => tty.close());
    } catch {
      console.error("無法讀取終端機，節目名稱只能用 --program 指定 / cannot read the terminal; use --program");
    }
  }
  if (process.stdin.isTTY) throw new Error("pipe 16-bit PCM into stdin (see --help) / 請以管線把 PCM 送進 stdin");

  const wallForSample = (sample: number): number | null => (lastArrival ? sampleWallMs(lastArrival, sample, SAMPLE_RATE) : null);

  const onDetection = (d: Detection) => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const setting = settingFor(s.settings, d.keyword);
    // 最後一個發音單元的時間戳 → 牆鐘；能量端點：環形緩衝最後 2 秒中語音結束的位置 → 牆鐘
    const lastTs = d.timestamps.length ? Math.max(...d.timestamps) : null;
    const lastTokenWall = lastTs === null ? null : wallForSample(Math.round(lastTs * SAMPLE_RATE));
    const tail = ring.latest();
    const bounds = speechBounds(tail, SAMPLE_RATE);
    const speechEndWall = bounds ? wallForSample(ring.pushed - tail.length + Math.round(bounds.end * SAMPLE_RATE)) : null;
    tail.fill(0);
    const event = {
      time: at,
      keyword: label(d),
      score: null,
      threshold: setting?.threshold ?? s.options.keywordsThreshold,
      boost: setting?.boost ?? s.options.keywordsScore,
      estimated_length_s: round(estimateKeywordSeconds(d.timestamps), 2),
      cpu_percent: round(cpu.current(), 1),
      ...(mode === "tv" ? { program: program || null } : {}),
    };
    console.log(JSON.stringify(event));
    events.push(event);
    eventMs.push(now);
    if (mode === "family" && trial > 0 && trial <= trials && pauseUntil === 0) {
      if (d.keyword === target.candidate.id && now <= trialDeadline) {
        results.push({
          trial,
          success: true,
          latency_from_speech_end_ms: speechEndWall === null ? null : now - speechEndWall,
          latency_from_last_token_ms: lastTokenWall === null ? null : now - lastTokenWall,
          other_detections: trialOther,
        });
        console.error("成功 / detected");
        pauseUntil = now + 1500;
      } else trialOther += 1;
    }
  };

  const finish = (reason: string) => {
    cpu.stop();
    // 每小時誤報以實際收到的音訊長度計（即時麥克風時約等於牆鐘時間；管線送檔時比牆鐘長）
    const audioSeconds = ring.pushed / SAMPLE_RATE;
    ring.clear();
    const endedMs = Date.now();
    const listened = (endedMs - startedMs) / 1000;
    const base = { kind: `wk00-listen-${mode}`, reason, started_at: new Date(startedMs).toISOString(), ended_at: new Date(endedMs).toISOString(), listened_seconds: round(listened, 1), audio_seconds: round(audioSeconds, 1), ...describe(s), cpu_percent: cpu.summary() };
    let report: object = { ...base, events };
    if (mode === "tv") {
      report = {
        ...base,
        note: "TV negative run: counts only, no audio recorded / 電視負例：只計數，不錄音",
        programs,
        false_alarms: events.length,
        false_alarms_per_hour: round(perHour(events.length, audioSeconds), 3),
        per_hour_buckets: hourlyBuckets(eventMs, startedMs, endedMs),
        events,
      };
    } else if (mode === "family") {
      const ok = results.filter((r) => r.success);
      report = {
        ...base,
        person,
        keyword: target.candidate.label,
        trials: results,
        attempts: results.length,
        success_rate: round(successRate(ok.length, results.length), 3),
        latency_from_speech_end_ms: summarize(ok.map((r) => r.latency_from_speech_end_ms).filter((v): v is number => v !== null)),
        latency_from_last_token_ms: summarize(ok.map((r) => r.latency_from_last_token_ms).filter((v): v is number => v !== null)),
      };
    }
    console.error(`\n${JSON.stringify(report, null, 2)}`);
    console.error(`report / 報告: ${writeReport(str(args, "out", defaultOutputDir()), `wk00-${mode}-${startedMs}.json`, report)}`);
    s.spotter.free();
    process.exit(0);
  };

  process.on("SIGINT", () => finish("interrupted"));
  if (mode === "family") nextTrial();
  console.error(`聆聽中（只在本機、不錄音）/ listening locally, nothing recorded — ${s.model} ${s.engine} ${s.settings.map(formatSetting).join(", ")}`);

  const status = setInterval(() => {
    if (mode !== "family") console.error(`[${new Date().toISOString()}] cpu ${round(cpu.current(), 1)}% · detections ${events.length}${mode === "tv" ? ` · program ${program || "-"}` : ""}`);
  }, 60_000);
  status.unref();

  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    const bytes = new Uint8Array(leftover.length + chunk.length);
    bytes.set(leftover, 0);
    bytes.set(chunk, leftover.length);
    const even = bytes.length - (bytes.length % 2);
    leftover = bytes.slice(even);
    let samples = pcm16leToFloat32(bytes.subarray(0, even));
    bytes.fill(0);
    if (rate !== SAMPLE_RATE) samples = resample(samples, rate, SAMPLE_RATE);
    ring.push(samples);
    const now = Date.now();
    lastArrival = { sample: ring.pushed, wall: now };
    for (const d of s.spotter.accept(samples)) onDetection(d);
    samples.fill(0);
    if (mode === "family") {
      if (pauseUntil > 0 && now >= pauseUntil) {
        if (trial >= trials) return finish("done");
        nextTrial();
      } else if (pauseUntil === 0 && now > trialDeadline) {
        results.push({ trial, success: false, latency_from_speech_end_ms: null, latency_from_last_token_ms: null, other_detections: trialOther });
        console.error("沒有偵測到 / not detected");
        pauseUntil = now + 1500;
      }
    }
    if (maxSeconds > 0 && (now - startedMs) / 1000 >= maxSeconds) return finish("time limit");
  }
  finish("input ended");
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help) {
    console.log(HELP);
    return;
  }
  if (cmd === "eval") return evalCommand(args);
  if (cmd === "listen") return listenCommand(args);
  throw new Error(`unknown command ${cmd}\n${HELP}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
