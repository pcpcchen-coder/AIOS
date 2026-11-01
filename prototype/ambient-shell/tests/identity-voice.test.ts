// SP-01 家人聲音登記：核心（enroll_voice／delete_voice、只有聲音的家人、補拍臉）、加密檔的聲音欄位、IPC 白名單。
// 特徵是合成的單位向量（tests/fixtures/identity.ts），不是真的聲音或臉；SecretBox 是替身，gallery 加密是真的 AES-GCM。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIdentityRequest } from "../desktop/identity-ipc.mjs";
import { GalleryStore } from "../server/identity-store.ts";
import { IdentityService, type ConfirmRequest } from "../server/identity-service.ts";
import { SPEAKER_MODEL_VERSION } from "../server/speaker-runtime.ts";
import { FAMILY_MAX, VOICE_KEYWORD_SAMPLES, VOICE_UTTERANCE_SAMPLES, type FaceModelVersion, type IdentityResponse, type SpeakerModelVersion } from "../shared/identity.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const VOICE: SpeakerModelVersion = SPEAKER_MODEL_VERSION;
const SESSION_RE = /^ids_[0-9a-f]{32}$/;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-identity-voice-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(options: { voiceRuntime?: "ok" | "missing" | "hash_mismatch"; camera?: boolean; dir?: string } = {}) {
  const clock = { now: 1_000_000 };
  const confirm = vi.fn<(r: ConfirmRequest) => Promise<boolean>>(async () => true);
  const store = new GalleryStore({ dir: join(root, options.dir ?? "identity"), secretBox: fakeSecretBox() });
  const svc = new IdentityService({
    store,
    confirm,
    camera: () => options.camera ?? true,
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    speakerRuntime: { state: options.voiceRuntime ?? "ok", problems: [] },
    speakerModel: VOICE,
    now: () => (clock.now += 1000),
  });
  return { svc, confirm, store, clock };
}

async function open(svc: IdentityService): Promise<string> {
  const res = await svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!res.ok || !("session" in res)) throw new Error(JSON.stringify(res));
  expect(res.session).toMatch(SESSION_RE);
  return res.session;
}

/** 一個人的聲音：喚醒詞與朗讀各一個中心，加一點雜訊。 */
function voiceOf(seed: number, overrides: { keyword?: number[][]; utterance?: number[][] } = {}) {
  const kw = unitFeature(seed * 10 + 1, 192);
  const ut = unitFeature(seed * 10 + 2, 192);
  return {
    keyword: overrides.keyword ?? Array.from({ length: VOICE_KEYWORD_SAMPLES }, (_, i) => Array.from(near(kw, i + 1))),
    utterance: overrides.utterance ?? Array.from({ length: VOICE_UTTERANCE_SAMPLES }, (_, i) => Array.from(near(ut, i + 11))),
  };
}

const faceSamples = (seed: number) => Array.from({ length: 6 }, (_, i) => Array.from(near(unitFeature(seed), i + 1)));

async function enrollVoice(svc: IdentityService, session: string, extra: Record<string, unknown>): Promise<IdentityResponse> {
  return svc.handle({ op: "enroll_voice", session, consent: true, model: VOICE, ...voiceOf(1), ...extra });
}

function people(res: IdentityResponse) {
  if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
  return res.people;
}

