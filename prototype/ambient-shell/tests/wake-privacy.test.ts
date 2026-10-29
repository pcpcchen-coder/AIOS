import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// WK-00 喚醒詞 spike（spike/wake/，docs/17 §5.2、§13.4）：未喚醒音訊只在記憶體。
// 靜態掃描：spike/wake 不得錄音或匯出音訊（MediaRecorder、blob、存檔 API、sherpa-onnx 的 writeWave）、不得連網、
// 不得用瀏覽器儲存；寫檔只限 report.ts（只寫經過音訊檢查的 JSON）。產品程式不得引用 spike，主程式 build 不含 wake 模型或 wasm。
// 這是字面掃描：間接呼叫抓不到，執行期另由 report.ts 的 findAudioLike 與 AudioRing.toJSON 擋住。

const app = join(import.meta.dirname, "..");
const spikeRoot = join(app, "spike", "wake");

const FORBIDDEN = new RegExp(
  [
    // 錄音、匯出與存檔
    String.raw`\b(MediaRecorder|createObjectURL|toBlob|convertToBlob|showSaveFilePicker|writeWave|captureStream)\b`,
    String.raw`new\s+(Blob|File)\s*\(`,
    // 寫檔與檔案描述子（report.ts 例外，另行檢查）
    String.raw`\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|writeSync|openSync|rename|renameSync|writev|writevSync)\b`,
    String.raw`\.open\(`,
    // 寫到標準輸出（音訊可能經管線流出）；偵測行改用 console.log 的 JSON.stringify(event)
    String.raw`\bstdout\.write\b`,
    // 另開程序（bench.ts 的 fork 是唯一白名單，另行檢查）
    String.raw`\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(`,
    String.raw`\bchild_process\b`,
    // 網路（含不帶 node: 前綴的 import／require）
    String.raw`\b(fetch|XMLHttpRequest|WebSocket|WebTransport|EventSource|sendBeacon|RTCPeerConnection)\b`,
    String.raw`["'\x60](node:)?(http|https|http2|net|dgram|tls)["'\x60]`,
    // 把樣本陣列印出（console.* 的參數裡出現 samples／pcm／ring 等）
    String.raw`\bconsole\.\w+\([^)]*\b(samples|pcm|chunk|bytes|ring|tail|wav)\b`,
    // 瀏覽器儲存
    String.raw`\b(localStorage|sessionStorage|indexedDB|caches)\b`,
    // 遠端 import 與核心 API
    String.raw`\bimport\s*\(\s*["'\x60](https?:)?\/\/`,
    String.raw`\/api\/`,
  ].join("|"),
);
const WRITE_ALLOWED = new Set(["report.ts"]);
const WRITE = /\b(writeFileSync|mkdirSync)\b/g;
/** bench.ts 只允許從 node:child_process 匯入 fork，並以 fork 開子程序（IPC 傳記憶體中的合成音訊，不經檔案）。 */
const FORK_ALLOWED = new Set(["bench.ts"]);
const FORK_LINES = [/^import \{ fork \} from "node:child_process";$/, /^\s*const child = fork\(/];

function spikeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["models", "public", "dist", "results"].includes(entry.name) ? [] : spikeFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name) ? [path] : [];
  });
}

function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "web", "dist"].includes(entry.name) ? [] : productFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|mts)$/.test(entry.name) ? [path] : [];
  });
}

