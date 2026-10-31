import { type Locale } from "../shared/i18n.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import { createApp } from "./app.ts";
import { CameraSettingsStore } from "./camera-settings.ts";
import { FaceTuningStore } from "./face-tuning-settings.ts";
import { VoiceSettingsStore } from "./voice-settings.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import { ChatGPTExecutor } from "./chatgpt-executor.ts";
import { ClaudeExecutor } from "./claude-executor.ts";
import { loadConfig } from "./config.ts";
import { MockExecutor } from "./mock-executor.ts";
import { ProviderManager } from "./providers.ts";
import { buildLiveInstructions, RealtimeBridge } from "./realtime.ts";
import { ApiKeyRoute, type RealtimeSessions, type SessionContext } from "./realtime-routes.ts";
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
import { memoryTaskViews, TaskStore, type PlaintextDropReason } from "./store.ts";
import { checkFaceRuntime, FACE_MODEL_VERSION } from "./face-runtime.ts";
import { checkWakeRuntime } from "./wake-runtime.ts";
import { WakeSettingsStore } from "./wake-settings.ts";
import { GalleryStore, type SecretBox } from "./identity-store.ts";
import { IdentityService, type ConfirmFn, type IdentityContext, type IdentityMemoryLink } from "./identity-service.ts";
import type { IdentityResponse } from "../shared/identity.ts";
import type { MemoryResponse } from "../shared/memory.ts";
import { MemoryService, type MemoryConfirmFn, type MemoryIdentityHooks } from "./memory/service.ts";
import { MemoryStore, type MemorySecretBox } from "./memory/store.ts";
import { claudeAccountKey, codexTarget, openaiRealtimeTarget } from "./providers.ts";
import { MemoryBoundary } from "./memory/boundary.ts";
import { SealedVault, VaultError, type VaultFailure } from "./sealed-vault.ts";
import type { MemoryLockProvider } from "./memory/store.ts";
import { createTaskIpc } from "./task-ipc.ts";
import type { TasksResponse } from "../shared/protected-tasks.ts";

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
  /** MEM-2：即時語音停播未確認時強制靜音（App：主視窗 webContents.setAudioMuted）；沒有注入時只記 log。 */
  audio?: { setMuted(muted: boolean): void };
  /**
   * MEM-4a：任務加密保存（只有 macOS App 注入；George 2026-10-30 決定全部任務都加密）。沒有注入（瀏覽器版）時照舊明文，
   * 也不搬遷。
   */
  tasks?: TasksInjection;
  /**
   * WK-01a：喚醒引擎檔案的資料夾（App：userData/wake-runtime）。只有 NOUS_WAKE=on 時使用；WK-01a 的清單是空的，
   * 所以一律回報 runtime missing，頁面不開麥克風。
   */
  wakeRuntimeDir?: string | null;
  /**
   * 誰能打開鏡頭：macOS App 傳 "main_process"（HTTP 的 active: true 回 403，只有主程序經 NousHandle.camera 在原生說明之後打開）；
   * 未提供或 "http"（終端機／瀏覽器版）時頁面照舊可以經 HTTP 打開，由瀏覽器的鏡頭權限提示與畫面指示點把關。
   */
  cameraEnable?: "main_process" | "http";
}

