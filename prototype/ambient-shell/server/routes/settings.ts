import { AUDIO_WRITE_PATH, AudioPatchError, parseAudioPatch, type AudioPrefsPatch } from "../../shared/audio-devices.ts";
import { CLOCK_WRITE_PATH, ClockPatchError, parseClockPatch, type ClockPrefsPatch } from "../../shared/clock.ts";
import { DAY_NIGHT_WRITE_PATH, DayNightPatchError, parseDayNightPatch, type DayNightPatch } from "../../shared/day-night.ts";
import { FaceTuningError, parseFaceTuningPatch, type FaceTuning } from "../../shared/face-tuning.ts";
import { HOME_CORNER_WRITE_PATH, HomeCornerPatchError, parseHomeCornerPatch, type HomeCornerPrefsPatch } from "../../shared/home-corner.ts";
import { MEMORIES_WRITE_PATH, MemoriesPatchError, parseMemoriesPatch, type MemoriesPrefsPatch } from "../../shared/memories.ts";
import { parseProactivePatch, ProactivePatchError, type ProactivePrefsPatch } from "../../shared/proactive.ts";
import { parseRealtimePatch, RealtimePatchError, type RealtimePrefsPatch } from "../../shared/realtime-route.ts";
import { CameraPatchError, parseCameraPatch, type CameraPrefsPatch } from "../../shared/sense.ts";
import type { ExecutorMode } from "../../shared/types.ts";
import { parseVoicePatch, VoicePatchError, type VoicePrefsPatch } from "../../shared/voice-prefs.ts";
import { parseWakePatch, WakePatchError, type WakePrefsPatch } from "../../shared/wake.ts";
import { HttpError } from "../http-error.ts";

// POST /api/settings/* 的寫入路由表（docs/23 §3 的 S6）。server/app.ts 的 handleApi 在 GET /api/settings 之後查這張表；
// 寫入成功後由 app.ts 回整份設定（sendSettings），所以這裡不碰回應、SSE 或語言。
// 每一條的先後固定：store 在不在 → 讀 body → 格式檢查（400）→ 寫入前的拒絕（403）→ store.update（失敗 500）。
// 訊息字串是 messages.en.json 的鍵，改字要連翻譯表一起改。
// 不在這張表的：/api/settings/alarms（和 /api/alarms/* 共用同一段錯誤處理，留在 app.ts）。

type Body = Record<string, unknown>;
export type ReadBody = () => Promise<Body>;

interface Writable<P> {
  update(patch: P): unknown;
}

/** 這張表用到的 store（欄位名稱與 AppOptions 相同，app.ts 直接把 options 傳進來）。 */
export interface SettingsWriteStores {
  settings: { select(provider: ExecutorMode): void };
  /** "main_process"（macOS App）時頁面不能經 HTTP 打開鏡頭。 */
  cameraEnable?: "main_process" | "http";
  camera?: Writable<CameraPrefsPatch> & { view(): { enabled: boolean } };
  faceTuning?: { update(patch: Partial<FaceTuning>, calibrated?: boolean): unknown; reset(): unknown };
  voice?: Writable<VoicePrefsPatch>;
  audio?: Writable<AudioPrefsPatch>;
  wake?: Writable<WakePrefsPatch>;
  clock?: Writable<ClockPrefsPatch>;
  dayNight?: Writable<DayNightPatch>;
  homeCorner?: Writable<HomeCornerPrefsPatch>;
  proactive?: Writable<ProactivePrefsPatch>;
  memories?: Writable<MemoriesPrefsPatch>;
  realtimePrefs?: Writable<RealtimePrefsPatch>;
}

/** 處理一個請求。true＝已寫入，呼叫端回整份設定；false＝這條路由在目前的組裝不存在（旗標關閉），照舊落到 404。 */
export type SettingsWrite = (stores: SettingsWriteStores, readBody: ReadBody) => Promise<boolean>;

/** 寫檔失敗：伺服器記憶體沒有改，回報真實原因，不顯示假成功。 */
function saveFailed(message: (reason: string) => string, err: unknown): HttpError {
  return new HttpError(500, message((err as Error).message));
}

interface PatchRoute<P> {
  path: string;
  store(stores: SettingsWriteStores): Writable<P> | undefined;
  /** store 沒有提供時：字串＝409 與這個訊息（在讀 body 之前）；null＝這條路由不存在。 */
  missing: string | null;
  parse(input: unknown): P;
  /** parse 丟這個類別＝400 與它的訊息；其他錯誤照丟。 */
  PatchError: new (...args: never[]) => Error;
  /** 格式通過之後、寫入之前的拒絕（丟 HttpError）；整個請求拒絕，什麼都不保存。 */
  refuse?(patch: P, stores: SettingsWriteStores): void;
  /** store.update 自己也會丟 PatchError（合併後才能檢查的規則）：一樣是 400。 */
  storeValidates?: boolean;
  saveFailed(reason: string): string;
}

/** 一致的那一種：解析 patch → store.update → 寫檔失敗 500。update 會呼叫 onChange（→ notifySettings），這裡不重複廣播。 */
function patchRoute<P>(spec: PatchRoute<P>): [string, SettingsWrite] {
  return [spec.path, async (stores, readBody) => {
    const store = spec.store(stores);
    if (!store) {
      if (spec.missing === null) return false;
      throw new HttpError(409, spec.missing);
    }
    let patch: P;
    try {
      patch = spec.parse(await readBody());
    } catch (err) {
      if (err instanceof spec.PatchError) throw new HttpError(400, err.message);
      throw err;
    }
    spec.refuse?.(patch, stores);
    try {
      store.update(patch);
    } catch (err) {
      if (spec.storeValidates && err instanceof spec.PatchError) throw new HttpError(400, err.message);
      throw saveFailed(spec.saveFailed, err);
    }
    return true;
  }];
}

