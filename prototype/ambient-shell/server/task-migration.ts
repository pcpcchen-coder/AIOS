import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, Task } from "../shared/types.ts";
import { sealedKind, type SealedVault } from "./sealed-vault.ts";

// MEM-4a：把舊的明文 tasks.json／artifacts.json 一次搬進加密保存（只在 macOS App 的核心啟動時，George 2026-10-30）。
// 步驟（任何一步失敗：明文原檔不動，已寫的加密檔與備份清掉，照實回報是哪一步）：
//   1. read     讀明文（格式不對就停）；
//   2. encrypt  每筆加密寫入（SealedVault）；
//   3. verify   每筆解密回來，和原文逐字比對；
//   4. backup   原檔複製到 data/plaintext-backup-<日期>/（0700，檔案 0600，fsync 後逐位元組比對）；
//   5. switch   tasks.json 改寫成外殼（原子取代），再刪 artifacts.json；刪除失敗就把 tasks.json 從備份還原。
// 備份一直保留，直到使用者在畫面上確認刪除（deletePlaintextBackups，主程序先跳原生確認）。
// log 只記筆數與步驟，不記內容。

export type MigrationStep = "read" | "encrypt" | "verify" | "backup" | "switch";
export type MigrationResult =
  | { ok: true; tasks: number; artifacts: number; backup: string }
  | { ok: false; step: MigrationStep };

export const BACKUP_PREFIX = "plaintext-backup-";
const BACKUP_DIR = /^plaintext-backup-\d{4}-\d{2}-\d{2}(?:-\d{1,3})?$/;

export interface MigrationOptions {
  dataDir: string;
  vault: SealedVault;
  /** 把外殼寫回 tasks.json（TaskStore 的原子寫入）。 */
  writeShells: (tasks: Task[]) => void;
  now?: () => Date;
  /** 測試專用：在每一步開始前呼叫；丟錯即模擬那一步失敗。 */
  checkpoint?: (step: MigrationStep | "after_shells") => void;
}

/** 明文判斷：artifacts.json 還在，或 tasks.json 裡有不是外殼的項目。 */
export function hasPlaintext(dataDir: string): boolean {
  if (existsSync(join(dataDir, "artifacts.json"))) return true;
  const file = join(dataDir, "tasks.json");
  if (!existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return !Array.isArray(parsed) || parsed.some(t => !t || typeof t !== "object" || (t as Task).protected !== true);
  } catch {
    return true;
  }
}

export function plaintextBackups(dataDir: string): string[] {
  try { return readdirSync(dataDir).filter(n => BACKUP_DIR.test(n)).sort(); } catch { return []; }
}

