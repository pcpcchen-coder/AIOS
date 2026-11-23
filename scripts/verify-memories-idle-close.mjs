#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAst } from '../prototype/ambient-shell/node_modules/rolldown/dist/parse-ast-index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'prototype/ambient-shell');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const web = resolve(option('web', join(app, 'desktop/build/app/web')));
const evidence = await mkdtemp(join(tmpdir(), 'aios-memories-close-'));
const output = resolve(option('output', join(evidence, 'report.json')));
const scratch = join(evidence, 'runtime');
await mkdir(join(scratch, 'library'), { recursive: true });
await writeFile(join(scratch, 'library/MOCK.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const { startNous } = await import(pathToFileURL(join(app, 'desktop/build/app/server.mjs')));
const core = await startNous({
  envFile: null, dataDir: join(scratch, 'data'), distDir: web,
  overrides: {
    PORT: String(port), NOUS_CONFIG_DIR: join(scratch, 'config'), NOUS_MEMORIES_DIR: join(scratch, 'library'),
    NOUS_PROVIDER: 'mock', NOUS_CAMERA: 'off', NOUS_WAKE: 'off', NOUS_GOG_PATH: '', NOUS_GOG_ACCOUNT: '', NOUS_MAIL_SELF: '',
  },
  log: () => {},
});
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
let browser;
const report = {
  fixture: 'Real built page and actual realtime onClosed callback; synthetic close events, fake clock, isolated core and synthetic PNG; no microphone or AI calls',
  cases: [], errors: [],
};

try {
  const { chromium } = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
  const url = `http://127.0.0.1:${port}`;
  const response = await fetch(`${url}/api/settings/memories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, idle_s: 60, dwell_s: 5 }),
  });
  assert.equal(response.status, 200);
  const html = await readFile(join(web, 'index.html'), 'utf8');
  const asset = html.match(/src="\/(assets\/main-[\w-]+\.js)"/)?.[1];
  assert(asset, 'build the real application before running the browser check');
  const source = await readFile(join(web, asset), 'utf8');
  let busyFunction;
  let callbacksName;
  let closeCallback;
  let requestIdsName;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.key?.name === 'userRequestIds' && node.value?.type === 'Identifier') requestIdsName = node.value.name;
    if (node.type === 'FunctionDeclaration' && node.end - node.start < 1600 && source.slice(node.start, node.end).includes('dataset.facing')) busyFunction = node;
    if (node.type === 'VariableDeclarator' && node.init?.type === 'ObjectExpression'
      && node.init.properties.some(property => property.key?.name === 'onClosed')
      && node.init.properties.some(property => property.key?.name === 'onPhase')) {
      callbacksName = node.id.name;
      closeCallback = node.init.properties.find(property => property.key?.name === 'onClosed').value;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parseAst(source));
  assert(busyFunction && callbacksName && requestIdsName, 'cannot locate the real module callback and idle check in this build');
  const statement = busyFunction.body.body.find(node => node.type === 'ReturnStatement');
  assert(statement);
  let dispatchName;
  let taskMapName;
  let shellName;
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.arguments.some(argument => argument.type === 'ObjectExpression'
        && argument.properties.some(property => property.key?.name === 'type'
          && (property.value?.value ?? property.value?.quasis?.[0]?.value?.cooked) === 'input.open'))) dispatchName = node.callee.name;
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.property.name === 'values') taskMapName = node.object.name;
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.property.name === 'surface') shellName = node.object.name;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  }
  inspect(closeCallback);
  inspect(statement);
  assert(dispatchName && taskMapName && shellName);
  const lines = source.slice(0, statement.start).split('\n');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });

  const cases = [
    { name: 'idle empty returns to memories', code: 'idle', ambient: true },
    { name: 'duration limit returns to memories', code: 'max_duration', ambient: true },
    { name: 'real error keeps recovery input', code: null, ambient: false },
    { name: 'typed draft is preserved', code: 'idle', draft: true, ambient: false },
    { name: 'open settings surface is preserved', code: 'idle', surface: true, ambient: false },
    { name: 'foreground task still presents its result', code: 'idle', foreground: true, ambient: false },
  ];
  for (const test of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.clock.install();
      page.on('pageerror', error => report.errors.push(String(error)));
      await page.goto(`${url}/?terminal=rpi4`);
      await page.waitForFunction(() => document.body.dataset.memories === 'waiting');
      if (test.draft) {
        await page.keyboard.press('Enter');
        await page.locator('#command-input').fill('MOCK draft remains');
      }
      if (test.surface) await page.evaluate(() => document.querySelector('#conversation-settings').click());
      if (test.foreground) await page.route('**/api/artifacts/artifact_close_fixture', route => route.fulfill({
        json: { schema_version: 'proto-0.1', artifact_id: 'artifact_close_fixture', version: 1, task_id: 'task_close_fixture', title: 'MOCK result', content: 'MOCK result content', mode: 'mock', model: null, assumptions: [], capability_gaps: [], status: 'complete', created_at: '2026-01-01T00:00:00.000Z' },
      }));

      // A non-pausing breakpoint reaches the actual module closure without a production test API.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Debugger.enable');
      const condition = `(window.__closeTest?(()=>{const request=window.__closeTest;window.__closeTest=null;if(request.foreground){${requestIdsName}.add(request.task.request_id);${taskMapName}.set(request.task.task_id,request.task);${dispatchName}({type:'task.submitted',task_id:request.task.task_id,request_id:request.task.request_id})}${callbacksName}.onClosed('MOCK close test',request.code??undefined);if(request.foreground){window.__foregroundPreserved=${shellName}.mode==='working'&&${shellName}.foreground_task_id===request.task.task_id;const done={...request.task,status:'succeeded',artifact_id:'artifact_close_fixture',finished_at:'2026-01-01T00:00:01.000Z'};${taskMapName}.set(done.task_id,done);${dispatchName}({type:'task.updated',task:done});window.__completionPresented=${shellName}.surface?.kind==='artifact'}window.__closeTestDone=true})():0,false)`;
      const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', {
        url: `${url}/${asset}`, lineNumber: lines.length - 1, columnNumber: lines.at(-1).length, condition,
      });
      await page.evaluate(({ code, foreground }) => {
        window.__closeTest = { code, foreground, task: { schema_version: 'proto-0.1', task_id: 'task_close_fixture', request_id: 'req_aaaaaaaa', title: 'MOCK task', status: 'running', mode: 'mock', model: null, plan_ready: false, steps: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', finished_at: null, error: null, artifact_id: null, retry_of: null } };
      }, { code: test.code, foreground: !!test.foreground });
      await page.clock.fastForward(1200);
      await page.waitForFunction(() => window.__closeTestDone === true);
      await cdp.send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
      await cdp.send('Debugger.disable');

      const inputOpen = await page.locator('#command').evaluate(element => !element.hidden);
      let error = null;
      try {
        assert.equal(inputOpen, !(test.ambient || test.foreground), 'automatic close must not leave an empty input busy');
        if (test.draft) assert.equal(await page.locator('#command-input').inputValue(), 'MOCK draft remains');
        if (test.surface) assert(await page.locator('.memories-settings').isVisible());
        if (test.foreground) {
          assert(await page.evaluate(() => window.__foregroundPreserved), 'automatic close must retain the foreground task');
          assert(await page.evaluate(() => window.__completionPresented), 'task completion must still present its artifact');
          await page.getByRole('heading', { name: 'MOCK task', exact: true }).waitFor({ state: 'visible' });
        }
        await page.clock.fastForward(61_000);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => document.body.dataset.memories), test.ambient ? 'showing' : 'busy');
      } catch (failure) {
        error = failure.message;
      }
      report.cases.push({ name: test.name, inputOpen, phase: await page.evaluate(() => document.body.dataset.memories), passed: !error, error });
    } finally {
      await context.close();
    }
  }
  report.passed = report.cases.every(test => test.passed) && report.errors.length === 0;
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  await core.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await rm(scratch, { recursive: true, force: true });
}
console.log(`Evidence: ${output}`);
