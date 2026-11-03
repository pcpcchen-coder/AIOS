import { describe, expect, it } from "vitest";
import { BUILTIN_PACKS, composeRelayDocument } from "../server/integrations/voice-relay/builtin.ts";
import { parseRelayCatalog } from "../server/integrations/voice-relay/catalog.ts";

// VCR-0（docs/19）：三層資料的驗證器。內建的 Google 說法都是候選（NOT_TESTED）；裝置表是示範資料（fixture）。

type Doc = any;
const doc = (): Doc => structuredClone(composeRelayDocument(null));
const zhPack = (d: Doc) => d.packs.find((p: Doc) => p.id === "google.home_mini.zh-TW.v1");
const entry = (d: Doc, templateId: string) => zhPack(d).entries.find((e: Doc) => e.templateId === templateId);
const target = (d: Doc) => d.targets[0];

function errorsOf(d: Doc): string[] {
  const r = parseRelayCatalog(d);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors;
}

describe("parseRelayCatalog", () => {
  it("accepts the built-in catalog and deep-freezes the result", () => {
    const r = parseRelayCatalog(doc());
    expect(r.ok, r.ok ? "" : r.errors.join("\n")).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.catalog)).toBe(true);
    expect(Object.isFrozen(r.catalog.targets[0]!.devices[0])).toBe(true);
    // 內建 Google 說法全部是候選、未測；Apple／Amazon／Xiaomi 只有空命令包。
    for (const e of r.catalog.packs.flatMap((p) => p.entries)) {
      expect(e.status).toBe("candidate");
      expect(e.testResult).toBe("NOT_TESTED");
    }
    expect(BUILTIN_PACKS.filter((p) => p.vendor !== "google").every((p) => p.entries.length === 0 && p.wakePhrases.length === 0)).toBe(true);
    expect(r.catalog.targets.every((t) => t.fixture === true)).toBe(true);
    expect(r.catalog.profiles.every((p) => p.fixture === true)).toBe(true);
  });

  it("returns errors instead of throwing for non-objects", () => {
    expect(parseRelayCatalog(null)).toEqual({ ok: false, errors: expect.any(Array) });
    expect(parseRelayCatalog([])).toMatchObject({ ok: false });
    const d = doc();
    d.schemaVersion = 2;
    expect(errorsOf(d).join()).toMatch(/schemaVersion/);
  });

  it("rejects unknown keys at every level", () => {
    const cases: ((d: Doc) => void)[] = [
      (d) => (d.extra = 1),
      (d) => (d.intents[0].extra = 1),
      (d) => (zhPack(d).extra = 1),
      (d) => (zhPack(d).wakePhrases[0].extra = 1),
      (d) => (entry(d, "google.next.zh1").raw_text = "x"),
      (d) => (d.profiles[0].extra = 1),
      (d) => (d.voiceDefaults[0].extra = 1),
      (d) => (target(d).extra = 1),
      (d) => (target(d).devices[0].extra = 1),
      (d) => (target(d).reviewedTemplates[0].extra = 1),
      (d) => (entry(d, "google.genre.zh1").slotText.genre.metal = "金屬"),
    ];
    for (const mutate of cases) {
      const d = doc();
      mutate(d);
      expect(errorsOf(d).join(), String(mutate)).toMatch(/不認得的欄位/);
    }
  });

  it("does not echo values in error messages", () => {
    const d = doc();
    target(d).devices[0].name = "SECRET-NAME\n";
    const errors = errorsOf(d).join();
    expect(errors).not.toContain("SECRET-NAME");
    expect(errors).toMatch(/devices\[0\]\.name/);
  });

  it("rejects duplicate ids", () => {
    const cases: [(d: Doc) => void, RegExp][] = [
      [(d) => d.packs.push(structuredClone(d.packs[2])), /packs/],
      [(d) => (entry(d, "google.pause.zh1").templateId = "google.next.zh1"), /templateId/],
      [(d) => d.profiles.push(structuredClone(d.profiles[0])), /profiles/],
      [(d) => d.targets.push(structuredClone(d.targets[0])), /targets\[2\]\.id/],
      [(d) => target(d).devices.push({ ...target(d).devices[0] }), /devices/],
      [(d) => (d.packs[1].wakePhrases[0].id = "google.wake.ok.zh"), /wakePhrases/],
      [(d) => d.voiceDefaults.push({ ...d.voiceDefaults[0] }), /voiceDefaults/],
    ];
    for (const [mutate, path] of cases) {
      const d = doc();
      mutate(d);
      const errors = errorsOf(d);
      expect(errors.join(), String(mutate)).toMatch(/重複|只能有一個/);
      expect(errors.join()).toMatch(path);
    }
  });

  it("allows at most one selected entry per intent in a pack", () => {
    const d = doc();
    entry(d, "google.genre_spotify.zh1").selected = true;
    expect(errorsOf(d).join()).toMatch(/只能選定一個模板/);
  });

  it("checks placeholders against the intent's slots and requires slot words for every enum/boolean value", () => {
    const cases: [(d: Doc) => void, RegExp][] = [
      [(d) => (entry(d, "google.next.zh1").utteranceTemplate = "下一首{genre}"), /不是意圖的 slot/],
      [(d) => (entry(d, "google.volume.zh1").utteranceTemplate = "音量調大"), /沒有用到 slot percent/],
      [(d) => delete entry(d, "google.genre.zh1").slotText.genre.kids, /slotText\.genre\.kids/],
      [(d) => delete entry(d, "google.light.zh1").slotText, /slotText\.on/],
      [(d) => (entry(d, "google.volume.zh1").slotText = { percent: { "1": "一" } }), /不用說法表/],
      [(d) => (entry(d, "google.next.zh1").utteranceTemplate = "下一首 {"), /大括號/],
      [(d) => (entry(d, "google.next.zh1").intentId = "music.shuffle"), /不是目錄裡的意圖/],
    ];
    for (const [mutate, error] of cases) {
      const d = doc();
      mutate(d);
      expect(errorsOf(d).join(), String(mutate)).toMatch(error);
    }
  });

  it("rejects a wake phrase inside the command, control characters and over-long text", () => {
    for (const text of ["ok google 下一首歌", "下一首\n歌", "下一首\u0007", "長".repeat(121), " "]) {
      const d = doc();
      entry(d, "google.next.zh1").utteranceTemplate = text;
      expect(errorsOf(d).join(), JSON.stringify(text)).toMatch(/utteranceTemplate/);
    }
  });

  it("rejects wake phrases (normalised, from any pack) inside templates, slot words and device names", () => {
    const cases: [(d: Doc) => void, RegExp][] = [
      [(d) => (entry(d, "google.next.zh1").utteranceTemplate = "OK  Google 下一首"), /utteranceTemplate/],
      [(d) => (entry(d, "google.next.zh1").utteranceTemplate = "ｏｋ ｇｏｏｇｌｅ下一首"), /utteranceTemplate/],
      [(d) => (entry(d, "google.genre.zh1").slotText.genre.pop = "hey google"), /slotText\.genre\.pop/],
      [(d) => (target(d).devices[0].name = "Ok Google 燈"), /devices\[0\]\.name/],
      // 別的命令包的喚醒詞也算。
      [(d) => d.packs.push({ id: "x.pack", version: 1, scope: "model", vendor: "amazon", assistant: "alexa", model: "echo_dot", locale: "zh-TW", wakePhrases: [{ id: "x.wake", text: "Alexa", selected: true }], entries: [] }) && (target(d).devices[0].name = "alexa 燈"), /devices\[0\]\.name/],
    ];
    for (const [mutate, path] of cases) {
      const d = doc();
      mutate(d);
      const errors = errorsOf(d).join();
      expect(errors, String(mutate)).toMatch(/喚醒詞/);
      expect(errors).toMatch(path);
    }
  });

  it("rejects Unicode format characters (zero-width, bidi, BOM) in every spoken text field", () => {
    const chars = ["\u200b", "\u200f", "\u202e", "\u2066", "\ufeff"];
    const fields: ((d: Doc, ch: string) => void)[] = [
      (d, ch) => (entry(d, "google.next.zh1").utteranceTemplate = `下一首${ch}歌`),
      (d, ch) => (entry(d, "google.genre.zh1").slotText.genre.pop = `流${ch}行`),
      (d, ch) => (zhPack(d).wakePhrases[0].text = `Ok${ch} Google`),
      (d, ch) => (target(d).devices[0].name = `測試${ch}燈`),
    ];
    for (const ch of chars) for (const mutate of fields) expect(parseRelayCatalog(((d) => (mutate(d, ch), d))(doc())).ok, `${String(mutate)} ${ch.codePointAt(0)}`).toBe(false);
  });

  it("does not crash on scope names inherited from Object.prototype", () => {
    for (const scope of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const d = doc();
      zhPack(d).scope = scope;
      expect(() => parseRelayCatalog(d), scope).not.toThrow();
      expect(errorsOf(d).join()).toMatch(/scope/);
    }
  });

  it("enforces pack scope rules", () => {
    const cases: ((d: Doc) => void)[] = [
      (d) => delete zhPack(d).model,
      (d) => (zhPack(d).scope = "vendor"),
      (d) => Object.assign(zhPack(d), { scope: "generic" }),
      (d) => (zhPack(d).compatibleAssistants = ["siri"]),
      (d) => (zhPack(d).locale = "zh_TW"),
      (d) => (zhPack(d).wakePhrases[1].selected = true),
    ];
    for (const mutate of cases) expect(parseRelayCatalog(((d) => (mutate(d), d))(doc())).ok, String(mutate)).toBe(false);
  });

  it("checks target references", () => {
    const cases: [(d: Doc) => void, RegExp][] = [
      [(d) => (target(d).voiceProfileId = "nope"), /voiceProfileId/],
      [(d) => (target(d).candidateVoiceProfileIds = ["nope"]), /candidateVoiceProfileIds\[0\]/],
      [(d) => (target(d).wakePhraseId = "nope"), /wakePhraseId/],
      [(d) => (target(d).templateOverrides = { "music.next": "nope" }), /沒有這個模板/],
      [(d) => (target(d).templateOverrides = { "music.next": "google.pause.zh1" }), /別的意圖/],
      [(d) => (target(d).templateOverrides = { "music.shuffle": "google.next.zh1" }), /不認得的欄位/],
      [(d) => (target(d).id = "Bad-ID"), /targets\[0\]\.id/],
      [(d) => (target(d).outputNode = "../x"), /outputNode/],
      [(d) => (target(d).outputDeviceId = ""), /outputDeviceId/],
      [(d) => (d.voiceDefaults[0].voiceProfileId = "google_en_a"), /語系/],
      [(d) => (d.voiceDefaults[0].voiceProfileId = "nope"), /沒有這個聲線/],
      [(d) => (d.profiles[0].rate = 3), /rate/],
      [(d) => (d.profiles[0].wakeToCommandPauseMs = 6000), /wakeToCommandPauseMs/],
    ];
    for (const [mutate, error] of cases) {
      const d = doc();
      mutate(d);
      expect(errorsOf(d).join(), String(mutate)).toMatch(error);
    }
  });
});
