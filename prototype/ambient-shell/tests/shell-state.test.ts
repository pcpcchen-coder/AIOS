import { describe, expect, it } from "vitest";
import { initialShell, reduceShell, type ShellEvent, type ShellState } from "../src/shell-state.ts";
import { makeTask } from "./fixtures.ts";

const run = (events: ShellEvent[], start: ShellState = initialShell) => events.reduce(reduceShell, start);
const submitted: ShellEvent = { type: "task.submitted", task_id: "task_1", request_id: "req_aaaaaaaa" };
const succeeded = makeTask({ status: "succeeded", artifact_id: "artifact_1" });

describe("reduceShell", () => {
  it("待機畫面沒有任何 Surface", () => {
    expect(initialShell).toEqual({ mode: "ambient", listening: false, foreground_task_id: null, surface: null });
  });

  it("交辦後進入 working，前景任務完成時呈現成果（理由為該次 user_request）", () => {
    const s = run([{ type: "input.open" }, submitted, { type: "task.updated", task: succeeded }]);
    expect(s.mode).toBe("presenting");
    expect(s.listening).toBe(false);
    expect(s.surface).toMatchObject({
      kind: "artifact",
      visibility_reason: "user_request",
      request_id: "req_aaaaaaaa",
      artifact_id: "artifact_1",
    });
  });

  it("收起只關視圖：回到 ambient，且 reducer 不產生取消", () => {
    const s = run([submitted, { type: "dismiss" }]);
    expect(s).toEqual(initialShell);
  });

  it("收起後背景完成不會自己跳出來（AC-06）", () => {
    const s = run([submitted, { type: "dismiss" }, { type: "task.updated", task: succeeded }]);
    expect(s).toEqual(initialShell);
  });

  it("非前景任務的完成不搶走目前畫面", () => {
    const other = makeTask({ task_id: "task_2", status: "succeeded", artifact_id: "artifact_2" });
    const s = run([submitted, { type: "task.updated", task: other }]);
    expect(s.mode).toBe("working");
    expect(s.surface).toBeNull();
  });

  it("前景任務失敗進入 recoverable_error 並帶真實錯誤", () => {
    const failed = makeTask({ status: "failed", error: "連線逾時" });
    const s = run([submitted, { type: "task.updated", task: failed }]);
    expect(s.mode).toBe("recoverable_error");
    expect(s.surface).toMatchObject({ kind: "error", message: "連線逾時", task_id: "task_1" });
  });

  it("前景任務被停止後回到 ambient", () => {
    const s = run([submitted, { type: "task.updated", task: makeTask({ status: "cancelled" }) }]);
    expect(s).toEqual(initialShell);
  });

  it("聆聽是疊層：關閉輸入後保留原本的成果畫面", () => {
    const presenting = run([{ type: "show.progress", request_id: "req_bbbbbbbb" }]);
    const s = run([{ type: "input.open" }, { type: "input.close" }], presenting);
    expect(s.surface).toEqual(presenting.surface);
    expect(s.mode).toBe("presenting");
  });

  it("問進度時呈現進度 Surface；正在看進度時任務完成不切換畫面", () => {
    const s = run([
      submitted,
      { type: "show.progress", request_id: "req_cccccccc" },
      { type: "task.updated", task: succeeded },
    ]);
    expect(s.surface).toMatchObject({ kind: "progress", request_id: "req_cccccccc" });
  });

  it("問設定時呈現設定 Surface", () => {
    const s = run([{ type: "show.settings", request_id: "req_dddddddd", message: "請先登入" }]);
    expect(s.surface).toMatchObject({ kind: "settings", visibility_reason: "user_request", message: "請先登入" });
  });

  it("無關事件回傳同一個 state 物件", () => {
    expect(reduceShell(initialShell, { type: "input.close" })).toBe(initialShell);
    expect(reduceShell(initialShell, { type: "task.updated", task: succeeded })).toBe(initialShell);
  });
});
