import { DEFAULT_DAY_NIGHT_PREFS, NIGHT_VOLUME_DEFAULT, parseDayNightPrefs, type DayNightDecision, type DayNightMode, type DayNightPrefs } from "../shared/day-night.ts";
import { clampVoiceVolume, nextVoiceVolume, VOICE_VOLUME_DEFAULT, type VoiceVolumeOutcome, type VoiceVolumeRequest } from "../shared/voice-volume.ts";

// VOL-1：對話音量的頁面狀態（shared/voice-volume.ts 是規則）。播放 AI 語音的元素（兩條即時語音路徑）向這裡登記，
// 改音量時立即套用到正在播的元素；值存在這個頁面的 localStorage，每台裝置各自保存，不送核心。
// VOL-2：分日間與夜間兩個音量（shared/day-night.ts 決定現在是哪一個）。日間沿用 VOL-1 的鍵，所以舊值不必遷移。

export const VOICE_VOLUME_KEY = "nous.voice-volume.v1";
export const NIGHT_VOLUME_KEY = "nous.voice-volume.night.v1";
export const DAY_NIGHT_KEY = "nous.day-night.v1";

/** 設定頁的文字（原文；畫面上經 t() 翻譯，英文在 src/messages.en.json）。 */
export const VOICE_VOLUME_TEXT = {
  title: "這台裝置的對話音量",
  current: "目前 {0}",
  down: "小聲一點",
  up: "大聲一點",
  reset: "恢復預設",
  note: "只調即時語音中 Nous 說話的聲音，最大就是系統音量；即時語音中也可以說「你講話大聲一點」「音量 60」。語音模式的系統朗讀、提示音與系統音量不變。",
  day: "日間音量",
  night: "夜間音量",
  inUse: "使用中",
  modeLine: {
    day: "現在用日間音量",
    hours: "現在用夜間音量：在夜間時段（{0}:00–{1}:00）",
    camera_dark: "現在用夜間音量：鏡頭量到環境很暗",
  },
  hoursStart: "夜間開始",
  hoursEnd: "夜間結束",
  hoursNote: "開始和結束選同一個整點就沒有夜間時段。",
  camera: "用鏡頭亮度判斷",
  cameraNote: "鏡頭有開時每 30 秒量一次畫面的平均亮度（只留一個數字，不保存影像）；連續 1 分鐘都很暗就用夜間音量。鏡頭會自動曝光，晚上開著燈仍會亮，所以夜間時段內一律用夜間音量。",
  light: {
    unknown: "鏡頭亮度：—（鏡頭沒開或還沒量到，只看時段）",
    off: "鏡頭亮度：不使用（只看時段）",
    reading: "鏡頭亮度：{0}（{1}）",
    dark: "暗",
    bright: "亮",
    middle: "介於中間",
  },
} as const;

type VolumeStorage = Pick<Storage, "getItem" | "setItem">;

function pageStorage(): VolumeStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function loadNumber(storage: VolumeStorage | null, key: string, fallback: number): number {
  try {
    const saved = storage?.getItem(key);
    if (saved !== null && saved !== undefined && saved.trim() !== "" && Number.isFinite(Number(saved))) return clampVoiceVolume(Number(saved));
  } catch {}
  return fallback;
}

export function loadVoiceVolume(storage: VolumeStorage | null = pageStorage()): number {
  return loadNumber(storage, VOICE_VOLUME_KEY, VOICE_VOLUME_DEFAULT);
}

export function loadNightVolume(storage: VolumeStorage | null = pageStorage()): number {
  return loadNumber(storage, NIGHT_VOLUME_KEY, NIGHT_VOLUME_DEFAULT);
}

export function loadDayNightPrefs(storage: VolumeStorage | null = pageStorage()): DayNightPrefs {
  try {
    const saved = storage?.getItem(DAY_NIGHT_KEY);
    if (saved) return parseDayNightPrefs(JSON.parse(saved));
  } catch {}
  return { ...DEFAULT_DAY_NIGHT_PREFS };
}

