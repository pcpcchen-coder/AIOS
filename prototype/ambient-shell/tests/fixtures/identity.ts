// 家人辨識測試共用的替身（fixture）：模擬 safeStorage 的 SecretBox 與合成的單位特徵向量。都不是真的 Keychain 或真的臉。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretBox } from "../../server/identity-store.ts";

/** 模擬 safeStorage：固定的應用程式金鑰（不會輪換，和真的 safeStorage 一樣）＋真 AES-GCM。 */
export function fakeSecretBox(appKey = randomBytes(32)): SecretBox & { sealed: number } {
  const box = {
    sealed: 0,
    available: () => true,
    seal(plain: string): Buffer {
      box.sealed++;
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", appKey, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    open(sealed: Buffer): string {
      const d = createDecipheriv("aes-256-gcm", appKey, sealed.subarray(0, 12));
      d.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString("utf8");
    },
  };
  return box;
}

/** 可重現的亂數（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合成的 128 維單位向量（不是任何人的臉）；不同 seed 之間的 cosine 約在 ±0.3 內。 */
export function unitFeature(seed: number): Float32Array {
  const r = rng(seed * 7919 + 1);
  const v = Float32Array.from({ length: 128 }, () => r() * 2 - 1);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** 以 base 為中心、加一點雜訊的同一「人」特徵（cosine 約 0.95 以上）。 */
export function near(base: Float32Array, seed: number, amount = 0.05): Float32Array {
  const r = rng(seed * 104729 + 17);
  const v = base.map((x) => x + amount * (r() * 2 - 1));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
}

/** 兩個向量的正規化和（與兩者 cosine 相同，用來造「分不清是哪一位」）。 */
export function blend(a: Float32Array, b: Float32Array): Float32Array {
  const v = a.map((x, i) => x + b[i]!);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
