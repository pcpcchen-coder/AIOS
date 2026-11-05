// shared/memory-validate.mjs 的型別（核心的終端機路由、desktop/memory-ipc.mjs 與測試共用）。
export const MEMORY_OPS: readonly string[];
export function validateMemoryRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };
