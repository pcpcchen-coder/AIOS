import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_SCHEMA_VERSION, summarizeTrials, type IntentId, type MusicService, type RelayCatalog, type RelayTrial, type ReviewedTemplate, type Target, type TrialSummary, type VoiceProfile, type VoiceRelayMode } from "../../../shared/voice-relay.ts";
import { BUILTIN_PROFILES, composeRelayDocument } from "./builtin.ts";
import { parseRelayCatalog, readRelayUserConfig, SHORT_ID, type RelayUserConfig } from "./catalog.ts";
import { relayPolicy } from "./policy.ts";
import { levelDefault, packLevel } from "./resolver.ts";
import { parseTrials } from "./trials.ts";

// VCR-2：設定頁「語音中繼（實驗）」的寫入端。只改 <configDir>/voice-relay/config.json 與 trials.json（原子寫入，0600；目錄 0700）。
// 每次修改：讀目前的使用者設定 → 套用 → 先用 parseRelayCatalog 驗證組好的整份目錄 → 通過才寫檔 → 通知 Adapter 換目錄。
// 只能改使用者設定檔裡的目標與聲線；內建示範資料（fixture）不能改。錯誤訊息固定，不回顯輸入的值。

export class VoiceRelayStoreError extends Error {
  constructor(readonly status: number, message: string, readonly errors: readonly string[] = []) {
    super(message);
  }
}

export const STORE_INVALID = "語音中繼設定不正確，沒有儲存。";
const NO_TARGET = "沒有這個語音中繼目標，沒有儲存。";
const FIXTURE_TARGET = "內建示範目標不能修改；請先新增自己的目標。";
const BAD_TEMPLATE = "這個命令說法不能用在這個目標，沒有儲存。";
const BAD_PROFILE = "這個聲線不能用在這個目標，沒有儲存。";
const BAD_VOICE = "輸出端沒有這個語言的這個聲音，沒有儲存。";
const FILE_BROKEN = "語音中繼設定檔無法讀取，沒有儲存。";
const TRIALS_BROKEN = "試驗紀錄檔不正確，沒有儲存。";

export interface CreateTargetInput {
  id?: string;
  locale: "zh-TW" | "en-US";
  output_device_id: string;
  voice_id: string;
  music_service: MusicService;
}
export interface UpsertProfileInput {
  target_id: string;
  id?: string;
  voice_id: string;
  rate: number;
  gain_db: number;
  pause_ms: number;
  lead_ms: number;
  tail_ms: number;
}
export interface AdoptInput {
  target_id: string;
  intent_id: IntentId;
  template_id: string;
  template_version: number;
  voice_profile_id: string;
}
export interface UnadoptInput {
  target_id: string;
  template_id: string;
  template_version: number;
}
export interface TrialInput {
  target_id: string;
  template_id: string;
  template_version: number;
  voice_profile_id: string;
  kind: RelayTrial["kind"];
  wake: RelayTrial["wake"];
  command: RelayTrial["command"];
  evidence: RelayTrial["evidence"];
}

export interface VoiceRelayStoreOptions {
  mode: VoiceRelayMode;
  now?: () => Date;
  /** 輸出端目前讀到的聲音（建立或修改聲線時，聲音必須在清單裡、語系相同）。 */
  voices?: () => readonly { id: string; locale: string }[];
  /** 寫檔成功後呼叫（Adapter.reload）。 */
  onChange?: (catalog: RelayCatalog) => void;
}

type MutableTarget = { -readonly [K in keyof Target]: Target[K] extends readonly (infer U)[] ? U[] : Target[K] } & { templateOverrides: Partial<Record<IntentId, string>> };
type UserDoc = { schemaVersion: 1; targets: MutableTarget[]; voiceProfiles: VoiceProfile[]; voiceDefaults?: unknown[]; commandPacks?: unknown[] };

const BUILTIN_PROFILE_IDS = new Set(BUILTIN_PROFILES.map((p) => p.id));

/** 把 JSON 原子寫進檔案：先寫暫存檔（0600）再 rename。 */
function writeAtomic(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "voice";
}

export class VoiceRelayStore {
  private readonly now: () => Date;

