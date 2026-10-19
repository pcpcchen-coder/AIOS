import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatus, createApp } from "./app.ts";
import { ClaudeExecutor } from "./claude-executor.ts";
import { loadConfig } from "./config.ts";
import { MockExecutor } from "./mock-executor.ts";
import { TaskRunner, type Executor } from "./runner.ts";
import { TaskStore } from "./store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env);
const executor: Executor =
  config.mode === "claude"
    ? new ClaudeExecutor({
        apiKey: config.apiKey!,
        model: config.model,
        modelFamily: config.modelFamily,
        fallbacks: config.fallbacks,
      })
    : new MockExecutor();

const store = new TaskStore(join(root, "data"));
const runner = new TaskRunner(store, executor, config.maxConcurrent);
const server = createApp({
  store,
  runner,
  status: buildStatus(config.mode, config.modeReason),
  port: config.port,
  devPort: config.devPort,
  distDir: join(root, "dist"),
});

// 只綁本機位址，不對區域網路開放。
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Nous 原型已啟動：http://localhost:${config.port}`);
  console.log(`執行模式：${config.mode === "claude" ? "Claude" : "模擬（mock）"} — ${config.modeReason}`);
  if (config.mode === "claude") {
    console.log(
      config.model
        ? `模型：${config.model}（NOUS_MODEL）`
        : `模型：第一個任務時經 Models API 取得最新的「${config.modelFamily}」系列`,
    );
  }
});
