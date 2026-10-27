import baseMessages from './messages.en.json' with { type: 'json' };

export const LOCALES = Object.freeze(['zh-TW', 'en']);
export const DEFAULT_LOCALE = 'zh-TW';
export function normalizeLocale(value) { return value === 'en' ? 'en' : DEFAULT_LOCALE; }
const messages = new Map();
let patterns = [];
const slots = text => [...text.matchAll(/\{(\d+)\}/g)].map(m => m[1]);
const insert = (text, values) => text.replace(/\{(\d+)\}/g, (match, i) => Number(i) < values.length ? String(values[Number(i)]) : match);

export function registerMessages(catalog) {
  for (const [source, target] of Object.entries(catalog)) {
    if (typeof target !== 'string' || !target.trim()) throw new TypeError(`Missing English message: ${source}`);
    if ([...new Set(slots(source))].sort().join(',') !== [...new Set(slots(target))].sort().join(',')) throw new TypeError(`Message placeholders differ: ${source}`);
    messages.set(source, target);
  }
  patterns = [...messages].filter(([source]) => slots(source).length > 0 && slots(source).length <= 8).map(([source, target]) => {
    const indices = [];
    const parts = [];
    let cursor = 0;
    for (const match of source.matchAll(/\{(\d+)\}/g)) {
      parts.push(source.slice(cursor, match.index));
      indices.push(Number(match[1]));
      cursor = match.index + match[0].length;
    }
    parts.push(source.slice(cursor));
    const numericUnit = /^\{0\} (?:秒|分鐘|倍|個|小時 \{1\} 分|分 \{1\} 秒)(?:（(?:預設|目前)）)?$/u.test(source);
    return { parts, indices, target, numericUnit, weight: parts.join('').length };
  }).sort((a, b) => b.weight - a.weight);
}
registerMessages(baseMessages);

export function translate(source, locale = DEFAULT_LOCALE, ...values) {
  if (normalizeLocale(locale) !== 'en') return insert(source, values);
  const direct = messages.get(source);
  if (direct !== undefined) return insert(direct, values);
  if (!values.length && source.length <= 10000) {
    for (const pattern of patterns) {
      if (!source.startsWith(pattern.parts[0])) continue;
      const captures = [];
      let cursor = pattern.parts[0].length;
      let valid = true;
      for (const [i, slot] of pattern.indices.entries()) {
        const next = pattern.parts[i + 1];
        const last = i === pattern.indices.length - 1;
        const end = last ? (source.endsWith(next) ? source.length - next.length : -1) : source.indexOf(next, cursor);
        if (end < cursor) { valid = false; break; }
        const value = source.slice(cursor, end);
        if (captures[slot] !== undefined && captures[slot] !== value) { valid = false; break; }
        captures[slot] = value;
        cursor = end + next.length;
      }
      if (pattern.numericUnit && captures.some(value => !/^\d+(?:\.\d+)?$/u.test(value))) valid = false;
      if (valid && cursor === source.length) return insert(pattern.target, captures);
    }
  }
  return insert(source, values);
}
