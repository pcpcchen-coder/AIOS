#!/usr/bin/env node
// External browser/API fixtures only. This does not validate OAuth, AI, microphones, or speakers.
// Build prototype/ambient-shell first; run this from any directory with --output <evidence-directory>.
// PLAYWRIGHT_MODULE accepts a separately installed package/module path; CHROMIUM_PATH overrides Chromium.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'prototype/ambient-shell');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? `/tmp/aios-region-browser-${Date.now()}` : process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
let playwright;
try { playwright = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName); }
catch (error) { throw new Error('Install Playwright separately or set PLAYWRIGHT_MODULE to its module path.', { cause: error }); }

async function hashes(directory) {
  const result = {};
  async function visit(path, relative = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
    }
  }
  await visit(directory);
  return { files: result, sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}

const digestFile = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const inputHashes = { dist: await hashes(join(app, 'dist')), src: await hashes(join(app, 'src')), shared: await hashes(join(app, 'shared')),
  entry: await digestFile(join(app, 'index.html')), harness: await digestFile(fileURLToPath(import.meta.url)) };
const report = {
  fixture: 'SIMULATED account/API SSE + browser speech APIs; real built application in Chromium',
  limitations: ['No real OAuth/account, AI provider, microphone, TTS hardware, camera, or model neural activity verified.'],
  started: new Date().toISOString(), inputHashes, servedAssets: {}, cases: [], requests: [], browserErrors: [],
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const clone = (value) => structuredClone(value);
function settings(signedIn = true) {
  return {
    schema_version: 'proto-0.1', provider: signedIn ? 'chatgpt' : 'mock',
    providers: [
      { id: 'chatgpt', label: 'ChatGPT', available: signedIn, detail: 'FIXTURE simulated ChatGPT account' },
      { id: 'mock', label: '模擬模式', available: true, detail: 'FIXTURE no AI request' },
      { id: 'claude', label: 'Claude', available: false, detail: 'FIXTURE unavailable' },
    ],
    chatgpt: { signed_in: signedIn, email: signedIn ? 'fixture@example.invalid' : null, plan_usage: signedIn,
      needs_reauth: false, welcome_ack: true, pending_login: false, last_error: null },
  };
}
function task(domain, overrides = {}) {
  const timestamp = new Date().toISOString();
  return { schema_version: 'proto-0.1', task_id: 'task_fixture', request_id: 'req_fixture', title: 'FIXTURE 背景任務',
    status: 'running', mode: 'mock', model: null, plan_ready: true,
    steps: [{ title: 'FIXTURE step', status: 'running', domain, started_at: timestamp, finished_at: null, output_chars: 12 }],
    created_at: timestamp, updated_at: timestamp, finished_at: null, error: null, artifact_id: null, retry_of: null, ...overrides };
}
let current;
const clients = new Set();
function emit(event) {
  const value = { sequence: ++current.sequence, ...event };
  if (event.type === 'settings.updated') current.settings = event.settings;
  if (event.type === 'task.updated') current.tasks = [event.task];
  for (const response of clients) response.write(frame(value));
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    if (!path.startsWith('/api/')) {
      const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const file = resolve(app, 'dist', relative);
      if (!file.startsWith(join(app, 'dist') + '/')) { response.writeHead(403).end(); return; }
      const data = await readFile(file);
      report.servedAssets[relative] = createHash('sha256').update(data).digest('hex');
      assert.equal(report.servedAssets[relative], inputHashes.dist.files[relative], 'served asset must match the recorded dist');
      response.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
      response.end(data); return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    report.requests.push({ case: current.name, method: request.method, path, body: payload });
    if (path === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(frame({ type: 'hello', sequence: ++current.sequence, settings: current.settings, tasks: current.tasks }));
      clients.add(response); response.on('close', () => clients.delete(response)); return;
    }
    if (path === '/api/chat') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      current.chats.push({ response, payload });
      return;
    }
    let result;
    if (path === '/api/settings/provider') {
      current.settings.provider = payload.provider; result = current.settings;
      emit({ type: 'settings.updated', settings: clone(result) });
    } else if (path === '/api/auth/chatgpt/logout') {
      current.settings = settings(false); result = { revoked: true, settings: current.settings };
      emit({ type: 'settings.updated', settings: clone(current.settings) });
    } else if (path === '/api/auth/chatgpt/login') {
      current.settings.chatgpt.pending_login = true;
      result = { authorize_url: 'about:blank#FIXTURE-no-real-OAuth' };
    } else if (path === '/api/tasks') {
      result = task('planning', { request_id: payload.request_id, title: payload.text, plan_ready: false, steps: [] });
      emit({ type: 'task.updated', task: result });
    } else { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'FIXTURE unsupported endpoint' })); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
} catch (error) {
  await new Promise((resolve) => server.close(resolve));
  throw error;
}
report.runtime = { node: process.version, chromium: browser.version() };

