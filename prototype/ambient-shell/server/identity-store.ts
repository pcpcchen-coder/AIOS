import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidFeature, type FaceModelVersion } from "../shared/identity.ts";

// 家人辨識的登記資料（gallery）加密保存（ADR-0001 §2.2、§2.3；George 2026-10-25 決定用 Electron safeStorage）。
//
// 檔案：<dir>/gallery.v1.json（0600，資料夾 0700）。包裝後的資料金鑰與密文放在同一個檔，一次原子替換：
//   { format, version, key_generation, gallery_version, cipher, wrapped_key, nonce, tag, ciphertext }
// - 資料金鑰（DEK）：每次寫入（登記、刪除）都重新產生 32 位元組隨機金鑰，key_generation 與 gallery_version 各加一；
//   舊金鑰的 Buffer 用完即 fill(0)。
// - wrapped_key：SecretBox.seal(DEK 的 base64)。App 裡 SecretBox 是 safeStorage（Keychain 中的應用程式金鑰）。
// - 內容：AES-256-GCM、每次隨機 12 位元組 nonce，AAD 綁住檔頭（含 wrapped_key），檔頭被改就解不開。
// - 寫入：tmp（0600、O_EXCL）→ fsync → rename → fsync 資料夾；啟動時清掉中斷留下的 tmp。
// - 解不開分兩種（審查 2026-10-25）：
//   key_unavailable：SecretBox 解不開資料金鑰（例如沒有允許鑰匙圈存取）。可重試，不誘導清除。
//   corrupt：格式不符、GCM 驗證失敗或內容損壞。不覆寫、不退回明文；只能經原生確認「清除全部家人資料」。
// - 載入時逐一檢查特徵（128 維、有限值、‖v‖≈1）；不合格的人照實標 damaged，不參與比對。
// - 沒有防回滾：有人用舊的 gallery 檔整個替換新檔時，只要舊檔仍能用同一把應用程式金鑰解開就會被接受（ADR §2.2）。
//   核心只在寫入前比對磁碟上的 gallery_version 與記憶體是否相同，防止同一台機器上兩個核心互相覆蓋。
//
// 照實記錄的殘餘風險（驗證紀錄與 ADR §2.2）：
// - safeStorage 的應用程式金鑰不會輪換。Time Machine 或 APFS 本機快照若留有舊的 gallery 檔（含當時的 wrapped_key），
//   用同一台 Mac 的同一把應用程式金鑰理論上仍可解開舊檔。刪除時輪換 DEK 只保證「新檔」不含被刪的人。
//   資料夾加 Time Machine 排除（tmutil addexclusion）降低這個風險，APFS 本機快照不受排除影響。
// - SecretBox 介面以字串進出（safeStorage.encryptString／decryptString），DEK 的 base64 字串與解密後的 JSON 字串
//   會留在 V8 heap 直到被回收，無法主動清零；能清零的 Buffer 都已清零。

export const GALLERY_FILE = "gallery.v1.json";
/**
 * 雲端稱名說明的已讀紀錄（ID-02）：只有時間與版本，不含姓名或特徵，所以不加密；放在同一個 0700 資料夾。
 * 不讀 Keychain，問候決策每次都能檢查。
 */
export const NAMING_NOTICE_FILE = "cloud-naming-notice.v1.json";
const FORMAT = "nous.identity.gallery";
const CIPHER = "aes-256-gcm";
const TMP_PREFIX = `${GALLERY_FILE}.tmp-`;

/** 包裝資料金鑰的介面。App 用 safeStorage；測試用假的（但內容加密仍是真的 AES-GCM）。 */
export interface SecretBox {
  available(): boolean;
  seal(plain: string): Buffer;
  open(sealed: Buffer): string;
}

export interface StoredPerson {
  /** 載入時發現特徵不合格（不存檔，每次載入重新判斷）。 */
  damaged?: boolean;
  person_id: string;
  name: string;
  minor: boolean;
  created_at: string;
  updated_at: string;
  model: FaceModelVersion;
  /** 每張樣本一個 128 維、已 normalize 的特徵。 */
  features: Float32Array[];
}

export interface GalleryData {
  people: StoredPerson[];
}

export interface GalleryVersions {
  key_generation: number;
  gallery_version: number;
}

export type GalleryLoad =
  | ({ ok: true; data: GalleryData } & GalleryVersions)
  | { ok: false; reason: "key_unavailable" | "corrupt" };

