#!/usr/bin/env node
// 架構盤點用的量測腳本（唯讀）：算出 docs/23_Architecture_Review_2026-11.md 與 docs/validation/architecture-review-2026-11-09.md
// 引用的數字。只讀 prototype/ambient-shell 的原始碼與測試，不執行任何程式、不連網、不寫檔。
// 用法：node scripts/architecture-metrics.mjs [--json]
//
// Read-only metrics for the architecture review. Computes every number quoted in
// docs/23_Architecture_Review_2026-11.md and docs/validation/architecture-review-2026-11-09.md
// from prototype/ambient-shell sources and tests. Runs nothing, fetches nothing, writes nothing.
// Usage: node scripts/architecture-metrics.mjs [--json]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = join(repo, "prototype", "ambient-shell");
const layers = ["server", "shared", "src", "desktop"];

// ---- 來源檔清單（排除 .d.ts、測試、node_modules、dist）----
const files = [];
function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "dist" && !(d.endsWith("desktop") && n === "scripts")) walk(p); continue; }
    if (/\.(ts|mts|mjs|cjs)$/.test(n) && !/\.d\.(ts|mts)$/.test(n) && !n.endsWith(".test.ts")) files.push(p);
  }
}
for (const l of layers) walk(join(shell, l));
const rel = (p) => relative(shell, p).split("\\").join("/");
const known = new Set(files.map(rel));
const text = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")]));
const loc = new Map([...text].map(([f, t]) => [f, t.split("\n").length]));

// ---- import 圖（只看相對路徑）----
const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const edges = new Map();
for (const [f, t] of text) {
  const out = new Set();
  for (const m of t.matchAll(importRe)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith(".")) continue;
    const base = relative(shell, resolve(join(shell, dirname(f)), spec.replace(/\?.*$/, ""))).split("\\").join("/");
    const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
    const hit = candidates.find((c) => known.has(c));
    if (hit) out.add(hit);
  }
  edges.set(f, out);
}
const fanIn = new Map();
for (const outs of edges.values()) for (const o of outs) fanIn.set(o, (fanIn.get(o) ?? 0) + 1);
const layerOf = (f) => f.split("/")[0];
const allowed = { server: ["server", "shared"], shared: ["shared"], src: ["src", "shared"], desktop: ["desktop", "shared"] };
const crossLayer = [];
for (const [f, outs] of edges) for (const o of outs) if (!allowed[layerOf(f)].includes(layerOf(o))) crossLayer.push(`${f} -> ${o}`);

// Tarjan：找出 import 環（含 type-only import；型別環在執行期無害，但顯示分層不清）。
let counter = 0; const index = new Map(), low = new Map(), onStack = new Set(), stack = [], cycles = [];
function strong(v) {
  index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v);
  for (const w of edges.get(v) ?? []) {
    if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) { const comp = []; let w; do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v); if (comp.length > 1) cycles.push(comp.sort()); }
}
for (const f of edges.keys()) if (!index.has(f)) strong(f);

// ---- 分層規模 ----
const byLayer = {};
for (const [f, n] of loc) { const l = layerOf(f); byLayer[l] ??= { files: 0, loc: 0 }; byLayer[l].files++; byLayer[l].loc += n; }
const totalLoc = [...loc.values()].reduce((a, b) => a + b, 0);
const over800 = [...loc].filter(([, n]) => n > 800).sort((a, b) => b[1] - a[1]);

// ---- HTTP 路由：app.ts 的 handleApi 以 path 比對；voice-relay 以 switch case ----
const appTs = text.get("server/app.ts");
const apiRoutes = (appTs.match(/path === "\/api\/[^"]+"|path\.startsWith\("\/api\/[^"]+"\)|path\.match\(\/\^\\\/api[^)]*\)|path === "\/help\/commands"/g) ?? []).length;
const relayRoutes = text.get("server/integrations/voice-relay/routes.ts");
const relayCases = (relayRoutes.match(/case "[a-z-]+":/g) ?? []).length;

// ---- 設定檔寫入方式：各自 tmp+rename vs 走 prefs-file.ts ----
const ownRename = [...text].filter(([f, t]) => layerOf(f) === "server" && /renameSync/.test(t)).map(([f]) => f).sort();
const prefsFileUsers = [...text].filter(([f, t]) => layerOf(f) === "server" && /from "\.{1,2}\/prefs-file\.ts"/.test(t)).map(([f]) => f).sort();

