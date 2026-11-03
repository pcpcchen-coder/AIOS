import { describe, expect, it } from "vitest";
import { summarizeTrials, type RelayTrial } from "../shared/voice-relay.ts";
import { parseTrials } from "../server/integrations/voice-relay/trials.ts";

// VCR-0（docs/experiments/VOICE_COMMAND_RELAY_TEST_PLAN.md §C）：試驗統計公式。下面的試驗全部是手算用的虛構資料（fixture），不是實測結果。

let n = 0;
const trial = (patch: Partial<RelayTrial>): RelayTrial => ({
  id: `t${n++}`, targetId: "fixture_google_mini_zh", templateId: "google.next.zh1", templateVersion: 1, voiceProfileId: "google_zh_a", at: "fixture",
  kind: "positive", wake: "WAKE_OK", command: "COMMAND_OK", evidence: "human_confirmed", review: "reviewed", ...patch,
});
const repeat = (count: number, patch: Partial<RelayTrial>) => Array.from({ length: count }, () => trial(patch));

describe("summarizeTrials", () => {
  it("computes the §C formulas from hand-counted fixtures (10 trials, 7 wake, 5 correct)", () => {
    const trials = [
      ...repeat(5, {}),
      ...repeat(1, { command: "WRONG_COMMAND" }),
      ...repeat(1, { command: "UNKNOWN" }),
      ...repeat(3, { wake: "NO_WAKE", command: "NO_COMMAND" }),
      ...repeat(4, { kind: "negative", wake: "NO_WAKE", command: "NO_COMMAND" }),
      ...repeat(1, { kind: "negative", wake: "WAKE_OK", command: "NO_COMMAND" }),
      ...repeat(2, { review: "pending" }),
    ];
    const [s] = summarizeTrials(parseOk(trials));
    expect(s).toMatchObject({ trials: 10, wakeDetected: 7, correctCommand: 5, wrongCommand: 1, unknown: 1, negativeTrials: 5, falseWake: 1, pending: 2, status: "MEASURED" });
    expect(s!.wakeRate).toEqual({ num: 7, den: 10, value: 0.7 });
    expect(s!.commandRate).toEqual({ num: 5, den: 7, value: 5 / 7 });
    expect(s!.endToEndRate).toEqual({ num: 5, den: 10, value: 0.5 });
    expect(s!.falseWakeRate).toEqual({ num: 1, den: 5, value: 0.2 });
  });

  it("uses N/A (null) for zero denominators and NOT_TESTED when there are no reviewed positive trials", () => {
    const [s] = summarizeTrials(repeat(3, { review: "pending" }));
    expect(s).toMatchObject({ trials: 0, pending: 3, status: "NOT_TESTED" });
    for (const r of [s!.wakeRate, s!.commandRate, s!.endToEndRate, s!.falseWakeRate]) expect(r.value).toBeNull();
    const [noWake] = summarizeTrials(repeat(4, { wake: "NO_WAKE", command: "NO_COMMAND" }));
    expect(noWake!.wakeRate.value).toBe(0);
    expect(noWake!.commandRate).toEqual({ num: 0, den: 0, value: null });
    expect(summarizeTrials([])).toEqual([]);
  });

  it("groups by target | template@version | voice in sorted key order", () => {
    const out = summarizeTrials([trial({ voiceProfileId: "google_zh_b" }), trial({ templateVersion: 2 }), trial({})]);
    expect(out.map((s) => s.key)).toEqual([
      "fixture_google_mini_zh|google.next.zh1@1|google_zh_a",
      "fixture_google_mini_zh|google.next.zh1@1|google_zh_b",
      "fixture_google_mini_zh|google.next.zh1@2|google_zh_a",
    ]);
  });
});

function parseOk(trials: RelayTrial[]): RelayTrial[] {
  const r = parseTrials({ schemaVersion: 1, trials });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.trials;
}

describe("parseTrials", () => {
  it("rejects command results that exceed wake, commands on negative trials, unknown keys and bad enums", () => {
    const bad: [unknown, RegExp][] = [
      [{ schemaVersion: 1, trials: [trial({ wake: "NO_WAKE", command: "COMMAND_OK" })] }, /NO_COMMAND/],
      [{ schemaVersion: 1, trials: [trial({ wake: "UNKNOWN", command: "WRONG_COMMAND" })] }, /NO_COMMAND/],
      [{ schemaVersion: 1, trials: [trial({ kind: "negative", wake: "WAKE_OK", command: "COMMAND_OK" })] }, /negative/],
      [{ schemaVersion: 1, trials: [{ ...trial({}), spoken: "x" }] }, /不認得的欄位/],
      [{ schemaVersion: 1, trials: [trial({ evidence: "nous_said_so" as never })] }, /evidence/],
      [{ schemaVersion: 1, trials: [trial({ templateVersion: 0 })] }, /templateVersion/],
      [{ schemaVersion: 1, trials: [trial({ id: "dup" }), trial({ id: "dup" })] }, /重複/],
      [{ schemaVersion: 2, trials: [] }, /schemaVersion/],
      [{ schemaVersion: 1, trials: {} }, /陣列/],
      [{ schemaVersion: 1, trials: [], extra: 1 }, /不認得的欄位/],
      [[], /物件/],
    ];
    for (const [raw, error] of bad) {
      const r = parseTrials(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      if (!r.ok) expect(r.errors.join(), JSON.stringify(raw)).toMatch(error);
    }
    expect(parseTrials({ schemaVersion: 1, trials: [trial({})] }).ok).toBe(true);
  });
});
