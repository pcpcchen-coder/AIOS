export function createMemorySecretBox({ safeStorage, platform = process.platform, ready = () => true }) {
  const unavailable = () => new Error("memory_key_unavailable");
  const available = () => {
    try {
      if (platform !== "darwin" || !ready()) return false;
      if (typeof safeStorage?.isEncryptionAvailable !== "function"
        || typeof safeStorage?.encryptString !== "function"
        || typeof safeStorage?.decryptString !== "function") return false;
      return safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    available,
    seal(plain) {
      if (typeof plain !== "string" || !available()) throw unavailable();
      try {
        const sealed = safeStorage.encryptString(plain);
        if (!Buffer.isBuffer(sealed) || sealed.length === 0) throw unavailable();
        return sealed;
      } catch {
        throw unavailable();
      }
    },
    open(sealed) {
      if (!Buffer.isBuffer(sealed) || sealed.length === 0 || !available()) throw unavailable();
      try {
        const plain = safeStorage.decryptString(sealed);
        if (typeof plain !== "string") throw unavailable();
        return plain;
      } catch {
        throw unavailable();
      }
    },
  });
}
