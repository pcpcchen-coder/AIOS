// shared/identity-validate.mjs 的型別（核心的終端機路由、desktop/identity-ipc.mjs 與測試共用）。

export const IDENTITY_OPS: readonly string[];

export function validateIdentityRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };
