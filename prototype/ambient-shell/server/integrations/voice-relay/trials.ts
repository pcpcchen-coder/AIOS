import { RELAY_SCHEMA_VERSION, type RelayTrial } from "../../../shared/voice-relay.ts";
import { ID, SHORT_ID } from "./catalog.ts";

// VCR-0（docs/experiments/VOICE_COMMAND_RELAY_TEST_PLAN.md §C）：試驗紀錄的驗證。統計公式在 shared/voice-relay.ts（summarizeTrials）。
// 規則：同一筆試驗的 commandOK 不能超過 wakeOK（沒有喚醒就一定是 NO_COMMAND）；negative 試驗沒有命令結果；不認得的欄位一律拒絕。

export type TrialsResult = { ok: true; trials: RelayTrial[] } | { ok: false; errors: string[] };

const KEYS = ["id", "targetId", "templateId", "templateVersion", "voiceProfileId", "at", "kind", "wake", "command", "evidence", "review"];
const ENUMS: Record<string, readonly string[]> = {
  kind: ["positive", "negative"],
  wake: ["WAKE_OK", "NO_WAKE", "UNKNOWN"],
  command: ["COMMAND_OK", "WRONG_COMMAND", "NO_COMMAND", "UNKNOWN"],
  evidence: ["visual", "human_confirmed", "device_state_api"],
  review: ["reviewed", "pending"],
};
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** 文件格式：{ schemaVersion: 1, trials: RelayTrial[] }。 */
export function parseTrials(raw: unknown): TrialsResult {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(raw)) return { ok: false, errors: ["$：必須是物件"] };
  for (const k of Object.keys(raw)) if (k !== "schemaVersion" && k !== "trials") errors.push(`$.${k.slice(0, 32)}：不認得的欄位`);
  if (raw.schemaVersion !== RELAY_SCHEMA_VERSION) errors.push("$.schemaVersion：必須是 1");
  if (!Array.isArray(raw.trials)) return { ok: false, errors: [...errors, "$.trials：必須是陣列"] };
  const ids = new Set<string>();
  raw.trials.forEach((t, i) => {
    const p = `$.trials[${i}]`;
    if (!isObj(t)) return void errors.push(`${p}：必須是物件`);
    for (const k of Object.keys(t)) if (!KEYS.includes(k)) errors.push(`${p}.${k.slice(0, 32)}：不認得的欄位`);
    // ID 用和目錄相同的格式（裝置表 ID 用短格式）。
    const PATTERNS: Record<string, RegExp> = { id: ID, targetId: SHORT_ID, templateId: ID, voiceProfileId: ID };
    for (const k of ["id", "targetId", "templateId", "voiceProfileId", "at"]) {
      const v = t[k];
      if (typeof v !== "string" || !v.length || v.length > 128 || CONTROL.test(v)) errors.push(`${p}.${k}：必須是非空字串`);
      else if (PATTERNS[k] && !PATTERNS[k].test(v)) errors.push(`${p}.${k}：格式不合法`);
    }
    if (typeof t.id === "string") {
      if (ids.has(t.id)) errors.push(`${p}.id：ID 重複`);
      ids.add(t.id);
    }
    if (typeof t.templateVersion !== "number" || !Number.isInteger(t.templateVersion) || t.templateVersion < 1) errors.push(`${p}.templateVersion：必須是正整數`);
    for (const [k, values] of Object.entries(ENUMS)) if (!values.includes(t[k] as string)) errors.push(`${p}.${k}：不在允許的值裡`);
    if (t.kind === "negative" && t.command !== "NO_COMMAND") errors.push(`${p}.command：negative 試驗必須是 NO_COMMAND`);
    if (t.kind === "positive" && t.wake !== "WAKE_OK" && t.command !== "NO_COMMAND") errors.push(`${p}.command：沒有喚醒時必須是 NO_COMMAND（commandOK 不能超過 wakeOK）`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, trials: raw.trials as RelayTrial[] };
}
