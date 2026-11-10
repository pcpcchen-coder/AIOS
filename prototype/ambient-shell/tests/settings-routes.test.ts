// 架構重整 S6：每一條 POST /api/settings/* 的狀態碼與回應本體（docs/validation/architecture-s6-settings-routes-2026-11-10.md）。
// 這份測試刻意寫成「重整前的 main 也會通過」：它只描述對外行為（狀態碼、標頭、JSON、訊息字串、檢查與寫入的先後），
// 不 import 重整後才有的模組。全部是本機 HTTP 加模擬引擎（MockExecutor）與暫存資料夾的 fixture，不是產品 gate。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlarmCenter } from "../server/alarms.ts";
import { createApp } from "../server/app.ts";
import { AudioSettingsStore } from "../server/audio-settings.ts";
import { CameraSettingsStore } from "../server/camera-settings.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { ClockSettingsStore } from "../server/clock-settings.ts";
import { loadConfig } from "../server/config.ts";
import { DayNightSettingsStore } from "../server/day-night-settings.ts";
import { FaceTuningStore } from "../server/face-tuning-settings.ts";
import { HomeCornerSettingsStore } from "../server/home-corner-settings.ts";
import { FolderMemoriesSource, memoriesFeature, MemoriesSettingsStore } from "../server/memories.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { ProactiveSettingsStore } from "../server/proactive.ts";
import { ProviderManager } from "../server/providers.ts";
import { RealtimeSettingsStore } from "../server/realtime-settings.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { VoiceSettingsStore } from "../server/voice-settings.ts";
import { WakeSettingsStore } from "../server/wake-settings.ts";
import type { ProactiveSettingsView } from "../shared/proactive.ts";
import type { SettingsView } from "../shared/types.ts";

type Json = Record<string, unknown>;

/** 一條設定寫入路由對外的行為（訊息字串逐字；它們同時是 server/messages.en.json 的鍵）。 */
interface RouteCase {
  name: string;
  path: string;
  /** 會改變設定的合法 patch，與它在 settings 裡對應的那一段。 */
  valid: Json;
  section(view: SettingsView): unknown;
  /** 不合法的 patch 與預期的 400 訊息。 */
  invalid: Json;
  invalidMessage: string;
  /** store 寫入失敗（理由 disk full）時的 500 訊息：中文與 X-Nous-Locale: en。 */
  failed: string;
  failedEn: string;
  /** 沒有提供這個 store 時：409 加訊息，或 404（旗標關閉，等於沒有這條路由）。 */
  missing: { status: 409; message: string } | { status: 404; message: "not found" };
  /** 真實核心裡保存這份設定的檔案（configDir 底下）。 */
  file: string;
}

