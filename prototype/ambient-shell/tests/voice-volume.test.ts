// VOL-1（George 2026-11-07）：對話音量。規則（shared/voice-volume.ts）、頁面狀態與保存（src/voice-volume.ts）、
// 兩條即時語音路徑共用的工具執行器（src/realtime-tools.ts）、工具表與說話規則（server/realtime.ts）、設定頁。
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { liveCallerTools } from "../server/live-tool-caller.ts";
import { buildRealtimeTools, realtimeToolRules, voiceVolumeRule } from "../server/realtime.ts";
import { nextVoiceVolume, parseVoiceVolumeArgs, VOICE_VOLUME_DEFAULT, VOICE_VOLUME_MAX, VOICE_VOLUME_MIN, VOICE_VOLUME_STEP, voiceVolumeOutput } from "../shared/voice-volume.ts";
import { HOST_TIMEOUT_MS } from "../server/realtime-routes.ts";
import { loadVoiceVolume, saveVoiceVolume, VOICE_VOLUME_KEY, VOICE_VOLUME_TEXT, VoiceVolume } from "../src/voice-volume.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("nextVoiceVolume", () => {
  it("steps up and down by VOICE_VOLUME_STEP and clamps to 10–100, flagging the limit", () => {
    expect(nextVoiceVolume(60, { change: "up" })).toEqual({ ok: true, volume: 60 + VOICE_VOLUME_STEP, previous: 60, limit: null });
    expect(nextVoiceVolume(60, { change: "down" })).toEqual({ ok: true, volume: 60 - VOICE_VOLUME_STEP, previous: 60, limit: null });
    expect(nextVoiceVolume(100, { change: "up" })).toEqual({ ok: true, volume: VOICE_VOLUME_MAX, previous: 100, limit: "max" });
    expect(nextVoiceVolume(90, { change: "up" })).toEqual({ ok: true, volume: VOICE_VOLUME_MAX, previous: 90, limit: "max" });
    expect(nextVoiceVolume(30, { change: "down" })).toEqual({ ok: true, volume: VOICE_VOLUME_MIN, previous: 30, limit: null });
    expect(nextVoiceVolume(20, { change: "down" })).toEqual({ ok: true, volume: VOICE_VOLUME_MIN, previous: 20, limit: "min" });
    expect(nextVoiceVolume(40, { change: "reset" })).toEqual({ ok: true, volume: VOICE_VOLUME_DEFAULT, previous: 40, limit: null });
  });

  it("an explicit level wins over change and is rounded and clamped", () => {
    expect(nextVoiceVolume(100, { level: 60, change: "up" })).toMatchObject({ volume: 60, limit: null });
    expect(nextVoiceVolume(100, { level: 47.6 })).toMatchObject({ volume: 48 });
    expect(nextVoiceVolume(100, { level: 0 })).toMatchObject({ volume: VOICE_VOLUME_MIN, limit: "min" });
    expect(nextVoiceVolume(50, { level: 150 })).toMatchObject({ volume: VOICE_VOLUME_MAX, limit: "max" });
    expect(nextVoiceVolume(50, { level: 100 })).toMatchObject({ volume: 100, limit: null });
  });

  it("refuses a request with neither level nor change, without changing anything", () => {
    expect(nextVoiceVolume(70, {})).toMatchObject({ ok: false });
    expect(voiceVolumeOutput(nextVoiceVolume(70, {}))).toMatchObject({ ok: false });
  });

  it("parses the model's arguments, including numeric strings, and ignores unknown values", () => {
    expect(parseVoiceVolumeArgs({ level: "60" })).toEqual({ level: 60, change: null, period: null });
    expect(parseVoiceVolumeArgs({ change: "up", period: "night" })).toEqual({ level: null, change: "up", period: "night" });
    expect(parseVoiceVolumeArgs({ change: "louder", level: "x", period: "evening" })).toEqual({ level: null, change: null, period: null });
  });

  it("the tool output is confirmed with the real volume, and carries a note only at a limit", () => {
    expect(voiceVolumeOutput(nextVoiceVolume(60, { change: "up" }))).toEqual({ ok: true, status: "confirmed", volume: 80, previous: 60 });
    expect(voiceVolumeOutput(nextVoiceVolume(100, { change: "up" }))).toMatchObject({ volume: 100, note: expect.stringContaining("系統") });
    expect(voiceVolumeOutput(nextVoiceVolume(10, { change: "down" }))).toMatchObject({ volume: 10, note: expect.stringContaining("最小") });
  });
});

