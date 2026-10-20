import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, 'vendor/pstack');
const lock = JSON.parse(await readFile(join(root, 'vendor/pstack.lock.json'), 'utf8'));
assert.match(lock.commit, /^[0-9a-f]{40}$/);
const manifest = JSON.parse(await readFile(join(upstream, 'plugin.json'), 'utf8'));
assert.equal(manifest.version, lock.version);

const entries = (await readdir(upstream, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => join(entry.parentPath, entry.name).slice(upstream.length + 1))
  .sort();
assert.deepEqual(entries, Object.keys(lock.files).sort(), 'upstream file membership changed');
for (const path of entries) {
  const hash = createHash('sha256').update(await readFile(join(upstream, path))).digest('hex');
  assert.equal(hash, lock.files[path], `upstream file changed: ${path}`);
}

const skills = await readdir(join(upstream, 'skills'));
for (const name of skills) {
  const canonical = join(upstream, 'skills', name);
  const text = await readFile(join(canonical, 'SKILL.md'), 'utf8');
  const header = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(header, `missing frontmatter: ${name}`);
  assert.ok(/^name: .+/m.test(header[1]), `missing name: ${name}`);
  assert.ok(/^description: .+/m.test(header[1]), `missing description: ${name}`);
  for (const client of ['.cursor', '.agents']) {
    assert.equal(await realpath(join(root, client, 'skills', name)), canonical);
  }
}
for (const name of await readdir(join(upstream, 'agents'))) {
  assert.equal(await realpath(join(root, '.cursor/agents', name)), join(upstream, 'agents', name));
}
assert.equal(await realpath(join(root, '.cursor/skills/verify-aios')), join(root, '.agents/skills/verify-aios'));
const rule = await readFile(join(root, '.cursor/rules/pstack-models.mdc'), 'utf8');
const setup = await readFile(join(upstream, 'skills/setup-pstack/SKILL.md'), 'utf8');
const template = setup.match(/# budget: large \(xhigh\)\n([\s\S]*?)\n```/)[1];
const roles = text => text.split('\n').filter(line => line && !line.startsWith('#') && line.includes(': ')).map(line => line.split(': ')[0]);
const config = rule.split('---')[2].trim();
assert.deepEqual(roles(config), roles(template), 'role configuration differs from upstream roles');
for (const line of config.split('\n').filter(line => line && !line.startsWith('#'))) {
  assert.ok(line.split(': ')[1].split(', ').every(model => model === 'inherit-parent'), `unexpected model: ${line}`);
}
console.log(`pstack ${lock.version}: ${entries.length} upstream hashes, ${skills.length} skills in both clients, agents and model roles verified.`);
