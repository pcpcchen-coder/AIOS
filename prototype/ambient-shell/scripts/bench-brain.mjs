#!/usr/bin/env node
// Brain canvas benchmark and pixel comparison: baseline brain.ts (a git ref) against the working tree.
// --webgl instead compares the working tree's Canvas 2D renderer with its WebGL renderer (same brain, same events),
// with WebGL forced onto software GL (SwiftShader) because headless Chromium has no GPU here.
// Headless Chromium in this environment is a relative measurement only; it is not a Raspberry Pi number.
// Usage: node scripts/bench-brain.mjs [--baseline <git-ref>] [--candidate <brain.ts copy>] [--frames 300] [--runs 3] [--json <file>] [--skip-bench] [--skip-pixels] [--no-raster]
//        node scripts/bench-brain.mjs --webgl [--frames 300] [--runs 3] [--json <file>] [--shots <dir>] [--skip-bench] [--skip-pixels]
// PLAYWRIGHT_MODULE overrides the Playwright module path.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);
// main before the per-frame optimization; pinned so the comparison still means something after merge.
// esbuild comes with vite (package-lock.json); it bundles both copies for the page.
const baselineRef = arg('baseline', 'd28ce235f98b75097c97e8efc5870407e1740b46');
const frames = Number(arg('frames', 300));
const runs = Number(arg('runs', 3));
const warmup = 60;
// Visible threshold (canvas composited over black and over white): max channel difference, and share of pixels that differ at all.
const MAX_CHANNEL_DIFF = 2;
const MAX_DIFF_SHARE = 0.005;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const work = await mkdtemp(join(tmpdir(), 'bench-brain-'));
const src = join(app, 'src');
// Copies are bundled from a temp directory, so their relative imports are pointed back at src/ and shared/.
const absoluteImports = (source) => source.replace(/from "\.\.\/shared\//g, `from "${join(app, 'shared')}/`).replace(/from "\.\//g, `from "${src}/`);
const baselineSource = execFileSync('git', ['show', `${baselineRef}:prototype/ambient-shell/src/brain.ts`], { cwd: repo, encoding: 'utf8' });
await writeFile(join(work, 'baseline-brain.ts'), absoluteImports(baselineSource));
const candidate = resolve(arg('candidate', join(src, 'brain.ts')));
await writeFile(join(work, 'candidate-brain.ts'), absoluteImports(await readFile(candidate, 'utf8')));

async function bundle(entry, globalName) {
  const out = await build({ entryPoints: [entry], bundle: true, format: 'iife', globalName, write: false, target: 'es2022', logLevel: 'error' });
  return out.outputFiles[0].text;
}
const baselineJs = await bundle(join(work, 'baseline-brain.ts'), 'BaselineBrain');
const currentJs = await bundle(join(work, 'candidate-brain.ts'), 'CurrentBrain');
const performanceJs = await bundle(join(src, 'performance.ts'), 'Perf');

// Runs inside the page. The scenario is a live call with the language region active, a progress ring,
// processing tint and fresh pulses every 15 frames; Math.random is seeded so both renderers spawn the same pulses.
function harness() {
  const seeded = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const activity = [{ domain: 'language', source: 'tts', owner: 'speech' }, { domain: 'planning', source: 'topic', owner: 'req_bench' }];
  const state = { conversation: 'speaking', listening: true, working: true, layout: 'center', progress: 0.4, activity, voice: 'live', processing: true };

  function make(lib, budgetName) {
    Math.random = seeded(7);
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const brain = new lib.Brain(canvas);
    brain.setRenderBudget(Perf.RENDER_BUDGETS[budgetName]);
    brain.setState(state);
    brain.pulse('submit', 'language');
    brain.pulse('success');
    const dt = 1 / Perf.RENDER_BUDGETS[budgetName].maxFps;
    let frame = 0;
    const advance = () => {
      if (frame % 15 === 0) { brain.pulse('step', 'language'); brain.pulse('stream', 'planning'); brain.pulse('stepDone'); }
      if (frame % 90 === 45) brain.cuePing();
      frame++;
      const t0 = performance.now();
      brain.step(dt);
      brain.draw();
      return performance.now() - t0;
    };
    return { brain, canvas, advance };
  }

  const nextFrame = () => new Promise((done) => requestAnimationFrame(() => done()));
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { median: at(0.5), p95: at(0.95), mean: values.reduce((s, v) => s + v, 0) / values.length, n: values.length };
  };

  window.benchRun = async (which, budgetName, count, warm, flush) => {
    const lib = which === 'baseline' ? BaselineBrain : CurrentBrain;
    const r = make(lib, budgetName);
    const ctx = r.canvas.getContext('2d');
    const drawMs = [];
    const flushMs = [];
    for (let i = 0; i < warm + count; i++) {
      await nextFrame();
      const ms = r.advance();
      let f = 0;
      if (flush) {
        // Forces the recorded canvas commands to rasterize so raster cost moved off the main thread is not hidden.
        const t0 = performance.now();
        ctx.getImageData(0, 0, 1, 1);
        f = performance.now() - t0;
      }
      if (i >= warm) { drawMs.push(ms); flushMs.push(ms + f); }
    }
    return { drawMs: stats(drawMs), withRaster: flush ? stats(flushMs) : null, pulses: r.brain.pulses.length, canvas: [r.canvas.width, r.canvas.height] };
  };

  const useRenderer = (r, renderer) => {
    const status = renderer === 'webgl' ? r.brain.setRendererPreference(true, { allowSoftware: true }) : r.brain.rendererStatus();
    if (status.active !== renderer) throw new Error(`wanted ${renderer}, got ${status.active}: ${status.detail}`);
    return renderer === 'webgl' ? r.brain.renderer.gl : null;
  };

  window.rendererRun = async (renderer, budgetName, count, warm, flush) => {
    const r = make(CurrentBrain, budgetName);
    const gl = useRenderer(r, renderer);
    const ctx = r.canvas.getContext('2d');
    const px = new Uint8Array(4);
    const drawMs = [];
    const flushMs = [];
    for (let i = 0; i < warm + count; i++) {
      await nextFrame();
      const ms = r.advance();
      let f = 0;
      if (flush) {
        // Waits for the GPU (or SwiftShader) to finish this frame: readPixels for WebGL, getImageData for the 2D canvas
        // (in WebGL mode that canvas is the label overlay).
        const t0 = performance.now();
        if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ctx.getImageData(0, 0, 1, 1);
        f = performance.now() - t0;
      }
      if (i >= warm) { drawMs.push(ms); flushMs.push(ms + f); }
    }
    const result = { drawMs: stats(drawMs), withRaster: flush ? stats(flushMs) : null, pulses: r.brain.pulses.length, canvas: [r.canvas.width, r.canvas.height], active: r.brain.rendererStatus().active };
    r.brain.setRendererPreference(false);
    return result;
  };

  // Composites what the viewer sees (WebGL canvas under the label overlay) over black and summarises it coarsely.
  window.visualRun = (renderer, budgetName, count, wantImage) => {
    const r = make(CurrentBrain, budgetName);
    useRenderer(r, renderer);
    const ctx = r.canvas.getContext('2d');
    const labels = [];
    const realFillText = ctx.fillText.bind(ctx);
    ctx.fillText = (text, x, y) => { labels.push(text); realFillText(text, x, y); };
    for (let i = 0; i < count; i++) r.advance();
    const w = r.canvas.width;
    const h = r.canvas.height;
    const comp = document.createElement('canvas');
    comp.width = w;
    comp.height = h;
    const c = comp.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    if (renderer === 'webgl') c.drawImage(r.brain.renderer.canvas, 0, 0);
    c.drawImage(r.canvas, 0, 0);
    const data = c.getImageData(0, 0, w, h).data;
    const lum = (i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const gx = 16, gy = 9;
    const grid = new Float64Array(gx * gy);
    let lit = 0;
    let total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = lum((y * w + x) * 4);
        total += l;
        if (l > 8 / 255) lit++;
        grid[Math.min(gy - 1, Math.floor((y / h) * gy)) * gx + Math.min(gx - 1, Math.floor((x / w) * gx))] += l;
      }
    }
    const cell = (w / gx) * (h / gy);
    const frame = r.brain.frame;
    const scale = w / frame.width;
    const regions = {};
    for (const d of Object.keys(frame.regionCenter)) {
      const center = frame.regionCenter[d];
      if (!center?.valid || frame.activation[d] < 0.25) continue;
      const rad = frame.R * 0.3 * scale;
      let sum = 0, n = 0;
      for (let y = Math.max(0, Math.floor(center.y * scale - rad)); y < Math.min(h, center.y * scale + rad); y++) {
        for (let x = Math.max(0, Math.floor(center.x * scale - rad)); x < Math.min(w, center.x * scale + rad); x++) {
          if ((x - center.x * scale) ** 2 + (y - center.y * scale) ** 2 > rad * rad) continue;
          sum += lum((y * w + x) * 4); n++;
        }
      }
      regions[d] = sum / n;
    }
    const counts = renderer === 'webgl' ? { ...r.brain.renderer.lastCounts } : null;
    const image = wantImage ? comp.toDataURL('image/png') : null;
    r.brain.setRendererPreference(false);
    return { grid: Array.from(grid, (v) => v / cell), meanLum: total / (w * h), litShare: lit / (w * h), regions, labels: [...new Set(labels)], pulses: r.brain.pulses.length, counts, image };
  };

  window.pixelRun = (which, budgetName, count, captureAt) => {
    const lib = which === 'baseline' ? BaselineBrain : CurrentBrain;
    const r = make(lib, budgetName);
    const ctx = r.canvas.getContext('2d');
    const shots = {};
    const labels = [];
    const realFillText = ctx.fillText.bind(ctx);
    ctx.fillText = (text, x, y) => { labels.push(text); realFillText(text, x, y); };
    for (let i = 1; i <= count; i++) {
      r.advance();
      if (captureAt.includes(i)) shots[i] = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
    }
    window.__shots = window.__shots || {};
    window.__shots[which] = shots;
    return { labels: [...new Set(labels)], pulses: r.brain.pulses.length };
  };

  // getImageData returns un-premultiplied colour, which magnifies a 1/255 change at alpha 17 into 15/255.
  // What a viewer sees is the canvas composited over the page, so the visible difference is measured over
  // black and over white backgrounds; the raw un-premultiplied difference is reported alongside.
  window.pixelCompare = (captureAt) => {
    const out = [];
    const shown = (px, i, c, bg) => Math.round((px[i + c] * px[i + 3]) / 255 + ((255 - px[i + 3]) * bg) / 255);
    for (const at of captureAt) {
      const a = window.__shots.baseline[at];
      const b = window.__shots.current[at];
      let rawMax = 0;
      let rawDiffering = 0;
      let visibleMax = 0;
      let visibleDiffering = 0;
      let lit = 0;
      for (let i = 0; i < a.length; i += 4) {
        let raw = 0;
        let visible = 0;
        for (let c = 0; c < 4; c++) raw = Math.max(raw, Math.abs(a[i + c] - b[i + c]));
        if (raw > 0) {
          for (const bg of [0, 255]) for (let c = 0; c < 3; c++) visible = Math.max(visible, Math.abs(shown(a, i, c, bg) - shown(b, i, c, bg)));
        }
        if (raw > 0) rawDiffering++;
        if (raw > rawMax) rawMax = raw;
        if (visible > 0) visibleDiffering++;
        if (visible > visibleMax) visibleMax = visible;
        if (b[i + 3] > 0) lit++;
      }
      out.push({ frame: at, visibleMax, visibleDiffering, rawMax, rawDiffering, pixels: a.length / 4, litPixels: lit });
    }
    window.__shots = {};
    return out;
  };
}