describe("enroll_voice: a voice-only family member", () => {
  it("is created with face:false / voice:enrolled, survives a reload, and the native confirm says voice only", async () => {
    const s = setup();
    const session = await open(s.svc);
    const res = await enrollVoice(s.svc, session, { name: "阿嬤", minor: false });
    expect(people(res)).toEqual([expect.objectContaining({ name: "阿嬤", face: false, voice: "enrolled", damaged: false, needs_reenroll: false })]);
    expect(s.confirm).toHaveBeenCalledWith({ kind: "enroll_voice", name: "阿嬤", minor: false, existing: false });
    if (res.ok && "status" in res) expect(res.status).toMatchObject({ needs_reenroll: 0, damaged: 0, voice_models: "ok" });
    // 重新載入：只有聲音的家人不是壞資料
    const load = s.store.load();
    expect(load.ok && load.data.people[0]).toMatchObject({ name: "阿嬤", features: [] });
    expect(load.ok && load.data.people[0]!.damaged).toBeUndefined();
    expect(load.ok && load.data.people[0]!.voice!.keyword).toHaveLength(VOICE_KEYWORD_SAMPLES);
  });

  it("works with the camera off (voice does not need the camera or the face models)", async () => {
    const s = setup({ camera: false });
    const session = await open(s.svc);
    expect(people(await enrollVoice(s.svc, session, { name: "阿公", minor: false }))).toHaveLength(1);
  });

  it("needs consent, a valid name, the guardian for a minor, and respects FAMILY_MAX", async () => {
    const s = setup();
    const session = await open(s.svc);
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false, consent: false })).toMatchObject({ ok: false, code: "consent_required" });
    expect(await enrollVoice(s.svc, session, { name: "", minor: false })).toMatchObject({ ok: false, code: "bad_name" });
    expect(await enrollVoice(s.svc, session, { name: "小明", minor: true })).toMatchObject({ ok: false, code: "guardian_required" });
    expect(people(await enrollVoice(s.svc, session, { name: "小明", minor: true, guardian_confirmed: true }))).toHaveLength(1);
    for (let i = 2; i <= FAMILY_MAX; i++) expect((await enrollVoice(s.svc, session, { name: `家人${i}`, minor: false, ...voiceOf(i) })).ok).toBe(true);
    expect(await enrollVoice(s.svc, session, { name: "多一位", minor: false, ...voiceOf(99) })).toMatchObject({ ok: false, code: "full" });
  });

  it("rejects the wrong count, a bad shape, inconsistent segments and a model mismatch before asking to confirm", async () => {
    const s = setup();
    const session = await open(s.svc);
    const v = voiceOf(1);
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false, keyword: v.keyword.slice(1) })).toMatchObject({ ok: false, code: "bad_samples" });
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false, utterance: [...v.utterance.slice(1), [1, 2, 3]] })).toMatchObject({ ok: false, code: "bad_request" });
    // 三句朗讀其實是三個不同的人
    const mixed = [1, 2, 3].map((k) => Array.from(unitFeature(500 + k, 192)));
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false, utterance: mixed })).toMatchObject({ ok: false, code: "inconsistent_samples" });
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false, model: { ...VOICE, speaker: "other@00000000" } })).toMatchObject({ ok: false, code: "model_mismatch" });
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it("refuses a voice that matches another member (duplicate), without saying who", async () => {
    const s = setup();
    const session = await open(s.svc);
    await enrollVoice(s.svc, session, { name: "George", minor: false });
    const again = await enrollVoice(s.svc, session, { name: "George 2", minor: false });
    expect(again).toMatchObject({ ok: false, code: "duplicate" });
    expect(again.ok ? "" : again.message).not.toMatch(/George/);
  });

  it("is unavailable when the speaker model is missing or tampered (face enrollment is unaffected)", async () => {
    for (const state of ["missing", "hash_mismatch"] as const) {
      const s = setup({ voiceRuntime: state, dir: state });
      const session = await open(s.svc);
      const res = await enrollVoice(s.svc, session, { name: "A", minor: false });
      expect(res).toMatchObject({ ok: false, code: "unavailable" });
      expect(res.ok ? "" : res.message).toMatch(state === "missing" ? /speaker:setup/ : /雜湊不符/);
      const face = await s.svc.handle({ op: "enroll", session, name: "B", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: faceSamples(7) });
      expect(face.ok).toBe(true);
    }
  });

  it("declined native confirm saves nothing", async () => {
    const s = setup();
    s.confirm.mockResolvedValueOnce(false);
    const session = await open(s.svc);
    expect(await enrollVoice(s.svc, session, { name: "A", minor: false })).toMatchObject({ ok: false, code: "declined" });
    expect(s.store.load()).toMatchObject({ ok: true, data: { people: [] } });
  });
});

