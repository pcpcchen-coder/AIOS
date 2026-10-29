import { type Locale } from "../shared/i18n.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import { createApp } from "./app.ts";
import { CameraSettingsStore } from "./camera-settings.ts";
import { VoiceSettingsStore } from "./voice-settings.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import { ChatGPTExecutor } from "./chatgpt-executor.ts";
import { ClaudeExecutor } from "./claude-executor.ts";
import { loadConfig } from "./config.ts";
import { MockExecutor } from "./mock-executor.ts";
import { ProviderManager } from "./providers.ts";
import { buildLiveInstructions, RealtimeBridge } from "./realtime.ts";
import { ApiKeyRoute, type RealtimeSessions } from "./realtime-routes.ts";
import type { RouteId } from "../shared/realtime-route.ts";
import { CodexAuth } from "./codex-auth.ts";
import { CodexResponses, type CodexModelCache } from "./codex-responses.ts";
import { LiveRoute, type LiveGreeting } from "./live-route.ts";
import { GreetingPicker } from "./greeting-picker.ts";
import { CALLER_LIMITS, LiveToolCaller } from "./live-tool-caller.ts";
import { RealtimeSettingsStore } from "./realtime-settings.ts";
import { WEB_SEARCH_TIMEOUT_MS, WebSearch } from "./web-search.ts";
import { HomeBridge } from "./home-bridge.ts";
import { TaskRunner } from "./runner.ts";
import { TaskStore } from "./store.ts";
import { checkFaceRuntime, FACE_MODEL_VERSION } from "./face-runtime.ts";
import { GalleryStore, type SecretBox } from "./identity-store.ts";
import { IdentityService, type ConfirmFn, type IdentityContext, type IdentityMemoryLink } from "./identity-service.ts";
import type { IdentityResponse } from "../shared/identity.ts";
import type { MemoryResponse } from "../shared/memory.ts";
import { MemoryService, type MemoryConfirmFn, type MemoryIdentityHooks } from "./memory/service.ts";
import { MemoryStore, type MemorySecretBox } from "./memory/store.ts";
import { claudeAccountKey } from "./providers.ts";

// 啟動本機核心。終端機版（index.ts）與 macOS App 共用：路徑、連接埠與設定都由呼叫端決定。

export interface NousOptions {
  /** .env 檔；不存在時忽略。 */
  envFile: string | null;
  dataDir: string;
  distDir: string;
  /** 覆寫 .env 與環境變數的設定（例如 App 選單裡選的即時語音模型）。 */
  overrides?: Record<string, string | undefined>;
  /** 指定的連接埠被占用時改用其他空閒埠（App 用）；終端機版維持報錯。 */
  fallbackPort?: boolean;
  log?: (line: string) => void;
  /**
   * 家人辨識（ADR-0001；只有 macOS App 注入）。核心持有資料與比對；身分資料只經 Electron IPC（handle），不走 HTTP。
   * 沒有注入（瀏覽器版）時 settings.identity 回報「瀏覽器版不可用」。
   */
  identity?: IdentityInjection;
  /**
   * 家庭記憶層（docs/16 MEM-1；只有 macOS App 注入）。store 第一次收到記憶 IPC 才開（啟動時不碰 Keychain）。
   * 沒有注入（瀏覽器版）時 settings.memory 回報不可用，一般聊天照舊。
   */
  memory?: MemoryInjection;
}

export interface MemoryInjection {
  /** 加密快照的資料夾（App：userData/memory；0700）。 */
  dir: string;
  /** 包裝資料金鑰（App：desktop/memory-safe-storage.mjs，只在 darwin 且 safeStorage 可用時 available）。 */
  secretBox: MemorySecretBox;
  /** 刪除人物記憶、全部忘記、連結家人辨識前的原生確認。 */
  confirm: MemoryConfirmFn;
  /** Time Machine 排除（App：tmutil addexclusion）。 */
  excludeFromBackup?: (dir: string) => Promise<void>;
  /** 本次人物世代改變時通知主視窗（App：webContents.send，不含內容）。 */
  onPresence?: () => void;
}

export interface IdentityInjection {
  /** gallery 的資料夾（App：userData/identity）。 */
  dir: string;
  /** 包裝資料金鑰（App：safeStorage；只在 darwin 且可加密時 available）。 */
  secretBox: SecretBox;
  /** Time Machine 排除（App：tmutil addexclusion）。 */
  excludeFromBackup?: (dir: string) => Promise<void>;
  /** 登記、刪除與清除前的原生確認（App：dialog.showMessageBox）。 */
  confirm: ConfirmFn;
  /** 模型與 onnxruntime wasm 的資料夾（App：userData/face-runtime；npm run face:setup -- --product 安裝）。 */
  modelDir?: string | null;
}

