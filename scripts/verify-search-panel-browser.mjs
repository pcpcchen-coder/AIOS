#!/usr/bin/env node
// Screenshots of the realtime web search panel (candidates, reading with read-along, failed) and its settings stepper.
// SIMULATED: the search response is a page.route fixture and the realtime callbacks are invoked directly in the built page;
// no microphone, voice model, Codex or OpenAI call is made. Build first: (cd prototype/ambient-shell && npx vite build).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'prototype/ambient-shell');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? join(root, 'docs/screenshots/web-search-picker') : process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const dist = join(app, 'dist');
const html = await readFile(join(dist, 'index.html'), 'utf8').catch(() => '');
const asset = html.match(/src="\/(assets\/[\w-]+\.js)"/)?.[1];
assert(asset, 'build the app first: (cd prototype/ambient-shell && npx vite build)');
const source = await readFile(join(dist, asset), 'utf8');
const { parseAst } = await import(pathToFileURL(join(app, 'node_modules/rolldown/dist/parse-ast-index.mjs')).href);

let callbacksName;
let tickArrow;
(function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.init?.type === 'ObjectExpression'
    && node.init.properties.some(p => p.key?.name === 'onShowSearchResult')
    && node.init.properties.some(p => p.key?.name === 'onPhase')) callbacksName = node.id.name;
  if (node.type === 'CallExpression' && node.callee?.name === 'setInterval' && node.arguments[1]?.value === 200
    && node.arguments[0]?.type === 'ArrowFunctionExpression') tickArrow = node.arguments[0];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
})(parseAst(source));
assert(callbacksName && tickArrow, 'cannot locate the realtime callbacks and the 200 ms sensor tick in this build');
const before = source.slice(0, tickArrow.body.start).split('\n');

const scratch = await mkdtemp(join(tmpdir(), 'aios-search-panel-'));
const { tsImport } = await import(pathToFileURL(join(app, 'node_modules/tsx/dist/esm/api/index.mjs')));
const { startNous } = await tsImport(join(app, 'server/nous.ts'), import.meta.url);
const core = await startNous({
  envFile: join(scratch, 'empty.env'), dataDir: join(scratch, 'data'), distDir: dist, fallbackPort: true,
  overrides: { PORT: '48981', NOUS_CONFIG_DIR: join(scratch, 'config'), NOUS_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SMARTHOME_URL: '', SMARTHOME_TOKEN: '', NOUS_CAMERA: 'off', NOUS_WAKE: 'off', NOUS_REALTIME_MCP: '' },
  log: () => {},
});

const SIMULATED = {
  ok: true,
  answer: 'SIMULATED：台股今天收 23,456.78 點，漲 1.2%。',
  sources: [{ title: 'SIMULATED 財經 A', url: 'https://news.example.com/a' }],
  model: 'simulated',
  candidates: [
    { n: 1, title: 'SIMULATED 台股收盤', url: 'https://news.example.com/a', host: 'news.example.com', points: ['加權指數收 23,456.78 點', '成交量 4,321 億元', '外資買超 120 億元'], summarized: true },
    { n: 2, title: 'SIMULATED 半導體領漲', url: 'https://example.org/b', host: 'example.org', points: ['台積電上漲 1.2%', '聯發科持平'], summarized: true },
    { n: 3, title: 'SIMULATED 盤後分析', url: 'https://c.example.net/x', host: 'c.example.net', points: [], summarized: false },
  ],
};

