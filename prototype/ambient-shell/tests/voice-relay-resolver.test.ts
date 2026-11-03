import { describe, expect, it } from "vitest";
import type { RelayCatalog } from "../shared/voice-relay.ts";
import { composeRelayDocument } from "../server/integrations/voice-relay/builtin.ts";
import { parseRelayCatalog } from "../server/integrations/voice-relay/catalog.ts";
import { resolveRelay, type RelayResolved } from "../server/integrations/voice-relay/resolver.ts";

// VCR-0（docs/19 §4.4）：決定論解析器。全部是示範資料（fixture），沒有播任何聲音。

type Doc = any;
const doc = (): Doc => structuredClone(composeRelayDocument(null));
const build = (d: Doc): RelayCatalog => {
  const r = parseRelayCatalog(d);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.catalog;
};
const ZH = "fixture_google_mini_zh";
const EN = "fixture_google_mini_en";
const resolved = (r: ReturnType<typeof resolveRelay>): RelayResolved => {
  if (r.kind !== "resolved") throw new Error(`refused: ${r.reason} ${r.detail ?? ""}`);
  return r;
};

/** 同一個意圖（music.next）在四個層級各有一個已選定的說法；zh 目標已審閱全部。 */
function layeredDoc(): Doc {
  const d = doc();
  const entry = (templateId: string, text: string) => ({ templateId, version: 1, intentId: "music.next", utteranceTemplate: text, selected: true, supported: true, status: "approved", downstreamService: "configured_music_service", source: "test fixture", testedOn: null, testResult: "NOT_TESTED" });
  d.packs.push(
    { id: "t.assistant", version: 1, scope: "assistant", vendor: "google", assistant: "google_assistant", locale: "zh-TW", wakePhrases: [{ id: "t.wake.a", text: "Hey Google", selected: true }], entries: [entry("t.next.assistant", "助理層下一首")] },
    { id: "t.vendor", version: 1, scope: "vendor", vendor: "google", locale: "zh-TW", wakePhrases: [], entries: [entry("t.next.vendor", "品牌層下一首")] },
    { id: "t.generic", version: 1, scope: "generic", compatibleAssistants: ["google_assistant"], locale: "zh-TW", wakePhrases: [], entries: [entry("t.next.generic", "通用層下一首")] },
    { id: "t.override", version: 1, scope: "vendor", vendor: "google", locale: "zh-TW", wakePhrases: [{ id: "t.wake.o", text: "Ok Google", selected: true }], entries: [{ ...entry("t.next.override", "覆寫下一首"), selected: false }] },
  );
  return d;
}

