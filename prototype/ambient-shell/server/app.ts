import { localize, localizeSettings } from "./localization.ts";
import { normalizeLocale, translate } from "../shared/i18n.mjs";
import type { Locale } from "../shared/i18n.mjs";
import { BROWSER_MEMORY_STATUS, MEMORY_CLAIM, type MemorySettingsStatus } from "../shared/memory.ts";
import type { ChatTarget } from "./memory/retrieve.ts";
import type { MemoryContext } from "./memory/service.ts";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { pipeline } from "node:stream";
import { extname, join, normalize, sep } from "node:path";
import type { ExecutorMode, ServerEvent, SettingsView, Task } from "../shared/types.ts";
import type { ChatGPTAuth } from "./chatgpt-auth.ts";
import { buildChatSystem, DelegationFilter, validateMessages, type ChatCapable } from "./chat.ts";
import { ExecutionError } from "./runner.ts";
import { RealtimeError, type RealtimeBridge } from "./realtime.ts";
import { WebSearchError, type WebSearch } from "./web-search.ts";
import { HomeBridgeError, type ControlRequest, type HomeBridge } from "./home-bridge.ts";
import { FaceTuningError, parseFaceTuningPatch, type FaceTuning, type FaceTuningView } from "../shared/face-tuning.ts";
import { CameraPatchError, parseCameraPatch, type CameraPrefsPatch, type CameraSettings } from "../shared/sense.ts";
import { cameraPreviewDisabledReason, describeMenuPrefs } from "../shared/menu-prefs.ts";
import { DEFAULT_VOICE_PREFS, parseVoicePatch, VoicePatchError, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import { allowedHosts, checkRequest } from "./http-guard.ts";
import { ApiKeyRoute, FallbackRequired, RealtimeSessions, RouteStartError, SessionError, type RealtimeRoute } from "./realtime-routes.ts";
import type { CodexAuth } from "./codex-auth.ts";
import {
  APPROVAL_CARD_OUTCOMES,
  LIVE_INPUT_KINDS,
  parseRealtimePatch,
  RealtimePatchError,
  STOP_REPLY_RESPONSE_ID,
  type ApprovalCardOutcome,
  type ApprovalReport,
  type LiveInputKind,
  type RealtimePrefs,
  type RealtimePrefsPatch,
} from "../shared/realtime-route.ts";
import { COMMANDS_PATH, commandsPageHeaders, renderCommandsPage } from "./commands-page.ts";
import { BROWSER_IDENTITY_STATUS, type IdentityStatus } from "../shared/identity.ts";
import { faceRuntimePath, readVerifiedFaceRuntime } from "./face-runtime.ts";
import { readVerifiedSpeakerRuntime, speakerRuntimePath } from "./speaker-runtime.ts";
import { readVerifiedWakeRuntime, wakeRuntimePath } from "./wake-runtime.ts";
import { AUDIO_WRITE_PATH, AudioPatchError, DEFAULT_AUDIO_PREFS, parseAudioPatch, type AudioPrefs, type AudioPrefsPatch } from "../shared/audio-devices.ts";
import { effectiveWakeThresholds, parseWakePatch, WAKE_ID, WakePatchError, type WakeKeywordConfig, type WakePrefs, type WakePrefsPatch, type WakeRuntimeState } from "../shared/wake.ts";
import wakeManifest from "../shared/wake-runtime.json" with { type: "json" };
import { parsePageEndReason, parseVoiceUsage } from "../shared/voice-cost.ts";
import { parseCostLimit, type VoiceCostLog } from "./voice-cost-log.ts";
import { historyPageHeaders, pageHeaders } from "./page-headers.ts";
import type { TaskRunner } from "./runner.ts";
import { tasksForTarget, type TaskStore } from "./store.ts";
import type { VoiceRoute } from "./memory/live.ts";
import { forgetHistoryArtifact, HistoryQueryError, parseHistoryQuery, searchHistory, type HistorySource } from "./history.ts";
import type { HistoryDetail } from "../shared/history.ts";
import type { Integrations } from "./integrations/index.ts";
import { HOME_CORNER_WRITE_PATH, HOME_OVERVIEW_PATH, HomeCornerPatchError, parseHomeCornerPatch, type HomeCornerPrefs, type HomeCornerPrefsPatch, type HomeCornerSettingsView, type HomeOverviewView } from "../shared/home-corner.ts";
import { DAY_NIGHT_WRITE_PATH, DayNightPatchError, isScreenState, parseDayNightPatch, TERMINAL_DISPLAY_PATH, type DayNightPatch, type DayNightSettingsView, type ScreenState } from "../shared/day-night.ts";
import { CLOCK_WRITE_PATH, ClockPatchError, parseClockPatch, WEATHER_NOW_PATH, type ClockPrefs, type ClockPrefsPatch, type ClockSettingsView, type WeatherNowView } from "../shared/clock.ts";
import { parseProactivePatch, ProactivePatchError, type ProactivePrefs, type ProactivePrefsPatch, type ProactiveSettingsView } from "../shared/proactive.ts";
import { MEMORIES_GOOGLE_PATHS, MEMORIES_ITEMS_PATH, MEMORIES_MEDIA_PREFIX, MEMORIES_WRITE_PATH, MemoriesPatchError, parseMemoriesPatch, type MemoriesItem, type MemoriesPrefs, type MemoriesPrefsPatch, type MemoriesSettingsView } from "../shared/memories.ts";
import { parseByteRange } from "./memories.ts";
import type { MemoriesGooglePart } from "./memories-google.ts";
import { isTerminalId, pageSource } from "../shared/terminal.ts";
import { terminalIdentity, terminalMemory, type TerminalIdentityPort, type TerminalMemoryPort } from "./terminal-routes.ts";
import { handleVoiceRelayRoute } from "./integrations/voice-relay/routes.ts";
import { VoiceRelayStoreError } from "./integrations/voice-relay/store.ts";
import { HOME_TOOL } from "./integrations/adapters/home.ts";
import type { IntegrationToolId } from "../shared/integrations.ts";
import { HOME_ARG_MAX } from "../shared/home.ts";
import { ALARM_WRITE_PATH, AlarmPatchError, STOP_SOURCES, type StopSource } from "../shared/alarm.ts";
import type { AlarmCenter } from "./alarms.ts";
import { repeatDays } from "../shared/alarm-schedule.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 2000;
/** 確認卡時限的上限（頁面預設 60 秒；家電卡不超過確認 ID 的期限）。 */
const MAX_APPROVAL_MS = 10 * 60_000;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{6,64}$/;
const SESSION_ID = /^rt_[0-9a-f]{32}$/;
const OWNER = /^own_[A-Za-z0-9_-]{20,64}$/;
const CALL_ID = /^hc_[0-9a-f]{32}$/;
const CLIENT_ID = /^sse_[0-9a-f]{32}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  // onnxruntime 的 wasm 載入器（/face-runtime/）與 YuNet、SFace 模型。
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
};

/**
 * JavaScript 回應的 CSP。頁面的 CSP 只管頁面；dedicated worker 套用的是它自己腳本回應的 CSP，沒有這個標頭時
 * worker 不受 connect-src 限制。家人辨識的 worker 要編譯 onnxruntime wasm（'wasm-unsafe-eval'）並從同源讀模型；
 * 除此之外一律只允許同源，不能連外。這不放寬頁面的 CSP。
 */
export function scriptHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  };
}

