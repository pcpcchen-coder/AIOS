import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// 量測邏輯在 repo 根目錄的 scripts/（與 docs/23 架構盤點共用同一份），這裡用靜態 import：
// 找不到腳本時整個測試檔會載入失敗而變紅，不會悄悄跳過。
import { collectImportGraph, LAYERS, LINE_LIMIT, type ImportGraph } from "../../../scripts/architecture-metrics.mjs";

// 架構守門測試（docs/23 §3 的 S2）。只做靜態分析：讀這個原型的原始碼，不執行、不連網。
// 它只證明「分層與規模沒有比 2026-11-09 的基準更差」，不是產品 gate，也不代表任何功能可用。
// 量的是這個測試檔所在的原型目錄（tests/ 的上一層），所以複製到別處執行時量的也是那一份。
const shellDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 允許清單一：既有的 import 環（基準 3cc1401，共 4 組）----
// 這份清單「只能刪、不能加」：拆掉一組環或把某個檔移出環之後，把對應項目刪掉；
// 不要為了讓新的環通過而加項目——請改掉新的環（通常是把共用型別移到 shared/ 或拆出小模組）。
// 規則：找到的每一組環必須是下列某一組的子集合，所以環可以變小、分裂或消失，但不能長大、不能出現新的。
const ALLOWED_CYCLES: readonly (readonly string[])[] = [
  ["shared/realtime-route.ts", "shared/seconds-menu.ts", "shared/types.ts", "shared/voice-cost.ts"],
  [
    "server/apikey-call.ts", "server/codex-auth.ts", "server/codex-responses.ts", "server/live-tool-caller.ts",
    "server/memory/live.ts", "server/proactive-calendar.ts", "server/realtime-routes.ts", "server/web-search.ts",
  ],
  ["server/memories-google.ts", "server/memories.ts"],
  ["src/api.ts", "src/realtime-session.ts", "src/realtime-tools.ts", "src/realtime.ts"],
];

// ---- 允許清單二：已經超過 800 行的檔（基準 3cc1401，共 16 個）----
// 這份清單也「只能刪、不能加」：新檔與目前 800 行以內的檔必須維持在 800 行以內。
// 刻意的選擇：只檢查「是否在清單內」，不限制清單內的檔再長多少。
// 理由：目前的優先順序是功能便利性（CLAUDE.md，2026-10-31）；一般功能仍會改到 src/main.ts、server/app.ts，
// 若再加逐檔行數上限，日常功能 PR 會在 CI 失敗，卻擋不住真正的問題。這些大檔的瘦身由 docs/23 的 S6–S14 處理。
// 已知的漏洞：清單內的檔降到 800 行以下後若沒有刪掉項目，之後又長回來不會被擋；拆檔的 PR 請順手刪項目。
// 行數的算法與量測腳本相同：text.split("\n").length（比 wc -l 多 1）。括號內是基準行數，只供對照，不參與判斷。
const ALLOWED_LARGE_FILES: readonly string[] = [
  "src/main.ts", // 4211
  "server/memory/service.ts", // 2613
  "src/views.ts", // 2028
  "server/identity-service.ts", // 1684
  "server/home-bridge.ts", // 1655
  "desktop/main.mjs", // 1523
  "server/app.ts", // 1369
  "server/memory/live.ts", // 1361
  "server/realtime-routes.ts", // 1275
  "src/family-view.ts", // 1259
  "src/realtime.ts", // 1080
  "server/store.ts", // 1029
  "src/live-voice.ts", // 884
  "src/brain.ts", // 873
  "src/memory-view.ts", // 836
  "server/live-route.ts", // 811
];

// 三條守門規則各自回傳違規清單（空陣列＝通過）。真實原始碼與下方的 fixture 反向測試共用同一組函式。
function crossLayerViolations(graph: ImportGraph): string[] {
  return [...graph.cross_layer_imports].sort();
}

function cycleViolations(graph: ImportGraph, allowed: readonly (readonly string[])[] = ALLOWED_CYCLES): string[] {
  return graph.import_cycles
    .filter((cycle) => !allowed.some((entry) => cycle.every((file) => entry.includes(file))))
    .map((cycle) => cycle.join(" <-> "));
}

function largeFileViolations(graph: ImportGraph, allowed: readonly string[] = ALLOWED_LARGE_FILES): string[] {
  return graph.files_over_800_lines.filter(([file]) => !allowed.includes(file)).map(([file, lines]) => `${file} (${lines})`);
}

