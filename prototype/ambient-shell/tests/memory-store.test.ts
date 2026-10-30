import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_FILE, MemoryStore, newStoreOperation, type MemoryData, type MemoryFact, type MemorySecretBox, type MemoryStoreOptions } from "../server/memory/store.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

function box(key: Buffer = randomBytes(32)): MemorySecretBox {
  return {
    available: () => true,
    seal(plain) { const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]); },
    open(sealed) { const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString(); },
  };
}
const CANARY = "隔離測試不吃香菜_M0_CANARY";
const profile = { id: "fictional-a", name: "虛構甲", createdAt: "2026-10-26T00:00:00Z", facePersonId: null, minor: false };
function fact(): MemoryFact { return { id: "fact-a", profileId: profile.id, revision: 1, kind: "preference", topic: "food", key: "coriander", value: CANARY, audience: "household", source: { kind: "explicit", turnId: "turn-1", at: profile.createdAt, excerpt: CANARY, by: null }, validFrom: profile.createdAt, expiresAt: null, reviewAfter: null, pinned: false, derivedFrom: null }; }
function add(data: MemoryData) { data.profiles.push(profile); data.facts.push(fact()); return "saved" as const; }
let dir: string, secretBox: MemorySecretBox, key: Buffer;
let stores: MemoryStore[] = [];
async function open(extra: Partial<MemoryStoreOptions> = {}) { const store = await MemoryStore.open({ dir, secretBox, lockProvider: testLockProvider, ...extra }); stores.push(store); return store; }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nous-memory-fixture-")); key = randomBytes(32); secretBox = box(key); });
afterEach(async () => { await Promise.all(stores.map(s => s.close())); stores = []; rmSync(dir, { recursive: true, force: true }); });

// macOS 用正式 lockf；Linux 用測試鎖 flock(1)（testLockProvider），其餘（AES-GCM、rename、SIGKILL）都是真的。
describe.skipIf(!realLockAvailable)("MemoryStore isolated writer; fake key wrapper, real AES-GCM and lockf (flock on Linux CI)", () => {
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
  }, 60_000);
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

