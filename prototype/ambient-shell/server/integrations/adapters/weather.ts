import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import { weatherCondition, weatherPlace, WEATHER_ATTRIBUTION, type WeatherPlaceId } from "../../../shared/proactive.ts";
import type { WeatherService } from "../../weather.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// PRO-1（George 2026-11-05）：今天的天氣（Open-Meteo，CC BY 4.0）當成唯讀 Adapter。
// 沒有任何參數：地點只來自主動提醒設定（WEATHER_PLACES 的固定座標），模型不能指定地點或網址。
// 結果和招呼後念的那一句來自同一份快取（server/weather.ts）。

export const WEATHER_TOOL = "app.weather.today" as const satisfies IntegrationToolId;

export interface WeatherAdapterOptions {
  service: WeatherService;
  /** 主動提醒設定的地點（選的或依系統時區推的）；null＝沒有地點。 */
  place: () => WeatherPlaceId | null;
}

export class WeatherAdapter implements IntegrationAdapter {
  readonly id = "weather";
  readonly service = "weather";
  readonly version = 1;
  readonly mock = false;

  constructor(private readonly options: WeatherAdapterOptions) {}

  tools(): readonly ToolDefinition[] {
    return [
      {
        id: WEATHER_TOOL,
        description: "查今天的天氣（設定裡的地點；資料來源 Open-Meteo）：天氣狀況、最低與最高溫、降雨機率最高的時段。使用者問今天天氣時呼叫。",
        descriptionEn: "Get today's weather for the place in settings (data from Open-Meteo): condition, low and high temperature, and the part of the day with the highest chance of rain. Call when the user asks about today's weather.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        effect: "read",
        enabled: true,
        timeoutMs: 10_000,
        supportedRoutes: ["api_key", "live"],
      },
    ];
  }

  async health(): Promise<HealthReport> {
    if (!this.options.place()) return { health: "unavailable", reason: "not_configured" };
    const s = this.options.service.state();
    if (s.state === "ok") return { health: "available", reason: "ok" };
    if (s.state === "failed") return { health: "unavailable", reason: "error" };
    return { health: "unknown", reason: "not_ready" };
  }

  async execute(toolId: IntegrationToolId, _args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (toolId !== WEATHER_TOOL) return toolResult("refused", "沒有這個工具。", { reason: "not_registered" });
    const placeId = this.options.place();
    const place = weatherPlace(placeId);
    if (!placeId || !place) return toolResult("refused", "還沒有設定天氣的地點（選單列「主動提醒」可以選）。", { reason: "unavailable" });
    const w = await this.options.service.refresh(placeId, ctx.signal);
    if (!w) return toolResult("failed", "查不到今天的天氣（Open-Meteo 沒有回應或回覆看不懂）。", { reason: "unavailable" });
    return toolResult("confirmed", "今天的天氣。", {
      data: {
        place: place.zh,
        date: w.date,
        condition: weatherCondition(w.code, "zh-TW"),
        low_c: Math.round(w.min_c),
        high_c: Math.round(w.max_c),
        rain: w.rain ? { part: w.rain.part, percent: w.rain.percent } : null,
        source: WEATHER_ATTRIBUTION,
      },
    });
  }
}
