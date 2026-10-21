import { describe, expect, it } from "vitest";
import { matchApproval } from "../src/approval.ts";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { reduceShell, initialShell } from "../src/shell-state.ts";

describe("matchApproval", () => {
  it("approves only 確認／確定 + an action verb", () => {
    for (const t of ["確認執行", "確認寄出。", "好，確定發布", "確認 送出"]) expect(matchApproval(t)).toBe("approve");
  });
  it("bare agreement does not count", () => {
    for (const t of ["好", "可以", "確認", "OK", "對", "嗯嗯", ""]) expect(matchApproval(t)).toBeNull();
  });
  it("any cancel word rejects, even next to 確認", () => {
    for (const t of ["取消", "不要寄", "算了", "確認取消", "確認執行，不對，不要"]) expect(matchApproval(t)).toBe("reject");
  });
});

describe("confirm surface", () => {
  it("is shown with action_confirmation and only allowed while the approval is pending", () => {
    const shell = reduceShell(initialShell, { type: "show.confirm", request_id: "apr_1", message: "mail · send" });
    expect(shell.mode).toBe("confirming");
    expect(shell.surface).toMatchObject({ kind: "confirm", visibility_reason: "action_confirmation", request_id: "apr_1" });
    const base = { userRequestIds: new Set<string>(), tasks: new Map() };
    expect(evaluateSurface(shell.surface, { ...base, pendingConfirmIds: new Set(["apr_1"]) })).toEqual({ allowed: true });
    expect(evaluateSurface(shell.surface, { ...base, pendingConfirmIds: new Set() }).allowed).toBe(false);
  });
});
