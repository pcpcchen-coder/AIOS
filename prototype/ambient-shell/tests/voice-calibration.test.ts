// SP-03a 聲音校準：只存分數的加密檔、收集 → 建議門檻 → 套用（原生確認）→ 驗證（0 筆陌生聲音被認成家人）→ 只憑聲音稱名；
// 模板重錄後舊分數不採用；清除。驗證的兩個測試各寫 200 多次加密檔（每次 fsync），給 30 秒。特徵是合成的單位向量（不是真的聲音），SecretBox 是替身，加密是真的 AES-GCM／替身 seal。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIdentityRequest } from "../desktop/identity-ipc.mjs";
import { GalleryStore } from "../server/identity-store.ts";
import { IdentityService, type AmbientPrefs, type ConfirmRequest } from "../server/identity-service.ts";
import { SPEAKER_MODEL_VERSION } from "../server/speaker-runtime.ts";
import { CALIBRATION_MIN, CALIBRATION_VERIFY_STRANGERS, VOICE_KEYWORD_SAMPLES, VOICE_UTTERANCE_SAMPLES, type CalibrationReport, type FaceModelVersion, type IdentityResponse, type VoiceSegment } from "../shared/identity.ts";
import { GREETING_TEMPLATES } from "../shared/sense.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const VOICE = SPEAKER_MODEL_VERSION;
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMED = new RegExp(`「(${GREETING_TEMPLATES.filter((t) => t.named).map((t) => esc(t.render("George"))).join("|")})」`);
const PLAIN = new RegExp(`「(${GREETING_TEMPLATES.filter((t) => !t.named).map((t) => esc(t.render(null))).join("|")})」`);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-calib-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const GEORGE = { keyword: unitFeature(11, 192), utterance: unitFeature(12, 192) };

function setup() {
  const clock = { now: 1_000_000 };
  const confirm = vi.fn<(r: ConfirmRequest) => Promise<boolean>>(async () => true);
  const prefs: AmbientPrefs = { look_to_talk: true, look_to_talk_greet: true, look_to_talk_greet_name: true };
  const claims = new Map<string, { route: "api_key"; session_id: string; source: "wake_word"; wake_id: string }>();
  const log: string[] = [];
  const box = fakeSecretBox();
  const dir = join(root, "identity");
  const store = new GalleryStore({ dir, secretBox: box });
  const svc = new IdentityService({
    store,
    confirm,
    camera: () => false,
    ambient: () => prefs,
    wakeGreetingOpen: () => true,
    claimGreeting: (i) => {
      const c = claims.get(i) ?? null;
      claims.delete(i);
      return c;
    },
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    speakerRuntime: { state: "ok", problems: [] },
    speakerModel: VOICE,
    now: () => clock.now,
    log: (l) => log.push(l),
  });
  return { svc, clock, confirm, claims, log, store, dir };
}
type Setup = ReturnType<typeof setup>;

async function session(c: Setup): Promise<string> {
  c.clock.now += 1000;
  const res = await c.svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!res.ok || !("session" in res)) throw new Error(JSON.stringify(res));
  return res.session;
}

async function enrollGeorge(c: Setup, seed = 0): Promise<{ s: string; george: string }> {
  const s = await session(c);
  const voice = {
    keyword: Array.from({ length: VOICE_KEYWORD_SAMPLES }, (_, i) => Array.from(near(GEORGE.keyword, i + 1 + seed))),
    utterance: Array.from({ length: VOICE_UTTERANCE_SAMPLES }, (_, i) => Array.from(near(GEORGE.utterance, i + 11 + seed))),
  };
  const res = await c.svc.handle({ op: "enroll_voice", session: s, consent: true, model: VOICE, name: "George", minor: false, ...voice });
  if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
  // 聲音登記的同意不含雲端稱名說明：另外按「我知道了」
  c.clock.now += 300;
  await c.svc.handle({ op: "ack_naming", session: s });
  return { s, george: res.people[0]!.person_id };
}

let seq = 0;
async function trial(c: Setup, s: string, label: "member" | "stranger", segment: VoiceSegment, feature: Float32Array, person?: string): Promise<CalibrationReport> {
  c.clock.now += 300; // 每秒 6 次的 session 限速
  const res = await c.svc.handle({ op: "calib_trial", session: s, label, segment, voiced_ms: 2500, model: VOICE, feature: Array.from(feature), ...(person ? { person_id: person } : {}) });
  if (!res.ok || res.op !== "calib_trial") throw new Error(JSON.stringify(res));
  return res.report;
}
const memberFeature = (seg: VoiceSegment) => near(GEORGE[seg], 500 + ++seq, 0.06);
const strangerFeature = () => unitFeature(1000 + ++seq, 192);

async function collect(c: Setup, s: string, george: string): Promise<CalibrationReport> {
  let r!: CalibrationReport;
  for (const seg of ["keyword", "utterance"] as const) {
    for (let i = 0; i < CALIBRATION_MIN.member; i++) r = await trial(c, s, "member", seg, memberFeature(seg), george);
    for (let i = 0; i < CALIBRATION_MIN.stranger; i++) r = await trial(c, s, "stranger", seg, strangerFeature());
  }
  return r;
}

