import { randomBytes } from "node:crypto";
import { DUCK_WAKE_TOKEN, DUCK_WAKE_TTL_MS } from "../../shared/duck-terminal.ts";

// DUCK-2：鴨子喚醒的一次性權杖。核心收到 duck-link 的 wake_word 事件時發一個，隨 SSE voice.request 交給鴨子終端的頁面；
// 頁面開始即時語音時帶回來，核心核對「是我發的、給這個頁面、還沒用過、沒過期」才把這通當成喚醒開始。
// 這不是使用者授權，只是把「喚醒真的發生過」的證據從 duck-link 接到 /api/realtime/start；限速仍由 RealtimeSessions 做。

export class DuckWakeGate {
  private readonly issued = new Map<string, { page: string; expires: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DUCK_WAKE_TTL_MS,
  ) {}

  /** 為這個頁面發一個權杖（同一個頁面之前還沒用的作廢：一次只有一個喚醒在等）。 */
  issue(page: string): string {
    this.sweep();
    for (const [token, entry] of [...this.issued]) if (entry.page === page) this.issued.delete(token);
    const token = `dw_${randomBytes(16).toString("hex")}`;
    this.issued.set(token, { page, expires: this.now() + this.ttlMs });
    return token;
  }

  /** 核對並用掉。格式不對、不是發給這個頁面、過期或用過都回 false。 */
  redeem(token: unknown, page: string): boolean {
    if (typeof token !== "string" || !DUCK_WAKE_TOKEN.test(token)) return false;
    this.sweep();
    const entry = this.issued.get(token);
    if (!entry || entry.page !== page) return false;
    this.issued.delete(token);
    return true;
  }

  get pending(): number {
    this.sweep();
    return this.issued.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of [...this.issued]) if (entry.expires <= now) this.issued.delete(token);
  }
}
