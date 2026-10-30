import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryLockProvider, MemorySecretBox } from "./memory/store.ts";

// MEM-4a：任務內容的加密保存（只有 macOS App 注入；瀏覽器版沒有 safeStorage／Keychain，照舊明文）。
// - 一筆一檔：任務本身（使用者原句、步驟標題、錯誤）task_<uuid>.enc；成果（內容、假設、能力缺口）artifact_<uuid>.enc。
// - 每檔一把隨機資料金鑰（AES-256-GCM），金鑰用 secretBox（App：safeStorage → Keychain 的應用程式金鑰）包裝後放在檔頭；
//   AAD 綁定格式、版本、種類與 ID，檔案不能被換名或換到別筆。
// - 檔案 0600、資料夾 0700；寫入是 唯一暫存檔 → fsync → rename → 資料夾 fsync（同 server/memory/store.ts）。
// - 刪除＝刪檔（file deletion）：那把資料金鑰只在這個檔裡，檔案刪掉後 Nous 自己就解不開了；但這不是密碼學上的抹除
//   （crypto-shred）：已存在的 Time Machine 備份、APFS 快照或尚未覆寫的磁區仍可能留有舊檔，而包裝金鑰的應用程式金鑰
//   不輪換，理論上仍可解開（見 docs/validation/memory-mem4a-2026-10-30.md）。
// - 單一寫入者：資料夾裡的 writer.lock 用和記憶檔相同的 BSD 鎖（macOS /usr/bin/lockf；Linux 測試用 flock(1)）。
//   唯一的呼叫者是 TaskStore（核心裡同步呼叫，不會交錯）；鎖只防第二個核心同時寫同一個資料夾。
//   不和 MemoryStore 共用鎖：任務加密不論記憶開不開都要運作，而記憶檔只在使用者用到記憶時才開（不能為了任務去開它）。

export const SEALED_FORMAT = "nous.task.sealed";
export const SEALED_VERSION = 1;
export type SealedKind = "task" | "artifact";
const SEALED_ID = /^(task|artifact)_[0-9a-f-]{36}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type VaultFailure = "key_unavailable" | "locked" | "permissions" | "corrupt" | "unavailable";
export class VaultError extends Error { constructor(readonly code: VaultFailure) { super(`vault_${code}`); } }

interface Envelope { format: typeof SEALED_FORMAT; version: typeof SEALED_VERSION; kind: SealedKind; id: string; wrappedKey: string; nonce: string; tag: string; ciphertext: string }

export interface SealedVaultOptions {
  dir: string;
  secretBox: MemorySecretBox;
  /** 測試專用（同 MemoryStoreOptions.lockProvider）：Linux CI 用 flock(1)；正式只在 macOS 用 /usr/bin/lockf。 */
  lockProvider?: MemoryLockProvider;
  /** 測試專用的崩潰點。 */
  checkpoint?: (stage: "before_write" | "after_file_sync" | "after_rename") => void;
}

function aad(e: Pick<Envelope, "format" | "version" | "kind" | "id" | "wrappedKey">): Buffer {
  return Buffer.from(JSON.stringify([e.format, e.version, e.kind, e.id, e.wrappedKey]));
}

export function sealedKind(id: string): SealedKind | null {
  return SEALED_ID.test(id) ? (id.startsWith("task_") ? "task" : "artifact") : null;
}

export class SealedVault {
  private lockFd: number | undefined;
  readonly dir: string;
  private constructor(private readonly options: SealedVaultOptions) { this.dir = resolve(options.dir); }

  /** 開啟（建資料夾、取鎖）。金鑰不可用、鎖被占用或權限不符時丟 VaultError；不退回明文。 */
  static open(options: SealedVaultOptions): SealedVault {
    const vault = new SealedVault(options);
    vault.start();
    return vault;
  }

