import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checker = new URL('./check-bilingual-docs.mjs', import.meta.url);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-bilingual-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'docs'));
  cpSync(checker, join(dir, 'scripts/check-bilingual-docs.mjs'));
  const put = (path, text) => writeFileSync(join(dir, path), text);
  put('README.md', '<!-- bilingual: source=zh-TW -->\n\n[English](README.en.md)\n\n# 說明\n\n這是完整的操作說明文件。請啟動程式。\n\n```sh\nnpm start\n```\n');
  put('README.en.md', '[繁體中文](README.md)\n\n# Guide\n\nThis is the complete usage guide. Start the application.\n\n```sh\nnpm start\n```\n');
  const run = (...args) => spawnSync(process.execPath, ['scripts/check-bilingual-docs.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  const recorded = run('--record');
  assert.equal(recorded.status, 0, recorded.stderr);
  return { dir, put, run, read: path => readFileSync(join(dir, path), 'utf8') };
}

test('accepts reviewed pairs and detects a new document without its translation', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  f.put('docs/new.md', '# 新指南\n\n這份文件也需要完整英文。\n');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing docs\/new.en.md/);
});

test('rejects one-language edits even when recording is requested', t => {
  const f = fixture(t);
  f.put('README.md', f.read('README.md') + '\n新增步驟。\n');
  assert.equal(f.run().status, 1);
  const result = f.run('--record');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only one language changed/);
  f.put('README.en.md', f.read('README.en.md') + '\nAn additional step.\n');
  assert.equal(f.run('--record').status, 0);
  assert.equal(f.run().status, 0);
});

test('rejects changed executable examples and missing reciprocal links', t => {
  const f = fixture(t);
  f.put('README.en.md', f.read('README.en.md').replace('npm start', 'npm run missing').replace('[繁體中文](README.md)', 'Original'));
  const result = f.run('--record');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing link to original/);
  assert.match(result.stderr, /fenced blocks differ/);
});

test('detects removal of just one language and orphaned translations', t => {
  const f = fixture(t);
  rmSync(join(f.dir, 'README.md'));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /orphaned translation/);
  assert.match(result.stderr, /removed/);
});

test('allows a complete inline policy but rejects an English-only placeholder', t => {
  const f = fixture(t);
  f.put('docs/policy.md', '<!-- bilingual-inline -->\n# Policy / 規範\n\n## 繁體中文\n兩種語言一起更新。\n\n## English\nUpdate both languages together.\n');
  assert.equal(f.run('--record').status, 0);
  f.put('docs/policy.md', '<!-- bilingual-inline -->\n# Policy\n\n## English\nEnglish only.\n');
  const result = f.run('--record');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs both complete languages/);
});
