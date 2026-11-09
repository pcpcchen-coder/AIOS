import { formatClock, repeatDays, repeatText, REPEATS } from "../../../shared/alarm-schedule.ts";
import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import type { AlarmView } from "../../../shared/alarm.ts";
import type { AlarmCenter, AlarmOp } from "../../alarms.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// ALARM-2（George 2026-11-09）：鬧鐘是核心內建的本機工具（同定時器，不需要 NOUS_AIL），兩條即時語音路徑共用。
// 時間一律是 24 小時制的本機時間（核心的系統時區）；「明天」「下週三」由模型依指示裡的今天日期換成 date。

const ALARM_REF = { type: "string", description: "哪一個鬧鐘：名字、時間（例如 07:00）或 ID；只有一個時可以不給", maxLength: 40 } as const;
const ROUTES = ["api_key", "live"] as const;

const TOOLS: readonly ToolDefinition[] = [
  {
    id: "app.alarm.set",
    description: "設定鬧鐘（「明天早上 7 點叫我」「每個工作天 6:30」）。time 是 24 小時制的本機時間；單次鬧鐘可給 date（YYYY-MM-DD，不給就是下一次的這個時間）；重複用 repeat（daily、weekdays、weekends，或 custom 加 days，例如 mon,wed,fri）。響的時候 Nous 會在設定的這台裝置響鈴。",
    descriptionEn: "Set an alarm (\"wake me at 7 tomorrow\", \"every weekday at 6:30\"). time is local 24-hour time; a one-off alarm may have date (YYYY-MM-DD; without it, the next time this clock time comes). Repeat with repeat (daily, weekdays, weekends, or custom plus days such as mon,wed,fri). It rings on the device where it was set.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "24 小時制本機時間，例如 07:00、18:30", maxLength: 5 },
        repeat: { type: "string", enum: REPEATS, description: "once（預設）、daily、weekdays、weekends、custom" },
        days: { type: "string", description: "repeat 是 custom 時的星期，例如 mon,wed,fri", maxLength: 40 },
        date: { type: "string", description: "單次鬧鐘的日期 YYYY-MM-DD（本機）", maxLength: 10 },
        label: { type: "string", description: "使用者取的名字（例如「吃藥」）；沒說就不給", maxLength: 40 },
      },
      required: ["time"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
  {
    id: "app.alarm.list",
    description: "列出鬧鐘（時間、重複、開或關、下一次什麼時候響）與貪睡中的鬧鐘。",
    descriptionEn: "List alarms (time, repeat, on or off, when each rings next) and snoozed alarms.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
  {
    id: "app.alarm.enable",
    description: "打開或關掉一個鬧鐘（不刪除）。",
    descriptionEn: "Turn an alarm on or off (without deleting it).",
    inputSchema: { type: "object", properties: { alarm: ALARM_REF, enabled: { type: "boolean", description: "true 打開、false 關掉" } }, required: ["enabled"], additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
  {
    id: "app.alarm.delete",
    description: "刪除一個鬧鐘；all 為 true 時刪除全部鬧鐘。",
    descriptionEn: "Delete an alarm; with all set to true, delete every alarm.",
    inputSchema: { type: "object", properties: { alarm: ALARM_REF, all: { type: "boolean", description: "刪除全部" } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
  {
    id: "app.alarm.snooze",
    description: "鬧鐘正在響時貪睡（使用者說「貪睡」「再睡一下」）：停下來，過幾分鐘再響。",
    descriptionEn: "Snooze a ringing alarm (the user says snooze or a few more minutes): stop now and ring again in a few minutes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
  {
    id: "app.alarm.stop_ringing",
    description: "停止正在響的鬧鐘（「停」「我起來了」）；cancel_snoozes 為 true 時也取消貪睡中的（「不用再叫我了」）。",
    descriptionEn: "Stop a ringing alarm (\"stop\", \"I'm up\"); with cancel_snoozes true, also cancel snoozed ones (\"don't wake me again\").",
    inputSchema: { type: "object", properties: { cancel_snoozes: { type: "boolean", description: "一併取消貪睡" } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ROUTES,
  },
];

export class AlarmAdapter implements IntegrationAdapter {
  readonly id = "alarm";
  readonly service = "alarm";
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
      case "app.alarm.set": {
        const days = repeatDays(args.repeat, args.days);
        if (!days) return toolResult("refused", "重複規則看不懂（custom 要給 days，例如 mon,wed,fri）。", { reason: "invalid_arguments" });
        const r = this.center.setAlarm({ time: args.time, days, date: days.length ? undefined : args.date, label: args.label, origin: ctx.page ?? null });
        if (!r.ok) return refused(r);
        const a = this.view(r);
        return toolResult("confirmed", `已設定${a.label ? `「${a.label}」` : ""}${repeatText(a.days)} ${a.time} 的鬧鐘。`, { data: { alarm: this.describe(a) } });
      }
      case "app.alarm.list": {
        const alarms = this.center.alarms();
        const snoozes = this.center.view("main").snoozes;
        return toolResult("confirmed", alarms.length ? `有 ${alarms.length} 個鬧鐘。` : "現在沒有鬧鐘。", {
          data: { alarms: alarms.map((a) => this.describe(a)), snoozed: snoozes.map((z) => ({ label: z.label, rings_at: this.local(z.due_at) })), ringing: this.center.rings().length },
        });
      }
      case "app.alarm.enable": {
        const r = this.center.setAlarmEnabled(args.alarm, args.enabled === true);
        if (!r.ok) return refused(r);
        const a = this.view(r);
        return toolResult("confirmed", `${a.enabled ? "已打開" : "已關掉"} ${a.time}${a.label ? `「${a.label}」` : ""}的鬧鐘。`, { data: { alarm: this.describe(a) } });
      }
      case "app.alarm.delete": {
        const r = this.center.deleteAlarm(args.alarm, args.all === true);
        if (!r.ok) return refused(r);
        if (!r.deleted.length) return toolResult("confirmed", "現在沒有鬧鐘，不用刪。", { data: { deleted: [] } });
        return toolResult("confirmed", `已刪除 ${r.deleted.map((a) => `${a.time}${a.label ? `「${a.label}」` : ""}`).join("、")} 的鬧鐘。`, { data: { deleted: r.deleted.map((a) => a.label ?? a.time) } });
      }
      case "app.alarm.snooze": {
        const n = this.center.snoozeRings("tool");
        const minutes = Math.round(this.center.prefs().snooze_s / 60);
        return toolResult("confirmed", n ? `好，${minutes} 分鐘後再叫。` : "現在沒有在響的鬧鐘。", { data: { snoozed: n, minutes } });
      }
      case "app.alarm.stop_ringing": {
        const n = this.center.stopRings("tool");
        const cancelled = args.cancel_snoozes === true ? this.center.cancelSnoozes() : 0;
        return toolResult("confirmed", n || cancelled ? "鬧鐘已停止。" : "現在沒有在響的鬧鐘。", { data: { stopped: n, snoozes_cancelled: cancelled } });
      }
      default:
        return toolResult("refused", "沒有這個工具。", { reason: "not_registered" });
    }
  }

  private view(r: Extract<AlarmOp, { ok: true }>): AlarmView {
    const a = r.alarm;
    return { id: a.id, label: a.label, time: formatClock(a.hour, a.minute), days: [...a.days], date: a.date, enabled: a.enabled, next_at: a.next_at };
  }

  private local(epoch: number): string {
    const d = new Date(epoch);
    return new Intl.DateTimeFormat("sv-SE", { timeZone: this.center.timeZone(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  }

  private describe(a: AlarmView): Record<string, unknown> {
    return { id: a.id, label: a.label, time: a.time, repeat: repeatText(a.days), date: a.date, enabled: a.enabled, next: a.next_at === null ? null : this.local(a.next_at) };
  }
}

function refused(r: { code: string; message: string; candidates?: string[] }): ToolResult {
  const reason = r.code === "disabled" ? "disabled" : r.code === "invalid" ? "invalid_arguments" : "unavailable";
  return toolResult("refused", r.message, { reason, ...(r.candidates?.length ? { data: { candidates: r.candidates } } : {}) });
}
