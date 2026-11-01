// SP-02a 喚醒時認聲音：voice_probe（喚醒片段與問候前的話）、voice_test（試認聲音）、問候決策的臉聲融合（docs/17 §7.3）、IPC 白名單。
// 特徵是合成的單位向量（tests/fixtures/identity.ts），不是真的聲音或臉；SecretBox 是替身，gallery 加密是真的 AES-GCM。
// 證明的是「什麼證據組合下核心帶不帶名字」，不證明真人的辨識率（門檻未校準，SP-03）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateIdentityRequest } from "../desktop/identity-ipc.mjs";
import { GalleryStore } from "../server/identity-store.ts";
import { combineVoice, IdentityService, VOICE_EVIDENCE_MS, type AmbientPrefs } from "../server/identity-service.ts";
import { SPEAKER_MODEL_VERSION } from "../server/speaker-runtime.ts";
import { VOICE_CALIBRATED, VOICE_KEYWORD_SAMPLES, VOICE_UTTERANCE_SAMPLES, type FaceModelVersion, type IdentityResponse, type VoiceSegment } from "../shared/identity.ts";
import { GREETING_TEMPLATES } from "../shared/sense.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const VOICE = SPEAKER_MODEL_VERSION;
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const said = (name: string | null) => new RegExp(`「(${GREETING_TEMPLATES.filter((t) => t.named === (name !== null)).map((t) => esc(t.render(name))).join("|")})」`);
const NAMED = said("George");
const PLAIN = said(null);
const id = (n: number) => `int_${n.toString(16).padStart(16, "0")}`;
const wid = (n: number) => `int_${(0xabc000 + n).toString(16).padStart(16, "0")}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-wake-voice-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Claim {
  route: "api_key" | "live";
  session_id: string;
  source?: "look_to_talk" | "wake_word";
  wake_id?: string;
}

function setup(options: { voiceRuntime?: "ok" | "missing"; camera?: boolean; voiceNameTest?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const prefs: AmbientPrefs = { look_to_talk: true, look_to_talk_greet: true, look_to_talk_greet_name: true };
  const claims = new Map<string, Claim>();
  const log: string[] = [];
  const camera = { on: options.camera ?? true };
  const voiceNameTest = { on: options.voiceNameTest ?? false };
  const svc = new IdentityService({
    store: new GalleryStore({ dir: join(root, "identity"), secretBox: fakeSecretBox() }),
    confirm: async () => true,
    camera: () => camera.on,
    ambient: () => prefs,
    wakeGreetingOpen: () => true,
    claimGreeting: (interaction) => {
      const claim = claims.get(interaction) ?? null;
      claims.delete(interaction);
      return claim;
    },
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    speakerRuntime: { state: options.voiceRuntime ?? "ok", problems: [] },
    speakerModel: VOICE,
    voiceNameTest: () => voiceNameTest.on,
    now: () => clock.now,
    log: (l) => log.push(l),
  });
  return { svc, clock, prefs, claims, log, camera, voiceNameTest };
}
type Setup = ReturnType<typeof setup>;

/** 每個人：臉、喚醒詞、朗讀各一個中心。 */
const person = (seed: number) => ({ face: unitFeature(seed), keyword: unitFeature(seed * 10 + 1, 192), utterance: unitFeature(seed * 10 + 2, 192) });
const GEORGE = person(1);
const MARY = person(2);
const STRANGER = person(9);

async function openSession(c: Setup): Promise<string> {
  const res = await c.svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!res.ok || !("session" in res)) throw new Error(JSON.stringify(res));
  return res.session;
}

/** 登記：face／voice 可各自省略。回傳 person_id。 */
async function enroll(c: Setup, name: string, p: ReturnType<typeof person>, what: { face?: boolean; voice?: boolean } = { face: true, voice: true }): Promise<string> {
  const session = await openSession(c);
  let personId: string | undefined;
  if (what.face !== false) {
    c.clock.now += 1000;
    const samples = Array.from({ length: 6 }, (_, i) => Array.from(near(p.face, i + 1)));
    const res = await c.svc.handle({ op: "enroll", session, name, minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples });
    if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
    personId = res.people.find((x) => x.name === name)!.person_id;
  }
  if (what.voice !== false) {
    c.clock.now += 1000;
    const voice = {
      keyword: Array.from({ length: VOICE_KEYWORD_SAMPLES }, (_, i) => Array.from(near(p.keyword, i + 1))),
      utterance: Array.from({ length: VOICE_UTTERANCE_SAMPLES }, (_, i) => Array.from(near(p.utterance, i + 11))),
    };
    const res = await c.svc.handle({ op: "enroll_voice", session, consent: true, model: VOICE, ...voice, ...(personId ? { person_id: personId } : { name, minor: false }) });
    if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
    personId = res.people.find((x) => x.name === name)!.person_id;
  }
  await c.svc.handle({ op: "close_session", session });
  return personId!;
}

async function faces(c: Setup, track: number, face: Float32Array, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    c.clock.now += 250;
    const res = await c.svc.handle({ op: "ambient_probe", track, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(face, c.clock.now % 997, 0.03)) });
    expect(res).toMatchObject({ ok: true });
  }
}

function voiceProbe(c: Setup, wakeId: string, segment: VoiceSegment, center: Float32Array | null, voiced = segment === "keyword" ? 700 : 2000): Promise<IdentityResponse> {
  return c.svc.handle({ op: "voice_probe", wake_id: wakeId, segment, voiced_ms: voiced, model: VOICE, ...(center ? { feature: Array.from(near(center, 77, 0.04)) } : {}) });
}

async function greet(c: Setup, interaction: string, track: number, claim: Partial<Claim> = {}): Promise<string | null> {
  c.claims.set(interaction, { route: "api_key", session_id: `rt_${interaction.slice(4)}`, source: "wake_word", ...claim });
  const res = await c.svc.handle({ op: "greeting", interaction, track, eligible: true, route: "api_key" });
  if (!res.ok || res.op !== "greeting") throw new Error(JSON.stringify(res));
  return res.text;
}

const lastDecision = (c: Setup) => c.log.filter((l) => l.includes("問候決策")).at(-1) ?? "";

describe("combineVoice", () => {
  it("two segments pointing at different people conflict; one matched wins over unknown; otherwise the most informative state", () => {
    const m = (person_id: string, segment: VoiceSegment) => ({ state: "matched" as const, person_id, segment });
    expect(combineVoice({ keyword: m("a", "keyword"), utterance: m("b", "utterance") })).toEqual({ state: "ambiguous", conflict: true });
    expect(combineVoice({ keyword: m("a", "keyword"), utterance: { state: "unknown", segment: "utterance" } })).toEqual({ state: "matched", person_id: "a", conflict: false });
    expect(combineVoice({ keyword: { state: "unavailable", reason: "too_short", segment: "keyword" }, utterance: { state: "unknown", segment: "utterance" } })).toMatchObject({ state: "unknown" });
    expect(combineVoice({})).toMatchObject({ state: "unavailable" });
  });

  it("voice alone is never calibrated before SP-03", () => {
    expect(VOICE_CALIBRATED).toEqual({ keyword: false, utterance: false });
  });
});

describe("greeting after a wake: face + voice fusion (docs/17 §7.3)", () => {
  it("face George + keyword George → named, logged as confirmed without names, ids or scores", async () => {
    const c = setup();
    const george = await enroll(c, "George", GEORGE);
    await faces(c, 1, GEORGE.face);
    expect(await voiceProbe(c, wid(1), "keyword", GEORGE.keyword)).toEqual({ ok: true, op: "voice_probe" });
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(NAMED);
    const line = lastDecision(c);
    expect(line).toContain("聲音 喚醒詞 matched／話語 —，融合 confirmed");
    expect(line).not.toMatch(/George|fam_|0\.\d{3}/);
    expect(line).not.toContain(george);
  });

  it("face George + voice Mary → no name (voice_conflict)", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await enroll(c, "Mary", MARY);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "keyword", MARY.keyword);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(PLAIN);
    expect(lastDecision(c)).toMatch(/（api_key，voice_conflict，.*融合 conflict/);
  });

  it("face George + an unknown voice → no name when George has a voice enrolled (voice_unsupported)", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "utterance", STRANGER.utterance);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(PLAIN);
    expect(lastDecision(c)).toMatch(/voice_unsupported，.*話語 unknown，融合 voice_unsupported/);
  });

  it("face George without a voice enrollment + an unknown voice → still named (nothing to compare against)", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE, { face: true, voice: false });
    await enroll(c, "Mary", MARY);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "keyword", STRANGER.keyword);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(NAMED);
    expect(lastDecision(c)).toContain("融合 face_only");
  });

  it("face George + no usable voice (too short, nothing sent, another wake) → ID-02 behaviour, named", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "keyword", null, 0);
    await voiceProbe(c, wid(1), "utterance", GEORGE.utterance, 900);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(NAMED);
    expect(lastDecision(c)).toContain("聲音 喚醒詞 too_short／話語 too_short，融合 face_only");
    c.clock.now += 61_000;
    await faces(c, 2, GEORGE.face);
    await voiceProbe(c, wid(9), "keyword", MARY.keyword);
    expect(await greet(c, id(2), 2, { wake_id: wid(2) })).toMatch(NAMED);
    expect(lastDecision(c)).toContain("聲音 沒有聲音，融合 face_only");
  });

  it("keyword George + utterance Mary → conflict, no name", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await enroll(c, "Mary", MARY);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "keyword", GEORGE.keyword);
    await voiceProbe(c, wid(1), "utterance", MARY.utterance);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(PLAIN);
    expect(lastDecision(c)).toContain("voice_conflict");
  });

  it("voice alone never names before calibration (camera off, or no face evidence)", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await voiceProbe(c, wid(1), "keyword", GEORGE.keyword);
    await voiceProbe(c, wid(1), "utterance", GEORGE.utterance);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(PLAIN);
    expect(lastDecision(c)).toMatch(/no_evidence，.*融合 voice_only/);
    // 鏡頭關閉：聲音照樣收（回應只有 ok），問候不帶名字
    c.camera.on = false;
    c.clock.now += 61_000;
    expect(await voiceProbe(c, wid(2), "keyword", GEORGE.keyword)).toEqual({ ok: true, op: "voice_probe" });
    expect(await greet(c, id(2), 1, { wake_id: wid(2) })).toMatch(PLAIN);
    expect(lastDecision(c)).toContain("（api_key，unavailable，");
  });

  it("look-to-talk greetings ignore voice evidence; wake evidence expires and is used once", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await enroll(c, "Mary", MARY);
    await faces(c, 1, GEORGE.face);
    await voiceProbe(c, wid(1), "keyword", MARY.keyword);
    expect(await greet(c, id(1), 1, { source: "look_to_talk", wake_id: wid(1) })).toMatch(NAMED);
    expect(lastDecision(c)).not.toContain("融合");
    // 過期
    c.clock.now += 61_000;
    await voiceProbe(c, wid(2), "keyword", MARY.keyword);
    c.clock.now += VOICE_EVIDENCE_MS;
    await faces(c, 2, GEORGE.face);
    expect(await greet(c, id(2), 2, { wake_id: wid(2) })).toMatch(NAMED);
    expect(lastDecision(c)).toContain("聲音 沒有聲音");
    // 用過一次就丟掉
    c.clock.now += 61_000;
    await voiceProbe(c, wid(3), "keyword", MARY.keyword);
    await faces(c, 3, GEORGE.face);
    expect(await greet(c, id(3), 3, { wake_id: wid(3) })).toMatch(PLAIN);
    c.clock.now += 61_000;
    await faces(c, 4, GEORGE.face);
    expect(await greet(c, id(4), 4, { wake_id: wid(3) })).toMatch(NAMED);
  });
});

describe("voice_probe", () => {
  it("replies only ok, validates the shape, and is refused without the speaker model or while the manage screen is open", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    expect(await voiceProbe(c, wid(1), "keyword", STRANGER.keyword)).toEqual({ ok: true, op: "voice_probe" });
    expect(await c.svc.handle({ op: "voice_probe", wake_id: "nope", segment: "keyword", voiced_ms: 500, model: VOICE })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await c.svc.handle({ op: "voice_probe", wake_id: wid(1), segment: "other", voiced_ms: 500, model: VOICE })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await c.svc.handle({ op: "voice_probe", wake_id: wid(1), segment: "keyword", voiced_ms: 500, model: { ...VOICE, speaker: "other" } })).toMatchObject({ ok: false, code: "model_mismatch" });
    c.clock.now += 1000;
    const session = await openSession(c);
    expect(await voiceProbe(c, wid(1), "keyword", GEORGE.keyword)).toMatchObject({ ok: false, code: "unavailable", message: "目前不能辨認聲音" });
    await c.svc.handle({ op: "close_session", session });
    const off = setup({ voiceRuntime: "missing" });
    expect(await voiceProbe(off, wid(1), "keyword", GEORGE.keyword)).toMatchObject({ ok: false, code: "unavailable", message: "目前不能辨認聲音" });
  });

  it("is rate limited", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await voiceProbe(c, wid(1), "keyword", GEORGE.keyword));
    expect(results.filter((r) => !r.ok && r.code === "rate_limited")).toHaveLength(2);
  });
});

describe("voice_test (試認聲音)", () => {
  it("returns who the segment matches, without scores; keyword compares with wake-word templates only", async () => {
    const c = setup();
    const george = await enroll(c, "George", GEORGE);
    const mary = await enroll(c, "Mary", MARY, { face: false, voice: true });
    const session = await openSession(c);
    const test = (segment: VoiceSegment, center: Float32Array) => c.svc.handle({ op: "voice_test", session, segment, model: VOICE, feature: Array.from(near(center, 5, 0.04)) });
    expect(await test("keyword", GEORGE.keyword)).toEqual({ ok: true, op: "voice_test", observation: { state: "matched", person_id: george, segment: "keyword" } });
    expect(await test("utterance", MARY.utterance)).toEqual({ ok: true, op: "voice_test", observation: { state: "matched", person_id: mary, segment: "utterance" } });
    // George 的朗讀拿去比喚醒詞模板：不是同一種片段，認不出來
    expect(await test("keyword", GEORGE.utterance)).toMatchObject({ observation: { state: "unknown" } });
    const between = Float32Array.from(GEORGE.utterance.map((x, i) => x + MARY.utterance[i]!));
    const n = Math.hypot(...between);
    expect(await test("utterance", between.map((x) => x / n))).toMatchObject({ observation: { state: "ambiguous", reason: "margin" } });
  });

  it("needs a manage session; with no voices enrolled it says no_enrollment", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE, { face: true, voice: false });
    expect(await c.svc.handle({ op: "voice_test", session: "ids_" + "0".repeat(32), segment: "keyword", model: VOICE, feature: Array.from(GEORGE.keyword) })).toMatchObject({ ok: false, code: "no_session" });
    const session = await openSession(c);
    expect(await c.svc.handle({ op: "voice_test", session, segment: "keyword", model: VOICE, feature: Array.from(GEORGE.keyword) })).toMatchObject({
      ok: true,
      observation: { state: "unavailable", reason: "no_enrollment" },
    });
  });
});

describe("IPC whitelist", () => {
  const feature = Array.from(unitFeature(3, 192));
  it("voice_probe: no session; wake_id, segment, voiced_ms and an optional 192-d feature; extra fields dropped", () => {
    expect(validateIdentityRequest({ op: "voice_probe", wake_id: wid(1), segment: "keyword", voiced_ms: 600, model: VOICE, feature, samples: [1] })).toEqual({
      ok: true,
      request: { op: "voice_probe", wake_id: wid(1), segment: "keyword", voiced_ms: 600, model: VOICE, feature },
    });
    expect(validateIdentityRequest({ op: "voice_probe", wake_id: wid(1), segment: "utterance", voiced_ms: 0, model: VOICE })).toMatchObject({ ok: true });
    expect(validateIdentityRequest({ op: "voice_probe", wake_id: "x", segment: "keyword", voiced_ms: 1, model: VOICE })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ op: "voice_probe", wake_id: wid(1), segment: "keyword", voiced_ms: 1, model: VOICE, feature: feature.slice(1) })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ op: "voice_probe", wake_id: wid(1), segment: "all", voiced_ms: 1, model: VOICE })).toMatchObject({ ok: false });
  });
  it("voice_test: needs a session and a 192-d feature", () => {
    const session = "ids_" + "a".repeat(32);
    expect(validateIdentityRequest({ op: "voice_test", session, segment: "utterance", model: VOICE, feature })).toEqual({ ok: true, request: { op: "voice_test", session, segment: "utterance", model: VOICE, feature } });
    expect(validateIdentityRequest({ op: "voice_test", segment: "utterance", model: VOICE, feature })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ op: "voice_test", session, segment: "utterance", model: VOICE })).toMatchObject({ ok: false });
  });
});

describe("voice-only naming test switch (George 2026-11-01, off by default)", () => {
  it("on: not looking at the screen (no face evidence) or camera off → the voice alone names George; face candidates for memory stay face-only", async () => {
    const c = setup({ voiceNameTest: true });
    await enroll(c, "George", GEORGE);
    await voiceProbe(c, wid(1), "keyword", GEORGE.keyword);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(NAMED);
    expect(lastDecision(c)).toMatch(/（api_key，ok，.*融合 voice_only_test/);
    expect(c.svc.memoryCandidate()).toBeNull();
    c.camera.on = false;
    c.clock.now += 61_000;
    await voiceProbe(c, wid(2), "utterance", GEORGE.utterance);
    expect(await greet(c, id(2), 1, { wake_id: wid(2) })).toMatch(NAMED);
  });

  it("on: still no name for a stranger's face, several faces, a face that is someone else, look-to-talk, an unknown voice, or naming off", async () => {
    const c = setup({ voiceNameTest: true });
    await enroll(c, "George", GEORGE);
    await enroll(c, "Mary", MARY);
    const round = async (n: number, setupFaces: () => Promise<void>, claim: Partial<Claim> = {}, voice = GEORGE.keyword) => {
      c.clock.now += 61_000;
      await setupFaces();
      await voiceProbe(c, wid(n), "keyword", voice);
      return greet(c, id(n), n, { wake_id: wid(n), ...claim });
    };
    expect(await round(1, () => faces(c, 1, STRANGER.face))).toMatch(PLAIN);
    expect(lastDecision(c)).toContain("（api_key，unknown，");
    expect(
      await round(2, async () => {
        for (let i = 0; i < 3; i++) {
          c.clock.now += 250;
          await c.svc.handle({ op: "ambient_probe", track: 2, model: MODEL, face_count: 2, quality: "multi_face" });
        }
      }),
    ).toMatch(PLAIN);
    expect(await round(3, () => faces(c, 3, MARY.face))).toMatch(PLAIN);
    expect(lastDecision(c)).toContain("voice_conflict");
    expect(await round(4, async () => {}, { source: "look_to_talk" })).toMatch(PLAIN);
    expect(await round(5, async () => {}, {}, STRANGER.keyword)).toMatch(PLAIN);
    c.prefs.look_to_talk_greet_name = false;
    expect(await round(6, async () => {})).toMatch(PLAIN);
    expect(lastDecision(c)).toContain("naming_off");
  });

  it("off (default): the same voice-only wake stays unnamed", async () => {
    const c = setup();
    await enroll(c, "George", GEORGE);
    await voiceProbe(c, wid(1), "keyword", GEORGE.keyword);
    expect(await greet(c, id(1), 1, { wake_id: wid(1) })).toMatch(PLAIN);
    c.voiceNameTest.on = true;
    c.clock.now += 61_000;
    await voiceProbe(c, wid(2), "keyword", GEORGE.keyword);
    expect(await greet(c, id(2), 1, { wake_id: wid(2) })).toMatch(NAMED);
  });
});
