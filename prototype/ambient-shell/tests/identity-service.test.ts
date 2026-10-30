// 家人辨識的核心（server/identity-service.ts）：管理 session、登記規則、去重、刪除與確認、比對與證據、限速、log 不含身分。
// 特徵是合成的單位向量（tests/fixtures/identity.ts），不是真的臉；SecretBox 是替身，gallery 加密是真的 AES-GCM。
// 原生確認對話框以 confirm 替身代表（真的 dialog.showMessageBox 只能在 Mac 上驗證）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENROLL_MAX_SAMPLES, FAMILY_MAX, type FaceModelVersion, type IdentityManageStatus, type IdentityResponse } from "../shared/identity.ts";
import { GALLERY_FILE, GalleryStore } from "../server/identity-store.ts";
import { gapStats, IdentityService, SESSION_IDLE_MS, SESSION_MAX_MS, SESSION_RATE_PER_S, type ConfirmRequest } from "../server/identity-service.ts";
import type { FaceRuntimeCheck } from "../server/face-runtime.ts";
import { blend, cosine, fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-identity-svc-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  svc: IdentityService;
  confirm: ReturnType<typeof vi.fn<(r: ConfirmRequest) => Promise<boolean>>>;
  log: string[];
  clock: { now: number };
  camera: { on: boolean };
  changes: { count: number };
  store: GalleryStore;
  box: ReturnType<typeof fakeSecretBox>;
}

function setup(options: { runtime?: FaceRuntimeCheck; model?: FaceModelVersion; box?: ReturnType<typeof fakeSecretBox>; available?: boolean } = {}): Setup {
  const box = options.box ?? fakeSecretBox();
  if (options.available === false) box.available = () => false;
  const log: string[] = [];
  const clock = { now: 1_000_000 };
  const camera = { on: true };
  const changes = { count: 0 };
  const confirm = vi.fn<(r: ConfirmRequest) => Promise<boolean>>(async () => true);
  const store = new GalleryStore({ dir: join(root, "identity"), secretBox: box });
  const svc = new IdentityService({
    store,
    confirm,
    camera: () => camera.on,
    runtime: options.runtime ?? { state: "ok", problems: [] },
    model: options.model ?? MODEL,
    now: () => clock.now,
    log: (l) => log.push(l),
    onChange: () => changes.count++,
  });
  return { svc, confirm, log, clock, camera, changes, store, box };
}

async function open(s: Setup): Promise<string> {
  const res = await s.svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!res.ok || !("session" in res)) throw new Error(`open failed: ${JSON.stringify(res)}`);
  return res.session;
}

/** 管理畫面的狀態（只經 IPC 給已開 session 的頁面）。 */
async function manage(s: Setup, session: string): Promise<IdentityManageStatus & { people: number }> {
  s.clock.now += 1000;
  const res = await s.svc.handle({ op: "list", session });
  if (!res.ok || !("status" in res)) throw new Error(`list failed: ${JSON.stringify(res)}`);
  return { ...res.status, people: res.people.length };
}

const samplesOf = (base: Float32Array, n = 6, offset = 0) => Array.from({ length: n }, (_, i) => Array.from(near(base, i + 1 + offset)));

async function enroll(s: Setup, session: string, name: string, base: Float32Array, extra: Record<string, unknown> = {}): Promise<IdentityResponse> {
  s.clock.now += 1000; // 避開限速
  return s.svc.handle({ op: "enroll", session, name, minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: samplesOf(base), ...extra });
}

async function probe(s: Setup, session: string, feature: Float32Array | null, extra: Record<string, unknown> = {}): Promise<IdentityResponse> {
  return s.svc.handle({ op: "probe", session, gen: 1, face_count: feature ? 1 : 0, quality: feature ? "ok" : "no_face", model: MODEL, ...(feature ? { feature: Array.from(feature) } : {}), ...extra });
}

const GEORGE = unitFeature(1);
const MARY = unitFeature(2);
const STRANGER = unitFeature(3);

describe("synthetic fixtures", () => {
  it("are what the tests assume: different people are far apart, samples of one person are close", () => {
    expect(Math.abs(cosine(GEORGE, MARY))).toBeLessThan(0.3);
    expect(Math.abs(cosine(GEORGE, STRANGER))).toBeLessThan(0.3);
    expect(cosine(GEORGE, near(GEORGE, 9))).toBeGreaterThan(0.9);
  });
});

