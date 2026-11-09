import { spokenDuration, timerRemainingMs, TIMER_MAX_S, type TimerView } from "../../../shared/alarm.ts";
import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import type { AlarmCenter, TimerOp } from "../../alarms.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// ALARM-1（George 2026-11-09）：定時器是核心內建的本機工具（不需要 NOUS_AIL）；兩條即時語音路徑共用。
// 排程與保存都在 AlarmCenter；這裡只把模型的參數轉成核心操作，結果一律來自核心的狀態（confirmed 表示核心已保存）。
// 設定頁關掉「鬧鐘與定時器」時，工具不出現在工具清單（registry 的 enabled），已在通話中的呼叫回 refused。

const TIMER_REF = { type: "string", description: "哪一個定時器：名字（例如「泡麵」）或 ID；只有一個時可以不給", maxLength: 40 } as const;

const TOOLS: readonly ToolDefinition[] = [
  {
    id: "app.timer.start",
    description: "開始一個倒數定時器（例如「計時 10 分鐘」「泡麵 3 分鐘」）。可以同時有好幾個。時間到時 Nous 會在建立的這台裝置響鈴，不用再說話提醒。",
    descriptionEn: "Start a countdown timer (\"set a timer for 10 minutes\", \"noodles, 3 minutes\"). Several can run at once. When it ends Nous rings on the device where it was set; you do not need to remind the user yourself.",
    inputSchema: {
      type: "object",
      properties: {
        duration_s: { type: "integer", description: "長度（秒），1 到 86400", minimum: 1, maximum: TIMER_MAX_S },
        label: { type: "string", description: "使用者取的名字（例如「泡麵」）；沒說就不給", maxLength: 40 },
      },
      required: ["duration_s"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.list",
    description: "列出目前的定時器與各剩多少時間（使用者問「還剩多久」「有哪些定時器」時呼叫）。",
    descriptionEn: "List the current timers and how much time each has left (call when the user asks how long is left or which timers are running).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.pause",
    description: "暫停一個定時器。",
    descriptionEn: "Pause a timer.",
    inputSchema: { type: "object", properties: { timer: TIMER_REF }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.resume",
    description: "繼續一個暫停的定時器。",
    descriptionEn: "Resume a paused timer.",
    inputSchema: { type: "object", properties: { timer: TIMER_REF }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.extend",
    description: "延長一個定時器（例如「再加 5 分鐘」）。",
    descriptionEn: "Add time to a timer (\"add 5 more minutes\").",
    inputSchema: {
      type: "object",
      properties: { timer: TIMER_REF, add_s: { type: "integer", description: "要加多少秒", minimum: 1, maximum: TIMER_MAX_S } },
      required: ["add_s"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.cancel",
    description: "取消一個定時器；all 為 true 時取消全部。",
    descriptionEn: "Cancel a timer; with all set to true, cancel every timer.",
    inputSchema: { type: "object", properties: { timer: TIMER_REF, all: { type: "boolean", description: "取消全部" } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.timer.stop_ringing",
    description: "停止正在響的定時器鈴聲（使用者說「停」「關掉」「知道了」時呼叫）。",
    descriptionEn: "Stop a timer that is ringing (call when the user says stop, turn it off, or got it).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
];

export class TimerAdapter implements IntegrationAdapter {
  readonly id = "timer";
  readonly service = "timer";
  readonly version = 1;
  readonly mock = false;

  constructor(private readonly center: AlarmCenter) {}

  tools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  async health(): Promise<HealthReport> {
    return this.center.enabled ? { health: "available", reason: "ok" } : { health: "unavailable", reason: "not_configured" };
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (!this.center.enabled) return toolResult("refused", "鬧鐘與定時器已在設定關閉，沒有執行。", { reason: "disabled" });
    switch (toolId) {
      case "app.timer.start": {
        const r = this.center.startTimer({ duration_s: args.duration_s as number, label: args.label, origin: ctx.page ?? null });
        if (!r.ok) return refused(r);
        return toolResult("confirmed", `已開始${r.timer.label ? `「${r.timer.label}」` : ""}${spokenDuration(r.timer.duration_ms)}的定時器。`, { data: { timer: this.describe(timerViewOf(r)) } });
      }
      case "app.timer.list": {
        const timers = this.center.timers();
        const ringing = this.center.rings().length;
        return toolResult("confirmed", timers.length ? `目前有 ${timers.length} 個定時器。` : "現在沒有定時器。", { data: { timers: timers.map((t) => this.describe(t)), ringing } });
      }
      case "app.timer.pause":
        return this.op(this.center.pause(args.timer), "已暫停");
      case "app.timer.resume":
        return this.op(this.center.resume(args.timer), "已繼續");
      case "app.timer.extend":
        return this.op(this.center.extend(args.timer, args.add_s as number), "已延長");
      case "app.timer.cancel": {
        const r = this.center.cancel(args.timer, args.all === true);
        if (!r.ok) return refused(r);
        if (!r.cancelled.length) return toolResult("confirmed", "現在沒有定時器，不用取消。", { data: { cancelled: [] } });
        return toolResult("confirmed", `已取消 ${r.cancelled.map((t) => (t.label ? `「${t.label}」` : spokenDuration(t.duration_ms))).join("、")}。`, { data: { cancelled: r.cancelled.map((t) => t.label ?? t.id) } });
      }
      case "app.timer.stop_ringing": {
        const n = this.center.stopRings("tool");
        return toolResult("confirmed", n ? "鈴聲已停止。" : "現在沒有在響的定時器。", { data: { stopped: n } });
      }
      default:
        return toolResult("refused", "沒有這個工具。", { reason: "not_registered" });
    }
  }

  private op(r: TimerOp, verb: string): ToolResult {
    if (!r.ok) return refused(r);
    const t = timerViewOf(r);
    return toolResult("confirmed", `${verb}${t.label ? `「${t.label}」` : "定時器"}，還剩 ${spokenDuration(timerRemainingMs(t, this.center.now()))}。`, { data: { timer: this.describe(t) } });
  }

  private describe(t: TimerView): Record<string, unknown> {
    const left = timerRemainingMs(t, this.center.now());
    return { id: t.id, label: t.label, state: t.state, remaining_s: Math.ceil(left / 1000), remaining: spokenDuration(left) };
  }
}

function timerViewOf(r: Extract<TimerOp, { ok: true }>): TimerView {
  const t = r.timer;
  return { id: t.id, label: t.label, state: t.state, duration_ms: t.duration_ms, ends_at: t.state === "running" ? t.ends_at : null, remaining_ms: t.state === "paused" ? t.remaining_ms : null };
}

function refused(r: { code: string; message: string; candidates?: string[] }): ToolResult {
  const reason = r.code === "disabled" ? "disabled" : r.code === "invalid" ? "invalid_arguments" : "unavailable";
  const data = r.candidates?.length ? { candidates: r.candidates } : undefined;
  return toolResult("refused", r.message, { reason, ...(data ? { data } : {}) });
}
