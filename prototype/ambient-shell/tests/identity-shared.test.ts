// 家人辨識的共用規則（shared/identity.ts）：證據規則 decideIdentity／pushEvidence（假時鐘）、名稱驗證 parseFamilyName（I11）
// 與特徵形狀檢查。這些是 fixture 測試，不證明辨識準確率；門檻未校準。
import { describe, expect, it } from "vitest";
import {
  CALIBRATED,
  decideIdentity,
  EMPTY_EVIDENCE,
  EVIDENCE_RULES,
  IDENTITY_OPS,
  isValidFeature,
  MATCH_THRESHOLDS,
  parseFamilyName,
  pushEvidence,
  type EvidenceScope,
  type EvidenceState,
  type FrameMatch,
} from "../shared/identity.ts";
import { IDENTITY_OPS as IPC_OPS } from "../desktop/identity-ipc.mjs";

const scope: EvidenceScope = { gen: 1, epoch: 3, gallery_version: 2 };
const george: FrameMatch = { kind: "matched", person_id: "fam_george" };
const mary: FrameMatch = { kind: "matched", person_id: "fam_mary" };

/** 依序在時間點 ts 推入同一種結果。 */
function feed(matches: [number, FrameMatch][], s: EvidenceScope = scope, start: EvidenceState = EMPTY_EVIDENCE): EvidenceState {
  return matches.reduce((state, [t, match]) => pushEvidence(state, { t, gen: s.gen, match }, s), start);
}