// ---- app.ts 重複片段 ----
const localizeLine = (appTs.match(/localizeSettings\(settings\.view\(pageSource/g) ?? []).length;
const saveError = (appTs.match(/沒有保存（無法寫入設定檔/g) ?? []).length;

// ---- 兩條即時語音頁面類別同名的 private 方法 ----
const methodNames = (t) => new Set([...t.matchAll(/^\s+private\s+(?:async\s+)?([A-Za-z_]+)\(/gm)].map((m) => m[1]));
const rt = methodNames(text.get("src/realtime.ts")), lv = methodNames(text.get("src/live-voice.ts"));
const sharedMethods = [...rt].filter((n) => lv.has(n)).sort();

// ---- 測試分類（依序取第一個符合的類別）----
const testsDir = join(shell, "tests");
const testFiles = readdirSync(testsDir).filter((n) => n.endsWith(".test.ts")).sort();
const classes = { desktop: 0, server_http: 0, page_dom: 0, fixture: 0, pure: 0 };
const classOf = (t) => {
  if (/\.\.\/desktop\//.test(t)) return "desktop";
  if (/server\/app\.ts|node:http"/.test(t)) return "server_http";
  if (/globalThis\.document|document\.createElement|HTMLElement|createElement|readFileSync\([^)]*(src|index\.html|history\.html|style\.css)/.test(t)) return "page_dom";
  if (/\.\/fixtures\/|\.\/fixtures\.ts/.test(t)) return "fixture";
  return "pure";
};
for (const n of testFiles) classes[classOf(readFileSync(join(testsDir, n), "utf8"))]++;
const jsdom = /jsdom|happy-dom/.test(readFileSync(join(shell, "package.json"), "utf8"));
// 沒有任何測試（含 fixtures）直接 import 的來源模組
const imported = new Set();
const testSources = [...testFiles.map((n) => join(testsDir, n)), join(testsDir, "fixtures.ts"), ...readdirSync(join(testsDir, "fixtures")).filter((n) => n.endsWith(".ts")).map((n) => join(testsDir, "fixtures", n))];
for (const p of testSources) for (const m of readFileSync(p, "utf8").matchAll(importRe)) {
  const spec = m[1] ?? m[2] ?? m[3]; if (!spec?.startsWith(".")) continue;
  const base = relative(shell, resolve(dirname(p), spec)).split("\\").join("/");
  for (const c of [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`]) if (known.has(c)) imported.add(c);
}
const untested = [...known].filter((f) => !imported.has(f) && !/\.(json)$/.test(f)).sort();

const result = {
  measured_at: new Date().toISOString().slice(0, 10),
  source_files: files.length, total_loc: totalLoc, by_layer: byLayer,
  files_over_800_lines: over800,
  top_fan_out: [...edges].map(([f, o]) => [f, o.size]).sort((a, b) => b[1] - a[1]).slice(0, 8),
  top_fan_in: [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 8),
  cross_layer_imports: crossLayer,
  import_cycles: cycles,
  http_routes: { app_ts_path_matches: apiRoutes, voice_relay_cases: relayCases, note: "app.ts 的比對數不等於路由數：一行可含多個動詞或子路徑；人工逐行點算為 85（見 docs/23 §1.4）。" },
  settings_writers: { own_tmp_rename_files: ownRename, prefs_file_users: prefsFileUsers },
  app_ts_repeats: { localize_settings_view_lines: localizeLine, same_save_error_message: saveError },
  realtime_page_duplicate_private_methods: sharedMethods,
  tests: { files: testFiles.length, classes, dom_environment_installed: jsdom, modules_without_direct_test_import: untested },
};
if (process.argv.includes("--json")) { console.log(JSON.stringify(result, null, 2)); }
else {
  console.log(`source files ${result.source_files}, LOC ${result.total_loc}`);
  for (const [l, v] of Object.entries(byLayer)) console.log(`  ${l}: ${v.files} files, ${v.loc} LOC`);
  console.log(`files > 800 lines: ${over800.length}`); for (const [f, n] of over800) console.log(`  ${n}\t${f}`);
  console.log(`cross-layer imports: ${crossLayer.length}`);
  console.log(`import cycles: ${cycles.length}`); for (const c of cycles) console.log(`  ${c.join(" <-> ")}`);
  console.log(`settings writers: own tmp+rename in ${ownRename.length} files; prefs-file.ts used by ${prefsFileUsers.length} files`);
  console.log(`app.ts repeats: localizeSettings(settings.view(...)) x${localizeLine}, same save error x${saveError}`);
  console.log(`realtime.ts / live-voice.ts same-named private methods: ${sharedMethods.length} (${sharedMethods.join(", ")})`);
  console.log(`tests: ${testFiles.length} files; ${JSON.stringify(classes)}; DOM env installed: ${jsdom}`);
  console.log(`modules without direct test import: ${untested.length}`); for (const f of untested) console.log(`  ${f}`);
}