export interface AppOptions {
  store: TaskStore;
  runner: TaskRunner;
  settings: {
    view(): SettingsView;
    select(provider: ExecutorMode): void;
  };
  auth: ChatGPTAuth;
  /** 語音對話用的引擎（通常就是 ProviderManager）；chatTarget 是記憶同意用的「服務＋帳號」。 */
  chat: ChatCapable & { chatTarget?(): ChatTarget | null };
  /**
   * 記憶層（MemoryService；只有 macOS App 注入）。/api/chat 帶 IPC 發的 memory_turn 時才檢索；settings 只放 {available, enabled}。
   * 未提供（瀏覽器版）時回報不可用，一般聊天照舊。
   */
  memory?: {
    settingsStatus(): MemorySettingsStatus;
    withChat<T>(request: { nonce: unknown; requestId: string; lastUser: string; target: ChatTarget | null; historyLength?: number }, run: (ctx: MemoryContext) => Promise<T>): Promise<T>;
    /** MEM-4a：哪些任務可以把真實標題給這個模型目標（沒有同意回 null＝全部外殼）。 */
    taskTitleFilter?(target: ChatTarget | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null;
    /** MEM-4a：即時語音路徑的同意對象（live：codex；api_key：openai_realtime）。 */
    routeTarget?(route: VoiceRoute): ChatTarget | null;
  } & Partial<TerminalMemoryPort>;
  /** 即時語音的 API key 路徑（OpenAI Realtime GA）；未提供時這條路徑不可用。 */
  realtime?: RealtimeBridge;
  /**
   * 即時語音的路徑（server/realtime-routes.ts）。未提供時只有包住 realtime 的 API key 路徑（舊的組裝方式照舊可用）。
   */
  realtimeRoutes?: { live?: RealtimeRoute; api_key?: RealtimeRoute };
  /** 路徑偏好與 ChatGPT 方案路徑的聲音（RealtimeSettingsStore）；未提供時固定 auto、不能修改。 */
  realtimePrefs?: RealtimeSettingsSource;
  /** 即時語音用的 Codex 登入（ChatGPT 方案路徑）；未提供時沒有這個登入。 */
  codexAuth?: CodexAuth;
  /** MEM-2：停播未確認時強制靜音（macOS App：主視窗 webContents.setAudioMuted）。 */
  realtimeAudio?: { setMuted(muted: boolean): void };
  /** 只限測試 build（NOUS_TEST_DROP_STOP_REPORT=1）：丟掉頁面的停播回報。 */
  dropStopReport?: boolean;
  /** MEM-3 只限測試 build：記憶撤銷的 closed 事件不送給頁面（NOUS_TEST_RENDERER_IGNORE_REVOKE=1）。 */
  hideRevokeFromPage?: boolean;
  /** 即時語音的上網查詢；未提供時不可用。 */
  webSearch?: WebSearch;
  /** 武陵居中控的查詢與控制（docs/12 H0、H1）；未提供時不可用。 */
  home?: HomeBridge;
  /**
   * AIL-1：整合層。未提供時沒有 /api/integrations/*（一律 404）、settings 沒有 integrations 欄位。ALARM-1 起核心一定提供
   * （至少有內建的定時器）；NOUS_AIL 關閉時 settings.integrations.builtin_only 為 true，頁面不顯示「App 整合」狀態。
   */
  integrations?: Integrations;
  /** 雙目鏡頭設定（docs/11，通常是 CameraSettingsStore）；未提供或未啟用時頁面不允許使用鏡頭。 */
  camera?: CameraSettingsSource;
  /**
   * 誰能打開鏡頭（由啟動核心的一方決定）。"main_process"（macOS App）：POST /api/settings/camera 的 active: true 回 403，
   * 只有 App 主程序在原生說明之後經 NousHandle.camera 打開，settings.camera 帶 enable_via: "app"。
   * "http"（預設；終端機／瀏覽器版）：頁面可以經 HTTP 打開，和以前相同，由瀏覽器自己的鏡頭權限提示與畫面指示點把關。
   */
  cameraEnable?: "main_process" | "http";
  /** 語音閒置秒數（通常是 VoiceSettingsStore）；未提供時用預設值且不能修改。 */
  voice?: VoiceSettingsSource;
  /** 人臉辨識校正值（FaceTuningStore）；只在鏡頭啟用時提供。 */
  faceTuning?: FaceTuningSource;
  /** F2／F10：本機開口偵測門檻（NOUS_EARLY_SPEECH_RMS）；未提供時頁面用預設值。 */
  earlySpeechRms?: number;
  /**
   * 家人辨識的狀態（IdentityService）：只有可用與否與人數。管理與登記只走 Electron IPC；有 handle 時，終端機頁面可經
   * POST /api/terminal/identity 用不需要管理 session 的認人操作（server/terminal-routes.ts）。未提供（瀏覽器版）時回報不可用、
   * 終端機路由 404。
   */
  identity?: { status(source?: string): IdentityStatus } & Partial<TerminalIdentityPort>;
  /** 家人辨識模型與 onnxruntime wasm 的資料夾（只提供清單上的檔名）；未提供時 /face-runtime/ 一律 404。 */
  faceRuntimeDir?: string | null;
  /** SP-01 講者模型與 onnxruntime wasm 的資料夾（只提供清單上的檔名）；未提供時 /speaker-runtime/ 一律 404。 */
  speakerRuntimeDir?: string | null;
  /**
   * WK-01a：常駐喚醒聆聽（只有 NOUS_WAKE=on 時提供，通常是 WakeSettingsStore 加上引擎核對結果）。未提供時沒有
   * /api/settings/wake、settings 沒有 wake 欄位、/wake-runtime/ 一律 404，和加入喚醒程式之前相同。
   */
  wake?: WakeSettingsSource;
  /**
   * 聲音輸入／輸出裝置的選擇（通常是 AudioSettingsStore，configDir/audio.json）。不綁旗標；未提供時（舊的組裝方式、測試）
   * settings.audio 一樣有，但兩者都是系統預設，POST /api/settings/audio 回 409。
   */
  audio?: AudioSettingsSource;
  /** 喚醒引擎檔案的資料夾（只提供 shared/wake-runtime.json 清單上、雜湊相符的檔名；WK-01a 清單為空）。 */
  wakeRuntimeDir?: string | null;
  /**
   * WK-02（F6）：即時語音的費用紀錄（configDir/voice-cost.jsonl）。George 2026-10-31：一律記錄，不綁喚醒開關；
   * 未提供時不記，GET /api/realtime/cost-records 回空清單。
   */
  voiceCostLog?: VoiceCostLog;
  /**
   * 成果紀錄（HIST-1）額外的搜尋來源；一般任務（TaskStore）一律包含。MEM-4c 的受保護成果之後由這裡併入。
   */
  historySources?: HistorySource[];
  /**
   * 服務模式：終端機（Pi kiosk）頁面的心跳（server/terminal-presence.ts）。未提供時 POST /api/terminal/heartbeat 落到 404。
   */
  terminals?: { heartbeat(id: string): void };
  /** DN-3：終端機的螢幕狀態（頁面回報、Pi 的 aios-display 讀）。未提供時兩條路由 404。 */
  terminalDisplay?: { report(id: string, screen: ScreenState): void; view(id: string): { screen: ScreenState; fresh: boolean } };
  /**
   * PRO-1：主動提醒（招呼後接今天的天氣）。view 給 settings.proactive；prefetch 在看著說話或喚醒開始時先取天氣。
   * 未提供時（舊的組裝、測試）settings 沒有 proactive、POST /api/settings/proactive 回 404。
   */
  proactive?: { view(): ProactiveSettingsView; update(patch: ProactivePrefsPatch): ProactivePrefs; prefetch(): void };
  /**
   * CLK-1：右上角時鐘與天氣。view(source) 給 settings.clock（依頁面來源算 enabled）；weatherNow 給唯讀的 GET /api/weather/now
   * （沒有參數；地點同主動提醒）。未提供時 settings 沒有 clock，兩條路由 404。
   */
  clock?: { view(source: string): ClockSettingsView; update(patch: ClockPrefsPatch): ClockPrefs; weatherNow(locale: Locale): Promise<WeatherNowView> };
  /**
   * HOME-1：左上角家中狀態。view(source) 給 settings.home_corner；overview 給唯讀的 GET /api/home/overview（沒有參數，
   * 不送任何控制指令）。未提供時 settings 沒有 home_corner，兩條路由 404。
   */
  /** DN-2：日夜間模式的共用設定與手動切換（settings.day_night 與 POST /api/settings/day-night）。未提供時兩者都沒有。 */
  dayNight?: { view(): DayNightSettingsView; update(patch: DayNightPatch): DayNightSettingsView };
  /** ALARM-1：定時器與響鈴（settings.alarms 與 /api/settings/alarms、/api/alarms/*）。未提供時都沒有。 */
  alarms?: AlarmCenter;
  homeCorner?: { view(source: string): HomeCornerSettingsView; update(patch: HomeCornerPrefsPatch): HomeCornerPrefs; overview(): Promise<HomeOverviewView> };
  /**
   * MEMO-1：回憶模式（設定與本機資料夾的照片、影片）。未提供時 settings 沒有 memories，相關路由 404。
   * file() 回傳的路徑只在核心內使用，不出現在任何回應。
   */
  memories?: { view(): MemoriesSettingsView; update(patch: MemoriesPrefsPatch): MemoriesPrefs; items(): MemoriesItem[]; file(id: string): { path: string; type: string } | null; google?: MemoriesGooglePart };
  port: number;
  devPort: number;
  distDir: string | null;
}

/** 鏡頭設定的來源：安裝設定固定，使用者設定可寫入。 */
export interface CameraSettingsSource {
  view(): CameraSettings;
  update(patch: CameraPrefsPatch): CameraSettings;
}

/** 人臉辨識校正值的來源（FaceTuningStore）。 */
export interface FaceTuningSource {
  view(): FaceTuningView;
  update(patch: Partial<FaceTuning>, calibrated?: boolean): FaceTuningView;
  reset(): FaceTuningView;
}

/** 即時語音路徑偏好的來源。 */
export interface RealtimeSettingsSource {
  view(): RealtimePrefs;
  update(patch: RealtimePrefsPatch): RealtimePrefs;
}

/** 常駐喚醒聆聽偏好的來源（WakeSettingsStore）與引擎核對結果。 */
export interface WakeSettingsSource {
  view(): WakePrefs;
  update(patch: WakePrefsPatch): WakePrefs;
  runtime(): WakeRuntimeState;
}

/** 聲音輸入／輸出裝置偏好的來源（AudioSettingsStore）。 */
export interface AudioSettingsSource {
  view(): AudioPrefs;
  update(patch: AudioPrefsPatch): AudioPrefs;
}

/** 語音閒置秒數的來源。 */
export interface VoiceSettingsSource {
  view(): VoicePrefs;
  update(patch: VoicePrefsPatch): VoicePrefs;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp(options: AppOptions): Server & { notifySettings(): void; notifyMemoryPresence(): void; connectedSources(): Set<string>; realtimeSessions: RealtimeSessions | null } {
  const { store, runner, auth, chat, realtime, webSearch, home, codexAuth } = options;
  /** SSE 串流：client_id → 回應。工具呼叫只送到擁有工作階段的那一條。 */
  const clients = new Map<string, { response: ServerResponse; source: string }>();
  let sequence = 0;
  const routes = options.realtimeRoutes ?? (realtime ? { api_key: new ApiKeyRoute(realtime, realtime.info().available, "") } : null);
  const sessions = routes && (routes.api_key || routes.live)
    ? new RealtimeSessions({
        routes,
        preference: () => options.realtimePrefs?.view().route ?? "auto",
        // MEM-4a：即時語音（兩條路徑）的指示只在那條路徑的記憶同意成立時放真實標題，其餘外殼（瀏覽器版不加密，照舊）。
        tasks: (route) => tasksFor(route ? options.memory?.routeTarget?.(route as VoiceRoute) ?? null : null),
        liveAccount: codexAuth ? () => codexAuth.info() : undefined,
        send: (clientId, event) => {
          const res = clients.get(clientId)?.response;
          if (!res) return false;
          res.write(`data: ${JSON.stringify({ ...event, sequence: ++sequence })}\n\n`);
          return true;
        },
        log: (line) => console.log(line),
        audio: options.realtimeAudio,
        dropStopReport: options.dropStopReport,
        hideRevokeFromPage: options.hideRevokeFromPage,
        costLog: options.voiceCostLog,
        // 費用防護：每通上限讀 voice.json（每次連上時讀，選單列改了下一通生效；進行中的照它連上時的值）。
        maxCallMs: () => (options.voice?.view() ?? DEFAULT_VOICE_PREFS).realtime_max_call_s * 1000,
        // PRO-1：看著說話或喚醒開始（會打招呼的通話）時先取天氣，招呼決策時已在快取裡。
        ...(options.proactive ? { onGreetingStart: () => options.proactive?.prefetch() } : {}),
      })
    : null;
  const tasksFor = (target: ChatTarget | null) => tasksForTarget(store, options.memory ?? null, target);
  const cameraEnableStrict = options.cameraEnable === "main_process";
  const settings = {
    view: (source = pageSource(undefined)): SettingsView => {
      const live = sessions?.info();
      const cameraView = options.camera?.view();
      const camera = cameraView && cameraEnableStrict ? { ...cameraView, enable_via: "app" as const } : cameraView;
      const voice = options.voice?.view() ?? DEFAULT_VOICE_PREFS;
      return {
        ...options.settings.view(),
        ...(live ? { realtime: options.earlySpeechRms !== undefined ? { ...live, early_speech_rms: options.earlySpeechRms } : live } : {}),
        ...(camera ? { camera } : {}),
        ...(camera?.enabled && options.faceTuning ? { face_tuning: options.faceTuning.view() } : {}),
        voice,
        seconds: describeMenuPrefs({ camera, voice, voiceWritable: !!options.voice, realtime: live }),
        camera_preview_disabled_reason: cameraPreviewDisabledReason(camera),
        identity: options.identity?.status(source) ?? BROWSER_IDENTITY_STATUS,
        memory: options.memory?.settingsStatus() ?? BROWSER_MEMORY_STATUS,
        audio: { prefs: options.audio?.view() ?? { ...DEFAULT_AUDIO_PREFS }, write_path: AUDIO_WRITE_PATH },
        ...(options.wake ? { wake: wakeView(options.wake.view(), options.wake.runtime()) } : {}),
        ...(options.proactive ? { proactive: options.proactive.view() } : {}),
        ...(options.clock ? { clock: options.clock.view(source) } : {}),
        ...(options.homeCorner ? { home_corner: options.homeCorner.view(source) } : {}),
        ...(options.dayNight ? { day_night: options.dayNight.view() } : {}),
        ...(options.alarms ? { alarms: options.alarms.view(source) } : {}),
        ...(options.memories ? { memories: options.memories.view() } : {}),
        ...(options.integrations ? { integrations: { tools: options.integrations.registry.functionSpecs("api_key").map((t) => t.name), ...(options.integrations.builtinOnly ? { builtin_only: true } : {}) } } : {}),
        // VCR-2：只有註冊了 voice_relay 才有這個鍵（沒有時輸出和之前完全相同）。
        ...(options.integrations?.voiceRelay ? { voice_relay: true } : {}),
      };
    },
    select: (provider: ExecutorMode) => options.settings.select(provider),
  };
  const hosts = allowedHosts(options.port, options.devPort);

  const broadcast = (event: ServerEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const { response } of clients.values()) response.write(frame);
  };
  // 加密模式下 subscribe 收到的已經是外殼（TaskStore.commit）。
  store.subscribe((task) => broadcast({ type: "task.updated", sequence: ++sequence, task }));
  store.subscribeDeleted((deleted) => {
    // 記憶體裡為搜尋準備的純文字也一起丟掉。
    if (deleted.artifact_id) forgetHistoryArtifact(deleted.artifact_id);
    broadcast({ type: "task.deleted", sequence: ++sequence, ...deleted });
  });
  /**
   * 成果紀錄的搜尋來源：一般任務＋選用的其他來源。MEM-4a：macOS App 加密保存時，HTTP（/history 網頁與 /api/history）
   * 只搜得到外殼（「受保護的任務，請在 App 內查看」），真正內容只在 App 內經 IPC 搜尋。
   */
  const historySources: HistorySource[] = [
    { id: "tasks", get protected() { return store.sealed; }, documents: () => store.publicDocuments() },
    ...(options.historySources ?? []),
  ];

