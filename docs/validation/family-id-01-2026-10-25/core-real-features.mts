// 以產品 worker 在雲端算出的真實 SFace 特徵（公有領域肖像，見 ID-00）走一次核心：登記 → 試認 → 重複登記 → 刪除 → 重啟。
// 特徵只在記憶體與系統暫存資料夾，不進 repo。SecretBox 是替身；門檻未校準，這不是準確率。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const APP = process.env.APP_DIR ?? fileURLToPath(new URL("../../../prototype/ambient-shell", import.meta.url));
const report = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const { GalleryStore } = await import(`${APP}/server/identity-store.ts`);
const { IdentityService } = await import(`${APP}/server/identity-service.ts`);
const { FACE_MODEL_VERSION } = await import(`${APP}/server/face-runtime.ts`);
// 特徵從 worker-crosscheck.mts 的報告（features 欄位，只放在 repo 外）讀。
const features: Record<string, number[]> = report.features;
const tmp = mkdtempSync(join(tmpdir(), "id01-core-"));
const box = { available: () => true, seal: (s: string) => Buffer.from(s).reverse(), open: (b: Buffer) => Buffer.from(b).reverse().toString() };
let now = 1_000_000;
const logs: string[] = [];
const make = () =>
  new IdentityService({
    store: new GalleryStore({ dir: join(tmp, "identity"), secretBox: box }),
    confirm: async () => true,
    camera: () => true,
    runtime: { state: "ok", problems: [] },
    model: FACE_MODEL_VERSION,
    now: () => now,
    log: (l: string) => logs.push(l),
  });
const out: Record<string, unknown> = {};
let svc = make();
let open = await svc.handle({ op: "open_session" }, { userInitiated: true });
let session = open.session;
const sample = (n: string) => Array.from({ length: 6 }, () => features[n]);
now += 1000;
const enrolled = await svc.handle({ op: "enroll", session, name: "拜登", minor: false, guardian_confirmed: false, consent: true, model: FACE_MODEL_VERSION, samples: sample("biden_2013.jpg.rgba") });
out.enroll = enrolled.ok ? "ok" : enrolled.code;
const personId = enrolled.people?.[0]?.person_id;
const tryWith = async (name: string, frames = 4) => {
  const seq: string[] = [];
  for (let i = 0; i < frames; i++) {
    now += 250;
    const r = await svc.handle({ op: "probe", session, gen: 7, face_count: 1, quality: "ok", model: FACE_MODEL_VERSION, feature: features[name] });
    seq.push(r.ok ? `${r.observation.state}${r.observation.reason ? `/${r.observation.reason}` : ""}${r.observation.person_id === personId ? "（拜登）" : ""}` : r.code);
  }
  now += 2000;
  return seq;
};
out.try_biden_2021 = await tryWith("biden_2021.jpg.rgba");
out.try_obama = await tryWith("obama_2012.jpg.rgba");
out.try_harris = await tryWith("harris_2017.jpg.rgba");
now += 1000;
const dup = await svc.handle({ op: "enroll", session, name: "另一位", minor: false, guardian_confirmed: false, consent: true, model: FACE_MODEL_VERSION, samples: sample("biden_2021.jpg.rgba") });
out.duplicate = dup.ok ? "ok" : `${dup.code}：${dup.message}`;
now += 1000;
const mixed = await svc.handle({ op: "enroll", session, name: "混合", minor: false, guardian_confirmed: false, consent: true, model: FACE_MODEL_VERSION, samples: [...sample("harris_2017.jpg.rgba").slice(0, 3), ...sample("obama_2012.jpg.rgba").slice(0, 3)] });
out.mixed = mixed.ok ? "ok" : mixed.code;
now += 1000;
out.delete = (await svc.handle({ op: "delete", session, person_id: personId })).ok ? "ok" : "failed";
svc = make(); // 重啟
open = await svc.handle({ op: "open_session" }, { userInitiated: true });
session = open.session;
out.after_restart_count = open.people.length;
out.try_after_delete = await tryWith("biden_2013.jpg.rgba");
out.log_has_identity = logs.some((l) => /拜登|另一位|fam_[0-9a-f]/.test(l));
out.log = logs;
console.log(JSON.stringify(out, null, 2));
rmSync(tmp, { recursive: true, force: true });