describe("resolveRelay", () => {
  it("resolves an approved fixture template into wake phrase + command, with metadata", () => {
    const r = resolved(resolveRelay(build(doc()), { targetId: ZH, intentId: "music.next", slots: {} }));
    expect(r).toMatchObject({ templateId: "google.next.zh1", templateVersion: 1, packId: "google.home_mini.zh-TW.v1", level: "model_locale", wakePhrase: "Ok Google", commandText: "下一首歌", spokenText: "Ok Google 下一首歌", outputNode: "fake_node", outputDeviceId: "fake_speaker_1", voiceProfileId: "google_zh_a", testStatus: "NOT_TESTED", reviewStatus: "approved", diagnostic: false, catalogVersion: 1 });
  });

  it("renders slots: light power zh/en, genre, percent", () => {
    const c = build(doc());
    expect(resolved(resolveRelay(c, { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: true } })).commandText).toBe("打開測試燈");
    expect(resolved(resolveRelay(c, { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: false } })).commandText).toBe("關掉測試燈");
    expect(resolved(resolveRelay(c, { targetId: EN, intentId: "light.power", slots: { device: "fixture_light", on: true } })).commandText).toBe("turn on the test lamp");
    expect(resolved(resolveRelay(c, { targetId: ZH, intentId: "music.play_genre", slots: { genre: "jazz" } })).commandText).toBe("播放爵士音樂");
    expect(resolved(resolveRelay(c, { targetId: EN, intentId: "volume.set", slots: { percent: 30 } })).spokenText).toBe("Ok Google set the volume to 30 percent");
    expect(resolved(resolveRelay(c, { targetId: ZH, intentId: "light.brightness", slots: { device: "fixture_light", percent: 40 } })).commandText).toBe("把測試燈的亮度調到百分之40");
  });

  it("follows level priority: device override > model > assistant > vendor > generic", () => {
    const d = layeredDoc();
    const next = () => resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} });
    d.targets[0].templateOverrides = { "music.next": "t.next.override" };
    expect(resolved(next())).toMatchObject({ level: "device_override", commandText: "覆寫下一首" });
    d.targets[0].templateOverrides = {};
    expect(resolved(next())).toMatchObject({ level: "model_locale", commandText: "下一首歌" });
    d.packs[0].entries.find((e: Doc) => e.templateId === "google.next.zh1").selected = false;
    // 喚醒詞一律取最具體的同品牌同助理同語系命令包（型號層 "Ok Google"），不跟著模板所在的命令包。
    expect(resolved(next())).toMatchObject({ level: "assistant_locale", commandText: "助理層下一首", wakePhrase: "Ok Google", packId: "t.assistant" });
    d.packs.find((p: Doc) => p.id === "t.assistant").entries[0].selected = false;
    expect(resolved(next())).toMatchObject({ level: "vendor_locale", commandText: "品牌層下一首", wakePhrase: "Ok Google" });
    d.targets[0].wakePhraseId = "google.wake.hey.zh";
    expect(resolved(next())).toMatchObject({ level: "vendor_locale", wakePhrase: "Hey Google" });
    d.packs.find((p: Doc) => p.id === "t.vendor").entries[0].selected = false;
    expect(resolved(next())).toMatchObject({ level: "generic", commandText: "通用層下一首" });
    d.packs.find((p: Doc) => p.id === "t.generic").entries[0].selected = false;
    expect(next()).toEqual({ kind: "refused", reason: "unsupported_intent", detail: "no_template" });
  });

  it("reports ambiguity when two packs at the same level both select a template", () => {
    const d = layeredDoc();
    d.packs[0].entries.find((e: Doc) => e.templateId === "google.next.zh1").selected = false;
    d.packs.push({ ...structuredClone(d.packs.find((p: Doc) => p.id === "t.assistant")), id: "t.assistant2", wakePhrases: [], entries: [{ ...d.packs.find((p: Doc) => p.id === "t.assistant").entries[0], templateId: "t.next.assistant2" }] });
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "ambiguous_template", detail: "assistant_locale" });
  });

  it("stops at an entry marked supported:false instead of falling back to a less specific level", () => {
    const d = layeredDoc();
    d.packs[0].entries.find((e: Doc) => e.templateId === "google.next.zh1").supported = false;
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toMatchObject({ kind: "refused", reason: "unsupported_intent" });
  });

  it("never falls back to another locale", () => {
    const d = doc();
    // 英文目標，但只剩中文命令包。
    d.packs = d.packs.filter((p: Doc) => p.id !== "google.home_mini.en-US.v1");
    d.targets[1].reviewedTemplates = [];
    expect(resolveRelay(build(d), { targetId: EN, intentId: "music.next", slots: {} })).toMatchObject({ kind: "refused", reason: "unsupported_intent" });
    // 型號相同但語系 zh-CN 也不行。
    const d2 = doc();
    d2.targets[0].locale = "zh-CN";
    expect(resolveRelay(build(d2), { targetId: ZH, intentId: "music.next", slots: {} })).toMatchObject({ kind: "refused", reason: "unsupported_intent" });
  });

  it("is deterministic: same input gives deep-equal, JSON-identical output", () => {
    const c = build(doc());
    const req = { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: true } };
    const a = resolveRelay(c, req);
    const b = resolveRelay(c, req);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(resolveRelay(build(doc()), req))).toBe(JSON.stringify(a));
  });

  it("refuses unknown and disabled targets, unknown intents, and Google timers", () => {
    const d = doc();
    d.targets[1].enabled = false;
    const c = build(d);
    expect(resolveRelay(c, { targetId: "nope", intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "unknown_target" });
    expect(resolveRelay(c, { targetId: EN, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "target_disabled" });
    expect(resolveRelay(c, { targetId: ZH, intentId: "music.shuffle", slots: {} })).toMatchObject({ reason: "unsupported_intent" });
    expect(resolveRelay(c, { targetId: ZH, intentId: "assistant.timer", slots: { seconds: 60 } })).toMatchObject({ reason: "unsupported_intent" });
  });

  it("refuses invalid slots", () => {
    const c = build(doc());
    const cases: [string, Record<string, unknown>][] = [
      ["music.next", { genre: "pop" }],
      ["music.play_genre", {}],
      ["music.play_genre", { genre: "metal" }],
      ["volume.set", { percent: 101 }],
      ["volume.set", { percent: 5.5 }],
      ["volume.set", { percent: "50" }],
      ["light.power", { device: "fixture_light" }],
      ["light.power", { device: "other_light", on: true }],
      ["light.power", { device: "fixture_light", on: "yes" }],
      ["assistant.timer", { seconds: 0 }],
    ];
    for (const [intentId, slots] of cases) expect(resolveRelay(c, { targetId: ZH, intentId, slots }), `${intentId} ${JSON.stringify(slots)}`).toMatchObject({ reason: "invalid_slots" });
  });

  it("requires review: candidate → not_reviewed; reviewedTemplates approves; rejected stays refused even in diagnostic", () => {
    const d = doc();
    d.targets[0].reviewedTemplates = d.targets[0].reviewedTemplates.filter((r: Doc) => r.templateId !== "google.next.zh1");
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "not_reviewed", detail: "candidate" });
    // 診斷模式可以試候選。
    const diag = resolved(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} }, { diagnostic: { candidateTemplateId: "google.next.zh1" } }));
    expect(diag).toMatchObject({ level: "diagnostic", reviewStatus: "candidate", diagnostic: true });
    // 審閱紀錄要同版本才算。
    d.targets[0].reviewedTemplates.push({ templateId: "google.next.zh1", version: 2, status: "approved", reviewedAt: "2026-11-03" });
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toMatchObject({ reason: "not_reviewed" });
    d.targets[0].reviewedTemplates.push({ templateId: "google.next.zh1", version: 1, status: "rejected", reviewedAt: "2026-11-03" });
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "not_reviewed", detail: "rejected" });
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} }, { diagnostic: { candidateTemplateId: "google.next.zh1" } })).toEqual({ kind: "refused", reason: "not_reviewed", detail: "rejected" });
  });

  it("diagnostic options: template must match intent and target; voice must be one of the target's", () => {
    const c = build(doc());
    const req = { targetId: ZH, intentId: "music.next", slots: {} };
    expect(resolveRelay(c, req, { diagnostic: { candidateTemplateId: "google.pause.zh1" } })).toMatchObject({ reason: "diagnostic_invalid" });
    expect(resolveRelay(c, req, { diagnostic: { candidateTemplateId: "google.next.en1" } })).toMatchObject({ reason: "diagnostic_invalid" });
    expect(resolveRelay(c, req, { diagnostic: { candidateTemplateId: "nope" } })).toMatchObject({ reason: "diagnostic_invalid" });
    expect(resolved(resolveRelay(c, req, { diagnostic: { candidateVoiceId: "google_zh_b" } }))).toMatchObject({ voiceProfileId: "google_zh_b", diagnostic: true });
    expect(resolveRelay(c, req, { diagnostic: { candidateVoiceId: "google_en_b" } })).toEqual({ kind: "refused", reason: "diagnostic_invalid", detail: "voice" });
  });

  it("voice: never substitutes; missing or wrong-locale voice → tts_unavailable; defaults used when the target names none", () => {
    const req = { targetId: ZH, intentId: "music.next", slots: {} };
    const c = build(doc());
    expect(resolveRelay(c, req, { voiceAvailable: () => false })).toEqual({ kind: "refused", reason: "tts_unavailable", detail: "voice_missing" });
    const seen: unknown[] = [];
    resolved(resolveRelay(c, req, { voiceAvailable: (...a) => (seen.push(a), true) }));
    expect(seen).toEqual([["fake_node", "macos_say", "Meijia"]]);
    const d = doc();
    d.targets[0].voiceProfileId = "google_en_a";
    expect(resolveRelay(build(d), req)).toEqual({ kind: "refused", reason: "tts_unavailable", detail: "voice_locale" });
    delete d.targets[0].voiceProfileId;
    expect(resolved(resolveRelay(build(d), req)).voiceProfileId).toBe("google_zh_a");
    d.voiceDefaults = d.voiceDefaults.filter((v: Doc) => v.locale !== "zh-TW");
    expect(resolveRelay(build(d), req)).toEqual({ kind: "refused", reason: "tts_unavailable", detail: "no_voice" });
    // 助理層預設（沒有型號）也可以。
    d.voiceDefaults.push({ vendor: "google", assistant: "google_assistant", locale: "zh-TW", voiceProfileId: "google_zh_b" });
    expect(resolved(resolveRelay(build(d), req)).voiceProfileId).toBe("google_zh_b");
  });

  it("refuses when the profile's output differs from the target's speaker (never moves audio elsewhere)", () => {
    const req = { targetId: ZH, intentId: "music.next", slots: {} };
    for (const patch of [{ outputNode: "kitchen_pi" }, { outputDeviceId: "usb_speaker" }]) {
      const d = doc();
      Object.assign(d.profiles[0], patch);
      expect(resolveRelay(build(d), req), JSON.stringify(patch)).toEqual({ kind: "refused", reason: "output_unavailable", detail: "output_mismatch" });
    }
    // 和目標相同的值可以。
    const d = doc();
    Object.assign(d.profiles[0], { outputNode: "fake_node", outputDeviceId: "fake_speaker_1" });
    expect(resolved(resolveRelay(build(d), req))).toMatchObject({ outputNode: "fake_node", outputDeviceId: "fake_speaker_1" });
  });

  it("takes the wake phrase only from a same-brand, same-assistant, same-locale pack; never from generic or other packs", () => {
    const req = { targetId: ZH, intentId: "music.next", slots: {} };
    const d = doc();
    d.packs[0].wakePhrases = [];
    d.packs.push({ id: "t.generic", version: 1, scope: "generic", compatibleAssistants: ["google_assistant"], locale: "zh-TW", wakePhrases: [{ id: "t.wake.g", text: "Hey Google", selected: true }], entries: [] });
    // 英文包的喚醒詞、通用包的喚醒詞都不能拿來用。
    expect(resolveRelay(build(d), req)).toEqual({ kind: "refused", reason: "unsupported_intent", detail: "no_wake_phrase" });
    // 助理層命令包（同品牌同助理同語系）可以。
    d.packs.push({ id: "t.assistant", version: 1, scope: "assistant", vendor: "google", assistant: "google_assistant", locale: "zh-TW", wakePhrases: [{ id: "t.wake.a", text: "Hey Google", selected: true }], entries: [] });
    expect(resolved(resolveRelay(build(d), req)).wakePhrase).toBe("Hey Google");
  });

  it("validator rejects a target wakePhraseId from another locale, brand or assistant", () => {
    const d = doc();
    d.targets[0].wakePhraseId = "google.wake.ok.en";
    const r = parseRelayCatalog(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/wakePhraseId.*品牌、助理或語系/);
  });

  it("only an explicit candidateTemplateId may try an unreviewed template; candidateVoiceId alone does not", () => {
    const d = doc();
    d.targets[0].reviewedTemplates = [];
    const req = { targetId: ZH, intentId: "music.next", slots: {} };
    expect(resolveRelay(build(d), req, { diagnostic: { candidateVoiceId: "google_zh_b" } })).toEqual({ kind: "refused", reason: "not_reviewed", detail: "candidate" });
    expect(resolveRelay(build(d), req, { diagnostic: { candidateTemplateId: "google.next.zh1", candidateVoiceId: "google_zh_b" } }).kind).toBe("resolved");
  });

  it("a catalog entry marked rejected stays rejected even if the target approved it", () => {
    const d = doc();
    d.packs[0].entries.find((e: Doc) => e.templateId === "google.next.zh1").status = "rejected";
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "not_reviewed", detail: "rejected" });
  });

  it("re-checks the rendered command against every wake phrase in the catalog", () => {
    // 驗證器會擋下含喚醒詞的裝置名稱；這裡直接改凍結前的目錄，模擬繞過驗證的資料。
    const c = structuredClone(build(doc())) as Doc;
    for (const name of ["OK  google", "ｏｋ Ｇｏｏｇｌｅ", "hey google 的燈"]) {
      c.targets[0].devices[0].name = name;
      expect(resolveRelay(c, { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: true } }), name).toEqual({ kind: "refused", reason: "invalid_slots", detail: "wake_phrase_in_command" });
    }
    // 零寬字元本身就不是可以播的文字。
    c.targets[0].devices[0].name = "OK\u200bgoogle";
    expect(resolveRelay(c, { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: true } })).toMatchObject({ reason: "invalid_slots" });
  });
});