interface GalleryHeader {
  format: string;
  version: 1;
  key_generation: number;
  gallery_version: number;
  cipher: string;
  wrapped_key: string;
}

interface GalleryFile extends GalleryHeader {
  nonce: string;
  tag: string;
  ciphertext: string;
}

interface PlainPerson extends Omit<StoredPerson, "features"> {
  /** float32 little-endian 的 base64（只存在密文裡）。 */
  features: string[];
}

export type BackupExclusion = "excluded" | "failed" | "pending" | "not_applicable";

export interface GalleryStoreOptions {
  dir: string;
  secretBox: SecretBox;
  /** 把資料夾排除在 Time Machine 之外（App：tmutil addexclusion）。失敗只記狀態，不阻擋。 */
  excludeFromBackup?: (dir: string) => Promise<void>;
  log?: (line: string) => void;
}

/** 檔頭的 AAD：固定欄位順序，任何一項被改，GCM 驗證就失敗。 */
function aad(h: GalleryHeader): Buffer {
  return Buffer.from(JSON.stringify([h.format, h.version, h.key_generation, h.gallery_version, h.cipher, h.wrapped_key]), "utf8");
}

function featureToBase64(f: Float32Array): string {
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

function featureFromBase64(s: string): Float32Array {
  const bytes = Buffer.from(s, "base64");
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  bytes.fill(0);
  return out;
}

export class GalleryStore {
  readonly path: string;
  private backup: BackupExclusion = "pending";

  private prepared = false;

  constructor(private readonly options: GalleryStoreOptions) {
    this.path = join(options.dir, GALLERY_FILE);
  }

  /** 第一次需要時才呼叫（第一次開管理 session）；之後重複呼叫不做事。 */
  prepare(): void {
    if (this.prepared) return;
    this.init();
    this.prepared = true;
  }

  /** 建資料夾（0700）、清掉中斷的 tmp、要求 Time Machine 排除。 */
  init(): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.dir, 0o700);
    for (const name of readdirSync(this.options.dir)) {
      if (name.startsWith(TMP_PREFIX)) rmSync(join(this.options.dir, name), { force: true });
    }
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
    const exclude = this.options.excludeFromBackup;
    if (!exclude) {
      this.backup = "not_applicable";
      return;
    }
    exclude(this.options.dir).then(
      () => {
        this.backup = "excluded";
      },
      (err: unknown) => {
        this.backup = "failed";
        // 只記錯誤代碼：訊息可能帶路徑。
        const code = (err as { code?: unknown } | null)?.code;
        this.options.log?.(`identity: Time Machine 排除失敗（${typeof code === "string" || typeof code === "number" ? code : "error"}）`);
      },
    );
  }

  /** safeStorage 可用（App 只在 macOS 且 Keychain 可用時提供）。 */
  encryptionAvailable(): boolean {
    try {
      return this.options.secretBox.available();
    } catch {
      return false;
    }
  }

  backupExclusion(): BackupExclusion {
    return this.backup;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /** 已看過雲端稱名的說明（檔案存在且格式正確）。 */
  namingNoticeSeen(): boolean {
    try {
      const data = JSON.parse(readFileSync(join(this.options.dir, NAMING_NOTICE_FILE), "utf8")) as { schema_version?: unknown; seen_at?: unknown };
      return data.schema_version === 1 && typeof data.seen_at === "string";
    } catch {
      return false;
    }
  }

  /** 記錄已看過（管理畫面「我知道了」或登記時的同意）。 */
  markNamingNoticeSeen(at: string): void {
    this.prepare();
    const file = join(this.options.dir, NAMING_NOTICE_FILE);
    writeFileSync(file, `${JSON.stringify({ schema_version: 1, seen_at: at })}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** 磁碟上檔頭的 gallery_version（不解密）；沒有檔案是 null，讀不懂是 -1。寫入前用來確認沒有被別的程序改過。 */
  diskVersion(): number | null {
    if (!existsSync(this.path)) return null;
    try {
      const v = (JSON.parse(readFileSync(this.path, "utf8")) as Partial<GalleryFile>).gallery_version;
      return Number.isInteger(v) ? (v as number) : -1;
    } catch {
      return -1;
    }
  }

  /** 沒有檔案時是空的 gallery（世代都是 0）。 */
  load(): GalleryLoad {
    if (!existsSync(this.path)) return { ok: true, data: { people: [] }, key_generation: 0, gallery_version: 0 };
    let file: GalleryFile;
    try {
      file = JSON.parse(readFileSync(this.path, "utf8")) as GalleryFile;
      if (file.format !== FORMAT || file.version !== 1 || file.cipher !== CIPHER) throw new Error("format");
      if (!Number.isInteger(file.key_generation) || !Number.isInteger(file.gallery_version)) throw new Error("format");
      for (const k of ["wrapped_key", "nonce", "tag", "ciphertext"] as const) if (typeof file[k] !== "string") throw new Error("format");
    } catch {
      return { ok: false, reason: "corrupt" };
    }
    let dek: Buffer | null = null;
    let plain: Buffer | null = null;
    try {
      // 解開資料金鑰：失敗多半是鑰匙圈不給（或換了機器）；可以重試，不當成檔案損壞。
      try {
        dek = Buffer.from(this.options.secretBox.open(Buffer.from(file.wrapped_key, "base64")), "base64");
      } catch {
        return { ok: false, reason: "key_unavailable" };
      }
      if (dek.length !== 32) return { ok: false, reason: "corrupt" };
      const tag = Buffer.from(file.tag, "base64");
      const nonce = Buffer.from(file.nonce, "base64");
      if (tag.length !== 16 || nonce.length !== 12) return { ok: false, reason: "corrupt" };
      const decipher = createDecipheriv(CIPHER, dek, nonce, { authTagLength: 16 });
      decipher.setAAD(aad(file));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
      const parsed = JSON.parse(plain.toString("utf8")) as { people: PlainPerson[] };
      if (!Array.isArray(parsed.people)) return { ok: false, reason: "corrupt" };
      const people = parsed.people.map((p) => {
        const features = Array.isArray(p.features) ? p.features.map(featureFromBase64) : [];
        const damaged = features.length === 0 || features.some((f) => !isValidFeature(f));
        return { ...p, features, ...(damaged ? { damaged: true } : {}) };
      });
      return { ok: true, data: { people }, key_generation: file.key_generation, gallery_version: file.gallery_version };
    } catch {
      // GCM 驗證失敗、內容不是 JSON：檔案不可信，不覆寫原檔，等使用者決定。
      return { ok: false, reason: "corrupt" };
    } finally {
      dek?.fill(0);
      plain?.fill(0);
    }
  }

  /** 以新的資料金鑰重新加密整份 gallery 並原子替換；回傳新的世代。 */
  save(data: GalleryData, previous: GalleryVersions): GalleryVersions {
    const next: GalleryVersions = { key_generation: previous.key_generation + 1, gallery_version: previous.gallery_version + 1 };
    const dek = randomBytes(32);
    let plain: Buffer | null = null;
    try {
      const header: GalleryHeader = {
        format: FORMAT,
        version: 1,
        ...next,
        cipher: CIPHER,
        wrapped_key: this.options.secretBox.seal(dek.toString("base64")).toString("base64"),
      };
      const nonce = randomBytes(12);
      const cipher = createCipheriv(CIPHER, dek, nonce);
      cipher.setAAD(aad(header));
      // damaged 是載入時的判斷，不存檔。
      const people: PlainPerson[] = data.people.map(({ damaged: _damaged, ...p }) => ({ ...p, features: p.features.map(featureToBase64) }));
      plain = Buffer.from(JSON.stringify({ people }), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const file: GalleryFile = {
        ...header,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      this.writeAtomic(JSON.stringify(file));
      return next;
    } finally {
      dek.fill(0);
      plain?.fill(0);
    }
  }

  /** 清除全部家人資料（經原生確認後才會呼叫）：刪掉 gallery 與殘留的 tmp。 */
  remove(): void {
    rmSync(this.path, { force: true });
    for (const name of readdirSync(this.options.dir)) {
      if (name.startsWith(TMP_PREFIX)) rmSync(join(this.options.dir, name), { force: true });
    }
    this.fsyncDir();
  }

  private writeAtomic(text: string): void {
    const tmp = join(this.options.dir, `${TMP_PREFIX}${randomBytes(6).toString("hex")}`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      // writeFileSync(fd) 會一直寫到全部寫完（writeSync 單次呼叫可能只寫一部分）。
      writeFileSync(fd, text);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    chmodSync(this.path, 0o600);
    this.fsyncDir();
  }

  private fsyncDir(): void {
    try {
      const fd = openSync(this.options.dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // 有些檔案系統不支援對資料夾 fsync；rename 本身仍是原子的。
    }
  }
}
