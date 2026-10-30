import { localize } from "./localization.ts";
import { normalizeLocale, type Locale } from "../shared/i18n.mjs";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type Artifact, type ExecutorMode, type Task } from "../shared/types.ts";
import { isDomain } from "../shared/domain.ts";
import { VaultError, type SealedVault, type VaultFailure } from "./sealed-vault.ts";
import { hasPlaintext, migratePlaintext, plaintextBackups, deletePlaintextBackups, type MigrationResult, type MigrationStep } from "./task-migration.ts";
import { forgetAllHistoryContent, forgetHistoryArtifact, listItem, passesFilters, prepareFields, scoreFields, scoreHistoryDocument, searchTermsOf, type HistoryDocument, type HistorySource } from "./history.ts";
import { ProtectedIndex, type IndexedField } from "./protected-index.ts";
import { sortForProgress } from "../shared/progress.ts";
import type { HistoryFilters, HistoryPage } from "../shared/history.ts";

type Listener = (task: Task) => void;
/** 刪除通知：被刪的任務 ID 與它的成果 ID（沒有成果時 null）。 */
type DeleteListener = (deleted: { task_id: string; artifact_id: string | null }) => void;

const INTERRUPTED = "本機核心重新啟動，任務在完成前中斷（未產生成果）。";

/** MEM-4a：受保護外殼的固定句（共用翻譯表；畫面另依目前語言顯示）。 */
export const PROTECTED_TITLE = "受保護的任務，請在 App 內查看";
export const PROTECTED_STEP = "受保護的步驟";
export const PROTECTED_ERROR = "受保護的錯誤說明，請在 App 內查看";
/** 用到的記憶被撤銷後，成果內容已移除（刪除加密檔），只留外殼與重做。 */
export const WITHDRAWN_TEXT = "這份成果用到已忘記的記憶，內容已移除";

/**
 * MEM-4c：已結束的受保護任務，解密內容在核心記憶體裡最多留這麼久（從最後一次經授權的存取或任務結束起算）。
 * 記憶層的閒置（MEMORY_IDLE_MS，30 分鐘）只在選定本次人物時計時，不適用；這裡和記憶管理畫面的閒置（MANAGE_IDLE_MS）同為 10 分鐘。
 */
export const PLAINTEXT_IDLE_MS = 10 * 60_000;
/** MEM-4c：同時留在記憶體裡的已結束受保護任務（解密內容）最多幾筆（最近用過的優先留下）。 */
export const WARM_MAX = 16;
/**
 * MEM-4c：給模型的任務清單（對話提示、即時語音指示、get_tasks）只看依進度排序的前幾筆（最多 8 筆：get_tasks 8、
 * 對話與即時語音 6）。已丟棄內容的任務只在這前 8 筆裡才解密標題（任務檔，不含成果），其餘照外殼；標題另放最多
 * TITLE_CACHE_MAX 筆的小快取，丟棄時一起清掉。
 */
export const TITLE_PEEK = 8;
export const TITLE_CACHE_MAX = 16;

/** MEM-4c：丟棄解密內容的原因（只記在 log，不含內容）。 */
export type PlaintextDropReason = "os_lock" | "suspend" | "idle" | "memory_off" | "memory_closed" | "quit";

/** MEM-4c：重新載入加密內容時金鑰不可用（例如 Keychain 拒絕）：照實回報，不給空結果。 */
export const RELOAD_FAILED = "這次無法解開加密的任務內容（金鑰不可用）；內容仍安全保存在這台 Mac，請稍後再試";

/** 搜尋的計數（測試與量測用；不含內容）。 */
export interface ProtectedSearchStats {
  /** 這次查詢是否新建了索引（冷啟動）。 */
  built: boolean;
  /** 這次為了建索引或產生這一頁而解密的檔案數（任務檔＋成果檔）。 */
  decrypted: number;
  /** 實際用 scoreFields 精確比對的筆數。 */
  scored: number;
  /** 符合篩選的筆數。 */
  filtered: number;
}

/**
 * 任務加密（MEM-4a，只有 macOS App 注入）。vault 為 null：金鑰不可用或鎖被占用（failure 說明原因）。
 */
export interface TaskSealing {
  vault: SealedVault | null;
  failure?: VaultFailure | null;
  log?: (line: string) => void;
  now?: () => Date;
  /** 測試專用：搬遷每一步開始前呼叫，丟錯即模擬那一步失敗（after_shells＝tasks.json 已換成外殼、刪 artifacts.json 之前）。 */
  migrationCheckpoint?: (step: MigrationStep | "after_shells") => void;
  /**
   * MEM-4a（審查 M4a）：上次執行時記憶是否開著（memory-enabled.json 的提示，不開記憶檔）。回 false 時，載入時把所有
   * 帶記憶、還沒撤回的任務撤回：處理「關閉記憶後、刪成果檔前當機」而下次啟動又不會開記憶檔的情況。沒有提供時不做。
   */
  memoryEnabled?: () => boolean;
  /** MEM-4c：閒置計時用的時鐘（毫秒）；測試注入。 */
  clock?: () => number;
}

/**
 * 加密保存的狀態（給可信主視窗的 IPC 與 log；不含任何內容）。
 * mode：plain＝瀏覽器版（沒有加密）；sealed＝加密保存；plain_fallback＝macOS App 但這次無法加密（明文搬遷失敗，
 * 或金鑰不可用而舊資料還是明文），照舊明文保存，明文原檔沒有被改動。
 */
export interface VaultStatus {
  mode: "plain" | "sealed" | "plain_fallback";
  /** 金鑰或鎖的問題（sealed 模式下新任務的內容只留在記憶體，重新啟動後就沒有了）。 */
  failure: VaultFailure | null;
  migration: MigrationResult | null;
  /** 還沒刪除的明文備份資料夾名稱（只有名稱）。 */
  backups: string[];
  /** 這次執行裡沒能加密保存、只留在記憶體的任務數。 */
  unsealed: number;
  /** 這次讀不到內容的任務數（金鑰被拒、權限不符或檔案損壞）；這些任務只顯示外殼，加密檔原封不動。 */
  unreadable: number;
}

/**
 * 任務與成果的本機儲存。每次變更都寫入 JSON 檔，重啟後可喚回。
 * dataDir 為 null 時只存在記憶體（測試用）。
 *
 * MEM-4a（sealing）：tasks.json 只放受保護外殼（protected: true；標題、步驟標題、錯誤換成固定句），沒有 artifacts.json；
 * 真正的任務與成果放在 data/sealed/ 的加密檔（SealedVault）。執行中的任務在核心記憶體裡有完整內容（執行器要用），
 * 但對外的頻道（SSE、/api/tasks、/api/history、模型提示）一律走 public* 方法，只拿到外殼。
 * 加密檔只在建立、規劃完成、狀態改變、成果產生與撤銷時寫；步驟進度只改外殼。
 * MEM-4c：已結束的受保護任務，解密內容不一直留在記憶體（見 cold／warm 與 dropPlaintext）。
 */