function save(storage: VolumeStorage | null, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value);
    return !!storage;
  } catch {
    return false;
  }
}

/** 保存失敗（無痕、封鎖儲存）只影響下次開啟，這次仍照設定播放。 */
export function saveVoiceVolume(volume: number, storage: VolumeStorage | null = pageStorage()): boolean {
  return save(storage, VOICE_VOLUME_KEY, String(clampVoiceVolume(volume)));
}

/** 能調音量的播放元素（HTMLMediaElement 的子集，方便測試）。 */
export interface VolumeTarget {
  volume: number;
}

export interface VoiceVolumeChangeResult {
  outcome: VoiceVolumeOutcome;
  /** 調的是哪一個時段的音量。 */
  period: DayNightMode;
  /** 現在用的是哪一個。 */
  active: DayNightMode;
}

export class VoiceVolume {
  private readonly volumes: Record<DayNightMode, number>;
  private decision: DayNightDecision = { mode: "day", reason: "day", camera: false };
  private prefsValue: DayNightPrefs;
  private readonly targets = new Set<VolumeTarget>();
  private readonly listeners = new Set<(volume: number) => void>();

  constructor(private readonly storage: VolumeStorage | null = pageStorage()) {
    this.volumes = { day: loadVoiceVolume(storage), night: loadNightVolume(storage) };
    this.prefsValue = loadDayNightPrefs(storage);
  }

  /** 現在播放用的音量（依日間／夜間）。 */
  get current(): number {
    return this.volumes[this.decision.mode];
  }

  get mode(): DayNightDecision {
    return this.decision;
  }

  get prefs(): DayNightPrefs {
    return this.prefsValue;
  }

  volumeFor(period: DayNightMode): number {
    return this.volumes[period];
  }

  /** 播放元素開始播放時登記（立即套用目前音量）；回傳的函式在停止播放時呼叫。 */
  attach(target: VolumeTarget): () => void {
    this.targets.add(target);
    target.volume = this.current / 100;
    return () => this.targets.delete(target);
  }

  /** 依請求調整（語音工具與設定頁共用）；沒指定時段就調現在用的那一個。成功就保存，並套用到正在播的元素。 */
  change(request: VoiceVolumeRequest): VoiceVolumeChangeResult {
    const period = request.period ?? this.decision.mode;
    const outcome = nextVoiceVolume(this.volumes[period], request, period === "night" ? NIGHT_VOLUME_DEFAULT : VOICE_VOLUME_DEFAULT);
    if (outcome.ok) {
      this.volumes[period] = outcome.volume;
      save(this.storage, period === "night" ? NIGHT_VOLUME_KEY : VOICE_VOLUME_KEY, String(outcome.volume));
      this.applyTargets();
    }
    return { outcome, period, active: this.decision.mode };
  }

  /** VOL-1 的介面：調現在用的那一個。 */
  apply(request: VoiceVolumeRequest): VoiceVolumeOutcome {
    return this.change(request).outcome;
  }

  /** 直接設定現在用的那一個。 */
  set(volume: number): void {
    this.change({ level: volume });
  }

  /** 日間／夜間的判斷改變：換成那一個音量（正在播的元素立即套用）。 */
  setMode(decision: DayNightDecision): void {
    const changed = decision.mode !== this.decision.mode;
    this.decision = decision;
    if (changed) this.applyTargets();
  }

  setPrefs(patch: Partial<DayNightPrefs>): DayNightPrefs {
    this.prefsValue = parseDayNightPrefs({ ...this.prefsValue, ...patch });
    save(this.storage, DAY_NIGHT_KEY, JSON.stringify(this.prefsValue));
    return this.prefsValue;
  }

  onChange(listener: (volume: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyTargets(): void {
    for (const target of this.targets) target.volume = this.current / 100;
    for (const listener of this.listeners) listener(this.current);
  }
}

/** 頁面共用的一份。 */
export const voiceVolume = new VoiceVolume();