const CASES: RouteCase[] = [
  {
    name: "camera", path: "/api/settings/camera", valid: { look_to_talk_s: 2 }, section: (v) => v.camera,
    invalid: { look_to_talk_s: 99 }, invalidMessage: "look_to_talk_s 必須是 0.5–5 秒、間隔 0.1",
    failed: "鏡頭設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Camera settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 409, message: "鏡頭未設定" }, file: "camera.json",
  },
  {
    name: "camera-tuning", path: "/api/settings/camera-tuning", valid: { min_face_px: 120 }, section: (v) => v.face_tuning,
    invalid: { nope: 1 }, invalidMessage: "未知的校正值：nope",
    failed: "校正值沒有保存（無法寫入設定檔：disk full）", failedEn: "校正值沒有保存（無法寫入設定檔：disk full）",
    missing: { status: 409, message: "鏡頭未啟用" }, file: "face-tuning.json",
  },
  {
    name: "voice", path: "/api/settings/voice", valid: { voice_idle_s: 120 }, section: (v) => v.voice,
    invalid: { voice_idle_s: 5 }, invalidMessage: "voice_idle_s 必須是 30–600 秒、間隔 10",
    failed: "語音設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Voice settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 409, message: "語音設定未設定" }, file: "voice.json",
  },
  {
    name: "audio", path: "/api/settings/audio", valid: { input_device_id: "mic-a", input_label: "Mic A" }, section: (v) => v.audio?.prefs,
    invalid: {}, invalidMessage: "聲音裝置設定沒有任何欄位",
    failed: "聲音裝置設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Sound device settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 409, message: "聲音裝置設定未設定" }, file: "audio.json",
  },
  {
    name: "wake", path: "/api/settings/wake", valid: { wake_silence_s: 15 }, section: (v) => v.wake,
    invalid: { wake_silence_s: 7 }, invalidMessage: "wake_silence_s 必須是選單裡的秒數（3、5、8、10、15 或 20）",
    failed: "常駐喚醒聆聽設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Always-on wake listening settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "wake.json",
  },
  {
    name: "clock", path: "/api/settings/clock", valid: { main: true }, section: (v) => v.clock?.prefs,
    invalid: { main: "yes" }, invalidMessage: "main 必須是 true 或 false",
    failed: "時鐘設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Clock settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "clock.json",
  },
  {
    name: "alarms", path: "/api/settings/alarms", valid: { ring_s: 60 }, section: (v) => v.alarms?.prefs,
    invalid: { nope: 1 }, invalidMessage: "鬧鐘與定時器的設定值不正確",
    failed: "定時器沒有保存（無法寫入設定檔）", failedEn: "The timer was not saved (could not write the settings file)",
    missing: { status: 404, message: "not found" }, file: "alarms.json",
  },
  {
    name: "day-night", path: "/api/settings/day-night", valid: { night_start_h: 21 }, section: (v) => v.day_night?.prefs,
    invalid: {}, invalidMessage: "沒有要改的日夜間設定",
    failed: "日夜間設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Day/night settings were not saved (could not write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "day-night.json",
  },
  {
    name: "home-corner", path: "/api/settings/home-corner", valid: { main: true }, section: (v) => v.home_corner?.prefs,
    invalid: { nope: true }, invalidMessage: "未知的家中狀態設定：nope",
    failed: "家中狀態設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Home status settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "home-corner.json",
  },
  {
    name: "proactive", path: "/api/settings/proactive", valid: { start_hour: 6 }, section: (v) => v.proactive?.prefs,
    invalid: { enabled: "yes" }, invalidMessage: "enabled 必須是 true 或 false",
    failed: "主動提醒設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Proactive briefing settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "proactive.json",
  },
  {
    name: "memories", path: "/api/settings/memories", valid: { dwell_s: 12 }, section: (v) => v.memories?.prefs,
    invalid: { enabled: 1 }, invalidMessage: "enabled 必須是 true 或 false",
    failed: "回憶模式設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Memories settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 404, message: "not found" }, file: "memories.json",
  },
  {
    name: "realtime", path: "/api/settings/realtime", valid: { route: "api_key" }, section: (v) => (v as unknown as { realtime_prefs_probe?: unknown }).realtime_prefs_probe,
    invalid: { route: "fastest" }, invalidMessage: "route 只能是 auto、live、api_key",
    failed: "即時語音設定沒有保存（無法寫入設定檔：disk full）", failedEn: "Realtime voice settings were not saved (cannot write the settings file: disk full)",
    missing: { status: 409, message: "即時語音路徑設定未設定" }, file: "realtime.json",
  },
];

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

interface Reply {
  status: number;
  headers: { "content-type": string | null; "cache-control": string | null };
  body: Json;
}

/** 一個核心的 HTTP 用戶端。alarms.server_now 是回應當下的時間，比對前換成 0。 */
function client(base: string) {
  const read = async (res: Response): Promise<Reply> => {
    const body = (await res.json()) as Json;
    const alarms = body.alarms as Json | undefined;
    if (alarms && typeof alarms.server_now === "number") alarms.server_now = 0;
    return { status: res.status, headers: { "content-type": res.headers.get("content-type"), "cache-control": res.headers.get("cache-control") }, body };
  };
  const headers = (extra: Record<string, string>) => ({ "Content-Type": "application/json", ...extra });
  return {
    post: async (path: string, body: unknown, extra: Record<string, string> = {}) => read(await fetch(base + path, { method: "POST", headers: headers(extra), body: JSON.stringify(body) })),
    postRaw: async (path: string, body: string) => read(await fetch(base + path, { method: "POST", headers: headers({}), body })),
    get: async (path: string, extra: Record<string, string> = {}) => read(await fetch(base + path, { headers: extra })),
    settings: async (extra: Record<string, string> = {}) => (await read(await fetch(`${base}/api/settings`, { headers: extra }))).body,
  };
}

const error = (status: number, message: string): Reply => ({ status, headers: JSON_HEADERS, body: { error: message } });

