import { describe, expect, it, vi } from "vitest";
import { createMemorySecretBox } from "../desktop/memory-safe-storage.mjs";

function fixture() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((_plain: string): Buffer => Buffer.from("fixture ciphertext")),
    decryptString: vi.fn((_sealed: Buffer): string => "fixture key"),
  };
}

describe("memory safeStorage adapter (fixture, no Keychain)", () => {
  it("does not inspect or unlock storage when constructed", () => {
    const safeStorage = fixture();
    createMemorySecretBox({ safeStorage, platform: "darwin" });
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it("uses the locked runtime's synchronous interface when explicitly called", () => {
    const safeStorage = fixture();
    const box = createMemorySecretBox({ safeStorage, platform: "darwin", ready: () => true });
    const sealed = box.seal("synthetic key");
    expect(safeStorage.encryptString).toHaveBeenCalledWith("synthetic key");
    expect(box.open(sealed)).toBe("fixture key");
    expect(safeStorage.decryptString).toHaveBeenCalledWith(sealed);
  });

  it("fails closed on unavailable platforms, before ready, denial and exceptions", () => {
    for (const options of [
      { platform: "linux" as const },
      { platform: "darwin" as const, ready: () => false },
      { platform: "darwin" as const, denied: true },
      { platform: "darwin" as const, failed: true },
    ]) {
      const safeStorage = fixture();
      if (options.denied) safeStorage.isEncryptionAvailable.mockReturnValue(false);
      if (options.failed) safeStorage.isEncryptionAvailable.mockImplementation(() => { throw new Error("denied"); });
      const box = createMemorySecretBox({ safeStorage, ...options });
      expect(box.available()).toBe(false);
      expect(() => box.seal("canary")).toThrow("memory_key_unavailable");
      expect(() => box.open(Buffer.from("ciphertext"))).toThrow("memory_key_unavailable");
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
    }
  });

  it("never falls back after encryption or decryption fails", () => {
    const safeStorage = fixture();
    safeStorage.encryptString.mockImplementation(() => { throw new Error("synthetic failure"); });
    safeStorage.decryptString.mockImplementation(() => { throw new Error("synthetic failure"); });
    const box = createMemorySecretBox({ safeStorage, platform: "darwin" });
    expect(() => box.seal("canary")).toThrow("memory_key_unavailable");
    expect(() => box.open(Buffer.from("ciphertext"))).toThrow("memory_key_unavailable");
  });

  it("rejects missing synchronous APIs and invalid return values", () => {
    const safeStorage = fixture();
    const box = createMemorySecretBox({ safeStorage, platform: "darwin" });
    safeStorage.encryptString.mockReturnValue(Buffer.alloc(0));
    expect(() => box.seal("key")).toThrow("memory_key_unavailable");
    Reflect.deleteProperty(safeStorage, "encryptString");
    expect(box.available()).toBe(false);
    expect(() => box.open(Buffer.from("ciphertext"))).toThrow("memory_key_unavailable");
  });
});