const seg = (r: CalibrationReport, s: VoiceSegment) => r.segments.find((x) => x.segment === s)!;

describe("collect → propose", () => {
  it("not enough data → no proposal and apply is refused; enough → threshold = highest stranger + 0.05, reject rate on your samples", async () => {
    const c = setup();
    const { s, george } = await enrollGeorge(c);
    let r = await trial(c, s, "member", "keyword", memberFeature("keyword"), george);
    expect(seg(r, "keyword")).toMatchObject({ member_trials: 1, stranger_trials: 0, proposed: null, applied: false, calibrated: false });
    expect(await c.svc.handle({ op: "calib_apply", session: s })).toMatchObject({ ok: false, code: "bad_samples" });
    expect(c.confirm).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "calib_apply" }));
    r = await collect(c, s, george);
    for (const name of ["keyword", "utterance"] as const) {
      const g = seg(r, name);
      expect(g.member_trials).toBeGreaterThanOrEqual(CALIBRATION_MIN.member);
      expect(g.stranger_trials).toBe(CALIBRATION_MIN.stranger);
      expect(g.proposed!.match).toBeCloseTo(Math.max(0.3, g.stranger_max! + 0.05), 2);
      expect(g.proposed_reject_rate).toBe(0);
      expect(g.member_min!).toBeGreaterThan(g.proposed!.match);
    }
  });

  it("stores only scores, sealed: the file has no plaintext person ids, names or features; a corrupt file reads as none", async () => {
    const c = setup();
    const { s, george } = await enrollGeorge(c);
    await trial(c, s, "member", "keyword", memberFeature("keyword"), george);
    const raw = readFileSync(join(c.dir, "voice-calibration.v1.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ schema_version: 1, sealed: expect.any(String) });
    expect(raw).not.toContain(george);
    expect(raw).not.toContain("George");
    const data = c.store.loadCalibration()!;
    expect(data.trials[0]).toMatchObject({ label: "member", person_id: george, segment: "keyword", phase: "collect" });
    expect(Object.keys(data.trials[0]!)).not.toContain("feature");
    writeFileSync(join(c.dir, "voice-calibration.v1.json"), "{broken");
    expect(c.store.loadCalibration()).toBeNull();
  });
});

describe("apply → verify → voice-only naming", () => {
  it("apply asks the native confirm; then trials are verify; 50+50 strangers with no false accept → calibrated → a wake names George by voice without the test switch", async () => {
    const c = setup();
    const { s, george } = await enrollGeorge(c);
    await collect(c, s, george);
    c.confirm.mockResolvedValueOnce(false);
    expect(await c.svc.handle({ op: "calib_apply", session: s })).toMatchObject({ ok: false, code: "declined" });
    const applied = (await c.svc.handle({ op: "calib_apply", session: s })) as Extract<IdentityResponse, { report: CalibrationReport }>;
    expect(applied.ok).toBe(true);
    expect(c.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "calib_apply", keyword: expect.objectContaining({ match: expect.any(Number) }), utterance: expect.objectContaining({ match: expect.any(Number) }) }));
    expect(seg(applied.report, "keyword")).toMatchObject({ applied: true, calibrated: false });
    expect(seg(applied.report, "keyword").current.match).toBe(seg(applied.report, "keyword").proposed!.match);
    let r!: CalibrationReport;
    for (const name of ["keyword", "utterance"] as const) {
      for (let i = 0; i < CALIBRATION_VERIFY_STRANGERS; i++) r = await trial(c, s, "stranger", name, strangerFeature());
      for (let i = 0; i < 5; i++) r = await trial(c, s, "member", name, memberFeature(name), george);
    }
    expect(seg(r, "keyword").verify).toEqual({ stranger_trials: 50, false_accepts: 0, member_trials: 5, rejects: 0 });
    expect(seg(r, "keyword").calibrated).toBe(true);
    expect(seg(r, "utterance").calibrated).toBe(true);
    await c.svc.handle({ op: "close_session", session: s });
    // 喚醒：只有聲音（鏡頭關），沒有測試開關 → 校準過的片段可以稱名
    c.clock.now += 61_000;
    const wid = "int_00000000000abc01";
    await c.svc.handle({ op: "voice_probe", wake_id: wid, segment: "keyword", voiced_ms: 700, model: VOICE, feature: Array.from(memberFeature("keyword")) });
    c.claims.set("int_0000000000000001", { route: "api_key", session_id: "rt_1", source: "wake_word", wake_id: wid });
    const g = await c.svc.handle({ op: "greeting", interaction: "int_0000000000000001", track: 1, eligible: true, route: "api_key" });
    expect(g.ok && g.op === "greeting" ? g.text : "", c.log.filter((l) => l.includes("問候決策")).at(-1)).toMatch(NAMED);
    expect(c.log.filter((l) => l.includes("問候決策")).at(-1)).toMatch(/融合 voice_only_calibrated.*聲音門檻已校準/);
    expect(c.svc.memoryCandidate("main")).toBeNull();
  }, 30_000);

  it("one stranger taken for George during verification → not calibrated → voice alone still unnamed", async () => {
    const c = setup();
    const { s, george } = await enrollGeorge(c);
    await collect(c, s, george);
    await c.svc.handle({ op: "calib_apply", session: s });
    let r!: CalibrationReport;
    for (const name of ["keyword", "utterance"] as const) {
      for (let i = 0; i < CALIBRATION_VERIFY_STRANGERS - 1; i++) r = await trial(c, s, "stranger", name, strangerFeature());
      r = await trial(c, s, "stranger", name, memberFeature(name)); // 聽起來像 George 的「陌生人」
    }
    expect(seg(r, "keyword").verify.false_accepts).toBe(1);
    expect(seg(r, "keyword").calibrated).toBe(false);
    await c.svc.handle({ op: "close_session", session: s });
    c.clock.now += 61_000;
    const wid = "int_00000000000abc02";
    await c.svc.handle({ op: "voice_probe", wake_id: wid, segment: "keyword", voiced_ms: 700, model: VOICE, feature: Array.from(memberFeature("keyword")) });
    c.claims.set("int_0000000000000002", { route: "api_key", session_id: "rt_2", source: "wake_word", wake_id: wid });
    const g = await c.svc.handle({ op: "greeting", interaction: "int_0000000000000002", track: 1, eligible: true, route: "api_key" });
    expect(g.ok && g.op === "greeting" ? g.text : "").toMatch(PLAIN);
  }, 30_000);
});