export class TaskStore {
  private tasks = new Map<string, Task>();
  private artifacts = new Map<string, Artifact>();
  private listeners = new Set<Listener>();
  private deleteListeners = new Set<DeleteListener>();
  private mode: VaultStatus["mode"] = "plain";
  private vault: SealedVault | null = null;
  private failure: VaultFailure | null = null;
  private migration: MigrationResult | null = null;
  /**
   * 沒能加密保存、內容只在記憶體的紀錄 ID（任務 task_id 與成果 artifact_id 分開記；MEM-4c 審查 B1）。
   * 某一筆寫入成功只移除那一筆；任務或它的成果任何一筆還在這裡，任務的內容就不能丟棄。
   */
  private readonly unsealed = new Set<string>();
  /** MEM-4c 審查 minor 4：這次執行裡讀不到（損壞或權限不符）的成果檔，之後不再重複解密與記 log。 */
  private readonly badArtifacts = new Set<string>();
  /** MEM-4c 審查 M1：丟棄解密內容時通知（主程序再通知主視窗清掉畫面上的快取；不含內容）。 */
  private readonly dropListeners = new Set<(reason: PlaintextDropReason) => void>();
  /**
   * 審查 B1：這次讀不到內容的任務（解密或讀檔失敗）。它們在記憶體裡只有外殼；絕不重新加密寫入（會把外殼的固定句永久蓋掉
   * 原句），也不刪它們的加密檔。下次能讀時就恢復。
   */
  private readonly unreadable = new Set<string>();
  private readonly log: (line: string) => void;
  /**
   * MEM-4c 明文生命週期（只在加密模式）：已結束、而且內容已確實加密保存的任務，解密內容不一直留在記憶體。
   * cold：內容已丟棄，tasks 裡只放外殼（shellOf），要用時才從加密檔解密（get、IPC 的 get／search／redo、模型標題）。
   * warm：內容還在記憶體的已結束任務（最近用過的在後面；最多 WARM_MAX 筆）。
   * 排隊、執行中、停止中的任務一律保留完整內容（執行器要用）；沒能加密保存（unsealed）的任務也保留（否則內容就沒了）。
   */
  private readonly cold = new Set<string>();
  private readonly warm = new Set<string>();
  /** MEM-4c：這次重新解密時金鑰不可用的任務（暫時的；能解開或丟棄時清掉）。 */
  private readonly reloadFailed = new Set<string>();
  /** MEM-4c：給模型的真實標題（任務檔內容，不含成果）的小快取。 */
  private readonly titles = new Map<string, Task>();
  /** MEM-4c：受保護成果的 RAM 倒排索引（第一次搜尋才建立；丟棄時設回 null）。 */
  private index: ProtectedIndex | null = null;
  /** MEM-4c：記憶層正在提交撤回、還沒傳到任務端的任務（提交期間對外一律外殼；見 hold）。 */
  private readonly held = new Map<string, number>();
  private lastAccess = 0;
  private readonly clock: () => number;

  constructor(private readonly dataDir: string | null, private readonly sealing?: TaskSealing) {
    this.log = sealing?.log ?? (() => {});
    this.clock = sealing?.clock ?? Date.now;
    // 閒置從啟動起算（不是從 0 起算：否則第一次存取就會被當成閒置而丟棄、還通知畫面清空）。
    this.lastAccess = this.clock();
    if (dataDir) this.load(dataDir);
    else if (sealing) {
      this.mode = "sealed";
      this.vault = sealing.vault;
      this.failure = sealing.failure ?? (sealing.vault ? null : "unavailable");
    }
  }

  /** 是否以加密外殼對外（macOS App 的正常狀態）。 */
  get sealed(): boolean {
    return this.mode === "sealed";
  }

  vaultStatus(): VaultStatus {
    return { mode: this.mode, failure: this.failure, migration: this.migration, backups: this.dataDir && this.sealing ? plaintextBackups(this.dataDir) : [], unsealed: this.unsealedOwners(), unreadable: this.unreadable.size };
  }

  /** 有紀錄沒能加密保存的任務數（任務本身或它的成果；依任務計）。 */
  private unsealedOwners(): number {
    const owners = new Set<string>();
    for (const id of this.unsealed) owners.add(id.startsWith("artifact_") ? this.artifacts.get(id)?.task_id ?? id : id);
    return owners.size;
  }

  /** 使用者在畫面上確認後（主程序先跳原生確認）刪除明文備份。 */
  deleteBackups(): number {
    if (!this.dataDir || !this.sealing) return 0;
    const count = deletePlaintextBackups(this.dataDir);
    this.log(`tasks: 已刪除明文備份 ${count} 個資料夾`);
    return count;
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (/^(tasks|artifacts)\.json\.tmp-[0-9a-f-]+$/.test(name)) unlinkSync(join(dir, name));
    if (this.sealing) {
      this.failure = this.sealing.failure ?? (this.sealing.vault ? null : "unavailable");
      const plaintext = hasPlaintext(dir);
      if (plaintext && !this.sealing.vault) {
        // 金鑰不可用而舊資料是明文：這次照舊明文，不動原檔（下次能解開金鑰時再搬）。
        this.mode = "plain_fallback";
        this.log(`tasks: 無法加密保存（${this.failure}），這次照舊明文`);
      } else if (plaintext) {
        this.migration = migratePlaintext({ dataDir: dir, vault: this.sealing.vault!, now: this.sealing.now, checkpoint: this.sealing.migrationCheckpoint, writeShells: (tasks) => writeJsonAtomic(join(dir, "tasks.json"), tasks.map(shellOf)) });
        if (this.migration.ok) {
          this.mode = "sealed";
          this.log(`tasks: 明文已加密搬遷（任務 ${this.migration.tasks}、成果 ${this.migration.artifacts}），備份保留到使用者確認刪除`);
        } else {
          this.mode = "plain_fallback";
          this.log(`tasks: 明文加密搬遷失敗（步驟 ${this.migration.step}），明文原檔沒有改動，這次照舊明文`);
        }
      } else {
        this.mode = "sealed";
      }
      this.vault = this.mode === "sealed" ? this.sealing.vault : null;
    }
    if (this.mode === "sealed") this.loadSealed(dir);
    else this.loadPlain(dir);
  }

