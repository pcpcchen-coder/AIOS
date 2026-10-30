import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SealedVault, VaultError } from "../server/sealed-vault.ts";
import { PROTECTED_TITLE, TaskStore, shellOf, writeJsonAtomic } from "../server/store.ts";
import { BACKUP_PREFIX, hasPlaintext, type MigrationStep } from "../server/task-migration.ts";
import type { Artifact, Task } from "../shared/types.ts";
import { fakeBox } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

// MEM-4a：任務加密保存（SealedVault、TaskStore 的加密模式、明文一次性搬遷）。真 AES-GCM、真 rename／fsync；
// 只有資料金鑰的包裝是假的（正式 App 用 safeStorage／Keychain）。全部內容都是虛構的 canary。

const CANARY = "CANARY_任務原句_ZEBRA_7731";
const ART_CANARY = "CANARY_成果內容_OKAPI_4410";
const dirs: string[] = [];
const vaults: SealedVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nous-vault-")); dirs.push(d);
  return d;
}

function openVault(dir: string, key: Buffer, available = () => true): SealedVault {
  const v = SealedVault.open({ dir, secretBox: fakeBox(key, available), lockProvider: testLockProvider });
  vaults.push(v);
  return v;
}

/** 資料夾底下所有檔案的位元組（遞迴）。 */
function allBytes(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) out += allBytes(path);
    else out += readFileSync(path).toString("utf8");
  }
  return out;
}

function plaintextTask(i = 0): { task: Task; artifact: Artifact } {
  const id = randomUUID();
  const task: Task = { schema_version: "proto-0.1", task_id: `task_${id}`, request_id: "req_fixture0001", title: `${CANARY} ${i}`, status: "succeeded", mode: "mock", model: null, plan_ready: true,
    steps: [{ title: `步驟 ${CANARY}`, status: "done", started_at: null, finished_at: null, output_chars: null, domain: "language" }],
    created_at: "2026-10-30T01:00:00.000Z", updated_at: "2026-10-30T01:01:00.000Z", finished_at: "2026-10-30T01:01:00.000Z", error: null, artifact_id: `artifact_${randomUUID()}`, retry_of: null };
  const artifact: Artifact = { schema_version: "proto-0.1", artifact_id: task.artifact_id!, version: 1, task_id: task.task_id, title: task.title, content: `# ${ART_CANARY}`, mode: "mock", model: null, assumptions: [`假設 ${ART_CANARY}`], capability_gaps: [], status: "complete", created_at: task.finished_at! };
  return { task, artifact };
}

