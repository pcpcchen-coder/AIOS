// 家人辨識的加密保存（server/identity-store.ts）。SecretBox 用測試替身（固定的「應用程式金鑰」＋真 AES-GCM，模擬 safeStorage），
// gallery 本身的加密是真的 AES-256-GCM。macOS 的 safeStorage／Keychain 與 tmutil 沒有在這裡執行（只能在 Mac 上驗證）。
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GALLERY_FILE, GalleryStore, type SecretBox, type StoredPerson } from "../server/identity-store.ts";
import { fakeSecretBox, unitFeature } from "./fixtures/identity.ts";

const MODEL = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "a", preproc: "p" };

function person(name: string, seed: number): StoredPerson {
  return {
    person_id: `fam_${seed.toString(16).padStart(24, "0")}`,
    name,
    minor: false,
    created_at: "2026-10-25T00:00:00.000Z",
    updated_at: "2026-10-25T00:00:00.000Z",
    model: MODEL,
    features: [unitFeature(seed), unitFeature(seed + 100)],
  };
}

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "nous-identity-")), "identity");
});
afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("GalleryStore", () => {
  it("round-trips people and features; every write bumps key_generation and gallery_version", () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir, secretBox: box });
    store.init();
    expect(store.load()).toEqual({ ok: true, data: { people: [] }, key_generation: 0, gallery_version: 0 });
    const v1 = store.save({ people: [person("George", 1)] }, { key_generation: 0, gallery_version: 0 });
    expect(v1).toEqual({ key_generation: 1, gallery_version: 1 });
    const loaded = store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.key_generation).toBe(1);
    expect(loaded.data.people[0]!.name).toBe("George");
    expect(Array.from(loaded.data.people[0]!.features[0]!)).toEqual(Array.from(unitFeature(1)));
    expect(store.save(loaded.data, loaded)).toEqual({ key_generation: 2, gallery_version: 2 });
    expect(box.sealed).toBe(2); // 每次寫入都包一把新的資料金鑰
  });

  it("file is 0600 in a 0700 folder, and its bytes contain no name and no feature (raw float32 or base64)", () => {
    const store = new GalleryStore({ dir, secretBox: fakeSecretBox() });
    store.init();
    const p = person("王小明George", 7);
    store.save({ people: [p] }, { key_generation: 0, gallery_version: 0 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, GALLERY_FILE)).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(join(dir, GALLERY_FILE));
    const text = bytes.toString("utf8");
    expect(text).not.toContain("George");
    expect(text).not.toContain("王小明");
    expect(text).not.toContain(Buffer.from("George").toString("base64").slice(0, 6));
    const f = p.features[0]!;
    const raw = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
    expect(bytes.includes(raw.subarray(0, 16))).toBe(false);
    expect(text).not.toContain(raw.toString("base64").slice(0, 16));
    expect(text).not.toContain(String(f[0]).slice(0, 8));
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["cipher", "ciphertext", "format", "gallery_version", "key_generation", "nonce", "tag", "version", "wrapped_key"]);
  });

  it("tampered ciphertext, header, tag length or format → corrupt; a wrapped key the box cannot open → key_unavailable; the file is never overwritten", () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir, secretBox: box });
    store.init();
    store.save({ people: [person("George", 1)] }, { key_generation: 0, gallery_version: 0 });
    const path = join(dir, GALLERY_FILE);
    const original = readFileSync(path, "utf8");
    const file = JSON.parse(original);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[b.length - 1]! ^= 1;
      return b.toString("base64");
    };
    for (const tampered of [
      { ...file, ciphertext: flip(file.ciphertext) },
      { ...file, tag: flip(file.tag) },
      { ...file, nonce: flip(file.nonce) },
      { ...file, gallery_version: file.gallery_version + 1 }, // AAD 綁住檔頭
      { ...file, key_generation: 0 },
      { ...file, format: "other" },
      { ...file, tag: Buffer.from(file.tag, "base64").subarray(0, 12).toString("base64") }, // 短 tag（GCM 會接受截短的 tag，這裡明確拒絕）
      { ...file, ciphertext: 5 },
    ]) {
      writeFileSync(path, JSON.stringify(tampered));
      expect(store.load()).toEqual({ ok: false, reason: "corrupt" });
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(tampered)); // 不覆寫
    }
    writeFileSync(path, "not json");
    expect(store.load()).toEqual({ ok: false, reason: "corrupt" });
    // 包裝金鑰被改，或別台 Mac／鑰匙圈不給（SecretBox 解不開）：key_unavailable，可重試，不是檔案損壞
    writeFileSync(path, JSON.stringify({ ...file, wrapped_key: flip(file.wrapped_key) }));
    expect(store.load()).toEqual({ ok: false, reason: "key_unavailable" });
    writeFileSync(path, original);
    expect(new GalleryStore({ dir, secretBox: fakeSecretBox() }).load()).toEqual({ ok: false, reason: "key_unavailable" });
    const denied = fakeSecretBox();
    denied.open = () => {
      throw new Error("User canceled the keychain prompt");
    };
    expect(new GalleryStore({ dir, secretBox: denied }).load()).toEqual({ ok: false, reason: "key_unavailable" });
    expect(store.load().ok).toBe(true); // 原檔沒被動過
  });

  it("validates every stored feature on load and marks bad people as damaged (not dropped, not compared)", () => {
    const store = new GalleryStore({ dir, secretBox: fakeSecretBox() });
    store.init();
    const bad = person("Broken", 3);
    bad.features = [new Float32Array(128), unitFeature(4)]; // 一個 0 向量
    const short = person("Short", 5);
    short.features = [unitFeature(5).subarray(0, 64)];
    const nan = person("NaN", 6);
    nan.features = [unitFeature(6).map((x, i) => (i === 0 ? Number.NaN : x))];
    store.save({ people: [person("George", 1), bad, short, nan] }, { key_generation: 0, gallery_version: 0 });
    const loaded = store.load();
    expect(loaded.ok && loaded.data.people.map((p) => [p.name, p.damaged === true])).toEqual([
      ["George", false],
      ["Broken", true],
      ["Short", true],
      ["NaN", true],
    ]);
    // damaged 是載入時的判斷，不寫進檔案
    if (loaded.ok) store.save(loaded.data, loaded);
    const again = store.load();
    expect(again.ok && again.data.people.filter((p) => p.damaged).length).toBe(3);
  });

  it("prepare() is lazy and idempotent; diskVersion reads the header without decrypting", async () => {
    const exclude = vi.fn(async () => {});
    const box = fakeSecretBox();
    const opened = vi.spyOn(box, "open");
    const store = new GalleryStore({ dir, secretBox: box, excludeFromBackup: exclude });
    expect(existsSync(dir)).toBe(false); // 建構時不建資料夾
    expect(store.diskVersion()).toBeNull();
    store.prepare();
    store.prepare();
    expect(exclude).toHaveBeenCalledOnce();
    store.save({ people: [] }, { key_generation: 4, gallery_version: 9 });
    expect(store.diskVersion()).toBe(10);
    expect(opened).not.toHaveBeenCalled();
    writeFileSync(join(dir, GALLERY_FILE), "garbage");
    expect(store.diskVersion()).toBe(-1);
  });

  it("delete rotates the data key: the new file has no trace of the person; an OLD copy still opens with the same app key (residual risk, recorded)", () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir, secretBox: box });
    store.init();
    const v1 = store.save({ people: [person("George", 1), person("Mary", 2)] }, { key_generation: 0, gallery_version: 0 });
    const snapshot = join(dir, "..", "snapshot.json");
    copyFileSync(join(dir, GALLERY_FILE), snapshot); // 模擬 Time Machine／APFS 快照中的舊檔
    const before = JSON.parse(readFileSync(snapshot, "utf8"));
    const v2 = store.save({ people: [person("Mary", 2)] }, v1);
    expect(v2).toEqual({ key_generation: 2, gallery_version: 2 });
    const after = JSON.parse(readFileSync(join(dir, GALLERY_FILE), "utf8"));
    expect(after.wrapped_key).not.toBe(before.wrapped_key);
    const now = store.load();
    expect(now.ok && now.data.people.map((p) => p.name)).toEqual(["Mary"]);
    // 殘餘風險：舊檔在同一個應用程式金鑰下仍可解開（safeStorage 的金鑰不輪換）。這是照實記錄，不是要的行為。
    const old = new GalleryStore({ dir: join(dir, ".."), secretBox: box });
    writeFileSync(join(dir, "..", GALLERY_FILE), readFileSync(snapshot));
    const reopened = old.load();
    expect(reopened.ok && reopened.data.people.map((p) => p.name)).toEqual(["George", "Mary"]);
  });

  it("init removes leftover tmp files from an interrupted write; the previous gallery stays intact", () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir, secretBox: box });
    store.init();
    store.save({ people: [person("George", 1)] }, { key_generation: 0, gallery_version: 0 });
    // 寫到一半就斷電：tmp 留下半個檔，正式檔沒被換掉
    writeFileSync(join(dir, `${GALLERY_FILE}.tmp-deadbeef0000`), '{"format":"nous.identity.gallery","vers');
    const restarted = new GalleryStore({ dir, secretBox: box });
    restarted.init();
    expect(readdirSync(dir)).toEqual([GALLERY_FILE]);
    const loaded = restarted.load();
    expect(loaded.ok && loaded.data.people.map((p) => p.name)).toEqual(["George"]);
  });

  it("a failing write leaves the old file and no tmp behind", () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir, secretBox: box });
    store.init();
    store.save({ people: [person("George", 1)] }, { key_generation: 0, gallery_version: 0 });
    const before = readFileSync(join(dir, GALLERY_FILE), "utf8");
    box.seal = () => {
      throw new Error("keychain locked");
    };
    expect(() => store.save({ people: [] }, { key_generation: 1, gallery_version: 1 })).toThrow(/keychain/);
    expect(readFileSync(join(dir, GALLERY_FILE), "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual([GALLERY_FILE]);
  });

  it("remove() deletes the gallery (clear all)", () => {
    const store = new GalleryStore({ dir, secretBox: fakeSecretBox() });
    store.init();
    store.save({ people: [person("George", 1)] }, { key_generation: 0, gallery_version: 0 });
    store.remove();
    expect(existsSync(join(dir, GALLERY_FILE))).toBe(false);
    expect(store.load()).toMatchObject({ ok: true, data: { people: [] } });
  });

  it("asks for a Time Machine exclusion of the folder and records success or failure without blocking", async () => {
    const ok = vi.fn(async () => {});
    const a = new GalleryStore({ dir, secretBox: fakeSecretBox(), excludeFromBackup: ok });
    expect(a.backupExclusion()).toBe("pending");
    a.init();
    await Promise.resolve();
    await Promise.resolve();
    expect(ok).toHaveBeenCalledWith(dir);
    expect(a.backupExclusion()).toBe("excluded");
    const log = vi.fn();
    const failure = Object.assign(new Error(`tmutil: ${dir}: not permitted`), { code: 1 });
    const b = new GalleryStore({ dir, secretBox: fakeSecretBox(), excludeFromBackup: async () => Promise.reject(failure), log });
    b.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.backupExclusion()).toBe("failed");
    expect(log.mock.calls.join("\n")).toBe("identity: Time Machine 排除失敗（1）"); // 只記代碼，不記帶路徑的訊息
    // 還是可以寫入
    expect(b.save({ people: [] }, { key_generation: 0, gallery_version: 0 })).toEqual({ key_generation: 1, gallery_version: 1 });
    const c = new GalleryStore({ dir, secretBox: fakeSecretBox() });
    c.init();
    expect(c.backupExclusion()).toBe("not_applicable");
  });

  it("reports encryption availability from the SecretBox, and treats a throwing box as unavailable", () => {
    expect(new GalleryStore({ dir, secretBox: fakeSecretBox() }).encryptionAvailable()).toBe(true);
    const throwing: SecretBox = { available: () => { throw new Error("no keychain"); }, seal: () => Buffer.alloc(0), open: () => "" };
    expect(new GalleryStore({ dir, secretBox: throwing }).encryptionAvailable()).toBe(false);
  });
});
