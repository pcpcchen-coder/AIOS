// 釘住的設定畫面（George 2026-11-08）：打開後只有按「收起」或齒輪才關；其他事件照常更新狀態，但畫面留在設定。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialShell, keepPinnedSettings, reduceShell, type ShellState } from "../src/shell-state.ts";

const open = reduceShell(initialShell, { type: "show.settings", request_id: "r1" });
const pinned = open.surface!;

describe("keepPinnedSettings", () => {
  it("dismiss (person left, wake word, starting voice, Esc) keeps the same settings card", () => {
    const next = keepPinnedSettings(reduceShell(open, { type: "dismiss" }), pinned);
    expect(next.surface).toBe(pinned);
    expect(next.mode).toBe("presenting");
  });

  it("other surfaces do not replace it, but task state still updates underneath", () => {
    expect(keepPinnedSettings(reduceShell(open, { type: "show.progress", request_id: "r2" }), pinned).surface).toBe(pinned);
    const submitted = keepPinnedSettings(reduceShell(open, { type: "task.submitted", task_id: "t1", request_id: "r3" } as never), pinned);
    expect(submitted.surface).toBe(pinned);
    expect(submitted).toMatchObject({ mode: "working", foreground_task_id: "t1" });
  });

  it("a confirmation card may cover it; when the card closes, settings come back", () => {
    const confirm = reduceShell(open, { type: "show.confirm", request_id: "c1" } as never);
    expect(keepPinnedSettings(confirm, pinned).surface?.kind).toBe("confirm");
    expect(keepPinnedSettings(reduceShell(confirm, { type: "dismiss" }), pinned).surface).toBe(pinned);
  });

  it("not pinned (closed with 收起) → events behave as before", () => {
    const next: ShellState = reduceShell(open, { type: "dismiss" });
    expect(keepPinnedSettings(next, null)).toBe(next);
    expect(next.surface).toBeNull();
  });

  it("main.ts unpins only through closeSettings (收起 and the gear) or a policy-rejected card; pins only on terminal pages; Esc still ends a call", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main.match(/pinnedSettings = null/g)).toHaveLength(2);
    expect(main).toMatch(/if \(pinnedSettings\?\.surface_id === s\.surface_id\) pinnedSettings = null;/);
    expect(main).toMatch(/next\.surface\?\.kind === "settings" && pinSettingsOnThisPage\) pinnedSettings = next\.surface;/);
    expect(main).toMatch(/realtime\.on && shell\.surface !== null && !pinnedSettings\) dispatch/);
    expect(main).toMatch(/dismiss: \(\) => \(shell\.surface\?\.kind === "settings" \? closeSettings\(\) : dispatch\(\{ type: "dismiss" \}\)\)/);
    expect(main).toMatch(/close: \(\) => closeSettings\(\)/);
  });

  it("settings text is 1.5× (zoom) and still fits the screen height", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.surface-root:has\(> \.surface--settings\) \{ width: min\(1200px, 96vw\); zoom: 1; \}/);
    expect(css).toMatch(/\.surface\.surface--settings \{\n  zoom: 1\.5;\n  max-height: calc\(\(100vh - var\(--surface-top\) - 4vh\) \/ 1\.5\);/);
  });
});
