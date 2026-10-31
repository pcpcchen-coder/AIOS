import { localize, localizeSettings } from "./localization.ts";
import { normalizeLocale, translate } from "../shared/i18n.mjs";
import { BROWSER_MEMORY_STATUS, MEMORY_CLAIM, type MemorySettingsStatus } from "../shared/memory.ts";
import type { ChatTarget } from "./memory/retrieve.ts";
import type { MemoryContext } from "./memory/service.ts";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
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
import { cameraPreviewDisabledReason, describeMenuPrefs } from "../shared/seconds-menu.ts";
import { DEFAULT_VOICE_PREFS, parseVoicePatch, VoicePatchError, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import { allowedHosts, checkRequest } from "./http-guard.ts";
import { ApiKeyRoute, FallbackRequired, RealtimeSessions, RouteStartError, SessionError, type RealtimeRoute } from "./realtime-routes.ts";
import type { CodexAuth } from "./codex-auth.ts";
import {
  APPROVAL_CARD_OUTCOMES,
  LIVE_INPUT_KINDS,
  parseRealtimePatch,
  RealtimePatchError,
  type ApprovalCardOutcome,
  type ApprovalReport,
  type LiveInputKind,
  type RealtimePrefs,
  type RealtimePrefsPatch,
} from "../shared/realtime-route.ts";
import { COMMANDS_PATH, commandsPageHeaders, renderCommandsPage } from "./commands-page.ts";
import { BROWSER_IDENTITY_STATUS, type IdentityStatus } from "../shared/identity.ts";
import { faceRuntimePath, readVerifiedFaceRuntime } from "./face-runtime.ts";
import { readVerifiedWakeRuntime, wakeRuntimePath } from "./wake-runtime.ts";
import { parseWakePatch, WakePatchError, type WakePrefs, type WakePrefsPatch, type WakeRuntimeState } from "../shared/wake.ts";
import { historyPageHeaders, pageHeaders } from "./page-headers.ts";
import type { TaskRunner } from "./runner.ts";
import { tasksForTarget, type TaskStore } from "./store.ts";
import type { VoiceRoute } from "./memory/live.ts";
import { forgetHistoryArtifact, HistoryQueryError, parseHistoryQuery, searchHistory, type HistorySource } from "./history.ts";
import type { HistoryDetail } from "../shared/history.ts";

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
  };
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
  /** 雙目鏡頭設定（docs/11，通常是 CameraSettingsStore）；未提供或未啟用時頁面不允許使用鏡頭。 */
  camera?: CameraSettingsSource;
  /** 語音閒置秒數（通常是 VoiceSettingsStore）；未提供時用預設值且不能修改。 */
  voice?: VoiceSettingsSource;
  /** 人臉辨識校正值（FaceTuningStore）；只在鏡頭啟用時提供。 */
  faceTuning?: FaceTuningSource;
  /** F2／F10：本機開口偵測門檻（NOUS_EARLY_SPEECH_RMS）；未提供時頁面用預設值。 */
  earlySpeechRms?: number;
  /**
   * 家人辨識的狀態（IdentityService）：只有可用與否與人數。身分資料（姓名、識別碼、特徵）只走 Electron IPC，
   * 這裡沒有任何身分路由。未提供（瀏覽器版）時回報不可用。
   */
  identity?: { status(): IdentityStatus };
  /** 家人辨識模型與 onnxruntime wasm 的資料夾（只提供清單上的檔名）；未提供時 /face-runtime/ 一律 404。 */
  faceRuntimeDir?: string | null;
  /**
   * WK-01a：常駐喚醒聆聽（只有 NOUS_WAKE=on 時提供，通常是 WakeSettingsStore 加上引擎核對結果）。未提供時沒有
   * /api/settings/wake、settings 沒有 wake 欄位、/wake-runtime/ 一律 404，和加入喚醒程式之前相同。
   */
  wake?: WakeSettingsSource;
  /** 喚醒引擎檔案的資料夾（只提供 shared/wake-runtime.json 清單上、雜湊相符的檔名；WK-01a 清單為空）。 */
  wakeRuntimeDir?: string | null;
  /**
   * 成果紀錄（HIST-1）額外的搜尋來源；一般任務（TaskStore）一律包含。MEM-4c 的受保護成果之後由這裡併入。
   */
  historySources?: HistorySource[];
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