/** 使用者在畫面上確認後才呼叫：刪除所有明文備份資料夾。回傳刪掉的資料夾數。只是刪檔，不是安全抹除。 */
export function deletePlaintextBackups(dataDir: string): number {
  const names = plaintextBackups(dataDir);
  for (const name of names) rmSync(join(dataDir, name), { recursive: true, force: true });
  if (names.length) syncDir(dataDir);
  return names.length;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function copyExact(from: string, to: string): void {
  const bytes = readFileSync(from);
  const fd = openSync(to, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (!readFileSync(to).equals(bytes)) throw new Error("backup_mismatch");
}

function day(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function migratePlaintext(options: MigrationOptions): MigrationResult {
  const { dataDir, vault } = options;
  const tasksFile = join(dataDir, "tasks.json");
  const artifactsFile = join(dataDir, "artifacts.json");
  const written: string[] = [];
  let backup: string | null = null;
  let step: MigrationStep = "read";
  let switched = false;
  const rollback = () => {
    for (const id of written) { try { vault.remove(id); } catch { /* 清不掉的加密檔下次啟動當孤兒清除 */ } }
    if (backup) { try { rmSync(backup, { recursive: true, force: true }); } catch { /* 備份留著也只是原檔的複本 */ } }
  };
  try {
    options.checkpoint?.("read");
    const tasksRaw: unknown = existsSync(tasksFile) ? JSON.parse(readFileSync(tasksFile, "utf8")) : [];
    const artifactsRaw: unknown = existsSync(artifactsFile) ? JSON.parse(readFileSync(artifactsFile, "utf8")) : [];
    if (!Array.isArray(tasksRaw) || !Array.isArray(artifactsRaw)) throw new Error("not_array");
    const tasks = tasksRaw as Task[];
    const artifacts = artifactsRaw as Artifact[];
    // 已經是外殼的（上次搬到一半）：真正內容已在加密檔，這次不再寫。
    const plainTasks = tasks.filter(t => t?.protected !== true);
    for (const t of plainTasks) if (!t || sealedKind(t.task_id) !== "task") throw new Error("bad_task");
    for (const a of artifacts) if (!a || sealedKind(a.artifact_id) !== "artifact") throw new Error("bad_artifact");

    step = "encrypt";
    options.checkpoint?.("encrypt");
    for (const t of plainTasks) { vault.write(t.task_id, t); written.push(t.task_id); }
    for (const a of artifacts) { vault.write(a.artifact_id, a); written.push(a.artifact_id); }

    step = "verify";
    options.checkpoint?.("verify");
    const expected = new Map<string, string>([...plainTasks.map(t => [t.task_id, JSON.stringify(t)] as const), ...artifacts.map(a => [a.artifact_id, JSON.stringify(a)] as const)]);
    for (const [id, text] of expected) if (JSON.stringify(vault.read(id)) !== text) throw new Error("verify_mismatch");
    for (const t of tasks.filter(t => t?.protected === true)) if (vault.read(t.task_id) === null) throw new Error("verify_missing");

    step = "backup";
    options.checkpoint?.("backup");
    // 要備份的檔：tasks.json 只有在還有明文項目時才備份（全是外殼＝上次搬到一半，裡面沒有明文）；artifacts.json 有就備份。
    const needed = [...(plainTasks.length ? ["tasks.json"] : []), ...(existsSync(artifactsFile) ? ["artifacts.json"] : [])];
    // 上次搬到一半留下、內容完全相同的備份就沿用（不另開 -2 資料夾，也不重複保存明文）。
    let name = plaintextBackups(dataDir).find(dir => needed.length > 0 && needed.every(f => {
      const copy = join(dataDir, dir, f);
      return existsSync(copy) && readFileSync(copy).equals(readFileSync(join(dataDir, f)));
    })) ?? null;
    if (!name) {
      const base = `${BACKUP_PREFIX}${day((options.now ?? (() => new Date()))())}`;
      name = base;
      for (let i = 2; existsSync(join(dataDir, name)); i++) name = `${base}-${i}`;
      backup = join(dataDir, name);
      mkdirSync(backup, { mode: 0o700 });
      for (const f of needed) copyExact(join(dataDir, f), join(backup, f));
      syncDir(backup);
      syncDir(dataDir);
    }
    const backupDir = join(dataDir, name);

    step = "switch";
    options.checkpoint?.("switch");
    const real = new Map(tasks.map(t => [t.task_id, t.protected === true ? (vault.read<Task>(t.task_id) ?? t) : t]));
    options.writeShells([...real.values()]);
    // 審查 M3：tasks.json 已換成外殼之後，就不能再刪這次寫的加密檔與備份（外殼要靠它們）。之後失敗只會留下「搬到一半」：
    // 加密檔與備份都在，下次啟動再搬一次是安全的。
    switched = true;
    try {
      options.checkpoint?.("after_shells");
      if (existsSync(artifactsFile)) unlinkSync(artifactsFile);
      syncDir(dataDir);
    } catch (error) {
      // 明文成果刪不掉：把 tasks.json 從備份還原（暫存檔 O_EXCL → fsync → rename → 資料夾 fsync），這次照舊明文。
      const saved = join(backupDir, "tasks.json");
      if (plainTasks.length && existsSync(saved)) writeDurable(tasksFile, readFileSync(saved));
      throw error;
    }
    return { ok: true, tasks: plainTasks.length, artifacts: artifacts.length, backup: name };
  } catch {
    if (!switched) rollback();
    return { ok: false, step };
  }
}

/** 原子而且耐當機地取代一個檔：唯一暫存檔（O_EXCL、0600）→ fsync → rename → 資料夾 fsync。 */
function writeDurable(path: string, bytes: Buffer): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDir(dirname(path));
}
