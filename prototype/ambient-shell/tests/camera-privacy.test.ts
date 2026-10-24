import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 鏡頭畫面只畫到本頁畫布：前端程式不得讀回像素、轉成檔案或網址、或錄下串流（CLAUDE.md：原始影像不得寫檔、進 trace 或外傳）。
const FORBIDDEN = /\b(getImageData|toDataURL|toBlob|captureStream|createObjectURL)\b/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("camera privacy (static)", () => {
  it("no pixel read-back, export or recording APIs anywhere under src/", () => {
    const root = join(import.meta.dirname, "..", "src");
    const sources = files(root);
    expect(sources.length).toBeGreaterThan(10);
    const hits = sources.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => (FORBIDDEN.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null),
    );
    expect(hits).toEqual([]);
  });
});

// ID-00 人臉 spike（spike/face/，docs/14、docs/adr/ADR-0001）：模型要吃像素，所以這裡明確允許 getImageData，
// 但只限 runtime.ts 一個檔案，讀出的像素只做成推論張量。其餘匯出、錄影、擷取、網路、遠端 import 與本機儲存 API 一律不准；
// 產品程式也不得引用 spike，主程式 build 不含 spike 頁。這不是對 src/ 放寬：上一個測試仍完整檢查 src/。
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