let root: string;
let cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-settings-routes-"));
  cleanup = [];
});
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  rmSync(root, { recursive: true, force: true });
});

// ───────────── 真實核心（startNous）：真的 store、真的設定檔 ─────────────

async function boot(extra: Record<string, string> = {}): Promise<{ core: NousHandle; http: ReturnType<typeof client>; config: string }> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  const config = join(root, "config");
  const core = await startNous({
    envFile: null,
    dataDir: join(root, "data"),
    distDir: dist,
    fallbackPort: true,
    overrides: {
      NOUS_CONFIG_DIR: config, NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_WAKE: "on", NOUS_CAMERA: "on",
      ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", SMARTHOME_URL: "", SMARTHOME_TOKEN: "", NOUS_AIL: "off", ...extra,
    },
    log: () => {},
    weatherFetch: (async () => new Response("{}", { status: 503 })) as typeof fetch,
  });
  cleanup.push(() => core.close());
  return { core, http: client(core.url), config };
}

describe("設定寫入路由：真實核心（startNous，模擬引擎，暫存設定資料夾）", () => {
  it("每一條：合法 patch 回 200 與整份設定（和緊接著的 GET /api/settings 完全相同），並寫進設定檔", async () => {
    const { http, config } = await boot();
    for (const c of CASES) {
      const before = await http.settings();
      const reply = await http.post(c.path, c.valid);
      expect(reply.status, c.name).toBe(200);
      expect(reply.headers, c.name).toEqual(JSON_HEADERS);
      expect(reply.body, c.name).toEqual(await http.settings());
      expect(reply.body, c.name).not.toEqual(before);
      if (c.name !== "realtime") {
        expect(c.section(before as unknown as SettingsView), c.name).not.toMatchObject(c.valid);
        expect(c.section(reply.body as unknown as SettingsView), c.name).toMatchObject(c.valid);
      }
      const saved = JSON.parse(readFileSync(join(config, c.file), "utf8")) as { prefs: Json };
      expect(saved.prefs, c.name).toMatchObject(c.valid);
    }
    // 即時語音的路徑偏好不直接出現在 settings 的某一段，而是決定 realtime.preference。
    expect(((await http.settings()).realtime as Json).preference).toBe("api_key");
  });

  it("每一條：不合法的 patch 回 400 與固定訊息，設定與設定檔都不變", async () => {
    const { http, config } = await boot();
    const before = await http.settings();
    for (const c of CASES) {
      expect(await http.post(c.path, c.invalid), c.name).toEqual(error(400, c.invalidMessage));
      expect(existsSync(join(config, c.file)), c.name).toBe(false);
    }
    expect(await http.settings()).toEqual(before);
  });

  it("每一條：設定檔寫不進去（設定檔或暫存檔的位置是非空資料夾）回 500 與「沒有保存」，設定不變", async () => {
    const config = join(root, "config");
    for (const c of CASES) {
      // 鬧鐘的 store 讀不懂時會把原檔改名移開，所以擋的是它的暫存檔（alarms.json.tmp）；其餘擋設定檔本身。
      const blocked = join(config, c.name === "alarms" ? `${c.file}.tmp` : c.file);
      mkdirSync(blocked, { recursive: true });
      writeFileSync(join(blocked, "keep"), "x");
    }
    const { http } = await boot();
    const before = await http.settings();
    for (const c of CASES) {
      const reply = await http.post(c.path, c.valid);
      expect(reply.status, c.name).toBe(500);
      expect(reply.headers, c.name).toEqual(JSON_HEADERS);
      if (c.name === "alarms") expect(reply.body).toEqual({ error: c.failed });
      else {
        expect(Object.keys(reply.body), c.name).toEqual(["error"]);
        const [head, tail] = c.failed.split("disk full");
        const message = reply.body.error as string;
        expect(message.startsWith(head!) && message.endsWith(tail!), `${c.name}: ${message}`).toBe(true);
        expect(message.slice(head!.length, message.length - tail!.length), c.name).toMatch(/^E[A-Z]+: .*rename /);
      }
    }
    expect(await http.settings()).toEqual(before);
  });

  it("切換引擎：合法、未知的引擎 400、Claude 沒有 key 時 409；不是 JSON 物件 400", async () => {
    const { http } = await boot();
    const ok = await http.post("/api/settings/provider", { provider: "chatgpt" });
    expect(ok.status).toBe(200);
    expect(ok.headers).toEqual(JSON_HEADERS);
    expect(ok.body.provider).toBe("chatgpt");
    expect(ok.body).toEqual(await http.settings());
    expect(await http.post("/api/settings/provider", { provider: "gemini" })).toEqual(error(400, "unknown provider"));
    expect(await http.post("/api/settings/provider", {})).toEqual(error(400, "unknown provider"));
    expect(await http.post("/api/settings/provider", { provider: "claude" })).toEqual(error(409, "尚未設定 ANTHROPIC_API_KEY，無法使用 Claude。"));
    expect(await http.postRaw("/api/settings/provider", "not json")).toEqual(error(400, "body must be a JSON object"));
    expect(await http.postRaw("/api/settings/provider", "[1]")).toEqual(error(400, "body must be a JSON object"));
    expect((await http.settings()).provider).toBe("chatgpt");
  });

  it("回應依 X-Nous-Terminal 的頁面來源與 X-Nous-Locale 的語言產生（和同樣標頭的 GET 相同）", async () => {
    const { http } = await boot();
    for (const c of CASES) {
      for (const extra of [{ "X-Nous-Terminal": "rpi4" }, { "X-Nous-Locale": "en" }] as Record<string, string>[]) {
        const reply = await http.post(c.path, c.valid, extra);
        expect(reply.status, c.name).toBe(200);
        expect(reply.body, c.name).toEqual(await http.settings(extra));
      }
    }
    // 終端機來源：時鐘 main 開、terminal 預設開；主視窗來源看 main。
    await http.post("/api/settings/clock", { main: false });
    expect((((await http.post("/api/settings/clock", {}, { "X-Nous-Terminal": "rpi4" })).body.clock) as Json).enabled).toBe(true);
    expect((((await http.post("/api/settings/clock", {})).body.clock) as Json).enabled).toBe(false);
  });

  it("每一條只接受 POST：同一個路徑的 GET 是 404", async () => {
    const { http } = await boot();
    for (const c of [...CASES.map((x) => x.path), "/api/settings/provider"]) expect(await http.get(c), c).toEqual(error(404, "not found"));
  });

  it("人臉辨識校正：reset、calibrated、合併後不合理的整組 400", async () => {
    const { http, config } = await boot();
    const path = "/api/settings/camera-tuning";
    const calibrated = await http.post(path, { near_min_m: 0.5, calibrated: true });
    expect(calibrated.status).toBe(200);
    expect(calibrated.body.face_tuning).toMatchObject({ near_min_m: 0.5, customized: true, calibrated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(await http.post(path, { near_min_m: 1.4, near_max_m: 1.5 })).toEqual(error(400, "辨識的最遠距離要比最近距離遠至少 0.3 m"));
    expect(await http.post(path, { min_face_px: 1 })).toEqual(error(400, "min_face_px 必須是數字、間隔 5"));
    expect(await http.post(path, { calibrated: true, nope: 1 })).toEqual(error(400, "未知的校正值：nope"));
    const plain = await http.post(path, { min_face_px: 120, calibrated: "yes" });
    expect(plain.body.face_tuning).toMatchObject({ near_min_m: 0.5, min_face_px: 120 });
    const reset = await http.post(path, { reset: true, min_face_px: 1 });
    expect(reset.status).toBe(200);
    expect(reset.body.face_tuning).toMatchObject({ near_min_m: 0.6, min_face_px: 100, customized: false, calibrated_at: null });
    expect(reset.body).toEqual(await http.settings());
    expect((JSON.parse(readFileSync(join(config, "face-tuning.json"), "utf8")) as { prefs: Json }).prefs).toEqual({});
  });

  it("鏡頭沒有啟用（NOUS_CAMERA=off）時校正值 409，鏡頭設定仍可寫", async () => {
    const { http } = await boot({ NOUS_CAMERA: "off" });
    expect(await http.post("/api/settings/camera-tuning", { min_face_px: 120 })).toEqual(error(409, "鏡頭未啟用"));
    expect(await http.post("/api/settings/camera-tuning", { reset: true })).toEqual(error(409, "鏡頭未啟用"));
    expect((await http.post("/api/settings/camera", { look_to_talk_s: 2 })).status).toBe(200);
  });

  it("喚醒：頁面不能打開聆聽或只憑聲音叫名字（403，什麼都不保存）；格式檢查在 403 之前", async () => {
    const { http, config } = await boot();
    const path = "/api/settings/wake";
    expect(await http.post(path, { wake_listen: true })).toEqual(error(403, "常駐喚醒聆聽只能從 App 選單列打開"));
    expect(await http.post(path, { voice_name_test: true })).toEqual(error(403, "只憑聲音叫名字只能從 App 選單列打開"));
    expect(await http.post(path, { voice_name_test: true, wake_listen: true, wake_silence_s: 15 })).toEqual(error(403, "常駐喚醒聆聽只能從 App 選單列打開"));
    expect(await http.post(path, { wake_listen: true, wake_silence_s: 7 })).toEqual(error(400, "wake_silence_s 必須是選單裡的秒數（3、5、8、10、15 或 20）"));
    expect(await http.post(path, { voice_name_test: true }, { "X-Nous-Locale": "en" })).toEqual(error(403, "Voice-only naming can only be turned on from the App menu bar"));
    expect(existsSync(join(config, "wake.json"))).toBe(false);
    expect((await http.post(path, { wake_listen: false, voice_name_test: false })).status).toBe(200);
  });

  it("主動提醒：合併後開始不早於結束時 400（store 的檢查），不寫檔", async () => {
    const { http, config } = await boot();
    expect(await http.post("/api/settings/proactive", { start_hour: 9, end_hour: 9 })).toEqual(error(400, "時段的開始要早於結束"));
    expect(existsSync(join(config, "proactive.json"))).toBe(false);
  });
});

// ───────────── createApp 加可控制的 store：缺 store、寫入失敗的固定理由、檢查與寫入的先後 ─────────────

interface Harness {
  http: ReturnType<typeof client>;
  /** 每次呼叫 store 的寫入方法記一筆（不論成功失敗）。 */
  calls: string[];
  /** store 成功寫入後的 onChange 次數（→ notifySettings → SSE settings.updated）。 */
  changes(): number;
  /** true：之後每次寫入都丟 Error("disk full")，不碰真的 store。 */
  fail(on: boolean): void;
}

async function harness(options: { stores?: boolean; cameraEnable?: "main_process" | "http"; camera?: "on" | "off" } = {}): Promise<Harness> {
  const dir = join(root, "config");
  const port = await freePort();
  const calls: string[] = [];
  let changes = 0;
  let failing = false;
  let notify = () => {};
  const onChange = () => {
    changes += 1;
    notify();
  };
  const log = () => {};
  const guarded = <A extends unknown[], R>(name: string, run: (...args: A) => R) => (...args: A): R => {
    calls.push(name);
    if (failing) throw new Error("disk full");
    return run(...args);
  };
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
  const base = { store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: null };
  let app: ReturnType<typeof createApp>;
  if (options.stores === false) app = createApp(base);
  else {
    const camera = new CameraSettingsStore({ base: loadConfig({ NOUS_CAMERA: options.camera ?? "on" }).camera, dir, onChange, log });
    const faceTuning = new FaceTuningStore({ dir, onChange, log });
    const voice = new VoiceSettingsStore({ dir, onChange, log });
    const audio = new AudioSettingsStore({ dir, onChange, log });
    const wake = new WakeSettingsStore({ dir, onChange, log });
    const clock = new ClockSettingsStore({ dir, onChange, log });
    const dayNight = new DayNightSettingsStore({ dir, onChange, log });
    const homeCorner = new HomeCornerSettingsStore({ dir, onChange, log });
    const proactive = new ProactiveSettingsStore({ dir, onChange, log });
    const realtimePrefs = new RealtimeSettingsStore({ dir, defaults: { route: "auto", live_voice: "cove" }, onChange, log });
    const memories = memoriesFeature(new MemoriesSettingsStore({ dir, onChange, log }), new FolderMemoriesSource({ dir: join(root, "library") }));
    const alarms = new AlarmCenter({ dir, onChange, log });
    cleanup.push(() => alarms.dispose());
    alarms.updatePrefs = guarded("alarms", alarms.updatePrefs.bind(alarms));
    const proactiveView = (): ProactiveSettingsView =>
      ({ prefs: proactive.view(), place: null, places: [], start_hours: [], end_hours: [], weather: { state: "idle", at: null }, calendar: { state: "off" }, attribution: "" }) as unknown as ProactiveSettingsView;
    app = createApp({
      ...base,
      ...(options.cameraEnable ? { cameraEnable: options.cameraEnable } : {}),
      camera: { view: () => camera.view(), update: guarded("camera", (patch) => camera.update(patch)) },
      faceTuning: { view: () => faceTuning.view(), update: guarded("camera-tuning", (patch, calibrated) => faceTuning.update(patch, calibrated)), reset: guarded("camera-tuning:reset", () => faceTuning.reset()) },
      voice: { view: () => voice.view(), update: guarded("voice", (patch) => voice.update(patch)) },
      audio: { view: () => audio.view(), update: guarded("audio", (patch) => audio.update(patch)) },
      wake: { view: () => wake.view(), update: guarded("wake", (patch) => wake.update(patch)), runtime: () => "missing" },
      clock: { view: (source) => clock.view(source), update: guarded("clock", (patch) => clock.update(patch)), weatherNow: async () => { throw new Error("not used"); } },
      dayNight: { view: () => dayNight.view(), update: guarded("day-night", (patch) => dayNight.update(patch)) },
      homeCorner: { view: (source) => homeCorner.view(source), update: guarded("home-corner", (patch) => homeCorner.update(patch)), overview: async () => { throw new Error("not used"); } },
      proactive: { view: proactiveView, update: guarded("proactive", (patch) => proactive.update(patch)), prefetch: () => {} },
      memories: { ...memories, update: guarded("memories", (patch) => memories.update(patch)) },
      realtimePrefs: { view: () => realtimePrefs.view(), update: guarded("realtime", (patch) => realtimePrefs.update(patch)) },
      alarms,
    });
  }
  notify = app.notifySettings;
  cleanup.push(() => new Promise<void>((r) => (app as Server).close(() => r())));
  await new Promise<void>((r) => app.listen(port, "127.0.0.1", r));
  return { http: client(`http://localhost:${port}`), calls, changes: () => changes, fail: (on) => void (failing = on) };
}

describe("設定寫入路由：createApp 加可控制的 store（模擬引擎，暫存資料夾）", () => {
  it("每一條：合法 patch 只呼叫一次自己的 store、通知一次；不合法的 patch 不呼叫 store（鬧鐘由 store 自己驗證）", async () => {
    const h = await harness();
    for (const c of CASES) {
      const calls = h.calls.length;
      const changes = h.changes();
      const ok = await h.http.post(c.path, c.valid);
      expect(ok.status, c.name).toBe(200);
      expect(ok.body, c.name).toEqual(await h.http.settings());
      expect(h.calls.slice(calls), c.name).toEqual([c.name]);
      expect(h.changes() - changes, c.name).toBe(1);

      expect(await h.http.post(c.path, c.invalid), c.name).toEqual(error(400, c.invalidMessage));
      expect(h.calls.slice(calls + 1), c.name).toEqual(c.name === "alarms" ? ["alarms"] : []);
      expect(h.changes() - changes, c.name).toBe(1);
    }
  });

  it("每一條：store 寫入失敗回 500 與逐字的「沒有保存」訊息（英文照翻譯表；「校正值」那一句沒有翻譯，維持中文），設定不變、不通知", async () => {
    const h = await harness();
    const before = await h.http.settings();
    h.fail(true);
    for (const c of CASES) {
      expect(await h.http.post(c.path, c.valid), c.name).toEqual(error(500, c.failed));
      expect(await h.http.post(c.path, c.valid, { "X-Nous-Locale": "en" }), c.name).toEqual(error(500, c.failedEn));
    }
    expect(await h.http.post("/api/settings/camera-tuning", { reset: true })).toEqual(error(500, "校正值沒有保存（無法寫入設定檔：disk full）"));
    expect(h.changes()).toBe(0);
    h.fail(false);
    expect(await h.http.settings()).toEqual(before);
  });

  it("每一條：寫入失敗前先驗證（不合法的 patch 仍是 400，不是 500）", async () => {
    const h = await harness();
    h.fail(true);
    for (const c of CASES.filter((x) => x.name !== "alarms")) expect(await h.http.post(c.path, c.invalid), c.name).toEqual(error(400, c.invalidMessage));
    expect(h.calls).toEqual([]);
  });

  it("沒有提供 store：409 或 404，而且在讀 body 之前（不合法的 patch、不是 JSON 的 body 都一樣）", async () => {
    const h = await harness({ stores: false });
    for (const c of CASES) {
      const expected = error(c.missing.status, c.missing.message);
      expect(await h.http.post(c.path, c.valid), c.name).toEqual(expected);
      expect(await h.http.post(c.path, c.invalid), c.name).toEqual(expected);
      expect(await h.http.postRaw(c.path, "not json"), c.name).toEqual(expected);
    }
    expect(await h.http.post("/api/settings/voice", {}, { "X-Nous-Locale": "en" })).toEqual(error(409, "Voice preferences are not configured"));
    expect((await h.http.post("/api/settings/provider", { provider: "chatgpt" })).status).toBe(200);
    expect(await h.http.post("/api/settings/nope", {})).toEqual(error(404, "not found"));
  });

  it("有 store 時 body 不是 JSON 物件：400 body must be a JSON object，不呼叫 store", async () => {
    const h = await harness();
    for (const c of CASES) expect(await h.http.postRaw(c.path, "not json"), c.name).toEqual(error(400, "body must be a JSON object"));
    expect(h.calls).toEqual([]);
  });

  it("鏡頭（App：cameraEnable main_process）：active true 回 403、不呼叫 store；格式檢查在 403 之前；關掉與其他設定照收", async () => {
    const h = await harness({ cameraEnable: "main_process" });
    expect(((await h.http.settings()).camera as Json).enable_via).toBe("app");
    expect(await h.http.post("/api/settings/camera", { active: true })).toEqual(error(403, "鏡頭只能從 App 打開"));
    expect(await h.http.post("/api/settings/camera", { active: true, look_to_talk_s: 2 })).toEqual(error(403, "鏡頭只能從 App 打開"));
    expect(await h.http.post("/api/settings/camera", { active: true, look_to_talk_s: 99 })).toEqual(error(400, "look_to_talk_s 必須是 0.5–5 秒、間隔 0.1"));
    expect(h.calls).toEqual([]);
    const off = await h.http.post("/api/settings/camera", { active: false, look_to_talk_s: 2 });
    expect(off.status).toBe(200);
    expect(off.body.camera).toMatchObject({ active: false, look_to_talk_s: 2, enable_via: "app" });
    expect(h.calls).toEqual(["camera"]);
  });

  it("鏡頭（終端機／瀏覽器版：cameraEnable http 或未指定）：active true 照收", async () => {
    for (const cameraEnable of ["http", undefined] as const) {
      const h = await harness(cameraEnable ? { cameraEnable } : {});
      await h.http.post("/api/settings/camera", { active: false });
      const on = await h.http.post("/api/settings/camera", { active: true });
      expect(on.status).toBe(200);
      expect(on.body.camera).toMatchObject({ active: true });
      expect((on.body.camera as Json).enable_via).toBeUndefined();
      for (const step of cleanup.splice(0).reverse()) await step();
      rmSync(join(root, "config"), { recursive: true, force: true });
    }
  });

  it("人臉辨識校正：reset 走 reset()、其餘走 update()；鏡頭沒有啟用時 409 且不呼叫 store", async () => {
    const h = await harness();
    await h.http.post("/api/settings/camera-tuning", { min_face_px: 120, calibrated: true });
    await h.http.post("/api/settings/camera-tuning", { reset: true });
    expect(h.calls).toEqual(["camera-tuning", "camera-tuning:reset"]);
    for (const step of cleanup.splice(0).reverse()) await step();
    const off = await harness({ camera: "off" });
    expect(await off.http.post("/api/settings/camera-tuning", { min_face_px: 120 })).toEqual(error(409, "鏡頭未啟用"));
    expect(off.calls).toEqual([]);
  });

  it("喚醒：403 不呼叫 store；主動提醒：store 丟出的格式錯誤是 400", async () => {
    const h = await harness();
    expect(await h.http.post("/api/settings/wake", { wake_listen: true })).toEqual(error(403, "常駐喚醒聆聽只能從 App 選單列打開"));
    expect(await h.http.post("/api/settings/wake", { voice_name_test: true })).toEqual(error(403, "只憑聲音叫名字只能從 App 選單列打開"));
    expect(h.calls).toEqual([]);
    expect(await h.http.post("/api/settings/proactive", { start_hour: 9, end_hour: 9 })).toEqual(error(400, "時段的開始要早於結束"));
    expect(h.calls).toEqual(["proactive"]);
    expect(h.changes()).toBe(0);
  });
});
