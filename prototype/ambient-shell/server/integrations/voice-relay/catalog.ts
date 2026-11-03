import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANTS,
  AUDIO_FORMATS,
  DOWNSTREAM_SERVICES,
  INTENT_IDS,
  MUSIC_SERVICES,
  PACK_SCOPES,
  RELAY_LOCALE,
  RELAY_SCHEMA_VERSION,
  SAMPLE_RATES,
  SLOT_NAMES,
  TEMPLATE_STATUSES,
  TEST_RESULTS,
  TTS_ENGINES,
  VENDORS,
  type CommandPack,
  type IntentDef,
  type RelayCatalog,
} from "../../../shared/voice-relay.ts";

// VCR-0（docs/19）：三層資料的驗證器（手寫，這就是 Schema；schemaVersion 1）。
// 每一層物件都拒絕不認得的鍵；錯誤訊息只有路徑與規則，不回顯值。驗證後的結果整個凍結。
// 交叉檢查：ID 唯一、意圖存在、佔位符與 slot 一致、slot 說法齊全、喚醒詞不能出現在命令裡、裝置表的參照都存在。

export type CatalogResult = { ok: true; catalog: RelayCatalog } | { ok: false; errors: string[] };

/** 一般 ID（命令包、模板、喚醒詞、聲線）：可含大寫語系段，例如 google.home_mini.zh-TW.v1。 */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** 裝置表、輸出節點、燈的 ID。 */
export const SHORT_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** 控制字元、換行，以及 Unicode 格式字元（零寬、雙向控制、BOM 等 \p{Cf}）。 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
export const TEXT_MAX = 120;
const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** 要播出的文字：非空、沒有控制字元或換行、≤120 字。 */
export function safeText(value: string): boolean {
  return value.trim().length > 0 && value.length <= TEXT_MAX && !CONTROL.test(value);
}

/** 比對用的正規化：NFKC、小寫、拿掉所有空白與格式字元（"OK  Google"、"ok\u200bgoogle" 都變成 "okgoogle"）。 */
export function normalizeSpoken(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{Cf}]+/gu, "");
}

/** 文字裡有沒有任何一個喚醒詞（正規化後比對）。 */
export function containsWakePhrase(text: string, wakePhrases: readonly string[]): boolean {
  const t = normalizeSpoken(text);
  return wakePhrases.some((w) => {
    const n = normalizeSpoken(w);
    return n.length > 0 && t.includes(n);
  });
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

type Obj = Record<string, unknown>;

class Checker {
  readonly errors: string[] = [];
  err(path: string, rule: string): void {
    if (this.errors.length < 200) this.errors.push(`${path}：${rule}`);
  }
  /** 物件：必填鍵都在、沒有不認得的鍵。 */
  obj(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) return this.err(path, "必須是物件"), null;
    const o = v as Obj;
    for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) this.err(`${path}.${k.slice(0, 32)}`, "不認得的欄位");
    for (const k of required) if (o[k] === undefined) this.err(`${path}.${k}`, "缺少");
    return o;
  }
  arr(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) return this.err(path, "必須是陣列"), [];
    return v;
  }
  str(v: unknown, path: string, pattern?: RegExp, max = 128): boolean {
    if (typeof v !== "string" || !v.length || v.length > max || CONTROL.test(v)) return this.err(path, "必須是非空字串（無控制字元）"), false;
    if (pattern && !pattern.test(v)) return this.err(path, "格式不合法"), false;
    return true;
  }
  text(v: unknown, path: string): boolean {
    if (typeof v !== "string" || !safeText(v)) return this.err(path, `必須是 1–${TEXT_MAX} 字、沒有控制字元或換行的文字`), false;
    return true;
  }
  optStr(v: unknown, path: string, pattern?: RegExp, max?: number): void {
    if (v !== undefined) this.str(v, path, pattern, max);
  }
  nullableStr(v: unknown, path: string): void {
    if (v !== null) this.str(v, path);
  }
  oneOf(v: unknown, path: string, values: readonly unknown[]): boolean {
    if (!values.includes(v)) return this.err(path, "不在允許的值裡"), false;
    return true;
  }
  bool(v: unknown, path: string): void {
    if (typeof v !== "boolean") this.err(path, "必須是 true 或 false");
  }
  optBool(v: unknown, path: string): void {
    if (v !== undefined) this.bool(v, path);
  }
  int(v: unknown, path: string, min: number, max: number): boolean {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return this.err(path, `必須是 ${min}–${max} 的整數`), false;
    return true;
  }
  num(v: unknown, path: string, min: number, max: number): void {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) this.err(path, `必須是 ${min}–${max} 的數字`);
  }
  unique(ids: string[], path: string): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) this.err(path, "ID 重複");
      seen.add(id);
    }
  }
}

