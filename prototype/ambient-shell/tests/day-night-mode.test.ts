// DN-2（George 2026-11-08）：日夜間模式移到核心共用、手動切換（設定頁、選單列、語音 set_day_night）與夜間輕聲語氣。
// 時間一律用假時鐘（本機時區的固定時刻）；鏡頭亮度用假讀值。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DayNightSettingsStore } from "../server/day-night-settings.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { buildLiveInstructions, buildRealtimeInstructions, buildRealtimeTools, DAY_NIGHT_RULE, NIGHT_TONE_RULE, realtimeToolRules } from "../server/realtime.ts";
import { liveCallerTools } from "../server/live-tool-caller.ts";
import { HOST_TIMEOUT_MS } from "../server/realtime-routes.ts";
import {
  activeOverride, DayNightPatchError, dayNightToolOutput, decideDayNight, DEFAULT_DAY_NIGHT_PREFS, nextScheduledChange, overrideUntil,
  parseDayNightPatch, parseDayNightToolArgs, type DayNightSettingsView,
} from "../shared/day-night.ts";
import { DAY_NIGHT_TEXT, dayNightMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";
import type { SettingsView } from "../shared/types.ts";
import { dayNightReasonText, VOICE_VOLUME_TEXT } from "../src/voice-volume.ts";

/** 本機時區 2026-11-08 的某個時刻。 */
const at = (h: number, m = 0, day = 8) => new Date(2026, 10, day, h, m).getTime();
const prefs = DEFAULT_DAY_NIGHT_PREFS;

describe("scheduled changes and override end times (local time, fake clock)", () => {
  it("next change: 15:30 → 22:00, 23:10 → 07:00 next day; no night hours → null", () => {
    expect(nextScheduledChange(at(15, 30), prefs)).toBe(at(22));
    expect(nextScheduledChange(at(23, 10), prefs)).toBe(at(7, 0, 9));
    expect(nextScheduledChange(at(3), prefs)).toBe(at(7));
    expect(nextScheduledChange(at(12), { night_start_h: 5, night_end_h: 5 })).toBeNull();
  });

  it("scope now lasts to the next boundary; tonight lasts to the end of tonight's night hours", () => {
    expect(overrideUntil(at(8), "now", prefs)).toBe(at(22));
    expect(overrideUntil(at(21), "tonight", prefs)).toBe(at(7, 0, 9));
    expect(overrideUntil(at(23), "tonight", prefs)).toBe(at(7, 0, 9));
    expect(overrideUntil(at(23), "now", prefs)).toBe(at(7, 0, 9));
    expect(overrideUntil(at(12), "now", { night_start_h: 0, night_end_h: 0 })).toBe(at(12) + 12 * 3_600_000);
    expect(overrideUntil(at(12), "tonight", { night_start_h: 0, night_end_h: 0 })).toBe(at(12) + 24 * 3_600_000);
  });

  it("a manual override wins over hours and camera until it expires, then the automatic decision returns", () => {
    const override = { mode: "day" as const, until: at(7, 0, 9) };
    expect(decideDayNight(23, "dark", prefs, override, at(23))).toEqual({ mode: "day", reason: "manual", camera: true });
    expect(decideDayNight(7, null, prefs, override, at(7, 0, 9))).toEqual({ mode: "day", reason: "day", camera: false });
    expect(decideDayNight(15, "bright", prefs, { mode: "night", until: at(22) }, at(15))).toMatchObject({ mode: "night", reason: "manual" });
    expect(activeOverride(override, at(6, 59, 9))).toBe(override);
    expect(activeOverride(override, at(7, 0, 9))).toBeNull();
  });
});

describe("patch validation", () => {
  it("accepts prefs and overrides; rejects unknown keys, bad values, scope without a mode and empty patches", () => {
    expect(parseDayNightPatch({ override: "night" })).toEqual({ override: "night" });
    expect(parseDayNightPatch({ override: "day", scope: "tonight", night_effects: false })).toEqual({ override: "day", scope: "tonight", night_effects: false });
    expect(parseDayNightPatch({ night_start_h: 21, use_camera: false })).toEqual({ night_start_h: 21, use_camera: false });
    for (const bad of [{ override: "dusk" }, { scope: "tonight" }, { override: "auto", scope: "now" }, { night_end_h: 24 }, { use_camera: "on" }, { mode: "night" }, {}, [], null]) {
      expect(() => parseDayNightPatch(bad), JSON.stringify(bad)).toThrow(DayNightPatchError);
    }
  });
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-day-night-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("day-night.json (core store)", () => {
  it("defaults, saves overrides with an end time and scope, expires them, and survives a restart", () => {
    let now = at(21);
    let changes = 0;
    const store = new DayNightSettingsStore({ dir: root, onChange: () => changes++, now: () => now });
    expect(store.view()).toEqual({ prefs, override: null, saved: false, core_mode: "day", write_path: "/api/settings/day-night" });
    const view = store.update({ override: "day", scope: "tonight" });
    expect(changes).toBe(1);
    expect(view.override).toEqual({ mode: "day", until: at(7, 0, 9), scope: "tonight" });
    expect(view.saved).toBe(true);
    now = at(23);
    expect(store.coreMode()).toBe("day");
    const reopened = new DayNightSettingsStore({ dir: root, onChange: () => {}, now: () => now });
    expect(reopened.override()).toEqual({ mode: "day", until: at(7, 0, 9), scope: "tonight" });
    now = at(7, 0, 9);
    expect(store.override()).toBeNull();
    expect(store.coreMode()).toBe("day");
    now = at(23, 0, 9);
    expect(store.coreMode()).toBe("night");
    store.update({ override: "day" });
    expect(store.coreMode()).toBe("day");
    store.update({ override: "auto" });
    expect(store.override()).toBeNull();
    expect(JSON.parse(readFileSync(join(root, "day-night.json"), "utf8")).prefs.override).toBeNull();
  });

  it("changed prefs are shared; a bad saved key is ignored and the rest kept", () => {
    const store = new DayNightSettingsStore({ dir: root, onChange: () => {}, now: () => at(12) });
    store.update({ night_start_h: 21, night_effects: false });
    expect(store.prefs()).toEqual({ ...prefs, night_start_h: 21, night_effects: false });
    writeFileSync(join(root, "day-night.json"), JSON.stringify({ schema_version: 1, prefs: { night_start_h: 99, night_end_h: 6, override: { mode: "dusk", until: 1 } } }));
    const logs: string[] = [];
    const reopened = new DayNightSettingsStore({ dir: root, onChange: () => {}, log: (l) => logs.push(l), now: () => at(12) });
    expect(reopened.prefs()).toEqual({ ...prefs, night_end_h: 6 });
    expect(reopened.override()).toBeNull();
    expect(logs.join("")).toContain("被忽略");
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("HTTP (startNous, mock provider)", () => {
  let core: NousHandle | null = null;
  afterEach(async () => {
    await core?.close();
    core = null;
  });

  it("settings.day_night is shared by every page; POST switches it; bad bodies are 400", async () => {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: config, NOUS_PROVIDER: "mock", PORT: String(await freePort()), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
      log: () => {},
    });
    const url = core.url;
    const settings = async (terminal?: string) => (await (await fetch(`${url}/api/settings`, { headers: terminal ? { "x-nous-terminal": terminal } : {} })).json()) as SettingsView;
    expect((await settings()).day_night).toMatchObject({ prefs, override: null, saved: false, write_path: "/api/settings/day-night" });
    const post = (body: unknown) => fetch(`${url}/api/settings/day-night`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = (await (await post({ override: "night" })).json()) as SettingsView;
    expect(saved.day_night).toMatchObject({ override: { mode: "night", scope: "now" }, saved: true, core_mode: "night" });
    expect((await settings("pi")).day_night).toMatchObject({ override: { mode: "night" }, core_mode: "night" });
    expect((await post({ override: "dusk" })).status).toBe(400);
    expect((await post({ scope: "tonight" })).status).toBe(400);
    expect(((await (await post({ override: "auto" })).json()) as SettingsView).day_night?.override).toBeNull();
  });
});

describe("voice tool set_day_night", () => {
  it("is offered on both paths with a timeout and a speaking rule", () => {
    const caps = { webSearch: false, mcp: [] };
    expect(buildRealtimeTools(caps).map((t) => t.name)).toContain("set_day_night");
    expect(liveCallerTools(caps).map((t) => ("name" in t ? t.name : t.type))).toContain("set_day_night");
    expect(HOST_TIMEOUT_MS.set_day_night).toBe(10_000);
    expect(realtimeToolRules(caps)).toContain(DAY_NIGHT_RULE);
  });

  it("parses arguments", () => {
    expect(parseDayNightToolArgs({ mode: "night" })).toEqual({ mode: "night" });
    expect(parseDayNightToolArgs({ mode: "day", scope: "tonight" })).toEqual({ mode: "day", scope: "tonight" });
    expect(parseDayNightToolArgs({ mode: "auto", scope: "tonight" })).toEqual({ mode: "auto" });
    expect(parseDayNightToolArgs({ mode: "dusk" })).toBeNull();
  });

  it("the output says the mode and until when manual, or that automatic is back", () => {
    const until = at(7, 0, 9);
    expect(dayNightToolOutput({ mode: "day", reason: "manual", camera: false }, { mode: "day", until })).toEqual({
      ok: true, status: "confirmed", mode: "day", reason: "manual", until: "07:00", note: "手動切換，07:00 之後自動回到依時段判斷。",
    });
    expect(dayNightToolOutput({ mode: "night", reason: "hours", camera: false }, null)).toMatchObject({ ok: true, mode: "night", reason: "hours", note: "已恢復自動：依夜間時段與鏡頭亮度判斷。" });
  });

  it("the shared executor calls onDayNight and reports real failures", async () => {
    const { executeRealtimeTool } = await import("../src/realtime-tools.ts");
    const requests: unknown[] = [];
    const activity: string[] = [];
    const delivered: Record<string, unknown>[] = [];
    const callbacks = {
      onDayNight: async (request: unknown) => (requests.push(request), { ok: true, status: "confirmed", mode: "night", reason: "manual", until: "22:00" }),
      onToolActivity: (text: string) => activity.push(text),
    };
    const ctx = { callbacks, approvals: {}, generation: 1, stale: () => false, end: () => {}, deliver: (o: Record<string, unknown>) => delivered.push(o) };
    await executeRealtimeTool("set_day_night", JSON.stringify({ mode: "night" }), ctx as never);
    expect(requests).toEqual([{ mode: "night" }]);
    expect(delivered[0]).toMatchObject({ ok: true, mode: "night" });
    expect(activity).toEqual(["日夜間模式：夜間（手動）"]);
    await executeRealtimeTool("set_day_night", JSON.stringify({ mode: "dusk" }), ctx as never);
    expect(delivered[1]).toEqual({ ok: false, error: "mode 只能是 day、night 或 auto" });
    await executeRealtimeTool("set_day_night", JSON.stringify({ mode: "day" }), { ...ctx, callbacks: { onToolActivity: () => {} } } as never);
    expect(delivered[2]).toEqual({ ok: false, error: "這個畫面不能切換日夜間模式" });
  });
});

describe("night tone", () => {
  it("only when the core says night; both paths; otherwise the instructions are unchanged", () => {
    const now = new Date(at(23));
    const base = buildRealtimeInstructions([], now, { webSearch: false, mcp: [] });
    const night = buildRealtimeInstructions([], now, { webSearch: false, mcp: [], night: true });
    expect(base).not.toContain(NIGHT_TONE_RULE);
    expect(night).toContain(NIGHT_TONE_RULE);
    expect(night.replace(`${NIGHT_TONE_RULE}\n`, "")).toBe(base);
    expect(buildLiveInstructions([], now, { mcp: [] })).not.toContain(NIGHT_TONE_RULE);
    expect(buildLiveInstructions([], now, { mcp: [], night: true })).toContain(NIGHT_TONE_RULE);
  });
});

const view = (over: Partial<DayNightSettingsView> = {}): DayNightSettingsView => ({ prefs, override: null, saved: true, core_mode: "day", write_path: "/api/settings/day-night", ...over });

describe("menu bar section", () => {
  it("uses the same text as the page (the .mjs cannot import the .ts table)", () => {
    const m = VOICE_VOLUME_TEXT.manual;
    expect(DAY_NIGHT_TEXT).toEqual({
      group: m.group, auto: m.auto, day: m.day, night: m.night, tonightDay: m.tonightDay, autoLine: m.autoLine,
      manual_day: VOICE_VOLUME_TEXT.modeLine.manual_day, manual_night: VOICE_VOLUME_TEXT.modeLine.manual_night,
    });
  });

  it("status line and four radios that send the right patch", () => {
    const patches: unknown[] = [];
    const items = dayNightMenu(view(), { setDayNight: (p) => patches.push(p), now: at(12) });
    expect(items.map((i) => i.label ?? i.type)).toEqual(["separator", "日夜間模式", "自動：依夜間時段 22:00–07:00 與各裝置的鏡頭", "自動", "現在是白天", "切到夜間", "今晚維持日間"]);
    expect(items[3]).toMatchObject({ type: "radio", checked: true });
    for (const item of items.slice(3)) (item.click as () => void)();
    expect(patches).toEqual([{ override: "auto" }, { override: "day", scope: "now" }, { override: "night", scope: "now" }, { override: "day", scope: "tonight" }]);
    const manual = dayNightMenu(view({ override: { mode: "day", until: at(7, 0, 9), scope: "tonight" } }), { now: at(21) });
    expect(manual[2]!.label).toBe("手動切換：維持日間模式到 07:00");
    expect(manual.find((i) => i.checked)?.label).toBe("今晚維持日間");
    const expired = dayNightMenu(view({ override: { mode: "night", until: at(22) } }), { now: at(22) });
    expect(expired.find((i) => i.checked)?.label).toBe("自動");
  });

  it("appears in the settings menu only when the core gives settings.day_night; English has no Chinese", () => {
    const base = { seconds: [] } as unknown as SettingsView;
    const labels = (s: SettingsView) => settingsMenu(s, { command: () => {}, setMenuPref: () => {} }).map((i) => i.label);
    expect(labels(base)).not.toContain("日夜間模式");
    expect(labels({ ...base, day_night: view() })).toContain("日夜間模式");
    const en = dayNightMenu(view({ override: { mode: "night", until: at(22) } }), { translate: (s: string, ...v: unknown[]) => translate(s, "en", ...v), now: at(12) });
    for (const item of en) if (item.label) expect(item.label).not.toMatch(/[一-鿿]/u);
    const desktopEn = JSON.parse(readFileSync(new URL("../desktop/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of [...Object.values(DAY_NIGHT_TEXT), "日夜間設定沒有保存"]) expect(desktopEn[source], source).toBeTruthy();
  });
});

describe("page text", () => {
  it("reason line for manual, hours, camera and day", () => {
    const tt = (s: string, ...a: string[]) => a.reduce((out, v, i) => out.replace(`{${i}}`, v), s);
    expect(dayNightReasonText({ mode: "night", reason: "manual", camera: false }, prefs, { mode: "night", until: at(22) }, tt)).toBe("手動切換：維持夜間模式到 22:00");
    expect(dayNightReasonText({ mode: "night", reason: "hours", camera: false }, prefs, null, tt)).toBe("現在用夜間音量：在夜間時段（22:00–07:00）");
    expect(dayNightReasonText({ mode: "night", reason: "camera_dark", camera: true }, prefs, null, tt)).toBe("現在用夜間音量：鏡頭量到環境很暗");
    expect(dayNightReasonText({ mode: "day", reason: "day", camera: false }, prefs, null, tt)).toBe("現在用日間音量");
  });

  it("every new page string has English", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of [...Object.values(VOICE_VOLUME_TEXT.manual), VOICE_VOLUME_TEXT.modeLine.manual_day, VOICE_VOLUME_TEXT.modeLine.manual_night, "這個核心不支援手動切換日夜間模式", "日夜間設定沒有保存：{0}"]) {
      expect(en[source], source).toBeTruthy();
      expect(en[source]).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