  private loadPlain(dir: string): void {
    const tasks = readJson<Task[]>(join(dir, "tasks.json")) ?? [];
    const artifacts = readJson<Artifact[]>(join(dir, "artifacts.json")) ?? [];
    const taskIds = new Set(tasks.map((t) => t.task_id));
    let orphans = 0;
    for (const a of artifacts) {
      // 刪除時先寫 artifacts.json 再寫 tasks.json；萬一中間中斷，留下的只會是沒有成果的任務，不會是沒有任務的成果。
      // 保險起見，載入時仍丟掉找不到任務的成果。
      if (!taskIds.has(a.task_id)) { orphans += 1; continue; }
      this.artifacts.set(a.artifact_id, a);
    }
    for (const t of tasks) this.tasks.set(t.task_id, t);
    this.normalize();
    this.persistTasks();
    if (orphans > 0) this.persistArtifacts();
  }

  /**
   * 加密模式的載入：外殼（tasks.json）決定有哪些任務與它們的狀態，加密檔補上內容。
   * 找不到任何外殼的加密檔是孤兒（例如刪除或撤銷中途中斷），直接刪掉；已撤銷任務殘留的成果檔也刪掉。
   */
  private loadSealed(dir: string): void {
    const shells = readJson<Task[]>(join(dir, "tasks.json")) ?? [];
    const keep = new Set<string>();
    let unreadable = 0;
    // 金鑰被拒或權限不符：這次整個不清孤兒（讀不到不代表是孤兒），並照實記下原因。
    let skipCleanup = !this.vault;
    const failed = (error: unknown) => {
      unreadable += 1;
      const code = error instanceof VaultError ? error.code : "unavailable";
      if (code === "key_unavailable" || code === "permissions" || code === "unavailable") {
        skipCleanup = true;
        this.failure ??= code;
      }
    };
    for (const shell of shells) {
      keep.add(shell.task_id);
      if (shell.artifact_id) keep.add(shell.artifact_id);
      let real: Task | null = null;
      let readable = !!this.vault;
      try { real = this.vault?.read<Task>(shell.task_id) ?? null; } catch (error) { failed(error); readable = false; }
      const task = real ? merge(real, shell) : { ...shell };
      if (!real) this.unreadable.add(task.task_id);
      if (!real && readable) this.unsealed.add(task.task_id);
      this.tasks.set(task.task_id, task);
      if (task.artifact_id && !task.withdrawn) {
        try {
          const artifact = this.vault?.read<Artifact>(task.artifact_id) ?? null;
          if (artifact && artifact.task_id === task.task_id) this.artifacts.set(artifact.artifact_id, artifact);
        } catch (error) {
          failed(error);
          // MEM-4c 審查 minor 4：損壞或權限不符的成果檔記下來，之後不再重複解密。
          const code = error instanceof VaultError ? error.code : null;
          if (code === "corrupt" || code === "permissions") this.badArtifacts.add(task.artifact_id);
        }
      } else if (task.artifact_id && task.withdrawn) keep.delete(task.artifact_id);
    }
    let orphans = 0;
    if (this.vault && !skipCleanup) {
      for (const id of this.vault.ids()) {
        if (keep.has(id)) continue;
        try { this.vault.remove(id); orphans += 1; } catch { /* 下次再清 */ }
      }
    }
    if (orphans || unreadable) this.log(`tasks: 載入加密任務（孤兒清除 ${orphans}，無法解開 ${unreadable}${skipCleanup && this.vault ? "，這次不清孤兒" : ""}）`);
    const interrupted = this.normalize();
    // 讀不到內容的任務只改外殼（seal 會略過它們）。
    for (const id of interrupted) this.seal(this.tasks.get(id)!);
    this.persistTasks();
    // 審查 M4a：上次執行時記憶已關閉，帶記憶的成果一律撤回（刪成果檔、留外殼與重做）。
    if (this.sealing?.memoryEnabled && this.sealing.memoryEnabled() === false) {
      const pending = [...this.tasks.values()].filter(t => t.memory === true && !t.withdrawn).map(t => t.task_id);
      for (const id of pending) this.withdraw(id);
      if (pending.length) this.log(`tasks: 記憶已關閉，撤回帶記憶的成果 ${pending.length} 筆`);
    }
    // MEM-4c：啟動時逐一解密只為了核對（審查 B1 的讀不到、孤兒與中斷處理）；核對完就丟棄，之後要用才解密。
    for (const id of [...this.tasks.keys()]) this.cool(id);
  }

  /** 上次未完成的任務不可能還在跑：誠實標為失敗，而不是假裝仍在進行。回傳被標為失敗的任務。 */
  private normalize(): string[] {
    const now = new Date().toISOString();
    const interrupted: string[] = [];
    for (const t of this.tasks.values()) {
      if (normalizeLocale(t.locale) !== "en") delete t.locale;
      for (const step of t.steps) if (!isDomain(step.domain)) delete step.domain;
      if (t.status === "queued" || t.status === "running" || t.status === "cancelling") {
        t.status = "failed";
        t.error = localize(INTERRUPTED, t.locale);
        t.finished_at = now;
        t.updated_at = now;
        for (const s of t.steps) if (s.status === "running") s.status = "failed";
        interrupted.push(t.task_id);
      }
    }
    return interrupted;
  }

  private persistTasks(): void {
    if (!this.dataDir) return;
    const tasks = [...this.tasks.values()];
    writeJsonAtomic(join(this.dataDir, "tasks.json"), this.mode === "sealed" ? tasks.map(shellOf) : tasks);
  }

  private persistArtifacts(): void {
    // 加密模式沒有 artifacts.json：成果只在加密檔。
    if (this.dataDir && this.mode !== "sealed") writeJsonAtomic(join(this.dataDir, "artifacts.json"), [...this.artifacts.values()]);
  }

  /** 加密寫入一筆；失敗時內容只留在記憶體（照實記數，不假裝已保存）。 */
  private seal(value: Task | Artifact): void {
    if (this.mode !== "sealed" || !this.dataDir) return;
    const isArtifact = "artifact_id" in value && "content" in value;
    const id = isArtifact ? (value as Artifact).artifact_id : value.task_id;
    const owner = value.task_id;
    // 審查 B1：讀不到原內容的任務絕不重新寫入（只會寫進外殼的固定句，永久蓋掉原句與成果）。
    // MEM-4c：內容已丟棄（cold，記憶體裡只有外殼）的任務也一樣，絕不寫入。
    if (this.unreadable.has(owner) || this.cold.has(owner)) return;
    if (!this.vault) { this.unsealed.add(id); return; }
    try {
      this.vault.write(id, value);
      // MEM-4c 審查 B1：只移除寫入成功的這一筆（任務成功不代表成果也存好了）。
      this.unsealed.delete(id);
    } catch (error) {
      if (!this.unsealed.has(id)) this.log(`tasks: 加密保存失敗（${(error as { code?: string }).code ?? "error"}），內容只留在記憶體`);
      this.unsealed.add(id);
    }
  }

