// 家人辨識 ID-01 雲端端到端（不含 Electron）：真的頁面（含 MediaPipe 感測管線）＋真的核心＋產品 worker，
// Chromium 假鏡頭播放公有領域肖像做成的 2560×720 y4m。preload 的 IPC 以 exposeFunction 模擬，原生確認以替身自動同意，
// SecretBox 是替身。每一段重新啟動核心（同一個 identity 資料夾），也檢查重啟後的狀態。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const APP = process.env.APP_DIR ?? fileURLToPath(new URL("../../../prototype/ambient-shell", import.meta.url));
const [distDir, clipDir] = process.argv.slice(2);
const { startNous } = await import(`${APP}/server/nous.ts`);
const { MenuClickWindow, validateIdentityRequest } = await import(`${APP}/desktop/identity-ipc.mjs`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const tmp = mkdtempSync(join(tmpdir(), "id01-e2e-"));
const results: Record<string, unknown>[] = [];

async function phase(name: string, clip: string, act: (page: any, ctx: { click(): void }) => Promise<Record<string, unknown>>) {
  const logs: string[] = [];
  const confirms: unknown[] = [];
  const core = await startNous({
    envFile: null, dataDir: join(tmp, "data"), distDir, fallbackPort: true,
    overrides: { NOUS_CONFIG_DIR: join(tmp, "config"), NOUS_PROVIDER: "mock", NOUS_CAMERA: "on", NOUS_CAMERA_LABEL: ".y4m", PORT: "18790" },
    identity: {
      dir: join(tmp, "identity"),
      secretBox: { available: () => true, seal: (s: string) => Buffer.from(s).reverse(), open: (b: Buffer) => Buffer.from(b).reverse().toString() },
      confirm: async (r: unknown) => { confirms.push(r); return true; },
      modelDir: join(APP, "face-runtime"),
    },
    log: (l: string) => logs.push(l),
  });
  const click = new MenuClickWindow();
  const probes: { t: number; quality: string; faces: number }[] = [];
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(clipDir, clip)}`, ...(process.env.E2E_FLAGS ? process.env.E2E_FLAGS.split(" ") : [])] });
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  const offOrigin: string[] = [];
  page.on("request", (r: any) => { if (!r.url().startsWith(core.url)) offOrigin.push(r.url()); });
  const consoleErrors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
  await page.exposeFunction("__identityIpc", async (req: unknown) => {
    const checked = validateIdentityRequest(req);
    if (!checked.ok) return { ok: false, code: "bad_request", message: checked.error };
    if (checked.request.op === "probe") probes.push({ t: Date.now(), quality: String(checked.request.quality), faces: Number(checked.request.face_count) });
    return core.identity.handle(checked.request, { userInitiated: checked.request.op === "open_session" ? click.consume(Date.now()) : false });
  });
  await page.addInitScript(`window.nousDesktop = { openExternal() {}, reportState() {}, identity: (r) => window.__identityIpc(r) };`);
  await page.goto(core.url);
  const sensor = await page.waitForSelector('.sensor-indicator[data-state="ok"]', { timeout: 60000 }).then(() => "ok", async () => page.getAttribute(".sensor-indicator", "title"));
  const t0 = Date.now();
  let out: Record<string, unknown> = {};
  try {
    out = await act(page, { click: () => click.mark(Date.now()) });
  } catch (err) {
    out = { error: String(err).slice(0, 300), surface: (await page.textContent(".surface--family").catch(() => null))?.slice(0, 300) };
  }
  const gaps = probes.slice(1).map((p, i) => p.t - probes[i]!.t).sort((a, b) => a - b);
  const q: Record<string, number> = {};
  for (const p of probes) q[p.quality] = (q[p.quality] ?? 0) + 1;
  const probe_stats = gaps.length ? { n: probes.length, interval_median: gaps[Math.floor(gaps.length / 2)], interval_p95: gaps[Math.ceil(0.95 * gaps.length) - 1], interval_max: gaps.at(-1), over_500ms: gaps.filter((g) => g > 500).length, quality: q } : { n: probes.length, quality: q };
  results.push({ phase: name, clip, sensor, ms: Date.now() - t0, ...out, probe_stats, confirms, off_origin_requests: offOrigin, console_errors: consoleErrors.slice(0, 5), core_log: logs.filter((l) => /identity|家人/.test(l)) });
  await browser.close();
  await core.close();
}

const openFamily = async (page: any, ctx: { click(): void }) => {
  ctx.click();
  await page.evaluate(`window.dispatchEvent(new CustomEvent("nous:command", { detail: "family" }))`);
  await page.waitForSelector(".surface--family >> text=試認", { timeout: 10000 });
};

const tryRecognize = async (page: any, want: RegExp) => {
  await page.click("text=試認");
  const t0 = Date.now();
  const seen: string[] = [];
  for (let i = 0; i < 120; i++) {
    const text = ((await page.textContent(".family-result").catch(() => "")) ?? "").trim();
    if (seen.at(-1) !== text) seen.push(text);
    if (want.test(text)) break;
    await page.waitForTimeout(250);
  }
  const ms = Date.now() - t0;
  const label = (await page.textContent(".family-try"))?.includes("門檻未校準");
  await page.click("text=停止試認");
  return { try_sequence: seen, try_ms: ms, uncalibrated_label: label };
};

// 1. 登記 Biden（2013 肖像），送出前跳原生確認（替身同意）；登記前先試認（沒有家人）量取樣間隔
await phase("enroll", "biden_2013.y4m", async (page, ctx) => {
  await openFamily(page, ctx);
  const before = await tryRecognize(page, /還沒有可以比對的家人/);
  await page.click("text=新增家人");
  await page.fill('.surface--family input[type="text"]', "拜登");
  await page.click("text=下一步");
  await page.check(".surface--family .family-check input");
  const t0 = Date.now();
  await page.click("text=開始取樣");
  await page.waitForSelector(".surface--family >> text=已登記「拜登」", { timeout: 60000 });
  const enrollMs = Date.now() - t0;
  const list = (await page.textContent(".family-list"))?.trim();
  const t = await tryRecognize(page, /認得：/);
  return { before_enroll: before, enroll_ms: enrollMs, list, ...t };
});
if (!process.env.E2E_ONLY_FIRST) {
// 2. 重啟核心後，同一人另一張肖像（2021）→ 應認得
await phase("same person, other photo, after restart", "biden_2021.y4m", async (page, ctx) => {
  await openFamily(page, ctx);
  return tryRecognize(page, /認得：/);
});
// 3. 陌生人 → 不認得
await phase("stranger", "obama_2012.y4m", async (page, ctx) => {
  await openFamily(page, ctx);
  return tryRecognize(page, /^不認得$/);
});
// 4. 刪除後（原生確認替身同意），重啟再試同一人 → 沒有可比對的家人
await phase("delete then restart", "biden_2013.y4m", async (page, ctx) => {
  await openFamily(page, ctx);
  await page.click(".family-list >> text=刪除");
  await page.waitForSelector(".surface--family >> text=已永久刪除", { timeout: 10000 });
  return {};
});
await phase("after delete", "biden_2013.y4m", async (page, ctx) => {
  await openFamily(page, ctx);
  return tryRecognize(page, /還沒有可以比對的家人/);
});
}
console.log(JSON.stringify(results, null, 2));
rmSync(tmp, { recursive: true, force: true });
