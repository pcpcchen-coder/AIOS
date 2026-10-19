import { SCHEMA_VERSION, type Task, type TaskStep } from "../shared/types.ts";

export function step(title: string, status: TaskStep["status"], output_chars: number | null = null): TaskStep {
  return {
    title,
    status,
    started_at: status === "pending" ? null : "2026-10-19T10:00:00.000Z",
    finished_at: status === "done" ? "2026-10-19T10:00:05.000Z" : null,
    output_chars,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: "task_1",
    request_id: "req_aaaaaaaa",
    title: "整理本週會議重點",
    status: "running",
    mode: "mock",
    model: null,
    plan_ready: false,
    steps: [],
    created_at: "2026-10-19T10:00:00.000Z",
    updated_at: "2026-10-19T10:00:00.000Z",
    finished_at: null,
    error: null,
    artifact_id: null,
    retry_of: null,
    ...overrides,
  };
}
