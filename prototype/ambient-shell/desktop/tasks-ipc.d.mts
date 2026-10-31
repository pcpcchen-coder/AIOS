// desktop/tasks-ipc.mjs 的型別（給 tests/tasks-ipc.test.ts；App 本身直接跑 .mjs）。
export const TASK_OPS: readonly string[];
export function validateTasksRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };
export function validateConfirmDeleteRequest(req: unknown): { ok: true; request: { kind: "task"; title: string } } | { ok: false; error: string };
export function deleteTaskDialog(title: string, translate?: (source: string, ...values: string[]) => string): { type: "warning"; buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string };
export function deleteConfirmed(result: unknown): boolean;
