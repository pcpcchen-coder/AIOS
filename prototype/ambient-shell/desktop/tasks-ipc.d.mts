// desktop/tasks-ipc.mjs 的型別（給 tests/tasks-ipc.test.ts；App 本身直接跑 .mjs）。
export const TASK_OPS: readonly string[];
export function validateTasksRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };
