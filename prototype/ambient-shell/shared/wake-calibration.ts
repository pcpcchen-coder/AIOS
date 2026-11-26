// 「矯正喚醒詞…」（George 2026-11-01）的純邏輯：提示清單、候選門檻、計分與建議。畫面在 src/wake-calibration-view.ts，
// 錄音與比較在喚醒 worker（src/audio/calibration-core.ts；音訊只在 worker 記憶體，結束或取消時以 0 覆寫）。
// 做法照 2026-11-01 George 在 Mac 用 wk00.sh 調門檻的流程：每次提示錄一段，事後用同一段音訊、產品的偵測器
// 掃幾組提升分數／門檻，選「正例最多，而且不該叫醒的句子是 0」的那組（docs/validation/wk-00-mac-2026-10-31.md）。

import manifest from "./wake-runtime.json" with { type: "json" };
import { wakeKeywordDefaults, wakeKeywordGroup, type WakeKeywordOverrides, type WakeKeywordTuning, type WakeRuntimeManifest, type WakeSweepCandidate } from "./wake.ts";

export const WAKE_MANIFEST = manifest as WakeRuntimeManifest;

/** 一次提示：念什麼、算哪一類。group 是正例對應的關鍵詞組；不該叫醒的句子是 null。 */
export interface CalibrationPrompt {
  say: string;
  kind: "positive" | "negative";
  group: string | null;
}

/** 不該叫醒的句子（WK-00 的 Hey 三行測試用的五句；只說招呼語、相近的發音）。 */
export const NEGATIVE_PHRASES = ["Hey", "Hello", "Hey, no", "They know us", "Hey nurse"] as const;

/** Hey Nous 約 10 次、Hello Nous 約 5 次，再加上每句不該叫醒的話一次（共 20 次，約 3 分鐘）。 */
export const CALIBRATION_PROMPTS: readonly CalibrationPrompt[] = [
  ...Array.from({ length: 10 }, (): CalibrationPrompt => ({ say: "Hey Nous", kind: "positive", group: "HEY_NOUS" })),
  ...Array.from({ length: 5 }, (): CalibrationPrompt => ({ say: "Hello Nous", kind: "positive", group: "HELLO_NOUS" })),
  ...NEGATIVE_PHRASES.map((say): CalibrationPrompt => ({ say, kind: "negative", group: null })),
];

/** 每次提示：叮一聲之後錄這麼久（WK-00 腳本用 6 秒視窗；念一句喚醒詞加上反應時間 5 秒夠用）。 */
export const PROMPT_WINDOW_MS = 5000;
/** 每段念完後顯示結果多久，再自動到下一句。 */
export const RESULT_PAUSE_MS = 1200;

/** 門檻在預設值上下各掃兩格（每格 0.05）；提升分數維持預設。Hey 三行（預設 0.25）因此是 0.15–0.35。 */
export const THRESHOLD_STEP = 0.05;
export const THRESHOLD_SPAN = 2;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const same = (a: WakeKeywordTuning, b: WakeKeywordTuning): boolean => round2(a.boost) === round2(b.boost) && round2(a.threshold) === round2(b.threshold);

/** 清單上每一組的預設值（出貨的 shared/wake-runtime.json）。 */
export function groupDefaults(m: WakeRuntimeManifest = WAKE_MANIFEST): { group: string; boost: number; threshold: number }[] {
  return wakeKeywordDefaults(m.keywords);
}

/** 目前生效的值：有矯正值用矯正值，否則清單預設。 */
export function currentTuning(group: string, overrides: WakeKeywordOverrides | null, m: WakeRuntimeManifest = WAKE_MANIFEST): WakeKeywordTuning | null {
  const own = overrides?.groups[group];
  if (own) return own;
  const d = groupDefaults(m).find((g) => g.group === group);
  return d ? { boost: d.boost, threshold: d.threshold } : null;
}

/**
 * 要比較的候選：每一組在預設門檻上下各兩格（0.05 一格，限在 0.05–0.5），目前的矯正值不在格子上時也加進去。
 * 依組、門檻由低到高排列。
 */
export function sweepCandidates(overrides: WakeKeywordOverrides | null, m: WakeRuntimeManifest = WAKE_MANIFEST): WakeSweepCandidate[] {
  const out: WakeSweepCandidate[] = [];
  for (const d of groupDefaults(m)) {
    const list: WakeSweepCandidate[] = [];
    for (let i = -THRESHOLD_SPAN; i <= THRESHOLD_SPAN; i++) {
      const threshold = round2(d.threshold + i * THRESHOLD_STEP);
      if (threshold >= 0.05 && threshold <= 0.5) list.push({ group: d.group, boost: d.boost, threshold });
    }
    const own = overrides?.groups[d.group];
    if (own && !list.some((c) => same(c, own))) list.push({ group: d.group, boost: own.boost, threshold: own.threshold });
    list.sort((a, b) => a.threshold - b.threshold || a.boost - b.boost);
    out.push(...list);
  }
  return out;
}

/** 一段錄音的結果：提示編號與（目前設定下）偵測到的清單編號，-1＝沒有。 */
export interface ClipResult {
  prompt: number;
  keyword_index: number;
}

/** 一個候選的成績：該組正例命中幾次（共幾次）、不該叫醒的句子觸發幾次（共幾句）。 */
export interface CandidateScore extends WakeSweepCandidate {
  hits: number;
  positives: number;
  false_wakes: number;
  negatives: number;
  /** 這組有沒有每段都掃完（中途取消時是 false，不拿來建議）。 */
  complete: boolean;
}

