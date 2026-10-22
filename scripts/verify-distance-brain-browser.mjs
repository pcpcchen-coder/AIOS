#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'prototype/ambient-shell');
const flag = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const output = resolve(flag('output') || `/tmp/aios-distance-brain-browser-${Date.now()}`);
const selectedCase = flag('case');
await mkdir(output, {recursive: true});
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const {chromium} = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashes(directory) {
  const files = {};
  async function visit(path, relative = '') {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) files[name] = digest(await readFile(join(path, entry.name)));
    }
  }
  await visit(directory);
  return {files, sha256: digest(JSON.stringify(files))};
}
const sourceHashes = async () => ({src: await hashes(join(app, 'src')), shared: await hashes(join(app, 'shared')), entry: digest(await readFile(join(app, 'index.html')))});
const inputHashes = {...await sourceHashes(), dist: await hashes(join(app, 'dist')), harness: digest(await readFile(fileURLToPath(import.meta.url)))};
const report = {fixture: 'SIMULATED API/account and external SensePipeline events; actual built application, SenseController and native Canvas in Chromium',
  limitations: ['No physical stereo camera, image processing accuracy, real AI/account, microphone, speakers or touchscreen verified. Reduced motion provides deterministic geometry.'],
  scope: selectedCase ? `single case: ${selectedCase}` : 'full', started: new Date().toISOString(), inputHashes, servedAssets: {}, fixtureModules: [], cases: [], browserErrors: [], requests: []};
const fixtureSettings = () => ({schema_version: 'proto-0.1', provider: 'mock', providers: [
  {id: 'chatgpt', label: 'ChatGPT', available: false, detail: 'FIXTURE signed out'},
  {id: 'mock', label: '模擬模式', available: true, detail: 'FIXTURE no AI request'},
  {id: 'claude', label: 'Claude', available: false, detail: 'FIXTURE unavailable'},
], chatgpt: {signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: true, pending_login: false, last_error: null},
  realtime: {available: false, model: 'FIXTURE', voice: 'FIXTURE'},
  camera: {enabled: true, label: 'FIXTURE synthetic stereo events', left_first: true, screen_width_mm: 398, screen_offset_mm: 110,
    active: true, look_to_talk: false, look_to_talk_s: 1.5, look_to_talk_cooldown_s: 10, stop_gesture: false}});
