import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCostLimit, VOICE_COST_FILE, VOICE_COST_KEEP, VoiceCostLog } from "../server/voice-cost-log.ts";
import { addResponseUsage, emptyVoiceUsage, parsePageEndReason, parseVoiceUsage, VOICE_USAGE_CAP, type VoiceCostRecord } from "../shared/voice-cost.ts";

// WK-02（F6）費用紀錄：configDir/voice-cost.jsonl，最近 500 筆、0600、沒有逐字稿與音訊、費用一律 unknown。
// usage 是 fixture 數字（不是真的帳單）。

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-voice-cost-"));
  dirs.push(dir);
  return dir;
}

function record(n: number, extra: Partial<VoiceCostRecord> = {}): VoiceCostRecord {
  return {
    v: 1,
    session_id: `rt_${n}`,
    route: "api_key",
    model: "gpt-realtime",
    source: "wake_word",
    wake_id: "int_0000000000000001",
    started_at: new Date(n * 1000).toISOString(),
    ended_at: new Date(n * 1000 + 500).toISOString(),
    connected: true,
    connected_ms: 500,
    end_reason: "ended",
    no_voice_auto_end: false,
    usage: "unknown",
    cost: "unknown",
    ...extra,
  };
}

describe("VoiceCostLog", () => {
  it("appends JSONL with mode 0600 and lists newest first", () => {
    const dir = temp();
    const log = new VoiceCostLog({ dir });
    expect(log.list()).toEqual([]);
    log.record(record(1));
    log.record(record(2, { end_reason: "no_voice", no_voice_auto_end: true }));
    expect(log.file).toBe(join(dir, VOICE_COST_FILE));
    if (process.platform !== "win32") expect(statSync(log.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(log.file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(log.list().map((r) => r.session_id)).toEqual(["rt_2", "rt_1"]);
    expect(log.list(1).map((r) => r.session_id)).toEqual(["rt_2"]);
  });

  it(`keeps only the last ${VOICE_COST_KEEP} records and skips unreadable lines`, () => {
    const log = new VoiceCostLog({ dir: temp() });
    for (let i = 1; i <= VOICE_COST_KEEP + 7; i++) log.record(record(i));
    const lines = readFileSync(log.file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(VOICE_COST_KEEP);
    expect(JSON.parse(lines[0]!).session_id).toBe("rt_8");
    expect(log.list(VOICE_COST_KEEP + 100)).toHaveLength(VOICE_COST_KEEP);
  });

  it("amend replaces the last record of the same session (a late no_voice) and appends when it is not there", () => {
    const log = new VoiceCostLog({ dir: temp() });
    log.record(record(1));
    log.record(record(2));
    log.amend(record(1, { end_reason: "no_voice", no_voice_auto_end: true }));
    expect(readFileSync(log.file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(log.list().map((r) => [r.session_id, r.end_reason])).toEqual([["rt_2", "ended"], ["rt_1", "no_voice"]]);
    log.amend(record(3));
    expect(log.list().map((r) => r.session_id)).toEqual(["rt_3", "rt_2", "rt_1"]);
  });

  it("a write failure is logged and does not throw", () => {
    const dir = temp();
    const logs: string[] = [];
    const log = new VoiceCostLog({ dir: join(dir, "\0bad"), log: (l) => logs.push(l) });
    expect(() => log.record(record(1))).not.toThrow();
    expect(logs).toEqual(["費用紀錄：寫入失敗（不影響通話）"]);
  });

  it("parseCostLimit accepts 1–500, otherwise the default 50", () => {
    expect([null, "", "0", "abc", "501", "-3", "1e2", "10"].map(parseCostLimit)).toEqual([50, 50, 50, 50, 50, 50, 50, 10]);
    expect(parseCostLimit("500")).toBe(500);
  });
});

describe("usage parsing (page → core)", () => {
  it("keeps only known non-negative numbers, floors and caps them, drops unknown keys", () => {
    expect(parseVoiceUsage(null)).toBeNull();
    expect(parseVoiceUsage([1])).toBeNull();
    expect(parseVoiceUsage({ transcript: "秘密" })).toBeNull();
    const u = parseVoiceUsage({ input_tokens: 10.7, output_tokens: 1e15, total_tokens: -1, responses: Number.NaN, audio: "x", input_audio_tokens: "3" });
    expect(u).toEqual({ ...emptyVoiceUsage(), input_tokens: 10, output_tokens: VOICE_USAGE_CAP });
    expect(Object.keys(u!)).not.toContain("audio");
  });

  it("sums Realtime response.done usage (details included); an unknown shape counts the response only", () => {
    let total = emptyVoiceUsage();
    total = addResponseUsage(total, {
      total_tokens: 150,
      input_tokens: 100,
      output_tokens: 50,
      input_token_details: { text_tokens: 40, audio_tokens: 60, cached_tokens: 20 },
      output_token_details: { text_tokens: 10, audio_tokens: 40 },
    });
    total = addResponseUsage(total, undefined);
    expect(total).toEqual({
      responses: 2,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_text_tokens: 40,
      input_audio_tokens: 60,
      input_cached_tokens: 20,
      output_text_tokens: 10,
      output_audio_tokens: 40,
    });
  });

  it("only no_voice is accepted as a page end reason", () => {
    expect(["no_voice", "ended", "page_gone", 1, null].map(parsePageEndReason)).toEqual(["no_voice", null, null, null, null]);
  });
});
