import { writeFileSync } from "node:fs";
import { modelToolOutputs } from "../tests/fixtures/model-tools.ts";

// CAP-1：產生 tests/fixtures/model-tools.baseline.json（送給模型的工具 JSON）。只在「刻意改變模型看到的工具」時重跑，
// 並在 PR 說明這次改了什麼；只加總表欄位時不重跑（測試要證明輸出不變）。
writeFileSync(new URL("../tests/fixtures/model-tools.baseline.json", import.meta.url), `${JSON.stringify(modelToolOutputs(), null, 1)}\n`);
