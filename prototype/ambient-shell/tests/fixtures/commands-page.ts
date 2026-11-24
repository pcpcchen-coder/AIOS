import type { SettingsView } from "../../shared/types.ts";
import { renderCommandsMarkdown } from "../../shared/voice-commands.ts";
import { renderCommandsPage } from "../../server/commands-page.ts";

// CAP-1：/help/commands（兩種語言）與 README 指令表的固定輸出。tests/fixtures/commands-page.baseline.json 是加入總表的
// 中英文翻譯之前產生的（scripts/write-model-tools-baseline.ts）；總表的翻譯鍵不能改變這一頁。

const VIEW: SettingsView = { schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬", available: true, detail: "不呼叫任何模型，只展示流程" }], chatgpt: { signed_in: true, email: "模擬", plan_usage: true, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } };
const NOW = new Date("2026-11-24T08:00:00.000Z");

export function commandsPageOutputs(): Record<string, string> {
  return { "page/zh-TW": renderCommandsPage(VIEW, NOW, "zh-TW"), "page/en": renderCommandsPage(VIEW, NOW, "en"), readme: renderCommandsMarkdown() };
}
