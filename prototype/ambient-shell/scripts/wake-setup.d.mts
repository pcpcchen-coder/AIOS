// scripts/wake-setup.mjs 的型別（tests 使用）。
export function extractMembers(archive: Buffer, top: string, members: string[]): Map<string, Buffer>;
export function verifyProduct(options: {
  manifest: unknown;
  models: unknown;
  fetchBytes: (fileName: string, url: string) => Promise<Buffer | Uint8Array>;
  extract?: (archive: Buffer | Uint8Array, top: string, members: string[]) => Map<string, Buffer | Uint8Array>;
  log?: (line: string) => void;
}): Promise<Map<string, Buffer | Uint8Array>>;
export function installVerified(verified: Map<string, Buffer | Uint8Array>, dests: string[]): void;
