import { existsSync, readFileSync } from "node:fs";
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
import { ApiKeyRoute } from "./realtime-routes.ts";
import { CodexAuth } from "./codex-auth.ts";
import { CodexResponses, type CodexModelCache } from "./codex-responses.ts";
import { LiveRoute } from "./live-route.ts";
import { CALLER_LIMITS, LiveToolCaller } from "./live-tool-caller.ts";
import { RealtimeSettingsStore } from "./realtime-settings.ts";
import { WEB_SEARCH_TIMEOUT_MS, WebSearch } from "./web-search.ts";
import { HomeBridge } from "./home-bridge.ts";
import { TaskRunner } from "./runner.ts";
import { TaskStore } from "./store.ts";

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
}

export interface NousHandle {
  port: number;
  url: string;
  close(): Promise<void>;
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
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => realtimePrefs.view().live_voice,
    model: config.liveModel,
    clientVersion: config.nousVersion,
    capabilities: () => ({ webSearch: true, home: home.available }),
    instructions: (ctx) => buildLiveInstructions(ctx.tasks(), new Date(), { mcp: config.realtimeMcp }),
    caller: (ctx) =>
      new LiveToolCaller({ responses: codex, caps: liveCaps, host: ctx.host, tasks: ctx.tasks, approval: ctx.approval, now: ctx.now, log }),
    log,
  });
  const apiKeyRoute = new ApiKeyRoute(realtime, !!config.openaiApiKey, config.realtimeVoice);
  const camera = new CameraSettingsStore({ base: config.camera, dir: config.configDir, onChange: () => notify(), log });
  const voice = new VoiceSettingsStore({ dir: config.configDir, onChange: () => notify(), log });
  const store = new TaskStore(options.dataDir);
  const runner = new TaskRunner(store, providers, config.maxConcurrent);
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

  return {
    port,
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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