describe.skipIf(!realLockAvailable)("SealedVault (real AES-256-GCM, per-file key)", () => {
  it("writes 0600 files in a 0700 dir, round-trips, and stores no plaintext", () => {
    const root = tmp(), dir = join(root, "sealed"), key = randomBytes(32);
    const v = openVault(dir, key);
    const id = `task_${randomUUID()}`;
    v.write(id, { title: CANARY });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${id}.enc`)).mode & 0o777).toBe(0o600);
    expect(v.read(id)).toEqual({ title: CANARY });
    expect(allBytes(dir)).not.toContain(CANARY);
    expect(readdirSync(dir).filter(n => n.includes(".tmp-"))).toEqual([]);
    expect(v.ids()).toEqual([id]);
  });

  it("binds the file to its id (AAD): a renamed or tampered file does not decrypt", () => {
    const dir = join(tmp(), "sealed"), v = openVault(dir, randomBytes(32));
    const a = `task_${randomUUID()}`, b = `task_${randomUUID()}`;
    v.write(a, { x: 1 });
    renameSync(join(dir, `${a}.enc`), join(dir, `${b}.enc`));
    expect(() => v.read(b)).toThrow(VaultError);
    v.write(a, { x: 2 });
    const env = JSON.parse(readFileSync(join(dir, `${a}.enc`), "utf8"));
    env.ciphertext = Buffer.from(Buffer.from(env.ciphertext, "base64").map((x: number, i: number) => (i === 0 ? x ^ 1 : x))).toString("base64");
    writeFileSync(join(dir, `${a}.enc`), JSON.stringify(env), { mode: 0o600 });
    expect(() => v.read(a)).toThrow(/vault_corrupt/);
  });

  it("each write uses a fresh data key; removing the file deletes it (gone, and other files untouched)", () => {
    const dir = join(tmp(), "sealed"), v = openVault(dir, randomBytes(32));
    const id = `artifact_${randomUUID()}`, other = `task_${randomUUID()}`;
    v.write(id, { c: 1 });
    const first = JSON.parse(readFileSync(join(dir, `${id}.enc`), "utf8")).wrappedKey;
    v.write(id, { c: 1 });
    expect(JSON.parse(readFileSync(join(dir, `${id}.enc`), "utf8")).wrappedKey).not.toBe(first);
    v.write(other, { c: 2 });
    v.remove(id);
    expect(existsSync(join(dir, `${id}.enc`))).toBe(false);
    expect(v.read(id)).toBeNull();
    expect(v.read(other)).toEqual({ c: 2 });
  });

  it("refuses to open without the key, with a second writer, or with loose permissions; never falls back to plaintext", () => {
    const root = tmp(), dir = join(root, "sealed");
    expect(() => SealedVault.open({ dir, secretBox: fakeBox(randomBytes(32), () => false), lockProvider: testLockProvider })).toThrow(/key_unavailable/);
    openVault(dir, randomBytes(32));
    expect(() => SealedVault.open({ dir, secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider })).toThrow(/locked/);
    const loose = join(root, "loose"); mkdirSync(loose, { mode: 0o755 }); chmodSync(loose, 0o755);
    expect(() => SealedVault.open({ dir: loose, secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider })).toThrow(/permissions/);
  });

  it("a crash before rename leaves only a temp file, which the next open deletes", () => {
    const dir = join(tmp(), "sealed"), key = randomBytes(32);
    const v = SealedVault.open({ dir, secretBox: fakeBox(key), lockProvider: testLockProvider, checkpoint: (s) => { if (s === "after_file_sync") throw new Error("crash"); } });
    expect(() => v.write(`task_${randomUUID()}`, { a: 1 })).toThrow("crash");
    expect(readdirSync(dir).filter(n => n.endsWith(".enc"))).toEqual([]);
    v.close();
    writeFileSync(join(dir, `task_${randomUUID()}.enc.tmp-${randomUUID()}`), "partial", { mode: 0o600 });
    const again = openVault(dir, key);
    expect(readdirSync(dir).filter(n => n.includes(".tmp-"))).toEqual([]);
    expect(again.ids()).toEqual([]);
  });
});

describe("TaskStore JSON hardening (all builds)", () => {
  it("writes 0600 with a unique temp name and leaves no temp files; stale temps are removed on load", () => {
    const dir = tmp();
    writeFileSync(join(dir, `tasks.json.tmp-${randomUUID()}`), "stale");
    const store = new TaskStore(dir);
    store.create({ title: "一般任務", request_id: "req_fixture0001", mode: "mock" });
    expect(statSync(join(dir, "tasks.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(n => n.includes(".tmp"))).toEqual([]);
    writeJsonAtomic(join(dir, "x.json"), { a: 1 });
    expect(JSON.parse(readFileSync(join(dir, "x.json"), "utf8"))).toEqual({ a: 1 });
  });

  it("browser build (no sealing): tasks.json and artifacts.json keep the original plaintext format and public views equal private ones", () => {
    const dir = tmp();
    const store = new TaskStore(dir);
    const task = store.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock" });
    store.addArtifact({ task_id: task.task_id, title: CANARY, content: ART_CANARY, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    expect(store.sealed).toBe(false);
    expect(store.publicList()).toEqual(store.list());
    expect(readFileSync(join(dir, "tasks.json"), "utf8")).toContain(CANARY);
    expect(readFileSync(join(dir, "artifacts.json"), "utf8")).toContain(ART_CANARY);
    expect(store.vaultStatus()).toEqual({ mode: "plain", failure: null, migration: null, backups: [], unsealed: 0, unreadable: 0 });
  });
});

describe.skipIf(!realLockAvailable)("TaskStore sealed mode (macOS App)", () => {
  function sealedStore(dataDir: string, key: Buffer, log: string[] = []) {
    const vault = openVault(join(dataDir, "sealed"), key);
    return { vault, store: new TaskStore(dataDir, { vault, log: (l) => log.push(l) }) };
  }

  it("tasks.json holds only shells, there is no artifacts.json, outward views are shells, and a restart restores the content", () => {
    const dataDir = tmp(), key = randomBytes(32), log: string[] = [];
    const { store, vault } = sealedStore(dataDir, key, log);
    const task = store.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock" });
    store.update(task.task_id, (t) => { t.status = "running"; t.steps = [{ title: `規劃 ${CANARY}`, status: "done", started_at: null, finished_at: null, output_chars: null, domain: "planning" }]; t.plan_ready = true; });
    store.update(task.task_id, (t) => { t.steps[0]!.output_chars = 42; });
    const artifact = store.addArtifact({ task_id: task.task_id, title: CANARY, content: ART_CANARY, mode: "mock", model: null, assumptions: [ART_CANARY], capability_gaps: [], status: "complete" });
    store.update(task.task_id, (t) => { t.status = "succeeded"; t.artifact_id = artifact.artifact_id; });
    expect(existsSync(join(dataDir, "artifacts.json"))).toBe(false);
    const shells = JSON.parse(readFileSync(join(dataDir, "tasks.json"), "utf8")) as Task[];
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({ protected: true, title: PROTECTED_TITLE, status: "succeeded", steps: [{ domain: "planning", status: "done" }] });
    expect(allBytes(dataDir)).not.toContain(CANARY);
    expect(allBytes(dataDir)).not.toContain(ART_CANARY);
    expect(store.publicList()[0]!.title).toBe(PROTECTED_TITLE);
    expect(store.publicArtifact(artifact.artifact_id)).toBeUndefined();
    expect(store.publicDocuments()[0]!.artifact).toBeNull();
    expect(store.get(task.task_id)!.title).toBe(CANARY);
    expect(log.join("\n")).not.toContain(CANARY);
    vault.close();
    const again = sealedStore(dataDir, key).store;
    expect(again.get(task.task_id)).toMatchObject({ title: CANARY, status: "succeeded", steps: [{ title: `規劃 ${CANARY}`, output_chars: 42 }] });
    expect(again.getArtifact(artifact.artifact_id)!.content).toBe(ART_CANARY);
  });

  it("restart: a running protected task is marked failed honestly; orphan .enc files are removed", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const { store, vault } = sealedStore(dataDir, key);
    const task = store.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock" });
    store.update(task.task_id, (t) => { t.status = "running"; });
    const orphan = `artifact_${randomUUID()}`;
    vault.write(orphan, { content: ART_CANARY });
    vault.close();
    const { store: again, vault: v2 } = sealedStore(dataDir, key);
    expect(again.get(task.task_id)).toMatchObject({ status: "failed", title: CANARY, error: "本機核心重新啟動，任務在完成前中斷（未產生成果）。" });
    expect(again.publicGet(task.task_id)!.error).toBe("受保護的錯誤說明，請在 App 內查看");
    expect(v2.ids()).toEqual([task.task_id]);
  });

  it("key unavailable with no plaintext: shells are still written, content stays in memory only and is counted", () => {
    const dataDir = tmp();
    const store = new TaskStore(dataDir, { vault: null, failure: "key_unavailable" });
    store.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock" });
    expect(store.sealed).toBe(true);
    expect(store.vaultStatus()).toMatchObject({ mode: "sealed", failure: "key_unavailable", unsealed: 1 });
    expect(allBytes(dataDir)).not.toContain(CANARY);
  });

  it("delete removes both encrypted files", () => {
    const dataDir = tmp();
    const { store, vault } = sealedStore(dataDir, randomBytes(32));
    const task = store.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock" });
    const a = store.addArtifact({ task_id: task.task_id, title: CANARY, content: ART_CANARY, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    store.update(task.task_id, (t) => { t.status = "succeeded"; t.artifact_id = a.artifact_id; });
    expect(vault.ids().sort()).toEqual([a.artifact_id, task.task_id].sort());
    expect(store.delete(task.task_id)).toMatchObject({ ok: true });
    expect(vault.ids()).toEqual([]);
  });

  it("shellOf keeps status, timestamps, step count and domains (the brain still runs on real events) and drops text", () => {
    const { task } = plaintextTask();
    task.error = `錯誤 ${CANARY}`;
    const shell = shellOf(task);
    expect(JSON.stringify(shell)).not.toContain(CANARY);
    expect(shell).toMatchObject({ protected: true, status: task.status, created_at: task.created_at, steps: [{ status: "done", domain: "language" }] });
  });
});

describe.skipIf(!realLockAvailable)("review B1: a read failure never deletes or overwrites encrypted content", () => {
  function seedTwo(dataDir: string, key: Buffer) {
    const vault = openVault(join(dataDir, "sealed"), key);
    const s = new TaskStore(dataDir, { vault });
    const t = s.create({ title: CANARY, request_id: "req_aaaaaaa1", mode: "mock" });
    const a = s.addArtifact({ task_id: t.task_id, title: "x", content: ART_CANARY, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    s.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; });
    const t2 = s.create({ title: `${CANARY}_RUNNING`, request_id: "req_aaaaaaa2", mode: "mock" });
    s.update(t2.task_id, (x) => { x.status = "running"; });
    vault.close();
    vaults.splice(vaults.indexOf(vault), 1);
    return { t, a, t2 };
  }
  const encFiles = (dataDir: string) => readdirSync(join(dataDir, "sealed")).filter(n => n.endsWith(".enc")).sort().map(n => [n, readFileSync(join(dataDir, "sealed", n), "utf8")]);
  function reopen(dataDir: string, key: Buffer) {
    const vault = openVault(join(dataDir, "sealed"), key);
    return new TaskStore(dataDir, { vault });
  }

  it("Keychain refuses decryption (reviewer probe): the vault does not open, nothing is deleted or resealed, the next run reads everything", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const { t, a, t2 } = seedTwo(dataDir, key);
    const before = encFiles(dataDir);
    const deny = { available: () => true, seal: fakeBox(key).seal, open: () => { throw new Error("denied"); } };
    expect(() => SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: deny, lockProvider: testLockProvider })).toThrow(/key_unavailable/);
    const store = new TaskStore(dataDir, { vault: null, failure: "key_unavailable" });
    expect(store.vaultStatus()).toMatchObject({ mode: "sealed", failure: "key_unavailable", unreadable: 2 });
    expect(store.get(t2.task_id)!.status).toBe("failed");
    expect(store.contentMissing(t.task_id)).toBe(true);
    expect(encFiles(dataDir)).toEqual(before);
    const again = reopen(dataDir, key);
    expect(again.get(t.task_id)!.title).toBe(CANARY);
    expect(again.getArtifact(a.artifact_id)!.content).toBe(ART_CANARY);
    expect(again.get(t2.task_id)).toMatchObject({ title: `${CANARY}_RUNNING`, status: "failed" });
  });

  it("a per-file decrypt failure (open throws only for stored keys) skips orphan cleanup and never reseals", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const { t, a, t2 } = seedTwo(dataDir, key);
    const before = encFiles(dataDir);
    const good = fakeBox(key);
    // 新包裝的探測能解開，但檔案裡的舊金鑰解不開（例如 Keychain 項目被換掉）。
    const fresh = new Set<string>();
    const partial = { available: () => true, seal: (p: string) => { const b = good.seal(p); fresh.add(b.toString("base64")); return b; }, open: (b: Buffer) => { if (!fresh.has(b.toString("base64"))) throw new Error("denied"); return good.open(b); } };
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: partial, lockProvider: testLockProvider });
    vaults.push(vault);
    const store = new TaskStore(dataDir, { vault });
    expect(store.vaultStatus()).toMatchObject({ failure: "key_unavailable", unreadable: 2 });
    expect(store.get(t2.task_id)!.status).toBe("failed");
    expect(encFiles(dataDir)).toEqual(before);
    vault.close(); vaults.splice(vaults.indexOf(vault), 1);
    const again = reopen(dataDir, key);
    expect(again.get(t.task_id)!.title).toBe(CANARY);
    expect(again.getArtifact(a.artifact_id)!.content).toBe(ART_CANARY);
  });

  it("a 0644 file: no cleanup, nothing rewritten; after fixing the mode the content reads back", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const { t, a } = seedTwo(dataDir, key);
    chmodSync(join(dataDir, "sealed", `${a.artifact_id}.enc`), 0o644);
    const before = encFiles(dataDir);
    const store = reopen(dataDir, key);
    expect(store.vaultStatus().failure).toBe("permissions");
    expect(store.getArtifact(a.artifact_id)).toBeUndefined();
    expect(encFiles(dataDir).map(([n]) => n)).toEqual(before.map(([n]) => n));
    vaults.pop()!.close();
    chmodSync(join(dataDir, "sealed", `${a.artifact_id}.enc`), 0o600);
    const again = reopen(dataDir, key);
    expect(again.get(t.task_id)!.title).toBe(CANARY);
    expect(again.getArtifact(a.artifact_id)!.content).toBe(ART_CANARY);
  });

  it("one corrupt file is kept (not treated as an orphan) and does not affect the others", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const { t, a, t2 } = seedTwo(dataDir, key);
    const file = join(dataDir, "sealed", `${t2.task_id}.enc`);
    writeFileSync(file, "{broken", { mode: 0o600 });
    const store = reopen(dataDir, key);
    expect(store.contentMissing(t2.task_id)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{broken");
    expect(store.get(t.task_id)!.title).toBe(CANARY);
    expect(store.getArtifact(a.artifact_id)!.content).toBe(ART_CANARY);
    vaults.pop()!.close();
    expect(readFileSync(file, "utf8")).toBe("{broken");
    expect(reopen(dataDir, key).get(t.task_id)!.title).toBe(CANARY);
  });

  it("withdraw writes the shell first: a crash before the file deletion leaves an orphan that the next load removes (reviewer probe)", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const vault = openVault(join(dataDir, "sealed"), key);
    const s = new TaskStore(dataDir, { vault });
    const t = s.create({ title: "T", request_id: "req_aaaaaaa1", mode: "mock" });
    const a = s.addArtifact({ task_id: t.task_id, title: "x", content: ART_CANARY, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    s.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; });
    // 模擬：外殼已寫 withdrawn，刪成果檔前當機（成果檔還在）。
    const artifactFile = readFileSync(join(dataDir, "sealed", `${a.artifact_id}.enc`));
    s.withdraw(t.task_id);
    writeFileSync(join(dataDir, "sealed", `${a.artifact_id}.enc`), artifactFile, { mode: 0o600 });
    vaults.pop()!.close();
    const again = reopen(dataDir, key);
    expect(again.get(t.task_id)).toMatchObject({ withdrawn: true, artifact_id: null });
    expect(again.getArtifact(a.artifact_id)).toBeUndefined();
    expect(existsSync(join(dataDir, "sealed", `${a.artifact_id}.enc`))).toBe(false);
  });

  it("memory hint false at load (review M4a): memory-derived tasks are withdrawn even though memory never opens", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const vault = openVault(join(dataDir, "sealed"), key);
    const s = new TaskStore(dataDir, { vault });
    const t = s.create({ title: "T", request_id: "req_aaaaaaa1", mode: "claude", memory: true });
    const a = s.addArtifact({ task_id: t.task_id, title: "x", content: ART_CANARY, mode: "claude", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    s.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; });
    const plain = s.create({ title: "P", request_id: "req_aaaaaaa2", mode: "claude" });
    vaults.pop()!.close();
    const v2 = openVault(join(dataDir, "sealed"), key);
    const again = new TaskStore(dataDir, { vault: v2, memoryEnabled: () => false });
    expect(again.get(t.task_id)).toMatchObject({ withdrawn: true, artifact_id: null });
    expect(v2.ids()).not.toContain(a.artifact_id);
    expect(again.get(plain.task_id)!.withdrawn).toBeUndefined();
  });
});

describe.skipIf(!realLockAvailable)("plaintext migration (once, reversible, in the App core)", () => {
  function seed(dataDir: string, n = 3): { tasks: Task[]; artifacts: Artifact[]; tasksBytes: Buffer; artifactsBytes: Buffer } {
    const pairs = Array.from({ length: n }, (_, i) => plaintextTask(i));
    const tasks = pairs.map(p => p.task), artifacts = pairs.map(p => p.artifact);
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(tasks, null, 2));
    writeFileSync(join(dataDir, "artifacts.json"), JSON.stringify(artifacts, null, 2));
    return { tasks, artifacts, tasksBytes: readFileSync(join(dataDir, "tasks.json")), artifactsBytes: readFileSync(join(dataDir, "artifacts.json")) };
  }

  it("encrypts, verifies, backs up to plaintext-backup-<date>/ (0700) and switches; the backup stays until the user deletes it", () => {
    const dataDir = tmp(), key = randomBytes(32), log: string[] = [];
    const seeded = seed(dataDir);
    const vault = openVault(join(dataDir, "sealed"), key);
    const store = new TaskStore(dataDir, { vault, log: (l) => log.push(l), now: () => new Date(2026, 9, 30, 12) });
    expect(store.vaultStatus()).toMatchObject({ mode: "sealed", migration: { ok: true, tasks: 3, artifacts: 3, backup: `${BACKUP_PREFIX}2026-10-30` }, backups: [`${BACKUP_PREFIX}2026-10-30`] });
    const backup = join(dataDir, `${BACKUP_PREFIX}2026-10-30`);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(backup, "tasks.json")).equals(seeded.tasksBytes)).toBe(true);
    expect(readFileSync(join(backup, "artifacts.json")).equals(seeded.artifactsBytes)).toBe(true);
    expect(statSync(join(backup, "tasks.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, "artifacts.json"))).toBe(false);
    expect(readFileSync(join(dataDir, "tasks.json"), "utf8")).not.toContain(CANARY);
    expect(hasPlaintext(dataDir)).toBe(false);
    expect(allBytes(join(dataDir, "sealed"))).not.toContain(CANARY);
    for (const t of seeded.tasks) expect(store.get(t.task_id)!.title).toBe(t.title);
    for (const a of seeded.artifacts) expect(store.getArtifact(a.artifact_id)!.content).toBe(a.content);
    expect(log.join("\n")).not.toContain(CANARY);
    // 備份一直保留：重新啟動也不會自動刪。
    vault.close();
    const v2 = openVault(join(dataDir, "sealed"), key);
    const again = new TaskStore(dataDir, { vault: v2 });
    expect(again.vaultStatus()).toMatchObject({ mode: "sealed", migration: null, backups: [`${BACKUP_PREFIX}2026-10-30`] });
    expect(again.get(seeded.tasks[0]!.task_id)!.title).toBe(seeded.tasks[0]!.title);
    expect(again.deleteBackups()).toBe(1);
    expect(existsSync(backup)).toBe(false);
    expect(allBytes(dataDir)).not.toContain(CANARY);
  });

  it.each<MigrationStep>(["read", "encrypt", "verify", "backup", "switch"])("a failure at %s leaves the plaintext byte-identical, no encrypted files and no backup", (step) => {
    const dataDir = tmp(), key = randomBytes(32);
    const seeded = seed(dataDir);
    const vault = openVault(join(dataDir, "sealed"), key);
    const store = new TaskStore(dataDir, { vault, migrationCheckpoint: (s) => { if (s === step) throw new Error(`fail ${s}`); } });
    expect(store.vaultStatus()).toMatchObject({ mode: "plain_fallback", migration: { ok: false, step }, backups: [] });
    expect(readFileSync(join(dataDir, "tasks.json")).equals(seeded.tasksBytes)).toBe(true);
    expect(readFileSync(join(dataDir, "artifacts.json")).equals(seeded.artifactsBytes)).toBe(true);
    expect(vault.ids()).toEqual([]);
    expect(readdirSync(dataDir).filter(n => n.startsWith(BACKUP_PREFIX))).toEqual([]);
    // 這次照舊明文（不加密、也不改原檔格式）；下次啟動再搬。
    expect(store.sealed).toBe(false);
    expect(store.get(seeded.tasks[0]!.task_id)!.title).toBe(seeded.tasks[0]!.title);
  });

  it("review M3: a failure after the shells were written restores tasks.json durably and keeps the encrypted files and the backup; the next start finishes", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const seeded = seed(dataDir);
    const vault = openVault(join(dataDir, "sealed"), key);
    const store = new TaskStore(dataDir, { vault, now: () => new Date(2026, 9, 30, 12), migrationCheckpoint: (s) => { if (s === "after_shells") throw new Error("unlink failed"); } });
    expect(store.vaultStatus()).toMatchObject({ mode: "plain_fallback", migration: { ok: false, step: "switch" } });
    expect(readFileSync(join(dataDir, "tasks.json")).equals(seeded.tasksBytes)).toBe(true);
    expect(readFileSync(join(dataDir, "artifacts.json")).equals(seeded.artifactsBytes)).toBe(true);
    expect(vault.ids()).toHaveLength(6);
    expect(readdirSync(dataDir).filter(n => n.startsWith(BACKUP_PREFIX))).toEqual([`${BACKUP_PREFIX}2026-10-30`]);
    expect(readdirSync(dataDir).filter(n => n.includes(".tmp"))).toEqual([]);
    vaults.pop()!.close();
    const v2 = openVault(join(dataDir, "sealed"), key);
    const again = new TaskStore(dataDir, { vault: v2, now: () => new Date(2026, 9, 30, 12) });
    expect(again.vaultStatus()).toMatchObject({ mode: "sealed", migration: { ok: true, backup: `${BACKUP_PREFIX}2026-10-30` }, backups: [`${BACKUP_PREFIX}2026-10-30`] });
    expect(again.get(seeded.tasks[0]!.task_id)!.title).toBe(seeded.tasks[0]!.title);
  });

  it("reviewer probe 2: a crash after the shells but before artifacts.json is removed re-migrates safely and reuses the same backup", () => {
    const dataDir = tmp(), key = randomBytes(32);
    const seeded = seed(dataDir, 1);
    let vault = openVault(join(dataDir, "sealed"), key);
    new TaskStore(dataDir, { vault, now: () => new Date(2026, 9, 30) });
    vaults.pop()!.close();
    writeFileSync(join(dataDir, "artifacts.json"), seeded.artifactsBytes); // 刪 artifacts.json 之前當機
    vault = openVault(join(dataDir, "sealed"), key);
    const again = new TaskStore(dataDir, { vault, now: () => new Date(2026, 9, 30) });
    expect(again.vaultStatus()).toMatchObject({ mode: "sealed", migration: { ok: true, tasks: 0, artifacts: 1, backup: `${BACKUP_PREFIX}2026-10-30` }, backups: [`${BACKUP_PREFIX}2026-10-30`] });
    expect(again.get(seeded.tasks[0]!.task_id)!.title).toBe(seeded.tasks[0]!.title);
    expect(again.getArtifact(seeded.artifacts[0]!.artifact_id)!.content).toBe(seeded.artifacts[0]!.content);
    expect(readFileSync(join(dataDir, `${BACKUP_PREFIX}2026-10-30`, "tasks.json")).equals(seeded.tasksBytes)).toBe(true);
    expect(existsSync(join(dataDir, "artifacts.json"))).toBe(false);
  });

  it("an unreadable plaintext file (read step) is left untouched", () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "artifacts.json"), "{not json");
    writeFileSync(join(dataDir, "tasks.json"), "[]");
    const vault = openVault(join(dataDir, "sealed"), randomBytes(32));
    expect(() => new TaskStore(dataDir, { vault })).toThrow();
    expect(readFileSync(join(dataDir, "artifacts.json"), "utf8")).toBe("{not json");
    expect(vault.ids()).toEqual([]);
  });

  it("key unavailable while plaintext exists: no migration, plaintext untouched, honest plain_fallback", () => {
    const dataDir = tmp();
    const seeded = seed(dataDir, 1);
    const store = new TaskStore(dataDir, { vault: null, failure: "key_unavailable" });
    expect(store.vaultStatus()).toMatchObject({ mode: "plain_fallback", failure: "key_unavailable", migration: null });
    expect(readFileSync(join(dataDir, "artifacts.json")).equals(seeded.artifactsBytes)).toBe(true);
  });
});