const page = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style><body>
<script>${performanceJs}</script><script>${baselineJs}</script><script>${currentJs}</script><script>(${harness})()</script></body>`;

// Cross-origin isolation gives performance.now() 5 µs resolution instead of 100 µs.
const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
  res.end(page);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch();
const report = {
  environment: {
    note: 'Headless Chromium, x86 container, 1920x1080 at device scale factor 1. Relative comparison only; not Raspberry Pi numbers.',
    chromium: browser.version(),
    node: process.version,
    baselineRef,
    candidate,
    frames, runs, warmup,
  },
  bench: [],
  pixels: [],
};
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  report.environment.crossOriginIsolated = await tab.evaluate(() => crossOriginIsolated);
  report.environment.gpu = await tab.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no webgl';
  });
  const budgets = ['full', 'balanced', 'light'];

  if (flag('webgl')) {
    report.environment.note = 'Headless Chromium, x86 container, 1920x1080 at device scale factor 1. WebGL here is SwiftShader (software GL on the CPU), forced on with allowSoftware; the real app refuses software WebGL. Relative comparison only; not Raspberry Pi numbers.';
    report.visual = [];
    if (!flag('skip-pixels')) {
      const shots = arg('shots');
      for (const budget of budgets) {
        const canvasShot = await tab.evaluate(([b, n, img]) => window.visualRun('canvas', b, n, img), [budget, 120, !!shots]);
        const webglShot = await tab.evaluate(([b, n, img]) => window.visualRun('webgl', b, n, img), [budget, 120, !!shots]);
        if (shots) {
          for (const [name, shot] of [['canvas', canvasShot], ['webgl', webglShot]]) {
            await writeFile(join(resolve(shots), `brain-${budget}-${name}.png`), Buffer.from(shot.image.split(',')[1], 'base64'));
          }
        }
        const a = canvasShot.grid;
        const b = webglShot.grid;
        const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
        const ma = mean(a), mb = mean(b);
        let cov = 0, va = 0, vb = 0, absDiff = 0;
        for (let i = 0; i < a.length; i++) {
          cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; absDiff += Math.abs(a[i] - b[i]);
        }
        delete canvasShot.image;
        delete webglShot.image;
        report.visual.push({
          budget,
          gridCorrelation: cov / Math.sqrt(va * vb),
          gridMeanAbsDiff: absDiff / a.length,
          canvas: canvasShot,
          webgl: webglShot,
        });
      }
    }
    if (!flag('skip-bench')) {
      for (let run = 1; run <= runs; run++) {
        for (const budget of budgets) {
          const order = run % 2 ? ['canvas', 'webgl'] : ['webgl', 'canvas'];
          for (const renderer of order) {
            for (const flush of [false, true]) {
              const result = await tab.evaluate(([r, b, n, warm, f]) => window.rendererRun(r, b, n, warm, f), [renderer, budget, frames, warmup, flush]);
              report.bench.push({ run, budget, which: renderer, mode: flush ? 'step+draw+gpu' : 'step+draw', ...result });
            }
          }
        }
      }
    }
  } else if (!flag('skip-pixels')) {
    const captureAt = [...new Set([1, 30, 120, frames])].filter((at) => at <= frames);
    for (const budget of budgets) {
      const base = await tab.evaluate(([b, n, at]) => window.pixelRun('baseline', b, n, at), [budget, frames, captureAt]);
      const cur = await tab.evaluate(([b, n, at]) => window.pixelRun('current', b, n, at), [budget, frames, captureAt]);
      const diffs = await tab.evaluate((at) => window.pixelCompare(at), captureAt);
      report.pixels.push({ budget, baselineLabels: base.labels, currentLabels: cur.labels, pulses: [base.pulses, cur.pulses], diffs });
    }
  }

  if (!flag('skip-bench') && !flag('webgl')) {
    for (let run = 1; run <= runs; run++) {
      for (const budget of budgets) {
        // Alternate the order each run so warm-up and drift favour neither side.
        const order = run % 2 ? ['baseline', 'current'] : ['current', 'baseline'];
        for (const which of order) {
          for (const flush of flag('no-raster') ? [false] : [false, true]) {
            const result = await tab.evaluate(([w, b, n, warm, f]) => window.benchRun(w, b, n, warm, f), [which, budget, frames, warmup, flush]);
            report.bench.push({ run, budget, which, mode: flush ? 'step+draw+raster' : 'step+draw', ...result });
          }
        }
      }
    }
  }
  report.pageErrors = errors;
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}

const fmt = (v) => v.toFixed(3);
const summarize = (rows) => {
  const med = rows.map((s) => s.median).sort((a, b) => a - b);
  const p95 = rows.map((s) => s.p95).sort((a, b) => a - b);
  return { median: med[Math.floor(med.length / 2)], medRange: [med[0], med.at(-1)], p95: p95[Math.floor(p95.length / 2)], p95Range: [p95[0], p95.at(-1)] };
};
let failed = false;
if (flag('webgl')) {
  if (report.bench.length) {
    console.log(`\nCanvas vs WebGL per frame, ms (${frames} frames after ${warmup} warm-up, ${runs} runs; ${report.environment.note})`);
    for (const mode of ['step+draw', 'step+draw+gpu']) {
      for (const budget of ['full', 'balanced', 'light']) {
        const rows = (which) => report.bench.filter((r) => r.mode === mode && r.budget === budget && r.which === which).map((r) => (mode === 'step+draw' ? r.drawMs : r.withRaster));
        const c = summarize(rows('canvas'));
        const g = summarize(rows('webgl'));
        console.log(`${mode.padEnd(14)} ${budget.padEnd(8)} canvas median ${fmt(c.median)} [${c.medRange.map(fmt).join('–')}] p95 ${fmt(c.p95)} [${c.p95Range.map(fmt).join('–')}]`
          + ` | webgl median ${fmt(g.median)} [${g.medRange.map(fmt).join('–')}] p95 ${fmt(g.p95)} [${g.p95Range.map(fmt).join('–')}]`
          + ` | median change ${(((g.median - c.median) / c.median) * 100).toFixed(1)}%`);
      }
    }
    for (const r of report.bench) if (r.active !== r.which) { failed = true; console.log(`renderer mismatch: wanted ${r.which}, ran ${r.active}`); }
  }
  for (const v of report.visual ?? []) {
    const regions = Object.keys(v.canvas.regions).map((d) => `${d} ${v.canvas.regions[d].toFixed(3)}/${(v.webgl.regions[d] ?? NaN).toFixed(3)}`).join(', ');
    const sameLabels = JSON.stringify(v.canvas.labels) === JSON.stringify(v.webgl.labels) && v.webgl.labels.length > 0;
    const pulsesDrawn = v.webgl.counts?.pulses > 0 && v.webgl.counts.pulses === v.webgl.pulses && v.canvas.pulses === v.webgl.pulses;
    if (!sameLabels || !pulsesDrawn || !(v.gridCorrelation > 0.9)) failed = true;
    console.log(`visual ${v.budget.padEnd(8)} frame 120: 16x9 grid luminance correlation ${v.gridCorrelation.toFixed(3)}, mean abs diff ${v.gridMeanAbsDiff.toFixed(4)};`
      + ` mean luminance canvas ${v.canvas.meanLum.toFixed(4)} / webgl ${v.webgl.meanLum.toFixed(4)}; lit share ${(v.canvas.litShare * 100).toFixed(1)}% / ${(v.webgl.litShare * 100).toFixed(1)}%;`
      + ` active-region luminance (canvas/webgl) ${regions}`);
    console.log(`labels ${v.budget}: canvas ${JSON.stringify(v.canvas.labels)} webgl ${JSON.stringify(v.webgl.labels)} ${sameLabels ? 'same' : 'DIFFERENT'};`
      + ` pulses canvas ${v.canvas.pulses}, webgl ${v.webgl.pulses} (drawn ${v.webgl.counts?.pulses}); webgl counts ${JSON.stringify(v.webgl.counts)}`);
  }
}
if (report.bench.length && !flag('webgl')) {
  console.log(`\nstep+draw per frame, ms (${frames} frames after ${warmup} warm-up, ${runs} runs; ${report.environment.note})`);
  for (const mode of flag('no-raster') ? ['step+draw'] : ['step+draw', 'step+draw+raster']) {
    for (const budget of ['full', 'balanced', 'light']) {
      const row = (which) => report.bench.filter((r) => r.mode === mode && r.budget === budget && r.which === which)
        .map((r) => (mode === 'step+draw' ? r.drawMs : r.withRaster));
      const b = summarize(row('baseline'));
      const c = summarize(row('current'));
      console.log(`${mode.padEnd(17)} ${budget.padEnd(8)} baseline median ${fmt(b.median)} [${b.medRange.map(fmt).join('–')}] p95 ${fmt(b.p95)} [${b.p95Range.map(fmt).join('–')}]`
        + ` | current median ${fmt(c.median)} [${c.medRange.map(fmt).join('–')}] p95 ${fmt(c.p95)} [${c.p95Range.map(fmt).join('–')}]`
        + ` | median change ${(((c.median - b.median) / b.median) * 100).toFixed(1)}%`);
    }
  }
}
for (const p of report.pixels) {
  for (const d of p.diffs) {
    const share = d.visibleDiffering / d.pixels;
    const ok = d.visibleMax <= MAX_CHANNEL_DIFF && share <= MAX_DIFF_SHARE && d.litPixels > 0;
    if (!ok) failed = true;
    console.log(`pixels ${p.budget.padEnd(8)} frame ${String(d.frame).padStart(3)}: visible max diff ${d.visibleMax}/255 on ${d.visibleDiffering} of ${d.pixels} px (${(share * 100).toFixed(3)}%);`
      + ` raw un-premultiplied max ${d.rawMax}/255 on ${d.rawDiffering} px; lit ${d.litPixels} ${ok ? 'ok' : 'FAIL'}`);
  }
  const sameLabels = JSON.stringify(p.baselineLabels) === JSON.stringify(p.currentLabels) && p.currentLabels.length > 0;
  if (!sameLabels || p.pulses[0] !== p.pulses[1] || p.pulses[1] === 0) failed = true;
  console.log(`labels ${p.budget}: ${JSON.stringify(p.currentLabels)} ${sameLabels ? 'same as baseline' : 'DIFFERENT'}; pulses baseline ${p.pulses[0]}, current ${p.pulses[1]}`);
}
if (report.pageErrors?.length) { failed = true; console.log('page errors:', report.pageErrors); }
console.log(`environment: ${JSON.stringify(report.environment)}`);
const jsonPath = arg('json');
if (jsonPath) await writeFile(resolve(jsonPath), JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