function installSpeechFixtures() {
  const fixture = { recognitions: [], utterances: [], starts: 0, cancels: 0 };
  class Recognition {
    constructor() { fixture.recognitions.push(this); }
    start() { fixture.starts++; this.onstart?.(); }
    stop() { this.onaudioend?.(); this.onend?.(); }
    abort() { this.onaudioend?.(); this.onend?.(); }
  }
  class Utterance { constructor(text) { this.text = text; } }
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: Recognition });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [], speak: (utterance) => fixture.utterances.push(utterance),
    cancel: () => { fixture.cancels++; for (const utterance of fixture.utterances) utterance.onend?.(); },
  } });
  window.__speechFixture = fixture;
  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.textContent = 'FIXTURE 模擬 · API/account/recognition/TTS · No real audio, camera or AI';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:12px;background:#ffec70;color:#111;font:700 15px sans-serif;text-align:center;z-index:999999;pointer-events:none';
    document.body.append(banner);
  });
}

let context, page;
async function fresh(name, signedIn = true, tasks = []) {
  await context?.close();
  current = { name, settings: settings(signedIn), tasks, sequence: 0, chats: [] };
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(installSpeechFixtures);
  page = await context.newPage();
  page.on('pageerror', (error) => report.browserErrors.push({ case: name, error: String(error) }));
  await page.goto(base);
  await page.waitForFunction(() => {
    const status = document.querySelector('#status-line');
    return status.hidden || !status.textContent.includes('連線中斷');
  });
  await page.waitForFunction(() => document.body.dataset.activeRegions !== undefined);
}
async function expectRegions(expected) {
  await page.waitForFunction((ids) => {
    const actual = (document.body.dataset.activeRegions || '').split(/\s+/).filter(Boolean).sort();
    return JSON.stringify(actual) === JSON.stringify([...ids].sort());
  }, expected, { timeout: 3500 });
  assert.equal(await page.locator('#brain').getAttribute('data-active-regions'), await page.locator('body').getAttribute('data-active-regions'));
}
async function type(text) {
  if (!await page.locator('#command-input').isVisible()) await page.keyboard.press('Enter');
  await page.locator('#command-input').fill(text);
  await page.locator('#command-input').press('Enter');
}
async function chat(text) {
  const count = current.chats.length;
  await type(text);
  await poll(() => current.chats.length > count, 'chat request');
  return current.chats.at(-1);
}
async function poll(check, label) {
  const until = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < until, `Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
function respond(chat, events, close = true) {
  for (const event of events) chat.response.write(frame(event));
  if (close) chat.response.end();
}
async function speech(event, payload = null, index = -1) {
  await page.evaluate(({ event, payload, index }) => {
    const fixture = window.__speechFixture;
    const recognition = index < 0 ? fixture.recognitions.at(index) : fixture.recognitions[index];
    if (event === 'ttsstart' || event === 'ttsend' || event === 'ttserror') {
      const utterance = fixture.utterances.at(-1);
      if (!utterance) throw new Error('No queued fixture utterance');
      utterance[{ ttsstart: 'onstart', ttsend: 'onend', ttserror: 'onerror' }[event]]?.();
    } else if (event === 'result') recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: payload } }] });
    else recognition[`on${event}`]?.(payload);
  }, { event, payload, index });
}
async function screenshot(name) {
  const path = join(output, `${name}.png`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path, fullPage: true });
  return path;
}
async function observe() {
  return page.evaluate(() => ({ active: document.body.dataset.activeRegions,
    activity: document.querySelector('#region-activity')?.textContent,
    visibility: document.querySelector('#region-activity')?.dataset.visibilityReason,
    requestId: document.querySelector('#region-activity')?.dataset.requestId,
    conversation: document.body.dataset.conversationState,
    reply: document.querySelector('#conversation-reply')?.dataset.status,
    recognitionStarts: window.__speechFixture.starts,
  }));
}
async function run(name, test) {
  const result = { name, status: 'running' };
  report.cases.push(result);
  try { await test(result); result.status = 'passed'; }
  catch (error) { result.status = 'failed'; result.error = error.stack; if (page && !page.isClosed()) result.screenshot = await screenshot(`FAIL-${name}`); }
  if (page && !page.isClosed()) result.observation = await observe();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${result.status}: ${name}`);
}