  private inspect(path: string, directory: boolean): void {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o777) !== (directory ? 0o700 : 0o600) || s.uid !== process.getuid?.()) throw new VaultError("permissions");
  }

  private start(): void {
    if (!this.options.lockProvider && process.platform !== "darwin") throw new VaultError("unavailable");
    if (!this.options.secretBox.available()) throw new VaultError("key_unavailable");
    // 審查 B1：available() 只說「可以加密」，不保證這次真的解得開（Keychain 可能拒絕解密）。開啟前實際包裝再解開一次。
    try {
      const probe = randomBytes(16).toString("hex");
      if (this.options.secretBox.open(this.options.secretBox.seal(probe)) !== probe) throw Error();
    } catch { throw new VaultError("key_unavailable"); }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.inspect(this.dir, true);
    const lock = join(this.dir, "writer.lock");
    try {
      this.lockFd = openSync(lock, constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
      this.inspect(lock, false);
      const status = this.options.lockProvider
        ? this.options.lockProvider(this.lockFd)
        : spawnSync("/usr/bin/lockf", ["-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", this.lockFd] }).status;
      if (status !== 0) throw new VaultError(status === 75 ? "locked" : "unavailable");
      // 上次寫到一半的暫存檔（rename 之前中斷）：內容不完整，直接刪掉。
      for (const name of readdirSync(this.dir)) if (/\.enc\.tmp-[0-9a-f-]+$/.test(name)) unlinkSync(join(this.dir, name));
    } catch (error) {
      this.close();
      throw error instanceof VaultError ? error : new VaultError("unavailable");
    }
  }

  close(): void {
    if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; }
  }

  available(): boolean { return this.lockFd !== undefined && this.options.secretBox.available(); }

  private file(id: string): string {
    if (!sealedKind(id)) throw new VaultError("corrupt");
    return join(this.dir, `${id}.enc`);
  }

  /** 加密寫入一筆（整檔取代）；舊檔與它的資料金鑰一起被取代。 */
  write(id: string, value: unknown): void {
    const kind = sealedKind(id);
    if (!kind || this.lockFd === undefined) throw new VaultError("unavailable");
    if (!this.options.secretBox.available()) throw new VaultError("key_unavailable");
    this.inspect(this.dir, true);
    const key = randomBytes(32), nonce = randomBytes(12), plain = Buffer.from(JSON.stringify(value));
    let temporary: string | undefined;
    try {
      if (plain.length > MAX_FILE_BYTES) throw new VaultError("unavailable");
      let wrapped: string;
      try { wrapped = this.options.secretBox.seal(key.toString("base64")).toString("base64"); } catch { throw new VaultError("key_unavailable"); }
      const header = { format: SEALED_FORMAT, version: SEALED_VERSION, kind, id, wrappedKey: wrapped } as const;
      const c = createCipheriv("aes-256-gcm", key, nonce); c.setAAD(aad(header));
      const ciphertext = Buffer.concat([c.update(plain), c.final()]);
      const raw = JSON.stringify({ ...header, nonce: nonce.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
      const target = this.file(id);
      this.options.checkpoint?.("before_write");
      temporary = `${target}.tmp-${randomUUID()}`;
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      this.options.checkpoint?.("after_file_sync");
      renameSync(temporary, target); temporary = undefined;
      this.options.checkpoint?.("after_rename");
      this.syncDir();
    } finally {
      key.fill(0); plain.fill(0);
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** 解密讀取；檔案不存在回 null；被改動、換名或金鑰解不開丟 VaultError。 */
  read<T>(id: string): T | null {
    const target = this.file(id);
    if (!existsSync(target)) return null;
    this.inspect(target, false);
    if (lstatSync(target).size > MAX_FILE_BYTES * 2) throw new VaultError("corrupt");
    let e: Envelope;
    try {
      e = JSON.parse(readFileSync(target, "utf8")) as Envelope;
      if (!e || e.format !== SEALED_FORMAT || e.version !== SEALED_VERSION || e.kind !== sealedKind(id) || e.id !== id || typeof e.wrappedKey !== "string" || typeof e.ciphertext !== "string"
        || Buffer.from(e.nonce, "base64").length !== 12 || Buffer.from(e.tag, "base64").length !== 16) throw Error();
    } catch { throw new VaultError("corrupt"); }
    let key: Buffer;
    try { key = Buffer.from(this.options.secretBox.open(Buffer.from(e.wrappedKey, "base64")), "base64"); if (key.length !== 32) throw Error(); }
    catch { throw new VaultError("key_unavailable"); }
    let plain: Buffer | undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.nonce, "base64")); d.setAAD(aad(e)); d.setAuthTag(Buffer.from(e.tag, "base64"));
      plain = Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch { throw new VaultError("corrupt"); } finally { key.fill(0); plain?.fill(0); }
  }

  /** 刪檔（file deletion）。不存在也算成功。 */
  remove(id: string): void {
    const target = this.file(id);
    try { unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return; }
    this.syncDir();
  }

  /** 資料夾裡的加密檔 ID（不解密）。 */
  ids(): string[] {
    return readdirSync(this.dir).filter(n => n.endsWith(".enc")).map(n => n.slice(0, -4)).filter(id => sealedKind(id) !== null);
  }

  private syncDir(): void {
    const directory = openSync(this.dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
