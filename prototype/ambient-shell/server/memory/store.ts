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
/**
 * MEM-4a：受保護成果的依賴索引（results）。只有第一次產生受保護成果時才以 3 寫入；在那之前一律照 2 寫（逐位元組同 MEM-3）。
 * 舊版 App 讀到 3 會當成損壞而停用記憶（不會覆寫），見 docs/validation/memory-mem4a-2026-10-30.md。
 */
export const RESULTS_SNAPSHOT_VERSION = 3;
/**
 * MEM-5a：記憶建議與家庭協同的欄位（fact.source.kind "suggestion"、fact.source.by、settings.suggestions true）以及給 MEM-5b
 * 預留的 fact.kind "work_summary" 與 fact.derivedFrom。記憶體裡一律是 4 的形狀；只有真的用到這些內容時才以 4 寫入，
 * 否則照 2／3 寫（逐位元組同 MEM-4c，見 diskForm）。舊版 App 讀到 4 會當成損壞而停用記憶（不會覆寫），
 * 見 docs/validation/memory-mem5a-2026-10-30.md。
 */
export const SUGGEST_SNAPSHOT_VERSION = 4;
export const RESULT_ID = /^res_[a-f0-9]{16}$/;
const TASK_ID = /^task_[0-9a-f-]{36}$/;
export const RESULT_LIMIT = 2000;
/**
 * 一筆受保護成果的依賴：用到哪幾筆記憶（ID 與當時的版本）、哪位人物、送給哪個服務帳號。沒有任何內容。
 * state：active＝成果仍有效；withdrawn＝依賴被撤銷，成果內容已移除（deps 清空、subject 改 null）。
 */
export interface MemoryResult {
  id: string; taskId: string; subject: string | null; deps: { factId: string; revision: number }[];
  target: { provider: string; account: string }; createdAt: string; state: "active" | "withdrawn";
}
/** version 2／3 可以保存的類別。 */
export const FACT_KINDS = ["preference", "note"] as const;
/** version 4 另外接受 work_summary（MEM-5b 才實作行為；MEM-5a 只先放進格式，避免再升一次版本）。 */
export const FACT_KINDS_V4 = ["preference", "note", "work_summary"] as const;
export type FactKind = (typeof FACT_KINDS_V4)[number];
export type FactSourceKind = "explicit" | "voice_confirmed" | "suggestion";
/**
 * 首次同意設定（16 §4）：記憶預設關閉。suggestions：MEM-5a 的記憶建議，預設 false；只有在記憶管理（管理權杖）明確開啟，
 * 而且 NOUS_MEMORY_ROUTES 列出 suggest 時才生效。true 只能以 version 4 保存。
 */
