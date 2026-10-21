import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
