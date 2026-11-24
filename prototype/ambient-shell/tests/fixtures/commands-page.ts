import type { SettingsView } from "../../shared/types.ts";
import { renderCommandsMarkdown } from "../../shared/voice-commands.ts";
import { renderCommandsPage } from "../../server/commands-page.ts";
import { liveCatalog, staticCatalog } from "../../server/integrations/catalog.ts";
import { IntegrationRegistry } from "../../server/integrations/registry.ts";

// CAP-1：/help/commands（兩種語言）與 README 指令表的固定輸出（scripts/write-model-tools-baseline.ts --commands 產生 baseline）。
// CAP-2：整合工具的列改由能力總表產生，baseline 重新產生；commands-page.pre-cap-2.json 是 CAP-2 之前的輸出，
// tests/capability-catalog.test.ts 用它證明「定時器與鬧鐘」「App 整合」以外的段落逐字不變。
// 頁面用沒有任何工具註冊的即時總表（和沒有整合層時的 server/app.ts 相同）；README 用靜態總表。

const VIEW: SettingsView = { schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬", available: true, detail: "不呼叫任何模型，只展示流程" }], chatgpt: { signed_in: true, email: "模擬", plan_usage: true, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } };
const NOW = new Date("2026-11-24T08:00:00.000Z");

export function commandsPageOutputs(): Record<string, string> {
  const catalog = liveCatalog(new IntegrationRegistry({ enabled: { has: () => false } }));
  return { "page/zh-TW": renderCommandsPage(VIEW, catalog, NOW, "zh-TW"), "page/en": renderCommandsPage(VIEW, catalog, NOW, "en"), readme: renderCommandsMarkdown(staticCatalog()) };
}
