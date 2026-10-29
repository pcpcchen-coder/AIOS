// desktop/memory-ipc.mjs 的型別（給 tests/memory-ipc.test.ts；App 本身直接跑 .mjs）。
export const MEMORY_OPS: readonly string[];
export function validateMemoryRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };
