import { describe, expect, it } from "vitest";
import { chunkForAppend, parseFramelessEvent } from "../shared/frameless.ts";

// frameless（gpt-live-1-codex v3）事件的解析與 append 切段；事件形狀是 fixture，依 OpenClaw／Codex 原始碼整理。

describe("parseFramelessEvent", () => {
  it("maps the frameless events both the page and the core read", () => {
    expect(parseFramelessEvent({ type: "session.started", session: { expires_at: 1_800_000_000 } })).toEqual({ kind: "session.started", expires_at: 1_800_000_000_000 });
    expect(parseFramelessEvent({ type: "input_transcript.added", item: { id: "it_1", text: "客廳" } })).toEqual({ kind: "transcript", role: "user", text: "客廳", final: false, item_id: "it_1" });
    expect(parseFramelessEvent({ type: "output_transcript.added", item: { text: "好" } })).toMatchObject({ role: "assistant", final: false, item_id: null });
    expect(parseFramelessEvent({ type: "turn.done", turn: { role: "user", transcript: "客廳燈打開", id: "t1" } })).toEqual({ kind: "transcript", role: "user", text: "客廳燈打開", final: true, item_id: "t1" });
    expect(parseFramelessEvent({ type: "output_audio_buffer.cleared" })).toEqual({ kind: "audio.cleared" });
    expect(
      parseFramelessEvent({ type: "delegation.created", item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "開" }, { type: "input_text", text: "燈" }, { type: "other", text: "x" }] } }),
    ).toEqual({ kind: "delegation", id: "d1", text: "開燈" });
  });

  it("does not treat session.updated as started, and has no session.closed (sideband close is the end signal)", () => {
    expect(parseFramelessEvent({ type: "session.updated", session: {} })).toBeNull();
    expect(parseFramelessEvent({ type: "session.closed", reason: "expired" })).toBeNull();
  });

  it("flags fatal auth errors and ignores malformed or unknown events", () => {
    expect(parseFramelessEvent({ type: "error", error: { code: "invalid_token", message: "bad" } })).toMatchObject({ kind: "error", fatal: true });
    expect(parseFramelessEvent({ type: "error", status: 401, message: "no" })).toMatchObject({ fatal: true, status: 401 });
    expect(parseFramelessEvent({ type: "error", error: { code: "rate_limited", message: "slow" } })).toMatchObject({ fatal: false });
    for (const raw of [null, "x", { type: 1 }, { type: "delegation.created", item: { type: "delegation", target: "server", id: "d" } }, { type: "turn.done", turn: { role: "x" } }, { type: "response.done" }]) {
      expect(parseFramelessEvent(raw)).toBeNull();
    }
  });
});

describe("chunkForAppend", () => {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");

  it("splits into ≤500-byte UTF-8 pieces on code-point boundaries that concatenate back", () => {
    const text = "燈已送出，請看一下有沒有亮。🙂".repeat(30); // 多位元組字元與 4 位元組 emoji
    const pieces = chunkForAppend(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(bytes(p)).toBeLessThanOrEqual(500);
      expect(Buffer.from(p, "utf8").toString("utf8")).toBe(p); // 沒有切斷的字元
    }
    expect(pieces.join("")).toBe(text);
  });

  it("caps the total at 1,800 characters with a [truncated] marker", () => {
    const pieces = chunkForAppend("字".repeat(2500));
    const joined = pieces.join("");
    expect([...joined].length).toBeLessThanOrEqual(1800);
    expect(joined.endsWith(" [truncated]")).toBe(true);
  });

  it("keeps short text byte-for-byte and returns nothing for empty text", () => {
    expect(chunkForAppend("好")).toEqual(["好"]);
    expect(chunkForAppend("")).toEqual([]);
  });
});
