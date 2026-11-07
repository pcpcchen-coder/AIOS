// VOL-1（George 2026-11-07）：這台裝置上 Nous 說話的音量（對話音量），可以用說的調。
// 只調頁面播放 AI 語音的那個元素（HTMLMediaElement.volume），所以最大 100 就是系統音量，不能比系統更大聲；
// 不改系統音量、不碰收音、喚醒與提示音。每台裝置（Mac 主視窗、Pi 終端機）各自保存在頁面的 localStorage。

export const VOICE_VOLUME_MIN = 10;
export const VOICE_VOLUME_MAX = 100;
export const VOICE_VOLUME_DEFAULT = 100;
/** 「大聲一點／小聲一點」一次調多少。 */
export const VOICE_VOLUME_STEP = 20;

export type VoiceVolumeChange = "up" | "down" | "reset";

export interface VoiceVolumeRequest {
  /** 指定音量（10–100）；和 change 同時給時以 level 為準。 */
  level?: number | null;
  change?: VoiceVolumeChange | null;
  /** VOL-2：要調白天還是晚上的音量；沒給就是現在用的那一個。 */
  period?: "day" | "night" | null;
}

export type VoiceVolumeOutcome =
  | { ok: true; volume: number; previous: number; limit: "max" | "min" | null }
  | { ok: false; error: string };

export function clampVoiceVolume(value: number): number {
  if (!Number.isFinite(value)) return VOICE_VOLUME_DEFAULT;
  return Math.min(VOICE_VOLUME_MAX, Math.max(VOICE_VOLUME_MIN, Math.round(value)));
}

/** 從模型的參數（JSON 物件）讀出請求；讀不懂的欄位當作沒給。 */
export function parseVoiceVolumeArgs(args: Record<string, unknown>): VoiceVolumeRequest {
  const raw = args.level;
  const level = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const change = args.change === "up" || args.change === "down" || args.change === "reset" ? args.change : null;
  const period = args.period === "day" || args.period === "night" ? args.period : null;
  return { level, change, period };
}

/**
 * 算出新的音量（純函式）。limit：要求超出範圍、被夾到上限或下限時標出來，讓模型照實說「現在是最大／最小」。
 * 例：目前 100 說「大聲一點」→ 仍是 100、limit max；目前 90 說「大聲一點」→ 100、limit max；目前 20 說「小聲一點」→ 10、limit min（目前 30 → 10 剛好到下限，不標）。
 */
export function nextVoiceVolume(current: number, request: VoiceVolumeRequest, resetTo: number = VOICE_VOLUME_DEFAULT): VoiceVolumeOutcome {
  const previous = clampVoiceVolume(current);
  let wanted: number;
  if (typeof request.level === "number" && Number.isFinite(request.level)) wanted = request.level;
  else if (request.change === "up") wanted = previous + VOICE_VOLUME_STEP;
  else if (request.change === "down") wanted = previous - VOICE_VOLUME_STEP;
  else if (request.change === "reset") wanted = resetTo;
  else return { ok: false, error: "缺少音量：請給 level（10 到 100）或 change（up、down、reset）" };
  const volume = clampVoiceVolume(wanted);
  const limit = wanted > VOICE_VOLUME_MAX ? "max" : wanted < VOICE_VOLUME_MIN ? "min" : null;
  return { ok: true, volume, previous, limit };
}

/**
 * 交回模型的結果（兩條路徑相同）。VOL-2：context 說調的是白天還是晚上的音量、現在用的是哪一個；
 * 調的不是現在用的那一個時，note 說明要到那個時段才會用到。
 */
export function voiceVolumeOutput(outcome: VoiceVolumeOutcome, context?: { period: "day" | "night"; active: "day" | "night" }): Record<string, unknown> {
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const periodFields = context ? { period: context.period, in_use_now: context.period === context.active } : {};
  if (context && context.period !== context.active) {
    const note = context.period === "night" ? "調的是夜間音量；現在用的是日間音量，到夜間才會用到。" : "調的是日間音量；現在用的是夜間音量，到白天才會用到。";
    return { ok: true, status: "confirmed", volume: outcome.volume, previous: outcome.previous, ...periodFields, note };
  }
  const note =
    outcome.limit === "max"
      ? "現在是最大（等於這台裝置的系統音量）；要更大聲，請使用者調高系統或喇叭本身的音量。"
      : outcome.limit === "min"
        ? `現在是最小（${VOICE_VOLUME_MIN}）；Nous 的聲音不會調到完全靜音。`
        : null;
  return { ok: true, status: "confirmed", volume: outcome.volume, previous: outcome.previous, ...periodFields, ...(note ? { note } : {}) };
}
