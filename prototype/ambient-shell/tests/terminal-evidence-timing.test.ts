import { describe, expect, it } from "vitest";
import { decideIdentity, EMPTY_EVIDENCE, pushEvidence, type EvidenceScope, type EvidenceState, type FrameMatch } from "../shared/identity.ts";
import { TERMINAL_EVIDENCE_TIMING } from "../shared/terminal.ts";

const scope: EvidenceScope = { gen: 1, epoch: 1, gallery_version: 1 };
const matched: FrameMatch = { kind: "matched", person_id: "fixture-george" };
function evidence(times: number[], terminal: boolean): EvidenceState {
  return times.reduce((state, t) => pushEvidence(state, { t, gen: 1, match: matched }, scope, terminal ? TERMINAL_EVIDENCE_TIMING : undefined), EMPTY_EVIDENCE);
}

describe("bounded terminal evidence timing with synthetic matches", () => {
  it("accumulates three slow frames without changing Mac continuity", () => {
    const terminal = evidence([0, 600, 1200], true);
    expect(terminal.frames).toHaveLength(3);
    expect(decideIdentity(terminal, 1200, scope, TERMINAL_EVIDENCE_TIMING).state).toBe("matched");
    const main = evidence([0, 600, 1200], false);
    expect(main.frames).toHaveLength(1);
    expect(decideIdentity(main, 1200, scope).reason).toBe("collecting");
  });
  it("accepts the terminal gap boundary and discards evidence beyond it", () => {
    expect(evidence([0, 2000, 4000], true).frames).toHaveLength(3);
    expect(evidence([0, 2001, 4002], true).frames).toHaveLength(1);
  });
  it("expires terminal evidence beyond two seconds and keeps the Mac one-second limit", () => {
    const terminal = evidence([0, 600, 1200], true);
    expect(decideIdentity(terminal, 3200, scope, TERMINAL_EVIDENCE_TIMING).state).toBe("matched");
    expect(decideIdentity(terminal, 3201, scope, TERMINAL_EVIDENCE_TIMING).reason).toBe("stale");
    const main = evidence([0, 250, 500], false);
    expect(decideIdentity(main, 1500, scope).state).toBe("matched");
    expect(decideIdentity(main, 1501, scope).reason).toBe("stale");
  });
  it("still requires three frames even when two frames span enough time", () => {
    expect(decideIdentity(evidence([0, 600], true), 600, scope, TERMINAL_EVIDENCE_TIMING).reason).toBe("collecting");
  });
  it.each(["gen", "epoch", "gallery_version"] as const)("resets on a different %s", (key) => {
    const changed = { ...scope, [key]: 2 };
    const state = pushEvidence(evidence([0, 600, 1200], true), { t: 1500, gen: changed.gen, match: matched }, changed, TERMINAL_EVIDENCE_TIMING);
    expect(state.frames).toHaveLength(1);
    expect(decideIdentity(state, 1500, changed, TERMINAL_EVIDENCE_TIMING).reason).toBe("collecting");
  });
  it.each<FrameMatch>([
    { kind: "matched", person_id: "fixture-mary" }, { kind: "unknown" },
    { kind: "ambiguous", reason: "multi_face" }, { kind: "unavailable", reason: "quality" }, { kind: "unavailable", reason: "no_face" },
  ])("does not retain the previous name after $kind", (match) => {
    const state = pushEvidence(evidence([0, 600, 1200], true), { t: 1500, gen: 1, match }, scope, TERMINAL_EVIDENCE_TIMING);
    expect(state.frames).toHaveLength(1);
    const decision = decideIdentity(state, 1500, scope, TERMINAL_EVIDENCE_TIMING);
    expect(decision.state).not.toBe("matched");
    expect(decision.person_id).toBeUndefined();
  });
});