  private shred(id: string): void {
    if (this.mode !== "sealed" || !this.vault) return;
    try { this.vault.remove(id); } catch { this.log("tasks: 加密檔刪除失敗，下次啟動時再清"); }
  }

  /** 訂閱任務變化；加密模式下收到的是外殼。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDeleted(listener: DeleteListener): () => void {
    this.deleteListeners.add(listener);
    return () => this.deleteListeners.delete(listener);
  }

  // ─────────────── MEM-4c：明文生命週期 ───────────────

  /** 這筆任務的內容可以丟棄（已結束、內容已確實加密保存，之後能從加密檔讀回）。 */
  private coolable(t: Task): boolean {
    // 審查 B1：任務檔與成果檔都要確實寫入，任何一筆只在記憶體就不能丟棄（丟了就沒了）。
    return this.mode === "sealed" && !!this.dataDir && !!this.vault && isTerminal(t) && !this.unsealed.has(t.task_id) && !(t.artifact_id && this.unsealed.has(t.artifact_id)) && !this.unreadable.has(t.task_id);
  }

  /** 丟棄一筆已結束任務的解密內容：tasks 裡換成外殼，成果從記憶體移除。 */
  private cool(taskId: string): void {
    const task = this.tasks.get(taskId);
    this.warm.delete(taskId);
    if (!task || this.cold.has(taskId) || !this.coolable(task)) return;
    this.tasks.set(taskId, shellOf(task));
    if (task.artifact_id) {
      this.artifacts.delete(task.artifact_id);
      forgetHistoryArtifact(task.artifact_id);
    }
    this.cold.add(taskId);
  }

  /** 已結束的任務留在記憶體（最近用過的在後面）；超過 WARM_MAX 時丟棄最久沒用的。 */
  private touchWarm(taskId: string): void {
    this.warm.delete(taskId);
    this.warm.add(taskId);
    while (this.warm.size > WARM_MAX) this.cool(this.warm.values().next().value!);
  }

  private touch(): void {
    this.lastAccess = this.clock();
  }

  /** 任務改變後：已結束而且可以丟棄的任務放進 warm（索引已建立時同步更新索引）；其他任務不在索引裡（每次查詢直接比對）。 */
  private settle(taskId: string): void {
    const task = this.tasks.get(taskId);
    this.titles.delete(taskId);
    if (!task || this.cold.has(taskId)) {
      // 內容讀不回來的外殼不能代表真實內容：從索引移除，下次搜尋時再試著解密加入。
      this.index?.remove(taskId);
      return;
    }
    if (!this.coolable(task)) {
      this.index?.remove(taskId);
      return;
    }
    this.index?.add(taskId, indexFields(this.residentDoc(task)));
    this.touchWarm(taskId);
  }

  private residentDoc(task: Task): HistoryDocument {
    return { task, artifact: task.artifact_id ? this.artifacts.get(task.artifact_id) ?? null : null };
  }

  private markUnreadable(taskId: string): void {
    this.unreadable.add(taskId);
    this.cold.delete(taskId);
    this.warm.delete(taskId);
    this.index?.remove(taskId);
  }

  /**
   * 讀回一筆任務的完整內容。內容還在記憶體時直接用；已丟棄（cold）時解密任務檔與成果檔，retain 為 true 時放回記憶體（warm）。
   * 金鑰不可用（key_unavailable／unavailable）：丟 VaultError（暫時的，記在 reloadFailed，之後可以再試）；
   * 檔案損壞、權限不符或不見了：照審查 B1 記為讀不到（這次執行只有外殼、絕不重寫），回外殼。
   * 回傳的是內部物件，對外前要 clone。
   */
  private loadContent(taskId: string, retain: boolean): HistoryDocument {
    const record = this.tasks.get(taskId)!;
    if (this.unreadable.has(taskId)) return { task: record, artifact: null };
    if (!this.cold.has(taskId)) {
      if (retain && this.warm.has(taskId)) this.touchWarm(taskId);
      return this.residentDoc(record);
    }
    let real: Task | null;
    try {
      real = this.vault!.read<Task>(taskId);
    } catch (error) {
      return this.loadFailed(taskId, record, error);
    }
    if (!real) {
      this.markUnreadable(taskId);
      return { task: record, artifact: null };
    }
    const task = merge(real, record);
    let artifact: Artifact | null = null;
    if (task.artifact_id && !task.withdrawn && !this.badArtifacts.has(task.artifact_id)) {
      try {
        const a = this.vault!.read<Artifact>(task.artifact_id);
        if (a && a.task_id === taskId) artifact = a;
      } catch (error) {
        const code = error instanceof VaultError ? error.code : "unavailable";
        if (code !== "corrupt" && code !== "permissions") return this.loadFailed(taskId, record, error);
        // 審查 minor 4：記下來，這次執行不再重複解密與記 log。
        this.badArtifacts.add(task.artifact_id);
        this.log(`tasks: 成果檔讀不到（${code}），只顯示任務`);
      }
    }
    this.reloadFailed.delete(taskId);
    if (retain) {
      this.tasks.set(taskId, task);
      if (artifact) this.artifacts.set(artifact.artifact_id, artifact);
      this.cold.delete(taskId);
      this.touchWarm(taskId);
    }
    return { task, artifact };
  }

  private loadFailed(taskId: string, record: Task, error: unknown): HistoryDocument {
    const code = error instanceof VaultError ? error.code : "unavailable";
    if (code === "corrupt" || code === "permissions") {
      this.markUnreadable(taskId);
      this.log(`tasks: 加密檔讀不到（${code}），只顯示外殼`);
      return { task: record, artifact: null };
    }
    if (!this.reloadFailed.has(taskId)) this.log(`tasks: 重新解密失敗（${code}）`);
    this.reloadFailed.add(taskId);
    throw new VaultError(code);
  }

  /** load，但金鑰不可用時給外殼（清單與核心內部用；IPC 的 get／search 用 open／searchProtected 照實回報錯誤）。 */
  private peek(taskId: string): HistoryDocument {
    try {
      return this.loadContent(taskId, false);
    } catch {
      return { task: this.tasks.get(taskId)!, artifact: null };
    }
  }

