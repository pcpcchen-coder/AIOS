import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 鏡頭畫面只畫到本頁畫布：前端程式不得讀回像素、轉成檔案或網址、或錄下串流（CLAUDE.md：原始影像不得寫檔、進 trace 或外傳）。
// 家人辨識（ID-01，ADR-0001）的兩個例外各限一個檔案：getImageData 只在推論 worker（sense/identity-worker.ts），
// createImageBitmap 只在感測管線的取樣出口（sense/pipeline.ts）。其餘匯出、錄影、擷取 API 在 src/ 全面禁止。
const FORBIDDEN = /\b(toDataURL|toBlob|captureStream|createObjectURL|MediaRecorder|ImageCapture|readPixels|convertToBlob|showSaveFilePicker)\b/;
const PIXEL_READ = /\bgetImageData\b/;
const PIXEL_READ_ALLOWED = new Set([join("sense", "identity-worker.ts")]);
const BITMAP = /\bcreateImageBitmap\b/;
const BITMAP_ALLOWED = new Set([join("sense", "pipeline.ts")]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("camera privacy (static)", () => {
  it("no pixel read-back, export or recording APIs anywhere under src/ (pixel read only in the identity worker, bitmaps only in the pipeline)", () => {
    const root = join(import.meta.dirname, "..", "src");
    const sources = files(root);
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map((f) => relative(root, f))).toEqual(expect.arrayContaining([...PIXEL_READ_ALLOWED, ...BITMAP_ALLOWED]));
    const hits = sources.flatMap((file) => {
      const name = relative(root, file);
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => {
          const bad = FORBIDDEN.test(line) || (PIXEL_READ.test(line) && !PIXEL_READ_ALLOWED.has(name)) || (BITMAP.test(line) && !BITMAP_ALLOWED.has(name));
          return bad ? `${name}:${i + 1}: ${line.trim()}` : null;
        })
        .filter((hit): hit is string => hit !== null);
    });
    expect(hits).toEqual([]);
  });

  it("flags the src/ patterns it is meant to catch", () => {
    for (const line of ["new MediaRecorder(s)", "new ImageCapture(t)", "gl.readPixels(0,0,1,1)", "c.convertToBlob()", "showSaveFilePicker()", "c.toDataURL()"]) expect(FORBIDDEN.test(line), line).toBe(true);
    expect(PIXEL_READ.test("ctx.getImageData(0, 0, 1, 1)")).toBe(true);
    expect(BITMAP.test("await createImageBitmap(c)")).toBe(true);
  });
});

// ID-00 人臉 spike（spike/face/，docs/14、docs/adr/ADR-0001）：模型要吃像素，所以這裡明確允許 getImageData，
// 但只限 runtime.ts 一個檔案，讀出的像素只做成推論張量。其餘匯出、錄影、擷取、網路、遠端 import 與本機儲存 API 一律不准；
// 產品程式也不得引用 spike，主程式 build 不含 spike 頁。src/ 另有自己的檢查（上一段）：ID-01 起 src/ 也有兩個單檔例外
// （identity-worker.ts 讀像素、pipeline.ts 建 ImageBitmap），其餘照舊全面禁止。
const SPIKE_PIXEL_READ_ALLOWED = new Set(["runtime.ts"]);
const SPIKE_FORBIDDEN = new RegExp(
  [
    // 匯出、錄影與擷取
    String.raw`\b(toDataURL|toBlob|convertToBlob|captureStream|createObjectURL|MediaRecorder|ImageCapture|readPixels|showSaveFilePicker)\b`,
    // 網路
    String.raw`\b(fetch|XMLHttpRequest|WebSocket|WebTransport|EventSource|sendBeacon|RTCPeerConnection)\b`,
    // 本機儲存
    String.raw`\b(localStorage|sessionStorage|indexedDB|caches)\b`,
    // 動態 import 遠端網址（含 //host 形式）
    String.raw`\bimport\s*\(\s*["'\x60](https?:)?\/\/`,
    String.raw`\/api\/`,
  ].join("|"),
);

/** 產品程式引用 spike 的任何形式：靜態、副作用、動態 import 與 require。 */
const IMPORTS_SPIKE = /(\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`][^"'`]*\bspike\//;

/** 產品程式碼（含 desktop 的 .cjs），略過安裝與建置產物。 */
function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "web", "dist"].includes(entry.name) ? [] : productFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|mts)$/.test(entry.name) ? [path] : [];
  });
}

function spikeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "public" || entry.name === "dist" ? [] : spikeFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name) ? [path] : [];
  });
}

describe("face spike privacy boundary (static)", () => {
  const spikeRoot = join(import.meta.dirname, "..", "spike", "face");
  const spikeSources = spikeFiles(spikeRoot);

  it("reads pixels only in runtime.ts and never exports, records, uploads or stores them", () => {
    expect(spikeSources.map((f) => relative(spikeRoot, f))).toEqual(expect.arrayContaining(["runtime.ts", "page.ts", "index.html", join("tools", "opencv-crosscheck.ts")]));
    const hits = spikeSources.flatMap((file) => {
      const name = relative(spikeRoot, file);
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => {
          const pixelRead = /\bgetImageData\b/.test(line) && !SPIKE_PIXEL_READ_ALLOWED.has(name);
          return pixelRead || SPIKE_FORBIDDEN.test(line) ? `${name}:${i + 1}: ${line.trim()}` : null;
        })
        .filter((hit): hit is string => hit !== null);
    });
    expect(hits).toEqual([]);
  });

  it("flags the forbidden patterns it is meant to catch", () => {
    const samples = [
      "canvas.convertToBlob()",
      "new MediaRecorder(stream)",
      "new ImageCapture(track)",
      "gl.readPixels(0, 0, 1, 1)",
      "await showSaveFilePicker()",
      "new WebTransport(url)",
      'await import("https://cdn.example/x.js")',
      "await import('//cdn.example/x.js')",
    ];
    expect(samples.filter((line) => !SPIKE_FORBIDDEN.test(line))).toEqual([]);
    expect(SPIKE_FORBIDDEN.test('await import("@mediapipe/tasks-vision")')).toBe(false);
  });

  it("restricts the spike page to same-origin connections via CSP", () => {
    const html = readFileSync(join(spikeRoot, "index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toMatch(/(^|; )connect-src 'self' ws:\/\/127\.0\.0\.1:5180(;|$)/);
  });

  it("is not wired into the product: no product module imports it and the main build has no spike entry", () => {
    const app = join(import.meta.dirname, "..");
    const product = ["src", "server", "shared", "desktop"].flatMap((d) => productFiles(join(app, d)));
    expect(product).toEqual(expect.arrayContaining([join(app, "desktop", "main.mjs"), join(app, "desktop", "preload.cjs")]));
    const imports = product.filter((file) => IMPORTS_SPIKE.test(readFileSync(file, "utf8")));
    expect(imports).toEqual([]);
    for (const sample of ['import "../spike/face/page.ts";', 'await import("../../spike/face/runtime.ts")', 'import x from "./spike/face/yunet.ts"', 'require("../spike/face/x.cjs")'])
      expect(IMPORTS_SPIKE.test(sample)).toBe(true);
    expect(readFileSync(join(app, "index.html"), "utf8")).not.toMatch(/spike/);
    expect(readFileSync(join(app, "vite.config.ts"), "utf8")).not.toMatch(/spike/);
  });
});

// 家人辨識（ID-01）：推論 worker 與取樣、品質、前後處理模組不得使用網路 API、匯出／存檔 API（showSaveFilePicker 等）、
// 本機儲存或 /api（以字面掃描，間接呼叫抓不到）；身分資料不走 HTTP；身分相關檔案的 log／console 呼叫不帶特徵、姓名或
// person_id 等識別字（同樣是字面掃描，執行期另以 log spy 檢查）；模型與 onnxruntime wasm 不進 dist／public。
const IDENTITY_RENDERER = [join("sense", "identity-worker.ts"), join("sense", "identity-client.ts"), join("sense", "identity-ambient.ts"), join("sense", "identity-protocol.ts"), join("sense", "face", "yunet.ts"), join("sense", "face", "sface.ts"), join("sense", "face", "quality.ts")];

describe("family recognition privacy boundary (static)", () => {
  const app = join(import.meta.dirname, "..");
  const src = join(app, "src");

  it("the identity worker and its helpers never use the network, storage, files or /api", () => {
    const hits = IDENTITY_RENDERER.flatMap((name) =>
      readFileSync(join(src, name), "utf8")
        .split("\n")
        .map((line, i) => (SPIKE_FORBIDDEN.test(line) ? `${name}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null),
    );
    expect(hits).toEqual([]);
    // 模型與 wasm 只從同源 /face-runtime/ 讀（不是遠端網址）
    const manifest = JSON.parse(readFileSync(join(app, "shared", "face-runtime.json"), "utf8"));
    expect(manifest.url_prefix).toBe("/face-runtime/");
  });

  it("the worker posts back only counts, quality, a feature and timing — never pixels, boxes or landmarks", () => {
    const worker = readFileSync(join(src, "sense", "identity-worker.ts"), "utf8");
    const posts = [...worker.matchAll(/postMessage\(([^;]+)\);/g)].map((m) => m[1]!);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p).not.toMatch(/rgba|pixels|bitmap|box|landmarks|faces\b/);
    expect(worker).toMatch(/const message: WorkerResponse = \{ type: "result", gen, face_count: faces\.length, quality: quality\.reason, ms: [^}]+, \.\.\.\(feature \? \{ feature \} : \{\}\) \};/);
  });

  it("identity data does not go over HTTP: server/app.ts has no identity route and only reads the status", () => {
    const appTs = readFileSync(join(app, "server", "app.ts"), "utf8");
    expect(appTs).not.toMatch(/["'`]\/api\/[^"'`]*(identity|family|face|person)/i);
    expect(appTs).not.toMatch(/person_id|\.handle\(|enroll|probe|gallery/);
    expect([...appTs.matchAll(/options\.identity\b[^\n]*/g)].map((m) => m[0])).toEqual(["options.identity?.status() ?? BROWSER_IDENTITY_STATUS,"]);
    // 頁面端也不經 HTTP 送身分資料：只用 window.nousDesktop.identity（IPC）
    for (const name of ["family-view.ts", join("sense", "identity-client.ts"), join("sense", "identity-ambient.ts"), "main.ts"]) {
      const text = readFileSync(join(src, name), "utf8");
      expect(text, name).not.toMatch(/api\.\w*(identity|family|enroll|probe)/i);
    }
  });

  it("ID-02：names are composed only in the core — the page never builds a named sentence (except the enrollment preview of the user's own typed name)", () => {
    const pageFiles = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const composing = pageFiles.filter((f) => /\b(greetingSentence|speakableName|liveGreetingText|greetingInstructions)\(/.test(readFileSync(join(src, f), "utf8")));
    // family-view.ts 只在登記畫面預覽使用者自己打的名稱會怎麼念（namePreview），不送出、不讀 gallery。
    expect(composing).toEqual(["family-view.ts"]);
    const view = readFileSync(join(src, "family-view.ts"), "utf8");
    const uses = [...view.matchAll(/\b(greetingSentence|speakableName)\(/g)].length;
    const preview = view.slice(view.indexOf("export function namePreview("), view.indexOf("/** 核心給的觀測"));
    expect([...preview.matchAll(/\b(greetingSentence|speakableName)\(/g)].length).toBe(uses);
    const liveRoute = readFileSync(join(app, "server", "live-route.ts"), "utf8");
    expect(liveRoute).not.toMatch(/person_id|speakableName/);
  });

  it("logs and console output in identity code never include names, person ids, features or scores", () => {
    const files = [join(app, "server", "identity-service.ts"), join(app, "server", "identity-store.ts"), join(app, "server", "face-runtime.ts"), join(src, "family-view.ts"), join(src, "family-enroll.ts"), ...IDENTITY_RENDERER.map((n) => join(src, n))];
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\b(log|console\.\w+)\(/.test(line) && /\b(name|person_id|feature|features|score|scores|samples|people)\b/.test(line))
        .map(({ line, i }) => `${relative(app, file)}:${i + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
    expect(readFileSync(join(src, "family-view.ts"), "utf8")).not.toMatch(/console\./);
  });

  it("models and the onnxruntime wasm are not bundled: no .onnx anywhere in dist or public, and vite uses the external-wasm build", () => {
    const vite = readFileSync(join(app, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/conditions: \["onnxruntime-web-use-extern-wasm"/);
    const walk = (dir: string): string[] =>
      existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [];
    const shipped = [...walk(join(app, "dist")), ...walk(join(app, "public"))];
    expect(shipped.filter((f) => /\.onnx$|ort-wasm/.test(f))).toEqual([]);
    const build = readFileSync(join(app, "desktop", "scripts", "build.mjs"), "utf8");
    expect(build).not.toMatch(/face-runtime["'`]\)|\.onnx/);
  });
});
