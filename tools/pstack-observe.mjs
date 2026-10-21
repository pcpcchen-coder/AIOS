#!/usr/bin/env node
/** pstack run recorder. Local-first; publishing to a PUBLIC central repo is explicit. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_STATUSES = new Set(['running', 'passed', 'failed', 'blocked', 'cancelled']);
const STEP_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'blocked', 'skipped']);
const cmd = process.argv[2];
function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (['publish', 'public-ok'].includes(key)) { out[key] = true; continue; }
    if (i + 1 >= argv.length || argv[i+1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}
const opts = argsFrom(process.argv.slice(3));
const die = (msg) => { throw new Error(msg); };
const now = () => new Date().toISOString();
const safe = (s, max=400) => String(s || '').slice(0, max);
const validateId = (id, what='run') => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id || '')) die(`Invalid ${what} ID; use letters, digits, dot, underscore or hyphen (max 80)`);
  return id;
};
const validateRepo = (repo) => {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo || '') || repo.includes('..')) die('Expected --repo owner/name');
  return repo;
};
const workspace = resolve(opts.workspace || process.cwd());
const dir = join(workspace, '.pstack', 'observability', 'runs');
const pathFor = (id) => join(dir, `${validateId(id)}.json`);
function load() {
  if (!opts.run) die('Provide --run <run-id>');
  const path = pathFor(opts.run);
  if (!existsSync(path)) die(`Run not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function save(run) {
  mkdirSync(dir, { recursive: true });
  run.updated_at = now();
  writeFileSync(pathFor(run.run_id), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
  return run;
}
const ev = (run, kind, step, status, note) => {
  run.events.push({ at: now(), type: kind, step_id: step || null, status, note: safe(note, 500) });
  if (run.events.length > 200) run.events = run.events.slice(-200);
};
function ghCall(method, apiPath, body, allowNotFound=false) {
  const a = ['api', '-X', method, apiPath];
  if (body !== undefined) a.push('--input', '-');
  const r = spawnSync('gh', a, { encoding: 'utf8', input: body && JSON.stringify(body), env: process.env, timeout: 30000, maxBuffer: 1024*1024 });
  if (r.error) die(`Cannot invoke GitHub CLI: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowNotFound && /404|Not Found/i.test(r.stderr)) return null;
    die(`GitHub API ${method} failed: ${safe(r.stderr, 1200)}`);
  }
  return r.stdout ? JSON.parse(r.stdout) : {};
}
function publish(run) {
  if (!opts['public-ok'] || process.env.PSTACK_OBSERVE_PUBLICATION_ACK !== '1') {
    die('Publishing to a PUBLIC repository requires --public-ok AND PSTACK_OBSERVE_PUBLICATION_ACK=1');
  }
  if (run.repo.split('/')[0] !== 'pcpcchen-coder') die('Only pcpcchen-coder repositories are allowed in this dashboard');
  const target = 'pcpcchen-coder/CursorPlugins';
  const branch = 'custom/pstack';
  const path = `dashboard/data/runs/${run.repo}/${run.run_id}.json`;
  const api = `repos/${target}/contents/${path}`;
  const existing = ghCall('GET', `${api}?ref=${encodeURIComponent(branch)}`, undefined, true);
  const payload = {
    message: `data(pstack): ${run.repo} ${run.run_id} ${run.status}`,
    content: Buffer.from(JSON.stringify(run, null, 2) + '\n').toString('base64'),
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {})
  };
  ghCall('PUT', api, payload);
  console.log(`PUBLISHED ${run.repo} ${run.run_id} to ${target}:${branch}`);
}
function maybePublish(run) { if (opts.publish) publish(run); }
function requireOpen(run) { if (run.ended_at) die(`Run ${run.run_id} is finished`); }
function parseEvidence(raw) {
  if (!raw) return [];
  const url = new URL(raw);
  if (url.protocol !== 'https:') die('--evidence must be an https URL (GitHub commit, PR, CI run or report)');
  return [{ label: safe(opts['evidence-label'] || 'Evidence', 100), url: url.toString().slice(0, 800) }];
}
const help = `Usage:
  node pstack-observe.mjs start --repo pcpcchen-coder/AIOS --title "Task" --playbook bug-fix --steps "investigate,fix,test,review" [--run ID]
  node pstack-observe.mjs step --run ID --step investigate --status running|passed|failed|blocked|skipped [--note TEXT] [--evidence https://...]
  node pstack-observe.mjs finish --run ID --status passed|failed|blocked|cancelled [--note TEXT]
  node pstack-observe.mjs publish --run ID --public-ok

All commands support --workspace PATH. start/step/finish can add --publish --public-ok to publish each snapshot.
Publishing is opt-in and REQUIRES PSTACK_OBSERVE_PUBLICATION_ACK=1 and GitHub CLI authenticated with Contents:write on the PUBLIC dashboard repo.
No event is automatically collected merely by installing this script.`;
try {
  if (cmd === 'start') {
    const id = validateId(opts.run || `run-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${randomUUID().slice(0,6)}`);
    if (existsSync(pathFor(id))) die(`Run ${id} already exists`);
    const steps = (opts.steps || 'investigate,implement,verify,review').split(',').map(s => s.trim()).filter(Boolean);
    if (!steps.length || steps.length > 40 || new Set(steps).size !== steps.length) die('Use 1–40 unique comma-separated step IDs');
    steps.forEach(id => validateId(id, 'step'));
    const t = now();
    const run = {
      schema_version: 1, repo: validateRepo(opts.repo), run_id: id,
      title: safe(opts.title || 'Untitled pstack run', 160), playbook: safe(opts.playbook || 'unspecified', 80),
      branch: safe(opts.branch || '', 120), commit_sha: safe(opts.commit || '', 64),
      status: 'running', started_at: t, updated_at: t, ended_at: null,
      steps: steps.map(id => ({ id, title: id.replace(/[-_]/g,' '), status: 'pending', started_at: null, ended_at: null, note: '', evidence: [] })),
      events: []
    };
    ev(run, 'run_started', null, 'running', '');
    save(run); maybePublish(run);
    console.log(`RUN_ID=${run.run_id}`);
    console.log(`LOCAL=${pathFor(id)}`);
  } else if (cmd === 'step') {
    const run = load(); requireOpen(run);
    const step = run.steps.find(s => s.id === opts.step);
    if (!step) die(`Unknown step ${opts.step}; expected ${run.steps.map(s => s.id).join(', ')}`);
    const status = opts.status;
    if (!STEP_STATUSES.has(status) || status === 'pending') die('step status must be running, passed, failed, blocked or skipped');
    if (step.ended_at && status === 'running') die('Cannot re-open completed step; use a new run');
    if (!step.started_at) step.started_at = now();
    step.status = status;
    if (status !== 'running') step.ended_at = now();
    if (opts.note) step.note = safe(opts.note, 500);
    for (const evidence of parseEvidence(opts.evidence)) {
      if (!step.evidence.some(item => item.url === evidence.url)) step.evidence.push(evidence);
    }
    ev(run, 'step_updated', step.id, status, opts.note);
    save(run); maybePublish(run);
    console.log(`STEP=${step.id} STATUS=${status}`);
  } else if (cmd === 'finish') {
    const run = load(); requireOpen(run);
    const status = opts.status;
    if (!RUN_STATUSES.has(status) || status === 'running') die('finish status must be passed, failed, blocked or cancelled');
    if (status === 'passed' && run.steps.some(s => !['passed','skipped'].includes(s.status))) {
      die('Cannot finish passed while steps are incomplete; mark each step passed or skipped');
    }
    run.status = status;
    run.ended_at = now();
    ev(run, 'run_finished', null, status, opts.note);
    save(run); maybePublish(run);
    console.log(`RUN=${run.run_id} STATUS=${status}`);
  } else if (cmd === 'publish') {
    const run = load();
    publish(run);
  } else {
    console.log(help);
    if (cmd && !['--help','help'].includes(cmd)) process.exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
