import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import { ChatGPTExecutor } from "./chatgpt-executor.ts";
import { ClaudeExecutor } from "./claude-executor.ts";
import { loadConfig } from "./config.ts";
import { MockExecutor } from "./mock-executor.ts";
import { ProviderManager } from "./providers.ts";
import { TaskRunner } from "./runner.ts";
import { TaskStore } from "./store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env);
let notify = () => {};

const auth = new ChatGPTAuth({ dir: config.configDir, callbackPort: config.oauthPort, onChange: () => notify() });
const providers = new ProviderManager({
  claude: config.apiKey
    ? new ClaudeExecutor({
        apiKey: config.apiKey,
        model: config.model,
        modelFamily: config.modelFamily,
        fallbacks: config.fallbacks,
      })
    : null,
  chatgpt: new ChatGPTExecutor(auth, { model: config.chatgptModel }),
  mock: new MockExecutor(),
  auth,
  dir: config.configDir,
  preferred: config.preferred,
  onChange: () => notify(),
});

const store = new TaskStore(join(root, "data"));
const runner = new TaskRunner(store, providers, config.maxConcurrent);
const server = createApp({
  store,
  runner,
  settings: providers,
  auth,
  chat: providers,
  port: config.port,
  devPort: config.devPort,
  distDir: join(root, "dist"),
});
notify = server.notifySettings;

const LABEL = { claude: "Claude", chatgpt: "ChatGPT（Sign in with ChatGPT）", mock: "模擬（mock）" } as const;

// 只綁本機位址，不對區域網路開放。
server.listen(config.port, "127.0.0.1", () => {
  const view = providers.view();
  console.log(`Nous 原型已啟動：http://localhost:${config.port}`);
  console.log(`目前引擎：${LABEL[view.provider]}（可在畫面上說「設定」切換）`);
  for (const p of view.providers) console.log(`  - ${p.label}：${p.available ? "可用" : "不可用"}，${p.detail}`);
  console.log(`憑證與設定目錄：${config.configDir}`);
});
