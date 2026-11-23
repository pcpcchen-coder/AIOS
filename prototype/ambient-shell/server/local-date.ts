// 「今天」一律用本機時區（Nous 核心跑在家裡的 Mac 上，系統時區就是使用者的時區），不用 UTC：
// 之前用 toISOString().slice(0, 10)，台灣時間 00:00–08:00 會變成前一天，模型換算「明天」「下週三」就差一天（George 2026-11-05 要求修正）。

const WEEKDAY_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;

/** 本機系統的 IANA 時區（取不到時 UTC）。 */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 某個時刻在這個時區的日期（YYYY-MM-DD）與星期幾（0＝星期日）。 */
export function localDate(now: Date, timeZone: string = systemTimeZone()): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekday < 0 ? 0 : weekday };
}

/** 本機時區的今天（YYYY-MM-DD）。 */
export function localToday(now: Date = new Date(), timeZone: string = systemTimeZone()): string {
  return localDate(now, timeZone).date;
}

/** 說明文字裡的一行：「今天日期：2026-11-05（星期四，Asia/Taipei）。」 */
export function todayLine(now: Date, timeZone: string = systemTimeZone()): string {
  const { date, weekday } = localDate(now, timeZone);
  return `今天日期：${date}（${WEEKDAY_ZH[weekday]}，${timeZone}）。`;
}