export interface MemorySettings { enabled: boolean; setupAt: string | null; suggestions: boolean }
/** facePersonId：可移除的家人辨識連結（ADR-0001 的 person_id）；minor 跟著連結的登記資料，MEM-1 聊天不寫未成年人物。 */
export interface MemoryProfile { id: string; name: string; createdAt: string; facePersonId: string | null; minor: boolean }
export interface MemoryFact {
  id: string; profileId: string | null; revision: number; kind: FactKind; topic: string; key: string; value: string;
  /** 首版只接受 household：家中可使用，不是私密空間（16 §3）。 */
  audience: "household";
  /**
   * explicit：打字或畫面點擊；voice_confirmed：MEM-2 即時語音的確認詞（George 2026-10-30）；suggestion：MEM-5a 記憶建議上按「記住」。
   * by：MEM-5a 家庭協同，全家共用的事實由哪位本次人物記下（只是當時選定的人物，不是身分驗證）；其他一律 null。
   */
  source: { kind: FactSourceKind; turnId: string; at: string; excerpt: string; by: string | null };
  validFrom: string; expiresAt: string | null; reviewAfter: string | null; pinned: boolean;
  /** MEM-5b 預留：work_summary 來自哪個任務；其他類別一律 null。 */
  derivedFrom: { taskId: string } | null;
}
export interface MemoryConsent { profileId: string | null; provider: string; account: string; allowed: boolean }
export interface MemoryData { settings: MemorySettings; profiles: MemoryProfile[]; facts: MemoryFact[]; consents: MemoryConsent[]; tombstones: { id: string; revision: number }[]; results: MemoryResult[] }
export type MemoryOutcome = "saved" | "updated" | "forgotten" | "unchanged";
export interface MemoryReceipt { operationId: string; digest: string; status: MemoryOutcome; revision: number; issuedAt: number }
export interface MemorySnapshot extends MemoryData {
  format: typeof FORMAT; version: typeof SNAPSHOT_VERSION | typeof RESULTS_SNAPSHOT_VERSION | typeof SUGGEST_SNAPSHOT_VERSION; revision: number; dedupKey: string; receiptFloor: number; receipts: MemoryReceipt[];
}
export interface StoreOperation {
  operationId: string; issuedAt: number; expiresAt: number; expectedRevision: number; fingerprint: string;
}
export type StoreResult = { status: MemoryOutcome; revision: number } | { status: "conflict" | "receipt_expired" | "unavailable" };
export type StoreFailure = "locked" | "key_unavailable" | "corrupt" | "permissions" | "unavailable";
export class MemoryStoreError extends Error { constructor(readonly code: StoreFailure) { super(`memory_${code}`); } }
interface Envelope { format: typeof FORMAT; version: 1 | 2 | 3 | 4; revision: number; wrappedKey: string; nonce: string; tag: string; ciphertext: string }
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
function validSettings(x: unknown, version: 2 | 3 | 4): x is MemorySettings {
  return record(x) && keys(x, ["enabled", "setupAt", "suggestions"]) && typeof x.enabled === "boolean" && (x.setupAt === null || date(x.setupAt)) && (version === 4 ? typeof x.suggestions === "boolean" : x.suggestions === false);
}
function validResults(x: Record<string, unknown>, ids: Set<string>): boolean {
  if (!Array.isArray(x.results) || x.results.length > RESULT_LIMIT) return false;
  const facts = new Set((x.facts as { id: string }[]).map(f => f.id));
  return x.results.every(r => record(r) && keys(r, ["id", "taskId", "subject", "deps", "target", "createdAt", "state"]) && typeof r.id === "string" && RESULT_ID.test(r.id)
    && typeof r.taskId === "string" && /^task_[0-9a-f-]{36}$/.test(r.taskId) && (r.subject === null || (typeof r.subject === "string" && ids.has(r.subject)))
    && Array.isArray(r.deps) && r.deps.length <= 8 && r.deps.every(d => record(d) && keys(d, ["factId", "revision"]) && text(d.factId, 100) && integer(d.revision) && (r.state !== "active" || facts.has(d.factId as string)))
    && record(r.target) && keys(r.target, ["provider", "account"]) && text(r.target.provider, 100) && text(r.target.account, 200) && date(r.createdAt)
    && (r.state === "active" || (r.state === "withdrawn" && (r.deps as unknown[]).length === 0 && r.subject === null))) && unique(x.results as { id: string }[]);
}
function validBody(x: Record<string, unknown>, version: 1 | 2 | 3 | 4): boolean {
  const profileKeys = version === 1 ? ["id", "name", "createdAt"] : ["id", "name", "createdAt", "facePersonId", "minor"];
  if (!Array.isArray(x.profiles) || x.profiles.length > ITEM_LIMIT || !x.profiles.every(p => record(p) && keys(p, profileKeys) && text(p.id, 100) && text(p.name, 80) && date(p.createdAt)
    && (version === 1 || ((p.facePersonId === null || text(p.facePersonId, 100)) && typeof p.minor === "boolean"))) || !unique(x.profiles)) return false;
  const ids = new Set(x.profiles.map(p => p.id));
  const subject = (p: unknown) => p === null || (typeof p === "string" && ids.has(p));
  const factKeys = version === 1 ? ["id", "profileId", "revision", "topic", "key", "value", "source", "expiresAt"]
    : ["id", "profileId", "revision", "kind", "topic", "key", "value", "audience", "source", "validFrom", "expiresAt", "reviewAfter", "pinned", ...(version === 4 ? ["derivedFrom"] : [])];
  const sourceKeys = ["kind", "turnId", "at", "excerpt", ...(version === 4 ? ["by"] : [])];
  const sourceKinds: readonly unknown[] = version === 4 ? ["explicit", "voice_confirmed", "suggestion"] : ["explicit", "voice_confirmed"];
  const kinds: readonly unknown[] = version === 4 ? FACT_KINDS_V4 : FACT_KINDS;
  // version 4：by 只能是既有人物（或 null），而且只有全家共用的事實才有；derivedFrom 只有 work_summary 才可以不是 null。
  const v4Fields = (f: Record<string, unknown>, source: Record<string, unknown>) => version !== 4 || ((source.by === null || (typeof source.by === "string" && ids.has(source.by) && f.profileId === null))
    && (f.derivedFrom === null || (f.kind === "work_summary" && record(f.derivedFrom) && keys(f.derivedFrom, ["taskId"]) && typeof f.derivedFrom.taskId === "string" && TASK_ID.test(f.derivedFrom.taskId))));
  if (!Array.isArray(x.facts) || x.facts.length > ITEM_LIMIT || !x.facts.every(f => record(f) && keys(f, factKeys) && text(f.id, 100) && subject(f.profileId) && integer(f.revision) && f.revision > 0 && f.revision <= (x.revision as number) && text(f.topic, 80) && text(f.key, 100) && text(f.value, 512) && (f.expiresAt === null || date(f.expiresAt)) && record(f.source) && keys(f.source, sourceKeys) && sourceKinds.includes(f.source.kind) && text(f.source.turnId, 100) && date(f.source.at) && text(f.source.excerpt, 240)
    && (version === 1 || (kinds.includes(f.kind) && f.audience === "household" && date(f.validFrom) && (f.reviewAfter === null || date(f.reviewAfter)) && typeof f.pinned === "boolean" && v4Fields(f, f.source as Record<string, unknown>)))) || !unique(x.facts)) return false;
  if (!Array.isArray(x.consents) || x.consents.length > ITEM_LIMIT || !x.consents.every(c => record(c) && keys(c, ["profileId", "provider", "account", "allowed"]) && subject(c.profileId) && text(c.provider, 100) && text(c.account, 200) && typeof c.allowed === "boolean")) return false;
  if (!Array.isArray(x.receipts) || x.receipts.length > MAX_RECEIPTS || !x.receipts.every(r => record(r) && keys(r, ["operationId", "digest", "status", "revision", "issuedAt"]) && operationTime(r.operationId) === r.issuedAt && typeof r.digest === "string" && /^[a-f0-9]{64}$/.test(r.digest) && ["saved", "updated", "forgotten", "unchanged"].includes(r.status as string) && integer(r.revision) && r.revision <= (x.revision as number) && integer(r.issuedAt)) || new Set(x.receipts.map(r => r.operationId)).size !== x.receipts.length) return false;
  if ((version === 3 || version === 4) && !validResults(x, ids)) return false;
  return Array.isArray(x.tombstones) && x.tombstones.length <= 10000 && x.tombstones.every(t => record(t) && keys(t, ["id", "revision"]) && text(t.id, 100) && integer(t.revision) && t.revision <= (x.revision as number)) && unique(x.tombstones);
}
const HEAD = ["format", "version", "revision", "dedupKey", "receiptFloor", "profiles", "facts", "consents", "receipts", "tombstones"];
function validHead(x: Record<string, unknown>, version: 1 | 2 | 3 | 4): boolean {
  return x.format === FORMAT && x.version === version && integer(x.revision) && integer(x.receiptFloor) && typeof x.dedupKey === "string" && /^[a-f0-9]{64}$/.test(x.dedupKey);
}
/** 磁碟上的快照（version 2 沒有 results 欄位；version 3、4 有；version 4 的 fact 多 derivedFrom、source 多 by）。 */
export function validSnapshot(x: unknown): x is MemorySnapshot {
  if (!record(x)) return false;
  if (x.version === SUGGEST_SNAPSHOT_VERSION) return keys(x, [...HEAD, "settings", "results"]) && validHead(x, 4) && validSettings(x.settings, 4) && validBody(x, 4);
  if (x.version === RESULTS_SNAPSHOT_VERSION) return keys(x, [...HEAD, "settings", "results"]) && validHead(x, 3) && validSettings(x.settings, 3) && validBody(x, 3);
  return keys(x, [...HEAD, "settings"]) && validHead(x, 2) && validSettings(x.settings, 2) && validBody(x, 2);
}
/**
 * 記憶體裡的快照一律是 version 4 的形狀：有 results（version 2 時是空陣列）、每筆 fact 有 derivedFrom、source 有 by（舊檔補 null）。
 * version 欄位仍記著讀進來的版本（2、3 或 4），寫入時由 diskForm 依內容決定。補的欄位一律加在最後，拿掉後欄位順序和原檔相同。
 */
