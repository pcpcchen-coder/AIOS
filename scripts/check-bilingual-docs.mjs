#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'docs/bilingual-manifest.json');
const record = process.argv.includes('--record');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n'))]
  .filter(p => p.endsWith('.md') && !p.startsWith('vendor/') && existsSync(resolve(root, p)) && !lstatSync(resolve(root, p)).isSymbolicLink()).sort();
const sources = files.filter(p => !/\.(en|zh-TW)\.md$/.test(p));
const previous = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { documents: [] };
const oldByPath = new Map(previous.documents.map(d => [d.source, d]));
const errors = [];
const documents = [];
const hash = text => createHash('sha256').update(text).digest('hex');
const read = p => readFileSync(resolve(root, p), 'utf8');
const targetFrom = (from, to) => relative(dirname(from), to).replaceAll('\\', '/');
const hasLink = (text, target) => text.includes(`](${target})`) || text.includes(`](./${target})`);
const content = text => text.replace(/^<!-- bilingual:.*-->\n/gm, '').replace(/^> \[繁體中文\].*\n/gm, '');
function fences(text) {
  const blocks = [];
  let delimiter = null;
  let block = [];
  for (const line of content(text).split('\n')) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match && !delimiter) { delimiter = match[1]; block = [line.trimStart()]; }
    else if (delimiter) {
      block.push(line);
      if (match && match[1][0] === delimiter[0] && match[1].length >= delimiter.length) { blocks.push(block.join('\n')); delimiter = null; }
    }
  }
  return blocks;
}
for (const source of sources) {
  const text = read(source);
  if (text.includes('<!-- bilingual-inline -->')) {
    if (!/[\u3400-\u9fff]/u.test(text) || !/^## English\s*$/m.test(text)) errors.push(`${source}: inline policy needs both complete languages`);
    const entry = { source, mode: 'inline', sha256: hash(text) };
    documents.push(entry);
    if (!record && JSON.stringify(oldByPath.get(source)) !== JSON.stringify(entry)) errors.push(`${source}: changed or unrecorded; review both languages, then use --record`);
    continue;
  }
  const sourceLanguage = text.match(/<!-- bilingual: source=(en|zh-TW) -->/)?.[1] ?? (/[\u3400-\u9fff]/u.test(content(text)) ? 'zh-TW' : 'en');
  const companionLanguage = sourceLanguage === 'en' ? 'zh-TW' : 'en';
  const translation = source.replace(/\.md$/, `.${companionLanguage}.md`);
  if (!files.includes(translation)) { errors.push(`${source}: missing ${translation}`); continue; }
  const translated = read(translation);
  if (!hasLink(text, targetFrom(source, translation))) errors.push(`${source}: missing link to companion`);
  if (!hasLink(translated, targetFrom(translation, source))) errors.push(`${translation}: missing link to original`);
  if (!content(translated).trim() || content(translated).trim().length < content(text).trim().length * 0.35) errors.push(`${translation}: content is implausibly short; inspect for missing sections`);
  const a = fences(text), b = fences(translated);
  if (a.length !== b.length || a.some((block, i) => block !== b[i])) errors.push(`${translation}: executable/evidence fenced blocks differ from the original`);
  const entry = { source, sourceLanguage, translation, sourceSha256: hash(text), translationSha256: hash(translated) };
  documents.push(entry);
  const old = oldByPath.get(source);
  if (record && old?.translation === translation && (old.sourceSha256 !== entry.sourceSha256 && old.translationSha256 === entry.translationSha256)) errors.push(`${source}: only one language changed; synchronize its companion before recording`);
  if (!record && JSON.stringify(old) !== JSON.stringify(entry)) errors.push(`${source}: pair changed or unrecorded; synchronize and review before --record`);
}
const paired = new Set(documents.flatMap(d => d.translation ? [d.source, d.translation] : [d.source]));
for (const file of files) if (/\.(en|zh-TW)\.md$/.test(file) && !paired.has(file)) errors.push(`${file}: orphaned translation`);
if (!record) for (const old of previous.documents) if (!sources.includes(old.source)) errors.push(`${old.source}: removed; remove both versions and refresh the reviewed catalog`);
if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`Bilingual documentation check FAILED (${errors.length} issues).`);
  process.exitCode = 1;
} else {
  if (record) writeFileSync(catalogPath, JSON.stringify({ version: 1, policy: 'docs/BILINGUAL.md', documents }, null, 2) + '\n');
  console.log(`Bilingual documentation ${record ? 'catalog recorded' : 'check passed'}: ${documents.length} documents, ${documents.filter(d => d.translation).length} complete pairs, ${documents.filter(d => d.mode === 'inline').length} inline policies.`);
}
