// 家人辨識 ID-01 雲端 UI 煙霧測試：真的 dist 頁面＋真的核心（identity 注入，SecretBox 替身），
// 以 Playwright 的 exposeFunction 模擬 preload 的 nousDesktop.identity（Electron IPC 不在雲端），
// 選單列指令以 nous:command 事件模擬，點擊時間窗以 harness 的 clickAt 模擬 main.mjs 的 MenuClickWindow。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const APP = process.env.APP_DIR ?? fileURLToPath(new URL("../../../prototype/ambient-shell", import.meta.url));
const { startNous } = await import(`${APP}/server/nous.ts`);
const { MenuClickWindow, validateIdentityRequest } = await import(`${APP}/desktop/identity-ipc.mjs`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const tmp = mkdtempSync(join(tmpdir(), "id01-ui-"));
const logs: string[] = [];
const confirms: unknown[] = [];
const core = await startNous({
  envFile: null, dataDir: join(tmp, "data"), distDir: join(APP, "dist"), fallbackPort: true,
  overrides: { NOUS_CONFIG_DIR: join(tmp, "config"), NOUS_PROVIDER: "mock", NOUS_CAMERA: "on", PORT: "18788" },
  identity: {
    dir: join(tmp, "identity"),
    secretBox: { available: () => true, seal: (s: string) => Buffer.from(s).reverse(), open: (b: Buffer) => Buffer.from(b).reverse().toString() },
    confirm: async (r: unknown) => { confirms.push(r); return true; },
    modelDir: join(APP, "face-runtime"),
  },
  log: (l: string) => logs.push(l),
});
const click = new MenuClickWindow();
const browser = await chromium.launch();
const page = await browser.newPage();
const ipc: string[] = [];
await page.exposeFunction("__identityIpc", async (req: unknown) => {
  const checked = validateIdentityRequest(req);
  if (!checked.ok) return { ok: false, code: "bad_request", message: checked.error };
  ipc.push(checked.request.op);
  return core.identity.handle(checked.request, { userInitiated: checked.request.op === "open_session" ? click.consume(Date.now()) : false });
});
await page.addInitScript(`window.nousDesktop = { openExternal() {}, reportState() {}, identity: (r) => window.__identityIpc(r) };`);
const offOrigin: string[] = [];
page.on("request", (r: any) => { if (!r.url().startsWith(core.url)) offOrigin.push(r.url()); });
await page.goto(core.url);
await page.waitForTimeout(500);
const out: Record<string, unknown> = {};
// 1. 沒點選單列，頁面腳本自己發 family 指令：核心拒絕開 session
await page.evaluate(`window.dispatchEvent(new CustomEvent("nous:command", { detail: "family" }))`);
await page.waitForTimeout(500);
out.without_click = (await page.textContent(".surface--family"))?.slice(0, 120);
await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
await page.click(".surface--family .btn--ghost").catch(() => {});
await page.waitForTimeout(200);
// 2. 點了選單列（main.mjs 記錄點擊）→ 打開
click.mark(Date.now());
await page.evaluate(`window.dispatchEvent(new CustomEvent("nous:command", { detail: "family" }))`);
await page.waitForSelector(".surface--family >> text=新增家人");
out.opened = (await page.textContent(".surface--family"))?.slice(0, 200);
out.visibility_reason = await page.getAttribute(".surface--family", "data-visibility-reason");
// 3. 試認：瀏覽器沒有雙目鏡頭與 pose 模型（沒有 vision:setup），管線沒有畫面 → 照實說鏡頭沒有在運作
await page.click("text=試認");
await page.waitForTimeout(1500);
out.try = (await page.textContent(".family-try"))?.trim();
await page.click("text=停止試認");
// 4. 收起 → close_session
await page.click(".surface--family >> text=收起");
await page.waitForTimeout(300);
out.after_close_surface = await page.$(".surface--family").then((e: unknown) => e !== null);
out.ipc_ops = ipc;
out.settings_identity = await (await fetch(`${core.url}/api/settings`)).json().then((s: any) => s.identity);
out.off_origin_requests = offOrigin;
out.confirms = confirms;
out.core_log = logs.filter((l) => /identity|家人/.test(l));
console.log(JSON.stringify(out, null, 2));
await browser.close();
await core.close();
rmSync(tmp, { recursive: true, force: true });