/**
 * 候選的成績。scans[candidate][clip] 是候選掃那一段的清單編號（-1＝沒有，undefined＝沒掃）。
 * 正例只算這組自己的提示（Hey Nous 的段落只看 Hey 三行）；不該叫醒的句子每組都要是 0（任何一行命中就算叫醒）。
 */
export function scoreCandidates(candidates: readonly WakeSweepCandidate[], clips: readonly ClipResult[], scans: readonly (readonly (number | undefined)[])[], prompts: readonly CalibrationPrompt[] = CALIBRATION_PROMPTS): CandidateScore[] {
  return candidates.map((c, ci) => {
    let hits = 0, positives = 0, falseWakes = 0, negatives = 0, complete = true;
    clips.forEach((clip, k) => {
      const prompt = prompts[clip.prompt];
      if (!prompt) return;
      const counts = prompt.kind === "negative" || prompt.group === c.group;
      if (!counts) return;
      const hit = scans[ci]?.[k];
      if (hit === undefined) complete = false;
      if (prompt.kind === "negative") {
        negatives++;
        if (hit !== undefined && hit >= 0) falseWakes++;
      } else {
        positives++;
        if (hit !== undefined && hit >= 0) hits++;
      }
    });
    return { ...c, hits, positives, false_wakes: falseWakes, negatives, complete };
  });
}

/** 目前設定下（錄音當下顯示的結果）每一類的成績。 */
export function currentSummary(clips: readonly ClipResult[], prompts: readonly CalibrationPrompt[] = CALIBRATION_PROMPTS): { group: string | null; say: string; hits: number; total: number }[] {
  const rows: { group: string | null; say: string; hits: number; total: number }[] = [];
  for (const clip of clips) {
    const p = prompts[clip.prompt];
    if (!p) continue;
    const key = p.kind === "negative" ? null : p.group;
    let row = rows.find((r) => r.group === key);
    if (!row) rows.push((row = { group: key, say: p.kind === "negative" ? "" : p.say, hits: 0, total: 0 }));
    row.total++;
    if (clip.keyword_index >= 0) row.hits++;
  }
  return rows;
}

export type GroupAdvice =
  /** 有建議值（可能和目前一樣）。 */
  | { group: string; status: "ok"; pick: CandidateScore; current: WakeKeywordTuning; changed: boolean }
  /** 每個候選都會被不該叫醒的句子觸發：不建議改，保留目前的值。 */
  | { group: string; status: "all_false_wake"; current: WakeKeywordTuning }
  /** 沒有任何候選認得這組（或這組沒錄到）：不建議改。 */
  | { group: string; status: "no_hits" | "not_measured"; current: WakeKeywordTuning };

/**
 * 每一組的建議：在「不該叫醒的句子 0 次」的候選中選正例最多的；一樣多時選門檻較高（較不容易誤叫醒）、再選提升分數較低的。
 * 沒有任何候選做得到 0 次，或最好的也一次都沒認出時，不建議改。
 */
export function recommend(scores: readonly CandidateScore[], overrides: WakeKeywordOverrides | null, m: WakeRuntimeManifest = WAKE_MANIFEST): GroupAdvice[] {
  return groupDefaults(m).map(({ group }) => {
    const current = currentTuning(group, overrides, m)!;
    const mine = scores.filter((s) => s.group === group && s.complete && s.positives > 0);
    if (mine.length === 0) return { group, status: "not_measured", current };
    const clean = mine.filter((s) => s.false_wakes === 0);
    if (clean.length === 0) return { group, status: "all_false_wake", current };
    const pick = [...clean].sort((a, b) => b.hits - a.hits || b.threshold - a.threshold || a.boost - b.boost)[0]!;
    if (pick.hits === 0) return { group, status: "no_hits", current };
    return { group, status: "ok", pick, current, changed: !same(pick, current) };
  });
}

/**
 * 套用建議後要保存的 keyword_overrides：和清單預設一樣的組不列；全部都和預設一樣時回 null（等於回復預設）。
 * 沒有建議的組保留原本的矯正值。
 */
export function overridesFromAdvice(advice: readonly GroupAdvice[], code: string, previous: WakeKeywordOverrides | null, m: WakeRuntimeManifest = WAKE_MANIFEST): WakeKeywordOverrides | null {
  const defaults = groupDefaults(m);
  const groups: Record<string, WakeKeywordTuning> = {};
  for (const a of advice) {
    const tuning = a.status === "ok" ? { boost: a.pick.boost, threshold: a.pick.threshold } : previous?.groups[a.group];
    const d = defaults.find((x) => x.group === a.group);
    if (tuning && d && !same(tuning, d)) groups[a.group] = { boost: round2(tuning.boost), threshold: round2(tuning.threshold) };
  }
  return Object.keys(groups).length === 0 ? null : { groups, code, at: null };
}

/** 有沒有任何一組的建議和目前不同（「套用」按鈕是否有意義）。 */
export function adviceChanges(advice: readonly GroupAdvice[]): boolean {
  return advice.some((a) => a.status === "ok" && a.changed);
}

/** 介面上的組名（清單 id → 念法）。 */
export function groupLabel(group: string): string {
  return group === "HEY_NOUS" ? "Hey Nous" : group === "HELLO_NOUS" ? "Hello Nous" : group;
}

/** 清單編號 → 組（顯示「由哪一組認出」用）。 */
export function groupOfIndex(index: number, m: WakeRuntimeManifest = WAKE_MANIFEST): string | null {
  const e = m.keywords.entries[index];
  return e ? wakeKeywordGroup(e.id) : null;
}