export function normalizeSnapshot(x: MemorySnapshot): MemorySnapshot {
  const facts = x.facts.map(f => {
    const loose = f as Partial<MemoryFact> & Omit<MemoryFact, "derivedFrom" | "source"> & { source: Omit<MemoryFact["source"], "by"> & { by?: string | null } };
    const hasBy = loose.source.by !== undefined, hasDerived = loose.derivedFrom !== undefined;
    if (hasBy && hasDerived) return f;
    const source = hasBy ? f.source : { ...loose.source, by: null };
    return { ...loose, source, derivedFrom: hasDerived ? loose.derivedFrom! : null } as MemoryFact;
  });
  return { ...x, facts, results: Array.isArray(x.results) ? x.results : [] };
}
/** 這份快照有沒有只有 version 4 才能保存的內容（建議開關、建議來源、記下的人、工作摘要）。 */
export function needsV4(x: Pick<MemoryData, "settings" | "facts">): boolean {
  return x.settings.suggestions === true || x.facts.some(f => f.kind === "work_summary" || f.derivedFrom !== null || f.source.kind === "suggestion" || f.source.by !== null);
}
/**
 * 寫入磁碟的形式（MEM-5a）：有 version 4 的內容才寫 4；否則有受保護成果（或曾以 3 寫過）寫 3、其餘寫 2，
 * 拿掉記憶體才有的 derivedFrom、by（與 version 2 的 results），欄位順序與 MEM-4c 逐位元組相同。4 不是單向的：
 * 那些內容都移除後（例如關掉建議、忘記建議來的那幾筆）會照 2／3 寫回，舊版 App 又讀得到。
 */
