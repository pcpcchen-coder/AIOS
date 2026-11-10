import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 量測邏輯在 repo 根目錄的 scripts/（與 docs/23 架構盤點共用同一份），這裡用靜態 import：
// 找不到腳本時整個測試檔會載入失敗而變紅，不會悄悄跳過。
import { collectImportGraph, LAYERS, type ImportGraph } from "../../../scripts/architecture-metrics.mjs";

// 架構守門測試（docs/23 §3 的 S2）。只做靜態分析：讀這個原型的原始碼，不執行、不連網。
// 只守兩件事：跨層 import 與 import 環。它只證明這兩項沒有在不知情的情況下比 2026-11-09 的基準更差，
// 不是產品 gate，也不代表任何功能可用。
// 檔案大小刻意不守（George 2026-11-10 決定：專案仍在開發中，現在不限制 800 行；大檔之後與 docs/23 的 S6–S14 一起整理）。
// 量測腳本仍會「回報」超過 800 行的檔數，那只是資訊，不是限制。
// 量的是這個測試檔所在的原型目錄（tests/ 的上一層），所以複製到別處執行時量的也是那一份。
const shellDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/validation/architecture-guard-2026-11-10.md";

// ---- 允許清單：既有的 import 環（基準 3cc1401，共 4 組）----
// 「環」指 import 圖的強連通分量（兩個檔以上，type-only import 也算）。
// 規則：找到的每一個分量必須是下列某一組的子集合，所以分量可以變小、分裂或消失，不能長出清單外的檔。
// 分量內部多一條 import 不會被擋（分量的成員沒變）；詳見驗證紀錄的限制。
//
// 清單預設只刪不加：拆掉一組環或把檔移出環之後，在同一個 PR 刪掉對應項目。
// 有意識的例外（目前功能便利性優先，CLAUDE.md 2026-10-31）：功能 PR 若現在解環不合理，「可以」加一筆項目，
// 條件是：(1) 項目旁邊加一行註解寫原因；(2) 同時調高下方對應的上限常數；(3) 在 PR 說明提到這件事。
// 這個測試的目的是讓變差是「被看見、被決定的」，不是擋住功能。
const ALLOWED_CYCLES: readonly (readonly string[])[] = [
  ["shared/realtime-route.ts", "shared/seconds-menu.ts", "shared/types.ts", "shared/voice-cost.ts"],
  [
    "server/apikey-call.ts", "server/codex-auth.ts", "server/codex-responses.ts", "server/live-tool-caller.ts",
    "server/memory/live.ts", "server/proactive-calendar.ts", "server/realtime-routes.ts", "server/web-search.ts",
  ],
  ["server/memories-google.ts", "server/memories.ts"],
  ["src/api.ts", "src/realtime-session.ts", "src/realtime-tools.ts", "src/realtime.ts"],
];
const MAX_ALLOWED_CYCLES = 4; // 加一組環時一起調高（見上方「有意識的例外」）
const MAX_ALLOWED_CYCLE_FILES = 18; // 環內多一個檔時一起調高

// 兩條守門規則各自回傳違規清單（空陣列＝通過）。真實原始碼與下方的 fixture 反向測試共用同一組函式。
function crossLayerViolations(graph: ImportGraph): string[] {
  return [...graph.cross_layer_imports].sort();
}

function cycleViolations(graph: ImportGraph, allowed: readonly (readonly string[])[] = ALLOWED_CYCLES): string[] {
  return graph.import_cycles
    .filter((cycle) => !allowed.some((entry) => cycle.every((file) => entry.includes(file))))
    .map((cycle) => cycle.join(" <-> "));
}

// 失敗訊息：規則、該怎麼做、有意識的例外、文件位置。
const OVERRIDE =
  "有意識的例外：現在解環不合理時，可在 tests/architecture.test.ts 的允許清單加一筆（旁邊一行註解寫原因、調高上限常數、PR 說明提到）。" +
  " / Conscious override: if fixing it now is not reasonable, add an allowlist entry in tests/architecture.test.ts" +
  " (one-line reason comment, bump the cap constant, mention it in the PR description).";
const message = (rule: string, fix: string, override: string = OVERRIDE): string =>
  `\n[架構守門 / architecture guard] ${rule}\n該怎麼做 / What to do: ${fix}\n${override}\n說明 / Docs: ${DOC}\n`;

