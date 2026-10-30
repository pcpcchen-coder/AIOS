import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MEMORY_FILE = "store.v1.enc";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECEIPTS = 2048;
const FORMAT = "nous.memory.snapshot";
const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface MemorySecretBox { available(): boolean; seal(plain: string): Buffer; open(sealed: Buffer): string }
/** 快照格式版本：MEM-1 起為 2；讀到 1 時只在記憶體內升級（檔名照舊 store.v1.enc），下次寫入才以 2 保存。 */
export const SNAPSHOT_VERSION = 2;
export const FACT_KINDS = ["preference", "note"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
/** 首次同意設定（16 §4）：記憶預設關閉；自動建議首版固定關閉（MEM-5 才提供）。 */
export interface MemorySettings { enabled: boolean; setupAt: string | null; suggestions: false }
/** facePersonId：可移除的家人辨識連結（ADR-0001 的 person_id）；minor 跟著連結的登記資料，MEM-1 聊天不寫未成年人物。 */
export interface MemoryProfile { id: string; name: string; createdAt: string; facePersonId: string | null; minor: boolean }
export interface MemoryFact {
  id: string; profileId: string | null; revision: number; kind: FactKind; topic: string; key: string; value: string;
  /** 首版只接受 household：家中可使用，不是私密空間（16 §3）。 */
  audience: "household";
  /** explicit：打字或畫面點擊；voice_confirmed：MEM-2 即時語音的確認詞（George 2026-10-30）。 */
  source: { kind: "explicit" | "voice_confirmed"; turnId: string; at: string; excerpt: string };
  validFrom: string; expiresAt: string | null; reviewAfter: string | null; pinned: boolean;
}
export interface MemoryConsent { profileId: string | null; provider: string; account: string; allowed: boolean }
export interface MemoryData { settings: MemorySettings; profiles: MemoryProfile[]; facts: MemoryFact[]; consents: MemoryConsent[]; tombstones: { id: string; revision: number }[] }
export type MemoryOutcome = "saved" | "updated" | "forgotten" | "unchanged";
export interface MemoryReceipt { operationId: string; digest: string; status: MemoryOutcome; revision: number; issuedAt: number }
export interface MemorySnapshot extends MemoryData {
  format: typeof FORMAT; version: typeof SNAPSHOT_VERSION; revision: number; dedupKey: string; receiptFloor: number; receipts: MemoryReceipt[];
}
export interface StoreOperation {
  operationId: string; issuedAt: number; expiresAt: number; expectedRevision: number; fingerprint: string;
}
export type StoreResult = { status: MemoryOutcome; revision: number } | { status: "conflict" | "receipt_expired" | "unavailable" };
export type StoreFailure = "locked" | "key_unavailable" | "corrupt" | "permissions" | "unavailable";
export class MemoryStoreError extends Error { constructor(readonly code: StoreFailure) { super(`memory_${code}`); } }
interface Envelope { format: typeof FORMAT; version: 1 | 2; revision: number; wrappedKey: string; nonce: string; tag: string; ciphertext: string }
/** 測試用的單寫入者鎖：對繼承的 fd 3 取 BSD 鎖，回傳結束碼（0 成功、75 被占用）。 */
export type MemoryLockProvider = (fd: number) => number | null;
export interface MemoryStoreOptions {
  dir: string; secretBox: MemorySecretBox; now?: () => number;
  /** Isolated crash fixtures only. No production caller supplies this. */
  checkpoint?: (stage: "before_write" | "after_file_sync" | "after_rename" | "after_dir_sync") => void;
  /**
   * Tests only (like checkpoint). Production always uses macOS /usr/bin/lockf and refuses other platforms; this hook lets
   * Linux CI run the real AES-GCM, rename and crash-point tests with an equivalent flock(1) lock. No production caller supplies it.
   */
  lockProvider?: MemoryLockProvider;
}
/** MemoryService 依賴的最小介面（測試可換成假 store）。只在核心使用，不交給 renderer 或模型。 */
export interface MemoryStoreLike {
  read(): MemorySnapshot;
  receipt(operationId: string): StoreResult;
  commit(operation: StoreOperation, change: (data: MemoryData) => MemoryOutcome): Promise<StoreResult>;
  close(): Promise<void>;
}

function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === "object" && !Array.isArray(x); }
function keys(x: Record<string, unknown>, names: string[]) { return Object.keys(x).sort().join() === names.sort().join(); }
function text(x: unknown, max: number): x is string { return typeof x === "string" && x.length > 0 && [...x].length <= max; }
function integer(x: unknown): x is number { return Number.isSafeInteger(x) && (x as number) >= 0; }
function operationTime(id: unknown): number | null {
  if (typeof id !== "string" || !OPERATION_ID.test(id)) return null;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
function date(x: unknown): x is string { return typeof x === "string" && Number.isFinite(Date.parse(x)); }
function unique(xs: { id: string }[]) { return new Set(xs.map(x => x.id)).size === xs.length; }
const ITEM_LIMIT = 1000;
function validSettings(x: unknown): x is MemorySettings {
  return record(x) && keys(x, ["enabled", "setupAt", "suggestions"]) && typeof x.enabled === "boolean" && (x.setupAt === null || date(x.setupAt)) && x.suggestions === false;
}
function validBody(x: Record<string, unknown>, version: 1 | 2): boolean {
  const profileKeys = version === 1 ? ["id", "name", "createdAt"] : ["id", "name", "createdAt", "facePersonId", "minor"];
  if (!Array.isArray(x.profiles) || x.profiles.length > ITEM_LIMIT || !x.profiles.every(p => record(p) && keys(p, profileKeys) && text(p.id, 100) && text(p.name, 80) && date(p.createdAt)
    && (version === 1 || ((p.facePersonId === null || text(p.facePersonId, 100)) && typeof p.minor === "boolean"))) || !unique(x.profiles)) return false;
  const ids = new Set(x.profiles.map(p => p.id));
  const subject = (p: unknown) => p === null || (typeof p === "string" && ids.has(p));
  const factKeys = version === 1 ? ["id", "profileId", "revision", "topic", "key", "value", "source", "expiresAt"]
    : ["id", "profileId", "revision", "kind", "topic", "key", "value", "audience", "source", "validFrom", "expiresAt", "reviewAfter", "pinned"];
  if (!Array.isArray(x.facts) || x.facts.length > ITEM_LIMIT || !x.facts.every(f => record(f) && keys(f, factKeys) && text(f.id, 100) && subject(f.profileId) && integer(f.revision) && f.revision > 0 && f.revision <= (x.revision as number) && text(f.topic, 80) && text(f.key, 100) && text(f.value, 512) && (f.expiresAt === null || date(f.expiresAt)) && record(f.source) && keys(f.source, ["kind", "turnId", "at", "excerpt"]) && (f.source.kind === "explicit" || f.source.kind === "voice_confirmed") && text(f.source.turnId, 100) && date(f.source.at) && text(f.source.excerpt, 240)
    && (version === 1 || ((FACT_KINDS as readonly unknown[]).includes(f.kind) && f.audience === "household" && date(f.validFrom) && (f.reviewAfter === null || date(f.reviewAfter)) && typeof f.pinned === "boolean"))) || !unique(x.facts)) return false;
  if (!Array.isArray(x.consents) || x.consents.length > ITEM_LIMIT || !x.consents.every(c => record(c) && keys(c, ["profileId", "provider", "account", "allowed"]) && subject(c.profileId) && text(c.provider, 100) && text(c.account, 200) && typeof c.allowed === "boolean")) return false;
  if (!Array.isArray(x.receipts) || x.receipts.length > MAX_RECEIPTS || !x.receipts.every(r => record(r) && keys(r, ["operationId", "digest", "status", "revision", "issuedAt"]) && operationTime(r.operationId) === r.issuedAt && typeof r.digest === "string" && /^[a-f0-9]{64}$/.test(r.digest) && ["saved", "updated", "forgotten", "unchanged"].includes(r.status as string) && integer(r.revision) && r.revision <= (x.revision as number) && integer(r.issuedAt)) || new Set(x.receipts.map(r => r.operationId)).size !== x.receipts.length) return false;
  return Array.isArray(x.tombstones) && x.tombstones.length <= 10000 && x.tombstones.every(t => record(t) && keys(t, ["id", "revision"]) && text(t.id, 100) && integer(t.revision) && t.revision <= (x.revision as number)) && unique(x.tombstones);
}
const HEAD = ["format", "version", "revision", "dedupKey", "receiptFloor", "profiles", "facts", "consents", "receipts", "tombstones"];
function validHead(x: Record<string, unknown>, version: 1 | 2): boolean {
  return x.format === FORMAT && x.version === version && integer(x.revision) && integer(x.receiptFloor) && typeof x.dedupKey === "string" && /^[a-f0-9]{64}$/.test(x.dedupKey);
}
export function validSnapshot(x: unknown): x is MemorySnapshot {
  return record(x) && keys(x, [...HEAD, "settings"]) && validHead(x, 2) && validSettings(x.settings) && validBody(x, 2);
}
/** MEM-0（version 1）快照：只在記憶體內升級。舊資料沒有同意設定，記憶維持關閉；舊記錄視為未釘選、家中可使用的偏好。 */
function upgradeV1(x: unknown): MemorySnapshot | null {
  if (!record(x) || !keys(x, HEAD) || !validHead(x, 1) || !validBody(x, 1)) return null;
  const v1 = x as unknown as Omit<MemorySnapshot, "version" | "settings" | "profiles" | "facts"> & {
    profiles: { id: string; name: string; createdAt: string }[];
    facts: (Omit<MemoryFact, "kind" | "audience" | "validFrom" | "reviewAfter" | "pinned">)[];
  };
  const next: MemorySnapshot = {
    ...v1,
    version: SNAPSHOT_VERSION,
    settings: { enabled: false, setupAt: null, suggestions: false },
    profiles: v1.profiles.map(p => ({ ...p, facePersonId: null, minor: false })),
    facts: v1.facts.map(f => ({ ...f, kind: "preference" as const, audience: "household" as const, validFrom: f.source.at, reviewAfter: null, pinned: false })),
  };
  return validSnapshot(next) ? next : null;
}
function aad(e: Pick<Envelope, "format" | "version" | "revision" | "wrappedKey">) { return Buffer.from(JSON.stringify([e.format, e.version, e.revision, e.wrappedKey])); }

export class MemoryStore implements MemoryStoreLike {
  private state!: MemorySnapshot;
  private lockFd: number | undefined;
  private diskToken: string | null = null;
  private active = false;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly options: MemoryStoreOptions) {}
  static async open(options: MemoryStoreOptions): Promise<MemoryStore> {
    const store = new MemoryStore(options);
    store.start();
    return store;
  }
  private inspect(path: string, directory: boolean) {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o777) !== (directory ? 0o700 : 0o600) || s.uid !== process.getuid?.()) throw new MemoryStoreError("permissions");
  }
  private disk(): string | null {
    const file = join(this.options.dir, MEMORY_FILE);
    try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    this.inspect(file, false);
    if (lstatSync(file).size > 15 * 1024 * 1024) throw new MemoryStoreError("corrupt");
    return readFileSync(file, "utf8");
  }
  private hash(raw: string | null) { return raw === null ? null : createHash("sha256").update(raw).digest("hex"); }
  private start() {
    if (!this.options.lockProvider && process.platform !== "darwin") throw new MemoryStoreError("unavailable");
    if (!this.options.secretBox.available()) throw new MemoryStoreError("key_unavailable");
    this.options.dir = resolve(this.options.dir);
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    this.inspect(this.options.dir, true);
    const lock = join(this.options.dir, "writer.lock");
    try {
      this.lockFd = openSync(lock, constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
      this.inspect(lock, false);
      // BSD flock belongs to the shared open file description. The parent keeps that fd after lockf exits.
      const status = this.options.lockProvider
        ? this.options.lockProvider(this.lockFd)
        : spawnSync("/usr/bin/lockf", ["-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", this.lockFd] }).status;
      if (status !== 0) throw new MemoryStoreError(status === 75 ? "locked" : "unavailable");
      const raw = this.disk();
      this.diskToken = this.hash(raw);
      this.state = raw === null ? { format: FORMAT, version: SNAPSHOT_VERSION, revision: 0, dedupKey: randomBytes(32).toString("hex"), receiptFloor: 0, settings: { enabled: false, setupAt: null, suggestions: false }, profiles: [], facts: [], consents: [], tombstones: [], receipts: [] } : this.decrypt(raw);
      for (const name of readdirSync(this.options.dir)) if (/^store\.v1\.enc\.tmp-[a-f0-9-]+$/.test(name)) unlinkSync(join(this.options.dir, name));
      this.active = true;
    } catch (error) {
      this.fail();
      throw error instanceof MemoryStoreError ? error : new MemoryStoreError("unavailable");
    }
  }
  private fail() { this.active = false; if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; } }
  private decrypt(raw: string): MemorySnapshot {
    let e: Envelope;
    try {
      e = JSON.parse(raw) as Envelope;
      if (!record(e) || !keys(e, ["format", "version", "revision", "wrappedKey", "nonce", "tag", "ciphertext"]) || e.format !== FORMAT || (e.version !== 1 && e.version !== 2) || !integer(e.revision) || typeof e.wrappedKey !== "string" || typeof e.nonce !== "string" || typeof e.tag !== "string" || typeof e.ciphertext !== "string" || Buffer.from(e.nonce, "base64").length !== 12 || Buffer.from(e.tag, "base64").length !== 16) throw Error();
    } catch { throw new MemoryStoreError("corrupt"); }
    let key: Buffer;
    try { key = Buffer.from(this.options.secretBox.open(Buffer.from(e.wrappedKey, "base64")), "base64"); if (key.length !== 32) throw Error(); }
    catch { throw new MemoryStoreError("key_unavailable"); }
    let plain: Buffer | undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.nonce, "base64")); d.setAAD(aad(e)); d.setAuthTag(Buffer.from(e.tag, "base64"));
      plain = Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]);
      if (plain.length > MAX_BYTES) throw Error();
      const parsed: unknown = JSON.parse(plain.toString("utf8"));
      if (!record(parsed) || parsed.version !== e.version) throw Error();
      const state = e.version === 1 ? upgradeV1(parsed) : validSnapshot(parsed) ? parsed : null;
      if (!state || state.revision !== e.revision) throw Error();
      return state;
    } catch { throw new MemoryStoreError("corrupt"); } finally { key.fill(0); plain?.fill(0); }
  }
  private encrypt(state: MemorySnapshot): string {
    if (!this.options.secretBox.available()) throw new MemoryStoreError("key_unavailable");
    const key = randomBytes(32), nonce = randomBytes(12), plain = Buffer.from(JSON.stringify(state));
    try {
      if (plain.length > MAX_BYTES) throw new MemoryStoreError("unavailable");
      const header: Pick<Envelope, "format" | "version" | "revision" | "wrappedKey"> = { format: FORMAT, version: SNAPSHOT_VERSION, revision: state.revision, wrappedKey: this.options.secretBox.seal(key.toString("base64")).toString("base64") };
      const c = createCipheriv("aes-256-gcm", key, nonce); c.setAAD(aad(header));
      const ciphertext = Buffer.concat([c.update(plain), c.final()]);
      return JSON.stringify({ ...header, nonce: nonce.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    } finally { key.fill(0); plain.fill(0); }
  }
  read(): MemorySnapshot { if (!this.active) throw new MemoryStoreError("unavailable"); return structuredClone(this.state); }
  receipt(operationId: string): StoreResult {
    if (!this.active) return { status: "unavailable" };
    const r = this.state.receipts.find(x => x.operationId === operationId);
    return r ? { status: r.status, revision: r.revision } : { status: "receipt_expired" };
  }
  commit(operation: StoreOperation, change: (data: MemoryData) => MemoryOutcome): Promise<StoreResult> {
    const captured = structuredClone(operation);
    const run = this.queue.then(() => this.apply(captured, change));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async apply(op: StoreOperation, change: (data: MemoryData) => MemoryOutcome): Promise<StoreResult> {
    if (!this.active) return { status: "unavailable" };
    if (!integer(op.issuedAt) || operationTime(op.operationId) !== op.issuedAt || !integer(op.expiresAt) || !integer(op.expectedRevision) || typeof op.fingerprint !== "string" || Buffer.byteLength(op.fingerprint) > MAX_BYTES) return { status: "conflict" };
    const digest = createHmac("sha256", Buffer.from(this.state.dedupKey, "hex")).update(JSON.stringify([op.issuedAt, op.expiresAt, op.expectedRevision, op.fingerprint])).digest("hex");
    const previous = this.state.receipts.find(r => r.operationId === op.operationId);
    if (previous) return previous.digest === digest ? { status: previous.status, revision: previous.revision } : { status: "conflict" };
    const now = (this.options.now ?? Date.now)();
    if (op.issuedAt <= this.state.receiptFloor || op.issuedAt > now || op.expiresAt <= now || op.expiresAt <= op.issuedAt || op.expiresAt - op.issuedAt > 5 * 60_000) return { status: "receipt_expired" };
    if (op.expectedRevision !== this.state.revision) return { status: "conflict" };
    try {
      const next = structuredClone(this.state);
      const data: MemoryData = { settings: next.settings, profiles: next.profiles, facts: next.facts, consents: next.consents, tombstones: next.tombstones };
      const status = change(data);
      Object.assign(next, data);
      next.revision++;
      next.receipts.push({ operationId: op.operationId, digest, status, revision: next.revision, issuedAt: op.issuedAt });
      while (next.receipts.length > MAX_RECEIPTS) {
        const old = next.receipts.shift()!; next.receiptFloor = Math.max(next.receiptFloor, old.issuedAt);
      }
      if (!validSnapshot(next)) return { status: "conflict" };
      const raw = this.encrypt(next);
      this.persist(raw);
      this.diskToken = this.hash(raw); this.state = structuredClone(next);
      return { status, revision: next.revision };
    } catch { this.fail(); return { status: "unavailable" }; }
  }
  private persist(raw: string) {
    this.inspect(this.options.dir, true);
    if (this.lockFd === undefined || this.hash(this.disk()) !== this.diskToken) throw new MemoryStoreError("unavailable");
    const held = fstatSync(this.lockFd), named = lstatSync(join(this.options.dir, "writer.lock"));
    if (named.isSymbolicLink() || held.ino !== named.ino || held.dev !== named.dev) throw new MemoryStoreError("unavailable");
    const file = join(this.options.dir, MEMORY_FILE);
    let temporary: string | undefined;
    try {
      this.options.checkpoint?.("before_write");
      temporary = `${file}.tmp-${randomUUID()}`;
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      this.options.checkpoint?.("after_file_sync");
      renameSync(temporary, file); temporary = undefined;
      this.options.checkpoint?.("after_rename");
      const directory = openSync(this.options.dir, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.options.checkpoint?.("after_dir_sync");
    } finally { if (temporary && existsSync(temporary)) unlinkSync(temporary); }
  }
  async close(): Promise<void> { await this.queue; this.fail(); }

}

export function newStoreOperation(revision: number, fingerprint: string, now = Date.now()): StoreOperation {
  if (!integer(now) || now > 0xffffffffffff) throw new Error("invalid_operation_time");
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { operationId, issuedAt: now, expiresAt: now + 60_000, expectedRevision: revision, fingerprint };
}