describe("wake spike privacy boundary (static)", () => {
  const sources = spikeFiles(spikeRoot);

  it("never records, exports, uploads or stores audio; only report.ts writes files", () => {
    expect(sources.map((f) => relative(spikeRoot, f))).toEqual(
      expect.arrayContaining(["cli.ts", "bench.ts", "engines.ts", "ring-buffer.ts", "report.ts", "page.ts", "capture-worklet.ts", "index.html"]),
    );
    const hits = sources.flatMap((file) => {
      const name = relative(spikeRoot, file);
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => {
          if (/^\s*(\/\/|\*|<!--)/.test(line)) return null;
          if (FORK_ALLOWED.has(name) && FORK_LINES.some((re) => re.test(line))) return null;
          const bad = WRITE_ALLOWED.has(name) ? FORBIDDEN.test(line.replace(WRITE, "")) : FORBIDDEN.test(line);
          return bad ? `${name}:${i + 1}: ${line.trim()}` : null;
        })
        .filter((hit): hit is string => hit !== null);
    });
    expect(hits).toEqual([]);
  });

  it("report.ts writes only JSON that passed the audio check", () => {
    const report = readFileSync(join(spikeRoot, "report.ts"), "utf8");
    const writes = [...report.matchAll(/writeFileSync\(([^;]+)\);/g)].map((m) => m[1]!);
    expect(writes).toEqual(['file, JSON.stringify(report, null, 2) + "\\n", "utf8"']);
    const body = report.slice(report.indexOf("export function writeReport"));
    expect(body.indexOf("findAudioLike(report)")).toBeGreaterThan(0);
    expect(body.indexOf("findAudioLike(report)")).toBeLessThan(body.indexOf("writeFileSync"));
  });

  it("flags the patterns it is meant to catch", () => {
    const samples = [
      "new MediaRecorder(stream)",
      "URL.createObjectURL(b)",
      "new Blob([pcm])",
      "sherpa.writeWave('x.wav', w)",
      "writeFileSync('a.pcm', buf)",
      "createWriteStream(path)",
      "await fetch(url)",
      'import https from "node:https";',
      "localStorage.setItem('a', 'b')",
      'await import("https://cdn.example/x.js")',
      'import http from "http";',
      'const net = require("net");',
      'import { connect } from "tls";',
      "fs.writeSync(fd, buf)",
      "const fd = openSync(path, 'w')",
      "await fs.promises.open(path, 'w')",
      "renameSync(a, b)",
      "await rename(a, b)",
      "process.stdout.write(Buffer.from(pcm.buffer))",
      "spawn('sox', args)",
      "exec('rec x.wav')",
      "execFile('ffmpeg', args)",
      "execSync('sox -d x.wav')",
      'import { spawn } from "node:child_process";',
      "console.log(samples)",
      "console.log(JSON.stringify([...pcm]))",
      "console.error(ring.latest())",
    ];
    expect(samples.filter((line) => !FORBIDDEN.test(line))).toEqual([]);
    // 白名單只放行 bench.ts 這兩行的確切寫法
    expect(FORK_LINES[0]!.test('import { fork } from "node:child_process";')).toBe(true);
    expect(FORK_LINES.some((re) => re.test('import { fork, spawn } from "node:child_process";'))).toBe(false);
    expect(FORBIDDEN.test("console.log(JSON.stringify(event));")).toBe(false);
  });

  it("the ring buffer is not serializable and the CLI/page clear it", () => {
    expect(readFileSync(join(spikeRoot, "ring-buffer.ts"), "utf8")).toMatch(/toJSON\(\): never \{\s*throw/);
    expect(readFileSync(join(spikeRoot, "cli.ts"), "utf8")).toMatch(/ring\.clear\(\)/);
    expect(readFileSync(join(spikeRoot, "page.ts"), "utf8")).toMatch(/s\.ring\.clear\(\)/);
  });

  it("restricts the spike page to same-origin connections via CSP", () => {
    const html = readFileSync(join(spikeRoot, "index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toMatch(/(^|; )connect-src 'self' ws:\/\/127\.0\.0\.1:5182(;|$)/);
    expect(readFileSync(join(spikeRoot, "vite.config.ts"), "utf8")).toMatch(/host: "127\.0\.0\.1", port: 5182/);
  });

  it("is not wired into the product: no product module, page or build config refers to the spike or sherpa-onnx", () => {
    const product = ["src", "server", "shared", "desktop"].flatMap((d) => productFiles(join(app, d)));
    const IMPORTS = /(\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`][^"'`]*(\bspike\/|sherpa-onnx)/;
    expect(product.filter((file) => IMPORTS.test(readFileSync(file, "utf8")))).toEqual([]);
    expect(readFileSync(join(app, "index.html"), "utf8")).not.toMatch(/spike|sherpa/);
    expect(readFileSync(join(app, "vite.config.ts"), "utf8")).not.toMatch(/spike|sherpa/);
    // App 內容（desktop/build/app）只由這個腳本組出：不得複製 spike、模型或 sherpa 檔
    expect(readFileSync(join(app, "desktop", "scripts", "build.mjs"), "utf8")).not.toMatch(/spike|sherpa|kws|\.onnx/);
  });

  // 建置產物：資料夾存在時逐檔檢查；不存在時這個測試顯示為 skipped（不會默默通過）。
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const rel of ["dist", "public", join("desktop", "build", "app")]) {
    const dir = join(app, rel);
    it.skipIf(!existsSync(dir))(`${rel}/ has no wake models, tokens or sherpa wasm`, () => {
      const files = walk(dir);
      expect(files.filter((f) => /\.onnx$|sherpa|kws|tokens\.txt$|wasm-nodejs/i.test(relative(dir, f)))).toEqual([]);
    });
  }

  it("sherpa-onnx is a pinned devDependency only, and 1.13.8 (bundles GPL espeak-ng) is not a dependency at all", () => {
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((k) => k.includes("sherpa"))).toEqual([]);
    expect(pkg.devDependencies["sherpa-onnx-node"]).toBe("2.0.1");
    expect(pkg.devDependencies["sherpa-onnx"]).toBe("2.0.1");
    expect(JSON.stringify(pkg)).not.toMatch(/1\.13\.8/);
    const gitignore = readFileSync(join(app, ".gitignore"), "utf8");
    for (const dir of ["spike/wake/models/", "spike/wake/public/", "spike/wake/results/", "spike/wake/dist/"]) expect(gitignore).toContain(dir);
  });
});