describe("validity and clearing", () => {
  it("re-recording the voice invalidates old scores; clear asks the native confirm and returns to starting thresholds", async () => {
    const c = setup();
    const { s, george } = await enrollGeorge(c);
    await collect(c, s, george);
    // 重錄聲音（同一人）：模板版本變了
    c.clock.now += 1000;
    const voice = {
      keyword: Array.from({ length: VOICE_KEYWORD_SAMPLES }, (_, i) => Array.from(near(GEORGE.keyword, i + 31))),
      utterance: Array.from({ length: VOICE_UTTERANCE_SAMPLES }, (_, i) => Array.from(near(GEORGE.utterance, i + 41))),
    };
    expect(await c.svc.handle({ op: "enroll_voice", session: s, consent: true, model: VOICE, person_id: george, ...voice })).toMatchObject({ ok: true });
    c.clock.now += 1000;
    let r = (await c.svc.handle({ op: "calib_status", session: s })) as Extract<IdentityResponse, { report: CalibrationReport }>;
    expect(seg(r.report, "keyword")).toMatchObject({ member_trials: 0, stranger_trials: 0, proposed: null });
    c.confirm.mockResolvedValueOnce(false);
    expect(await c.svc.handle({ op: "calib_clear", session: s })).toMatchObject({ ok: false, code: "declined" });
    r = (await c.svc.handle({ op: "calib_clear", session: s })) as Extract<IdentityResponse, { report: CalibrationReport }>;
    expect(r.ok).toBe(true);
    expect(c.confirm).toHaveBeenLastCalledWith({ kind: "calib_clear" });
    expect(seg(r.report, "keyword")).toMatchObject({ applied: false, current: { match: 0.5, margin: 0.08 } });
    expect(c.store.loadCalibration()).toBeNull();
  });

  it("needs a manage session; IPC keeps only the allowed fields", async () => {
    const c = setup();
    await enrollGeorge(c);
    expect(await c.svc.handle({ op: "calib_status", session: "ids_" + "0".repeat(32) })).toMatchObject({ ok: false, code: "no_session" });
    const feature = Array.from(unitFeature(5, 192));
    const session = "ids_" + "b".repeat(32);
    const person = "fam_" + "1".repeat(24);
    expect(validateIdentityRequest({ op: "calib_trial", session, label: "member", person_id: person, segment: "keyword", voiced_ms: 900, model: VOICE, feature, extra: 1 })).toEqual({
      ok: true,
      request: { op: "calib_trial", session, label: "member", person_id: person, segment: "keyword", voiced_ms: 900, model: VOICE, feature },
    });
    expect(validateIdentityRequest({ op: "calib_trial", session, label: "member", segment: "keyword", voiced_ms: 900, model: VOICE, feature })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ op: "calib_trial", session, label: "stranger", segment: "keyword", voiced_ms: 900, model: VOICE, feature, person_id: person })).toEqual({
      ok: true,
      request: { op: "calib_trial", session, label: "stranger", segment: "keyword", voiced_ms: 900, model: VOICE, feature },
    });
    for (const op of ["calib_status", "calib_apply", "calib_clear"]) expect(validateIdentityRequest({ op, session, x: 1 })).toEqual({ ok: true, request: { op, session } });
  });
});
