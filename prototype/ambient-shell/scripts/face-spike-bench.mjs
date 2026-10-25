#!/usr/bin/env node
// ID-00 人臉 spike 的可重現量測（docs/validation/family-id-00-spike-2026-10-24.md）。
// 以 headless Chromium 開 spike 頁的圖片模式，1280×720 畫格、不同臉寬下比較 YuNet 與 MediaPipe Face Detector 的偵測與耗時，
// 並計算 SFace cosine（只作 sanity check，不是準確率）。不使用鏡頭、不需要帳號；結果是本機 CPU／WASM 數字，不能當成 Mac 實機數據。
//
// 前置（在 prototype/ambient-shell）：npm ci && npm run face:setup
// 用法：node scripts/face-spike-bench.mjs --output <repo 外的資料夾> [--images <資料夾>] [--iterations 20] [--warmup 3] [--threads 1,4] [--screenshots]
//   --output 必須在 repo 之外：下載的人臉圖片與報告不能誤入 git。建置產物放在系統暫存資料夾，結束即刪。
//   --screenshots 才存畫面截圖（含人臉），預設不存。
//   只重算既有結果的彙總：--from-report <report.json> --output <repo 外的資料夾>
//   --images 省略時，從維基共享資源下載下列公有領域肖像的 1280 px 縮圖，並記錄授權與 SHA-256。
// Playwright 需另行安裝：PLAYWRIGHT_MODULE 指向模組；CHROMIUM_PATH 可覆寫瀏覽器（預設用 Playwright 自帶的 Chromium）。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(app, '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const output = resolve(arg('output', join(tmpdir(), `aios-face-spike-${Date.now()}`)));
const insideRepo = (p) => {
  const rel = relative(repoRoot, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
if (insideRepo(output)) {
  console.error(`--output 不可在 repo 內（${output}）：下載的人臉圖片與報告不能誤入 git。請改用 repo 外的資料夾。`);
  process.exit(1);
}
const screenshots = process.argv.includes('--screenshots');
const iterations = Number(arg('iterations', '20'));
const warmup = Number(arg('warmup', '3'));
const threadsList = arg('threads', '1,4').split(',').map(Number);
const faceWidths = [null, 60, 100, 150];
await mkdir(output, { recursive: true });

// 公有領域（美國聯邦政府作品）官方肖像；同一人兩張不同年份，另有第三人。授權以下載時 API 回傳的 extmetadata 為準並寫入報告。
const COMMONS = [
  { file: 'biden_2021.jpg', title: 'File:Joe Biden presidential portrait.jpg', person: 'A' },
  { file: 'biden_2013.jpg', title: 'File:Official portrait of Vice President Joe Biden.jpg', person: 'A' },
  { file: 'harris_2021.jpg', title: 'File:Kamala Harris Vice Presidential Portrait.jpg', person: 'B' },
  { file: 'harris_2017.jpg', title: 'File:Kamala Harris official photo.jpg', person: 'B' },
  { file: 'obama_2012.jpg', title: 'File:President Barack Obama.jpg', person: 'C' },
];
const UA = 'AIOS-face-spike/0.1 (https://github.com/pcpcchen-coder/AIOS; validation)';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}: ${url}`);
    await sleep(Number(res.headers.get('retry-after') ?? 10) * 1000 + attempt * 2000);
  }
  throw new Error(`retries exhausted: ${url}`);
}

const plain = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function downloadImages(dir) {
  await mkdir(dir, { recursive: true });
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|extmetadata|sha1', iiurlwidth: '1280', titles: COMMONS.map((c) => c.title).join('|') }))
    api.searchParams.set(k, v);
  const pages = Object.values((await (await fetchRetry(api)).json()).query.pages);
  const sources = [];
  for (const c of COMMONS) {
    const page = pages.find((p) => p.title === c.title);
    const info = page?.imageinfo?.[0];
    if (!info) throw new Error(`Commons 查無檔案：${c.title}`);
    const license = info.extmetadata?.LicenseShortName?.value;
    if (!/public domain|cc0/i.test(String(license))) throw new Error(`${c.title} 授權不是公有領域／CC0：${license}`);
    const buf = Buffer.from(await (await fetchRetry(info.thumburl)).arrayBuffer());
    await writeFile(join(dir, c.file), buf);
    sources.push({ ...c, page: info.descriptionurl, license, artist: plain(info.extmetadata?.Artist?.value), original: `${info.width}x${info.height}`, thumb_sha256: sha256(buf), thumb_bytes: buf.length });
    await sleep(1500);
  }
  return sources;
}

async function measure() {
  const imagesDir = arg('images', null) ? resolve(arg('images')) : join(output, 'images');
  const sources = arg('images', null) ? null : await downloadImages(imagesDir);
  const imageFiles = (await readdir(imagesDir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (imageFiles.length < 2) throw new Error(`需要至少兩張圖片：${imagesDir}`);

  const publicDir = join(app, 'spike/face/public');
  if (!existsSync(join(publicDir, 'models/face_recognition_sface_2021dec.onnx'))) throw new Error('缺模型：先在 prototype/ambient-shell 執行 npm run face:setup');
  const buildDir = await mkdtemp(join(tmpdir(), 'aios-face-spike-build-'));
  execFileSync(join(app, 'node_modules/.bin/vite'), ['build', '--config', 'spike/face/vite.config.ts', '--outDir', buildDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: app, stdio: 'inherit' });

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream', '.data': 'application/octet-stream' };
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(buildDir, path || 'index.html');
    if (!file.startsWith(buildDir)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  let playwright;
  try { playwright = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName); }
  catch (error) { server.close(); throw new Error('Install Playwright separately or set PLAYWRIGHT_MODULE to its module path.', { cause: error }); }
  const browser = await playwright.chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true });

  const report = {
    label: 'CLOUD CONTAINER CPU/WASM (headless Chromium) — not a Mac / AR0144 measurement; cosine is a sanity check, not accuracy',
    date: new Date().toISOString(),
    runtime: { node: process.version, chromium: browser.version(), platform: `${process.platform}/${process.arch}` },
    method: { frame: '1280x720', faceWidthsTarget: faceWidths, iterations, warmup, threads: threadsList, timing: 'performance.now() per call; median and nearest-rank p95 over iterations after warmup' },
    sources,
    images: Object.fromEntries(await Promise.all(imageFiles.map(async (f) => [f, sha256(await readFile(join(imagesDir, f)))]))),
    runs: [],
    offOriginRequests: [],
    /** 被頁面 CSP（connect-src 'self'）擋下、沒有離開瀏覽器的連線嘗試 */
    cspBlockedRequests: [],
  };

  try {
    for (const threads of threadsList) {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        consoleErrors.push(m.text());
        const blocked = /Refused to connect to '([^']+)'/.exec(m.text());
        if (blocked) report.cspBlockedRequests.push(blocked[1]);
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) report.offOriginRequests.push(r.url()); });
      await page.goto(base, { waitUntil: 'load' });
      await page.setInputFiles('#images', imageFiles.map((f) => join(imagesDir, f)));
      await page.waitForFunction(() => typeof window.faceSpike?.runImageBench === 'function');
      const loaded = await page.evaluate(async (t) => {
        const m = await window.faceSpike.loadModels({ threads: t, mpDelegate: 'CPU' });
        return { loadMs: m.loadMs, errors: m.errors, threads: m.threads, crossOriginIsolated: m.crossOriginIsolated };
      }, threads);
      await page.evaluate(() => window.faceSpike.setImages(document.getElementById('images').files));
      const started = Date.now();
      const result = await page.evaluate((o) => window.faceSpike.runImageBench(o), { faceWidths, iterations, warmup });
      if (screenshots) await page.screenshot({ path: join(output, `last-frame-threads${threads}.png`) });
      report.runs.push({ threadsRequested: threads, loaded, wallSeconds: (Date.now() - started) / 1000, result, consoleErrors });
      await page.close();
    }
    report.cameraSmoke = await cameraSmoke(playwright, base);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await rm(buildDir, { recursive: true, force: true });
  }

  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * 鏡頭模式的流程檢查，使用 Chromium 的假鏡頭（合成畫面，沒有人臉、不是 AR0144）。
 * 只確認迴圈會跑、停止後不再推論且畫布被清空；不產生任何偵測或耗時結論。
 */
async function cameraSmoke(playwright, base) {
  const browser = await playwright.chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const page = await browser.newPage();
    const offOriginRequests = [];
    const cspBlockedRequests = [];
    const consoleErrors = [];
    page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) offOriginRequests.push(r.url()); });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      consoleErrors.push(m.text());
      const blocked = /Refused to connect to '([^']+)'/.exec(m.text());
      if (blocked) cspBlockedRequests.push(blocked[1]);
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.faceSpike?.loadModels === 'function');
    await page.evaluate(() => window.faceSpike.loadModels({ threads: 1, mpDelegate: 'CPU' }).then(() => undefined));
    await page.click('#camera-start');
    await page.waitForFunction(() => document.getElementById('out').textContent.includes('timingsLastN'), null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const running = await page.evaluate(() => JSON.parse(document.getElementById('out').textContent));
    await page.click('#camera-stop');
    const afterStop = await page.evaluate(() => document.getElementById('out').textContent);
    await page.waitForTimeout(1500);
    const later = await page.evaluate(() => document.getElementById('out').textContent);
    // 以下讀像素的是量測腳本自己（檢查畫布已清空），不是 spike 頁的程式。
    const viewCleared = await page.evaluate(() => {
      const c = document.getElementById('view');
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.every((v) => v === 0);
    });
    const status = await page.textContent('#camera-status');
    return {
      device: 'Chromium fake video capture (synthetic pattern, no face) — flow check only',
      loopSamples: running.timingsLastN?.['yunet_fixed640.total']?.n ?? 0,
      yunetFacesOnFakeFeed: running.yunetFaces?.length ?? null,
      noInferenceAfterStop: afterStop === later,
      viewCleared,
      status,
      offOriginRequests,
      cspBlockedRequests,
      consoleErrors,
    };
  } finally {
    await browser.close();
  }
}

const fromReport = arg('from-report', null);
const report = fromReport ? JSON.parse(await readFile(resolve(fromReport), 'utf8')) : await measure();

// 彙總（計算方式同 docs/validation/family-id-00-spike-2026-10-24.md §2）：
// 每個畫格（圖片 × 臉寬）先得到該畫格 iterations 次的中位數與 p95；
// 再對所有畫格取「畫格中位數的中位數」與「畫格 p95 的最大值」。偵測率 = 至少偵測到一張臉的畫格數 ÷ 圖片數。
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const DETECTORS = [['yunet', 'fixed640'], ['yunet', 'dynamic'], ['mediapipe', 'short'], ['mediapipe', 'full']];
const TIMED = ['yunet_fixed640', 'yunet_dynamic', 'mediapipe_short', 'mediapipe_full', 'sface', 'frame_readback'];
const personOf = Object.fromEntries((report.sources ?? []).map((s) => [s.file, s.person]));
const lines = [];
for (const run of report.runs) {
  const frames = run.result.runs.filter((r) => r.analysis);
  lines.push(`\n## onnxruntime threads=${run.loaded.threads}, crossOriginIsolated=${run.loaded.crossOriginIsolated}`);
  lines.push(`模型載入 ms：${Object.entries(run.loaded.loadMs).map(([k, v]) => `${k} ${Math.round(v)}`).join('、')}；錯誤：${JSON.stringify(run.loaded.errors)}`);
  lines.push('\n| 項目 | 畫格中位數的中位數 ms | 畫格 p95 的最大值 ms | 畫格數 |');
  lines.push('|---|---:|---:|---:|');
  for (const k of TIMED) {
    const keys = k === 'frame_readback' ? [k] : [`${k}.total`, `${k}.pre`, `${k}.infer`, `${k}.post`];
    for (const key of keys) {
      const ts = frames.map((r) => r.timings?.[key]).filter(Boolean);
      if (ts.length) lines.push(`| ${key} | ${median(ts.map((t) => t.median)).toFixed(1)} | ${Math.max(...ts.map((t) => t.p95)).toFixed(1)} | ${ts.length} |`);
    }
  }
  lines.push('\n| 臉寬目標 px | YuNet 640 | YuNet 動態 | MP short | MP full | YuNet640 實際臉寬 | MP short 與 YuNet640 IoU |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const fw of report.method.faceWidthsTarget) {
    const rs = run.result.runs.filter((r) => r.faceWidthTarget === fw);
    const rate = (kind, v) => `${rs.filter((r) => r.analysis?.[kind]?.[v]?.faces > 0).length}/${rs.length}` + (rs.some((r) => r.analysis?.[kind]?.[v]?.faces > 1) ? '（含多框）' : '');
    const widths = rs.map((r) => r.analysis?.yunet?.fixed640?.widths?.[0]).filter((w) => w !== undefined);
    const ious = rs.map((r) => r.analysis?.boxDiff?.pairs?.[0]?.iou).filter((v) => v !== undefined);
    lines.push(`| ${fw ?? '原尺寸'} | ${rate('yunet', 'fixed640')} | ${rate('yunet', 'dynamic')} | ${rate('mediapipe', 'short')} | ${rate('mediapipe', 'full')} | ${widths.length ? `${Math.min(...widths).toFixed(0)}–${Math.max(...widths).toFixed(0)}` : '-'} | ${ious.length ? `${Math.min(...ious).toFixed(2)}–${Math.max(...ious).toFixed(2)}（${ious.length} 張）` : '無配對'} |`);
  }
  if (Object.keys(personOf).length) {
    lines.push('\n| 臉寬目標 px | 同一人 cosine | 不同人 cosine |');
    lines.push('|---|---|---|');
    for (const [fw, table] of Object.entries(run.result.cosine)) {
      const same = [];
      const diff = [];
      for (const [pair, v] of Object.entries(table)) {
        if (v === null) continue;
        const [a, b] = pair.split(' × ');
        (personOf[a] === personOf[b] ? same : diff).push(v);
      }
      const range = (xs) => (xs.length ? `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}（${xs.length} 對）` : '-');
      lines.push(`| ${fw === 'native' ? '原尺寸' : fw} | ${range(same)} | ${range(diff)} |`);
    }
  }
}
if (report.cameraSmoke) lines.push(`\n鏡頭模式流程檢查（假鏡頭）：${JSON.stringify(report.cameraSmoke)}`);
lines.push(`\n圖片模式：離開本機的請求（Playwright 觀察）${report.offOriginRequests.length}；被 CSP 擋下的連線嘗試 ${report.cspBlockedRequests?.length ?? 'n/a'} ${JSON.stringify([...new Set(report.cspBlockedRequests ?? [])])}`);
if (report.cameraSmoke) lines.push(`鏡頭模式：離開本機的請求 ${report.cameraSmoke.offOriginRequests?.length ?? 'n/a'}；被 CSP 擋下 ${report.cameraSmoke.cspBlockedRequests?.length ?? 'n/a'}`);
await writeFile(join(output, 'summary.md'), `${report.label}\n${lines.join('\n')}\n`);
console.log(`${report.label}\n${lines.join('\n')}\n\nsummary: ${join(output, 'summary.md')}`);
