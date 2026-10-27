export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}
export function createMemorySecretBox(options: {
  safeStorage: SafeStorageLike;
  platform?: NodeJS.Platform;
  ready?: () => boolean;
}): { available(): boolean; seal(plain: string): Buffer; open(sealed: Buffer): string };
