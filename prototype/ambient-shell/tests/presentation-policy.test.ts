import { describe, expect, it } from "vitest";
import { evaluateSurface } from "../src/presentation-policy.ts";
import type { Surface } from "../src/shell-state.ts";
import type { Task } from "../shared/types.ts";
import { makeTask } from "./fixtures.ts";

const base: Surface = {
  surface_id: "surface_progress_req_aaaaaaaa",
  kind: "progress",
  visibility_reason: "user_request",
  request_id: "req_aaaaaaaa",
  task_id: null,
  artifact_id: null,
  message: null,
};

function ctx(tasks: Task[] = [], requests = ["req_aaaaaaaa"]) {
  return { userRequestIds: new Set(requests), tasks: new Map(tasks.map((t) => [t.task_id, t])) };
}

describe("evaluateSurface", () => {
  it("沒有 Surface 時允許（回到電子腦）", () => {
    expect(evaluateSurface(null, ctx()).allowed).toBe(true);
  });

  it("有真實使用者請求的進度 Surface 可以呈現", () => {
    expect(evaluateSurface(base, ctx()).allowed).toBe(true);
  });

  it("request_id 不是使用者輸入時拒絕（模型不能自行捏造 user_request）", () => {
    expect(evaluateSurface(base, ctx([], [])).allowed).toBe(false);
  });

  it("原型尚未支援的可見理由一律拒絕", () => {
    const s: Surface = { ...base, visibility_reason: "subscribed_event" };
    expect(evaluateSurface(s, ctx())).toEqual({ allowed: false, reason: expect.stringContaining("尚未支援") });
  });

  const artifactSurface: Surface = { ...base, kind: "artifact", task_id: "task_1", artifact_id: "artifact_1" };

  it("成果只能來自已成功的同一任務", () => {
    const ok = makeTask({ status: "succeeded", artifact_id: "artifact_1" });
    expect(evaluateSurface(artifactSurface, ctx([ok])).allowed).toBe(true);
    expect(evaluateSurface(artifactSurface, ctx([{ ...ok, status: "running" }])).allowed).toBe(false);
    expect(evaluateSurface(artifactSurface, ctx([{ ...ok, artifact_id: "artifact_9" }])).allowed).toBe(false);
    expect(evaluateSurface(artifactSurface, ctx([])).allowed).toBe(false);
  });

  it("失敗畫面只給真的失敗的任務", () => {
    const s: Surface = { ...base, kind: "error", task_id: "task_1" };
    expect(evaluateSurface(s, ctx([makeTask({ status: "failed" })])).allowed).toBe(true);
    expect(evaluateSurface(s, ctx([makeTask({ status: "succeeded" })])).allowed).toBe(false);
  });
});

describe("memory surface", () => {
  const memory: Surface = { ...base, surface_id: "surface_memory_req_aaaaaaaa", kind: "memory" };
  it("需要真實的使用者請求；不能冒用外部動作的確認理由", () => {
    expect(evaluateSurface(memory, ctx()).allowed).toBe(true);
    expect(evaluateSurface(memory, ctx([], ["req_other000"]))).toEqual({ allowed: false, reason: "找不到對應的使用者請求" });
    expect(evaluateSurface({ ...memory, visibility_reason: "action_confirmation" }, { ...ctx(), pendingConfirmIds: new Set(["req_aaaaaaaa"]) })).toEqual({ allowed: false, reason: "確認卡與 action_confirmation 必須成對" });
    expect(evaluateSurface({ ...memory, visibility_reason: "sensor_status" }, ctx()).allowed).toBe(false);
  });
});