describe("VoiceVolume (page state)", () => {
  it("defaults to 100 and reads a saved value, ignoring junk", () => {
    expect(loadVoiceVolume(memoryStorage())).toBe(100);
    expect(loadVoiceVolume(memoryStorage({ [VOICE_VOLUME_KEY]: "40" }))).toBe(40);
    expect(loadVoiceVolume(memoryStorage({ [VOICE_VOLUME_KEY]: "loud" }))).toBe(100);
    expect(loadVoiceVolume(memoryStorage({ [VOICE_VOLUME_KEY]: "" }))).toBe(100);
    expect(loadVoiceVolume(memoryStorage({ [VOICE_VOLUME_KEY]: "3" }))).toBe(VOICE_VOLUME_MIN);
    expect(loadVoiceVolume(null)).toBe(100);
  });

  it("applies to attached players immediately, saves, and stops touching detached ones", () => {
    const storage = memoryStorage({ [VOICE_VOLUME_KEY]: "60" });
    const volume = new VoiceVolume(storage);
    const a = { volume: 1 };
    const detach = volume.attach(a);
    expect(a.volume).toBeCloseTo(0.6);
    const seen: number[] = [];
    volume.onChange((v) => seen.push(v));
    expect(volume.apply({ change: "down" })).toMatchObject({ ok: true, volume: 40 });
    expect(a.volume).toBeCloseTo(0.4);
    expect(storage.data.get(VOICE_VOLUME_KEY)).toBe("40");
    expect(seen).toEqual([40]);
    detach();
    volume.apply({ level: 90 });
    expect(a.volume).toBeCloseTo(0.4);
    expect(volume.current).toBe(90);
  });

  it("a failed request changes nothing", () => {
    const storage = memoryStorage();
    const volume = new VoiceVolume(storage);
    expect(volume.apply({}).ok).toBe(false);
    expect(volume.current).toBe(100);
    expect(storage.data.has(VOICE_VOLUME_KEY)).toBe(false);
  });

  it("a storage that throws does not break playback", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(saveVoiceVolume(50, broken)).toBe(false);
    const volume = new VoiceVolume(broken);
    const a = { volume: 1 };
    volume.attach(a);
    volume.apply({ level: 50 });
    expect(a.volume).toBeCloseTo(0.5);
  });
});

describe("set_voice_volume tool", () => {
  it("is offered on both routes, with or without the hub, and the page executor has a timeout", () => {
    for (const caps of [{ webSearch: false, mcp: [] }, { webSearch: true, mcp: [], home: true }]) {
      expect(buildRealtimeTools(caps).map((t) => t.name)).toContain("set_voice_volume");
      expect(liveCallerTools(caps).map((t) => ("name" in t ? t.name : t.type))).toContain("set_voice_volume");
    }
    expect(HOST_TIMEOUT_MS.set_voice_volume).toBeGreaterThan(0);
  });

  it("the rule says unnamed 'louder' means Nous's voice; home_control is mentioned only when the hub is configured", () => {
    expect(realtimeToolRules({ webSearch: false, mcp: [] })).toContain(voiceVolumeRule(false));
    expect(voiceVolumeRule(false)).not.toContain("home_");
    // 沒有中控時工具表與說明都不出現 home_（工具說明也一樣）。
    expect(JSON.stringify(buildRealtimeTools({ webSearch: false, mcp: [] }))).not.toContain("home_");
    expect(realtimeToolRules({ webSearch: false, mcp: [], home: true })).toContain(voiceVolumeRule(true));
    expect(voiceVolumeRule(true)).toContain("home_control");
    expect(realtimeToolRules({ webSearch: false, mcp: [], home: true }).join("\n")).toContain("「電視大聲一點」是 press volume_up");
  });

  it("the shared executor calls onVoiceVolume with parsed arguments and shows the real volume", async () => {
    const { executeRealtimeTool } = await import("../src/realtime-tools.ts");
    const requests: unknown[] = [];
    const activity: string[] = [];
    const delivered: Record<string, unknown>[] = [];
    const volume = new VoiceVolume(memoryStorage());
    const callbacks = {
      onVoiceVolume: (request: Parameters<VoiceVolume["apply"]>[0]) => (requests.push(request), voiceVolumeOutput(volume.apply(request))),
      onToolActivity: (text: string) => activity.push(text),
    };
    const ctx = { callbacks, approvals: {}, generation: 1, stale: () => false, end: () => {}, deliver: (o: Record<string, unknown>) => delivered.push(o) };
    await executeRealtimeTool("set_voice_volume", JSON.stringify({ change: "down" }), ctx as never);
    expect(requests).toEqual([{ level: null, change: "down", period: null }]);
    expect(delivered[0]).toEqual({ ok: true, status: "confirmed", volume: 80, previous: 100 });
    expect(activity).toEqual(["對話音量：80"]);
    await executeRealtimeTool("set_voice_volume", "{}", ctx as never);
    expect(delivered[1]).toMatchObject({ ok: false });
    expect(activity).toHaveLength(1);
    const noPage = { ...ctx, callbacks: { onToolActivity: () => {} } };
    await executeRealtimeTool("set_voice_volume", JSON.stringify({ level: 50 }), noPage as never);
    expect(delivered[2]).toEqual({ ok: false, error: "這個畫面不能調對話音量" });
  });
});

