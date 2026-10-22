// 把 shared/voice-commands.ts 的指令表寫進 README.md 的標記之間（npm run docs:commands）。
// tests/commands-doc.test.ts 會在 README 與程式不一致時失敗。
import { readFileSync, writeFileSync } from "node:fs";
import { COMMANDS_BEGIN, COMMANDS_END, renderCommandsMarkdown } from "../shared/voice-commands.ts";

const file = new URL("../README.md", import.meta.url);
const readme = readFileSync(file, "utf8");
const begin = readme.indexOf(COMMANDS_BEGIN);
const end = readme.indexOf(COMMANDS_END);
if (begin < 0 || end < begin) throw new Error(`README.md 找不到指令表標記：${COMMANDS_BEGIN} … ${COMMANDS_END}`);
const next = `${readme.slice(0, begin + COMMANDS_BEGIN.length)}\n\n${renderCommandsMarkdown()}\n\n${readme.slice(end)}`;
if (next === readme) console.log("README.md 的指令表已是最新");
else {
  writeFileSync(file, next);
  console.log("已更新 README.md 的指令表");
}