export interface TasksInjection {
  /** 包裝每檔資料金鑰（App：和記憶相同的 safeStorage secretBox）。 */
  secretBox: MemorySecretBox;
  /** 加密檔資料夾；預設 dataDir/sealed（0700）。 */
  dir?: string;
  /** 刪除明文備份前的原生確認（App：dialog.showMessageBox）。回 true 才刪。 */
  confirmDeleteBackups: (count: number) => Promise<boolean>;
  /** 只限測試（同 MemoryStoreOptions.lockProvider）。 */
  lockProvider?: MemoryLockProvider;
  /** 加密檔與明文備份資料夾排除在 Time Machine 之外（App：tmutil addexclusion）。 */
  excludeFromBackup?: (dir: string) => Promise<void>;
  /**
   * MEM-4c 審查 M1：核心丟棄解密內容後（鎖定、睡眠、閒置、關閉記憶、記憶層關閉、結束）通知主程序，主程序再送一個
   * 不含內容的事件給主視窗，讓頁面清掉自己的快取與成果紀錄畫面。
   */
  onPlaintextDropped?: (reason: PlaintextDropReason) => void;
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
  /** MEM-4a：只有注入 tasks 時存在；主程序的 IPC 處理器（desktop/tasks-ipc.mjs 過濾後）把請求轉到這裡。 */
  tasks?: { handle(request: unknown, ctx?: { userInitiated?: boolean }): Promise<TasksResponse>; closeSessions(): void; /** MEM-4c：OS 鎖定或睡眠時丟棄已結束受保護任務的解密內容。 */ dropPlaintext(reason: PlaintextDropReason): void };
  /** 只有注入 memory 時存在；主程序的 IPC 處理器（desktop/memory-ipc.mjs 過濾後）把請求轉到這裡。 */
  memory?: {
    handle(request: unknown, ctx: { userInitiated?: boolean }): Promise<MemoryResponse>;
    /** 主視窗導覽、重新載入或 renderer 結束：本次人物回到未選定。 */
    closeSessions(): void;
    /** OS 鎖定（powerMonitor lock-screen）：暫停本次人物。 */
    suspendAll(): void;
  };
  /**
   * WK-01a：只有 NOUS_WAKE=on 時存在。「常駐喚醒聆聽」的開關只由 App 主程序在原生說明之後呼叫（同一個行程，不經 HTTP、
   * 不經 preload），頁面拿不到；頁面經 HTTP 只能記下麥克風或關掉（ADR-0003 §2.3）。寫檔失敗時丟錯、設定不變。
   */
  wake?: { setListen(value: boolean): void };
  /**
   * 鏡頭「開關」：App（cameraEnable: "main_process"）由主程序在原生說明之後呼叫（同一個行程，不經 HTTP）；這時頁面經 HTTP
   * 只能關掉或改其他鏡頭設定（POST /api/settings/camera 收到 active: true 一律 403）。先寫 camera.json 再通知 settings；
   * 寫檔失敗時丟錯、設定不變。
   */
  camera?: {
    setActive(value: boolean): void;
    /**
     * 鏡頭現在是否允許運作：.env 啟用（NOUS_CAMERA=on）而且使用者設定為開。每次直接讀 store（不是主程序輪詢來的 settings，
     * 那可能過時）。App 主程序的權限處理器只在這裡是 true 時才把鏡頭（video）權限給頁面。
     */
    isActive(): boolean;
  };
}

const LABEL = { claude: "Claude", chatgpt: "ChatGPT（Sign in with ChatGPT）", mock: "模擬（mock）" } as const;