function task(domain = 'language') {
  const now = new Date().toISOString();
  return {schema_version: 'proto-0.1', task_id: `task_fixture_${domain}`, request_id: `req_fixture_${domain}`, title: `FIXTURE ${domain}`,
    status: 'running', mode: 'mock', model: null, plan_ready: true, created_at: now, updated_at: now, finished_at: null,
    error: null, artifact_id: null, retry_of: null, steps: [{title: 'FIXTURE step', status: 'running', domain, started_at: now, finished_at: null, output_chars: 12}]};
}
const fixturePipeline = `export class SensePipeline {
  constructor(settings, emit) {
    this.emit = emit; this.active = false;
    window.__distanceFixture = {events: [], starts: 0, stops: 0, send: event => { window.__distanceFixture.events.push(event); emit(event); }};
  }
  get running() { return this.active; }
  async start() { if (this.active) return; this.active = true; window.__distanceFixture.starts++; this.emit({type:'sensor',state:'starting',detail:'FIXTURE synthetic camera'}); this.emit({type:'sensor',state:'ok',detail:'FIXTURE synthetic camera'}); }
  stop() { if (!this.active) return; this.active = false; window.__distanceFixture.stops++; this.emit({type:'sensor',state:'off',detail:'FIXTURE stopped'}); this.emit({type:'presence',present:false,distance_m:null}); }
  setPreview() {}
}`;
let current = {name: '', settings: fixtureSettings(), tasks: [], sequence: 0};
const clients = new Set();
const frame = event => `data: ${JSON.stringify({sequence: ++current.sequence, ...event})}\n\n`;
function emit(event) { for (const response of clients) response.write(frame(event)); }
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    if (path.startsWith('/api/')) {
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = body ? JSON.parse(body) : null;
      report.requests.push({case: current.name, method: request.method, path, body: payload});
      if (path === '/api/events') {
        response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
        response.write(frame({type: 'hello', settings: current.settings, tasks: current.tasks}));
        clients.add(response); response.on('close', () => clients.delete(response)); return;
      }
      if (path === '/api/settings/camera' && request.method === 'POST') {
        current.settings.camera = {...current.settings.camera, ...payload};
        emit({type: 'settings.updated', settings: current.settings});
        response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(current.settings)); return;
      }
      response.writeHead(501).end('FIXTURE: real account/model/tool requests prohibited'); return;
    }
    const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const file = resolve(app, 'dist', relative);
    assert.ok(file.startsWith(join(app, 'dist') + '/'));
    const bytes = await readFile(file);
    const assetHash = digest(bytes);
    assert.equal(assetHash, inputHashes.dist.files[relative], 'built asset matches recorded hash');
    if (/^assets\/pipeline-[^/]+\.js$/.test(relative)) {
      assert.match(bytes.toString(), /as SensePipeline|export class SensePipeline/, 'replace only the external camera pipeline export');
      if (!report.fixtureModules.some(module => module.path === relative)) report.fixtureModules.push({path: relative, sourceSha256: assetHash, servedSha256: digest(fixturePipeline)});
      response.writeHead(200, {'content-type': 'text/javascript'}).end(fixturePipeline); return;
    }
    report.servedAssets[relative] = assetHash;
    response.writeHead(200, {'content-type': ({'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'})[extname(file)] || 'application/octet-stream'}).end(bytes);
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, context, page;
function installObservation() {
  let frame = 0;
  const nativeClear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) {
    const result = nativeClear.apply(this, args);
    if (this.canvas.id === 'brain') { frame++; window.__distanceLabels = []; }
    return result;
  };
  const nativeEllipse = CanvasRenderingContext2D.prototype.ellipse;
  CanvasRenderingContext2D.prototype.ellipse = function (...args) {
    const result = nativeEllipse.apply(this, args);
    if (this.canvas.id === 'brain' && args[0] === 0 && args[1] === 0 && args[2] > 0 && Math.abs(args[2] / args[3] - 1.62 / .42) < .001) {
      const transform = this.getTransform();
      const dpr = this.canvas.width / this.canvas.getBoundingClientRect().width;
      window.__distanceDraw = {frame, timestampMs: performance.now(), rx: args[2], radius: args[2] / 1.62, cx: transform.e / dpr, cy: transform.f / dpr, dpr};
    }
    return result;
  };
  const nativeText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    const result = nativeText.call(this, text, x, y, ...rest);
    if (this.canvas.id === 'brain') {
      const metrics = this.measureText(text), transform = this.getTransform();
      const dpr = this.canvas.width / this.canvas.getBoundingClientRect().width;
      const left = this.textAlign === 'right' ? x - metrics.width : this.textAlign === 'center' ? x - metrics.width / 2 : x;
      const start = new DOMPoint(left, y - metrics.actualBoundingBoxAscent).matrixTransform(transform);
      const end = new DOMPoint(left + metrics.width, y + metrics.actualBoundingBoxDescent).matrixTransform(transform);
      window.__distanceLabels.push({text, left: start.x / dpr, top: start.y / dpr, right: end.x / dpr, bottom: end.y / dpr, font: this.font});
    }
    return result;
  };
  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.textContent = 'FIXTURE synthetic stereo distance/API · Real Canvas · No physical camera or AI';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:1px;background:#ffec70;color:#111;font:700 10px/12px sans-serif;text-align:center;z-index:999999;pointer-events:none';
    document.body.append(banner);
  });
}
async function fresh(name, options = {}) {
  await context?.close();
  current = {name, settings: fixtureSettings(), tasks: options.tasks || [], sequence: 0};
  context = await browser.newContext({viewport: options.viewport || {width: 1280, height: 900}, reducedMotion: 'reduce', deviceScaleFactor: options.dpr || 1});
  await context.addInitScript(installObservation);
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push({case: name, error: String(error)}));
  await page.goto(base);
  await page.waitForFunction(() => window.__distanceFixture && window.__distanceDraw?.frame > 0);
}
async function sense(event) { await page.evaluate(event => window.__distanceFixture.send(event), event); }
async function distance(meters) { await sense({type: 'presence', present: true, distance_m: meters}); }
async function geometry() {
  const requested = await page.evaluate(() => ({frame: window.__distanceDraw?.frame || 0, timestampMs: performance.now()}));
  let previous;
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(110);
    const next = await page.evaluate(() => window.__distanceDraw);
    if (next.frame <= requested.frame || next.timestampMs <= requested.timestampMs || previous?.frame === next.frame) continue;
    if (previous && Math.abs(previous.radius - next.radius) < .02 && Math.abs(previous.cy - next.cy) < .02) return {...next, requestedAfterFrame: requested.frame, requestedAtMs: requested.timestampMs, priorStableFrame: previous.frame, priorStableTimestampMs: previous.timestampMs};
    previous = next;
  }
  throw new Error('Two fresh stable native Canvas frames were not observed');
}
async function cssScale() { return page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--distance-scale')) || 1); }
async function openSettings() {
  await page.mouse.click(2, 2); await page.keyboard.press('Enter');
  await page.locator('#command-input').waitFor({state: 'visible'});
  await page.locator('#command-input').fill('設定'); await page.locator('#command-input').press('Enter');
  await page.locator('.surface--settings').waitFor();
}
async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('.surface--settings').waitFor({state: 'detached'});
}
async function screenshot(name) { const path = join(output, `${name}.png`); await page.screenshot({path, fullPage: true}); return path; }
async function bounds(selector) { return page.locator(selector).boundingBox(); }
function fits(box, viewport, label) {
  assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label} within viewport: ${JSON.stringify(box)}`);
}
function clear(a, b, label) {
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${label} do not overlap: ${JSON.stringify({a, b})}`);
}
async function run(name, action) {
  if (selectedCase && selectedCase !== name) return;
  const result = {name, status: 'running'}; report.cases.push(result);
  try { await action(result); result.status = 'passed'; }
  catch (error) { result.status = 'failed'; result.error = error.stack; if (page && !page.isClosed()) result.screenshot = await screenshot(`FAIL-${name}`); }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${result.status}: ${name}`);
}
try {
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  report.runtime = {node: process.version, chromium: browser.version()};
  await run('measured-distance-actual-canvas-and-refresh', async result => {
    await fresh('measured-distance-actual-canvas-and-refresh'); result.values = [];
    for (const [meters, expectedScale] of [[1.5, .75], [2, 1], [3, 1.5]]) {
      await distance(meters); const value = await geometry(); assert.equal(await cssScale(), expectedScale);
      result.values.push({meters, scale: expectedScale, ...value});
    }
    const [near, normal, far] = result.values;
    assert.ok(near.radius < normal.radius && normal.radius < far.radius, 'actual Canvas grows with measured distance');
    assert.ok(Math.abs(near.radius / normal.radius - .75) < .01, 'near distance is applied once');
    assert.ok(far.radius / normal.radius <= 1.51, 'far distance is not applied twice');
    emit({type: 'task.updated', task: task()}); emit({type: 'settings.updated', settings: current.settings});
    result.afterRefresh = await geometry(); assert.ok(Math.abs(result.afterRefresh.radius - far.radius) < .02, 'ordinary render preserves measured scale');
    result.screenshot = await screenshot('far-distance-fixture');
  });
  await run('missing-distance-and-sensor-reset-paths', async result => {
    result.resets = [];
    for (const event of [{type: 'presence', present: true, distance_m: null}, {type: 'presence', present: false, distance_m: null},
      ...['off', 'error', 'degraded'].map(state => ({type: 'sensor', state, detail: `FIXTURE ${state}`}))]) {
      await fresh('missing-distance-and-sensor-reset-paths'); await distance(2); const normal = await geometry();
      await distance(3); const far = await geometry(); assert.ok(far.radius > normal.radius);
      await sense(event); const reset = await geometry(); assert.equal(await cssScale(), 1);
      assert.ok(Math.abs(reset.radius - normal.radius) < .02, `real hook resets Canvas for ${JSON.stringify(event)}`);
      result.resets.push({event, normal, far, reset});
    }
    result.screenshot = await screenshot('degraded-reset-fixture');
  });
  await run('top-layout-distance-and-single-panel-scale', async result => {
    await fresh('top-layout-distance-and-single-panel-scale'); await distance(2); await openSettings();
    result.values = [];
    for (const [meters, scale] of [[1.5, .75], [2, 1], [3, 1.5]]) {
      await distance(meters); result.values.push({meters, scale, canvas: await geometry(), panel: await bounds('.surface--settings')});
    }
    const [near, normal, far] = result.values;
    assert.ok(near.canvas.radius < normal.canvas.radius && normal.canvas.radius < far.canvas.radius);
    assert.ok(Math.abs(far.panel.y / normal.panel.y - 1.5) < .03, 'existing panel placement receives distance scale once');
    assert.ok(Math.abs(far.canvas.cy / normal.canvas.cy - 1.5) < .03, 'top-layout Canvas center aligns with existing zoomed panel');
    result.screenshot = await screenshot('top-far-distance-fixture');
  });
  await run('responsive-distance-resize-and-high-dpi', async result => {
    result.viewports = [];
    for (const viewport of [{width: 1920, height: 1080}, {width: 390, height: 844}, {width: 844, height: 390}]) {
      await fresh('responsive-distance-resize-and-high-dpi', {viewport}); const values = [];
      for (const meters of [1.5, 2, 3]) {
        await distance(meters); const value = await geometry();
        assert.ok(value.cx - value.rx >= -1 && value.cx + value.rx <= viewport.width + 1 && value.cy - value.rx >= -1 && value.cy + value.rx <= viewport.height + 1, 'native orbit envelope fits');
        fits(await bounds('#start-conversation'), viewport, 'ambient entry');
        await page.mouse.click(2, 2); await page.keyboard.press('Enter');
        fits(await bounds('#command-input'), viewport, 'text fallback'); await page.keyboard.press('Escape');
        values.push({meters, canvas: value});
      }
      assert.ok(values[0].canvas.radius < values[1].canvas.radius && values[1].canvas.radius < values[2].canvas.radius);
      await openSettings(); const top = await geometry();
      result.viewports.push({viewport, values, top, panel: await bounds('.surface--settings')});
      result.screenshots ||= []; result.screenshots.push(await screenshot(`top-${viewport.width}x${viewport.height}-far-fixture`));
      await closeSettings();
    }
    await page.setViewportSize({width: 390, height: 844}); result.afterResize = await geometry(); assert.equal(await cssScale(), 1.5);
    await fresh('responsive-distance-resize-and-high-dpi', {viewport: {width: 1280, height: 900}, dpr: 2});
    await distance(2); result.highDpi = await geometry(); assert.equal(result.highDpi.dpr, 2);
    assert.ok(Math.abs(result.highDpi.radius - 180) < .1, 'DPR does not apply distance a second time');
  });
  await run('active-region-labels-and-control-clearance', async result => {
    result.viewports = [];
    for (const viewport of [{width: 390, height: 844}, {width: 844, height: 390}]) {
      await fresh('active-region-labels-and-control-clearance', {viewport, tasks: ['language', 'math', 'art', 'auditory', 'visual', 'planning'].map(task)});
      await distance(3); const canvas = await geometry();
      await page.waitForFunction(() => window.__distanceLabels?.length === 6);
      const labels = await page.evaluate(() => window.__distanceLabels);
      for (const label of labels) {
        assert.match(label.text, /模擬任務/);
        assert.ok(label.left >= 0 && label.top >= 0 && label.right <= viewport.width && label.bottom <= viewport.height, `Canvas label fits: ${JSON.stringify(label)}`);
      }
      const activity = await bounds('#region-activity'), entry = await bounds('#start-conversation');
      fits(activity, viewport, 'source status'); clear(activity, entry, 'source status and ambient entry');
      const fullText = await page.locator('#region-activity').textContent();
      for (const name of ['語言區', '數理區', '藝術區', '聽覺區', '視覺區', '規劃區']) assert.ok(fullText.includes(name), `full source text retains ${name}`);
      result.screenshots ||= []; result.screenshots.push(await screenshot(`active-${viewport.width}x${viewport.height}-far-fixture`));
      await page.mouse.click(2, 2); await page.keyboard.press('Enter'); await page.locator('#command-input').waitFor({state: 'visible'});
      const typingActivity = await bounds('#region-activity'), command = await bounds('#command');
      fits(command, viewport, 'full text fallback'); clear(typingActivity, command, 'source status and text fallback');
      await page.keyboard.press('Escape'); await openSettings();
      const record = {viewport, canvas, labels, activity, entry, typingActivity, command, topDistances: []};
      result.viewports.push(record);
      for (const meters of [1.5, 2, 3]) {
        await distance(meters); const topCanvas = await geometry();
        const topActivity = await bounds('#region-activity'), panel = await bounds('.surface--settings');
        record.topDistances.push({meters, canvas: topCanvas, activity: topActivity, panel, closeButton: await bounds('.surface--settings .surface-footer button')});
        assert.equal(await page.locator('#region-activity').textContent(), fullText, 'top ellipsis preserves complete source descriptions');
        assert.ok(topActivity.y + topActivity.height <= panel.y, `top source status stays above panel at ${meters}m: ${JSON.stringify({viewport, topActivity, panel})}`);
      }
      await closeSettings();
    }
  });
  await run('scaled-hit-area-and-camera-off-command', async result => {
    await fresh('scaled-hit-area-and-camera-off-command'); await distance(3); const far = await geometry();
    const point = {x: far.cx + far.radius * 1.2, y: far.cy};
    await page.mouse.click(point.x, point.y); await page.locator('.surface--settings').waitFor(); await closeSettings();
    await distance(1.5); const near = await geometry();
    await page.mouse.click(point.x, point.y); await page.waitForTimeout(150);
    assert.equal(await page.locator('.surface--settings').count(), 0, 'hit area shrinks with actual brain');
    await distance(3); await page.mouse.click(2, 2); await page.keyboard.press('Enter');
    await page.locator('#command-input').fill('鏡頭關掉'); await page.locator('#command-input').press('Enter');
    result.afterOff = await geometry(); assert.equal(await cssScale(), 1);
    assert.equal(current.settings.camera.active, false); assert.ok(await page.evaluate(() => window.__distanceFixture.stops > 0));
    result.far = far; result.near = near; result.point = point; result.screenshot = await screenshot('camera-off-reset-fixture');
  });
} finally {
  report.finished = new Date().toISOString();
  report.sourceUnchangedDuringRun = JSON.stringify(await sourceHashes()) === JSON.stringify({src: inputHashes.src, shared: inputHashes.shared, entry: inputHashes.entry});
  report.distUnchangedDuringRun = JSON.stringify(await hashes(join(app, 'dist'))) === JSON.stringify(inputHashes.dist);
  report.passed = report.cases.length === (selectedCase ? 1 : 6) && report.cases.every(c => c.status === 'passed') && report.browserErrors.length === 0 && report.sourceUnchangedDuringRun && report.distUnchangedDuringRun;
  await context?.close(); await browser?.close(); for (const response of clients) response.end();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${join(output, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
