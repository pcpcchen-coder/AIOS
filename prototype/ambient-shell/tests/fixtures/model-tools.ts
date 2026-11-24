import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locale } from "../../shared/i18n.mjs";
import type { AlarmCenter } from "../../server/alarms.ts";
import { AlarmAdapter } from "../../server/integrations/adapters/alarm.ts";
import { GmailGogAdapter } from "../../server/integrations/adapters/gmail-gog.ts";
import { GoogleCalendarAdapter } from "../../server/integrations/adapters/google-calendar.ts";
import { HomeAdapter, type HomeBridgePort } from "../../server/integrations/adapters/home.ts";
import { LgTvAdapter } from "../../server/integrations/adapters/lg-tv.ts";
import { MockAdapter } from "../../server/integrations/adapters/mock.ts";
import { SpotifySoloistAdapter } from "../../server/integrations/adapters/spotify-soloist.ts";
import { TimerAdapter } from "../../server/integrations/adapters/timer.ts";
import { createVoiceRelayAdapter } from "../../server/integrations/adapters/voice-relay.ts";
import { WeatherAdapter } from "../../server/integrations/adapters/weather.ts";
import type { IntegrationAdapter } from "../../server/integrations/contracts.ts";
import { IntegrationRegistry } from "../../server/integrations/registry.ts";
import type { WeatherService } from "../../server/weather.ts";
import { buildRealtimeTools } from "../../server/realtime.ts";

// CAP-1：送給模型的工具 JSON 的固定組合（每個已審核的 Adapter 都註冊，每個都啟用）。
// tests/fixtures/model-tools.baseline.json 是在加入總表欄位之前，用這份組合在未修改的程式上產生的輸出
// （scripts/write-model-tools-baseline.ts）；tests/capability-catalog.test.ts 比對現在的輸出與它逐字相同。

const unused = new Proxy({}, { get: () => { throw new Error("tools() 不應該用到這個依賴"); } });

function relay(mode: "fake" | "mac"): IntegrationAdapter {
  const dir = join(mkdtempSync(join(tmpdir(), "nous-model-tools-")), "voice-relay");
  const adapter = createVoiceRelayAdapter({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode, dir } }, () => undefined, { platform: "darwin", run: async () => ({ code: 0, stdout: "" }) });
  if (!adapter) throw new Error(`voice_relay（${mode}）沒有建立`);
  return adapter;
}

export function modelToolAdapters(relayMode: "fake" | "mac"): IntegrationAdapter[] {
  const home: HomeBridgePort = { available: true, probe: async () => undefined, status: unused as never, control: unused as never, confirm: unused as never };
  return [
    new MockAdapter(),
    new HomeAdapter(home),
    new SpotifySoloistAdapter({ port: 19090 }),
    relay(relayMode),
    new GoogleCalendarAdapter({ account: "someone@example.com", gogPath: "/usr/local/bin/gog" }),
    new WeatherAdapter({ service: unused as WeatherService, place: () => null }),
    new LgTvAdapter({ host: "192.168.1.20", pairingFile: "/nonexistent/lgtv.json" }),
    new GmailGogAdapter({ self: "someone@example.com", gogPath: "/usr/local/bin/gog" }),
    new TimerAdapter(unused as AlarmCenter),
    new AlarmAdapter(unused as AlarmCenter),
  ];
}

/** 每條語音路徑、每種語言、兩種 voice_relay 模式下，送給模型的 JSON（字串）。 */
export function modelToolOutputs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const relayMode of ["fake", "mac"] as const) {
    const registry = new IntegrationRegistry({ enabled: { has: () => true } });
    for (const adapter of modelToolAdapters(relayMode)) registry.register(adapter);
    for (const locale of ["zh-TW", "en"] as Locale[]) {
      for (const route of ["api_key", "live"] as const) {
        out[`functionSpecs/${relayMode}/${route}/${locale}`] = JSON.stringify(registry.functionSpecs(route, locale));
        for (const webSearch of [true, false]) {
          const tools = buildRealtimeTools({ webSearch, mcp: [], home: true, memory: true, integrations: (l) => registry.functionSpecs(route, l) }, locale);
          out[`buildRealtimeTools/${relayMode}/${route}/${locale}/web=${webSearch}`] = JSON.stringify(tools);
        }
      }
      out[`buildRealtimeTools/no-integrations/${locale}`] = JSON.stringify(buildRealtimeTools({ webSearch: true, mcp: [], home: true, memory: true }, locale));
    }
  }
  return out;
}