const provider: SettingsWrite = async (stores, readBody) => {
  const body = await readBody();
  const provider = body.provider;
  if (provider !== "claude" && provider !== "chatgpt" && provider !== "mock") throw new HttpError(400, "unknown provider");
  try {
    stores.settings.select(provider);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  return true;
};

/** 人臉辨識校正值：reset 整份還原，否則是 patch 加上 calibrated 旗標；store 自己檢查合併後的整組（FaceTuningError → 400）。 */
const cameraTuning: SettingsWrite = async (stores, readBody) => {
  if (!stores.faceTuning || !stores.camera?.view().enabled) throw new HttpError(409, "鏡頭未啟用");
  const body = await readBody();
  try {
    if (body && typeof body === "object" && (body as Record<string, unknown>).reset === true) stores.faceTuning.reset();
    else {
      const { calibrated, ...rest } = (body ?? {}) as Record<string, unknown>;
      stores.faceTuning.update(parseFaceTuningPatch(rest), calibrated === true);
    }
  } catch (err) {
    if (err instanceof FaceTuningError) throw new HttpError(400, err.message);
    throw saveFailed((reason) => `校正值沒有保存（無法寫入設定檔：${reason}）`, err);
  }
  return true;
};

const ROUTES = new Map<string, SettingsWrite>([
  ["/api/settings/provider", provider],
  patchRoute({
    path: "/api/settings/camera",
    store: (s) => s.camera,
    missing: "鏡頭未設定",
    parse: parseCameraPatch,
    PatchError: CameraPatchError,
    // App（cameraEnable: "main_process"）：頁面（以及任何本機頁面腳本）只能關掉鏡頭或改其他設定；打開只能由 App 主程序
    // 在原生說明之後經 NousHandle.camera 做（同 /api/settings/wake 的 wake_listen）。關掉一定安全，所以照收。
    // 終端機／瀏覽器版（"http"）照舊可以打開。
    refuse: (patch, s) => {
      if (s.cameraEnable === "main_process" && patch.active === true) throw new HttpError(403, "鏡頭只能從 App 打開");
    },
    saveFailed: (reason) => `鏡頭設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  ["/api/settings/camera-tuning", cameraTuning],
  patchRoute({
    path: "/api/settings/voice",
    store: (s) => s.voice,
    missing: "語音設定未設定",
    parse: parseVoicePatch,
    PatchError: VoicePatchError,
    saveFailed: (reason) => `語音設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: AUDIO_WRITE_PATH,
    store: (s) => s.audio,
    missing: "聲音裝置設定未設定",
    parse: parseAudioPatch,
    PatchError: AudioPatchError,
    saveFailed: (reason) => `聲音裝置設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: "/api/settings/wake",
    store: (s) => s.wake,
    missing: null,
    parse: parseWakePatch,
    PatchError: WakePatchError,
    refuse: (patch) => {
      // 頁面（以及任何本機頁面腳本）只能記下麥克風或關掉；打開只能由 App 主程序在原生說明之後經 NousHandle.wake 做
      // （ADR-0003 §2.3）。關掉一定安全，所以這裡照收。
      if (patch.wake_listen === true) throw new HttpError(403, "常駐喚醒聆聽只能從 App 選單列打開");
      // SP-02a：只憑聲音叫名字的測試開關同樣只能由主程序在原生說明之後打開。
      if (patch.voice_name_test === true) throw new HttpError(403, "只憑聲音叫名字只能從 App 選單列打開");
    },
    saveFailed: (reason) => `常駐喚醒聆聽設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: CLOCK_WRITE_PATH,
    store: (s) => s.clock,
    missing: null,
    parse: parseClockPatch,
    PatchError: ClockPatchError,
    saveFailed: (reason) => `時鐘設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: DAY_NIGHT_WRITE_PATH,
    store: (s) => s.dayNight,
    missing: null,
    parse: parseDayNightPatch,
    PatchError: DayNightPatchError,
    saveFailed: (reason) => `日夜間設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: HOME_CORNER_WRITE_PATH,
    store: (s) => s.homeCorner,
    missing: null,
    parse: parseHomeCornerPatch,
    PatchError: HomeCornerPatchError,
    saveFailed: (reason) => `家中狀態設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: "/api/settings/proactive",
    store: (s) => s.proactive,
    missing: null,
    parse: parseProactivePatch,
    PatchError: ProactivePatchError,
    storeValidates: true,
    saveFailed: (reason) => `主動提醒設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: MEMORIES_WRITE_PATH,
    store: (s) => s.memories,
    missing: null,
    parse: parseMemoriesPatch,
    PatchError: MemoriesPatchError,
    saveFailed: (reason) => `回憶模式設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
  patchRoute({
    path: "/api/settings/realtime",
    store: (s) => s.realtimePrefs,
    missing: "即時語音路徑設定未設定",
    parse: parseRealtimePatch,
    PatchError: RealtimePatchError,
    // 只影響下一次開始；正在進行的工作階段維持原本的路徑（RealtimeSessions 只在 start 讀偏好）。
    saveFailed: (reason) => `即時語音設定沒有保存（無法寫入設定檔：${reason}）`,
  }),
]);

/** 這個請求是不是表上的設定寫入路由（只比對 POST 與完整路徑）。不是時回 undefined，app.ts 繼續往下比對。 */
export function findSettingsWrite(method: string, path: string): SettingsWrite | undefined {
  return method === "POST" ? ROUTES.get(path) : undefined;
}
