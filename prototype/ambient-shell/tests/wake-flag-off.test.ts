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
// 例外（都不是喚醒程式）：F6 費用紀錄（下面另有測試）與 settings.audio（聲音輸入／輸出，2026-11-01；比對前拿掉這個欄位）。

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
    const raw = await (await fetch(`${handle.url}/api/settings`)).text();
    // 第二個刻意的例外（George 2026-11-01「聲音輸入／輸出」）：settings.audio 不綁任何旗標，一定存在。拿掉這一個欄位之後
    // 其餘逐位元組相同（快照不更新）；選單列的「聲音」分段也只來自這個欄位。
    const parsed = JSON.parse(raw) as SettingsView;
    // 「處理中音效」processing_cue（George 2026-11-02）也在這個欄位裡（預設開），一樣不綁旗標。
    expect(parsed.audio).toEqual({ prefs: { input_device_id: null, input_label: null, output_device_id: null, output_label: null, processing_cue: true }, write_path: "/api/settings/audio" });
    // 第三個刻意的例外（George 2026-11-05 PRO-1「主動提醒」）：settings.proactive 不綁旗標（預設開），一定存在；拿掉後其餘逐位元組相同。
    expect(parsed.proactive?.prefs).toEqual({ enabled: true, weather: true, calendar: true, start_hour: 5, end_hour: 11, place: null });
    // 第四個刻意的例外（George 2026-11-06 MEMO-1「回憶模式」）：settings.memories 不綁旗標（預設關），一定存在；拿掉後其餘逐位元組相同。
    expect(parsed.memories?.prefs).toEqual({ enabled: false, dwell_s: 8, idle_s: 60, video_sound: false });
    // 第五個刻意的例外（George 2026-11-07 CLK-1「右上角時鐘與天氣」）：settings.clock 不綁旗標（Mac 視窗預設關），一定存在；拿掉後其餘逐位元組相同。
    expect(parsed.clock).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/clock" });
    // 第六個刻意的例外（George 2026-11-07 HOME-1「左上角家中狀態」）：settings.home_corner 不綁旗標（同時鐘的預設），一定存在；拿掉後其餘逐位元組相同。
    expect(parsed.home_corner).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/home-corner" });
    // 第七個刻意的例外（George 2026-11-08 DN-2「日夜間模式」）：settings.day_night 不綁旗標（預設 22–07、沒有手動切換），一定存在；拿掉後其餘逐位元組相同。
    expect(parsed.day_night).toMatchObject({ prefs: { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true }, override: null, saved: false, write_path: "/api/settings/day-night" });
    // 第八個刻意的例外（George 2026-11-09 ALARM-1「定時器」、ALARM-2「鬧鐘」）：settings.alarms 不綁旗標（預設開），一定存在；定時器與鬧鐘工具是核心內建的
    // 整合工具（不需要 NOUS_AIL），所以 settings.integrations 只列 app__timer__* 與 app__alarm__*。拿掉這兩個欄位後其餘逐位元組相同。
    expect(parsed.alarms).toMatchObject({ prefs: { enabled: true, ring_s: 300, ramp_s: 30, late_ring_max_s: 1800, snooze_s: 540, alarm_min_volume: 30 }, timers: [], alarms: [], snoozes: [], rings: [], notice: null, write_path: "/api/settings/alarms" });
    expect(parsed.integrations?.tools.every((name) => name.startsWith("app__timer__") || name.startsWith("app__alarm__"))).toBe(true);
    const { audio: _audio, proactive: _proactive, memories: _memories, clock: _clock, home_corner: _homeCorner, day_night: _dayNight, alarms: _alarms, integrations: _integrations, ...rest } = parsed;
    // 第九個刻意的例外（George 2026-11-09「查詢結果收起秒數」）：voice.search_close_s 與 seconds 的同名一列不綁旗標，一定存在；
    // 拿掉這兩處後其餘逐位元組相同。
    expect(rest.voice?.search_close_s).toBe(8);
    if (rest.voice) delete (rest.voice as Partial<typeof rest.voice>).search_close_s;
    if (rest.seconds) rest.seconds = rest.seconds.filter((row) => row.key !== "search_close_s");
    const body = JSON.stringify(rest);
    expect(body).toMatchSnapshot();
    expect(menuJson(rest as SettingsView)).toMatchSnapshot();
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