const CROSS_LAYER_MESSAGE = message(
  "跨層 import 必須是 0（允許：server→{server,shared}、src→{src,shared}、desktop→{desktop,shared}、shared→shared）。 / Cross-layer imports must be 0.",
  "把共用的型別或純函式移到 shared/，兩邊都從 shared/ import。 / Move the shared type or pure function into shared/ and import it from there.",
  "有意識的例外：這條規則目前沒有允許清單（基準是 0）。真的需要例外時，在同一個 PR 為這條規則加一份允許清單（每筆一行原因註解）、更新驗證紀錄，並在 PR 說明提到。" +
    " / Conscious override: this rule has no allowlist today (the baseline is 0). If an exception is really needed, add an allowlist for this rule in the same PR" +
    " (one-line reason per entry), update the validation record, and mention it in the PR description.",
);
const CYCLE_MESSAGE = message(
  "import 環（強連通分量）必須是允許清單某一組的子集合；下面列出的是新的環，或長出清單外檔案的環。 / Every import cycle (strongly connected component) must be a subset of one allowlisted entry; listed below are new or grown cycles.",
  "解開環：把共用型別移到 shared/ 或拆出不依賴對方的小模組，讓其中一個方向的 import 消失。 / Break the cycle: move the shared type into shared/ or split out a small module so that one direction of the import goes away.",
);
const CAP_MESSAGE = message(
  "環的允許清單比記錄的上限大：有人加了項目但沒有調高上限常數。 / The cycle allowlist is larger than its recorded cap: an entry was added without bumping the cap constant.",
  "先確認真的需要加項目（優先把型別移到 shared/、解開環）；確定要加時，照下面的例外規則一起調高上限。 / First check the entry is really needed (prefer moving the type into shared/ or breaking the cycle); if it is, bump the cap as described below.",
);

describe("架構守門：真實原始碼（靜態分析，不是產品 gate）", () => {
  let graph: ImportGraph;
  beforeAll(() => {
    graph = collectImportGraph(shellDir);
  });

  it("量到的是完整的四層原始碼，不是空目錄", () => {
    // 防止路徑算錯時「什麼都沒量到所以全部通過」。
    const empty = `\n[架構守門 / architecture guard] 沒有量到完整的四層原始碼（${shellDir}），其他規則會空轉通過。 / The four source layers were not all measured, so the other rules would pass vacuously.\n說明 / Docs: ${DOC}\n`;
    expect(Object.keys(graph.by_layer).sort(), empty).toEqual([...LAYERS].sort());
    expect(graph.source_files, empty).toBeGreaterThan(200);
  });

  it("跨層 import 為 0（server→{server,shared}、src→{src,shared}、desktop→{desktop,shared}、shared→shared）", () => {
    expect(crossLayerViolations(graph), CROSS_LAYER_MESSAGE).toEqual([]);
  });

  it("每個 import 環（強連通分量）都是允許清單某一組的子集合", () => {
    expect(cycleViolations(graph), CYCLE_MESSAGE).toEqual([]);
  });

  it("環的允許清單沒有超過記錄的上限（加項目時要一起調高上限，讓這件事被看見）", () => {
    expect(ALLOWED_CYCLES.length, CAP_MESSAGE).toBeLessThanOrEqual(MAX_ALLOWED_CYCLES);
    expect(ALLOWED_CYCLES.flat().length, CAP_MESSAGE).toBeLessThanOrEqual(MAX_ALLOWED_CYCLE_FILES);
  });
});

// ---- 反向自我測試（fixture）----
// 以下全部是測試用的假目錄（fixture），建在系統暫存目錄，與產品原始碼無關；
// 目的只有一個：證明上面的守門規則「真的會失敗」，不是永遠通過。
describe("架構守門：反向自我測試（fixture 假目錄）", () => {
  let fixtureDir = "";
  let graph: ImportGraph;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "nous-arch-guard-fixture-"));
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
    // 對照組：合法方向的 import、被排除的 .d.ts 與 *.test.ts 都不應該被報。
    write("desktop/ok.mjs", 'import { a } from "../shared/a.ts";\nexport const ok = a;\n');
    write("shared/ignored.d.ts", 'import "../server/bad.ts";\n');
    write("shared/ignored.test.ts", 'import "../server/bad.ts";\n');
    graph = collectImportGraph(fixtureDir);
  });
  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("fixture：量測腳本回報跨層 import 與環", () => {
    expect(graph.source_files).toBe(5);
    expect(graph.cross_layer_imports).toEqual(["server/bad.ts -> src/page.ts"]);
    expect(graph.import_cycles).toEqual([["shared/a.ts", "shared/b.ts"]]);
  });

  it("fixture：兩條守門規則都會判定違規", () => {
    expect(crossLayerViolations(graph)).toEqual(["server/bad.ts -> src/page.ts"]);
    expect(cycleViolations(graph)).toEqual(["shared/a.ts <-> shared/b.ts"]);
  });

  it("fixture：環只能是允許項目的子集合，長出清單外的檔就算違規", () => {
    // 環本身在允許清單內：通過。
    expect(cycleViolations(graph, [["shared/a.ts", "shared/b.ts", "shared/c.ts"]])).toEqual([]);
    // 允許清單只列了其中一個檔（等於環長出了一個清單外的檔）：違規。
    expect(cycleViolations(graph, [["shared/a.ts", "shared/c.ts"]])).toEqual(["shared/a.ts <-> shared/b.ts"]);
  });
});