export async function startNous(options: NousOptions): Promise<NousHandle> {
  const log = options.log ?? console.log;
  const fileEnv = options.envFile && existsSync(options.envFile) ? parseEnv(readFileSync(options.envFile, "utf8")) : {};
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv };
  for (const [key, value] of Object.entries(options.overrides ?? {})) if (value !== undefined) env[key] = value;
  const config = loadConfig(env);
  // 只限測試的旗標（NOUS_TEST_DROP_STOP_REPORT、NOUS_TEST_RENDERER_IGNORE_REVOKE）只在明確的測試模式（NOUS_TEST_MODE=1）下生效；
  // 一般啟動時就算設了也忽略，避免正式使用時誤開而關掉停播保護。
  const testMode = env.NOUS_TEST_MODE === "1";
  const dropStopReport = testMode && env.NOUS_TEST_DROP_STOP_REPORT === "1";
  const hideRevokeFromPage = testMode && env.NOUS_TEST_RENDERER_IGNORE_REVOKE === "1";
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
  // MEM-2：ChatGPT 方案即時語音的記憶同意鍵（provider codex，獨立於 chatgpt）；沒有 Codex 登入時為 null。
  const liveTarget = () => codexTarget(codexAuth.accountSubject());
  // 開場句挑選（固定清單、依本機時段、避開上一次）：家人辨識的決策與 live 保底共用一個。
  const greetings = new GreetingPicker();
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => realtimePrefs.view().live_voice,
    model: config.liveModel,
    clientVersion: config.nousVersion,
    capabilities: () => ({ webSearch: true, home: home.available }),
    // memoryOn：這通記憶開著而且有 codex 同意（LiveMemoryBinding.memoryActive）才加記憶規則；否則和 MEM-2 之前一樣。
    instructions: (ctx, memoryOn) => buildLiveInstructions(ctx.tasks(), new Date(), { mcp: config.realtimeMcp, memory: !!memoryOn }, ctx.locale),
    // MEM-4b：voice（受保護的語音交辦）只改 delegate_task 的處理，不影響說明與工具表。
    caller: (ctx, mem, voice) =>
      new LiveToolCaller({ locale: ctx.locale, responses: codex, caps: () => ({ ...liveCaps(), memory: !!mem }), host: ctx.host, tasks: ctx.tasks, approval: ctx.approval, now: ctx.now, log, ...(mem ? { memory: mem } : {}), ...(voice ? { voice } : {}) }),
    // MEM-2：每通通話一個記憶 binding（server/memory/live.ts）；瀏覽器版沒有記憶層。
    // MEM-3：頁面的確認卡（MCP、家電）開著時不開語音記憶卡（兩條路徑一致）。
    ...(options.memory ? { memory: (ctx: SessionContext) => memory?.openLive({ lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale, approvalOpen: () => ctx.approval().open }) ?? null } : {}),
    // 看著說話的問候（ID-02）：頁面只帶互動 ID，短句由家人辨識的核心決策組成；瀏覽器版（沒有 identity）一律「我在」。
    greeting: liveGreetingSource(() => identity, greetings),
    palmQuietDelegation: config.palmQuietDelegation,
    log,
  });
  // MEM-3：API key 即時語音的記憶（核心旁路，server/apikey-call.ts）。放行旗標（NOUS_MEMORY_ROUTES）沒開時 binding 一律 route_off，
  // 不開旁路，請求和 MEM-2 之前一樣；瀏覽器版沒有記憶層。
  const apiKeyMemoryReleased = config.memoryRoutes.api_key;
  const apiKeyTarget = () => (apiKeyMemoryReleased ? openaiRealtimeTarget(config.openaiApiKey) : null);
  const apiKeyRoute = new ApiKeyRoute(realtime, !!config.openaiApiKey, config.realtimeVoice, {
    ...(options.memory ? { memory: (ctx: SessionContext) => memory?.openVoice("api_key", { lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale, approvalOpen: () => ctx.approval().open }) ?? null } : {}),
    log,
  });
  const camera = new CameraSettingsStore({ base: config.camera, dir: config.configDir, onChange: () => notify(), log });
  const voice = new VoiceSettingsStore({ dir: config.configDir, onChange: () => notify(), log });
  const faceTuning = new FaceTuningStore({ dir: config.configDir, onChange: () => notify(), log });
  // WK-01a：NOUS_WAKE=on 才建立喚醒偏好（wake.json）與核對引擎；關閉時完全不碰這兩樣，settings 與之前相同。
  const wakeRuntime = config.wake ? checkWakeRuntime(options.wakeRuntimeDir ?? null) : null;
  if (wakeRuntime && wakeRuntime.state !== "ok") log(`喚醒引擎：${wakeRuntime.state}（${wakeRuntime.problems.join("、") || "清單沒有檔案或未設定資料夾"}）`);
  const wakeStore = config.wake ? new WakeSettingsStore({ dir: config.configDir, onChange: () => notify(), log }) : null;
  const wake = wakeStore && wakeRuntime
    ? { view: () => wakeStore.view(), update: (patch: Parameters<WakeSettingsStore["update"]>[0]) => wakeStore.update(patch), runtime: () => wakeRuntime.state }
    : undefined;
  // MEM-4a：macOS App 加密保存全部任務（金鑰不可用或鎖被占用時 vault 為 null，TaskStore 照實處理並記 log）。
  let vault: SealedVault | null = null;
  let vaultFailure: VaultFailure | null = null;
  if (options.tasks) {
    try {
      vault = SealedVault.open({ dir: options.tasks.dir ?? join(options.dataDir, "sealed"), secretBox: options.tasks.secretBox, lockProvider: options.tasks.lockProvider });
    } catch (error) {
      vaultFailure = error instanceof VaultError ? error.code : "unavailable";
    }
  }
  const hintFile = join(config.configDir, "memory-enabled.json");
  const store = new TaskStore(options.dataDir, options.tasks ? {
    vault, failure: vaultFailure, log,
    // 審查 M4a：上次執行時記憶已關閉，就在載入時撤回帶記憶的成果（不必等記憶檔開啟）。
    ...(options.memory ? { memoryEnabled: () => memoryEnabledHint(hintFile).get() } : {}),
  } : undefined);
  const runner = new TaskRunner(store, providers, config.maxConcurrent);
  // MEM-4c：已結束受保護任務的解密內容閒置 10 分鐘（PLAINTEXT_IDLE_MS）就丟棄；每分鐘檢查一次。
  const plaintextTimer = options.tasks ? setInterval(() => store.dropIfIdle(), 60_000) : null;
  plaintextTimer?.unref?.();
  // MEM-4c 審查 M1：每次丟棄都通知主視窗（只有原因）。
  if (options.tasks?.onPlaintextDropped) {
    const notifyDropped = options.tasks.onPlaintextDropped;
    store.subscribeDropped((reason) => notifyDropped(reason));
  }
  // 審查 minor 4：執行前核對受保護交辦的同意對象仍是目前設定的帳號。
  runner.setTargetCheck((target) => providers.chatTargets().some((t) => t.provider === target.provider && t.account === target.account));
  // 審查 minor 6：加密檔與明文備份排除在 Time Machine 之外（失敗只記 log）。
  if (options.tasks?.excludeFromBackup) {
    const exclude = options.tasks.excludeFromBackup;
    for (const dir of [vault?.dir, ...store.vaultStatus().backups.map((name) => join(options.dataDir, name))]) {
      if (dir) void exclude(dir).catch(() => log("任務保存：Time Machine 排除失敗"));
    }
  }
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
        // MEM-3：API key 路徑的問候決策（有沒有稱名）交給那通的旁路，問候結束後才問臉部候選。
        apiKeyGreeted: (sessionId, named) => server.realtimeSessions?.greeted(sessionId, named),
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
        // 記憶管理只在 API key 路徑已放行時才列出它的同意對象（openai_realtime）。
        targets: () => {
          const live = liveTarget();
          const apiKey = apiKeyTarget();
          return { current: providers.chatTarget(), all: [...providers.chatTargets(), ...(live ? [live] : []), ...(apiKey ? [apiKey] : [])], live, byRoute: { live, api_key: apiKey } };
        },
        boundary: new MemoryBoundary({ release: { api_key: apiKeyMemoryReleased, task: config.memoryRoutes.task } }),
        // MEM-5a：記憶建議與全家共用的「由誰記下」（NOUS_MEMORY_ROUTES 列出 suggest；預設關閉）。
        suggest: config.memoryRoutes.suggest,
        // MEM-5b：工作決定連到任務（NOUS_MEMORY_ROUTES 列出 work_summary；預設關閉）。
        workSummary: config.memoryRoutes.work_summary,
        // MEM-4a：受保護交辦的任務端（同意對象沿用目前任務引擎的 claude／chatgpt 同意；模擬引擎不帶記憶）與撤銷傳播。
        // MEM-5b：scopedList（工作決定卡與記憶清單的連結標題；撤回中與讀不到的給外殼）、taskState（不解密，只看在不在）。
        tasks: {
          sealed: () => store.sealed && store.vaultStatus().failure === null, mode: () => runner.mode, target: () => providers.chatTarget(), submit: (input) => runner.submitProtected(input), publicGet: (taskId) => store.publicGet(taskId),
          ...memoryTaskViews(store),
        },
        onResultsWithdrawn: (taskIds) => runner.revokeMemory(taskIds),
        // MEM-4c：撤回提交期間先隱藏、關閉記憶或記憶層關閉時丟棄解密內容。
        holdResults: (taskIds) => store.hold(taskIds),
        onPlaintextDrop: (reason) => store.dropPlaintext(reason),
        confirm: memoryOpts.confirm,
        identity: (): MemoryIdentityHooks | null => identity ? { candidate: () => identity.memoryCandidate(), people: () => identity.memoryPeople(), nameAllowed: () => camera.view().look_to_talk_greet_name } : null,
        afterOpen: memoryOpts.excludeFromBackup ? () => memoryOpts.excludeFromBackup!(memoryOpts.dir) : undefined,
        // 上次執行時記憶是否開著：加密檔外只留這一個布林值（不含內容），讓重啟後第一次打字就能取用記憶，
        // 而記憶沒開時查狀態、一般聊天都不碰 Keychain。
        enabledHint: memoryEnabledHint(hintFile),
        onPresence: memoryOpts.onPresence,
        log,
        onChange: () => notify(),
      })
    : null;
  const server = createApp({
    cameraEnable: options.cameraEnable ?? "http",
    store,
    runner,
    settings: providers,
    auth,
    chat: providers,
    realtime,
    realtimeRoutes: { live, api_key: apiKeyRoute },
    realtimePrefs,
    codexAuth,
    realtimeAudio: options.audio,
    // 只限測試 build：丟掉停播回報，驗證強制靜音（docs/validation/memory-mem2-2026-10-30.md 第 8 步）。
    dropStopReport,
    // 只限測試 build：頁面收不到記憶撤銷（只靠核心 hangup；docs/validation/memory-mem3-2026-10-30.md 第 12 步）。
    hideRevokeFromPage,
    webSearch,
    home,
    camera,
    faceTuning,
    voice,
    ...(config.earlySpeechRms !== null ? { earlySpeechRms: config.earlySpeechRms } : {}),
    identity: identity ?? undefined,
    memory: memory ?? undefined,
    faceRuntimeDir,
    ...(wake ? { wake, wakeRuntimeDir: wakeRuntime?.state === "ok" ? (options.wakeRuntimeDir ?? null) : null } : {}),
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
  if (memory) log(`家庭記憶的路徑：ChatGPT 方案即時語音已放行；OpenAI API key 即時語音${apiKeyMemoryReleased ? "已放行（NOUS_MEMORY_ROUTES，Mac gate 尚未通過）" : "未放行（預設關閉）"}；背景任務${config.memoryRoutes.task ? "已放行（NOUS_MEMORY_ROUTES，Mac gate 尚未通過）" : "未放行（預設關閉）"}；記憶建議${config.memoryRoutes.suggest ? "已放行（NOUS_MEMORY_ROUTES，另需在「記憶…」開啟；Mac gate 尚未通過）" : "未放行（預設關閉）"}；工作決定${config.memoryRoutes.work_summary ? "已放行（NOUS_MEMORY_ROUTES，Mac gate 尚未通過）" : "未放行（預設關閉）"}`);
  const vaultState = store.vaultStatus();
  log(`任務保存：${options.tasks ? (vaultState.mode === "sealed" ? (vaultState.failure ? `加密（金鑰不可用：${vaultState.failure}；新任務內容只留在記憶體）` : "加密") : `明文（這次無法加密：${vaultState.failure ?? (vaultState.migration && !vaultState.migration.ok ? `搬遷失敗於 ${vaultState.migration.step}` : "原因不明")}）`) : "明文（瀏覽器版不加密）"}；明文備份 ${vaultState.backups.length} 個`);
  if (!testMode && (env.NOUS_TEST_DROP_STOP_REPORT === "1" || env.NOUS_TEST_RENDERER_IGNORE_REVOKE === "1")) log("警告：只限測試的旗標沒有生效（需要 NOUS_TEST_MODE=1）");
  if (hideRevokeFromPage) log("警告：NOUS_TEST_RENDERER_IGNORE_REVOKE=1（只限測試）：記憶撤銷不會送給頁面，只靠核心 hangup 停止，1.5 秒後強制靜音");
  if (dropStopReport) log("警告：NOUS_TEST_DROP_STOP_REPORT=1（只限測試）：即時語音的停播回報會被丟掉，用來驗證強制靜音");
  log(`家人辨識：${idStatus ? (idStatus.disabled_reason ?? `可用（模型 ${runtime.state}${idStatus.limited_reason ? `；${idStatus.limited_reason}` : ""}；門檻未校準；家人資料在第一次打開時才載入）`) : "瀏覽器版不可用"}`);

  return {
    port,
    url: `http://localhost:${port}`,
    ...(identity ? { identity: { handle: (request: unknown, ctx: IdentityContext) => identity.handle(request, ctx), closeSessions: () => identity.closeSessions() } } : {}),
    ...(memory ? { memory: { handle: (request: unknown, ctx: { userInitiated?: boolean }) => memory.handle(request, ctx), closeSessions: () => memory.closeSessions(), suspendAll: () => memory.suspendAll() } } : {}),
    ...(wakeStore ? { wake: { setListen: (value: boolean) => void wakeStore.update({ wake_listen: value }) } } : {}),
    camera: {
      setActive: (value: boolean) => void camera.update({ active: value }),
      isActive: () => {
        const view = camera.view();
        return view.enabled && view.active;
      },
    },
    ...(options.tasks ? { tasks: (() => {
      const ipc = createTaskIpc({ store, runner, memory, confirmDeleteBackups: options.tasks.confirmDeleteBackups, log });
      // MEM-4c：dropPlaintext＝OS 鎖定與睡眠（desktop/main.mjs 的 powerMonitor）時丟棄解密內容。
      return { handle: (request: unknown, ctx?: { userInitiated?: boolean }) => ipc(request, ctx), closeSessions: () => ipc.closeSessions(), dropPlaintext: (reason: PlaintextDropReason) => { store.dropPlaintext(reason); } };
    })() } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        // 先讓家人辨識進入關閉狀態：結束 session，等待中的原生確認回來後也不寫檔。
        identity?.shutdown();
        void memory?.shutdown();
        // MEM-4c：結束 App 時丟棄解密內容與索引（只是放掉參照，不是安全抹除）。
        if (plaintextTimer) clearInterval(plaintextTimer);
        store.dropPlaintext("quit");
        vault?.close();
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