  /** 閒置超過 PLAINTEXT_IDLE_MS 就丟棄解密內容（核心每分鐘的計時器與每次經授權的存取前呼叫）。 */
  dropIfIdle(): boolean {
    if (this.mode !== "sealed" || (!this.warm.size && !this.index && !this.titles.size)) return false;
    if (this.clock() - this.lastAccess < PLAINTEXT_IDLE_MS) return false;
    this.dropPlaintext("idle");
    return true;
  }

  /**
   * MEM-4c：丟棄記憶體裡已結束受保護任務的解密內容、倒排索引、模型標題快取與 HIST-1 的 CONTENT_CACHE。
   * OS 鎖定、睡眠、閒置、關閉記憶、記憶檔關閉與結束 App 時呼叫。排隊與執行中的任務保留內容（執行器要用），
   * 沒能加密保存的任務也保留（否則內容就沒了）。這只是放掉參照，不是安全抹除：JS 的 heap 與 GC 可能還留有副本。
   */
  dropPlaintext(reason: PlaintextDropReason): number {
    if (this.mode !== "sealed") {
      forgetAllHistoryContent();
      return 0;
    }
    const warm = this.warm.size;
    const indexed = this.index?.size ?? 0;
    this.index?.clear();
    this.index = null;
    this.titles.clear();
    this.reloadFailed.clear();
    for (const id of [...this.tasks.keys()]) this.cool(id);
    const cached = forgetAllHistoryContent();
    if (warm || indexed || cached) this.log(`tasks: 已丟棄記憶體裡的解密內容（${reason}；任務 ${warm}、索引 ${indexed}、快取 ${cached}）`);
    // 審查 M1：不論核心裡有沒有東西可丟，都通知（畫面自己的快取也要清）。
    for (const l of this.dropListeners) { try { l(reason); } catch { /* 通知失敗不影響丟棄 */ } }
    return warm;
  }

  /** MEM-4c 審查 M1：訂閱「已丟棄解密內容」（只有原因，不含內容）。 */
  subscribeDropped(listener: (reason: PlaintextDropReason) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** 測試與量測用：記憶體裡還有多少解密內容（筆數，不含內容）。 */
  residentPlaintext(): { warm: number; cold: number; indexed: number; titles: number; indexBuilt: boolean } {
    return { warm: this.warm.size, cold: this.cold.size, indexed: this.index?.size ?? 0, titles: this.titles.size, indexBuilt: this.index !== null };
  }

  /**
   * MEM-4c：記憶層提交撤回（寫快照）到傳給任務端之間，這些任務對外一律外殼（搜尋、詳細、模型標題），
   * 讓撤回中的成果連一次查詢都不會被看到。回傳釋放函式（提交失敗時照常恢復；成功時 withdraw 已移除內容）。
   */
  hold(taskIds: readonly string[]): () => void {
    for (const id of taskIds) this.held.set(id, (this.held.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of taskIds) {
        const n = (this.held.get(id) ?? 1) - 1;
        if (n <= 0) this.held.delete(id);
        else this.held.set(id, n);
      }
    };
  }

  isHeld(taskId: string): boolean {
    return this.held.has(taskId);
  }

  /**
   * 對外一律外殼（搜尋、詳細、清單、模型標題）：撤回中（hold），或記憶被撤銷、正在停止中還沒撤回（審查 minor 1：
   * cancel_reason 是 memory_revoked、還沒 withdrawn）。
   */
  hiddenNow(task: Pick<Task, "task_id" | "cancel_reason" | "withdrawn">): boolean {
    return this.held.has(task.task_id) || (task.cancel_reason === "memory_revoked" && !task.withdrawn);
  }

  /** 這筆任務這次為什麼沒有內容：讀不到（檔案損壞等，B1）或金鑰不可用（MEM-4c 重新解密失敗）；有內容回 null。 */
  contentProblem(taskId: string): "unreadable" | "key_unavailable" | null {
    if (this.unreadable.has(taskId)) return "unreadable";
    if (this.reloadFailed.has(taskId)) return "key_unavailable";
    return null;
  }

  /**
   * 可信主視窗的詳細與成果（IPC get）：解密並留在記憶體（warm）。金鑰不可用時丟 VaultError（照實回報，不給空結果）。
   */
  open(taskId: string): { task: Task; artifact: Artifact | null } | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    if (this.hiddenNow(record)) return { task: shellOf(record), artifact: null };
    this.dropIfIdle();
    const doc = this.loadContent(taskId, true);
    this.touch();
    return { task: clone(doc.task), artifact: doc.artifact ? clone(doc.artifact) : null };
  }

  /**
   * MEM-4c：給模型的任務清單（tasksForTarget）。可以給的任務放真實標題；內容已丟棄的任務只在依進度排序的前 TITLE_PEEK 筆裡
   * 才解密任務檔（不含成果）取標題，放進小快取；其他一律外殼。不延長閒置計時（聊天不會讓內容一直留在記憶體）。
   */
  modelTasks(allow: (task: Task) => boolean): Task[] {
    const records = [...this.tasks.values()];
    const peek = new Set(sortForProgress(records).slice(0, TITLE_PEEK).map((t) => t.task_id));
    return records.map((t) => {
      const id = t.task_id;
      if (this.hiddenNow(t) || !allow(t) || this.contentMissing(id)) return shellOf(t);
      if (!this.cold.has(id)) return clone(t);
      if (!peek.has(id)) return shellOf(t);
      const real = this.titleOf(t);
      return real ? clone(real) : shellOf(t);
    });
  }