export function diskForm(x: MemorySnapshot): Omit<MemorySnapshot, "results"> & { results?: MemoryResult[] } {
  if (needsV4(x)) return { ...x, version: SUGGEST_SNAPSHOT_VERSION };
  const version = x.results.length > 0 || x.version === RESULTS_SNAPSHOT_VERSION ? RESULTS_SNAPSHOT_VERSION : SNAPSHOT_VERSION;
  const facts = x.facts.map(f => {
    const { derivedFrom: _d, ...fact } = f;
    const { by: _b, ...source } = f.source;
    return { ...fact, source };
  }) as unknown as MemoryFact[];
  const settings = { ...x.settings, suggestions: false };
  if (version === RESULTS_SNAPSHOT_VERSION) return { ...x, version, settings, facts };
  const { results: _results, ...rest } = x;
  return { ...rest, version, settings, facts };
}
/** MEM-0（version 1）快照：只在記憶體內升級。舊資料沒有同意設定，記憶維持關閉；舊記錄視為未釘選、家中可使用的偏好。 */
function upgradeV1(x: unknown): MemorySnapshot | null {
  if (!record(x) || !keys(x, HEAD) || !validHead(x, 1) || !validBody(x, 1)) return null;
  const v1 = x as unknown as Omit<MemorySnapshot, "version" | "settings" | "profiles" | "facts" | "results"> & {
    profiles: { id: string; name: string; createdAt: string }[];
    facts: (Omit<MemoryFact, "kind" | "audience" | "validFrom" | "reviewAfter" | "pinned">)[];
  };
  const next: MemorySnapshot = {
    ...v1,
    version: SNAPSHOT_VERSION,
    settings: { enabled: false, setupAt: null, suggestions: false },
    profiles: v1.profiles.map(p => ({ ...p, facePersonId: null, minor: false })),
    facts: v1.facts.map(f => ({ ...f, kind: "preference" as const, audience: "household" as const, validFrom: f.source.at, reviewAfter: null, pinned: false })),
  } as MemorySnapshot;
  return validSnapshot(next) ? normalizeSnapshot(next) : null;
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
      this.state = raw === null ? { format: FORMAT, version: SNAPSHOT_VERSION, revision: 0, dedupKey: randomBytes(32).toString("hex"), receiptFloor: 0, settings: { enabled: false, setupAt: null, suggestions: false }, profiles: [], facts: [], consents: [], tombstones: [], receipts: [], results: [] } : this.decrypt(raw);
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
      if (!record(e) || !keys(e, ["format", "version", "revision", "wrappedKey", "nonce", "tag", "ciphertext"]) || e.format !== FORMAT || (e.version !== 1 && e.version !== 2 && e.version !== 3 && e.version !== 4) || !integer(e.revision) || typeof e.wrappedKey !== "string" || typeof e.nonce !== "string" || typeof e.tag !== "string" || typeof e.ciphertext !== "string" || Buffer.from(e.nonce, "base64").length !== 12 || Buffer.from(e.tag, "base64").length !== 16) throw Error();
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
      const state = e.version === 1 ? upgradeV1(parsed) : validSnapshot(parsed) ? normalizeSnapshot(parsed) : null;
      if (!state || state.revision !== e.revision) throw Error();
      return state;
    } catch { throw new MemoryStoreError("corrupt"); } finally { key.fill(0); plain?.fill(0); }
  }
  private encrypt(state: MemorySnapshot): string {
    if (!this.options.secretBox.available()) throw new MemoryStoreError("key_unavailable");
    const disk = diskForm(state);
    const key = randomBytes(32), nonce = randomBytes(12), plain = Buffer.from(JSON.stringify(disk));
    try {
      if (plain.length > MAX_BYTES) throw new MemoryStoreError("unavailable");
      const header: Pick<Envelope, "format" | "version" | "revision" | "wrappedKey"> = { format: FORMAT, version: disk.version, revision: state.revision, wrappedKey: this.options.secretBox.seal(key.toString("base64")).toString("base64") };
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
      const data: MemoryData = { settings: next.settings, profiles: next.profiles, facts: next.facts, consents: next.consents, tombstones: next.tombstones, results: next.results };
      const status = change(data);
      Object.assign(next, data);
      // 呼叫端給的事實補成 version 4 的形狀（缺 derivedFrom／by 時補 null）；寫入形式由 diskForm 決定。
      Object.assign(next, normalizeSnapshot(next));
      // 第一次有受保護成果才升到 3；升了就不降回 2（舊版 App 本來就讀不了）。
      if (next.results.length > 0 && next.version === SNAPSHOT_VERSION) next.version = RESULTS_SNAPSHOT_VERSION;
      next.revision++;
      next.receipts.push({ operationId: op.operationId, digest, status, revision: next.revision, issuedAt: op.issuedAt });
      while (next.receipts.length > MAX_RECEIPTS) {
        const old = next.receipts.shift()!; next.receiptFloor = Math.max(next.receiptFloor, old.issuedAt);
      }
      const disk = diskForm(next);
      if (!validSnapshot(disk)) return { status: "conflict" };
      // 記憶體記下這次實際寫入的版本（4 之後若內容拿掉，下一次照 2／3 寫）。
      next.version = disk.version;
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
