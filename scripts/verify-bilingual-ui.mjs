#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'prototype/ambient-shell');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? join(tmpdir(), `aios-bilingual-ui-${Date.now()}`) : process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'aios-bilingual-runtime-'));
const { tsImport } = await import(pathToFileURL(join(app, 'node_modules/tsx/dist/esm/api/index.mjs')));
const { startNous } = await tsImport(join(app, 'server/nous.ts'), import.meta.url);
const playwrightName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightName.startsWith('/') ? pathToFileURL(playwrightName).href : playwrightName);
const report = { fixture: 'Real built UI and local core; isolated mock provider/data/config; no account, AI, audio or camera hardware', cases: [], browserErrors: [], requests: [], runtime: { node: process.version } };
const core = await startNous({
  envFile: join(scratch, 'empty.env'), dataDir: join(scratch, 'data'), distDir: join(app, 'dist'), fallbackPort: true,
  overrides: { PORT: '48971', NOUS_CONFIG_DIR: join(scratch, 'config'), NOUS_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SMARTHOME_URL: '', SMARTHOME_TOKEN: '', NOUS_CAMERA: 'off', NOUS_REALTIME_MCP: '' },
  log: () => {},
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  report.runtime.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  await context.addInitScript(() => {
    const recognitions = [];
    class Recognition { constructor() { recognitions.push(this); } start() { this.onstart?.(); } stop() { this.onend?.(); } abort() { this.onend?.(); } }
    Object.defineProperty(window, 'SpeechRecognition', { value: Recognition, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: Recognition, configurable: true });
    window.__recognitions = recognitions;
    window.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('p');
      label.textContent = 'FIXTURE · Isolated mock core · No real account, AI, microphone or camera';
      label.id = 'fixture-banner';
      label.style.cssText = 'position:fixed;bottom:0;left:0;right:0;margin:0;background:#ffe68a;color:#111;padding:8px;text-align:center;font:14px sans-serif;z-index:10000;pointer-events:none';
      document.body.append(label);
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(String(error)));
  page.on('request', request => { if (request.url().includes('/api/') && request.method() === 'POST') report.requests.push({ path: new URL(request.url()).pathname, locale: request.headers()['x-nous-locale'] }); });
  const input = page.locator('#command-input');
  async function type(text) {
    if (!await input.isVisible()) {
      await page.locator('#brain').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Enter');
      await input.waitFor({ state: 'visible' });
    }
    await input.fill(text);
    await input.press('Enter');
  }
  async function settings() { await type('settings'); await page.locator('#interface-language').waitFor({ state: 'visible' }); }
  async function language(locale) { await page.locator('#interface-language').selectOption(locale); await page.waitForFunction(value => document.documentElement.lang === value, locale === 'en' ? 'en' : 'zh-Hant-TW'); }
  async function screenshot(name) { const path = join(output, name); await page.waitForTimeout(300); await page.screenshot({ path, fullPage: true, animations: 'disabled' }); return path; }

  await page.goto(core.url);
  await page.waitForFunction(() => document.body.dataset.activeRegions !== undefined);
  await settings();
  assert.equal(await page.locator('#interface-language').inputValue(), 'zh-TW');
  await screenshot('web-zh-TW.png');
  await language('en');
  assert.match(await page.locator('#surface-root').innerText(), /AI engine|Settings/);
  assert.doesNotMatch(await input.getAttribute('placeholder'), /[\u3400-\u9fff]/u);
  const unexpected = await page.locator('#surface-root').evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const found = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      const text = node.textContent.trim();
      if (!parent || parent.closest('option') || !parent.getClientRects().length || ['語言 / Language', 'Language / 語言'].includes(text)) continue;
      if (/[\u3400-\u9fff]/u.test(text)) found.push(text);
    }
    return found;
  });
  assert.deepEqual(unexpected, [], `Untranslated English settings copy: ${JSON.stringify(unexpected)}`);
  report.cases.push({ name: 'web-settings-zh-en-and-accessibility', status: 'passed', screenshot: await screenshot('web-en.png') });
  await page.reload();
  await settings();
  assert.equal(await page.locator('#interface-language').inputValue(), 'en');
  report.cases.push({ name: 'web-language-persists-across-reload', status: 'passed' });

  const title = '使用者原文「設定」 <Keep exact> & $value';
  const taskResponse = await fetch(`${core.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nous-Locale': 'en' }, body: JSON.stringify({ text: title, request_id: 'req_bilingual_fixture_task' }) });
  assert.equal(taskResponse.status, 201);
  const task = await taskResponse.json();
  await language('zh-TW');
  await language('en');
  await type('show progress');
  await page.locator('.task-title').filter({ hasText: title }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.task-title').first().innerText(), title);
  assert.doesNotMatch((await page.locator('#surface-root').innerText()).replaceAll(title, '<user-content>'), /[\u3400-\u9fff]/u, 'English progress chrome must preserve user text without untranslated labels');
  const afterSwitch = (await (await fetch(`${core.url}/api/tasks`)).json()).find(item => item.task_id === task.task_id);
  assert.ok(afterSwitch && afterSwitch.status !== 'cancelled' && afterSwitch.locale === 'en');
  report.cases.push({ name: 'language-switch-preserves-task-and-user-content', status: 'passed', screenshot: await screenshot('web-en-progress.png') });

  await settings();
  await language('zh-TW');
  assert.match(await page.locator('#surface-root').innerText(), /鏡頭與手勢|AI 引擎/);
  await language('en');
  await page.keyboard.press('Escape');
  await type('settings');
  assert.equal(await page.locator('#interface-language').inputValue(), 'en');
  report.cases.push({ name: 'roundtrip-and-English-settings-command', status: 'passed' });

  const enHelp = await fetch(`${core.url}/help/commands?lang=en`);
  const html = await enHelp.text();
  assert.match(html, /<html lang="en"/);
  assert.doesNotMatch(html, /<script[\s>]/i);
  assert.match(enHelp.headers.get('Content-Security-Policy'), /default-src 'none'/);
  report.cases.push({ name: 'English-command-help-retains-readonly-security', status: 'passed' });
  assert.deepEqual(report.browserErrors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  throw error;
} finally {
  await browser?.close();
  await core.close();
  report.distIndexSha256 = createHash('sha256').update(await readFile(join(app, 'dist/index.html'))).digest('hex');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Bilingual UI evidence: ${join(output, 'report.json')}`);
}
