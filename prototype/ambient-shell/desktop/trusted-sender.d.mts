// desktop/trusted-sender.mjs 的型別。
export function checkTrustedSender(
  event: { sender?: { mainFrame?: unknown } | null; senderFrame?: { url?: string } | null } | null | undefined,
  win: { webContents: unknown; isDestroyed?(): boolean } | null | undefined,
  coreUrl: string | null | undefined,
): boolean;
export function sameOrigin(url: string | null | undefined, coreUrl: string | null | undefined): boolean;
