import { writeFileSync } from "node:fs";
import { commandsPageOutputs } from "../tests/fixtures/commands-page.ts";
import { modelToolOutputs } from "../tests/fixtures/model-tools.ts";

// CAP-1：產生 tests/fixtures/model-tools.baseline.json（送給模型的工具 JSON）與 commands-page.baseline.json（/help/commands）。
// 只在「刻意改變模型看到的工具或指令頁」時重跑，並在 PR 說明這次改了什麼；只改總表時不重跑（測試要證明輸出不變）。
const write = (name: string, value: Record<string, string>) => writeFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), `${JSON.stringify(value, null, 1)}\n`);
if (process.argv.includes("--commands")) write("commands-page.baseline.json", commandsPageOutputs());
if (process.argv.includes("--model-tools")) write("model-tools.baseline.json", modelToolOutputs());