export interface NousHandle {
  port: number;
  url: string;
  close(): Promise<void>;
  /** 只有注入 identity 時存在；主程序的 IPC 處理器把頁面的請求轉到這裡。 */
  identity?: {
    handle(request: unknown, ctx: IdentityContext): Promise<IdentityResponse>;
    /** 主視窗導覽、重新載入或 renderer 結束時，主程序呼叫它結束管理 session。 */
    closeSessions(): void;
  };
  /** 只有注入 memory 時存在；主程序的 IPC 處理器（desktop/memory-ipc.mjs 過濾後）把請求轉到這裡。 */
  memory?: {
    handle(request: unknown, ctx: { userInitiated?: boolean }): Promise<MemoryResponse>;
    /** 主視窗導覽、重新載入或 renderer 結束：本次人物回到未選定。 */
    closeSessions(): void;
    /** OS 鎖定（powerMonitor lock-screen）：暫停本次人物。 */
    suspendAll(): void;
  };
}

const LABEL = { claude: "Claude", chatgpt: "ChatGPT（Sign in with ChatGPT）", mock: "模擬（mock）" } as const;

export async function startNous(options: NousOptions): Promise<NousHandle> {
  const log = options.log ?? console.log;
  const fileEnv = options.envFile && existsSync(options.envFile) ? parseEnv(readFileSync(options.envFile, "utf8")) : {};
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv };
  for (const [key, value] of Object.entries(options.overrides ?? {})) if (value !== undefined) env[key] = value;
  const config = loadConfig(env);
  const port = options.fallbackPort ? await freePort(config.port) : config.port;

  let notify = () => {};
  const auth = new ChatGPTAuth({ dir: config.configDir, callbackPort: config.oauthPort, onChange: () => notify() });
  const providers = new ProviderManager({
    claude: config.apiKey
      ? new ClaudeExecutor({
          apiKey: config.apiKey,
          model: config.model,
          modelFamily: config.modelFamily,
          fallbacks: config.fallbacks,
          webSearchTool: config.taskWebSearch ? config.claudeWebSearchTool : null,
        })
      : null,
    chatgpt: new ChatGPTExecutor(auth, { model: config.chatgptModel, webSearch: config.taskWebSearch }),
    mock: new MockExecutor(),
    auth,
    dir: config.configDir,
    preferred: config.preferred,
    onChange: () => notify(),
    claudeAccount: config.apiKey ? claudeAccountKey(config.apiKey) : null,
  });
  // 即時語音的 ChatGPT 方案路徑：Nous 自己的 Codex 登入（不讀 ~/.codex），語音、交辦的推論與上網查詢都算 Codex 額度。
  const codexAuth = new CodexAuth({ dir: config.configDir, onChange: () => notify(), log });
  // 交辦與上網查詢共用一份模型快取（/models 只查一次）；每一輪的時限都涵蓋查詢本身。
  const modelCache: CodexModelCache = { model: null };
  const codex = new CodexResponses(codexAuth, { model: config.liveAgentModel, clientVersion: config.codexClientVersion, userAgentVersion: config.nousVersion, turnTimeoutMs: CALLER_LIMITS.turnTimeoutMs, modelCache });
  const codexSearch = new CodexResponses(codexAuth, { model: config.liveAgentModel, clientVersion: config.codexClientVersion, userAgentVersion: config.nousVersion, turnTimeoutMs: WEB_SEARCH_TIMEOUT_MS, modelCache });
  const realtimePrefs = new RealtimeSettingsStore({
    dir: config.configDir,
    defaults: { route: config.realtimeRoute, live_voice: config.liveVoice },
    onChange: () => notify(),
    log,
  });
  const webSearch = new WebSearch({
    apiKey: config.openaiApiKey,
    model: config.searchModel,
    country: config.searchCountry,
    timezone: config.searchTimezone,
    codex: codexSearch,
  });
  const home = new HomeBridge({ url: config.smarthomeUrl, token: config.smarthomeToken });
  const realtime = new RealtimeBridge({
    apiKey: config.openaiApiKey,
    model: config.realtimeModel,
    voice: config.realtimeVoice,
    webSearch: webSearch.available,
    mcp: config.realtimeMcp,
    taskWebSearch: config.taskWebSearch,
    home: home.available,
  });
  const liveCaps = () => ({ webSearch: true, mcp: [], taskWebSearch: config.taskWebSearch, home: home.available });
  // 開場句挑選（固定清單、依本機時段、避開上一次）：家人辨識的決策與 live 保底共用一個。
  const greetings = new GreetingPicker();
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => realtimePrefs.view().live_voice,
    model: config.liveModel,
    clientVersion: config.nousVersion,
    capabilities: () => ({ webSearch: true, home: home.available }),
    instructions: (ctx) => buildLiveInstructions(ctx.tasks(), new Date(), { mcp: config.realtimeMcp }, ctx.locale),
    caller: (ctx) =>
      new LiveToolCaller({ locale: ctx.locale, responses: codex, caps: liveCaps, host: ctx.host, tasks: ctx.tasks, approval: ctx.approval, now: ctx.now, log }),
    // 看著說話的問候（ID-02）：頁面只帶互動 ID，短句由家人辨識的核心決策組成；瀏覽器版（沒有 identity）一律「我在」。
    greeting: liveGreetingSource(() => identity, greetings),
    log,
  });
  const apiKeyRoute = new ApiKeyRoute(realtime, !!config.openaiApiKey, config.realtimeVoice);
  const camera = new CameraSettingsStore({ base: config.camera, dir: config.configDir, onChange: () => notify(), log });
  const voice = new VoiceSettingsStore({ dir: config.configDir, onChange: () => notify(), log });
  const store = new TaskStore(options.dataDir);
  const runner = new TaskRunner(store, providers, config.maxConcurrent);
  // 雜湊核對沒過（缺檔或不符）就不提供 /face-runtime/，頁面也就載不到未核對的模型。
  const runtime = checkFaceRuntime(options.identity?.modelDir ?? null);
  const faceRuntimeDir = runtime.state === "ok" ? (options.identity?.modelDir ?? null) : null;
  if (options.identity && runtime.state !== "ok") log(`家人辨識模型：${runtime.state}（${runtime.problems.join("、") || "未設定資料夾"}）`);
  const identity = options.identity
    ? new IdentityService({
        store: new GalleryStore({ dir: options.identity.dir, secretBox: options.identity.secretBox, excludeFromBackup: options.identity.excludeFromBackup, log }),
        confirm: options.identity.confirm,
        camera: () => {
          const cam = camera.view();
          return cam.enabled && cam.active;
        },
        ambient: () => {
          const cam = camera.view();
          return { look_to_talk: cam.look_to_talk, look_to_talk_greet: cam.look_to_talk_greet, look_to_talk_greet_name: cam.look_to_talk_greet_name };
        },
        runtime,
        model: FACE_MODEL_VERSION,
        // 問候決策只接受 /api/realtime/start 發出、真的連上的互動 ID（server 在下面建立，呼叫時已存在）。
        claimGreeting: greetingClaims(() => server.realtimeSessions),
        picker: greetings,
        log,
        onChange: () => notify(),
        memory: (): IdentityMemoryLink | null => memory,
      })
    : null;
  const memoryOpts = options.memory;
  const memory: MemoryService | null = memoryOpts
    ? new MemoryService({
        openStore: () => MemoryStore.open({ dir: memoryOpts.dir, secretBox: memoryOpts.secretBox }),
        available: () => memoryOpts.secretBox.available(),
        targets: () => ({ current: providers.chatTarget(), all: providers.chatTargets() }),
        confirm: memoryOpts.confirm,
        identity: (): MemoryIdentityHooks | null => identity ? { candidate: () => identity.memoryCandidate(), people: () => identity.memoryPeople() } : null,
        afterOpen: memoryOpts.excludeFromBackup ? () => memoryOpts.excludeFromBackup!(memoryOpts.dir) : undefined,
        // 上次執行時記憶是否開著：加密檔外只留這一個布林值（不含內容），讓重啟後第一次打字就能取用記憶，
        // 而記憶沒開時查狀態、一般聊天都不碰 Keychain。
        enabledHint: memoryEnabledHint(join(config.configDir, "memory-enabled.json")),
        onPresence: memoryOpts.onPresence,
        log,
        onChange: () => notify(),
      })
    : null;
  const server = createApp({
    store,
    runner,
    settings: providers,
    auth,
    chat: providers,
    realtime,
    realtimeRoutes: { live, api_key: apiKeyRoute },
    realtimePrefs,
    codexAuth,
    webSearch,
    home,
    camera,
    voice,
    identity: identity ?? undefined,
    memory: memory ?? undefined,
    faceRuntimeDir,
    port,
    devPort: config.devPort,
    distDir: options.distDir,
  });
  notify = server.notifySettings;

  // 只綁本機位址，不對區域網路開放。
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const view = providers.view();
  log(`Nous 原型已啟動：http://localhost:${port}`);
  log(`目前引擎：${LABEL[view.provider]}（可在畫面上說「設定」切換）`);
  for (const p of view.providers) log(`  - ${p.label}：${p.available ? "可用" : "不可用"}，${p.detail}`);
  // 只印路徑與計費，不印權杖或帳號 ID。
  const rt = server.realtimeSessions?.info();
  const pref = realtimePrefs.view().route;
  log(`即時語音：${rt?.route ? `${rt.billing_line}（路徑偏好：${pref}）` : `不可用，${rt?.detail ?? "未設定"}（路徑偏好：${pref}）`}`);
  for (const option of rt?.routes ?? []) log(`  - ${option.id === "live" ? "ChatGPT 方案（Codex）" : "OpenAI API key"}：${option.available ? "可用" : "不可用"}，${option.detail}`);
  log(`武陵居中控：${home.available ? "已設定" : "未設定"}，${home.detail}`);
  const cam = camera.view();
  log(`雙目鏡頭：${cam.enabled ? `啟用（${cam.label}，影像只在本機處理${cam.active ? "" : "；使用者已在設定關閉"}）` : "未啟用（NOUS_CAMERA=on 開啟）"}`);
  log(`憑證與設定目錄：${config.configDir}`);
  const idStatus = identity?.status();
  // gallery 要到第一次開 session 才載入：這裡只記模型與鏡頭的狀態，不碰 Keychain。
  log(`家庭記憶：${memory ? (memory.settingsStatus().available ? "可用（第一次使用時才開啟加密檔）" : "此 Mac 無法加密保存，停用") : "瀏覽器版不可用"}`);
  log(`家人辨識：${idStatus ? (idStatus.disabled_reason ?? `可用（模型 ${runtime.state}${idStatus.limited_reason ? `；${idStatus.limited_reason}` : ""}；門檻未校準；家人資料在第一次打開時才載入）`) : "瀏覽器版不可用"}`);

  return {
    port,
    url: `http://localhost:${port}`,
    ...(identity ? { identity: { handle: (request: unknown, ctx: IdentityContext) => identity.handle(request, ctx), closeSessions: () => identity.closeSessions() } } : {}),
    ...(memory ? { memory: { handle: (request: unknown, ctx: { userInitiated?: boolean }) => memory.handle(request, ctx), closeSessions: () => memory.closeSessions(), suspendAll: () => memory.suspendAll() } } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        // 先讓家人辨識進入關閉狀態：結束 session，等待中的原生確認回來後也不寫檔。
        identity?.shutdown();
        void memory?.shutdown();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * live 路徑的問候文字來源（ID-02）：頁面 POST greeting 的文字只當互動 ID，連同這個 live 工作階段的 ID 交給
 * IdentityService.takeLiveGreeting；沒有家人辨識（瀏覽器版）或取不到時，由核心從固定清單挑一句不含名字的（例如「我在」「早安」）。
 */
export function liveGreetingSource(identity: () => IdentityService | null, picker: GreetingPicker): (interaction: string, sessionId: string, locale?: Locale) => LiveGreeting {
  return (interaction, sessionId, locale) => identity()?.takeLiveGreeting(interaction, sessionId) ?? picker.plainLive(locale);
}

/** IdentityService 的 claimGreeting：把核心發出的互動 ID 換成真的連上的工作階段（RealtimeSessions.claimGreeting）。 */
export function greetingClaims(sessions: () => RealtimeSessions | null): (interaction: string) => { route: RouteId; session_id: string; locale?: Locale } | null {
  return (interaction) => sessions()?.claimGreeting(interaction) ?? null;
}

/** 記憶開關提示（memory-enabled.json，只有 { enabled: boolean }）。讀寫失敗都當成「沒開」。 */
export function memoryEnabledHint(file: string): { get(): boolean; set(enabled: boolean): void } {
  return {
    get: () => {
      try { return (JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown }).enabled === true; } catch { return false; }
    },
    set: (enabled) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}

/** 先試指定的埠；被占用時讓系統分配一個空閒埠。 */
async function freePort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | null>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, "127.0.0.1", () => {
        const actual = (probe.address() as { port: number }).port;
        probe.close(() => resolve(actual));
      });
    });
  return (await tryListen(preferred)) ?? (await tryListen(0))!;
}
