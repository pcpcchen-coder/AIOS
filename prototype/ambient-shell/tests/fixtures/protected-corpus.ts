import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedVault } from "../../server/sealed-vault.ts";
import { shellOf, TaskStore, writeJsonAtomic, type TaskSealing } from "../../server/store.ts";
import type { MemorySecretBox } from "../../server/memory/store.ts";
import type { Artifact, ExecutorMode, Task, TaskStatus } from "../../shared/types.ts";
import { fakeBox } from "./memory-service.ts";
import { testLockProvider } from "./memory-lock.ts";

// MEM-4c：合成的受保護任務語料（全部虛構）。內容由固定種子的偽亂數產生，同一個 i 每次都一樣；
// 直接寫加密檔與外殼 tasks.json（和 TaskStore 重新啟動時讀到的一樣），不經過執行器。

const ZH = ["晚餐", "規劃", "旅行", "預算", "會議", "報告", "孩子", "學校", "週末", "採買", "食譜", "健身", "睡眠", "閱讀", "電影", "音樂", "花園", "整理", "房間", "保險", "稅務", "帳單", "醫院", "牙醫", "生日", "禮物", "朋友", "爺爺", "奶奶", "寵物", "散步", "咖啡", "早餐", "午餐", "蔬菜", "水果", "天氣", "雨傘", "火車", "機票", "飯店", "地圖", "博物館", "公園", "游泳", "腳踏車", "手機", "電腦", "印表機", "網路", "密碼", "相簿", "照片", "影片", "比較", "清單", "提醒", "計畫", "研究", "摘要", "翻譯", "郵件", "回覆", "合約", "租屋", "搬家", "裝潢", "家具", "冰箱", "洗衣機"];
const EN = ["budget", "dinner", "travel", "meeting", "report", "school", "weekend", "grocery", "recipe", "fitness", "reading", "movie", "garden", "insurance", "invoice", "dentist", "birthday", "gift", "coffee", "breakfast", "weather", "train", "flight", "hotel", "museum", "swimming", "bicycle", "laptop", "printer", "password", "photos", "compare", "checklist", "reminder", "research", "summary", "translate", "contract", "apartment", "furniture", "planning", "schedule", "estimate", "vendor", "receipt"];

/** 固定種子的偽亂數（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

export interface CorpusOptions {
  /** 第 i 筆是否帶記憶（memory: true；範圍測試用）。 */
  memory?: (i: number) => boolean;
  /** 第 i 筆的狀態（預設 succeeded；每 7 筆一筆 failed）。 */
  status?: (i: number) => TaskStatus;
  /** 加進第 i 筆成果的額外文字（canary 或稀有詞）。 */
  extra?: (i: number) => string;
  /** 加進第 i 筆標題的額外文字。 */
  titleExtra?: (i: number) => string;
}

/** 第 i 筆合成任務與成果（成果約 400–700 字，中英混合、有 Markdown）。 */
export function corpusDoc(i: number, options: CorpusOptions = {}): { task: Task; artifact: Artifact | null } {
  const r = rng(1000 + i);
  const status: TaskStatus = options.status?.(i) ?? (i % 7 === 6 ? "failed" : "succeeded");
  const mode: ExecutorMode = (["claude", "chatgpt", "mock"] as const)[i % 3]!;
  const title = `幫我${pick(r, ZH)}${pick(r, ZH)}的${pick(r, ZH)}（${pick(r, EN)}）${options.titleExtra?.(i) ?? ""}`;
  const created = new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();
  const taskId = `task_${uuidFrom(r)}`;
  const artifactId = status === "succeeded" ? `artifact_${uuidFrom(r)}` : null;
  const sentence = () => Array.from({ length: 6 + Math.floor(r() * 6) }, () => (r() < 0.6 ? pick(r, ZH) : ` ${pick(r, EN)} `)).join("");
  const paragraphs = Array.from({ length: 6 + Math.floor(r() * 4) }, () => `${r() < 0.3 ? "## " : "- "}${sentence()}，${sentence()}。`);
  const content = `${paragraphs.join("\n")}${options.extra ? `\n${options.extra(i)}` : ""}`;
  const task: Task = {
    schema_version: "proto-0.1", task_id: taskId, request_id: `req_corpus${String(i).padStart(6, "0")}`, title, status, mode, model: mode === "mock" ? null : "fixture-model",
    plan_ready: true,
    steps: [
      { title: "規劃步驟", status: "done", started_at: created, finished_at: created, output_chars: null, domain: "planning" },
      { title: `整理${pick(r, ZH)}與${pick(r, EN)}`, status: status === "failed" ? "failed" : "done", started_at: created, finished_at: created, output_chars: 400, domain: "language" },
    ],
    created_at: created, updated_at: created, finished_at: created, error: status === "failed" ? `執行失敗：${pick(r, ZH)}逾時` : null, artifact_id: artifactId, retry_of: null,
    ...(options.memory?.(i) ? { memory: true, origin: "user_sentence" as const } : {}),
  };
  const artifact: Artifact | null = artifactId ? {
    schema_version: "proto-0.1", artifact_id: artifactId, task_id: taskId, version: 1, title, content, mode, model: task.model,
    assumptions: [`假設${pick(r, ZH)}不變`], capability_gaps: r() < 0.3 ? [`無法確認${pick(r, ZH)}`] : [], status: "complete", created_at: created,
  } : null;
  return { task, artifact };
}

function uuidFrom(r: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 寫好 n 筆加密任務（加密檔＋外殼 tasks.json），回傳資料夾與原始內容。 */
export function seedSealed(n: number, options: CorpusOptions & { dataDir?: string; box?: MemorySecretBox } = {}): { dataDir: string; box: MemorySecretBox; docs: { task: Task; artifact: Artifact | null }[] } {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "nous-mem4c-"));
  const box = options.box ?? fakeBox(randomBytes(32));
  const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: box, lockProvider: testLockProvider });
  const docs = Array.from({ length: n }, (_, i) => corpusDoc(i, options));
  try {
    for (const d of docs) {
      vault.write(d.task.task_id, d.task);
      if (d.artifact) vault.write(d.artifact.artifact_id, d.artifact);
    }
  } finally {
    vault.close();
  }
  writeJsonAtomic(join(dataDir, "tasks.json"), docs.map((d) => shellOf(d.task)));
  return { dataDir, box, docs };
}

/** 開一個 TaskStore（重新啟動）。 */
export function openSealed(dataDir: string, box: MemorySecretBox, sealing: Partial<TaskSealing> = {}): { store: TaskStore; vault: SealedVault } {
  const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: box, lockProvider: testLockProvider });
  return { store: new TaskStore(dataDir, { vault, ...sealing }), vault };
}

export { randomUUID };
