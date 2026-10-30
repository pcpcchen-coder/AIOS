// MEM-4c：受保護成果（加密保存的任務與成果）的 RAM 倒排索引。只在核心記憶體，從不寫檔。
// - 第一次經授權的搜尋（可信主視窗的 IPC search）才建立：解密每一筆已結束的受保護任務，用和 HIST-1 相同的
//   prepareFields（Markdown 轉純文字、foldForSearch 簡繁對照與小寫）取得折疊後的欄位，再建立 UTF-16 單字與二字片段的倒排表。
// - 每筆只留折疊後的欄位（不留原文）。這些欄位仍然是內容的副本，和解密後的內容一樣敏感；所以 OS 鎖定、睡眠、閒置、關閉記憶、
//   結束 App 時和解密內容一起丟棄（TaskStore.dropPlaintext）。
// - 查詢詞（queryTerms：中文二字片段、單一漢字、英文與數字詞）在 UTF-16 上是子字串比對：一個詞出現在欄位裡，它的每個相鄰二字
//   片段（長度 1 的詞是那一個字）一定也在欄位裡。所以倒排表給的候選是「超集合」，再用 scoreFields 在候選的折疊欄位上逐筆精確比對：
//   排序與命中和逐筆掃描完全相同。中文二字片段（最常見的查詢詞）本身就是索引鍵，候選就是精確的命中。
// - 刪除、撤回（忘記、更正、撤回同意、刪除人物、關閉記憶）在 TaskStore 的同一段同步程式裡移除（remove 是 O(1)）：
//   移除之後的任何查詢都不會再看到它。

export interface IndexedField {
  field: "title" | "content" | "step" | "notes";
  folded: string;
}

interface IndexedDoc {
  taskId: string;
  fields: readonly IndexedField[];
}

/** 被移除（墓碑）的項目超過有效項目的兩倍（而且超過 256 筆）時重建倒排表。 */
const COMPACT_MIN_DEAD = 256;

export class ProtectedIndex {
  private docs: (IndexedDoc | undefined)[] = [];
  private readonly byTask = new Map<string, number>();
  private postings = new Map<string, number[]>();
  private dead = 0;

  /** 目前有效的筆數。 */
  get size(): number {
    return this.byTask.size;
  }

  has(taskId: string): boolean {
    return this.byTask.has(taskId);
  }

  /** 折疊後的欄位（給 scoreFields）；不在索引裡回 null。 */
  fields(taskId: string): readonly IndexedField[] | null {
    const id = this.byTask.get(taskId);
    return id === undefined ? null : this.docs[id]!.fields;
  }

  /** 加入或取代一筆。 */
  add(taskId: string, fields: readonly IndexedField[]): void {
    this.remove(taskId);
    this.insert({ taskId, fields: fields.map((f) => ({ field: f.field, folded: f.folded })) });
  }

  private insert(doc: IndexedDoc): void {
    const id = this.docs.length;
    this.docs.push(doc);
    this.byTask.set(doc.taskId, id);
    const grams = new Set<string>();
    for (const f of doc.fields) {
      const text = f.folded;
      for (let i = 0; i < text.length; i++) {
        grams.add(text[i]!);
        if (i + 1 < text.length) grams.add(text.slice(i, i + 2));
      }
    }
    for (const gram of grams) {
      const list = this.postings.get(gram);
      if (list) list.push(id);
      else this.postings.set(gram, [id]);
    }
  }

  /** 移除一筆（O(1)，留墓碑）；之後的查詢不會再回傳它。 */
  remove(taskId: string): boolean {
    const id = this.byTask.get(taskId);
    if (id === undefined) return false;
    this.byTask.delete(taskId);
    this.docs[id] = undefined;
    this.dead += 1;
    if (this.dead > COMPACT_MIN_DEAD && this.dead > this.byTask.size * 2) this.compact();
    return true;
  }

  private compact(): void {
    const live = this.docs.filter((d): d is IndexedDoc => d !== undefined);
    this.docs = [];
    this.byTask.clear();
    this.postings = new Map();
    this.dead = 0;
    for (const doc of live) this.insert(doc);
  }

  clear(): void {
    this.docs = [];
    this.byTask.clear();
    this.postings = new Map();
    this.dead = 0;
  }

  /**
   * 每筆候選最多可能命中幾個查詢詞（上限；精確值由 scoreFields 計算）。不可能命中任何詞的項目不在結果裡。
   * minHits：至少要命中幾個詞才可能算（有兩個以上的詞時要一半），低於的直接略過。
   */
  candidates(terms: readonly string[], minHits = 1): Map<string, number> {
    const counts = new Map<number, number>();
    for (const term of terms) {
      for (const id of this.lookup(term)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const out = new Map<string, number>();
    for (const [id, count] of counts) {
      const doc = this.docs[id];
      if (doc && count >= minHits) out.set(doc.taskId, count);
    }
    return out;
  }

  /** 一個查詢詞的候選（每個相鄰二字片段的倒排表取交集；長度 1 的詞直接查那一個字）。 */
  private lookup(term: string): number[] {
    if (term.length === 0) return [];
    const keys = term.length === 1 ? [term] : Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2));
    const lists: number[][] = [];
    for (const key of new Set(keys)) {
      const list = this.postings.get(key);
      if (!list) return [];
      lists.push(list);
    }
    lists.sort((a, b) => a.length - b.length);
    let result = lists[0]!.filter((id) => this.docs[id] !== undefined);
    for (let i = 1; i < lists.length && result.length > 0; i++) result = intersectSorted(result, lists[i]!);
    return result;
  }
}

/** 兩個遞增的整數陣列取交集。 */
function intersectSorted(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    if (x === y) { out.push(x); i++; j++; } else if (x < y) i++; else j++;
  }
  return out;
}
