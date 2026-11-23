import { describe, expect, it } from "vitest";
import { composeRelayDocument } from "../server/integrations/voice-relay/builtin.ts";
import { parseRelayCatalog } from "../server/integrations/voice-relay/catalog.ts";
import { relayPolicy } from "../server/integrations/voice-relay/policy.ts";
import { resolveRelay } from "../server/integrations/voice-relay/resolver.ts";

// VCR-0（docs/19 §5）：下游用途政策。Spotify 語音控制未取得授權（SP-2 BLOCKED）；只有低風險意圖。示範資料（fixture）。

type Doc = any;
const doc = (): Doc => structuredClone(composeRelayDocument(null));
const build = (d: Doc) => {
  const r = parseRelayCatalog(d);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.catalog;
};
const ZH = "fixture_google_mini_zh";
const genre = { targetId: ZH, intentId: "music.play_genre", slots: { genre: "pop" } };

describe("relay policy", () => {
  it("blocks a Spotify-downstream template picked by device override, before the review check", () => {
    const d = doc();
    d.targets[0].templateOverrides = { "music.play_genre": "google.genre_spotify.zh1" };
    expect(resolveRelay(build(d), genre)).toEqual({ kind: "refused", reason: "policy_blocked", detail: "spotify_downstream" });
  });

  it("diagnostic mode cannot bypass the policy", () => {
    expect(resolveRelay(build(doc()), genre, { diagnostic: { candidateTemplateId: "google.genre_spotify.zh1" } })).toMatchObject({ reason: "policy_blocked" });
  });

  it("blocks configured_music_service when the target's music service is Spotify or unknown", () => {
    for (const musicService of ["spotify", "unknown"]) {
      const d = doc();
      d.targets[0].musicService = musicService;
      expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} }), musicService).toMatchObject({ reason: "policy_blocked" });
    }
  });

  it("blocks a user pack whose command text mentions Spotify even when labelled configured_music_service", () => {
    const d = doc();
    d.packs.push({
      id: "user.pack", version: 1, scope: "vendor", vendor: "google", locale: "zh-TW", wakePhrases: [],
      entries: ["Spotify 下一首", "聲破天下一首"].map((text, i) => ({ templateId: `user.next${i}`, version: 1, intentId: "music.next", utteranceTemplate: text, selected: false, supported: true, status: "approved", downstreamService: "configured_music_service", source: "user", testedOn: null, testResult: "NOT_TESTED" })),
    });
    for (const id of ["user.next0", "user.next1"]) {
      d.targets[0].templateOverrides = { "music.next": id };
      expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} }), id).toEqual({ kind: "refused", reason: "policy_blocked", detail: "spotify_text" });
    }
  });

  it("judges by usage: any music intent is blocked for Spotify/unknown music service whatever the downstream label", () => {
    for (const label of ["assistant_builtin", "smart_home", "other"]) {
      for (const musicService of ["spotify", "unknown"]) {
        const d = doc();
        d.targets[0].musicService = musicService;
        d.packs[0].entries.find((e: Doc) => e.templateId === "google.next.zh1").downstreamService = label;
        expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} }), `${label} ${musicService}`).toMatchObject({ reason: "policy_blocked" });
      }
    }
  });

  it("normalises the command text before the Spotify check (NFKC, case, spaces, zero-width/bidi)", () => {
    const c = build(doc());
    const intent = c.intents.find((i) => i.id === "volume.set")!;
    const entry = c.packs[0]!.entries.find((e) => e.templateId === "google.volume.zh1")!;
    for (const text of ["用 S p o t i f y", "ＳＰＯＴＩＦＹ", "spo\u200btify", "spo\u202etify", "聲 破 天", "SpOtIfY"]) {
      expect(relayPolicy(intent, entry, c.targets[0]!, text), JSON.stringify(text)).toEqual({ ok: false, detail: "spotify_text" });
    }
    expect(relayPolicy(intent, entry, c.targets[0]!, "音量調到百分之20")).toEqual({ ok: true });
  });

  it("allows volume and light commands regardless of music service", () => {
    const d = doc();
    d.targets[0].musicService = "spotify";
    const c = build(d);
    expect(resolveRelay(c, { targetId: ZH, intentId: "volume.set", slots: { percent: 20 } }).kind).toBe("resolved");
    expect(resolveRelay(c, { targetId: ZH, intentId: "light.power", slots: { device: "fixture_light", on: true } }).kind).toBe("resolved");
  });

  it("blocks riskClass high, and the resolver reports it even for approved templates", () => {
    const c = build(doc());
    const intent = c.intents.find((i) => i.id === "music.next")!;
    const entry = c.packs[0]!.entries[0]!;
    expect(relayPolicy({ ...intent, riskClass: "high" }, entry, c.targets[0]!, "下一首歌")).toEqual({ ok: false, detail: "risk_class" });
    const d = doc();
    d.intents.find((i: Doc) => i.id === "music.next").riskClass = "high";
    expect(resolveRelay(build(d), { targetId: ZH, intentId: "music.next", slots: {} })).toEqual({ kind: "refused", reason: "policy_blocked", detail: "risk_class" });
  });
});