export function createApp(options: AppOptions): Server & { notifySettings(): void; realtimeSessions: RealtimeSessions | null } {
  const { store, runner, auth, chat, realtime, webSearch, home, codexAuth } = options;
  /** SSE 串流：client_id → 回應。工具呼叫只送到擁有工作階段的那一條。 */
  const clients = new Map<string, ServerResponse>();
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
          const res = clients.get(clientId);
          if (!res) return false;
          res.write(`data: ${JSON.stringify({ ...event, sequence: ++sequence })}\n\n`);
          return true;
        },
        log: (line) => console.log(line),
        audio: options.realtimeAudio,
        dropStopReport: options.dropStopReport,
        hideRevokeFromPage: options.hideRevokeFromPage,
      })
    : null;
  const tasksFor = (target: ChatTarget | null) => tasksForTarget(store, options.memory ?? null, target);
  const settings = {
    view: (): SettingsView => {
      const live = sessions?.info();
      const camera = options.camera?.view();
      const voice = options.voice?.view() ?? DEFAULT_VOICE_PREFS;
      return {
        ...options.settings.view(),
        ...(live ? { realtime: options.earlySpeechRms !== undefined ? { ...live, early_speech_rms: options.earlySpeechRms } : live } : {}),
        ...(camera ? { camera } : {}),
        ...(camera?.enabled && options.faceTuning ? { face_tuning: options.faceTuning.view() } : {}),
        voice,
        seconds: describeMenuPrefs({ camera, voice, voiceWritable: !!options.voice, realtime: live }),
        camera_preview_disabled_reason: cameraPreviewDisabledReason(camera),
        identity: options.identity?.status() ?? BROWSER_IDENTITY_STATUS,
        memory: options.memory?.settingsStatus() ?? BROWSER_MEMORY_STATUS,
        ...(options.wake ? { wake: { ...options.wake.view(), runtime: options.wake.runtime() } } : {}),
      };
    },
    select: (provider: ExecutorMode) => options.settings.select(provider),
  };
  const hosts = allowedHosts(options.port, options.devPort);

  const broadcast = (event: ServerEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients.values()) res.write(frame);
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
    for (const res of clients.values()) res.write(": keep-alive\n\n");
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
    if (method === "GET" && path === "/api/settings") return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
    if (method === "POST" && path === "/api/settings/provider") {
      const body = await readJson(req);
      const provider = body.provider;
      if (provider !== "claude" && provider !== "chatgpt" && provider !== "mock") throw new HttpError(400, "unknown provider");
      try {
        settings.select(provider);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
      // update 會呼叫 onChange（→ notifySettings），這裡不重複廣播。
      try {
        options.camera.update(patch);
      } catch (err) {
        // 寫檔失敗：伺服器記憶體沒有改，回報真實原因，不顯示假成功。
        throw new HttpError(500, `鏡頭設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
      try {
        options.wake.update(patch);
      } catch (err) {
        // 寫檔失敗：記憶體沒有改（仍是保存前的值），回報真實原因，不顯示假成功。
        throw new HttpError(500, `常駐喚醒聆聽設定沒有保存（無法寫入設定檔：${(err as Error).message}）`);
      }
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/chat") return streamChat(req, res);
    if (method === "POST" && path === "/api/realtime/start") {
      const body = await readJson(req);
      if (!sessions) throw new HttpError(409, "即時語音模式未啟用");
      const clientId = typeof body.client_id === "string" && CLIENT_ID.test(body.client_id) && clients.has(body.client_id) ? body.client_id : null;
      // source 只決定要不要發看著說話的互動 ID（ID-02），不是授權；其他值都當成 user。
      const locale = normalizeLocale(req.headers["x-nous-locale"]);
      // rebuild：MEM-2 記憶撤銷後頁面自動重建（只走 live、不問候）；只是開始方式，不是授權。
      const decision = sessions.start(clientId, body.source === "look_to_talk" ? "look_to_talk" : "user", locale, body.rebuild === true);
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
      sessionCall(() => sessions!.stopReply(sessionId, owner));
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/realtime/end") {
      const body = await readJson(req);
      const { sessionId, owner } = sessionAuth(body);
      try {
        await sessions!.end(sessionId, owner);
      } catch (err) {
        if (err instanceof SessionError) throw new HttpError(err.status, err.message);
        throw err;
      }
      return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/codex/logout") {
      await readJson(req);
      if (!codexAuth) throw new HttpError(409, "ChatGPT 方案即時語音未設定");
      const result = await codexAuth.logout();
      return sendJson(res, 200, { ...result, settings: settings.view() });
    }
    if (method === "POST" && path === "/api/home/status") {
      const body = await readJson(req);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const metric = typeof body.metric === "string" ? body.metric.trim() : null;
      if (!target) throw new HttpError(400, "target is required");
      if (target.length > 100 || (metric?.length ?? 0) > 40) throw new HttpError(400, "target or metric is too long");
      return sendJson(res, 200, await homeCall(() => home!.status(target, metric)));
    }
    if (method === "POST" && path === "/api/home/control") {
      const body = await readJson(req);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const command = typeof body.command === "string" ? body.command.trim() : "";
      const value = body.value ?? null;
      if (!target || !command) throw new HttpError(400, "target and command are required");
      if (target.length > 100 || command.length > 40) throw new HttpError(400, "target or command is too long");
      if (!(value === null || typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.length <= 40))) {
        throw new HttpError(400, "value must be a short string, a number or a boolean");
      }
      return sendJson(res, 200, await homeCall(() => home!.control({ target, command, value: value as ControlRequest["value"] })));
    }
    if (method === "POST" && path === "/api/home/confirm") {
      const body = await readJson(req);
      const id = body.confirm_id;
      if (typeof id !== "string" || !/^home_[\w-]{1,64}$/.test(id) || typeof body.approve !== "boolean") {
        throw new HttpError(400, "confirm_id and approve are required");
      }
      const approve = body.approve;
      return sendJson(res, 200, await homeCall(() => home!.confirm(id, approve)));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/login") {
      const body = await readJson(req);
      const mode = body.mode === "new" ? "new" : "auto";
      return sendJson(res, 200, await auth.startLogin(mode, normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/cancel") {
      await readJson(req);
      auth.cancelPending();
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/logout") {
      await readJson(req);
      const result = await auth.logout();
      return sendJson(res, 200, { ...result, settings: settings.view() });
    }
    if (method === "POST" && path === "/api/auth/chatgpt/welcome-ack") {
      await readJson(req);
      auth.ackWelcome();
      return sendJson(res, 200, localizeSettings(settings.view(), normalizeLocale(req.headers["x-nous-locale"])));
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
  async function homeCall<T>(run: () => Promise<T>): Promise<T> {
    if (!home?.available) throw new HttpError(409, "尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）");
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

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const clientId = `sse_${randomUUID().replaceAll("-", "")}`;
    const hello: ServerEvent = { type: "hello", sequence: ++sequence, settings: settings.view(), tasks: store.publicList(), client_id: clientId };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);
    clients.set(clientId, res);
    req.on("close", () => {
      clients.delete(clientId);
      // 這條串流擁有的 live 工作階段立刻結束（不假裝重連）。
      sessions?.clientClosed(clientId);
    });
  }

  return Object.assign(server, {
    realtimeSessions: sessions,
    /** 設定或登入狀態改變時呼叫，推送給所有畫面。 */
    notifySettings: () => broadcast({ type: "settings.updated", sequence: ++sequence, settings: settings.view() }),
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