const report = { fixture: 'SIMULATED search response (page.route) and directly invoked realtime callbacks in the real built page; isolated mock core; no microphone, voice model or web search', shots: [], errors: [] };
let browser;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const url = core.url;

  async function open(locale) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await context.addInitScript(({ locale }) => {
      try { localStorage.setItem('nous.locale', locale); } catch { /* 沒有 storage 時用預設語言 */ }
      window.addEventListener('DOMContentLoaded', () => {
        const label = document.createElement('p');
        label.id = 'simulated-badge';
        label.textContent = 'SIMULATED · fixture search results · no real search, voice or AI';
        label.style.cssText = 'position:fixed;top:12px;right:12px;margin:0;padding:8px 14px;border-radius:8px;background:#ffe68a;color:#111;font:600 20px sans-serif;z-index:10000;pointer-events:none';
        document.body.append(label);
      });
    }, { locale });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(String(error)));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#simulated-badge'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Debugger.enable');
    const condition = `(window.__searchTest?(()=>{const run=window.__searchTest;window.__searchTest=null;window.__searchDone=false;Promise.resolve(run(${callbacksName})).then(()=>{window.__searchDone=true},(e)=>{window.__searchError=String(e);window.__searchDone=true})})():0,false)`;
    await cdp.send('Debugger.setBreakpointByUrl', { url: `${url}/${asset}`, lineNumber: before.length - 1, columnNumber: before.at(-1).length, condition });
    async function call(fn, arg) {
      await page.evaluate(({ fn, arg }) => {
        const run = new Function('cb', 'arg', fn);
        window.__searchTest = (cb) => run(cb, arg);
      }, { fn, arg });
      await page.waitForFunction(() => window.__searchDone === true);
      assert.equal(await page.evaluate(() => window.__searchError ?? null), null);
      await page.waitForTimeout(400);
    }
    async function shot(name) {
      const path = join(output, name);
      await page.screenshot({ path, animations: 'disabled' });
      report.shots.push(name);
    }
    return { context, page, call, shot };
  }

  {
    const { context, page, call, shot } = await open('zh-TW');
    let failNext = false;
    await page.route('**/api/realtime/web-search', route => failNext
      ? route.fulfill({ status: 504, json: { error: '上網查詢逾時（30 秒）。（SIMULATED）' } })
      : route.fulfill({ json: SIMULATED }));
    await call('return cb.onWebSearch(arg)', 'SIMULATED · 今日台股');
    await page.locator('.surface--search-candidates').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.search-candidate[data-selectable]').count(), 3);
    await shot('search-candidates.zh-TW.png');

    await call('cb.onPhase("thinking"); const out = cb.onShowSearchResult(1); if (!out.ok) throw new Error(JSON.stringify(out)); cb.onPhase("speaking"); cb.onAssistantPartial("好，第一則。加權指數收兩萬三千四百五十六點。成交量");');
    await page.locator('.search-point.is-active').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.search-point').nth(1).getAttribute('aria-current'), 'true', 'point 2 is lit while speaking');
    await shot('search-reading-point2.zh-TW.png');

    await call('cb.onPhase("listening"); const out = cb.onShowSearchResult(3); if (!out.ok) throw new Error(JSON.stringify(out));');
    await page.locator('.search-unsummarized').waitFor({ state: 'visible' });
    await shot('search-reading-unsummarized.zh-TW.png');

    failNext = true;
    await call('return cb.onWebSearch(arg)', 'SIMULATED · 今日台股');
    await page.locator('.surface--search-failed').waitFor({ state: 'visible' });
    await shot('search-failed.zh-TW.png');

    await call('cb.onPhase("speaking"); cb.onPhase("listening");');
    const closeS = 8;
    await page.waitForTimeout(closeS * 1000 + 800);
    assert.equal(await page.locator('.surface--search').count(), 0, 'failed panel closes N seconds after speech ends');
    report.autoClose = `failed panel closed ${closeS} s after speaking → listening (real timer, default search_close_s)`;

    await page.evaluate(() => document.querySelector('#conversation-settings').click());
    const stepper = page.locator('.camera-settings', { hasText: '查詢結果收起秒數' });
    await stepper.waitFor({ state: 'visible' });
    await stepper.scrollIntoViewIfNeeded();
    await stepper.screenshot({ path: join(output, 'settings-search-close.zh-TW.png'), animations: 'disabled' });
    report.shots.push('settings-search-close.zh-TW.png');
    await context.close();
  }

  {
    const { context, page, call, shot } = await open('en');
    await page.route('**/api/realtime/web-search', route => route.fulfill({ json: {
      ...SIMULATED,
      answer: 'SIMULATED: the index closed at 23,456.78, up 1.2%.',
      candidates: [
        { ...SIMULATED.candidates[0], title: 'SIMULATED Market close', points: ['The index closed at 23,456.78', 'Turnover reached 432.1 billion', 'Foreign investors bought 12 billion'] },
        { ...SIMULATED.candidates[1], title: 'SIMULATED Chipmakers lead' },
      ],
    } }));
    await call('return cb.onWebSearch(arg)', 'SIMULATED · market today');
    await call('const out = cb.onShowSearchResult(1); if (!out.ok) throw new Error(JSON.stringify(out)); cb.onPhase("speaking"); cb.onAssistantPartial("Sure. The index closed at twenty-three thousand. Turnover reached");');
    await page.locator('.search-point.is-active').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.surface--search').getAttribute('aria-label'), 'Search results');
    await shot('search-reading-point2.en.png');
    await context.close();
  }
  report.passed = report.errors.length === 0;
} finally {
  await browser?.close();
  await core.close();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
