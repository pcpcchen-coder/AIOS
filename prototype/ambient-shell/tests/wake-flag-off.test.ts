import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsMenu } from "../desktop/settings-menu.mjs";
import { startNous, type NousHandle } from "../server/nous.ts";
import { pageHeaders } from "../server/page-headers.ts";
import type { SettingsView } from "../shared/types.ts";

// WK-01a（docs/17 §13.4）：NOUS_WAKE 預設關閉。關閉時頁面標頭、/api/settings 與選單列「鏡頭與語音設定」必須和加入喚醒程式
// 之前逐位元組相同。快照檔（__snapshots__/wake-flag-off.test.ts.snap）是在 base 9778b41、還沒有任何喚醒程式時先產生的，
// 之後的變更不得更新它；需要更新代表旗標關閉時的行為變了，要另行說明。

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-wake-flag-off-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
  rmSync(root, { recursive: true, force: true });
});

/** 固定的環境：不讀 process.env 裡可能存在的金鑰或旗標（startNous 先放 process.env，再以 overrides 蓋過）。 */
async function boot(extra: Record<string, string> = {}): Promise<NousHandle> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  core = await startNous({
    envFile: null,
    dataDir: join(root, "data"),
    distDir: dist,
    fallbackPort: true,
    overrides: {
      NOUS_CONFIG_DIR: join(root, "config"),
      NOUS_PROVIDER: "mock",
      PORT: String(await freePort()),
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      NOUS_CAMERA: "on",
      NOUS_REALTIME_ROUTE: "",
      NOUS_EARLY_SPEECH_RMS: "",
      NOUS_MEMORY_ROUTES: "",
      SMARTHOME_URL: "",
      SMARTHOME_TOKEN: "",
      NOUS_REALTIME_MCP: "",
      ...extra,
    },
    log: () => {},
  });
  return core;
}

/** 選單範本去掉 click（函式）後的 JSON：比對標籤、勾選、停用與順序。 */
function menuJson(view: SettingsView): string {
  return JSON.stringify(settingsMenu(view, { command: () => {}, setMenuPref: () => {}, openFamily: () => {} }), null, 1);
}

describe("NOUS_WAKE off is byte-identical to the pre-wake build", () => {
  it("page headers (camera off and on)", () => {
    expect(JSON.stringify(pageHeaders(false))).toMatchSnapshot();
    expect(JSON.stringify(pageHeaders(true))).toMatchSnapshot();
  });

  it("served page headers, /api/settings and the settings menu", async () => {
    const handle = await boot();
    const page = await fetch(`${handle.url}/`);
    expect(JSON.stringify(Object.fromEntries(["content-security-policy", "permissions-policy", "x-content-type-options", "referrer-policy"].map((h) => [h, page.headers.get(h)])))).toMatchSnapshot();
    const body = await (await fetch(`${handle.url}/api/settings`)).text();
    expect(body).toMatchSnapshot();
    expect(menuJson(JSON.parse(body) as SettingsView)).toMatchSnapshot();
  });

  it("has no wake route, no wake settings and /wake-runtime/ is 404 (not the SPA fallback)", async () => {
    const handle = await boot();
    const view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view).not.toHaveProperty("wake");
    const post = await fetch(`${handle.url}/api/settings/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wake_listen: true }) });
    expect(post.status).toBe(404);
    for (const path of ["/wake-runtime/", "/wake-runtime/x.wasm", "/wake-runtime/sub/index.html"]) {
      expect((await fetch(`${handle.url}${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${handle.url}/wake-runtime/x.wasm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("WK-02: with the flag off a wake_word start is answered exactly like a user start (no interaction ID, no rate limit)", async () => {
    const handle = await boot();
    const start = async (body: unknown) => (await fetch(`${handle.url}/api/realtime/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
    const user = await start({});
    for (let i = 0; i < 4; i++) expect(await start({ source: "wake_word", wake_id: "int_00000000000000ff" })).toBe(user);
    expect(user).not.toContain("wake_limited");
  });

  // 刻意的例外（George 2026-10-31「一律記錄，不綁喚醒開關」）：F6 費用紀錄不受 NOUS_WAKE 影響。旗標關閉時也有
  // GET /api/realtime/cost-records、/api/realtime/end 也讀 reason／usage、每通都寫 voice-cost.jsonl。上面的快照（標頭、
  // /api/settings、選單列）不含 F6，所以仍然逐位元組相同；「逐位元組相同」的說法不包含 F6。
  it("WK-02 (F6) is the one intentional, user-approved exception: cost records are on even with the flag off", async () => {
    const handle = await boot();
    const records = await fetch(`${handle.url}/api/realtime/cost-records?limit=5`);
    expect(records.status).toBe(200);
    expect(await records.json()).toEqual({ records: [] });
    const end = await fetch(`${handle.url}/api/realtime/end`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: `rt_${"0".repeat(32)}`, owner: `own_${"a".repeat(32)}`, reason: "no_voice", usage: { input_tokens: 5 } }) });
    expect(end.status).toBe(200);
    // 沒有任何通話：還沒有檔案（不是因為旗標）
    expect(existsSync(join(root, "config", "voice-cost.jsonl"))).toBe(false);
  });
});