  const heartbeat = setInterval(() => {
    for (const { response } of clients.values()) response.write(": keep-alive\n\n");
  }, 25_000);
  heartbeat.unref();

  const server = createServer(async (req, res) => {
    try {
      const guard = checkRequest(req.method ?? "GET", req.headers, hosts);
      if (!guard.ok) throw new HttpError(guard.status, guard.message);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === COMMANDS_PATH) {
        // 唯讀的指令表：在 SPA fallback 之前，每次依目前設定產生。
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
        res.writeHead(200, commandsPageHeaders());
        res.end(method === "HEAD" ? undefined : renderCommandsPage(settings.view(), new Date(), normalizeLocale(url.searchParams.get("lang"))));
      } else if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname, url.searchParams);
      } else if (url.pathname.startsWith("/face-runtime/")) {
        serveFaceRuntime(res, req.method ?? "GET", url.pathname, options.faceRuntimeDir);
      } else if (url.pathname.startsWith("/speaker-runtime/")) {
        serveVerifiedRuntime(res, req.method ?? "GET", speakerRuntimePath(options.speakerRuntimeDir, url.pathname), readVerifiedSpeakerRuntime);
      } else if (url.pathname.startsWith("/wake-runtime/")) {
        // 旗標關閉、或引擎核對不是 ok（例如清單仍是 pending_first_build）時一律 404，模型檔也一樣（不落到 SPA fallback）；
        // ok 時只給清單上、雜湊相符的檔案。
        serveWakeRuntime(res, req.method ?? "GET", url.pathname, options.wake?.runtime() === "ok" ? options.wakeRuntimeDir : null);
      } else {
        // 喚醒只有在引擎核對通過時才需要編譯 wasm（WK-01a 清單是空的，所以 CSP 和旗標關閉時相同）。
        serveStatic(res, url.pathname, options.distDir, !!options.camera?.view().enabled, options.wake?.runtime() === "ok");
      }
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error(err);
      if (!res.headersSent) sendJson(res, code, { error: localize((err as Error).message, normalizeLocale(req.headers["x-nous-locale"])) });
      else res.end();
    }
  });
  server.on("close", () => clearInterval(heartbeat));

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, params: URLSearchParams): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && path === "/api/settings") return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    if (method === "POST" && path === "/api/settings/provider") {
      const body = await readJson(req);
      const provider = body.provider;
      if (provider !== "claude" && provider !== "chatgpt" && provider !== "mock") throw new HttpError(400, "unknown provider");
      try {
        settings.select(provider);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/settings/camera") {
      if (!options.camera) throw new HttpError(409, "鏡頭未設定");
      let patch: CameraPrefsPatch;
      try {
        patch = parseCameraPatch(await readJson(req));
      } catch (err) {
        if (err instanceof CameraPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      // App（cameraEnable: "main_process"）：頁面（以及任何本機頁面腳本）只能關掉鏡頭或改其他設定；打開只能由 App 主程序
      // 在原生說明之後經 NousHandle.camera 做（同 /api/settings/wake 的 wake_listen）。整個請求拒絕，什麼都不保存。
      // 關掉一定安全，所以照收。終端機／瀏覽器版（"http"）照舊可以打開。
      if (cameraEnableStrict && patch.active === true) throw new HttpError(403, "鏡頭只能從 App 打開");
      // update 會呼叫 onChange（→ notifySettings），這裡不重複廣播。
      try {
        options.camera.update(patch);
      } catch (err) {
        // 寫檔失敗：伺服器記憶體沒有改，回報真實原因，不顯示假成功。
        throw new HttpError(500, `鏡頭設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/settings/camera-tuning") {
      if (!options.faceTuning || !options.camera?.view().enabled) throw new HttpError(409, "鏡頭未啟用");
      const body = await readJson(req);
      try {
        if (body && typeof body === "object" && (body as Record<string, unknown>).reset === true) options.faceTuning.reset();
        else {
          const { calibrated, ...rest } = (body ?? {}) as Record<string, unknown>;
          options.faceTuning.update(parseFaceTuningPatch(rest), calibrated === true);
        }
      } catch (err) {
        if (err instanceof FaceTuningError) throw new HttpError(400, err.message);
        throw new HttpError(500, `校正值沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/settings/voice") {
      if (!options.voice) throw new HttpError(409, "語音設定未設定");
      let patch: VoicePrefsPatch;
      try {
        patch = parseVoicePatch(await readJson(req));
      } catch (err) {
        if (err instanceof VoicePatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.voice.update(patch);
      } catch (err) {
        throw new HttpError(500, `語音設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === AUDIO_WRITE_PATH) {
      if (!options.audio) throw new HttpError(409, "聲音裝置設定未設定");
      let patch: AudioPrefsPatch;
      try {
        patch = parseAudioPatch(await readJson(req));
      } catch (err) {
        if (err instanceof AudioPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        // update 會呼叫 onChange（→ notifySettings → SSE settings.updated），頁面與選單列都會更新。
        options.audio.update(patch);
      } catch (err) {
        throw new HttpError(500, `聲音裝置設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.wake && method === "POST" && path === "/api/settings/wake") {
      let patch: WakePrefsPatch;
      try {
        patch = parseWakePatch(await readJson(req));
      } catch (err) {
        if (err instanceof WakePatchError) throw new HttpError(400, err.message);
        throw err;
      }
      // 頁面（以及任何本機頁面腳本）只能記下麥克風或關掉；打開只能由 App 主程序在原生說明之後經 NousHandle.wake 做
      // （ADR-0003 §2.3）。關掉一定安全，所以這裡照收。
      if (patch.wake_listen === true) throw new HttpError(403, "常駐喚醒聆聽只能從 App 選單列打開");
      // SP-02a：只憑聲音叫名字的測試開關同樣只能由主程序在原生說明之後打開。
      if (patch.voice_name_test === true) throw new HttpError(403, "只憑聲音叫名字只能從 App 選單列打開");
      try {
        options.wake.update(patch);
      } catch (err) {
        // 寫檔失敗：記憶體沒有改（仍是保存前的值），回報真實原因，不顯示假成功。
        throw new HttpError(500, `常駐喚醒聆聽設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.clock && method === "GET" && path === WEATHER_NOW_PATH) {
      return sendJson(res, 200, await options.clock.weatherNow(normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.clock && method === "POST" && path === CLOCK_WRITE_PATH) {
      let patch: ClockPrefsPatch;
      try {
        patch = parseClockPatch(await readJson(req));
      } catch (err) {
        if (err instanceof ClockPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.clock.update(patch);
      } catch (err) {
        throw new HttpError(500, `時鐘設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.alarms && method === "POST" && (path === ALARM_WRITE_PATH || path.startsWith("/api/alarms/"))) {
      const alarms = options.alarms;
      const source = pageSource(req.headers["x-nous-terminal"]);
      const body = await readJson(req);
      const saved = <T>(work: () => T): T => {
        try {
          return work();
        } catch (err) {
          if (err instanceof AlarmPatchError) throw new HttpError(400, "鬧鐘與定時器的設定值不正確");
          console.warn(`鬧鐘／定時器：沒有保存（${(err as Error).message}）`);
          throw new HttpError(500, "定時器沒有保存（無法寫入設定檔）");
        }
      };
      if (path === ALARM_WRITE_PATH) saved(() => alarms.updatePrefs(body as Record<string, unknown>));
      else if (path === "/api/alarms/stop") {
        const by: StopSource = (STOP_SOURCES as readonly unknown[]).includes(body.by) ? (body.by as StopSource) : "button";
        saved(() => alarms.stopRings(by));
      } else if (path === "/api/alarms/ack") {
        if (typeof body.ring_id !== "string" || body.ring_id.length > 40) throw new HttpError(400, "ring_id is required");
        saved(() => alarms.ack(body.ring_id as string, source, body.playing === true, typeof body.reason === "string" ? body.reason : undefined));
      } else if (path === "/api/alarms/notice/clear") saved(() => alarms.clearNotice());
      else if (path === "/api/alarms/timers/cancel") {
        if (typeof body.id !== "string" || body.id.length > 40) throw new HttpError(400, "id is required");
        const r = saved(() => alarms.cancel(body.id));
        if (!r.ok && r.code !== "none" && r.code !== "not_found") throw new HttpError(409, r.message);
      } else if (path === "/api/alarms/clear") saved(() => alarms.clearAll());
      // ALARM-2：貪睡（響鈴畫面的按鈕、打字或通話中說「貪睡」）與設定頁的鬧鐘管理。
      else if (path === "/api/alarms/snooze") {
        const by: StopSource = (STOP_SOURCES as readonly unknown[]).includes(body.by) ? (body.by as StopSource) : "button";
        saved(() => alarms.snoozeRings(by));
      } else if (path === "/api/alarms/alarms/add") {
        const days = repeatDays(body.repeat, body.days);
        if (!days) throw new HttpError(400, "鬧鐘的重複規則不正確");
        const r = saved(() => alarms.setAlarm({ time: body.time, days, date: days.length ? undefined : body.date, label: body.label, origin: source }));
        if (!r.ok) throw new HttpError(r.code === "disabled" ? 409 : 400, r.message);
      } else if (path === "/api/alarms/alarms/enable" || path === "/api/alarms/alarms/delete") {
        if (typeof body.id !== "string" || body.id.length > 40) throw new HttpError(400, "id is required");
        const r = saved(() => (path.endsWith("/enable") ? alarms.setAlarmEnabled(body.id, body.enabled === true) : alarms.deleteAlarm(body.id)));
        if (!r.ok && r.code !== "none" && r.code !== "not_found") throw new HttpError(409, r.message);
      }
      else throw new HttpError(404, "not found");
      return sendJson(res, 200, localizeSettings(settings.view(source), normalizeLocale(req.headers["x-nous-locale"])));
    }

    if (options.dayNight && method === "POST" && path === DAY_NIGHT_WRITE_PATH) {
      let patch: DayNightPatch;
      try {
        patch = parseDayNightPatch(await readJson(req));
      } catch (err) {
        if (err instanceof DayNightPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.dayNight.update(patch);
      } catch (err) {
        throw new HttpError(500, `日夜間設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.homeCorner && method === "GET" && path === HOME_OVERVIEW_PATH) {
      return sendJson(res, 200, await options.homeCorner.overview());
    }
    if (options.homeCorner && method === "POST" && path === HOME_CORNER_WRITE_PATH) {
      let patch: HomeCornerPrefsPatch;
      try {
        patch = parseHomeCornerPatch(await readJson(req));
      } catch (err) {
        if (err instanceof HomeCornerPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.homeCorner.update(patch);
      } catch (err) {
        throw new HttpError(500, `家中狀態設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.proactive && method === "POST" && path === "/api/settings/proactive") {
      let patch: ProactivePrefsPatch;
      try {
        patch = parseProactivePatch(await readJson(req));
      } catch (err) {
        if (err instanceof ProactivePatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.proactive.update(patch);
      } catch (err) {
        if (err instanceof ProactivePatchError) throw new HttpError(400, err.message);
        throw new HttpError(500, `主動提醒設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (options.memories && method === "POST" && path === MEMORIES_WRITE_PATH) {
      let patch: MemoriesPrefsPatch;
      try {
        patch = parseMemoriesPatch(await readJson(req));
      } catch (err) {
        if (err instanceof MemoriesPatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        options.memories.update(patch);
      } catch (err) {
        throw new HttpError(500, `回憶模式設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    // MEMO-2：Google 相簿挑選。回應是整份設定（含 picker_uri），選單列與頁面直接套用。
    const google = options.memories?.google;
    if (google && method === "POST" && path === MEMORIES_GOOGLE_PATHS.pick) {
      const result = await google.pick();
      if (result === "unavailable") throw new HttpError(409, google.view().unavailable_reason ?? "Google 相簿不可用");
      if (result === "busy") throw new HttpError(409, "已經在挑選 Google 相簿");
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (google && method === "POST" && (path === MEMORIES_GOOGLE_PATHS.cancel || path === MEMORIES_GOOGLE_PATHS.clear)) {
      if (path === MEMORIES_GOOGLE_PATHS.cancel) google.cancel();
      else {
        try {
          google.clear();
        } catch {
          throw new HttpError(500, "Google 相簿快取沒有清除完");
        }
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (google && method === "GET" && path === MEMORIES_GOOGLE_PATHS.qr) {
      const svg = google.qrSvg();
      if (!svg) throw new HttpError(404, "not found");
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(svg);
      return;
    }
    if (options.memories && method === "GET" && path === MEMORIES_ITEMS_PATH) return sendJson(res, 200, { items: options.memories.items() });
    if (options.memories && path.startsWith(MEMORIES_MEDIA_PREFIX)) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      return serveMemoriesMedia(req, res, method, options.memories.file(path.slice(MEMORIES_MEDIA_PREFIX.length)));
    }
    if (method === "POST" && path === "/api/settings/realtime") {
      if (!options.realtimePrefs) throw new HttpError(409, "即時語音路徑設定未設定");
      let patch: RealtimePrefsPatch;
      try {
        patch = parseRealtimePatch(await readJson(req));
      } catch (err) {
        if (err instanceof RealtimePatchError) throw new HttpError(400, err.message);
        throw err;
      }
      try {
        // 只影響下一次開始；正在進行的工作階段維持原本的路徑（RealtimeSessions 只在 start 讀偏好）。
        options.realtimePrefs.update(patch);
      } catch (err) {
        throw new HttpError(500, `即時語音設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/chat") return streamChat(req, res);
    if (method === "POST" && path === "/api/realtime/start") {
      const body = await readJson(req);
      if (!sessions) throw new HttpError(409, "即時語音模式未啟用");
      const clientId = typeof body.client_id === "string" && CLIENT_ID.test(body.client_id) && clients.has(body.client_id) ? body.client_id : null;
      // source 只決定要不要發互動 ID（ID-02）、問候與限速，不是授權；其他值都當成 user。
      // wake_word（WK-02）只有 NOUS_WAKE=on（options.wake 存在）時才接受，旗標關閉時當成 user（行為和之前相同）。
      const source = body.source === "look_to_talk" ? "look_to_talk" : body.source === "wake_word" && options.wake ? "wake_word" : "user";
      const wakeId = source === "wake_word" && typeof body.wake_id === "string" && WAKE_ID.test(body.wake_id) ? body.wake_id : null;
      const locale = normalizeLocale(req.headers["x-nous-locale"]);
      // rebuild：MEM-2 記憶撤銷後頁面自動重建（只走 live、不問候）；只是開始方式，不是授權。
      // RPI-ID：哪個頁面開始的（X-Nous-Terminal），記憶候選與喚醒時窗只看那個頁面；不是授權。
      // app：macOS App 主視窗報的（費用防護：Mac 鎖定只結束這些）；不是授權。
      const decision = sessions.start(clientId, source, locale, body.rebuild === true, wakeId, pageSource(req.headers["x-nous-terminal"]), body.app === true);
      return sendJson(res, 200, decision.ok
        ? { ...decision, billing_line: localize(decision.billing_line, locale), notice: decision.notice === null ? null : localize(decision.notice, locale) }
        : { ...decision, message: localize(decision.message, locale) });
    }
    if (method === "POST" && path === "/api/realtime/call") {
      const body = await readJson(req);
      const sdp = typeof body.sdp === "string" ? body.sdp : "";
      if (!sdp.startsWith("v=0")) throw new HttpError(400, "sdp offer is required");
      if (body.session_id !== undefined) {
        // 經 /api/realtime/start 決定路徑的工作階段（兩條路徑）。
        if (!sessions) throw new HttpError(409, "即時語音模式未啟用");
        const { sessionId, owner } = sessionAuth(body);
        try {
          return sendJson(res, 200, await sessions.call(sdp, sessionId, owner));
        } catch (err) {
          if (err instanceof FallbackRequired) return sendJson(res, 409, err.offer);
          if (err instanceof RouteStartError) throw new HttpError(err.status, err.message);
          if (err instanceof SessionError) throw new HttpError(err.status, err.message);
          if (err instanceof RealtimeError) throw new HttpError(err.status, err.message);
          throw err;
        }
      }
      // 沒有 session_id：原本的 API key 路徑，行為不變。
      if (!realtime) throw new HttpError(409, "即時語音模式未啟用");
      try {
        // call ID 只留在核心（MEM-3 的旁路用），不交給頁面。
        const { sdp: answer, model } = await realtime.connect(sdp, store.publicList(), normalizeLocale(req.headers["x-nous-locale"]));
        return sendJson(res, 200, { sdp: answer, model });
      } catch (err) {
        if (err instanceof RealtimeError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (method === "POST" && path === "/api/realtime/input") {
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      const kind = body.kind;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!(LIVE_INPUT_KINDS as readonly unknown[]).includes(kind)) throw new HttpError(400, "kind must be user_text, notice, context or greeting");
      if (!text || text.length > MAX_TEXT_CHARS) throw new HttpError(400, `text is required (≤ ${MAX_TEXT_CHARS} chars)`);
      sessionCall(() => sessions!.input(sessionId, owner, kind as LiveInputKind, text));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/approval") {
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      let report: ApprovalReport;
      if (body.state === "open") {
        const ms = body.timeout_ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_APPROVAL_MS) throw new HttpError(400, `timeout_ms must be a number between 0 and ${MAX_APPROVAL_MS}`);
        report = { state: "open", timeout_ms: ms };
      } else if (body.state === "resolved") {
        if (!(APPROVAL_CARD_OUTCOMES as readonly unknown[]).includes(body.outcome)) throw new HttpError(400, `outcome must be one of ${APPROVAL_CARD_OUTCOMES.join(", ")}`);
        report = { state: "resolved", outcome: body.outcome as ApprovalCardOutcome };
      } else {
        throw new HttpError(400, "state must be open or resolved");
      }
      sessionCall(() => sessions!.approval(sessionId, owner, report));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/host-result") {
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      const callId = body.call_id;
      const output = body.output;
      if (typeof callId !== "string" || !CALL_ID.test(callId)) throw new HttpError(400, "call_id is required");
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new HttpError(400, "output must be a JSON object");
      const accepted = sessionCall(() => sessions!.hostResult(sessionId, owner, callId, { output: output as Record<string, unknown> }));
      return sendJson(res, 200, { ok: true, accepted });
    }
    if (method === "POST" && path === "/api/realtime/stopped") {
      // MEM-2：頁面在記憶撤銷後停播並核對的證據（只有布林值與毫秒數，沒有內容）。
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      const e = body.evidence as Record<string, unknown> | undefined;
      if (!e || typeof e !== "object" || typeof e.paused !== "boolean" || typeof e.peer_closed !== "boolean" || typeof e.tracks_ended !== "boolean" || typeof e.ms !== "number" || !Number.isFinite(e.ms) || e.ms < 0 || e.ms > 60_000) {
        throw new HttpError(400, "evidence must be {paused, peer_closed, tracks_ended, ms}");
      }
      const accepted = sessionCall(() => sessions!.stoppedReport(sessionId, owner, { paused: e.paused as boolean, peer_closed: e.peer_closed as boolean, tracks_ended: e.tracks_ended as boolean, ms: Math.round(e.ms as number) }));
      return sendJson(res, 200, { ok: true, accepted });
    }
    if (method === "POST" && path === "/api/realtime/playback") {
      // MEM-3：API key 路徑的頁面在資料通道收到播放結束（output_audio_buffer.stopped）。沒有內容也沒有時間戳：核心用收到的時間，
      // 只會把語音確認的時窗往後延，不能縮短。
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      sessionCall(() => sessions!.playback(sessionId, owner));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/stop-reply") {
      // F7：手掌停止（停止回覆）。沒有內容：核心只把這一輪還沒回來的工具結果改成不念出；任務照常、通話不結束。
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      // HIST-1 Mac F1：scope "turn"＝本機畫面指令，只有這一輪；response_id 形狀不對就當成還沒建立（null）。其他一律是手掌停止。
      const responseId = typeof body.response_id === "string" && STOP_REPLY_RESPONSE_ID.test(body.response_id) ? body.response_id : null;
      const turn = body.scope === "turn" ? { scope: "turn" as const, response_id: responseId } : undefined;
      sessionCall(() => sessions!.stopReply(sessionId, owner, turn));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/alive") {
      // 費用防護：頁面每 15 秒報到（兩條路徑）；API key 路徑附這通加總的 usage（只取認得的數字欄位、截上限；頁面回報，不是帳單）。
      // 第一次報到之後 45 秒沒有再報到，核心結束這通（client_lost）。
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      sessionCall(() => sessions!.alive(sessionId, owner, parseVoiceUsage(body.usage)));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/end") {
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      try {
        // WK-02（F6，不綁喚醒開關）：可選的結束原因（只有 no_voice）與 API key 路徑加總的 usage（只取認得的數字欄位、截上限）。
        await sessions!.end(sessionId, owner, { reason: parsePageEndReason(body.reason), usage: parseVoiceUsage(body.usage) });
      } catch (err) {
        if (err instanceof SessionError) throw new HttpError(err.status, err.message);
        throw err;
      }
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/terminal/heartbeat" && options.terminals) {
      // 只有識別碼；不記 IP、不寫檔、不逐次記 log（連線與斷線的轉換由 TerminalPresence 的呼叫端記）。
      const body = await readJson(req);
      if (!isTerminalId(body.terminal)) throw new HttpError(400, "terminal must be a lowercase id (a-z, 0-9, -; up to 32 characters)");
      options.terminals.heartbeat(body.terminal);
      return sendJson(res, 200, { ok: true });
    }
    if (options.terminalDisplay && path === TERMINAL_DISPLAY_PATH && (method === "POST" || method === "GET")) {
      // DN-3：頁面回報螢幕要開或關（POST）；Pi 的 aios-display 經 SSH 通道讀（GET ?terminal=）。只有識別碼與狀態，不記 log。
      if (method === "POST") {
        const body = await readJson(req);
        if (!isTerminalId(body.terminal)) throw new HttpError(400, "terminal must be a lowercase id (a-z, 0-9, -; up to 32 characters)");
        if (!isScreenState(body.screen)) throw new HttpError(400, "screen must be on or off");
        options.terminalDisplay.report(body.terminal, body.screen);
        return sendJson(res, 200, { ok: true });
      }
      const terminal = params.get("terminal");
      if (!isTerminalId(terminal)) throw new HttpError(400, "terminal must be a lowercase id (a-z, 0-9, -; up to 32 characters)");
      return sendJson(res, 200, options.terminalDisplay.view(terminal));
    }
    if (method === "POST" && path === "/api/terminal/identity" && options.identity?.handle) {
      // RPI-ID：Pi 的認人（特徵向量，不是影像或錄音）；不記 log（取樣約 2 Hz），核心自己記狀態轉換與問候決策。
      const out = await terminalIdentity(options.identity as TerminalIdentityPort, await readJson(req));
      if (out.status !== 200) throw new HttpError(out.status, out.error);
      return sendJson(res, 200, out.body);
    }
    if (method === "POST" && path === "/api/terminal/memory" && options.memory?.handle && options.memory.cardKind) {
      // RPI-ID：Pi 的「正在用 X 的記憶」與「不是我」（不含記憶內容）。
      const out = await terminalMemory(options.memory as TerminalMemoryPort, await readJson(req));
      if (out.status !== 200) throw new HttpError(out.status, out.error);
      return sendJson(res, 200, out.body);
    }
    if (method === "GET" && path === "/api/realtime/cost-records") {
      // WK-02（F6）：最近的費用紀錄（新的在前）；沒有逐字稿與音訊，費用一律 unknown。
      return sendJson(res, 200, { records: options.voiceCostLog?.list(parseCostLimit(params.get("limit"))) ?? [] });
    }
    if (options.integrations && method === "GET" && path === "/api/integrations/status") {
      // 按需的服務狀態（頁面要看時才查）：只有健康代碼、原因代碼與工具數，沒有網址、帳號或播放內容。
      return sendJson(res, 200, await options.integrations.status.view());
    }

    if (options.integrations?.voiceRelay && (path === "/api/voice-relay" || path.startsWith("/api/voice-relay/"))) {
      // VCR-2：設定頁「語音中繼（實驗）」診斷區（按需；和其他設定 POST 一樣只靠 http-guard）。沒有註冊 voice_relay 時落到 404。
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      let result: unknown;
      try {
        result = await handleVoiceRelayRoute(options.integrations.voiceRelay, method, path, () => readJson(req), controller.signal);
      } catch (err) {
        if (err instanceof VoiceRelayStoreError) throw new HttpError(err.status, err.message);
        throw err;
      }
      if (result !== undefined) return sendJson(res, 200, result);
    }

    if (options.integrations && method === "POST" && path === "/api/integrations/call") {
      // API key 路徑的頁面收到 app__ 工具呼叫時轉交核心執行；只接受開始這通即時語音的頁面（session_id＋owner），
      // 路徑由核心依工作階段決定（頁面不能指定），工具必須是這條路徑上現在可用的（Dispatcher 再檢查一次）。
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      if (!sessions?.isOwner(sessionId, owner)) throw new HttpError(403, "不是開始這個即時語音的頁面。");
      const route = sessions.routeOf(sessionId);
      if (route !== "api_key") throw new HttpError(409, "這個工作階段的整合工具由核心直接執行。");
      const name = typeof body.name === "string" ? body.name : "";
      if (typeof body.arguments !== "string") throw new HttpError(400, "arguments must be a JSON string");
      const args = body.arguments;
      if (!name || name.length > 64) throw new HttpError(400, "valid name is required");
      if (args.length > 8_192) throw new HttpError(400, "arguments are too long");
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const page = sessions.pageOf(sessionId);
      return sendJson(res, 200, await options.integrations.dispatcher.execute({ tool: name, args, route, actor: "agent", sessionId, signal: controller.signal, ...(page ? { page } : {}) }));
    }

    if (method === "POST" && path === "/api/realtime/web-search") {
      const body = await readJson(req);
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) throw new HttpError(400, "query is required");
      if (query.length > 500) throw new HttpError(400, "query is too long");
      // ChatGPT 方案路徑的工作階段：用 Codex 額度查（同一個登入）；其他照舊用 OPENAI_API_KEY。
      let via: "api_key" | "codex" = "api_key";
      if (body.session_id !== undefined) {
        const { sessionId, owner } = sessionAuth(body);
        if (!sessions?.isOwner(sessionId, owner)) throw new HttpError(403, "不是開始這個即時語音的頁面。");
        if (sessions.routeOf(sessionId) === "live") via = "codex";
      }
      if (!webSearch?.availableVia(via)) {
        throw new HttpError(409, via === "codex" ? "上網查詢未啟用（ChatGPT 方案路徑尚未登入）" : "上網查詢未啟用（需要 OPENAI_API_KEY）");
      }
      try {
        return sendJson(res, 200, via === "codex" ? await webSearch.searchVia(query, "codex") : await webSearch.search(query));
      } catch (err) {
        if (err instanceof WebSearchError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (method === "POST" && path === "/api/auth/codex/login") {
      const body = await readJson(req);
      if (!codexAuth) throw new HttpError(409, "ChatGPT 方案即時語音未設定");
      const how = body.method === "device" ? "device" : "browser";
      try {
        return sendJson(res, 200, await codexAuth.startLogin(how, normalizeLocale(req.headers["x-nous-locale"])));
      } catch (err) {
        throw new HttpError(502, (err as Error).message);
      }
    }
    if (method === "POST" && path === "/api/auth/codex/cancel") {
      await readJson(req);
      codexAuth?.cancel();
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/codex/logout") {
      await readJson(req);
      if (!codexAuth) throw new HttpError(409, "ChatGPT 方案即時語音未設定");
      const result = await codexAuth.logout();
      return sendJson(res, 200, { ...result, settings: settings.view(pageSource(req.headers["x-nous-terminal"])) });
    }
    if (method === "POST" && path === "/api/home/status") {
      const body = await readJson(req);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const metric = typeof body.metric === "string" ? body.metric.trim() : null;
      if (!target) throw new HttpError(400, "target is required");
      if (target.length > HOME_ARG_MAX.target || (metric?.length ?? 0) > HOME_ARG_MAX.metric) throw new HttpError(400, "target or metric is too long");
      return sendJson(res, 200, await homeCall(() => home!.status(target, metric), HOME_TOOL.status, { target, ...(metric !== null ? { metric } : {}) }));
    }
    if (method === "POST" && path === "/api/home/control") {
      const body = await readJson(req);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const command = typeof body.command === "string" ? body.command.trim() : "";
      const value = body.value ?? null;
      if (!target || !command) throw new HttpError(400, "target and command are required");
      if (target.length > HOME_ARG_MAX.target || command.length > HOME_ARG_MAX.command) throw new HttpError(400, "target or command is too long");
      if (!(value === null || typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.length <= HOME_ARG_MAX.value))) {
        throw new HttpError(400, "value must be a short string, a number or a boolean");
      }
      return sendJson(res, 200, await homeCall(() => home!.control({ target, command, value: value as ControlRequest["value"] }), HOME_TOOL.control, { target, command, ...(value !== null ? { value } : {}) }));
    }
    if (method === "POST" && path === "/api/home/confirm") {
      const body = await readJson(req);
      const id = body.confirm_id;
      if (typeof id !== "string" || !/^home_[\w-]{1,64}$/.test(id) || typeof body.approve !== "boolean") {
        throw new HttpError(400, "confirm_id and approve are required");
      }
      const approve = body.approve;
      return sendJson(res, 200, await homeCall(() => home!.confirm(id, approve), HOME_TOOL.confirm, { confirm_id: id, approve }));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/login") {
      const body = await readJson(req);
      const mode = body.mode === "new" ? "new" : "auto";
      return sendJson(res, 200, await auth.startLogin(mode, normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/cancel") {
      await readJson(req);
      auth.cancelPending();
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/logout") {
      await readJson(req);
      const result = await auth.logout();
      return sendJson(res, 200, { ...result, settings: settings.view(pageSource(req.headers["x-nous-terminal"])) });
    }
    if (method === "POST" && path === "/api/auth/chatgpt/welcome-ack") {
      await readJson(req);
      auth.ackWelcome();
      return sendJson(res, 200, localizeSettings(settings.view(pageSource(req.headers["x-nous-terminal"])), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "GET" && path === "/api/tasks") return sendJson(res, 200, store.publicList());
    if (method === "GET" && path === "/api/events") return openEvents(req, res);

    if (method === "POST" && path === "/api/tasks") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, "text is required");
      if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `text exceeds ${MAX_TEXT_CHARS} chars`);
      // origin "typed"：呼叫端明確表示這是使用者打的原句（審查 M2；只影響之後重做時能不能重新取用記憶）。
      const created = runner.submit({ title: text, request_id: requestId(body), ...(normalizeLocale(req.headers["x-nous-locale"]) === "en" ? { locale: "en" as const } : {}), ...(body.origin === "typed" ? { origin: "user_sentence" as const } : {}) });
      return sendJson(res, 201, store.publicGet(created.task_id));
    }

    // HIST-1 成果紀錄：搜尋（記憶體內比對，不寫索引、不記查詢文字）、單筆詳細、經明確確認的刪除。
    if (method === "GET" && path === "/api/history") {
      let query: ReturnType<typeof parseHistoryQuery>;
      try {
        query = parseHistoryQuery(params);
      } catch (err) {
        if (err instanceof HistoryQueryError) throw new HttpError(400, err.message);
        throw err;
      }
      return sendJson(res, 200, searchHistory(historySources, query));
    }
    const historyItem = path.match(/^\/api\/history\/([\w-]+)$/);
    if (method === "GET" && historyItem) {
      const task = store.publicGet(historyItem[1]);
      if (!task) throw new HttpError(404, "找不到這個任務");
      const detail: HistoryDetail = { task, artifact: task.artifact_id ? store.publicArtifact(task.artifact_id) ?? null : null, source: "tasks", protected: store.sealed };
      return sendJson(res, 200, detail);
    }
    const historyDelete = path.match(/^\/api\/history\/([\w-]+)\/delete$/);
    if (method === "POST" && historyDelete) {
      const body = await readJson(req);
      requestId(body);
      // 刪除不能復原：頁面先經原生確認，再帶 confirm: true；沒有就不刪。
      if (body.confirm !== true) throw new HttpError(400, "刪除需要明確確認");
      const result = store.delete(historyDelete[1]);
      if (!result.ok && result.reason === "not_found") throw new HttpError(404, "找不到這個任務");
      if (!result.ok) throw new HttpError(409, "執行中的任務不能刪除，請先停止任務");
      return sendJson(res, 200, result);
    }

    const artifact = path.match(/^\/api\/artifacts\/([\w-]+)$/);
    if (method === "GET" && artifact) {
      // MEM-4a：加密保存時成果內容不經 HTTP（一律 404）；macOS App 的主視窗經 IPC 讀。
      const found = store.publicArtifact(artifact[1]);
      if (!found) throw new HttpError(404, "artifact not found");
      return sendJson(res, 200, found);
    }

    const action = path.match(/^\/api\/tasks\/([\w-]+)\/(cancel|retry)$/);
    if (method === "POST" && action) {
      const [, taskId, verb] = action;
      const body = await readJson(req);
      if (verb === "cancel") {
        const task = runner.cancel(taskId);
        if (!task) throw new HttpError(404, "task not found");
        return sendJson(res, 200, store.publicGet(task.task_id));
      }
      // redo：成果紀錄的「重做」，也接受已完成的任務（同樣建立新任務、記下 retry_of）。
      const redo = body.redo === true;
      const task = runner.retry(taskId, requestId(body), { redo });
      if (!task) throw new HttpError(409, redo ? "only finished tasks can be redone" : "only failed or cancelled tasks can be retried");
      return sendJson(res, 201, store.publicGet(task.task_id));
    }

    throw new HttpError(404, "not found");
  }

  /** session_id 與 owner：格式不對 400；擁有者由 RealtimeSessions 比對。 */
  function sessionAuth(body: Record<string, unknown>): { sessionId: string; owner: string } {
    if (!sessions) throw new HttpError(409, "即時語音模式未啟用");
    const sessionId = body.session_id;
    const owner = body.owner;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new HttpError(400, "valid session_id is required");
    if (typeof owner !== "string" || !OWNER.test(owner)) throw new HttpError(400, "valid owner is required");
    return { sessionId, owner };
  }

  function sessionCall<T>(run: () => T): T {
    try {
      return run();
    } catch (err) {
      if (err instanceof SessionError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /** 武陵居中控的呼叫：未設定時 409；連不上、權杖被拒等照實轉成 HTTP 錯誤。 */
  /**
   * 家電 API。AIL-2：整合層註冊了 home Facade（NOUS_AIL=on、NOUS_AIL_SERVICES 有 home、中控已設定）時改經 Dispatcher 呼叫 HomeBridge，
   * HTTP 回應（狀態碼、內容）和直接呼叫完全相同；沒有 Facade 時照原本直接呼叫。
   */
  async function homeCall<T>(run: () => Promise<T>, tool: string, args: Record<string, unknown>): Promise<T> {
    if (!home?.available) throw new HttpError(409, "尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）");
    const ail = options.integrations;
    if (ail && ail.registry.status(tool as IntegrationToolId, "page") === "available") {
      const result = await ail.dispatcher.execute({ tool, args, route: "page", actor: tool === HOME_TOOL.confirm ? "user" : "agent", sessionId: "page" });
      const data = result.data as { legacy?: T; http_error?: { status: number; message: string }; rethrow?: unknown } | undefined;
      if (data?.legacy !== undefined) return data.legacy;
      if (data && "rethrow" in data) throw data.rethrow;
      if (data?.http_error) throw new HttpError(data.http_error.status, data.http_error.message);
      // Dispatcher 自己的結果（參數不合、逾時、Adapter 出錯）：頁面原本只會收到 HTTP 錯誤，照樣回錯誤；
      // 控制指令逾時或出錯時，HomeBridge 可能已經送出，所以說不確定有沒有執行。
      if (result.status === "refused") throw new HttpError(400, result.message);
      if (tool !== HOME_TOOL.status && result.status === "unknown") throw new HttpError(504, "武陵居中控沒有在時限內回覆，不確定有沒有執行，請看一下設備。");
      throw new HttpError(502, result.message);
    }
    try {
      return await run();
    } catch (err) {
      if (err instanceof HomeBridgeError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /**
   * 語音對話：以 SSE 串流回覆文字；客戶端中斷（插話）時一併中止上游請求。
   * 記憶（16 §7、§8）：帶 memory_turn 時由 MemoryService.withChat 驗證並檢索，整個串流包在它的 lease 裡；每個片段經 ctx.deliver
   * 交付（撤銷後不再送），撤銷時送 memory_revoked 並中止上游。done 只附 memory_used 筆數，不附內容。
   * 帶記憶的那一輪，或對話歷史裡有用過記憶的回答（ctx.blockDelegation，含語音來源與沒有 memory_turn 的請求）都不交辦：
   * 模型的交辦改送 delegate_blocked，標題用使用者原句（不讓受記憶影響的改寫進明文任務）。
   */
  async function streamChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const id = requestId(body);
    const messages = validateMessages(body.messages);
    if (!messages) throw new HttpError(400, "messages must be 1–40 user/assistant turns ending with user");
    const locale = normalizeLocale(req.headers["x-nous-locale"]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const lastUser = messages[messages.length - 1]!.content;
    let revoked = false;
    const run = async (ctx: MemoryContext | null) => {
      const filter = new DelegationFilter();
      const used = ctx?.facts.length ?? 0;
      const block = used > 0 || ctx?.blockDelegation === true;
      const signal = ctx?.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
      ctx?.signal?.addEventListener("abort", () => {
        if (revoked || controller.signal.aborted) return;
        revoked = true;
        send({ type: "memory_revoked", message: localize("記憶已撤銷（換人、更正、忘記或關閉記憶）；這次回覆已停止", locale) });
      }, { once: true });
      const deliver = (output: () => void) => (ctx ? ctx.deliver(output) : (output(), true));
      let answer = "";
      let blocked = false;
      // MEM-4a：放行 task 路徑而且這一輪是可信主視窗的打字時，交辦改走受保護交辦（串流結束後由核心建立，標題是使用者原句）。
      let protectedDelegate = false;
      const emit = (text: string, delegates: string[]) => deliver(() => {
        if (text) { answer += text; send({ type: "delta", text }); }
        for (const title of delegates) {
          if (ctx?.delegate) protectedDelegate = true;
          else if (block) {
            if (!blocked) send({ type: "delegate_blocked", title: lastUser });
            blocked = true;
          } else send({ type: "delegate", title });
        }
      });
      // MEM-4a：任務標題只在這個服務帳號有記憶同意時才給模型看（帶記憶的任務另外要同意對象與人物相符）；其他一律外殼。
      const taskView = tasksFor(chat.chatTarget?.() ?? null);
      const { model } = await chat.chat(
        { system: buildChatSystem(taskView, new Date(), locale, ctx?.facts ?? []), messages },
        (delta) => {
          const { text, delegates } = filter.push(delta);
          emit(text, delegates);
        },
        signal,
      );
      const rest = filter.flush();
      if (rest) emit(rest, []);
      if (revoked) return;
      if (protectedDelegate && ctx?.delegate) {
        const out = await ctx.delegate(locale);
        if (revoked) return;
        // 對外只送外殼；真正標題由主視窗經 IPC 讀。沒能受保護交辦時照 M15 出交辦卡（標題是使用者原句）。
        if (out) deliver(() => send({ type: "delegated", task: store.publicGet(out.task.task_id) ?? out.task, memory_used: out.used }));
        else deliver(() => send({ type: "delegate_blocked", title: lastUser }));
      }
      if (options.memory) {
        // 模型說「記住了」但核心這一輪沒有成功回條：照實補一句（模型不能代替核心回條）。
        if (MEMORY_CLAIM.test(answer) && !ctx?.saved) send({ type: "memory_notice", message: localize("這次沒有保存到記憶", locale) });
        else if (ctx?.notice) send({ type: "memory_notice", message: translate(ctx.notice.message, locale, ...ctx.notice.values) });
      }
      deliver(() => send({ type: "done", model, ...(options.memory ? { memory_used: used } : {}) }));
    };
    try {
      if (options.memory) await options.memory.withChat({ nonce: body.memory_turn, requestId: id, lastUser, target: chat.chatTarget?.() ?? null, historyLength: messages.length }, run);
      else await run(null);
    } catch (err) {
      if (!controller.signal.aborted && !revoked) {
        send({
          type: "error",
          message: localize(err instanceof ExecutionError ? err.userMessage : `對話失敗：${(err as Error).message}`, locale),
          action: err instanceof ExecutionError ? err.action : null,
        });
      }
    }
    res.end();
  }

  let sourceChangeQueued = false;
  function queueSourceChange(): void {
    if (sourceChangeQueued) return;
    sourceChangeQueued = true;
    setTimeout(() => {
      sourceChangeQueued = false;
      notifyAll();
    }, 200).unref?.();
  }

  function notifyAll(): void {
    const updateSequence = ++sequence;
    for (const { response, source } of clients.values()) {
      const event: ServerEvent = { type: "settings.updated", sequence: updateSequence, settings: settings.view(source) };
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const clientId = `sse_${randomUUID().replaceAll("-", "")}`;
    const source = pageSource(new URL(req.url ?? "/", "http://localhost").searchParams.get("terminal"));
    const hello: ServerEvent = { type: "hello", sequence: ++sequence, settings: settings.view(source), tasks: store.publicList(), client_id: clientId };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);
    const sourceCount = (s: string) => [...clients.values()].filter((c) => c.source === s).length;
    const firstOfSource = sourceCount(source) === 0;
    clients.set(clientId, { response: res, source });
    // ALARM-3：某個頁面來源第一次連上或最後一條串流斷掉時，其他頁面的「到期時會不會在這裡響」（倒數）會變，重推設定。
    if (firstOfSource && options.alarms) queueSourceChange();
    req.on("close", () => {
      clients.delete(clientId);
      if (sourceCount(source) === 0 && options.alarms) queueSourceChange();
      // 這條串流擁有的 live 工作階段立刻結束（不假裝重連）。
      sessions?.clientClosed(clientId);
    });
  }

  return Object.assign(server, {
    realtimeSessions: sessions,
    /** 設定或登入狀態改變時呼叫，推送給所有畫面。 */
    notifySettings: () => notifyAll(),
    /** ALARM-1：現在有 SSE 串流的頁面來源（"main" 或終端機識別碼）。 */
    connectedSources: (): Set<string> => new Set([...clients.values()].map((c) => c.source)),
    /** RPI-ID：本次人物世代改變（不含內容）；每個頁面（含 Pi）自己用 status 重讀。Mac 主視窗另有 IPC 通知。 */
    notifyMemoryPresence: () => broadcast({ type: "memory.presence_changed", sequence: ++sequence }),
  });
}

function requestId(body: Record<string, unknown>): string {
  const id = body.request_id;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new HttpError(400, "valid request_id is required");
  return id;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "body must be a JSON object");
}

/** settings.wake：偏好、引擎核對結果，以及套上門檻調整值之後每個喚醒詞的門檻（設定頁顯示用）。 */
function wakeView(prefs: WakePrefs, runtime: WakeRuntimeState) {
  return { ...prefs, runtime, thresholds: effectiveWakeThresholds(wakeManifest.keywords as WakeKeywordConfig, prefs.wake_threshold_offset ?? 0) };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function serveStatic(res: ServerResponse, pathname: string, distDir: string | null, camera = false, wake = false): void {
  if (!distDir || !existsSync(join(distDir, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("前端尚未建置：請用 npm start（會先 vite build），或開發時用 npm run dev:web。");
    return;
  }
  // 成果紀錄的獨立網頁（HIST-1）：只有使用者自己打開 /history 才提供，不是預設頁。
  if (pathname === "/history" || pathname === "/history/") pathname = "/history.html";
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(distDir, relative);
  if (!file.startsWith(distDir + sep) && file !== distDir) throw new HttpError(403, "forbidden");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type };
  if (type.startsWith("text/html")) Object.assign(headers, file.endsWith(`${sep}history.html`) ? historyPageHeaders() : pageHeaders(camera, wake), { "Cache-Control": "no-cache" });
  if (type.startsWith("text/javascript")) Object.assign(headers, scriptHeaders());
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

/** MEMO-1：回憶的照片與影片。支援單一 Range（影片拖曳與 Chromium 播放需要）；回應與錯誤都不含檔案路徑。 */
function serveMemoriesMedia(req: IncomingMessage, res: ServerResponse, method: string, file: { path: string; type: string } | null): void {
  if (!file) throw new HttpError(404, "not found");
  let size: number;
  try {
    size = statSync(file.path).size;
  } catch {
    throw new HttpError(404, "not found");
  }
  const headers: Record<string, string> = { "Content-Type": file.type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" };
  const range = parseByteRange(req.headers.range, size);
  if (range === "invalid") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": String(Math.max(0, end - start + 1)), ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  if (method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  // pipeline：用戶端中途斷線（影片 Range 常被 Chromium 取消）時也關掉檔案，不留 fd。
  pipeline(createReadStream(file.path, { start, end }), res, () => undefined);
}

/** 家人辨識的模型與 onnxruntime wasm：只給清單上的檔名，沒有 SPA fallback；不存在 404，雜湊不符 503。 */
function serveFaceRuntime(res: ServerResponse, method: string, pathname: string, dir: string | null | undefined): void {
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
  const file = faceRuntimePath(dir, pathname);
  if (!file || !existsSync(file)) throw new HttpError(404, "not found");
  // 每次讀取都核對雜湊：啟動後才被換掉的檔案也不會送出去。
  const body = readVerifiedFaceRuntime(file);
  if (!body) throw new HttpError(503, "face runtime file failed verification");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (type.startsWith("text/javascript")) Object.assign(headers, scriptHeaders());
  res.writeHead(200, headers);
  res.end(method === "HEAD" ? undefined : body);
}

/** SP-01 講者模型與 onnxruntime wasm：同 serveFaceRuntime（只給清單上的檔名，不存在 404，雜湊不符 503）。 */
function serveVerifiedRuntime(res: ServerResponse, method: string, file: string | null, read: (path: string) => Buffer | null): void {
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
  if (!file || !existsSync(file)) throw new HttpError(404, "not found");
  const body = read(file);
  if (!body) throw new HttpError(503, "runtime file failed verification");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (type.startsWith("text/javascript")) Object.assign(headers, scriptHeaders());
  res.writeHead(200, headers);
  res.end(method === "HEAD" ? undefined : body);
}

/** 喚醒引擎檔案：只給清單上的檔名，沒有 SPA fallback；不存在、旗標關閉或引擎不是 ok 時 404，雜湊不符 503。 */
function serveWakeRuntime(res: ServerResponse, method: string, pathname: string, dir: string | null | undefined): void {
  if (!dir) throw new HttpError(404, "not found");
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
  const file = wakeRuntimePath(dir, pathname);
  if (!file || !existsSync(file)) throw new HttpError(404, "not found");
  const body = readVerifiedWakeRuntime(file);
  if (!body) throw new HttpError(503, "wake runtime file failed verification");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (type.startsWith("text/javascript")) Object.assign(headers, scriptHeaders());
  res.writeHead(200, headers);
  res.end(method === "HEAD" ? undefined : body);
}