  /**
   * MEM-4c：App 內成果紀錄搜尋加密保存的任務（IPC search）。結果和 HIST-1 的逐筆掃描（searchHistory）逐筆相同：
   * - 已結束的受保護任務用 RAM 倒排索引（第一次搜尋才建立；丟棄後下一次搜尋重建）找候選，再用 scoreFields 精確比對；
   *   排隊與執行中的任務每次直接比對（內容在記憶體）。
   * - 範圍外（其他家人的帶記憶任務，D2）、撤回中（hold）或讀不到的任務只用外殼比對與顯示；範圍在解密片段之前就套用。
   * - 片段與標題標示只為這一頁解密原文（不留在記憶體）。
   * 金鑰不可用時丟 VaultError（IPC 照實回報，不給空結果）。
   */
  searchProtected(filters: HistoryFilters & { cursor: number; limit: number }, inScope: (task: Task) => boolean, stats?: ProtectedSearchStats): HistoryPage {
    const st = stats ?? { built: false, decrypted: 0, scored: 0, filtered: 0 };
    this.dropIfIdle();
    this.touch();
    const source: HistorySource = { id: "tasks", protected: true, documents: () => [] };
    const sources = [{ id: source.id, protected: source.protected }];
    const visible = (t: Task) => inScope(t) && !this.hiddenNow(t) && !this.unreadable.has(t.task_id);
    const shellDoc = (t: Task): HistoryDocument => ({ task: shellOf(t), artifact: null });
    const full = (t: Task): HistoryDocument => {
      if (!visible(t)) return shellDoc(t);
      const wasCold = this.cold.has(t.task_id);
      const doc = this.loadContent(t.task_id, false);
      if (wasCold) st.decrypted += 1 + (doc.artifact ? 1 : 0);
      if (this.unreadable.has(t.task_id)) return shellDoc(doc.task);
      return { task: clone(doc.task), artifact: doc.artifact ? clone(doc.artifact) : null };
    };
    const records = [...this.tasks.values()].filter((t) => passesFilters(t, filters));
    st.filtered = records.length;
    const next = filters.cursor + filters.limit;
    const createdMs = (t: Task) => Date.parse(t.created_at) || 0;
    if (filters.q.trim() === "") {
      records.sort((a, b) => createdMs(b) - createdMs(a) || a.task_id.localeCompare(b.task_id));
      return {
        items: records.slice(filters.cursor, next).map((t) => listItem(full(t), source, false)),
        total: records.length,
        next_cursor: next < records.length ? String(next) : null,
        sources,
      };
    }
    const { terms, phrase } = searchTermsOf(filters.q);
    const index = this.ensureIndex(st);
    const candidates = index.candidates(terms, terms.length >= 2 ? Math.ceil(terms.length / 2) : 1);
    const scored: { task: Task; coverage: number; score: number; createdMs: number }[] = [];
    for (const t of records) {
      let fields: readonly IndexedField[];
      if (!visible(t)) fields = prepareFields(shellDoc(t), false);
      else if (index.has(t.task_id)) {
        if (!candidates.has(t.task_id)) continue;
        fields = index.fields(t.task_id)!;
      } else fields = prepareFields(this.residentDoc(t), false);
      st.scored += 1;
      const ranked = scoreFields(fields, terms, phrase);
      if (ranked) scored.push({ task: t, ...ranked, createdMs: createdMs(t) });
    }
    scored.sort((a, b) => b.coverage - a.coverage || b.score - a.score || b.createdMs - a.createdMs || a.task.task_id.localeCompare(b.task.task_id));
    const items = scored.slice(filters.cursor, next).map((s) => {
      const doc = full(s.task);
      return scoreHistoryDocument(doc, source, terms, phrase, false)?.item ?? listItem(doc, source, false);
    });
    return { items, total: scored.length, next_cursor: next < scored.length ? String(next) : null, sources };
  }

  /**
   * 建立或補齊倒排索引：每一筆已結束、可以丟棄內容的任務都要在索引裡（缺的就解密加入，不留在記憶體）。
   * 金鑰不可用時丟 VaultError；第一次建立失敗時不留下半套索引。
   */
  private ensureIndex(st: ProtectedSearchStats): ProtectedIndex {
    const fresh = this.index === null;
    const index = this.index ?? new ProtectedIndex();
    if (fresh) st.built = true;
    try {
      for (const t of [...this.tasks.values()]) {
        if (!this.coolable(t) || index.has(t.task_id)) continue;
        const wasCold = this.cold.has(t.task_id);
        const doc = this.loadContent(t.task_id, false);
        if (this.unreadable.has(t.task_id)) continue;
        if (wasCold) st.decrypted += 1 + (doc.artifact ? 1 : 0);
        index.add(t.task_id, indexFields(doc));
      }
    } catch (error) {
      if (fresh) index.clear();
      throw error;
    }
    this.index = index;
    return index;
  }

  // ─────────────── 搜尋來源與清單 ───────────────

  /**
   * 成果紀錄搜尋用（HIST-1）：每個任務與它的成果（快照）。完整內容，只給核心與可信主視窗。
   * 加密模式下內容已丟棄的任務逐筆解密（不留在記憶體）；金鑰不可用或讀不到的給外殼。
   */
  documents(): { task: Task; artifact: Artifact | null }[] {
    return [...this.tasks.keys()].map((id) => {
      const doc = this.peek(id);
      return { task: clone(doc.task), artifact: doc.artifact ? clone(doc.artifact) : null };
    });
  }

  /** 對外（/api/history）的搜尋來源：加密模式下只有外殼、沒有成果內容。 */
  publicDocuments(): { task: Task; artifact: Artifact | null }[] {
    if (this.mode !== "sealed") return this.documents();
    return [...this.tasks.values()].map((t) => ({ task: shellOf(t), artifact: null }));
  }