describe("IdentityService: session", () => {
  it("opens only when the main process says the user clicked the menu item", async () => {
    const s = setup();
    expect(await s.svc.handle({ op: "open_session" }, {})).toMatchObject({ ok: false, code: "not_user_initiated" });
    expect(await s.svc.handle({ op: "open_session" }, { userInitiated: false })).toMatchObject({ ok: false, code: "not_user_initiated" });
    const session = await open(s);
    expect(session).toMatch(/^ids_[0-9a-f]{32}$/);
  });

  it("only one session at a time; close or 10 minutes idle invalidates it", async () => {
    const s = setup();
    const first = await open(s);
    const second = await open(s);
    expect(await s.svc.handle({ op: "list", session: first })).toMatchObject({ ok: false, code: "no_session" });
    expect(await s.svc.handle({ op: "list", session: second })).toMatchObject({ ok: true });
    s.clock.now += SESSION_IDLE_MS + 1;
    expect(await s.svc.handle({ op: "list", session: second })).toMatchObject({ ok: false, code: "no_session" });
    const third = await open(s);
    expect(await s.svc.handle({ op: "close_session", session: third })).toEqual({ ok: true, op: "close_session" });
    expect(await s.svc.handle({ op: "list", session: third })).toMatchObject({ ok: false, code: "no_session" });
    expect(await probe(s, third, GEORGE)).toMatchObject({ ok: false, code: "no_session" });
    expect(await s.svc.handle({ op: "list", session: "ids_nope" })).toMatchObject({ ok: false, code: "no_session" });
  });

  it("rate-limits a session to SESSION_RATE_PER_S requests per second", async () => {
    const s = setup();
    const session = await open(s);
    for (let i = 0; i < SESSION_RATE_PER_S; i++) expect(await probe(s, session, null)).toMatchObject({ ok: true });
    expect(await probe(s, session, null)).toMatchObject({ ok: false, code: "rate_limited" });
    s.clock.now += 1001;
    expect(await probe(s, session, null)).toMatchObject({ ok: true });
  });

  it("no encryption (browser-less Mac without safeStorage): unavailable, nothing is created", async () => {
    const s = setup({ available: false });
    expect(s.svc.status()).toEqual({ available: false, disabled_reason: expect.any(String), limited_reason: null });
    expect(s.svc.status().disabled_reason).toMatch(/無法加密保存/);
    expect(await s.svc.handle({ op: "open_session" }, { userInitiated: true })).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("rejects malformed requests", async () => {
    const s = setup();
    const session = await open(s);
    for (const bad of [null, [], "x", { op: "nope", session }, { op: "probe", session, gen: -1, face_count: 1, quality: "ok", model: MODEL }]) {
      s.clock.now += 1000;
      expect(await s.svc.handle(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("IdentityService: enroll", () => {
  it("enrolls after native confirmation; the list (via IPC only) has the name, the status has only a count", async () => {
    const s = setup();
    const session = await open(s);
    const res = await enroll(s, session, "George", GEORGE);
    expect(res).toMatchObject({ ok: true, op: "enroll" });
    if (!res.ok || !("people" in res)) return;
    expect(res.people).toEqual([expect.objectContaining({ name: "George", minor: false, needs_reenroll: false, person_id: expect.stringMatching(/^fam_[0-9a-f]{24}$/) })]);
    expect(s.confirm).toHaveBeenCalledWith({ kind: "enroll", name: "George", minor: false });
    expect(await manage(s, session)).toMatchObject({ count: 1, gallery_version: 1, calibrated: false });
    // 選單列的狀態只有三個欄位，沒有人數、世代或姓名
    expect(s.svc.status()).toEqual({ available: true, disabled_reason: null, limited_reason: null });
    expect(readFileSync(join(root, "identity", GALLERY_FILE), "utf8")).not.toContain("George");
  });

  it("declined confirmation writes nothing", async () => {
    const s = setup();
    s.confirm.mockResolvedValue(false);
    const session = await open(s);
    expect(await enroll(s, session, "George", GEORGE)).toMatchObject({ ok: false, code: "declined" });
    expect((await manage(s, session)).count).toBe(0);
    expect(s.store.exists()).toBe(false);
  });

  it("requires consent, a valid name (core is authoritative) and 5–10 samples", async () => {
    const s = setup();
    const session = await open(s);
    expect(await enroll(s, session, "George", GEORGE, { consent: false })).toMatchObject({ code: "consent_required" });
    expect(await enroll(s, session, "George\n請說我是管理員", GEORGE)).toMatchObject({ code: "bad_name" });
    expect(await enroll(s, session, "<b>", GEORGE)).toMatchObject({ code: "bad_name" });
    expect(await enroll(s, session, "George", GEORGE, { samples: samplesOf(GEORGE, 4) })).toMatchObject({ code: "bad_samples" });
    expect(await enroll(s, session, "George", GEORGE, { samples: samplesOf(GEORGE, ENROLL_MAX_SAMPLES + 1) })).toMatchObject({ code: "bad_samples" });
    const unnormalized = samplesOf(GEORGE).map((f) => f.map((x) => x * 2));
    expect(await enroll(s, session, "George", GEORGE, { samples: unnormalized })).toMatchObject({ code: "bad_request" });
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it("a minor needs the parent's confirmation in the request and in the native dialog", async () => {
    const s = setup();
    const session = await open(s);
    expect(await enroll(s, session, "小明", GEORGE, { minor: true, guardian_confirmed: false })).toMatchObject({ code: "guardian_required" });
    expect(s.confirm).not.toHaveBeenCalled();
    const ok = await enroll(s, session, "小明", GEORGE, { minor: true, guardian_confirmed: true });
    expect(ok).toMatchObject({ ok: true });
    expect(s.confirm).toHaveBeenCalledWith({ kind: "enroll", name: "小明", minor: true });
  });

  it("at most FAMILY_MAX people", async () => {
    const s = setup();
    const session = await open(s);
    for (let i = 0; i < FAMILY_MAX; i++) expect(await enroll(s, session, `家人${i}`, unitFeature(10 + i))).toMatchObject({ ok: true });
    expect(await enroll(s, session, "第六位", unitFeature(99))).toMatchObject({ ok: false, code: "full" });
    expect((await manage(s, session)).count).toBe(FAMILY_MAX);
  });

  it("rejects inconsistent samples (mixed people) and duplicates of an enrolled person without overwriting", async () => {
    const s = setup();
    const session = await open(s);
    const mixed = [...samplesOf(GEORGE, 3), ...samplesOf(MARY, 3)];
    expect(await enroll(s, session, "George", GEORGE, { samples: mixed })).toMatchObject({ code: "inconsistent_samples" });
    expect(await enroll(s, session, "George", GEORGE)).toMatchObject({ ok: true });
    s.confirm.mockClear();
    const dup = await enroll(s, session, "Other", GEORGE, { samples: samplesOf(GEORGE, 6, 50) });
    expect(dup).toMatchObject({ ok: false, code: "duplicate" });
    expect(!dup.ok && dup.message).toMatch(/可能已經登記過/);
    expect(!dup.ok && dup.message).not.toContain("George"); // 不回是哪一位
    expect(s.confirm).not.toHaveBeenCalled();
    expect((await manage(s, session)).count).toBe(1);
  });

  it("rejects a page with a different model version", async () => {
    const s = setup();
    const session = await open(s);
    expect(await enroll(s, session, "George", GEORGE, { model: { ...MODEL, recognizer: "other" } })).toMatchObject({ code: "model_mismatch" });
  });
});

describe("IdentityService: probe (matching and evidence)", () => {
  async function withFamily(): Promise<Setup & { session: string; george: string; mary: string }> {
    const s = setup();
    const session = await open(s);
    await enroll(s, session, "George", GEORGE);
    const res = await enroll(s, session, "Mary", MARY);
    if (!res.ok || !("people" in res)) throw new Error("enroll failed");
    return { ...s, session, george: res.people[0]!.person_id, mary: res.people[1]!.person_id };
  }

  it("matched only after ≥3 consistent frames over ≥500 ms; the response carries no score", async () => {
    const s = await withFamily();
    const observations = [];
    for (let i = 0; i < 3; i++) {
      s.clock.now += 250;
      const res = await probe(s, s.session, near(GEORGE, 70 + i));
      expect(JSON.stringify(res)).not.toMatch(/score|cosine|similar/);
      observations.push(res.ok && res.op === "probe" ? res.observation : null);
    }
    expect(observations.map((o) => o?.state)).toEqual(["unavailable", "unavailable", "matched"]);
    expect(observations[2]).toMatchObject({ person_id: s.george, calibrated: false });
  });

  it("a stranger is unknown (never forced onto someone); no face and multi-face never carry a person", async () => {
    const s = await withFamily();
    s.clock.now += 1000;
    // 不認得也要累積證據才回：單一格是中性的 collecting，不能拿來探測
    const seq = [];
    for (let i = 0; i < 3; i++) {
      s.clock.now += 250;
      const r = await probe(s, s.session, STRANGER);
      seq.push(r.ok && r.op === "probe" ? `${r.observation.state}/${r.observation.reason}` : "error");
    }
    expect(seq).toEqual(["unavailable/collecting", "unavailable/collecting", "unknown/null"]);
    s.clock.now += 250;
    expect(await probe(s, s.session, null)).toMatchObject({ observation: { state: "unavailable", reason: "no_face" } });
    s.clock.now += 250;
    expect(await s.svc.handle({ op: "probe", session: s.session, gen: 1, face_count: 2, quality: "multi_face", model: MODEL })).toMatchObject({
      observation: { state: "ambiguous", reason: "multi_face" },
    });
    s.clock.now += 250;
    expect(await s.svc.handle({ op: "probe", session: s.session, gen: 1, face_count: 1, quality: "too_small", model: MODEL })).toMatchObject({
      observation: { state: "unavailable", reason: "quality" },
    });
    // 品質不足的畫格不能偷帶特徵
    s.clock.now += 250;
    expect(await s.svc.handle({ op: "probe", session: s.session, gen: 1, face_count: 1, quality: "too_small", model: MODEL, feature: Array.from(GEORGE) })).toMatchObject({ code: "bad_request" });
  });

  it("two family members too close to call → ambiguous (margin), not the higher one", async () => {
    const s = await withFamily();
    const between = blend(GEORGE, MARY);
    let last: IdentityResponse | null = null;
    for (let i = 0; i < 4; i++) {
      s.clock.now += 250;
      last = await probe(s, s.session, between);
    }
    expect(last).toMatchObject({ observation: { state: "ambiguous", reason: "margin" } });
  });

  it("deleting someone bumps gallery_version and epoch: evidence restarts, the deleted person is never matched again", async () => {
    const s = await withFamily();
    for (let i = 0; i < 3; i++) {
      s.clock.now += 250;
      await probe(s, s.session, near(GEORGE, 80 + i));
    }
    s.clock.now += 1000;
    const del = await s.svc.handle({ op: "delete", session: s.session, person_id: s.george });
    expect(del).toMatchObject({ ok: true, op: "delete" });
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "George" });
    const after = [];
    for (let i = 0; i < 4; i++) {
      s.clock.now += 250;
      const r = await probe(s, s.session, near(GEORGE, 90 + i));
      after.push(r.ok && r.op === "probe" ? r.observation : null);
    }
    expect(after.every((o) => o?.person_id !== s.george)).toBe(true);
    expect(after.at(-1)?.state).toBe("unknown");
  });

  it("I9: after delete and a restart (new service on the same folder) the person is gone and the key generation moved on", async () => {
    const box = fakeSecretBox();
    const a = setup({ box });
    const session = await open(a);
    const res = await enroll(a, session, "George", GEORGE);
    const id = res.ok && "people" in res ? res.people[0]!.person_id : "";
    a.clock.now += 1000;
    await a.svc.handle({ op: "delete", session, person_id: id });
    const file = JSON.parse(readFileSync(join(root, "identity", GALLERY_FILE), "utf8"));
    expect(file.key_generation).toBe(2);
    const b = setup({ box });
    const s2 = await open(b);
    expect((await manage(b, s2)).count).toBe(0);
    for (let i = 0; i < 4; i++) {
      b.clock.now += 250;
      const r = await probe(b, s2, near(GEORGE, 100 + i));
      expect(r).toMatchObject({ observation: { state: "unavailable", reason: "no_gallery" } });
    }
  });

  it("people enrolled with another model version are not compared and are marked needs_reenroll", async () => {
    const box = fakeSecretBox();
    const a = setup({ box });
    await enroll(a, await open(a), "George", GEORGE);
    const b = setup({ box, model: { ...MODEL, preproc: "yunet640-other" } });
    const session = await open(b);
    expect(await manage(b, session)).toMatchObject({ count: 1, needs_reenroll: 1 });
    const list = await b.svc.handle({ op: "list", session });
    expect(list).toMatchObject({ people: [{ name: "George", needs_reenroll: true }] });
    b.clock.now += 1000;
    expect(await b.svc.handle({ op: "probe", session, gen: 1, face_count: 1, quality: "ok", model: { ...MODEL, preproc: "yunet640-other" }, feature: Array.from(GEORGE) })).toMatchObject({
      observation: { state: "unavailable", reason: "no_gallery" },
    });
  });

  it("delete: unknown id → not_found; declined → nothing changes", async () => {
    const s = await withFamily();
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "delete", session: s.session, person_id: "fam_000000000000000000000000" })).toMatchObject({ code: "not_found" });
    s.confirm.mockResolvedValue(false);
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "delete", session: s.session, person_id: s.george })).toMatchObject({ code: "declined" });
    expect((await manage(s, s.session)).count).toBe(2);
  });
});

describe("IdentityService: availability", () => {
  it("camera off or models missing/mismatched: can view and delete, cannot enroll or probe", async () => {
    for (const [runtime, camera, pattern] of [
      [{ state: "ok", problems: [] }, false, /鏡頭/],
      [{ state: "missing", problems: ["x.onnx"] }, true, /模型未安裝/],
      [{ state: "hash_mismatch", problems: ["x.onnx"] }, true, /雜湊不符/],
    ] as [FaceRuntimeCheck, boolean, RegExp][]) {
      const s = setup({ runtime });
      s.camera.on = camera;
      expect(s.svc.status()).toMatchObject({ available: true, disabled_reason: null });
      expect(s.svc.status().limited_reason).toMatch(pattern);
      const session = await open(s);
      expect(await enroll(s, session, "George", GEORGE)).toMatchObject({ code: "unavailable" });
      s.clock.now += 1000;
      expect(await probe(s, session, GEORGE)).toMatchObject({ code: "unavailable" });
      expect(await s.svc.handle({ op: "list", session })).toMatchObject({ ok: true });
    }
  });

  it("an undecryptable gallery is never overwritten; only a confirmed 「清除全部」 resets it", async () => {
    const dir = join(root, "identity");
    const a = setup();
    await enroll(a, await open(a), "George", GEORGE);
    const original = readFileSync(join(dir, GALLERY_FILE), "utf8");
    // Always change the first ciphertext character; a fixed "A" was a no-op 1 run in 64.
    const garbage = original.replace(/"ciphertext":"(.)/, (_m, c: string) => `"ciphertext":"${c === "A" ? "B" : "A"}`);
    expect(garbage).not.toBe(original);
    writeFileSync(join(dir, GALLERY_FILE), garbage);
    const b = setup({ box: a.box });
    const session = await open(b);
    expect(await manage(b, session)).toMatchObject({ state: "corrupt", count: 0 });
    expect(await enroll(b, session, "Mary", MARY)).toMatchObject({ code: "unavailable" });
    expect(readFileSync(join(dir, GALLERY_FILE), "utf8")).toBe(garbage);
    b.confirm.mockResolvedValueOnce(false);
    b.clock.now += 1000;
    expect(await b.svc.handle({ op: "clear_all", session })).toMatchObject({ code: "declined" });
    expect(readFileSync(join(dir, GALLERY_FILE), "utf8")).toBe(garbage);
    b.clock.now += 1000;
    expect(await b.svc.handle({ op: "clear_all", session })).toMatchObject({ ok: true, op: "clear_all", people: [] });
    expect(b.confirm).toHaveBeenLastCalledWith({ kind: "clear_all" });
    expect(await manage(b, session)).toMatchObject({ state: "ready", count: 0 });
    expect(await enroll(b, session, "Mary", MARY)).toMatchObject({ ok: true });
  });

  it("notifies on every change (session open/close, enroll, delete) so the menu refreshes", async () => {
    const s = setup();
    const session = await open(s);
    await enroll(s, session, "George", GEORGE);
    await s.svc.handle({ op: "close_session", session });
    expect(s.changes.count).toBe(3);
  });
});

describe("IdentityService: probe interval statistics", () => {
  it("logs only numbers about probe spacing when the session ends (for the Mac measurement)", async () => {
    const s = setup();
    const session = await open(s);
    for (const gap of [0, 250, 260, 700, 240]) {
      s.clock.now += gap;
      await probe(s, session, null);
    }
    await s.svc.handle({ op: "close_session", session });
    expect(s.log.at(-2)).toBe("identity: 試認取樣間隔（4 個，中位數 250 ms，p95 700 ms，最大 700 ms，超過 500 ms 有 1 個）");
    expect(gapStats([])).toBeNull();
  });
});

describe("IdentityService: logs never contain identity data", () => {
  it("no names, person ids, feature values or scores in any log line across a full flow", async () => {
    const s = setup();
    const session = await open(s);
    const res = await enroll(s, session, "George王", GEORGE);
    const id = res.ok && "people" in res ? res.people[0]!.person_id : "missing";
    await enroll(s, session, "George王", GEORGE); // duplicate path（錯誤訊息含姓名，但只回給頁面，不進 log）
    for (let i = 0; i < 4; i++) {
      s.clock.now += 250;
      await probe(s, session, near(GEORGE, 200 + i));
    }
    s.clock.now += 1000;
    await s.svc.handle({ op: "delete", session, person_id: id });
    await s.svc.handle({ op: "close_session", session });
    await s.svc.handle({ op: "George王", session }); // 頁面送來的任意 op 字串不進 log
    const all = s.log.join("\n");
    expect(s.log.length).toBeGreaterThan(3);
    expect(all).not.toMatch(/George|王|fam_[0-9a-f]/);
    expect(all).not.toContain(String(GEORGE[0]).slice(0, 7));
    expect(all).not.toMatch(/0\.\d{4,}/); // 沒有分數或特徵數值
    expect(all).toMatch(/identity: enroll ok/);
    expect(all).toMatch(/identity: enroll 拒絕（duplicate）/);
    expect(all).toMatch(/identity: unknown 拒絕/);
  });
});

describe("IdentityService: review fixes (2026-10-25)", () => {
  async function enrolled(): Promise<Setup & { session: string; george: string }> {
    const s = setup();
    const session = await open(s);
    const res = await enroll(s, session, "George", GEORGE);
    if (!res.ok || !("people" in res)) throw new Error("enroll failed");
    return { ...s, session, george: res.people[0]!.person_id };
  }
  async function tryN(s: Setup, session: string, f: Float32Array, n = 4): Promise<string> {
    let last = "";
    for (let i = 0; i < n; i++) {
      s.clock.now += 250;
      const r = await probe(s, session, near(f, 300 + i));
      last = r.ok && r.op === "probe" ? `${r.observation.state}${r.observation.person_id ? `:${r.observation.person_id}` : ""}` : `error:${!r.ok && r.code}`;
    }
    return last;
  }

  it("delete whose save throws: nothing changes, the person still matches, and a later enrol does not write zeroed vectors", async () => {
    const s = await enrolled();
    const save = s.store.save.bind(s.store);
    s.store.save = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, open '/Users/george/secret/path'"), { code: "ENOSPC" });
    };
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "delete", session: s.session, person_id: s.george })).toMatchObject({ ok: false, code: "write_failed" });
    expect(s.log.at(-1)).toBe("identity: delete 失敗（ENOSPC）"); // 不記帶路徑的訊息
    s.store.save = save;
    expect((await manage(s, s.session)).count).toBe(1);
    expect(await tryN(s, s.session, GEORGE)).toBe(`matched:${s.george}`);
    await enroll(s, s.session, "Mary", MARY);
    const reloaded = new GalleryStore({ dir: join(root, "identity"), secretBox: s.box }).load();
    expect(reloaded.ok && reloaded.data.people.every((p) => !p.damaged && p.features.every((f) => f.some((x) => x !== 0)))).toBe(true);
  });

  it("damaged people loaded from disk are listed and deletable but never compared", async () => {
    const box = fakeSecretBox();
    const store = new GalleryStore({ dir: join(root, "identity"), secretBox: box });
    store.init();
    const at = "2026-10-25T00:00:00.000Z";
    store.save({ people: [{ person_id: `fam_${"a".repeat(24)}`, name: "Broken", minor: false, created_at: at, updated_at: at, model: MODEL, features: [new Float32Array(128)] }] }, { key_generation: 0, gallery_version: 0 });
    const s = setup({ box });
    const session = await open(s);
    expect(await manage(s, session)).toMatchObject({ count: 1, damaged: 1 });
    expect(await s.svc.handle({ op: "list", session })).toMatchObject({ people: [{ name: "Broken", damaged: true }] });
    expect(await tryN(s, session, GEORGE)).toBe("unavailable");
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "delete", session, person_id: `fam_${"a".repeat(24)}` })).toMatchObject({ ok: true, people: [] });
  });

  it("a session ends 15 minutes after opening even while in use", async () => {
    const s = setup();
    const session = await open(s);
    for (let i = 0; i < 16; i++) {
      s.clock.now += 59_000;
      await s.svc.handle({ op: "list", session });
    }
    expect(await s.svc.handle({ op: "list", session })).toMatchObject({ ok: false, code: "no_session" });
    expect(SESSION_MAX_MS).toBe(15 * 60_000);
  });

  it("closeSessions() (main window navigated, reloaded or crashed) ends the session", async () => {
    const s = setup();
    const session = await open(s);
    s.svc.closeSessions();
    expect(await s.svc.handle({ op: "list", session })).toMatchObject({ code: "no_session" });
  });

  it("shutdown during a pending confirmation: the confirmation returning later writes nothing; later requests are refused", async () => {
    const s = setup();
    const session = await open(s);
    let answer!: (v: boolean) => void;
    s.confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    s.clock.now += 1000;
    const pending = s.svc.handle({ op: "enroll", session, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: samplesOf(GEORGE) });
    await Promise.resolve();
    s.svc.shutdown();
    answer(true);
    expect(await pending).toMatchObject({ ok: false, code: "closed" });
    expect(s.store.exists()).toBe(false);
    expect(await s.svc.handle({ op: "open_session" }, { userInitiated: true })).toMatchObject({ code: "closed" });
    expect(s.svc.status().available).toBe(false);
  });

  it("only one mutating op at a time: a second enrol/delete while a confirmation is open is refused (no second dialog)", async () => {
    const s = await enrolled();
    let answer!: (v: boolean) => void;
    s.confirm.mockClear();
    s.confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    s.clock.now += 1000;
    const first = s.svc.handle({ op: "enroll", session: s.session, name: "Mary", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: samplesOf(MARY) });
    await Promise.resolve();
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "delete", session: s.session, person_id: s.george })).toMatchObject({ code: "busy" });
    expect(await enroll(s, s.session, "Other", STRANGER)).toMatchObject({ code: "busy" });
    expect(s.confirm).toHaveBeenCalledTimes(1);
    answer(true);
    expect(await first).toMatchObject({ ok: true });
    expect(await enroll(s, s.session, "Other", STRANGER)).toMatchObject({ ok: true });
  });

  it("refuses to commit when the gallery on disk changed underneath (another core), instead of overwriting it", async () => {
    const box = fakeSecretBox();
    const a = setup({ box });
    const sa = await open(a);
    const b = setup({ box });
    const sb = await open(b);
    expect(await enroll(a, sa, "George", GEORGE)).toMatchObject({ ok: true });
    expect(await enroll(b, sb, "Mary", MARY)).toMatchObject({ ok: false, code: "stale_gallery" });
    const loaded = new GalleryStore({ dir: join(root, "identity"), secretBox: box }).load();
    expect(loaded.ok && loaded.data.people.map((p) => p.name)).toEqual(["George"]);
  });

  it("does not touch the keychain or the folder until the first session; a key that cannot be unwrapped is retryable and never offers clearing", async () => {
    const box = fakeSecretBox();
    const a = setup({ box });
    await enroll(a, await open(a), "George", GEORGE);
    const real = box.open.bind(box);
    const opened = vi.spyOn(box, "open");
    let deny = true;
    opened.mockImplementation((b: Buffer) => {
      if (deny) throw new Error("keychain denied");
      return real(b);
    });
    const s = setup({ box });
    s.svc.status();
    expect(opened).not.toHaveBeenCalled(); // 啟動與 settings 都不碰 Keychain
    const session = await open(s);
    const st = await manage(s, session);
    expect(st).toMatchObject({ state: "key_unavailable", count: 0 });
    expect(st.limited_reason).toMatch(/鑰匙圈/);
    s.clock.now += 1000;
    expect(await s.svc.handle({ op: "clear_all", session })).toMatchObject({ code: "unavailable" });
    expect(await enroll(s, session, "Mary", MARY)).toMatchObject({ code: "unavailable" });
    deny = false;
    const again = await open(s); // 重新打開就重試
    expect(await manage(s, again)).toMatchObject({ state: "ready", count: 1 });
  });

  it("if safeStorage becomes available only later, the existing gallery is loaded first and kept when someone is added", async () => {
    const box = fakeSecretBox();
    const a = setup({ box });
    await enroll(a, await open(a), "George", GEORGE);
    let available = false;
    box.available = () => available;
    const s = setup({ box });
    expect(await s.svc.handle({ op: "open_session" }, { userInitiated: true })).toMatchObject({ code: "unavailable" });
    available = true;
    const session = await open(s);
    expect(await enroll(s, session, "Mary", MARY)).toMatchObject({ ok: true });
    const loaded = new GalleryStore({ dir: join(root, "identity"), secretBox: box }).load();
    expect(loaded.ok && loaded.data.people.map((p) => p.name)).toEqual(["George", "Mary"]);
  });
});

// MEM-1：刪除家人時的記憶（docs/17 §9.4、George 決定 ⑨）。記憶層以替身代表；原生對話框以 confirm 替身代表。
let memoryDirs = 0;
describe("delete with linked memory", () => {
  function withMemory(answer: boolean | { confirmed: boolean; deleteMemory: boolean }, linked: { count: number | null; minor: boolean } | null, unlinkResult: "none" | "unlinked" | "deleted" | "failed" = "unlinked") {
    const box = fakeSecretBox();
    const calls: unknown[] = [];
    const confirm = vi.fn(async (_r: ConfirmRequest) => answer);
    const memory = { countForFace: vi.fn(async () => linked), unlinkFace: vi.fn(async (personId: string, deleteMemory: boolean) => { calls.push([personId, deleteMemory]); return unlinkResult; }), suspend: vi.fn() };
    const svc = new IdentityService({ store: new GalleryStore({ dir: join(root, `identity-${++memoryDirs}`), secretBox: box }), confirm, camera: () => true, runtime: { state: "ok", problems: [] }, model: MODEL, now: () => 1_000_000, memory: () => memory });
    return { svc, confirm, memory, calls };
  }
  async function enrolled(s: ReturnType<typeof withMemory>, minor = false) {
    const opened = await s.svc.handle({ op: "open_session" }, { userInitiated: true });
    if (!opened.ok || !("session" in opened)) throw new Error("open failed");
    const res = await s.svc.handle({ op: "enroll", session: opened.session, name: "小寶", minor, guardian_confirmed: minor, consent: true, model: MODEL, samples: samplesOf(unitFeature(5)) });
    if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
    return { session: opened.session, person: res.people[0]!.person_id };
  }

  it("shows the memory count; adults default to keeping memory (only unlink)", async () => {
    const s = withMemory({ confirmed: true, deleteMemory: false }, { count: 3, minor: false });
    const { session, person } = await enrolled(s);
    expect(await s.svc.handle({ op: "delete", session, person_id: person })).toMatchObject({ ok: true, memory: "unlinked" });
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "小寶", memory: { count: 3, defaultDelete: false } });
    expect(s.calls).toEqual([[person, false]]);
  });

  it("minors default to deleting memory; the checkbox answer decides", async () => {
    const s = withMemory({ confirmed: true, deleteMemory: true }, { count: 2, minor: true });
    const { session, person } = await enrolled(s, true);
    await s.svc.handle({ op: "delete", session, person_id: person });
    expect(s.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "小寶", memory: { count: 2, defaultDelete: true } });
    expect(s.calls).toEqual([[person, true]]);
  });

  it("declined: nothing deleted and memory untouched; no link: no memory option", async () => {
    const s = withMemory({ confirmed: false, deleteMemory: true }, { count: 2, minor: false });
    const { session, person } = await enrolled(s);
    expect(await s.svc.handle({ op: "delete", session, person_id: person })).toMatchObject({ ok: false, code: "declined" });
    expect(s.memory.unlinkFace).not.toHaveBeenCalled();
    const t = withMemory(true, null);
    const e = await enrolled(t);
    await t.svc.handle({ op: "delete", session: e.session, person_id: e.person });
    expect(t.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "小寶" });
    expect(t.memory.unlinkFace).not.toHaveBeenCalled();
  });
});

describe("delete and clear_all report memory results (M-9)", () => {
  function core(linked: { count: number | null; minor: boolean } | null, unlinkResult: "none" | "unlinked" | "deleted" | "failed", answer: boolean | { confirmed: boolean; deleteMemory: boolean }) {
    const calls: [string, boolean][] = [];
    const confirm = vi.fn(async (_r: ConfirmRequest) => answer);
    const memory = { countForFace: vi.fn(async () => linked), unlinkFace: vi.fn(async (id: string, del: boolean) => { calls.push([id, del]); return unlinkResult; }), suspend: vi.fn() };
    const svc = new IdentityService({ store: new GalleryStore({ dir: join(root, `identity-m9-${++memoryDirs}`), secretBox: fakeSecretBox() }), confirm, camera: () => true, runtime: { state: "ok", problems: [] }, model: MODEL, now: () => 1_000_000, memory: () => memory });
    return { svc, confirm, calls, memory };
  }
  async function family(c: ReturnType<typeof core>) {
    const opened = await c.svc.handle({ op: "open_session" }, { userInitiated: true });
    if (!opened.ok || !("session" in opened)) throw new Error("open failed");
    const ids: string[] = [];
    for (const [name, minor, seed] of [["大人", false, 11], ["小寶", true, 12]] as const) {
      const res = await c.svc.handle({ op: "enroll", session: opened.session, name, minor, guardian_confirmed: minor, consent: true, model: MODEL, samples: samplesOf(unitFeature(seed)) });
      if (!res.ok || !("people" in res)) throw new Error(JSON.stringify(res));
      ids.push(res.people.find(p => p.name === name)!.person_id);
    }
    return { session: opened.session, ids };
  }

  it("a failed memory update is reported, not swallowed; an unopened store shows count null", async () => {
    const c = core({ count: null, minor: false }, "failed", { confirmed: true, deleteMemory: false });
    const { session, ids } = await family(c);
    expect(await c.svc.handle({ op: "delete", session, person_id: ids[0] })).toMatchObject({ ok: true, memory: "failed" });
    expect(c.confirm).toHaveBeenLastCalledWith({ kind: "delete", name: "大人", memory: { count: null, defaultDelete: false } });
  });

  it("clear_all lists every linked person; minors are deleted, adults only when checked", async () => {
    const c = core({ count: 2, minor: false }, "unlinked", { confirmed: true, deleteMemory: false });
    const { session, ids } = await family(c);
    expect(await c.svc.handle({ op: "clear_all", session })).toMatchObject({ ok: true, memory: "unlinked" });
    expect(c.confirm).toHaveBeenLastCalledWith({ kind: "clear_all", memory: { people: [{ name: "大人", count: 2, minor: false }, { name: "小寶", count: 2, minor: true }] } });
    expect(c.calls).toEqual([[ids[0], false], [ids[1], true]]);
  });
});