try {
  await run('signed-out-consent-gates', async (result) => {
    await fresh('signed-out-consent-gates', false);
    await page.locator('#start-conversation').click();
    await page.getByRole('button', { name: 'Continue with ChatGPT' }).waitFor();
    assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0);
    assert.equal(current.chats.length, 0);
    await expectRegions([]);
    result.screenshot = await screenshot('signed-out-fixture');
    await fresh('signed-in-before-consent');
    await page.locator('#start-conversation').click();
    await page.locator('#voice-consent').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0);
    await expectRegions([]);
    await page.locator('#consent-no').click();
    assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0);
  });

  await run('six-task-domains-and-terminal-cleanup', async (result) => {
    await fresh('six-task-domains-and-terminal-cleanup');
    const counts = JSON.parse(await page.locator('#brain').getAttribute('data-region-counts'));
    assert.equal(await page.locator('#region-activity').getAttribute('role'), 'status');
    assert.deepEqual(Object.keys(counts).sort(), ['language', 'math', 'art', 'auditory', 'visual', 'planning'].sort());
    for (const [domain, count] of Object.entries(counts)) assert.ok(Number.isInteger(count) && count > 0, `${domain} must own a nonempty rendered partition`);
    result.renderedPartitionCounts = counts;
    result.domains = [];
    for (const domain of ['language', 'math', 'art', 'auditory', 'visual', 'planning']) {
      emit({ type: 'task.updated', task: task(domain) });
      await expectRegions([domain]);
      const observation = await observe();
      assert.match(observation.activity, /模擬/);
      result.domains.push({ domain, ...observation, screenshot: await screenshot(`partition-${domain}-fixture`) });
    }
    emit({ type: 'task.updated', task: task('math', { status: 'succeeded', finished_at: new Date().toISOString() }) });
    await expectRegions([]);
    emit({ type: 'task.updated', task: task(null, { plan_ready: false, steps: [] }) });
    await expectRegions(['planning']);
    emit({ type: 'task.updated', task: task(undefined) });
    await expectRegions([]);
  });

  await run('six-topic-classifications', async (result) => {
    await fresh('six-topic-classifications');
    result.topics = [];
    const topics = { language: '翻譯英文郵件', math: '計算成本', art: '設計海報配色', auditory: '音樂旋律', visual: '這3張照片', planning: '規劃排程' };
    for (const [domain, text] of Object.entries(topics)) {
      const pending = await chat(text);
      await expectRegions([domain]);
      const observation = await observe();
      assert.match(observation.activity, /主題分類/);
      assert.equal(observation.visibility, 'user_request');
      assert.equal(observation.requestId, pending.payload.request_id);
      result.topics.push({ domain, text, ...observation });
      respond(pending, [{ type: 'delta', text: 'FIXTURE neutral response。' }, { type: 'done', model: 'FIXTURE' }]);
      await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'complete');
      await expectRegions([]);
    }
  });

  await run('topic-provenance-and-late-completion', async (result) => {
    await fresh('topic-provenance-and-late-completion');
    const a = await chat('計算數學公式');
    await expectRegions(['math']);
    const b = await chat('照片影像視覺');
    await expectRegions(['visual']);
    const observation = await observe();
    assert.match(observation.activity, /主題分類/);
    assert.doesNotMatch(observation.activity, /攝影機正在|正在看見|鏡頭分析/);
    respond(a, [{ type: 'delta', text: 'OLD A。' }, { type: 'done', model: 'FIXTURE' }]);
    await expectRegions(['visual']);
    assert.doesNotMatch(await page.locator('#conversation-answer').innerText(), /OLD A/);
    result.screenshot = await screenshot('visual-topic-fixture');
    respond(b, [{ type: 'delta', text: 'FIXTURE 影像討論。' }, { type: 'done', model: 'FIXTURE' }]);
    await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'complete');
    await expectRegions([]);
  });

  await run('actual-capture-tts-and-restart-boundaries', async (result) => {
    await fresh('actual-capture-tts-and-restart-boundaries');
    await page.locator('#start-conversation').click();
    await page.locator('#consent-yes').click();
    await expectRegions([]);
    await speech('ttsstart');
    await expectRegions(['language']);
    await speech('ttsend');
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions(['auditory']);
    assert.match((await observe()).activity, /收音|麥克風|音訊/);
    assert.equal((await observe()).visibility, 'sensor_status');
    result.screenshot = await screenshot('capture-fixture');
    await speech('audioend');
    await expectRegions([]);
    await speech('audiostart');
    await speech('end');
    await expectRegions([]);
    await page.waitForFunction(() => window.__speechFixture.recognitions.length >= 2);
    await expectRegions([]);
    await speech('audiostart', null, 0);
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions(['auditory']);
    await speech('error', { error: 'network' });
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions([]);
    await speech('end');
    await page.waitForFunction(() => window.__speechFixture.recognitions.length >= 3);
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions(['auditory']);
    await page.locator('#voice-pill').click();
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions([]);
  });

  await run('push-to-talk-actual-audio-and-errors', async () => {
    await fresh('push-to-talk-actual-audio-and-errors');
    await page.keyboard.press('Enter');
    await page.locator('#mic').click();
    assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0);
    await page.locator('#consent-yes').click();
    await expectRegions([]);
    await speech('audiostart');
    await expectRegions(['auditory']);
    await speech('audioend');
    await expectRegions([]);
    await speech('audiostart');
    await speech('error', { error: 'not-allowed' });
    await expectRegions([]);
    await page.locator('#command-error').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await speech('audiostart');
    await expectRegions([]);
    assert.equal(current.chats.length, 0);
  });

  await run('simultaneous-sources-and-close-preserves-task', async (result) => {
    await fresh('simultaneous-sources-and-close-preserves-task', true, [task('art')]);
    await expectRegions(['art']);
    await page.locator('#start-conversation').click();
    await page.locator('#consent-yes').click();
    await speech('audiostart');
    await expectRegions(['art', 'auditory']);
    const pending = await chat('計算數學公式');
    await expectRegions(['art', 'auditory', 'math']);
    result.screenshot = await screenshot('simultaneous-sources-fixture');
    await page.locator('#conversation-close').click();
    await expectRegions(['art']);
    respond(pending, [{ type: 'delta', text: 'OLD MATH。' }, { type: 'done', model: 'FIXTURE' }]);
    await expectRegions(['art']);
    assert.ok(!await page.locator('#conversation-reply').isVisible());
  });

  await run('provider-account-reset-preserves-background-task', async () => {
    await fresh('provider-account-reset-preserves-background-task', true, [task('art')]);
    let pending = await chat('計算數學公式');
    await expectRegions(['art', 'math']);
    emit({ type: 'settings.updated', settings: { ...settings(true), provider: 'mock' } });
    await expectRegions(['art']);
    respond(pending, [{ type: 'done', model: 'FIXTURE' }]);
    emit({ type: 'settings.updated', settings: settings(true) });
    pending = await chat('照片影像視覺');
    await expectRegions(['art', 'visual']);
    const changedAccount = settings(true);
    changedAccount.chatgpt.email = 'second-fixture@example.invalid';
    emit({ type: 'settings.updated', settings: changedAccount });
    await expectRegions(['art']);
    respond(pending, [{ type: 'delta', text: 'OLD ACCOUNT。' }, { type: 'done', model: 'FIXTURE' }]);
    const latest = await chat('翻譯文章');
    assert.equal(latest.payload.messages.length, 1, 'account changes reset conversation history');
    await expectRegions(['art', 'language']);
    await page.keyboard.press('Escape');
    await expectRegions(['art']);
    respond(latest, [{ type: 'done', model: 'FIXTURE' }]);
  });

  await run('shared-voice-typed-history-and-stream-errors', async (result) => {
    await fresh('shared-voice-typed-history-and-stream-errors');
    const first = await chat('翻譯文章');
    respond(first, [{ type: 'delta', text: 'FIXTURE first answer。' }, { type: 'done', model: 'FIXTURE' }]);
    await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'complete');
    await expectRegions([]);
    await page.keyboard.press('Enter');
    await page.locator('#voice-mode').click();
    await page.locator('#consent-yes').click();
    await speech('ttsstart');
    await speech('ttsend');
    await speech('result', '計算數學公式');
    await poll(() => current.chats.length === 2, 'voice chat');
    const second = current.chats[1];
    assert.deepEqual(second.payload.messages.slice(0, 2), [
      { role: 'user', content: '翻譯文章' }, { role: 'assistant', content: 'FIXTURE first answer。' },
    ]);
    await expectRegions(['math']);
    respond(second, [{ type: 'delta', text: 'FIXTURE second answer。' }, { type: 'done', model: 'FIXTURE' }]);
    await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'complete');
    await expectRegions([]);
    await speech('ttsstart');
    await expectRegions(['language']);
    await speech('ttserror');
    await expectRegions([]);
    const third = await chat('照片影像視覺');
    assert.equal(third.payload.messages.length, 5);
    assert.equal(third.payload.messages[3].content, 'FIXTURE second answer。');
    respond(third, [{ type: 'error', message: 'FIXTURE provider unavailable', action: null }]);
    await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'error');
    await expectRegions([]);
    assert.match(await page.locator('#conversation-answer').innerText(), /FIXTURE provider unavailable/);
    const fourth = await chat('計算數學公式');
    fourth.response.end();
    await page.waitForFunction(() => document.querySelector('#conversation-reply').dataset.status === 'error');
    await expectRegions([]);
    assert.match(await page.locator('#conversation-answer').innerText(), /中斷|完成確認/);
    result.screenshot = await screenshot('stream-error-fixture');
  });
} finally {
  report.finished = new Date().toISOString();
  report.sourceUnchangedDuringRun = JSON.stringify(inputHashes.src) === JSON.stringify(await hashes(join(app, 'src')))
    && JSON.stringify(inputHashes.shared) === JSON.stringify(await hashes(join(app, 'shared')));
  report.distUnchangedDuringRun = JSON.stringify(inputHashes.dist) === JSON.stringify(await hashes(join(app, 'dist')));
  await context?.close();
  await browser.close();
  for (const response of clients) response.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`Evidence: ${join(output, 'report.json')}`);
if (report.cases.some((entry) => entry.status !== 'passed') || report.browserErrors.length || !report.sourceUnchangedDuringRun || !report.distUnchangedDuringRun) process.exitCode = 1;