/** 驗證整份目錄（意圖、命令包、聲線、預設聲線、裝置表）。不丟錯；失敗回錯誤清單。 */
export function parseRelayCatalog(raw: unknown): CatalogResult {
  const c = new Checker();
  const root = c.obj(raw, "$", ["schemaVersion", "catalogVersion", "intents", "packs", "profiles", "voiceDefaults", "targets"]);
  if (!root) return { ok: false, errors: c.errors };
  if (root.schemaVersion !== RELAY_SCHEMA_VERSION) c.err("$.schemaVersion", "必須是 1");
  c.int(root.catalogVersion, "$.catalogVersion", 1, 1_000_000);

  // 意圖
  const intents = new Map<string, IntentDef>();
  c.arr(root.intents, "$.intents").forEach((raw, i) => {
    const p = `$.intents[${i}]`;
    const o = c.obj(raw, p, ["id", "riskClass", "category", "slots"]);
    if (!o) return;
    c.oneOf(o.id, `${p}.id`, INTENT_IDS);
    c.oneOf(o.riskClass, `${p}.riskClass`, ["low", "high"]);
    c.oneOf(o.category, `${p}.category`, ["music", "volume", "light", "timer"]);
    const slots = c.obj(o.slots, `${p}.slots`, [], SLOT_NAMES);
    if (slots) for (const [name, def] of Object.entries(slots)) checkSlot(c, def, `${p}.slots.${name}`);
    if (typeof o.id === "string") {
      if (intents.has(o.id)) c.err(`${p}.id`, "ID 重複");
      intents.set(o.id, o as unknown as IntentDef);
    }
  });

  // 命令包
  const packs: CommandPack[] = [];
  const templateIds = new Map<string, { intentId: string; pack: Obj }>();
  /** 喚醒詞 ID → 所屬命令包（裝置表的 wakePhraseId 要對得上品牌、助理、語系）。 */
  const wakeIds = new Map<string, Obj>();
  const allWakes: string[] = [];
  /** 最後才檢查（要等所有命令包的喚醒詞都收齊）：會被播出的文字不能含任何喚醒詞。 */
  const spoken: { path: string; text: string }[] = [];
  c.arr(root.packs, "$.packs").forEach((raw, i) => {
    const p = `$.packs[${i}]`;
    const o = c.obj(raw, p, ["id", "version", "scope", "locale", "wakePhrases", "entries"], ["vendor", "assistant", "model", "compatibleAssistants"]);
    if (!o) return;
    c.str(o.id, `${p}.id`, ID);
    c.int(o.version, `${p}.version`, 1, 1_000_000);
    const scopeOk = c.oneOf(o.scope, `${p}.scope`, PACK_SCOPES);
    c.str(o.locale, `${p}.locale`, RELAY_LOCALE, 8);
    const NEED: Record<string, readonly string[]> = { model: ["vendor", "assistant", "model"], assistant: ["vendor", "assistant"], vendor: ["vendor"], generic: [] };
    const need = scopeOk && Object.hasOwn(NEED, o.scope as string) ? NEED[o.scope as string]! : ["vendor", "assistant", "model"];
    for (const k of ["vendor", "assistant", "model"]) {
      if (need.includes(k) && o[k] === undefined) c.err(`${p}.${k}`, `scope ${String(o.scope)} 必須有`);
      if (!need.includes(k) && o[k] !== undefined) c.err(`${p}.${k}`, `scope ${String(o.scope)} 不能有`);
    }
    if (o.vendor !== undefined) c.oneOf(o.vendor, `${p}.vendor`, VENDORS);
    if (o.assistant !== undefined) c.oneOf(o.assistant, `${p}.assistant`, ASSISTANTS);
    c.optStr(o.model, `${p}.model`, SHORT_ID);
    if (o.scope === "generic") {
      const list = c.arr(o.compatibleAssistants, `${p}.compatibleAssistants`);
      if (!list.length) c.err(`${p}.compatibleAssistants`, "generic 必須列出至少一個助理");
      list.forEach((a, j) => c.oneOf(a, `${p}.compatibleAssistants[${j}]`, ASSISTANTS));
    } else if (o.compatibleAssistants !== undefined) c.err(`${p}.compatibleAssistants`, "只有 generic 可以有");

    const wakes = c.arr(o.wakePhrases, `${p}.wakePhrases`);
    let selectedWakes = 0;
    wakes.forEach((raw, j) => {
      const wp = `${p}.wakePhrases[${j}]`;
      const w = c.obj(raw, wp, ["id", "text", "selected"]);
      if (!w) return;
      if (c.str(w.id, `${wp}.id`, ID)) {
        if (wakeIds.has(w.id as string)) c.err(`${wp}.id`, "ID 重複");
        wakeIds.set(w.id as string, o);
      }
      if (c.text(w.text, `${wp}.text`)) allWakes.push(w.text as string);
      c.bool(w.selected, `${wp}.selected`);
      if (w.selected === true) selectedWakes++;
    });
    if (wakes.length && selectedWakes !== 1) c.err(`${p}.wakePhrases`, "必須剛好選定一個喚醒詞");

    const selectedPerIntent = new Set<string>();
    c.arr(o.entries, `${p}.entries`).forEach((raw, j) => {
      const ep = `${p}.entries[${j}]`;
      const e = c.obj(raw, ep, ["templateId", "version", "intentId", "utteranceTemplate", "selected", "supported", "status", "downstreamService", "source", "testedOn", "testResult"], ["slotText"]);
      if (!e) return;
      if (c.str(e.templateId, `${ep}.templateId`, ID)) {
        if (templateIds.has(e.templateId as string)) c.err(`${ep}.templateId`, "ID 重複");
        templateIds.set(e.templateId as string, { intentId: String(e.intentId), pack: o });
      }
      c.int(e.version, `${ep}.version`, 1, 1_000_000);
      const intent = typeof e.intentId === "string" ? intents.get(e.intentId) : undefined;
      if (!intent) c.err(`${ep}.intentId`, "不是目錄裡的意圖");
      c.bool(e.selected, `${ep}.selected`);
      c.bool(e.supported, `${ep}.supported`);
      c.oneOf(e.status, `${ep}.status`, TEMPLATE_STATUSES);
      c.oneOf(e.downstreamService, `${ep}.downstreamService`, DOWNSTREAM_SERVICES);
      c.str(e.source, `${ep}.source`, undefined, 200);
      c.nullableStr(e.testedOn, `${ep}.testedOn`);
      c.oneOf(e.testResult, `${ep}.testResult`, TEST_RESULTS);
      if (e.selected === true && typeof e.intentId === "string") {
        if (selectedPerIntent.has(e.intentId)) c.err(`${ep}.selected`, "同一個命令包裡同一個意圖只能選定一個模板");
        selectedPerIntent.add(e.intentId);
      }
      if (!c.text(e.utteranceTemplate, `${ep}.utteranceTemplate`) || !intent) return;
      const template = e.utteranceTemplate as string;
      spoken.push({ path: `${ep}.utteranceTemplate`, text: template });
      if (/[{}]/.test(template.replace(PLACEHOLDER, ""))) c.err(`${ep}.utteranceTemplate`, "大括號只能用在 {slot}");
      const used = placeholders(template);
      const slots = Object.keys(intent.slots ?? {});
      for (const name of used) if (!slots.includes(name)) c.err(`${ep}.utteranceTemplate`, `佔位符 ${name.slice(0, 16)} 不是意圖的 slot`);
      for (const name of slots) if (!used.includes(name)) c.err(`${ep}.utteranceTemplate`, `沒有用到 slot ${name}`);
      const slotText = e.slotText === undefined ? {} : c.obj(e.slotText, `${ep}.slotText`, [], SLOT_NAMES);
      if (!slotText) return;
      for (const name of slots) {
        const def = (intent.slots as Record<string, { kind?: string; values?: unknown }>)[name]!;
        const values = def.kind === "enum" && Array.isArray(def.values) ? def.values.map(String) : def.kind === "boolean" ? ["true", "false"] : null;
        if (!values) {
          if (slotText[name] !== undefined) c.err(`${ep}.slotText.${name}`, "這個 slot 不用說法表");
          continue;
        }
        const words = c.obj(slotText[name], `${ep}.slotText.${name}`, values);
        if (words) for (const v of values) if (words[v] !== undefined && c.text(words[v], `${ep}.slotText.${name}.${v}`)) spoken.push({ path: `${ep}.slotText.${name}.${v}`, text: words[v] as string });
      }
      for (const name of Object.keys(slotText)) if (!slots.includes(name)) c.err(`${ep}.slotText.${name}`, "不是意圖的 slot");
    });
    packs.push(o as unknown as CommandPack);
  });
  c.unique(packs.map((pk) => String(pk.id)), "$.packs");

  // 聲線
  const profiles = new Map<string, Obj>();
  c.arr(root.profiles, "$.profiles").forEach((raw, i) => {
    const p = `$.profiles[${i}]`;
    const o = c.obj(raw, p, ["id", "engine", "voiceId", "locale", "rate", "pitch", "gainDb", "wakeToCommandPauseMs", "leadSilenceMs", "tailSilenceMs", "testedAt", "recognitionStatsId"], ["modelId", "modelVersion", "outputSampleRateHz", "format", "outputNode", "outputDeviceId", "fixture"]);
    if (!o) return;
    if (c.str(o.id, `${p}.id`, ID)) {
      if (profiles.has(o.id as string)) c.err(`${p}.id`, "ID 重複");
      profiles.set(o.id as string, o);
    }
    c.oneOf(o.engine, `${p}.engine`, TTS_ENGINES);
    c.text(o.voiceId, `${p}.voiceId`);
    c.optStr(o.modelId, `${p}.modelId`);
    c.optStr(o.modelVersion, `${p}.modelVersion`);
    c.str(o.locale, `${p}.locale`, RELAY_LOCALE, 8);
    c.num(o.rate, `${p}.rate`, 0.5, 2);
    c.num(o.pitch, `${p}.pitch`, -12, 12);
    c.num(o.gainDb, `${p}.gainDb`, -30, 6);
    c.int(o.wakeToCommandPauseMs, `${p}.wakeToCommandPauseMs`, 0, 5000);
    c.int(o.leadSilenceMs, `${p}.leadSilenceMs`, 0, 3000);
    c.int(o.tailSilenceMs, `${p}.tailSilenceMs`, 0, 3000);
    if (o.outputSampleRateHz !== undefined) c.oneOf(o.outputSampleRateHz, `${p}.outputSampleRateHz`, SAMPLE_RATES);
    if (o.format !== undefined) c.oneOf(o.format, `${p}.format`, AUDIO_FORMATS);
    c.optStr(o.outputNode, `${p}.outputNode`, SHORT_ID);
    c.optStr(o.outputDeviceId, `${p}.outputDeviceId`);
    c.nullableStr(o.testedAt, `${p}.testedAt`);
    c.nullableStr(o.recognitionStatsId, `${p}.recognitionStatsId`);
    c.optBool(o.fixture, `${p}.fixture`);
  });

  // 預設聲線
  const defaultKeys = new Set<string>();
  c.arr(root.voiceDefaults, "$.voiceDefaults").forEach((raw, i) => {
    const p = `$.voiceDefaults[${i}]`;
    const o = c.obj(raw, p, ["vendor", "assistant", "locale", "voiceProfileId"], ["model"]);
    if (!o) return;
    c.oneOf(o.vendor, `${p}.vendor`, VENDORS);
    c.oneOf(o.assistant, `${p}.assistant`, ASSISTANTS);
    c.optStr(o.model, `${p}.model`, SHORT_ID);
    c.str(o.locale, `${p}.locale`, RELAY_LOCALE, 8);
    const key = `${String(o.vendor)}|${String(o.assistant)}|${String(o.model ?? "")}|${String(o.locale)}`;
    if (defaultKeys.has(key)) c.err(p, "同一組品牌／助理／型號／語系只能有一個預設聲線");
    defaultKeys.add(key);
    const profile = typeof o.voiceProfileId === "string" ? profiles.get(o.voiceProfileId) : undefined;
    if (!profile) c.err(`${p}.voiceProfileId`, "沒有這個聲線");
    else if (profile.locale !== o.locale) c.err(`${p}.voiceProfileId`, "聲線語系與預設的語系不同");
  });

  // 裝置表
  const targetIds = new Set<string>();
  c.arr(root.targets, "$.targets").forEach((raw, i) => {
    const p = `$.targets[${i}]`;
    const o = c.obj(raw, p, ["id", "vendor", "assistant", "model", "locale", "enabled", "outputNode", "outputDeviceId", "candidateVoiceProfileIds", "templateOverrides", "reviewedTemplates", "musicService", "devices"], ["voiceProfileId", "wakePhraseId", "fixture"]);
    if (!o) return;
    if (c.str(o.id, `${p}.id`, SHORT_ID)) {
      if (targetIds.has(o.id as string)) c.err(`${p}.id`, "ID 重複");
      targetIds.add(o.id as string);
    }
    c.oneOf(o.vendor, `${p}.vendor`, VENDORS);
    c.oneOf(o.assistant, `${p}.assistant`, ASSISTANTS);
    c.str(o.model, `${p}.model`, SHORT_ID);
    c.str(o.locale, `${p}.locale`, RELAY_LOCALE, 8);
    c.bool(o.enabled, `${p}.enabled`);
    c.str(o.outputNode, `${p}.outputNode`, SHORT_ID);
    c.str(o.outputDeviceId, `${p}.outputDeviceId`);
    if (o.voiceProfileId !== undefined && !(typeof o.voiceProfileId === "string" && profiles.has(o.voiceProfileId))) c.err(`${p}.voiceProfileId`, "沒有這個聲線");
    c.arr(o.candidateVoiceProfileIds, `${p}.candidateVoiceProfileIds`).forEach((id, j) => {
      if (!(typeof id === "string" && profiles.has(id))) c.err(`${p}.candidateVoiceProfileIds[${j}]`, "沒有這個聲線");
    });
    if (o.wakePhraseId !== undefined) {
      const owner = typeof o.wakePhraseId === "string" ? wakeIds.get(o.wakePhraseId) : undefined;
      if (!owner) c.err(`${p}.wakePhraseId`, "沒有這個喚醒詞");
      else if (owner.vendor !== o.vendor || owner.assistant !== o.assistant || owner.locale !== o.locale) c.err(`${p}.wakePhraseId`, "喚醒詞的品牌、助理或語系與目標不同");
    }
    const overrides = c.obj(o.templateOverrides, `${p}.templateOverrides`, [], INTENT_IDS);
    if (overrides) {
      for (const [intentId, templateId] of Object.entries(overrides)) {
        const found = typeof templateId === "string" ? templateIds.get(templateId) : undefined;
        if (!found) c.err(`${p}.templateOverrides.${intentId}`, "沒有這個模板");
        else if (found.intentId !== intentId) c.err(`${p}.templateOverrides.${intentId}`, "模板屬於別的意圖");
      }
    }
    c.arr(o.reviewedTemplates, `${p}.reviewedTemplates`).forEach((raw, j) => {
      const rp = `${p}.reviewedTemplates[${j}]`;
      const r = c.obj(raw, rp, ["templateId", "version", "status", "reviewedAt"], ["note"]);
      if (!r) return;
      c.str(r.templateId, `${rp}.templateId`, ID);
      c.int(r.version, `${rp}.version`, 1, 1_000_000);
      c.oneOf(r.status, `${rp}.status`, ["approved", "rejected"]);
      c.str(r.reviewedAt, `${rp}.reviewedAt`, undefined, 64);
      c.optStr(r.note, `${rp}.note`, undefined, 200);
    });
    c.oneOf(o.musicService, `${p}.musicService`, MUSIC_SERVICES);
    const deviceIds: string[] = [];
    c.arr(o.devices, `${p}.devices`).forEach((raw, j) => {
      const dp = `${p}.devices[${j}]`;
      const d = c.obj(raw, dp, ["id", "kind", "name"]);
      if (!d) return;
      if (c.str(d.id, `${dp}.id`, SHORT_ID)) deviceIds.push(d.id as string);
      c.oneOf(d.kind, `${dp}.kind`, ["light"]);
      if (c.text(d.name, `${dp}.name`)) spoken.push({ path: `${dp}.name`, text: d.name as string });
    });
    c.unique(deviceIds, `${p}.devices`);
    c.optBool(o.fixture, `${p}.fixture`);
  });

  for (const { path, text } of spoken) if (containsWakePhrase(text, allWakes)) c.err(path, "會播出的文字不能含喚醒詞");

  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, catalog: deepFreeze(structuredClone(raw) as RelayCatalog) };
}