  constructor(readonly dir: string, private readonly options: VoiceRelayStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** 已審閱或待審閱的試驗紀錄；檔案不存在是空的；壞掉丟錯。 */
  readTrials(): RelayTrial[] {
    let text: string;
    try {
      text = readFileSync(join(this.dir, "trials.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new VoiceRelayStoreError(409, TRIALS_BROKEN);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new VoiceRelayStoreError(409, TRIALS_BROKEN);
    }
    const parsed = parseTrials(raw);
    if (!parsed.ok) throw new VoiceRelayStoreError(409, TRIALS_BROKEN, parsed.errors);
    return parsed.trials;
  }

  /** exists：設定檔在不在（不在時「改之前」的目錄是內建資料，fake 模式含示範目標）。 */
  private readUser(): { user: UserDoc; exists: boolean } {
    const read = readRelayUserConfig(this.dir);
    if (!read.ok) throw new VoiceRelayStoreError(409, FILE_BROKEN, read.errors);
    const c = structuredClone(read.config ?? {}) as RelayUserConfig;
    const user: UserDoc = {
      schemaVersion: RELAY_SCHEMA_VERSION,
      targets: (c.targets ?? []) as MutableTarget[],
      voiceProfiles: (c.voiceProfiles ?? []) as VoiceProfile[],
      ...(c.voiceDefaults ? { voiceDefaults: c.voiceDefaults } : {}),
      ...(c.commandPacks ? { commandPacks: c.commandPacks } : {}),
    };
    return { user, exists: read.config !== null };
  }

  private compose(user: RelayUserConfig | null) {
    return parseRelayCatalog(composeRelayDocument(user, { fixtures: this.options.mode === "fake" }));
  }

  /** 讀 → 改 → 驗證整份目錄 → 寫 → 通知。fn 拿到可改的使用者設定與「改之前」的目錄。 */
  private mutate(fn: (user: UserDoc, before: RelayCatalog) => void): RelayCatalog {
    const { user, exists } = this.readUser();
    const before = this.compose(exists ? user : null);
    if (!before.ok) throw new VoiceRelayStoreError(409, FILE_BROKEN, before.errors);
    fn(user, before.catalog);
    const after = this.compose(user);
    if (!after.ok) throw new VoiceRelayStoreError(400, STORE_INVALID, after.errors);
    writeAtomic(this.dir, "config.json", user);
    this.options.onChange?.(after.catalog);
    return after.catalog;
  }

  private target(user: UserDoc, before: RelayCatalog, id: string): MutableTarget {
    const t = user.targets.find((x) => x.id === id);
    if (t) return t;
    throw new VoiceRelayStoreError(400, before.targets.some((x) => x.id === id) ? FIXTURE_TARGET : NO_TARGET);
  }

  createTarget(input: CreateTargetInput): RelayCatalog {
    return this.mutate((user, before) => {
      const taken = new Set([...before.targets.map((t) => t.id), ...user.targets.map((t) => t.id)]);
      let id = input.id;
      if (id !== undefined) {
        if (!SHORT_ID.test(id) || taken.has(id)) throw new VoiceRelayStoreError(400, STORE_INVALID);
      } else {
        let n = 1;
        while (taken.has(`google_mini_${n}`)) n++;
        id = `google_mini_${n}`;
      }
      this.requireVoice(input.voice_id, input.locale);
      const profile = this.newProfile(user, before, input.voice_id, input.locale, {});
      user.voiceProfiles.push(profile);
      user.targets.push({
        id, vendor: "google", assistant: "google_assistant", model: "home_mini", locale: input.locale, enabled: true,
        outputNode: "mac_local", outputDeviceId: input.output_device_id, voiceProfileId: profile.id, candidateVoiceProfileIds: [],
        templateOverrides: {}, reviewedTemplates: [], musicService: input.music_service, devices: [],
      });
    });
  }

  /** 聲音必須是輸出端讀到的、而且語系和目標相同。 */
  private requireVoice(voiceId: string, locale: string): void {
    if (!(this.options.voices?.() ?? []).some((v) => v.id === voiceId && v.locale === locale)) throw new VoiceRelayStoreError(400, BAD_VOICE);
  }

  private newProfile(user: UserDoc, before: RelayCatalog, voiceId: string, locale: string, patch: Partial<VoiceProfile>): VoiceProfile {
    const taken = new Set([...before.profiles.map((p) => p.id), ...user.voiceProfiles.map((p) => p.id)]);
    const stem = `mac_${slug(voiceId)}_${locale.toLowerCase().replace(/-/g, "")}`;
    let n = 1;
    while (taken.has(`${stem}_${n}`)) n++;
    return {
      id: `${stem}_${n}`, engine: "macos_say", voiceId, locale, rate: 1, pitch: 0, gainDb: 0,
      wakeToCommandPauseMs: 800, leadSilenceMs: 300, tailSilenceMs: 300, testedAt: null, recognitionStatsId: null, ...patch,
    };
  }

  upsertProfile(input: UpsertProfileInput): RelayCatalog {
    return this.mutate((user, before) => {
      const target = this.target(user, before, input.target_id);
      this.requireVoice(input.voice_id, target.locale);
      const fields = { voiceId: input.voice_id, rate: input.rate, gainDb: input.gain_db, wakeToCommandPauseMs: input.pause_ms, leadSilenceMs: input.lead_ms, tailSilenceMs: input.tail_ms };
      if (input.id !== undefined) {
        const profile = user.voiceProfiles.find((p) => p.id === input.id);
        const owned = input.id === target.voiceProfileId || target.candidateVoiceProfileIds.includes(input.id);
        // 只有使用者設定檔裡、屬於這個目標的聲線可以改（內建示範聲線不行）。
        if (!profile || !owned || BUILTIN_PROFILE_IDS.has(input.id) || profile.engine !== "macos_say") throw new VoiceRelayStoreError(400, BAD_PROFILE);
        Object.assign(profile, fields);
        // 改的是模型正在用的聲線：之前的採用是在舊聲音下確認的，全部作廢（approved 審閱與覆寫清掉，要重新採用；rejected 保留）。
        // 試驗紀錄以聲線 ID 分組，舊紀錄留著（同一個 ID 的設定已改，判讀時要注意）。
        if (input.id === target.voiceProfileId) {
          target.reviewedTemplates = target.reviewedTemplates.filter((r) => r.status !== "approved");
          target.templateOverrides = {};
        }
        return;
      }
      const profile = this.newProfile(user, before, input.voice_id, target.locale, fields);
      user.voiceProfiles.push(profile);
      target.candidateVoiceProfileIds = [...target.candidateVoiceProfileIds, profile.id];
    });
  }

  adopt(input: AdoptInput): RelayCatalog {
    return this.mutate((user, before) => {
      const target = this.target(user, before, input.target_id);
      const live = before.targets.find((t) => t.id === target.id)!;
      const intent = before.intents.find((i) => i.id === input.intent_id);
      if (!intent || !templateUsable(before, live, input.template_id, input.template_version, intent.id)) throw new VoiceRelayStoreError(400, BAD_TEMPLATE);
      const voice = input.voice_profile_id;
      if (voice !== target.voiceProfileId && !target.candidateVoiceProfileIds.includes(voice)) throw new VoiceRelayStoreError(400, BAD_PROFILE);

      const review: ReviewedTemplate = { templateId: input.template_id, version: input.template_version, status: "approved", reviewedAt: this.now().toISOString(), note: "adopted in diagnostics" };
      // 每個意圖只採用一個說法：同一個意圖其他 approved 的審閱拿掉（rejected 保留）。
      const intentOf = new Map(before.packs.flatMap((p) => p.entries).map((e) => [e.templateId, e.intentId]));
      target.reviewedTemplates = [
        ...target.reviewedTemplates.filter((r) => !(r.templateId === review.templateId && r.version === review.version) && !(r.status === "approved" && intentOf.get(r.templateId) === intent.id)),
        review,
      ];
      const def = levelDefault(before, live, intent.id);
      const overrides = { ...target.templateOverrides };
      if (def && !("ambiguous" in def) && def.entry.templateId === input.template_id) delete overrides[intent.id];
      else overrides[intent.id] = input.template_id;
      target.templateOverrides = overrides;
      if (target.voiceProfileId !== voice) {
        const previous = target.voiceProfileId;
        target.voiceProfileId = voice;
        target.candidateVoiceProfileIds = [...new Set([...(previous ? [previous] : []), ...target.candidateVoiceProfileIds])].filter((id) => id !== voice);
      }
    });
  }

  unadopt(input: UnadoptInput): RelayCatalog {
    return this.mutate((user, before) => {
      const target = this.target(user, before, input.target_id);
      const had = target.reviewedTemplates.some((r) => r.templateId === input.template_id && r.version === input.template_version);
      if (!had) throw new VoiceRelayStoreError(400, BAD_TEMPLATE);
      target.reviewedTemplates = target.reviewedTemplates.filter((r) => !(r.templateId === input.template_id && r.version === input.template_version));
      // 指向這個模板的覆寫一起拿掉（回到層級預設）。
      const overrides = { ...target.templateOverrides };
      for (const [intentId, templateId] of Object.entries(overrides)) if (templateId === input.template_id) delete overrides[intentId as IntentId];
      target.templateOverrides = overrides;
    });
  }

  setEnabled(input: { target_id: string; enabled: boolean }): RelayCatalog {
    return this.mutate((user, before) => {
      this.target(user, before, input.target_id).enabled = input.enabled;
    });
  }

  /** 加一筆已審閱的試驗（使用者在診斷畫面記錄的結果），回傳這一組的統計。 */
  recordTrial(input: TrialInput, catalog: RelayCatalog): TrialSummary {
    const target = catalog.targets.find((t) => t.id === input.target_id);
    if (!target) throw new VoiceRelayStoreError(400, NO_TARGET);
    // 和採用相同的檢查：模板要能用在這個目標；聲線必須是目標選定的或候選。
    if (!templateUsable(catalog, target, input.template_id, input.template_version)) throw new VoiceRelayStoreError(400, BAD_TEMPLATE);
    if (input.voice_profile_id !== selectedProfileId(catalog, target) && !target.candidateVoiceProfileIds.includes(input.voice_profile_id)) throw new VoiceRelayStoreError(400, BAD_PROFILE);
    const trials = this.readTrials();
    const max = trials.reduce((m, t) => Math.max(m, /^t_(\d+)$/.test(t.id) ? Number(t.id.slice(2)) : 0), 0);
    const trial: RelayTrial = {
      id: `t_${max + 1}`, targetId: input.target_id, templateId: input.template_id, templateVersion: input.template_version, voiceProfileId: input.voice_profile_id,
      at: this.now().toISOString(), kind: input.kind, wake: input.wake, command: input.command, evidence: input.evidence, review: "reviewed",
    };
    const doc = { schemaVersion: RELAY_SCHEMA_VERSION, trials: [...trials, trial] };
    const parsed = parseTrials(doc);
    if (!parsed.ok) throw new VoiceRelayStoreError(400, STORE_INVALID, parsed.errors);
    writeAtomic(this.dir, "trials.json", doc);
    const key = JSON.stringify([trial.targetId, trial.templateId, trial.templateVersion, trial.voiceProfileId]);
    return summarizeTrials(parsed.trials).find((s) => s.key === key)!;
  }
}

/** 模板能不能用在這個目標：存在、版本對、（指定時）意圖對、命令包相容、沒被目錄拒絕、supported、政策沒擋。 */
export function templateUsable(catalog: RelayCatalog, target: Target, templateId: string, version: number, intentId?: string): boolean {
  const hit = catalog.packs.flatMap((pack) => pack.entries.map((entry) => ({ pack, entry }))).find((h) => h.entry.templateId === templateId);
  if (!hit || hit.entry.version !== version || (intentId !== undefined && hit.entry.intentId !== intentId)) return false;
  if (!packLevel(hit.pack, target) || hit.entry.status === "rejected" || !hit.entry.supported) return false;
  return templatePolicyOk(catalog, target, templateId);
}

/** 目標選定的聲線（模型路徑用的）：裝置表指定的，否則同品牌／助理／語系的預設聲線。 */
export function selectedProfileId(catalog: RelayCatalog, t: Target): string | null {
  const same = catalog.voiceDefaults.filter((d) => d.vendor === t.vendor && d.assistant === t.assistant && d.locale === t.locale);
  return t.voiceProfileId ?? (same.find((d) => d.model === t.model) ?? same.find((d) => d.model === undefined))?.voiceProfileId ?? null;
}

/** 模板層級的政策檢查（不需要 slot 值）：模板原文加上所有 slot 說法一起檢查。 */
export function templatePolicyOk(catalog: RelayCatalog, target: Target, templateId: string): boolean {
  const entry = catalog.packs.flatMap((p) => p.entries).find((e) => e.templateId === templateId);
  const intent = entry && catalog.intents.find((i) => i.id === entry.intentId);
  if (!entry || !intent) return false;
  const words = Object.values(entry.slotText ?? {}).flatMap((m) => Object.values(m ?? {}));
  return relayPolicy(intent, entry, target, [entry.utteranceTemplate, ...words].join(" ")).ok;
}
