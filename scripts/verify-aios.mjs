import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, 'prototype/ambient-shell');
const evidence = await mkdtemp(join(tmpdir(), 'aios-verification-'));
const scratch = join(evidence, 'runtime');
const report = { mode: 'mock', checks: [], passed: false };
let server;
let exited;
let serverLog = '';

try {
  for (const command of ['typecheck', 'test', 'build']) {
    const result = spawnSync('npm', ['run', command], { cwd: app, encoding: 'utf8' });
    await writeFile(join(evidence, `${command}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `npm run ${command} failed`);
    report.checks.push(command);
  }

  await mkdir(scratch);
  for (const name of ['server', 'shared', 'dist', 'package.json']) {
    await cp(join(app, name), join(scratch, name), { recursive: true });
  }
  await symlink(join(app, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, NOUS_CONFIG_DIR: join(scratch, 'config'), NOUS_PROVIDER: 'mock', PORT: String(port) };
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, ['--import', pathToFileURL(join(app, 'node_modules/tsx/dist/loader.mjs')).href, join(scratch, 'server/index.ts')], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', resolve);
  });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  for (let i = 0; i < 50 && !serverLog.includes('Nous 原型已啟動'); i++) {
    assert.equal(server.exitCode, null, serverLog);
    await pause();
  }
  assert.match(serverLog, /Nous 原型已啟動/);
  const base = `http://127.0.0.1:${port}`;
  const request = path => fetch(base + path, { signal: AbortSignal.timeout(5000) });
  const json = async path => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script/);
  assert.equal((await json('/api/settings')).provider, 'mock');
  report.checks.push('built HTML and mock provider');
  const response = await fetch(base + '/api/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'pstack 環境驗證，模擬任務', request_id: 'req_pstack_verify0001' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  let task;
  for (let i = 0; i < 100; i++) {
    task = (await json('/api/tasks')).find(value => value.task_id === created.task_id);
    assert.ok(task);
    assert.notEqual(task.status, 'failed', task.error);
    if (task.status === 'succeeded') break;
    await pause();
  }
  assert.equal(task.status, 'succeeded');
  const artifact = await json(`/api/artifacts/${task.artifact_id}`);
  assert.equal(artifact.task_id, task.task_id);
  assert.equal(artifact.mode, 'mock');
  assert.equal(artifact.status, 'partial');
  assert.match(artifact.content, /沒有實際完成/);
  const persisted = JSON.parse(await readFile(join(scratch, 'data/artifacts.json'), 'utf8'));
  assert.ok(persisted.some(value => value.artifact_id === artifact.artifact_id));
  await cp(join(scratch, 'data'), join(evidence, 'data'), { recursive: true });
  report.checks.push('HTTP task submission, completion, labeled mock artifact and JSON persistence');
  report.task = task;
  report.artifact = artifact;
  const chat = await fetch(base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好，這是模擬對話驗證。' }], request_id: 'req_pstack_chat0001' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(chat.status, 200);
  const events = (await chat.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
  assert.equal(events.at(-1)?.type, 'done');
  assert.ok(events.some(event => event.type === 'delta'));
  assert.match(events.filter(event => event.type === 'delta').map(event => event.text).join(''), /模擬/);
  assert.equal((await json('/api/tasks')).length, 1, 'ordinary mock dialogue creates no extra task');
  report.checks.push('direct mock chat SSE with terminal event and no unsolicited background task');
  report.chatEvents = events;
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  await writeFile(join(evidence, 'server.log'), serverLog);
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(scratch, { recursive: true, force: true });
  console.log(`${report.passed ? 'PASS' : 'FAIL'}. Evidence: ${evidence}/report.json`);
  if (report.error) console.error(report.error);
}