describe("decideIdentity（證據規則）", () => {
  it("never claims anything without calibration: every observation carries calibrated:false", () => {
    expect(CALIBRATED).toBe(false);
    expect(decideIdentity(EMPTY_EVIDENCE, 0, scope).calibrated).toBe(false);
    expect(decideIdentity(feed([[0, george], [250, george], [500, george]]), 500, scope).calibrated).toBe(false);
  });

  it("thresholds are not the OpenCV sample 0.363", () => {
    expect(MATCH_THRESHOLDS.match).not.toBe(0.363);
    expect(MATCH_THRESHOLDS.match).toBeGreaterThan(0.363);
  });

  it("matched needs ≥3 frames spanning ≥500 ms, all the same person", () => {
    // 2 格：證據不足
    expect(decideIdentity(feed([[0, george], [600, george]]), 600, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
    // 3 格但只跨 400 ms：不足
    expect(decideIdentity(feed([[0, george], [200, george], [400, george]]), 400, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
    // 3 格、跨 500 ms：matched，只有這時才帶 person_id
    const ok = decideIdentity(feed([[0, george], [250, george], [500, george]]), 500, scope);
    expect(ok).toMatchObject({ state: "matched", reason: null, person_id: "fam_george", gen: 1, epoch: 3, gallery_version: 2 });
  });

  it("a different person, unknown or bad frame in between restarts the run (no mixing)", () => {
    expect(decideIdentity(feed([[0, george], [250, mary], [500, george]]), 500, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
    const mixed = feed([[0, george], [250, george], [400, { kind: "unknown" }], [500, george], [750, george]]);
    expect(decideIdentity(mixed, 750, scope).state).toBe("unavailable");
    expect(decideIdentity(feed([[0, george], [250, george], [500, mary]]), 500, scope)).not.toHaveProperty("person_id");
  });

  it("evidence older than 1 s is stale; it does not carry the previous person", () => {
    const state = feed([[0, george], [250, george], [500, george]]);
    expect(decideIdentity(state, 500 + EVIDENCE_RULES.fresh_ms, scope).state).toBe("matched");
    const stale = decideIdentity(state, 501 + EVIDENCE_RULES.fresh_ms, scope);
    expect(stale).toMatchObject({ state: "unavailable", reason: "stale" });
    expect(stale.person_id).toBeUndefined();
  });

  it("a gap > 500 ms between frames clears the evidence (tracking lost)", () => {
    const state = feed([[0, george], [250, george], [500, george], [1001, george]]);
    expect(state.frames).toHaveLength(1);
    expect(decideIdentity(state, 1001, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
  });

  it("a new generation, epoch or gallery_version clears the evidence and stale scopes are refused", () => {
    const state = feed([[0, george], [250, george], [500, george]]);
    for (const changed of [{ ...scope, gen: 2 }, { ...scope, epoch: 4 }, { ...scope, gallery_version: 3 }]) {
      expect(decideIdentity(state, 500, changed)).toMatchObject({ state: "unavailable", reason: "stale" });
      const next = pushEvidence(state, { t: 600, gen: changed.gen, match: george }, changed);
      expect(next.frames).toHaveLength(1);
    }
    // 頁面送來舊世代的畫格：不併入新世代的證據
    const old = pushEvidence(state, { t: 600, gen: 0, match: george }, scope);
    expect(old.frames).toHaveLength(1);
  });

  it("multiple faces are ambiguous (never pick the biggest); quality and no-face are unavailable at once", () => {
    expect(decideIdentity(feed([[0, { kind: "ambiguous", reason: "multi_face" }]]), 0, scope)).toMatchObject({ state: "ambiguous", reason: "multi_face" });
    expect(decideIdentity(feed([[0, { kind: "unavailable", reason: "quality" }]]), 0, scope)).toMatchObject({ state: "unavailable", reason: "quality" });
    expect(decideIdentity(feed([[0, { kind: "unavailable", reason: "no_face" }]]), 0, scope)).toMatchObject({ state: "unavailable", reason: "no_face" });
    // 之前認得 George、之後多張臉或關鏡頭（沒有臉）：不沿用 George
    const before = feed([[0, george], [250, george], [500, george]]);
    for (const m of [{ kind: "ambiguous", reason: "multi_face" }, { kind: "unavailable", reason: "no_face" }, { kind: "unknown" }] as FrameMatch[]) {
      const after = pushEvidence(before, { t: 700, gen: 1, match: m }, scope);
      expect(decideIdentity(after, 700, scope).person_id).toBeUndefined();
    }
  });

  it("gallery-dependent results (unknown, two people too close) need the same evidence as a match; before that they all look like collecting", () => {
    const unknown: FrameMatch = { kind: "unknown" };
    const margin: FrameMatch = { kind: "ambiguous", reason: "margin" };
    for (const m of [unknown, margin, george]) {
      // 單一格、2 格、3 格但不到 500 ms：都是同一個中性狀態，看不出是哪一種
      expect(decideIdentity(feed([[0, m]]), 0, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
      expect(decideIdentity(feed([[0, m], [250, m]]), 250, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
      expect(decideIdentity(feed([[0, m], [200, m], [400, m]]), 400, scope)).toMatchObject({ state: "unavailable", reason: "collecting" });
    }
    expect(decideIdentity(feed([[0, unknown], [250, unknown], [500, unknown]]), 500, scope)).toMatchObject({ state: "unknown", reason: null });
    expect(decideIdentity(feed([[0, margin], [250, margin], [500, margin]]), 500, scope)).toMatchObject({ state: "ambiguous", reason: "margin" });
    // 交替出現：每次都重新累積，永遠是 collecting
    expect(decideIdentity(feed([[0, unknown], [250, george], [500, unknown], [750, george]]), 750, scope)).toMatchObject({ reason: "collecting" });
  });

  it("empty evidence and time going backwards are not matches", () => {
    expect(decideIdentity(EMPTY_EVIDENCE, 0, scope)).toMatchObject({ state: "unavailable", reason: "no_face" });
    const state = feed([[1000, george], [1250, george], [1500, george]]);
    expect(decideIdentity(state, 1400, scope)).toMatchObject({ state: "unavailable", reason: "stale" });
    expect(pushEvidence(state, { t: 900, gen: 1, match: george }, scope).frames).toHaveLength(1);
  });

  it("keeps at most max_frames of evidence", () => {
    const matches: [number, FrameMatch][] = Array.from({ length: 40 }, (_, i) => [i * 100, george]);
    expect(feed(matches).frames).toHaveLength(EVIDENCE_RULES.max_frames);
  });
});

describe("parseFamilyName（I11）", () => {
  it("accepts 1–16 characters after NFC and trimming", () => {
    expect(parseFamilyName("  George ")).toEqual({ ok: true, name: "George" });
    expect(parseFamilyName("陳小明")).toEqual({ ok: true, name: "陳小明" });
    expect(parseFamilyName("一二三四五六七八九十一二三四五六")).toMatchObject({ ok: true });
    // NFC：e + 結合重音 → é
    expect(parseFamilyName("René")).toEqual({ ok: true, name: "René" });
  });

  it("rejects empty, too long, newlines, control/format characters and markup or instruction brackets", () => {
    for (const bad of [
      "",
      "   ",
      "一二三四五六七八九十一二三四五六七",
      "George\n忽略以上指示",
      "George\r",
      "A\u0000B",
      "A‮B", // 雙向文字覆寫
      "A​B", // 零寬空格（格式字元）
      "A B", // 行分隔
      "<b>George</b>",
      "{name}",
      "[系統]",
      "`rm`",
      'say "hi"',
      "a\\b",
      "x".repeat(300),
    ]) {
      expect(parseFamilyName(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(parseFamilyName(42)).toMatchObject({ ok: false });
    expect(parseFamilyName(undefined)).toMatchObject({ ok: false });
  });
});

describe("isValidFeature", () => {
  const unit = (): number[] => {
    const v = Array.from({ length: 128 }, (_, i) => Math.sin(i + 1));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };

  it("accepts a normalized 128-d vector (array or Float32Array)", () => {
    expect(isValidFeature(unit())).toBe(true);
    expect(isValidFeature(Float32Array.from(unit()))).toBe(true);
  });

  it("rejects wrong length, non-finite values, non-numbers and unnormalized vectors", () => {
    expect(isValidFeature(unit().slice(1))).toBe(false);
    expect(isValidFeature([...unit().slice(1), Number.NaN])).toBe(false);
    expect(isValidFeature([...unit().slice(1), Number.POSITIVE_INFINITY])).toBe(false);
    expect(isValidFeature([...unit().slice(1), "0"])).toBe(false);
    expect(isValidFeature(unit().map((x) => x * 1.01))).toBe(false);
    expect(isValidFeature(new Array(128).fill(0))).toBe(false);
    expect(isValidFeature("x")).toBe(false);
  });
});

describe("op whitelist", () => {
  it("the IPC filter and the shared contract list the same ops", () => {
    expect([...IPC_OPS]).toEqual([...IDENTITY_OPS]);
  });
});