describe("enroll_voice on an existing member, adding a face, delete_voice", () => {
  async function faceOnly(s: ReturnType<typeof setup>, session: string) {
    const res = await s.svc.handle({ op: "enroll", session, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: faceSamples(1) });
    return people(res)[0]!;
  }

  it("adds a voice to a face-enrolled member (name and minor come from the stored person) and replaces it on re-record", async () => {
    const s = setup();
    const session = await open(s.svc);
    const george = await faceOnly(s, session);
    const res = await enrollVoice(s.svc, session, { person_id: george.person_id, name: "ignored", minor: true });
    expect(people(res)).toEqual([expect.objectContaining({ person_id: george.person_id, name: "George", minor: false, face: true, voice: "enrolled" })]);
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "enroll_voice", name: "George", minor: false, existing: true });
    // 重錄：自己的舊聲音不算重複
    expect((await enrollVoice(s.svc, session, { person_id: george.person_id })).ok).toBe(true);
    expect(await enrollVoice(s.svc, session, { person_id: "fam_000000000000000000000000" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("can add a face to a voice-only member (enroll with person_id), but not a second face", async () => {
    const s = setup();
    const session = await open(s.svc);
    const grandma = people(await enrollVoice(s.svc, session, { name: "阿嬤", minor: false }))[0]!;
    const res = await s.svc.handle({ op: "enroll", session, person_id: grandma.person_id, name: "x", minor: true, guardian_confirmed: false, consent: true, model: MODEL, samples: faceSamples(2) });
    expect(people(res)).toEqual([expect.objectContaining({ person_id: grandma.person_id, name: "阿嬤", face: true, voice: "enrolled" })]);
    const again = await s.svc.handle({ op: "enroll", session, person_id: grandma.person_id, name: "x", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: faceSamples(3) });
    expect(again).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("delete_voice keeps the face; on a voice-only member it deletes the whole person through the normal delete confirm", async () => {
    const s = setup();
    const session = await open(s.svc);
    const george = await faceOnly(s, session);
    await enrollVoice(s.svc, session, { person_id: george.person_id });
    const kept = await s.svc.handle({ op: "delete_voice", session, person_id: george.person_id });
    expect(kept).toMatchObject({ ok: true, op: "delete_voice" });
    expect(people(kept)).toEqual([expect.objectContaining({ face: true, voice: "none" })]);
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "delete_voice", name: "George" });
    expect(await s.svc.handle({ op: "delete_voice", session, person_id: george.person_id })).toMatchObject({ ok: false, code: "not_found" });

    const grandma = people(await enrollVoice(s.svc, session, { name: "阿嬤", minor: false, ...voiceOf(2) })).find((p) => p.name === "阿嬤")!;
    const gone = await s.svc.handle({ op: "delete_voice", session, person_id: grandma.person_id });
    expect(gone).toMatchObject({ ok: true, op: "delete_voice" });
    expect(people(gone).map((p) => p.name)).toEqual(["George"]);
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "阿嬤" });
  });

  it("a voice-only member never takes part in face matching", async () => {
    const s = setup();
    const session = await open(s.svc);
    await enrollVoice(s.svc, session, { name: "阿嬤", minor: false });
    const res = await s.svc.handle({ op: "probe", session, gen: 1, face_count: 1, quality: "ok", model: MODEL, feature: Array.from(unitFeature(1)) });
    expect(res).toMatchObject({ ok: true, op: "probe", observation: { state: "unavailable", reason: "no_gallery" } });
  });

  it("a voice from another speaker model is listed as needs_reenroll", async () => {
    const s = setup();
    const session = await open(s.svc);
    await enrollVoice(s.svc, session, { name: "阿嬤", minor: false });
    const load = s.store.load();
    if (!load.ok) throw new Error("load");
    load.data.people[0]!.voice!.model = { ...VOICE, speaker: "older@11111111" };
    s.store.save(load.data, load);
    const s2 = new IdentityService({ store: s.store, confirm: s.confirm, camera: () => true, runtime: { state: "ok", problems: [] }, model: MODEL, speakerRuntime: { state: "ok", problems: [] }, speakerModel: VOICE });
    const res = await s2.handle({ op: "open_session" }, { userInitiated: true });
    expect(people(res)).toEqual([expect.objectContaining({ voice: "needs_reenroll", damaged: false })]);
  });
});

describe("gallery store: voice field", () => {
  it("a person with neither face nor voice, or with a malformed voice, is damaged; the malformed voice is written back unchanged", () => {
    mkdirSync(join(root, "g"), { recursive: true });
    const store = new GalleryStore({ dir: join(root, "g"), secretBox: fakeSecretBox() });
    const at = new Date(0).toISOString();
    const good = { model: VOICE, keyword: [unitFeature(1, 192)], utterance: [unitFeature(2, 192)], updated_at: at };
    const bad = { model: VOICE, keyword: [new Float32Array(192)], utterance: [unitFeature(3, 192)], updated_at: at };
    const base = { minor: false, created_at: at, updated_at: at, model: MODEL };
    let v = store.save(
      {
        people: [
          { ...base, person_id: "fam_000000000000000000000001", name: "voice", features: [], voice: good },
          { ...base, person_id: "fam_000000000000000000000002", name: "nothing", features: [] },
          { ...base, person_id: "fam_000000000000000000000003", name: "badvoice", features: [unitFeature(4)], voice: bad },
        ],
      },
      { key_generation: 0, gallery_version: 0 },
    );
    let load = store.load();
    if (!load.ok) throw new Error("load");
    expect(load.data.people.map((p) => [p.name, p.damaged === true])).toEqual([["voice", false], ["nothing", true], ["badvoice", true]]);
    v = store.save(load.data, v);
    load = store.load();
    if (!load.ok) throw new Error("load");
    expect(Array.from(load.data.people[2]!.voice!.keyword[0]!)).toEqual(Array.from(new Float32Array(192)));
  });
});

describe("IPC whitelist: enroll_voice / delete_voice", () => {
  const SESSION = `ids_${"a".repeat(32)}`;
  const PERSON = `fam_${"b".repeat(24)}`;
  const feature = () => Array.from(unitFeature(5, 192));
  const base = {
    op: "enroll_voice",
    session: SESSION,
    consent: true,
    model: VOICE,
    keyword: Array.from({ length: VOICE_KEYWORD_SAMPLES }, feature),
    utterance: Array.from({ length: VOICE_UTTERANCE_SAMPLES }, feature),
  };

  it("new person: name and minor are required; extra fields are dropped", () => {
    expect(validateIdentityRequest({ ...base, name: "阿嬤", minor: false, audio: [1, 2, 3] })).toEqual({ ok: true, request: { ...base, name: "阿嬤", minor: false } });
    expect(validateIdentityRequest({ ...base, minor: false })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, name: "A" })).toMatchObject({ ok: false });
  });

  it("existing person: person_id instead of name/minor; shapes are exact", () => {
    expect(validateIdentityRequest({ ...base, person_id: PERSON, name: "x", minor: true })).toEqual({ ok: true, request: { ...base, person_id: PERSON } });
    expect(validateIdentityRequest({ ...base, person_id: "fam_x" })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, person_id: PERSON, keyword: base.keyword.slice(1) })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, person_id: PERSON, utterance: [...base.utterance.slice(1), feature().slice(1)] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, person_id: PERSON, model: { speaker: "a" } })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, person_id: PERSON, guardian_confirmed: "yes" })).toMatchObject({ ok: false });
  });

  it("delete_voice needs a person_id; enroll accepts an optional person_id", () => {
    expect(validateIdentityRequest({ op: "delete_voice", session: SESSION, person_id: PERSON })).toEqual({ ok: true, request: { op: "delete_voice", session: SESSION, person_id: PERSON } });
    expect(validateIdentityRequest({ op: "delete_voice", session: SESSION })).toMatchObject({ ok: false });
    const face = Array.from(unitFeature(1));
    const enroll = { op: "enroll", session: SESSION, name: "x", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: [face, face], person_id: PERSON };
    expect(validateIdentityRequest(enroll)).toEqual({ ok: true, request: enroll });
  });
});
