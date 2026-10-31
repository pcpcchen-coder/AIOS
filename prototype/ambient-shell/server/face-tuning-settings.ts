import {
  checkFaceTuning,
  DEFAULT_FACE_TUNING,
  FACE_TUNING_KEYS,
  FaceTuningError,
  parseFaceTuningPatch,
  type FaceTuning,
  type FaceTuningView,
} from "../shared/face-tuning.ts";
import { PrefsFile } from "./prefs-file.ts";

// 人臉辨識的校正值（configDir/face-tuning.json）。只有這裡寫入；「校正人臉辨識」按「套用」或「還原預設」時更新。
// 檔案只存改過的鍵；讀不懂或某個鍵不合法時退回預設（預設就是校正功能出現前的行為，沒有安全疑慮）。

type Stored = FaceTuning & { calibrated_at: string };

function parseStored(input: unknown): Partial<Stored> {
  if (input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "calibrated_at")) {
    const { calibrated_at, ...rest } = input as Record<string, unknown>;
    if (typeof calibrated_at !== "string" || Number.isNaN(Date.parse(calibrated_at))) throw new FaceTuningError("calibrated_at 必須是時間");
    return { ...parseFaceTuningPatch(rest), calibrated_at };
  }
  return parseFaceTuningPatch(input);
}

export interface FaceTuningStoreOptions {
  /** configDir；不存在時以 0o700 建立。 */
  dir: string;
  /** 改變後呼叫（接到 notifySettings → SSE settings.updated）。 */
  onChange(): void;
  log?(message: string): void;
  now?(): Date;
}

export class FaceTuningStore {
  private readonly file: PrefsFile<Stored>;

  constructor(private readonly options: FaceTuningStoreOptions) {
    this.file = new PrefsFile<Stored>({
      dir: options.dir,
      name: "face-tuning.json",
      version: 1,
      parse: parseStored,
      failClosed: {},
      unreadable: "人臉辨識校正值用預設",
      log: options.log,
    });
  }

  view(): FaceTuningView {
    const saved = this.file.saved;
    const tuning = Object.fromEntries(FACE_TUNING_KEYS.map((k) => [k, saved[k] ?? DEFAULT_FACE_TUNING[k]])) as unknown as FaceTuning;
    // 檔案被手改成不合理的範圍：整組退回預設，不用一半。
    try {
      checkFaceTuning(tuning);
    } catch {
      return { ...DEFAULT_FACE_TUNING, customized: false, calibrated_at: null };
    }
    return {
      ...tuning,
      customized: FACE_TUNING_KEYS.some((k) => tuning[k] !== DEFAULT_FACE_TUNING[k]),
      calibrated_at: saved.calibrated_at ?? null,
    };
  }

  /**
   * 套用已驗證的 patch（呼叫端先用 parseFaceTuningPatch）：合併後檢查整組，先寫檔再改記憶體。
   * calibrated：這次是「校正人臉辨識」的套用（記下時間）；手動微調不改時間。
   */
  update(patch: Partial<FaceTuning>, calibrated = false): FaceTuningView {
    const current = this.view();
    const merged = { ...current, ...patch };
    checkFaceTuning(merged);
    this.file.update({ ...patch, ...(calibrated ? { calibrated_at: (this.options.now?.() ?? new Date()).toISOString() } : {}) });
    this.options.onChange();
    return this.view();
  }

  /** 還原預設：把每一項寫回預設值並清掉校正時間。 */
  reset(): FaceTuningView {
    this.file.replace({});
    this.options.onChange();
    return this.view();
  }
}