function checkSlot(c: Checker, raw: unknown, p: string): void {
  const kind = raw && typeof raw === "object" ? (raw as Obj).kind : undefined;
  if (kind === "enum") {
    const o = c.obj(raw, p, ["kind", "values", "required"]);
    const values = c.arr(o?.values, `${p}.values`);
    if (!values.length) c.err(`${p}.values`, "不能是空的");
    values.forEach((v, i) => c.str(v, `${p}.values[${i}]`, SHORT_ID));
    c.unique(values.map(String), `${p}.values`);
    if (o?.required !== true) c.err(`${p}.required`, "V1 的 slot 一律必填");
  } else if (kind === "boolean") {
    const o = c.obj(raw, p, ["kind", "required"]);
    if (o?.required !== true) c.err(`${p}.required`, "V1 的 slot 一律必填");
  } else if (kind === "integer") {
    const o = c.obj(raw, p, ["kind", "min", "max", "required"]);
    if (!o) return;
    const okMin = c.int(o.min, `${p}.min`, -1_000_000, 1_000_000);
    const okMax = c.int(o.max, `${p}.max`, -1_000_000, 1_000_000);
    if (okMin && okMax && (o.min as number) > (o.max as number)) c.err(p, "min 不能大於 max");
    if (o.required !== true) c.err(`${p}.required`, "V1 的 slot 一律必填");
  } else if (kind === "device") {
    const o = c.obj(raw, p, ["kind", "deviceKind", "required"]);
    c.oneOf(o?.deviceKind, `${p}.deviceKind`, ["light"]);
    if (o?.required !== true) c.err(`${p}.required`, "V1 的 slot 一律必填");
  } else c.err(`${p}.kind`, "不在允許的值裡");
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---- 使用者設定檔（<configDir>/voice-relay/config.json） ----

export interface RelayUserConfig {
  targets?: unknown[];
  voiceProfiles?: unknown[];
  voiceDefaults?: unknown[];
  commandPacks?: unknown[];
}

export type UserConfigRead = { ok: true; config: RelayUserConfig | null } | { ok: false; errors: string[] };

/** 讀使用者設定檔；不存在回 null（用內建示範資料）；壞掉或有不認得的欄位回錯誤（fail closed）。路徑只來自核心設定，不來自模型。 */
export function readRelayUserConfig(dir: string): UserConfigRead {
  let text: string;
  try {
    text = readFileSync(join(dir, "config.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: null };
    return { ok: false, errors: ["config.json：無法讀取"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["config.json：不是 JSON"] };
  }
  const c = new Checker();
  const o = c.obj(raw, "config.json", ["schemaVersion"], ["targets", "voiceProfiles", "voiceDefaults", "commandPacks"]);
  if (o && o.schemaVersion !== RELAY_SCHEMA_VERSION) c.err("config.json.schemaVersion", "必須是 1");
  if (o) for (const k of ["targets", "voiceProfiles", "voiceDefaults", "commandPacks"]) if (o[k] !== undefined) c.arr(o[k], `config.json.${k}`);
  if (c.errors.length || !o) return { ok: false, errors: c.errors };
  return { ok: true, config: { targets: o.targets as unknown[] | undefined, voiceProfiles: o.voiceProfiles as unknown[] | undefined, voiceDefaults: o.voiceDefaults as unknown[] | undefined, commandPacks: o.commandPacks as unknown[] | undefined } };
}