describe("settings view", () => {
  class El {
    children: (El | string)[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (() => void)[]>();
    disabled = false;
    selected = false;
    value = "";
    constructor(readonly tagName: string) {}
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    append(...nodes: (El | string)[]) { this.children.push(...nodes); }
    addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    click() { for (const fn of this.listeners.get("click") ?? []) fn(); }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  }
  let views: typeof import("../src/views.ts");
  beforeAll(async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    views = await import("../src/views.ts");
  });
  afterAll(() => vi.unstubAllGlobals());

  const panel = (over: Partial<import("../src/views.ts").VoiceVolumePanelState> = {}) => ({
    day: 60, night: 40, decision: { mode: "day", reason: "day", camera: false }, prefs: { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true, screen_off: true }, light: null, ...over,
  }) as import("../src/views.ts").VoiceVolumePanelState;
  const volumeButtons = (section: El, period: string) => section.all().find((e) => e.attributes.get("data-volume-period") === period)!.all().filter((e) => e.tagName === "button");

  it("shows day and night volumes; each row's buttons change that period; limits disable the matching button", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(panel(), { setVoiceVolume: (r: unknown) => calls.push(r), setDayNight: () => {} } as never) as unknown as El;
    expect(section.textContent).toContain("日間音量");
    expect(section.textContent).toContain("目前 60");
    expect(section.textContent).toContain("夜間音量");
    expect(section.textContent).toContain("目前 40");
    expect(section.textContent).toContain("現在用日間音量");
    const day = volumeButtons(section, "day");
    expect(day.map((b) => b.textContent)).toEqual(["小聲一點", "大聲一點", "恢復預設"]);
    for (const b of day) b.click();
    for (const b of volumeButtons(section, "night")) b.click();
    expect(calls).toEqual([
      { change: "down", period: "day" }, { change: "up", period: "day" }, { change: "reset", period: "day" },
      { change: "down", period: "night" }, { change: "up", period: "night" }, { change: "reset", period: "night" },
    ]);
    const limits = views.renderVoiceVolumeSettings(panel({ day: 100, night: 10 }), { setVoiceVolume: () => {} } as never) as unknown as El;
    expect(volumeButtons(limits, "day").map((b) => b.disabled)).toEqual([false, true, true]);
    expect(volumeButtons(limits, "night").map((b) => b.disabled)).toEqual([true, false, false]);
    // 夜間的預設是 40：已經是 40 時「恢復預設」停用。
    expect(volumeButtons(section, "night")[2]!.disabled).toBe(true);
  });

  it("says honestly why night is in use and what the camera read", () => {
    const hours = views.renderVoiceVolumeSettings(panel({ decision: { mode: "night", reason: "hours", camera: false } }), {} as never) as unknown as El;
    expect(hours.textContent).toContain("現在用夜間音量：在夜間時段（22:00–07:00）");
    expect(hours.textContent).toContain("鏡頭亮度：—（鏡頭沒開或還沒量到，只看時段）");
    const dark = views.renderVoiceVolumeSettings(panel({ decision: { mode: "night", reason: "camera_dark", camera: true }, light: { luma: 21.6, level: "dark" } }), {} as never) as unknown as El;
    expect(dark.textContent).toContain("現在用夜間音量：鏡頭量到環境很暗");
    expect(dark.textContent).toContain("鏡頭亮度：22（暗）");
    const off = views.renderVoiceVolumeSettings(panel({ prefs: { night_start_h: 22, night_end_h: 7, use_camera: false, night_effects: true, screen_off: true } }), {} as never) as unknown as El;
    expect(off.textContent).toContain("鏡頭亮度：不使用（只看時段）");
  });

  it("the camera toggle and hour selects call setDayNight", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(panel(), { setVoiceVolume: () => {}, setDayNight: (p: unknown) => calls.push(p) } as never) as unknown as El;
    const toggle = section.all().find((e) => e.attributes.get("aria-pressed") === "true")!;
    toggle.click();
    const selects = section.all().filter((e) => e.tagName === "select");
    expect(selects).toHaveLength(2);
    expect(selects[0]!.all().filter((e) => e.tagName === "option")).toHaveLength(24);
    selects[0]!.value = "21";
    for (const fn of selects[0]!.listeners.get("change") ?? []) fn();
    selects[1]!.value = "6";
    for (const fn of selects[1]!.listeners.get("change") ?? []) fn();
    expect(calls).toEqual([{ use_camera: false }, { night_start_h: 21 }, { night_end_h: 6 }]);
  });

  it("DN-1: the night-effects toggle calls setDayNight with night_effects", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(panel(), { setVoiceVolume: () => {}, setDayNight: (p: unknown) => calls.push(p) } as never) as unknown as El;
    expect(section.textContent).toContain("夜間一併調暗畫面、靜音處理中音效、暫停回憶");
    const toggle = section.all().find((e) => e.attributes.has("data-night-effects"))!;
    expect(toggle.attributes.get("aria-pressed")).toBe("true");
    toggle.click();
    const off = views.renderVoiceVolumeSettings(panel({ prefs: { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: false, screen_off: true } }), { setVoiceVolume: () => {}, setDayNight: (p: unknown) => calls.push(p) } as never) as unknown as El;
    const offToggle = off.all().find((e) => e.attributes.has("data-night-effects"))!;
    expect(offToggle.attributes.get("aria-pressed")).toBe("false");
    offToggle.click();
    expect(calls).toEqual([{ night_effects: false }, { night_effects: true }]);
  });

  const dnPanel = (over: Record<string, unknown> = {}) => ({ day: 100, night: 40, decision: { mode: "day", reason: "day", camera: false }, prefs: { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true, screen_off: true }, light: null, override: null, shared: true, ...over });

  it("DN-2: four manual buttons send the patch; the active one is pressed; none without a shared core", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(dnPanel() as never, { setVoiceVolume: () => {}, setDayNight: (p: unknown) => calls.push(p) } as never) as unknown as El;
    const buttons = section.all().filter((e) => e.attributes.has("data-day-night-manual"));
    expect(buttons.map((b) => b.attributes.get("data-day-night-manual"))).toEqual(["auto", "day", "night", "tonightDay"]);
    expect(buttons[0]!.attributes.get("aria-pressed")).toBe("true");
    for (const b of buttons) b.click();
    expect(calls).toEqual([{ override: "auto" }, { override: "day", scope: "now" }, { override: "night", scope: "now" }, { override: "day", scope: "tonight" }]);
    const tonight = views.renderVoiceVolumeSettings(dnPanel({ override: { mode: "day", until: Date.now() + 3_600_000, scope: "tonight" }, decision: { mode: "day", reason: "manual", camera: false } }) as never, { setDayNight: () => {} } as never) as unknown as El;
    expect(tonight.all().find((e) => e.attributes.get("aria-pressed") === "true" && e.attributes.has("data-day-night-manual"))?.attributes.get("data-day-night-manual")).toBe("tonightDay");
    const local = views.renderVoiceVolumeSettings(dnPanel({ shared: false }) as never, {} as never) as unknown as El;
    expect(local.all().some((e) => e.attributes.has("data-day-night-manual"))).toBe(false);
  });

  it("DN-3: the Pi screen-off toggle shows only with a shared core and sends screen_off", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(dnPanel() as never, { setVoiceVolume: () => {}, setDayNight: (p: unknown) => calls.push(p) } as never) as unknown as El;
    const toggle = section.all().find((e) => e.attributes.has("data-screen-off"))!;
    expect(toggle.attributes.get("aria-pressed")).toBe("true");
    toggle.click();
    expect(calls).toEqual([{ screen_off: false }]);
    const local = views.renderVoiceVolumeSettings(dnPanel({ shared: false }) as never, {} as never) as unknown as El;
    expect(local.all().some((e) => e.attributes.has("data-screen-off"))).toBe(false);
  });

  it("every new string has an English catalog entry", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    const sources = [
      ...Object.values(VOICE_VOLUME_TEXT).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))),
      "對話音量：{0}",
      "這個畫面不能調對話音量",
      voiceVolumeOutput(nextVoiceVolume(100, {})).error as string,
      voiceVolumeOutput(nextVoiceVolume(100, { change: "up" })).note as string,
      voiceVolumeOutput(nextVoiceVolume(10, { change: "down" })).note as string,
      voiceVolumeOutput(nextVoiceVolume(50, { change: "up" }), { period: "night", active: "day" }).note as string,
      voiceVolumeOutput(nextVoiceVolume(50, { change: "up" }), { period: "day", active: "night" }).note as string,
    ];
    for (const source of sources) {
      expect(en[source], source).toBeTruthy();
      expect(en[source]).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
