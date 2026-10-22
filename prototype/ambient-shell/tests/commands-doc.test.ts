import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS_BEGIN, COMMANDS_END, renderCommandsMarkdown } from "../shared/voice-commands.ts";

describe("README command table", () => {
  it("equals the table generated from shared/voice-commands.ts (run npm run docs:commands after changing it)", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const begin = readme.indexOf(COMMANDS_BEGIN);
    const end = readme.indexOf(COMMANDS_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(readme.slice(begin + COMMANDS_BEGIN.length, end).trim()).toBe(renderCommandsMarkdown());
  });
});
