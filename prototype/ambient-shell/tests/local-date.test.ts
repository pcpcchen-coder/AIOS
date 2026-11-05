import { describe, expect, it } from "vitest";
import { buildChatSystem } from "../server/chat.ts";
import { buildCallerInstructions } from "../server/live-tool-caller.ts";
import { localDate, localToday, systemTimeZone, todayLine } from "../server/local-date.ts";
import { planPrompt, stepPrompt } from "../server/prompts.ts";
import { buildLiveInstructions, buildRealtimeInstructions } from "../server/realtime.ts";

// 「今天日期」用本機時區，不用 UTC（George 2026-11-05）。時刻都是固定的 fixture。

// 2026-11-04T17:00Z ＝ 台北 2026-11-05 01:00（星期四）：舊的 toISOString 寫法會說成 11-04。
const TAIPEI_1AM = new Date("2026-11-04T17:00:00Z");

describe("local date", () => {
  it("uses the local calendar day, not UTC (Taipei 00:00–08:00 was a day behind)", () => {
    expect(TAIPEI_1AM.toISOString().slice(0, 10)).toBe("2026-11-04");
    expect(localDate(TAIPEI_1AM, "Asia/Taipei")).toEqual({ date: "2026-11-05", weekday: 4 });
    expect(localToday(TAIPEI_1AM, "Asia/Taipei")).toBe("2026-11-05");
    expect(todayLine(TAIPEI_1AM, "Asia/Taipei")).toBe("今天日期：2026-11-05（星期四，Asia/Taipei）。");
  });

  it("handles year and week boundaries and zones behind UTC", () => {
    expect(todayLine(new Date("2026-12-31T16:30:00Z"), "Asia/Taipei")).toBe("今天日期：2027-01-01（星期五，Asia/Taipei）。");
    expect(todayLine(new Date("2026-11-08T03:00:00Z"), "America/Los_Angeles")).toBe("今天日期：2026-11-07（星期六，America/Los_Angeles）。");
    expect(todayLine(new Date("2026-11-08T12:00:00Z"), "UTC")).toBe("今天日期：2026-11-08（星期日，UTC）。");
  });

  it("the system time zone is a real IANA name", () => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: systemTimeZone() })).not.toThrow();
  });

  it("every prompt that states today's date uses the local line (both voice routes, the caller, background tasks)", () => {
    const line = todayLine(TAIPEI_1AM);
    const caps = { webSearch: true, mcp: [], home: true };
    expect(buildRealtimeInstructions([], TAIPEI_1AM, caps)).toContain(line);
    expect(buildRealtimeInstructions([], TAIPEI_1AM, caps, "en")).toContain(line);
    expect(buildLiveInstructions([], TAIPEI_1AM, { mcp: [] })).toContain(line);
    expect(buildCallerInstructions(caps, [], TAIPEI_1AM)).toContain(line);
    expect(buildChatSystem([], TAIPEI_1AM)).toContain(line);
    for (const text of [buildRealtimeInstructions([], TAIPEI_1AM, caps), buildLiveInstructions([], TAIPEI_1AM, { mcp: [] }), buildCallerInstructions(caps, [], TAIPEI_1AM)]) {
      expect(text.match(/今天日期：/g)).toHaveLength(1);
    }
    expect(planPrompt("t")).toContain(`今天日期：${localToday()}`);
    expect(stepPrompt("t", { steps: [{ title: "a", instruction: "b", domain: "language" }], assumptions: [], capability_gaps: [] }, [], 0)).toContain(localToday());
  });
});
