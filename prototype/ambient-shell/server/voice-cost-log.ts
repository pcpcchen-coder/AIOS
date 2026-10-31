import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VoiceCostRecord } from "../shared/voice-cost.ts";

// F6 費用紀錄（docs/13 F6、docs/17 §5.7 第 3 點；WK-02）：configDir/voice-cost.jsonl，一行一筆，只留最近 VOICE_COST_KEEP 筆。
// 內容只有路徑、模型、開始方式、wake_id、時間、連線毫秒、結束原因與 usage（費用一律 unknown）；沒有逐字稿、音訊或姓名。
// 檔案權限 0600。寫入失敗只記 log，不影響通話。

export const VOICE_COST_FILE = "voice-cost.jsonl";
export const VOICE_COST_KEEP = 500;
export const VOICE_COST_LIST_DEFAULT = 50;

export interface VoiceCostLogOptions {
  dir: string;
  log?(message: string): void;
}

export class VoiceCostLog {
  readonly file: string;

  constructor(private readonly options: VoiceCostLogOptions) {
    this.file = join(options.dir, VOICE_COST_FILE);
  }

  /** 加一筆並只留最近 VOICE_COST_KEEP 筆（先寫暫存檔再改名，權限 0600）。 */
  record(record: VoiceCostRecord): void {
    this.write([...this.lines(), JSON.stringify(record)]);
  }

  /** 改寫同一個 session_id 的最後一筆（頁面的 no_voice／usage 晚到時）；找不到就加一筆。 */
  amend(record: VoiceCostRecord): void {
    const lines = this.lines();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        if ((JSON.parse(lines[i]!) as VoiceCostRecord).session_id === record.session_id) {
          lines[i] = JSON.stringify(record);
          this.write(lines);
          return;
        }
      } catch {
        // 讀不懂的行略過
      }
    }
    this.record(record);
  }

  private write(all: string[]): void {
    try {
      const lines = all.slice(-VOICE_COST_KEEP);
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      this.options.log?.("費用紀錄：寫入失敗（不影響通話）");
    }
  }

  /** 最近 limit 筆（新的在前）。讀不懂的行略過。 */
  list(limit = VOICE_COST_LIST_DEFAULT): VoiceCostRecord[] {
    const n = Math.min(Math.max(1, Math.floor(limit)), VOICE_COST_KEEP);
    const records: VoiceCostRecord[] = [];
    for (const line of this.lines().reverse()) {
      if (records.length >= n) break;
      try {
        const value = JSON.parse(line) as VoiceCostRecord;
        if (value && typeof value === "object" && value.v === 1) records.push(value);
      } catch {
        // 讀不懂的行略過
      }
    }
    return records;
  }

  private lines(): string[] {
    if (!existsSync(this.file)) return [];
    try {
      return readFileSync(this.file, "utf8").split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  }
}

/** GET /api/realtime/cost-records?limit= 的 limit：1–500 的整數，其他值用預設 50。 */
export function parseCostLimit(value: string | null): number {
  if (value === null || !/^\d{1,4}$/.test(value)) return VOICE_COST_LIST_DEFAULT;
  const n = Number(value);
  return n >= 1 && n <= VOICE_COST_KEEP ? n : VOICE_COST_LIST_DEFAULT;
}
