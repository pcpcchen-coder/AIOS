// desktop/identity-ipc.mjs 的型別（給 tests/identity-ipc.test.ts；App 本身直接跑 .mjs）。

export const IDENTITY_OPS: readonly string[];
export const MENU_CLICK_WINDOW_MS: number;

export function checkIdentitySender(
  event: { sender?: { mainFrame?: unknown } | null; senderFrame?: { url?: string } | null } | null | undefined,
  win: { webContents: unknown; isDestroyed?(): boolean } | null | undefined,
  coreUrl: string | null | undefined,
): boolean;

export function validateIdentityRequest(req: unknown): { ok: true; request: Record<string, unknown> & { op: string } } | { ok: false; error: string };

export class MenuClickWindow {
  constructor(windowMs?: number);
  mark(now: number): void;
  consume(now: number): boolean;
}
