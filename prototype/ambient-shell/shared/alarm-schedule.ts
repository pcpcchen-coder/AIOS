// ALARM-2（George 2026-11-09）：鬧鐘的本機時間計算（純函式；時區由呼叫端給，核心用 #96 的系統時區）。
// 鬧鐘是「牆上時鐘」的時間（每天 07:00），所以每次都用時區把當地日期與時間換成 epoch：
// - 夏令時間開始（例如 02:30 不存在）：延到跳過之後的同一個相對位置（03:30）。
// - 夏令時間結束（01:30 出現兩次）：用第一次。
// 重複規則只存星期幾（0＝星期日）；單次鬧鐘存當地日期。

export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const WEEKENDS = [0, 6] as const;
export const REPEATS = ["once", "daily", "weekdays", "weekends", "custom"] as const;
export type Repeat = (typeof REPEATS)[number];

export interface AlarmTime {
  hour: number;
  minute: number;
  /** 重複的星期幾（0–6，排序、不重複）；空的＝單次。 */
  days: number[];
  /** 單次鬧鐘的當地日期（YYYY-MM-DD）；重複的是 null。 */
  date: string | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 「07:00」「7:5」→ {hour, minute}；不合法回 null。 */
export function parseClock(text: unknown): { hour: number; minute: number } | null {
  if (typeof text !== "string") return null;
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

/** 重複規則 → 星期幾。custom 的 days 是「mon,wed,fri」或「一三五」；看不懂回 null。 */
export function repeatDays(repeat: unknown, days?: unknown): number[] | null {
  switch (repeat ?? "once") {
    case "once":
      return [];
    case "daily":
      return [0, 1, 2, 3, 4, 5, 6];
    case "weekdays":
      return [...WEEKDAYS];
    case "weekends":
      return [...WEEKENDS];
    case "custom": {
      if (typeof days !== "string") return null;
      const tokens = days.toLowerCase().replace(/星期|週|周|禮拜|礼拜/g, "").match(/[a-z]+|[日天一二三四五六]|\d/g) ?? [];
      const out = new Set<number>();
      for (const tok of tokens) {
        const n = /^\d$/.test(tok) ? Number(tok) % 7 : DAY_NAMES[tok];
        if (n === undefined) return null;
        out.add(n);
      }
      return out.size ? [...out].sort((a, b) => a - b) : null;
    }
    default:
      return null;
  }
}

/** 這個時刻在時區裡的牆上時間。 */
export function wallTime(epoch: number, timeZone: string): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(epoch));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))),
  };
}

function offsetMs(epoch: number, timeZone: string): number {
  const w = wallTime(epoch, timeZone);
  const [y, m, d] = w.date.split("-").map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, w.hour, w.minute);
  return asUtc - Math.floor(epoch / 60_000) * 60_000;
}

/** 當地日期與時間 → epoch（夏令時間的空隙延後、重疊取第一次）。 */
export function wallToEpoch(date: string, hour: number, minute: number, timeZone: string): number {
  const m = DATE.exec(date);
  if (!m) throw new Error(`不是日期：${date}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  const candidates = [...new Set([guess - offsetMs(guess - 12 * 3600_000, timeZone), guess - offsetMs(guess + 12 * 3600_000, timeZone), guess - offsetMs(guess, timeZone)])].sort((a, b) => a - b);
  const exact = candidates.filter((t) => {
    const w = wallTime(t, timeZone);
    return w.date === date && w.hour === hour && w.minute === minute;
  });
  if (exact.length) return exact[0]!;
  // 夏令時間開始跳過的時間：取較晚的那一個（跳過之後的同一個相對位置）。
  return candidates[candidates.length - 1]!;
}

function addDays(date: string, n: number): string {
  const m = DATE.exec(date)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

/** 單次鬧鐘沒指定日期：今天這個時間還沒過就是今天，否則明天。 */
export function nextDateFor(hour: number, minute: number, after: number, timeZone: string): string {
  const today = wallTime(after, timeZone).date;
  return wallToEpoch(today, hour, minute, timeZone) > after ? today : addDays(today, 1);
}

/** 下一次響的時間（> after）；單次鬧鐘已經過了回 null。 */
export function nextOccurrence(alarm: AlarmTime, after: number, timeZone: string): number | null {
  if (!alarm.days.length) {
    if (!alarm.date) return null;
    const t = wallToEpoch(alarm.date, alarm.hour, alarm.minute, timeZone);
    return t > after ? t : null;
  }
  const start = wallTime(after, timeZone).date;
  for (let i = 0; i <= 8; i++) {
    const date = addDays(start, i);
    const t = wallToEpoch(date, alarm.hour, alarm.minute, timeZone);
    if (t > after && alarm.days.includes(wallTime(t, timeZone).weekday)) return t;
  }
  return null;
}

/** 重複規則的說法（「每天」「工作日」「週一、三、五」）。 */
export function repeatText(days: readonly number[], locale: "zh-TW" | "en" = "zh-TW"): string {
  const key = days.join(",");
  if (!days.length) return locale === "en" ? "once" : "單次";
  if (key === "0,1,2,3,4,5,6") return locale === "en" ? "every day" : "每天";
  if (key === "1,2,3,4,5") return locale === "en" ? "weekdays" : "工作日";
  if (key === "0,6") return locale === "en" ? "weekends" : "週末";
  const zh = ["日", "一", "二", "三", "四", "五", "六"];
  const en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return locale === "en" ? days.map((d) => en[d]).join(", ") : `週${days.map((d) => zh[d]).join("、")}`;
}

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