describe.skipIf(!realLockAvailable)("MemoryStore snapshot version 2 (MEM-1)", () => {
  it("upgrades a version 1 snapshot in memory, keeps the filename and writes version 2 only on the next commit", async () => {
    // 以與 store 相同的信封格式造一份 MEM-0（version 1）快照：沒有 settings，profile／fact 沒有 MEM-1 欄位。
    const dek = randomBytes(32), nonce = randomBytes(12);
    const v1 = { format: "nous.memory.snapshot", version: 1, revision: 1, dedupKey: randomBytes(32).toString("hex"), receiptFloor: 0,
      profiles: [{ id: "profile_v1", name: "虛構甲", createdAt: profile.createdAt }],
      facts: [{ id: "fact-v1", profileId: "profile_v1", revision: 1, topic: "food", key: "coriander", value: "不吃香菜", source: { kind: "explicit", turnId: "turn-1", at: profile.createdAt, excerpt: "不吃香菜" }, expiresAt: null }],
      consents: [], receipts: [], tombstones: [] };
    const header = { format: "nous.memory.snapshot", version: 1, revision: 1, wrappedKey: secretBox.seal(dek.toString("base64")).toString("base64") };
    const c = createCipheriv("aes-256-gcm", dek, nonce); c.setAAD(Buffer.from(JSON.stringify([header.format, header.version, header.revision, header.wrappedKey])));
    const ciphertext = Buffer.concat([c.update(JSON.stringify(v1)), c.final()]);
    writeFileSync(join(dir, MEMORY_FILE), JSON.stringify({ ...header, nonce: nonce.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
    chmodSync(dir, 0o700);
    const s = await open();
    const state = s.read();
    expect(state.version).toBe(2);
    expect(state.settings).toEqual({ enabled: false, setupAt: null, suggestions: false });
    expect(state.profiles[0]).toMatchObject({ facePersonId: null, minor: false });
    expect(state.facts[0]).toMatchObject({ kind: "preference", audience: "household", pinned: false, reviewAfter: null, validFrom: profile.createdAt, value: "不吃香菜" });
    expect(JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8")).version).toBe(1);
    expect(await s.commit(newStoreOperation(1, "enable"), data => { data.settings = { enabled: true, setupAt: profile.createdAt, suggestions: false }; return "updated"; })).toEqual({ status: "updated", revision: 2 });
    expect(JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8")).version).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([MEMORY_FILE, "writer.lock"]);
  });

  it("rejects facts that are not household audience or lack MEM-1 fields, without writing", async () => {
    const s = await open();
    expect(await s.commit(newStoreOperation(0, "private"), data => { data.profiles.push(profile); data.facts.push({ ...fact(), audience: "private" as "household" }); return "saved"; })).toEqual({ status: "conflict" });
    expect(await s.commit(newStoreOperation(0, "no-pin"), data => { data.profiles.push(profile); const { pinned: _p, ...rest } = fact(); data.facts.push(rest as MemoryFact); return "saved"; })).toEqual({ status: "conflict" });
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
  });
});

describe("MemoryStore production platform rule", () => {
  it.skipIf(process.platform === "darwin")("refuses to open on a non-macOS platform when no test lock is injected", async () => {
    const d = mkdtempSync(join(tmpdir(), "nous-memory-platform-"));
    try {
      await expect(MemoryStore.open({ dir: d, secretBox: box() })).rejects.toMatchObject({ code: "unavailable" });
      expect(readdirSync(d)).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// ───────────── MEM-5a：快照 version 4 ─────────────

function plainOf(d: string): string {
  const e = JSON.parse(readFileSync(join(d, MEMORY_FILE), "utf8")) as { format: string; version: number; revision: number; wrappedKey: string; nonce: string; tag: string; ciphertext: string };
  const dek = Buffer.from(secretBox.open(Buffer.from(e.wrappedKey, "base64")), "base64");
  const dc = createDecipheriv("aes-256-gcm", dek, Buffer.from(e.nonce, "base64"));
  dc.setAAD(Buffer.from(JSON.stringify([e.format, e.version, e.revision, e.wrappedKey])));
  dc.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([dc.update(Buffer.from(e.ciphertext, "base64")), dc.final()]).toString("utf8");
}
const fileVersion = (d: string) => (JSON.parse(readFileSync(join(d, MEMORY_FILE), "utf8")) as { version: number }).version;
const household = (extra: Partial<MemoryFact> = {}): MemoryFact => ({ ...fact(), id: "fact-h", profileId: null, value: "晚餐不要太鹹", source: { ...fact().source, excerpt: "晚餐不要太鹹", by: profile.id }, ...extra });
const result = { id: "res_0123456789abcdef", taskId: "task_01234567-89ab-cdef-0123-456789abcdef", subject: null, deps: [], target: { provider: "claude", account: "fp0000claude0001" }, createdAt: profile.createdAt, state: "active" as const };

describe.skipIf(!realLockAvailable)("MemoryStore snapshot version 4 (MEM-5a)", () => {
  it("round-trips settings.suggestions, a suggestion source, source.by and a work_summary with derivedFrom", async () => {
    let s = await open();
    expect(await s.commit(newStoreOperation(0, "v4"), data => {
      data.settings = { enabled: true, setupAt: profile.createdAt, suggestions: true };
      data.profiles.push(profile);
      data.facts.push({ ...fact(), source: { ...fact().source, kind: "suggestion" } }, household(), { ...fact(), id: "fact-w", kind: "work_summary", value: "這次選了方案 B", derivedFrom: { taskId: result.taskId } });
      return "saved";
    })).toEqual({ status: "saved", revision: 1 });
    expect(fileVersion(dir)).toBe(4);
    const before = s.read();
    await s.close(); stores = [];
    s = await open();
    expect(s.read()).toEqual(before);
    expect(s.read().facts.map(f => [f.source.kind, f.source.by, f.kind, f.derivedFrom])).toEqual([["suggestion", null, "preference", null], ["explicit", profile.id, "preference", null], ["explicit", null, "work_summary", { taskId: result.taskId }]]);
  });

  it("validates version 4 content: derivedFrom only on work_summary, by only on household facts and only for an existing profile", async () => {
    const s = await open();
    const bad: [string, (d: MemoryData) => void][] = [
      ["derived-on-preference", d => { d.profiles.push(profile); d.facts.push({ ...fact(), derivedFrom: { taskId: result.taskId } }); }],
      ["derived-bad-task", d => { d.profiles.push(profile); d.facts.push({ ...fact(), kind: "work_summary", derivedFrom: { taskId: "task_x" } }); }],
      ["by-unknown", d => { d.profiles.push(profile); d.facts.push(household({ source: { ...fact().source, by: "nobody" } })); }],
      ["by-on-person", d => { d.profiles.push(profile); d.facts.push({ ...fact(), source: { ...fact().source, by: profile.id } }); }],
      ["unknown-source", d => { d.profiles.push(profile); d.facts.push({ ...fact(), source: { ...fact().source, kind: "model" as "explicit" } }); }],
    ];
    for (const [name, change] of bad) expect(await s.commit(newStoreOperation(0, name), d => { change(d); return "saved"; })).toEqual({ status: "conflict" });
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
  });

  it("tamper: a changed envelope version or ciphertext fails closed (corrupt) without rewriting", async () => {
    const s = await open();
    await s.commit(newStoreOperation(0, "v4"), d => { d.profiles.push(profile); d.facts.push(household()); return "saved"; });
    await s.close(); stores = [];
    const file = join(dir, MEMORY_FILE), original = readFileSync(file, "utf8");
    for (const mutate of [(e: Record<string, unknown>) => { e.version = 3; }, (e: Record<string, unknown>) => { e.version = 5; }, (e: Record<string, unknown>) => { const c = Buffer.from(e.ciphertext as string, "base64"); c[5] ^= 1; e.ciphertext = c.toString("base64"); }]) {
      const e = JSON.parse(original) as Record<string, unknown>; mutate(e);
      const tampered = JSON.stringify(e);
      writeFileSync(file, tampered, { mode: 0o600 });
      await expect(open()).rejects.toMatchObject({ code: "corrupt" });
      expect(readFileSync(file, "utf8")).toBe(tampered);
    }
  });

  it("without version 4 content, versions 2 and 3 are byte-identical to the MEM-4c store (7fc7d09) for the same operation", async () => {
    const { MemoryStore: OldStore } = await import("./fixtures/memory-store-7fc7d09.ts");
    for (const withResults of [false, true]) {
      const a = mkdtempSync(join(tmpdir(), "nous-memory-old-")), b = mkdtempSync(join(tmpdir(), "nous-memory-new-"));
      try {
        const seed = await OldStore.open({ dir: a, secretBox, lockProvider: testLockProvider });
        // OldStore 的 fact 沒有 by／derivedFrom（MEM-4c 的形狀）。
        const oldFact = () => { const { derivedFrom: _d, ...f } = fact(); const { by: _b, ...source } = f.source; return { ...f, source }; };
        await seed.commit(newStoreOperation(0, "seed"), data => { data.profiles.push(profile); data.facts.push(oldFact() as never); if (withResults) data.results.push(result); return "saved"; });
        await seed.close();
        writeFileSync(join(b, MEMORY_FILE), readFileSync(join(a, MEMORY_FILE)), { mode: 0o600 });
        chmodSync(b, 0o700);
        const op = newStoreOperation(1, "same-change");
        const oldStore = await OldStore.open({ dir: a, secretBox, lockProvider: testLockProvider });
        const newStore = await MemoryStore.open({ dir: b, secretBox, lockProvider: testLockProvider });
        const second = { ...oldFact(), id: "fact-b", value: "不喝咖啡", key: "咖啡" };
        expect(await oldStore.commit(op, data => { data.facts.push(second as never); data.settings = { ...data.settings, enabled: true, setupAt: profile.createdAt }; return "saved"; })).toEqual({ status: "saved", revision: 2 });
        expect(await newStore.commit(op, data => { data.facts.push(second as never); data.settings = { ...data.settings, enabled: true, setupAt: profile.createdAt }; return "saved"; })).toEqual({ status: "saved", revision: 2 });
        await oldStore.close(); await newStore.close();
        expect(fileVersion(b)).toBe(withResults ? 3 : 2);
        expect(plainOf(b)).toBe(plainOf(a));
        expect(plainOf(b)).not.toMatch(/"by"|"derivedFrom"/);
      } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
    }
  });

  it("v3 → v4 when suggestions are turned on (results kept), back to v3 when the version 4 content is gone; the MEM-4c store refuses v4 without overwriting it", async () => {
    const s = await open();
    await s.commit(newStoreOperation(0, "v3"), d => { d.profiles.push(profile); d.facts.push(fact()); d.results.push(result); return "saved"; });
    expect(fileVersion(dir)).toBe(3);
    await s.commit(newStoreOperation(1, "on"), d => { d.settings = { ...d.settings, suggestions: true }; return "updated"; });
    expect(fileVersion(dir)).toBe(4);
    expect(s.read().results).toEqual([result]);
    await s.close(); stores = [];
    // 舊版 App（MEM-4c 的 store）讀到 version 4：當成損壞而停用記憶，不覆寫。
    const { MemoryStore: OldStore } = await import("./fixtures/memory-store-7fc7d09.ts");
    const bytes = readFileSync(join(dir, MEMORY_FILE));
    await expect(OldStore.open({ dir, secretBox, lockProvider: testLockProvider })).rejects.toMatchObject({ code: "corrupt" });
    expect(readFileSync(join(dir, MEMORY_FILE))).toEqual(bytes);
    const again = await open();
    await again.commit(newStoreOperation(2, "off"), d => { d.settings = { ...d.settings, suggestions: false }; return "updated"; });
    expect(fileVersion(dir)).toBe(3);
    await again.close(); stores = [];
    // 回到 3 之後舊版又讀得到。
    const old = await OldStore.open({ dir, secretBox, lockProvider: testLockProvider });
    expect(old.read().results).toEqual([result]);
    await old.close();
  });
});