describe("架構守門：真實原始碼（靜態分析，不是產品 gate）", () => {
  const graph = collectImportGraph(shellDir);

  it("量到的是完整的四層原始碼，不是空目錄", () => {
    // 防止路徑算錯時「什麼都沒量到所以全部通過」。
    expect(Object.keys(graph.by_layer).sort()).toEqual([...LAYERS].sort());
    expect(graph.source_files).toBeGreaterThan(200);
    expect(LINE_LIMIT).toBe(800);
  });

  it("跨層 import 為 0（server→{server,shared}、src→{src,shared}、desktop→{desktop,shared}、shared→shared）", () => {
    expect(crossLayerViolations(graph)).toEqual([]);
  });

  it("沒有新的 import 環，既有的環也沒有長大", () => {
    expect(cycleViolations(graph)).toEqual([]);
  });

  it("超過 800 行的檔都在允許清單內（新檔與其他檔須維持在 800 行以內）", () => {
    expect(largeFileViolations(graph)).toEqual([]);
  });

  it("允許清單沒有超出基準的組數與檔數", () => {
    // 清單只能縮小：有人往清單加項目時，這裡會先失敗，提醒回頭看上面的註解。
    expect(ALLOWED_CYCLES.length).toBeLessThanOrEqual(4);
    expect(ALLOWED_CYCLES.flat().length).toBeLessThanOrEqual(18);
    expect(ALLOWED_LARGE_FILES.length).toBeLessThanOrEqual(16);
    expect(new Set(ALLOWED_LARGE_FILES).size).toBe(ALLOWED_LARGE_FILES.length);
  });
});

// ---- 反向自我測試（fixture）----
// 以下全部是測試用的假目錄（fixture），建在系統暫存目錄，與產品原始碼無關；
// 目的只有一個：證明上面的守門規則「真的會失敗」，不是永遠通過。
describe("架構守門：反向自我測試（fixture 假目錄）", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "nous-arch-guard-fixture-"));
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const write = (file: string, content: string): void => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), content);
  };
  // 違規一：server 直接 import 頁面層（跨層）。
  write("server/bad.ts", 'import { page } from "../src/page.ts";\nexport const bad = page;\n');
  write("src/page.ts", 'import type { Shape } from "../shared/a.ts";\nexport const page: Shape = { n: 1 };\n');
  // 違規二：shared 內兩個檔互相 import（環；其中一邊是 type-only，量測同樣算）。
  write("shared/a.ts", 'import { b } from "./b.ts";\nexport interface Shape { n: number }\nexport const a = b;\n');
  write("shared/b.ts", 'import type { Shape } from "./a.ts";\nexport const b: Shape = { n: 2 };\n');
  // 違規三：不在允許清單內、超過 800 行的檔（801 行）。
  write("src/huge.ts", `${"// fixture\n".repeat(LINE_LIMIT)}export const huge = 1;`);
  // 對照組：剛好 800 行的檔、合法方向的 import、被排除的 .d.ts 與 *.test.ts 都不應該被報。
  write("src/exact.ts", `${"// fixture\n".repeat(LINE_LIMIT - 1)}export const exact = 1;`);
  write("desktop/ok.mjs", 'import { a } from "../shared/a.ts";\nexport const ok = a;\n');
  write("shared/ignored.d.ts", 'import "../server/bad.ts";\n');
  write("shared/ignored.test.ts", 'import "../server/bad.ts";\n');

  const graph = collectImportGraph(fixtureDir);

  it("fixture：量測腳本回報跨層 import、環與大檔", () => {
    expect(graph.source_files).toBe(7);
    expect(graph.cross_layer_imports).toEqual(["server/bad.ts -> src/page.ts"]);
    expect(graph.import_cycles).toEqual([["shared/a.ts", "shared/b.ts"]]);
    expect(graph.files_over_800_lines).toEqual([["src/huge.ts", LINE_LIMIT + 1]]);
  });

  it("fixture：三條守門規則都會判定違規", () => {
    expect(crossLayerViolations(graph)).toEqual(["server/bad.ts -> src/page.ts"]);
    expect(cycleViolations(graph)).toEqual(["shared/a.ts <-> shared/b.ts"]);
    expect(largeFileViolations(graph)).toEqual([`src/huge.ts (${LINE_LIMIT + 1})`]);
  });

  it("fixture：環只能是允許項目的子集合，長大就算違規", () => {
    // 環本身在允許清單內：通過。
    expect(cycleViolations(graph, [["shared/a.ts", "shared/b.ts", "shared/c.ts"]])).toEqual([]);
    // 允許清單只列了其中一個檔（等於環長大了一個檔）：違規。
    expect(cycleViolations(graph, [["shared/a.ts", "shared/c.ts"]])).toEqual(["shared/a.ts <-> shared/b.ts"]);
    // 大檔在允許清單內：通過。
    expect(largeFileViolations(graph, ["src/huge.ts"])).toEqual([]);
  });
});