  /**
   * 刪除任務與它的成果（成果紀錄裡經使用者明確確認後）。執行中（排隊、執行、停止中）的任務不能刪：
   * 回 "active"，要先停止。不存在回 "not_found"。兩個檔都改寫後才通知訂閱者。
   */
  delete(taskId: string): { ok: true; task_id: string; artifact_id: string | null } | { ok: false; reason: "not_found" | "active" } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.status === "queued" || task.status === "running" || task.status === "cancelling") return { ok: false, reason: "active" };
    const artifactId = task.artifact_id;
    // MEM-4c：和刪除在同一段同步程式裡先移除索引與快取，刪除之後的任何查詢都不會再看到它。
    this.index?.remove(taskId);
    this.titles.delete(taskId);
    this.cold.delete(taskId);
    this.warm.delete(taskId);
    this.reloadFailed.delete(taskId);
    this.tasks.delete(taskId);
    this.unsealed.delete(taskId);
    this.unreadable.delete(taskId);
    // 同一個任務的成果（正常只有 artifact_id 那一份；保險起見依 task_id 一併清掉）。
    const shredIds = new Set<string>(artifactId ? [artifactId] : []);
    for (const [id, a] of this.artifacts) if (id === artifactId || a.task_id === taskId) { this.artifacts.delete(id); shredIds.add(id); }
    for (const id of shredIds) { forgetHistoryArtifact(id); this.unsealed.delete(id); this.badArtifacts.delete(id); }
    // 明文模式：先移除成果內容，再移除任務（見 load 的說明）。
    this.persistArtifacts();
    // 加密模式（審查 minor 2）：先寫外殼，再刪加密檔；中途中斷時留下的加密檔在下次載入時當孤兒清掉。
    this.persistTasks();
    for (const id of shredIds) this.shred(id);
    this.shred(taskId);
    const deleted = { task_id: taskId, artifact_id: artifactId };
    for (const l of this.deleteListeners) l(deleted);
    return { ok: true, ...deleted };
  }

  /**
   * MEM-4a 撤銷傳播：用到的記憶被忘記、更正、撤回同意、刪除人物或關閉記憶。成果內容（與受記憶影響的步驟標題）移除，
   * 成果加密檔刪掉（刪檔）；任務留外殼、使用者原句與重做。執行中的任務不在這裡處理（TaskRunner 先取消）。
   * MEM-4c：和撤回在同一段同步程式裡先從倒排索引與標題快取移除；之後的任何查詢都不會再比對到成果內容。
   * 內容已丟棄的任務先解密讀回（要重新加密寫入撤回後的任務）；金鑰不可用時只改外殼（不重寫任務檔），成果檔照樣刪。
   */
  withdraw(taskId: string): Task | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    if (existing.withdrawn) return clone(existing);
    if (existing.status === "queued" || existing.status === "running" || existing.status === "cancelling") return null;
    this.index?.remove(taskId);
    this.titles.delete(taskId);
    if (this.cold.has(taskId)) {
      try { this.loadContent(taskId, true); } catch { /* 金鑰不可用：只改外殼（seal 會略過 cold） */ }
    }
    const task = this.tasks.get(taskId)!;
    const shredIds = new Set<string>(task.artifact_id ? [task.artifact_id] : []);
    for (const [id, a] of this.artifacts) if (id === task.artifact_id || a.task_id === taskId) { this.artifacts.delete(id); shredIds.add(id); }
    // HIST-1 的搜尋快取（記憶體裡折疊過的成果純文字）一起丟掉。
    for (const id of shredIds) { forgetHistoryArtifact(id); this.unsealed.delete(id); this.badArtifacts.delete(id); }
    if (shredIds.size) this.persistArtifacts();
    // 先寫外殼（withdrawn），再刪成果檔（審查 minor 2）：中途中斷時，下次載入把殘留的成果檔當孤兒刪掉。
    const updated = this.update(taskId, (t) => {
      t.withdrawn = true;
      t.artifact_id = null;
      for (const s of t.steps) s.title = localize(PROTECTED_STEP, t.locale);
    });
    for (const id of shredIds) this.shred(id);
    return updated;
  }

  /** 審查 B1／M2：這次讀不到內容的任務（只有外殼）；不能重做、不能送給模型。MEM-4c：重新解密時金鑰不可用的也算。 */
  contentMissing(taskId: string): boolean {
    return this.unreadable.has(taskId) || this.reloadFailed.has(taskId);
  }

  /** 完整內容（核心內部與可信主視窗）。內容已丟棄的任務逐筆解密（不留在記憶體）；金鑰不可用的給外殼。 */
  list(): Task[] {
    return [...this.tasks.keys()].map((id) => clone(this.peek(id).task));
  }

  /** 可信主視窗的清單（IPC list）：範圍外的任務只給外殼、不解密；範圍內內容已丟棄的逐筆解密（不留在記憶體）。 */
  listFor(inScope: (task: Task) => boolean, stats?: { decrypted: number }): Task[] {
    // 審查 minor 5：內容已丟棄的任務只讀任務檔（不讀成果），經標題快取；審查 minor 1：撤回中或停止中的撤銷任務給外殼。
    return [...this.tasks.values()].map((record) => {
      if (!inScope(record) || this.hiddenNow(record)) return shellOf(record);
      if (!this.cold.has(record.task_id) || this.unreadable.has(record.task_id)) return clone(record);
      const real = this.titleOf(record, stats);
      return real ? clone(real) : shellOf(record);
    });
  }

  /**
   * 內容已丟棄的任務的真實標題、步驟標題與錯誤（只解密任務檔，不讀成果），放進最多 TITLE_CACHE_MAX 筆的快取（丟棄時清空）。
   * 解不開或讀不到回 null（呼叫端給外殼）。
   */
  private titleOf(record: Task, stats?: { decrypted: number }): Task | null {
    const id = record.task_id;
    let real = this.titles.get(id);
    if (real) {
      this.titles.delete(id);
      this.titles.set(id, real);
      return real;
    }
    try {
      const read = this.vault?.read<Task>(id) ?? null;
      if (stats) stats.decrypted += 1;
      if (!read) return null;
      real = merge(read, record);
    } catch {
      return null;
    }
    this.titles.set(id, real);
    while (this.titles.size > TITLE_CACHE_MAX) this.titles.delete(this.titles.keys().next().value!);
    return real;
  }

  /**
   * 一筆任務的完整內容（核心內部）；內容已丟棄時解密但不留在記憶體、不延長閒置計時（審查 minor 2）。
   * 金鑰不可用時給外殼，contentMissing 回 true。只要狀態的呼叫端用 publicGet（不解密）。
   */
  get(taskId: string): Task | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    try {
      return clone(this.loadContent(taskId, false).task);
    } catch {
      return clone(this.tasks.get(taskId)!);
    }
  }

  getArtifact(artifactId: string): Artifact | undefined {
    const a = this.artifacts.get(artifactId);
    if (a) return clone(a);
    if (this.mode !== "sealed") return undefined;
    for (const t of this.tasks.values()) {
      if (t.artifact_id !== artifactId || !this.cold.has(t.task_id)) continue;
      const doc = this.peek(t.task_id);
      return doc.artifact ? clone(doc.artifact) : undefined;
    }
    return undefined;
  }

  /** 對外（SSE、/api/tasks、模型提示）：加密模式下是外殼。 */
  publicList(): Task[] {
    return this.mode === "sealed" ? [...this.tasks.values()].map(shellOf) : this.list();
  }

  publicGet(taskId: string): Task | undefined {
    const t = this.tasks.get(taskId);
    return t ? (this.mode === "sealed" ? shellOf(t) : clone(t)) : undefined;
  }

  /** 對外的成果：加密模式下一律沒有（/api/artifacts 回 404，內容只經 IPC）。 */
  publicArtifact(artifactId: string): Artifact | undefined {
    return this.mode === "sealed" ? undefined : this.getArtifact(artifactId);
  }

  create(input: { title: string; request_id: string; mode: ExecutorMode; retry_of?: string; locale?: Locale; task_id?: string; memory?: boolean; origin?: "user_sentence" }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      schema_version: SCHEMA_VERSION,
      task_id: input.task_id ?? `task_${randomUUID()}`,
      request_id: input.request_id,
      title: input.title,
      ...(normalizeLocale(input.locale) === "en" ? { locale: "en" as const } : {}),
      status: "queued",
      mode: input.mode,
      model: null,
      plan_ready: false,
      steps: [],
      created_at: now,
      updated_at: now,
      finished_at: null,
      error: null,
      artifact_id: null,
      retry_of: input.retry_of ?? null,
      ...(input.memory ? { memory: true } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    };
    if (this.tasks.has(task.task_id)) throw new Error("duplicate task id");
    this.tasks.set(task.task_id, task);
    this.seal(task);
    this.commit(task);
    return clone(task);
  }

  /**
   * 以 mutator 修改任務並通知訂閱者；回傳修改後的快照。
   * MEM-4c：內容已丟棄（cold）的任務在這裡只改外殼（seal 會略過）；需要真實內容的呼叫端（withdraw）先讀回。
   */
  update(taskId: string, mutate: (task: Task) => void): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const before = sealKey(task);
    mutate(task);
    task.updated_at = new Date().toISOString();
    // 加密檔只在狀態、規劃、錯誤、成果或撤銷改變時寫；步驟進度只改外殼。
    if (sealKey(task) !== before) this.seal(task);
    // 審查 B1：之前沒寫成的成果，下一次更新時再試。
    if (task.artifact_id && this.unsealed.has(task.artifact_id)) {
      const artifact = this.artifacts.get(task.artifact_id);
      if (artifact) this.seal(artifact);
    }
    this.commit(task);
    if (this.mode === "sealed") this.settle(taskId);
    return clone(task);
  }

  addArtifact(input: Omit<Artifact, "schema_version" | "artifact_id" | "version" | "created_at">): Artifact {
    const artifact: Artifact = {
      schema_version: SCHEMA_VERSION,
      artifact_id: `artifact_${randomUUID()}`,
      version: 1,
      created_at: new Date().toISOString(),
      ...input,
    };
    this.artifacts.set(artifact.artifact_id, artifact);
    this.seal(artifact);
    this.persistArtifacts();
    return clone(artifact);
  }

  private commit(task: Task): void {
    this.persistTasks();
    const snapshot = this.mode === "sealed" ? shellOf(task) : clone(task);
    for (const l of this.listeners) l(snapshot);
  }
}

