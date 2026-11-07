import { clampVoiceVolume, nextVoiceVolume, VOICE_VOLUME_DEFAULT, type VoiceVolumeOutcome, type VoiceVolumeRequest } from "../shared/voice-volume.ts";

// VOL-1：對話音量的頁面狀態（shared/voice-volume.ts 是規則）。播放 AI 語音的元素（兩條即時語音路徑）向這裡登記，
// 改音量時立即套用到正在播的元素；值存在這個頁面的 localStorage，每台裝置各自保存，不送核心。

export const VOICE_VOLUME_KEY = "nous.voice-volume.v1";

/** 設定頁的文字（原文；畫面上經 t() 翻譯，英文在 src/messages.en.json）。 */
export const VOICE_VOLUME_TEXT = {
  title: "這台裝置的對話音量",
  current: "目前 {0}",
  down: "小聲一點",
  up: "大聲一點",
  reset: "恢復預設",
  note: "只調即時語音中 Nous 說話的聲音，最大就是系統音量；即時語音中也可以說「你講話大聲一點」「音量 60」。語音模式的系統朗讀、提示音與系統音量不變。",
} as const;

type VolumeStorage = Pick<Storage, "getItem" | "setItem">;

function pageStorage(): VolumeStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadVoiceVolume(storage: VolumeStorage | null = pageStorage()): number {
  try {
    const saved = storage?.getItem(VOICE_VOLUME_KEY);
    if (saved !== null && saved !== undefined && saved.trim() !== "" && Number.isFinite(Number(saved))) return clampVoiceVolume(Number(saved));
  } catch {}
  return VOICE_VOLUME_DEFAULT;
}

/** 保存失敗（無痕、封鎖儲存）只影響下次開啟，這次仍照設定播放。 */
export function saveVoiceVolume(volume: number, storage: VolumeStorage | null = pageStorage()): boolean {
  try {
    storage?.setItem(VOICE_VOLUME_KEY, String(clampVoiceVolume(volume)));
    return !!storage;
  } catch {
    return false;
  }
}

/** 能調音量的播放元素（HTMLMediaElement 的子集，方便測試）。 */
export interface VolumeTarget {
  volume: number;
}

export class VoiceVolume {
  private value: number;
  private readonly targets = new Set<VolumeTarget>();
  private readonly listeners = new Set<(volume: number) => void>();

  constructor(private readonly storage: VolumeStorage | null = pageStorage()) {
    this.value = loadVoiceVolume(storage);
  }

  get current(): number {
    return this.value;
  }

  /** 播放元素開始播放時登記（立即套用目前音量）；回傳的函式在停止播放時呼叫。 */
  attach(target: VolumeTarget): () => void {
    this.targets.add(target);
    target.volume = this.value / 100;
    return () => this.targets.delete(target);
  }

  /** 依請求調整（語音工具與設定頁共用）：成功就套用到正在播的元素並保存。 */
  apply(request: VoiceVolumeRequest): VoiceVolumeOutcome {
    const outcome = nextVoiceVolume(this.value, request);
    if (outcome.ok) this.set(outcome.volume);
    return outcome;
  }

  set(volume: number): void {
    this.value = clampVoiceVolume(volume);
    for (const target of this.targets) target.volume = this.value / 100;
    saveVoiceVolume(this.value, this.storage);
    for (const listener of this.listeners) listener(this.value);
  }

  onChange(listener: (volume: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** 頁面共用的一份。 */
export const voiceVolume = new VoiceVolume();
