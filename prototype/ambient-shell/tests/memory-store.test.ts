import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_FILE, MemoryStore, newStoreOperation, type MemoryData, type MemoryFact, type MemorySecretBox, type MemoryStoreOptions } from "../server/memory/store.ts";

function box(key: Buffer = randomBytes(32)): MemorySecretBox {
  return {
    available: () => true,
    seal(plain) { const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]); },
    open(sealed) { const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString(); },
  };
}
const CANARY = "隔離測試不吃香菜_M0_CANARY";
const profile = { id: "fictional-a", name: "虛構甲", createdAt: "2026-10-26T00:00:00Z" };
function fact(): MemoryFact { return { id: "fact-a", profileId: profile.id, revision: 1, topic: "food", key: "coriander", value: CANARY, source: { kind: "explicit", turnId: "turn-1", at: profile.createdAt, excerpt: CANARY }, expiresAt: null }; }
function add(data: MemoryData) { data.profiles.push(profile); data.facts.push(fact()); return "saved" as const; }
let dir: string, secretBox: MemorySecretBox, key: Buffer;
let stores: MemoryStore[] = [];
async function open(extra: Partial<MemoryStoreOptions> = {}) { const store = await MemoryStore.open({ dir, secretBox, ...extra }); stores.push(store); return store; }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nous-memory-fixture-")); key = randomBytes(32); secretBox = box(key); });
afterEach(async () => { await Promise.all(stores.map(s => s.close())); stores = []; rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "darwin")("MemoryStore isolated macOS writer; fake key wrapper, real AES-GCM and lockf", () => {
  it("atomically persists data and a body-free receipt, restarts, and rejects a changed replay", async () => {
    let s = await open(); const op = newStoreOperation(0, CANARY);
    expect(await s.commit(op, add)).toEqual({ status: "saved", revision: 1 });
    expect(s.read().facts[0]!.value).toBe(CANARY);
    expect(JSON.stringify(s.read().receipts)).not.toContain(CANARY);
    expect(await s.commit(op, () => { throw Error("must not reapply"); })).toEqual({ status: "saved", revision: 1 });
    expect(await s.commit({ ...op, fingerprint: "changed" }, add)).toEqual({ status: "conflict" });
    await s.close(); s = await open();
    expect(s.receipt(op.operationId)).toEqual({ status: "saved", revision: 1 });
    expect(await s.commit(op, add)).toEqual({ status: "saved", revision: 1 });
    expect(s.read().facts).toHaveLength(1);
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).includes(Buffer.from(CANARY))).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, MEMORY_FILE)).mode & 0o777).toBe(0o600);
  });
  it("blocks a second live core and allows it after the owner exits", async () => {
    const a = await open();
    await expect(open()).rejects.toMatchObject({ code: "locked" });
    await a.close();
    const b = await open(); expect(b.read().revision).toBe(0);
  });

  it("keeps the native lock after lockf exits; another process cannot open the store", async () => {
    const s = await open();
    const contender = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/memory-store-crash.ts", dir, key.toString("hex"), "none"], { encoding: "utf8" });
    expect(contender.status).toBe(1);
    expect(contender.stderr).toContain("memory_locked");
    expect(s.read().revision).toBe(0);
  });
  it("accepts 1000 facts, restarts, and rejects the 1001st without dropping data", async () => {
    let s = await open();
    expect(await s.commit(newStoreOperation(0, "capacity-1000"), data => {
      data.profiles.push(profile);
      data.facts = Array.from({ length: 1000 }, (_, i) => ({ ...fact(), id: `fact-${i}` }));
      return "saved";
    })).toEqual({ status: "saved", revision: 1 });
    await s.close(); s = await open();
    expect(s.read().facts).toHaveLength(1000);
    const before = readFileSync(join(dir, MEMORY_FILE));
    expect(await s.commit(newStoreOperation(1, "capacity-1001"), data => { data.facts.push({ ...fact(), id: "fact-extra" }); return "saved"; })).toEqual({ status: "conflict" });
    expect(readFileSync(join(dir, MEMORY_FILE))).toEqual(before);
  });
  it("rejects symlink snapshots without reading or replacing their targets", async () => {
    const target = join(dir, "other"); writeFileSync(target, "private-target", { mode: 0o600 });
    symlinkSync(target, join(dir, MEMORY_FILE));
    await expect(open()).rejects.toMatchObject({ code: "permissions" });
    expect(readFileSync(target, "utf8")).toBe("private-target");
    expect(statSync(join(dir, MEMORY_FILE)).size).toBe(14);
  });
  it("serializes concurrent changes and refuses the stale revision", async () => {
    const s = await open();
    const results = await Promise.all([s.commit(newStoreOperation(0, "first"), add), s.commit(newStoreOperation(0, "second"), add)]);
    expect(results).toEqual([{ status: "saved", revision: 1 }, { status: "conflict" }]);
  });
  it("expires pruned operation IDs across restart and rejects changing their embedded issue time", async () => {
    let now = Date.now();
    let s = await open({ now: () => now });
    const oldest = newStoreOperation(0, "oldest", now);
    expect((await s.commit(oldest, () => "unchanged")).status).toBe("unchanged");
    for (let i = 1; i <= 2048; i++) {
      now++;
      expect((await s.commit(newStoreOperation(i, `receipt-${i}`, now), () => "unchanged")).status).toBe("unchanged");
    }
    await s.close(); s = await open({ now: () => now });
    expect(s.read().receipts).toHaveLength(2048);
    expect(s.receipt(oldest.operationId).status).toBe("receipt_expired");
    const change = () => { throw new Error("expired operation must never run"); };
    expect((await s.commit(oldest, change)).status).toBe("receipt_expired");
    expect((await s.commit({ ...oldest, issuedAt: now, expiresAt: now + 60_000, expectedRevision: 2049, fingerprint: "changed" }, change)).status).toBe("conflict");
    expect(s.read().revision).toBe(2049);
  }, 60_000);
  it("captures queued operations and isolates committed data from retained callback references", async () => {
    let s = await open();
    const op = newStoreOperation(0, "captured operation");
    const operationId = op.operationId;
    let retained!: MemoryData;
    const pending = s.commit(op, data => { add(data); retained = data; return "saved"; });
    op.fingerprint = "caller changed command";
    op.operationId = newStoreOperation(0, "other").operationId;
    op.expectedRevision = 200;
    expect(await pending).toEqual({ status: "saved", revision: 1 });
    retained.profiles[0]!.name = "mutated after save";
    retained.facts[0]!.value = "mutated after save";
    expect(s.read().profiles[0]!.name).toBe("虛構甲");
    expect(s.read().facts[0]!.value).toBe(CANARY);
    expect(s.receipt(operationId)).toEqual({ status: "saved", revision: 1 });
    expect(s.receipt(op.operationId).status).toBe("receipt_expired");
    await s.close(); s = await open();
    expect(s.read().profiles[0]!.name).toBe("虛構甲");
    expect(s.read().facts[0]!.value).toBe(CANARY);
  });
  it.each(["before_write", "after_file_sync"] as const)("fails closed on isolated ENOSPC at %s without success or plaintext", async stage => {
    let s = await open(); await s.commit(newStoreOperation(0, "seed"), add); await s.close();
    const before = readFileSync(join(dir, MEMORY_FILE));
    s = await open({ checkpoint: point => { if (point === stage) throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }); } });
    const op = newStoreOperation(1, "forget disk full");
    expect(await s.commit(op, data => { data.facts = []; return "forgotten"; })).toEqual({ status: "unavailable" });
    expect(readFileSync(join(dir, MEMORY_FILE))).toEqual(before);
    await s.close(); s = await open();
    expect(s.read().facts[0]!.value).toBe(CANARY);
    expect(s.receipt(op.operationId).status).toBe("receipt_expired");
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).includes(Buffer.from(CANARY))).toBe(false);
  });
  it.each(["before_write", "after_file_sync", "after_rename", "after_dir_sync"] as const)("recovers complete old/new data and matching receipt after writer crash at %s", async testingCrashAt => {
    let s = await open(); await s.commit(newStoreOperation(0, "seed"), add); await s.close();
    const op = newStoreOperation(1, "forget");
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/memory-store-crash.ts", dir, key.toString("hex"), testingCrashAt, JSON.stringify(op)], { encoding: "utf8" });
    expect(crashed.signal).toBe("SIGKILL");
    s = await open();
    const committed = ["after_rename", "after_dir_sync"].includes(testingCrashAt);
    expect(s.read().revision).toBe(committed ? 2 : 1);
    expect(s.read().facts).toHaveLength(committed ? 0 : 1);
    expect(s.receipt(op.operationId).status).toBe(committed ? "forgotten" : "receipt_expired");
    expect(readdirSync(dir).filter(n => n.includes(".tmp-"))).toEqual([]);
    if (committed) expect(JSON.stringify(s.read())).not.toContain(CANARY);
  });
  it("does not reset corrupt data or use a plaintext fallback on key denial", async () => {
    let s = await open(); await s.commit(newStoreOperation(0, "seed"), add); await s.close();
    const file = join(dir, MEMORY_FILE), bytes = readFileSync(file);
    await expect(open({ secretBox: { ...secretBox, available: () => false } })).rejects.toMatchObject({ code: "key_unavailable" });
    await expect(open({ secretBox: box() })).rejects.toMatchObject({ code: "key_unavailable" });
    expect(readFileSync(file)).toEqual(bytes);
    const parsed = JSON.parse(bytes.toString()); parsed.tag = randomBytes(16).toString("base64"); writeFileSync(file, JSON.stringify(parsed));
    await expect(open()).rejects.toMatchObject({ code: "corrupt" });
    expect(readFileSync(file).toString()).toBe(JSON.stringify(parsed));
  });
  it("fails closed when permissions are too broad or a write cannot replace the snapshot", async () => {
    const s = await open(); await s.commit(newStoreOperation(0, "seed"), add);
    const original = readFileSync(join(dir, MEMORY_FILE));
    chmodSync(dir, 0o755);
    expect(await s.commit(newStoreOperation(1, "forget"), data => { data.facts = []; return "forgotten"; })).toEqual({ status: "unavailable" });
    expect(readFileSync(join(dir, MEMORY_FILE))).toEqual(original);
    await expect(open()).rejects.toMatchObject({ code: "permissions" });
    chmodSync(dir, 0o700);
  });
  it("rejects expiry, malformed state, excess capacity, and imported stale operations", async () => {
    const now = Date.now(), s = await open({ now: () => now });
    expect(await s.commit(newStoreOperation(0, "future", now + 1), add)).toEqual({ status: "receipt_expired" });
    expect(await s.commit(newStoreOperation(0, "old", now - 60_001), add)).toEqual({ status: "receipt_expired" });
    expect(await s.commit(newStoreOperation(0, "invalid", now), data => { data.facts.push(fact()); return "saved"; })).toEqual({ status: "conflict" });
    expect(await s.commit(newStoreOperation(0, "overflow", now), data => { data.profiles.push(profile); data.facts = Array.from({ length: 1001 }, (_, i) => ({ ...fact(), id: `fact-${i}` })); return "saved"; })).toEqual({ status: "conflict" });
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
  });
  it("rotates envelope key and nonce; clears old body on correction and forgetting", async () => {
    const s = await open(); await s.commit(newStoreOperation(0, "seed"), add);
    const e1 = JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8"));
    expect(await s.commit(newStoreOperation(1, "correct"), data => { data.facts[0] = { ...fact(), value: "可以吃香菜", source: { ...fact().source, excerpt: "可以吃香菜" }, revision: 2 }; return "updated"; })).toEqual({ status: "updated", revision: 2 });
    const e2 = JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8"));
    expect(e2.nonce).not.toBe(e1.nonce); expect(e2.wrappedKey).not.toBe(e1.wrappedKey);
    expect(JSON.stringify(s.read())).not.toContain(CANARY);
    await s.commit(newStoreOperation(2, "forget"), data => { data.facts = []; return "forgotten"; });
    expect(s.read().facts).toEqual([]);
  });
});