function isTerminal(t: Pick<Task, "status">): boolean {
  return t.status === "succeeded" || t.status === "failed" || t.status === "cancelled";
}

/** 倒排索引只留折疊後的欄位（不留原文）。 */
function indexFields(doc: HistoryDocument): IndexedField[] {
  return prepareFields(doc, false).map((f) => ({ field: f.field, folded: f.folded }));
}

function sealKey(t: Task): string {
  return JSON.stringify([t.status, t.plan_ready, t.steps.length, t.error, t.artifact_id, t.withdrawn ?? false, t.cancel_reason ?? null, t.model]);
}

/** 加密檔的內容加上外殼的狀態（外殼在每次更新都寫，比加密檔新）。 */
function merge(real: Task, shell: Task): Task {
  // 撤回過的任務：受記憶影響的步驟標題不從加密檔拿回來（加密檔可能是撤回前寫的）。
  const steps = shell.steps.map((s, i) => ({ ...s, title: shell.withdrawn ? s.title : real.steps[i]?.title ?? s.title }));
  const { protected: _shell, ...rest } = real;
  return {
    ...rest,
    status: shell.status,
    plan_ready: shell.plan_ready,
    steps,
    updated_at: shell.updated_at,
    finished_at: shell.finished_at,
    artifact_id: shell.artifact_id,
    model: shell.model,
    error: shell.error === null ? null : real.error ?? shell.error,
    ...(shell.error_action !== undefined ? { error_action: shell.error_action } : {}),
    ...(shell.withdrawn ? { withdrawn: true } : {}),
    ...(shell.cancel_reason ? { cancel_reason: shell.cancel_reason } : {}),
  };
}

/**
 * 給模型的任務清單（MEM-4a，George 2026-10-30）：加密模式下，目標有記憶同意時，可以給的任務放真實標題，
 * 其他任務（含讀不到內容的）一律外殼；沒有同意或沒有記憶層時全部外殼。瀏覽器版照舊。
 * 用在對話提示、即時語音指示與 get_tasks（App 的頁面經 IPC voice_tasks 取得）。
 */
export function tasksForTarget<T>(store: TaskStore, memory: { taskTitleFilter?(target: T | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null } | null, target: T | null): Task[] {
  if (!store.sealed) return store.publicList();
  const allow = memory?.taskTitleFilter?.(target) ?? null;
  if (!allow) return store.publicList();
  // MEM-4c：內容已丟棄的任務只在模型看得到的前幾筆裡才解密標題（TaskStore.modelTasks）。
  return store.modelTasks(allow);
}

/**
 * MEM-5b：記憶層看任務的兩個窗口（server/nous.ts 的 TaskPort 與測試共用）。
 * scopedList：可信主視窗的清單規則（listFor）；inScope 為 false、撤回中或讀不到內容的一律外殼（protected: true），範圍外的不解密。
 * taskState：不解密，只看任務還在不在、成果有沒有撤回；讀不到內容的任務仍是 present（不能當成已刪除）。
 */
export function memoryTaskViews(store: TaskStore): { scopedList(inScope: (task: Task) => boolean): Task[]; taskState(taskId: string): "present" | "withdrawn" | "missing" } {
  return {
    // listFor 已經把撤回中（hiddenNow）的任務當成範圍外（外殼）。
    scopedList: (inScope) => store.listFor(inScope).map((task) => (store.contentMissing(task.task_id) ? shellOf(task) : task)),
    taskState: (taskId) => {
      const task = store.publicGet(taskId);
      return !task ? "missing" : task.withdrawn ? "withdrawn" : "present";
    },
  };
}

/** 受保護外殼：標題、步驟標題與錯誤換成固定句；狀態、時間、步驟數與腦區（domain）照舊，電子腦動畫仍由真實事件驅動。 */
export function shellOf(task: Task): Task {
  const t = clone(task);
  return {
    ...t,
    title: localize(PROTECTED_TITLE, t.locale),
    steps: t.steps.map((s) => ({ ...s, title: localize(PROTECTED_STEP, t.locale) })),
    error: t.error === null ? null : localize(PROTECTED_ERROR, t.locale),
    protected: true,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 0600、唯一的暫存檔名、fsync 檔案與資料夾後才 rename（MEM-4a 補強；格式不變）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* 已不存在 */ }
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
