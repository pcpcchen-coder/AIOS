// MEMO-1：回憶模式的狀態機（假時鐘）、設定驗證與照片說明（時間與地點）。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORIES_PREFS,
  MEMORIES_CACHE_CAP_BYTES,
  MEMORIES_OFF,
  memoryCaption,
  MemoriesPatchError,
  parseMemoriesPatch,
  stepMemories,
  wakeMemories,
  type MemoriesInput,
  type MemoriesState,
} from "../shared/memories.ts";

const IDLE = 60_000;
const input = (now: number, over: Partial<MemoriesInput> = {}): MemoriesInput => ({ now, enabled: true, busy: false, hasItems: true, idleMs: IDLE, ...over });

/** 依序跑一串輸入，回傳每一步的 phase。 */
function run(steps: MemoriesInput[], start: MemoriesState = MEMORIES_OFF): { phases: string[]; state: MemoriesState } {
  let state = start;
  const phases: string[] = [];
  for (const step of steps) {
    state = stepMemories(state, step);
    phases.push(state.phase);
  }
  return { phases, state };
}

describe("state machine", () => {
  it("disabled is always off, whatever else is true", () => {
    expect(run([input(0, { enabled: false }), input(IDLE * 5, { enabled: false, busy: true })]).phases).toEqual(["off", "off"]);
  });

  it("idle → waiting → showing once idleMs has passed (not before)", () => {
    expect(run([input(0), input(IDLE - 1), input(IDLE)]).phases).toEqual(["waiting", "waiting", "showing"]);
  });

  it("busy (task running, call, processing…) collapses at once and stops the countdown", () => {
    const { phases, state } = run([input(0), input(IDLE), input(IDLE + 1, { busy: true })]);
    expect(phases).toEqual(["waiting", "showing", "busy"]);
    expect(state.idleSince).toBeNull();
  });

  it("when work ends the countdown starts from that moment, then memories come back", () => {
    const end = 500_000;
    const { phases } = run([input(0, { busy: true }), input(end), input(end + IDLE - 1), input(end + IDLE)]);
    expect(phases).toEqual(["busy", "waiting", "waiting", "showing"]);
  });

  it("wake while showing collapses immediately and restarts the countdown from the wake time", () => {
    const shown = run([input(0), input(IDLE)]).state;
    expect(shown.phase).toBe("showing");
    const woke = wakeMemories(shown, IDLE + 5_000);
    expect(woke).toEqual({ phase: "waiting", idleSince: IDLE + 5_000 });
    expect(run([input(IDLE + 5_000 + IDLE - 1)], woke).phases).toEqual(["waiting"]);
    expect(run([input(IDLE + 5_000 + IDLE)], woke).phases).toEqual(["showing"]);
  });

  it("wake while off stays off", () => {
    expect(wakeMemories(MEMORIES_OFF, 10)).toBe(MEMORIES_OFF);
  });

  it("with no items it never shows; showing falls back to waiting when the list empties", () => {
    expect(run([input(0, { hasItems: false }), input(IDLE * 10, { hasItems: false })]).phases).toEqual(["waiting", "waiting"]);
    const shown = run([input(0), input(IDLE)]).state;
    expect(stepMemories(shown, input(IDLE + 1, { hasItems: false })).phase).toBe("waiting");
  });

  it("an unchanged step returns the same object (no needless re-render)", () => {
    const s = run([input(0)]).state;
    expect(stepMemories(s, input(1))).toBe(s);
  });
});

describe("settings", () => {
  it("defaults: off, 8 s per photo, 60 s idle, video muted; cache cap 2 GiB", () => {
    expect(DEFAULT_MEMORIES_PREFS).toEqual({ enabled: false, dwell_s: 8, idle_s: 60, video_sound: false });
    expect(MEMORIES_CACHE_CAP_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it("parseMemoriesPatch accepts listed values and refuses anything else", () => {
    expect(parseMemoriesPatch({ enabled: true, dwell_s: 20, idle_s: 300, video_sound: true })).toEqual({ enabled: true, dwell_s: 20, idle_s: 300, video_sound: true });
    for (const bad of [null, [], { dwell_s: 7 }, { idle_s: 61 }, { enabled: "yes" }, { path: "/etc" }]) {
      expect(() => parseMemoriesPatch(bad)).toThrow(MemoriesPatchError);
    }
  });
});

describe("memoryCaption", () => {
  const now = new Date(2026, 10, 6, 15, 0); // 2026-11-06 15:00 本機時間
  const hsinchu = { zh: "新竹", en: "Hsinchu" };
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
  const rows: [string, number | null, { zh: string; en: string } | null, string | null, string | null][] = [
    ["same day", at(2026, 11, 6, 8), null, "今天", "Today"],
    ["under a week", at(2026, 11, 2), null, "這個星期", "This week"],
    ["weeks", at(2026, 10, 20), null, "兩個星期前", "2 weeks ago"],
    ["one week", at(2026, 10, 29), null, "一個星期前", "1 week ago"],
    ["months", at(2026, 6, 1), null, "五個月前", "5 months ago"],
    ["one year ago today", at(2025, 11, 6), null, "一年前的今天", "A year ago today"],
    ["last year", at(2025, 3, 1), null, "去年", "Last year"],
    ["n years ago today", at(2023, 11, 6), null, "三年前的今天", "3 years ago today"],
    ["n years", at(2023, 5, 1), hsinchu, "三年前在新竹", "3 years ago in Hsinchu"],
    ["over ten years", at(2014, 5, 1), null, "12 年前", "12 years ago"],
    ["place only", null, hsinchu, "在新竹", "In Hsinchu"],
    ["future (clock skew) with place", at(2027, 1, 1), hsinchu, "在新竹", "In Hsinchu"],
    ["future without place", at(2027, 1, 1), null, null, null],
    ["nothing", null, null, null, null],
  ];
  it.each(rows)("%s", (_name, takenAt, place, zh, en) => {
    expect(memoryCaption({ taken_at: takenAt, place }, now, "zh-TW")).toBe(zh);
    expect(memoryCaption({ taken_at: takenAt, place }, now, "en")).toBe(en);
  });
});
