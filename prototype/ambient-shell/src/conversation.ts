import type { Locale } from "../shared/i18n.mjs";
import type { ChatEvent, ChatTurn } from "./api.ts";

interface Exchange {
  requestId: string;
  user: string;
  answer: string;
  /** 核心的記憶提示（這次沒有保存或沒有用到記憶）；不進對話歷史。 */
  notice?: string;
  /** 這一輪用到記憶（或是核心的記憶回條）：之後被撤銷、更正、忘記或換人時要清掉含它的歷史。 */
  usedMemory?: boolean;
}

export type ConversationReply =
  | { kind: "idle" }
  | (Exchange & { kind: "pending" | "complete" | "interrupted" })
  | (Exchange & { kind: "error"; message: string; action: string | null });

export interface ConversationOutput {
  push(text: string): void;
  end(): void;
  cancel(): void;
}

interface ConversationOptions {
  stream(messages: ChatTurn[], requestId: string, event: (value: ChatEvent) => void, signal: AbortSignal, locale?: Locale, memoryTurn?: string | null): Promise<void>;
  output(): ConversationOutput;
  changed(): void;
  activity?(kind: "submit" | "stream", requestId: string, text: string): void;
  delegated(title: string, requestId: string, locale?: Locale): void;
  /** 帶記憶的一輪想交辦：改由使用者決定（title 是使用者原句）。 */
  delegateBlocked?(title: string, requestId: string, locale?: Locale): void;
}

interface ActiveTurn {
  locale?: Locale;
  controller: AbortController;
  output: ConversationOutput;
  exchange: Exchange;
  settled: boolean;
}

const MAX_REQUEST_BYTES = 15_000;
const MAX_MESSAGE_CHARS = 4000;

export class ConversationSession {
  private history: { turn: ChatTurn[]; usedMemory: boolean }[] = [];
  private active: ActiveTurn | null = null;
  private reply: ConversationReply = { kind: "idle" };
  private visible = false;

  constructor(private readonly options: ConversationOptions) {}

  get view(): Readonly<{ reply: ConversationReply; visible: boolean }> {
    return { reply: this.reply, visible: this.visible };
  }

  /**
   * memoryTurn：桌面版 IPC turn 發的一次性 nonce（只有打字來源）；瀏覽器版與語音來源為 null，核心就不取用記憶。
   */
  async send(text: string, requestId: string, locale?: Locale, memoryTurn: string | null = null): Promise<void> {
    this.interrupt();
    const exchange = { requestId, user: text.trim(), answer: "" };
    this.visible = true;
    if (!exchange.user || exchange.user.length > MAX_MESSAGE_CHARS) {
      this.reply = { ...exchange, kind: "error", message: "訊息需為 1 至 4000 字，請縮短後再試。", action: null };
      this.options.changed();
      return;
    }
    let messages: ChatTurn[];
    try {
      messages = this.messagesFor(exchange);
    } catch (error) {
      this.reply = { ...exchange, kind: "error", message: String(error), action: null };
      this.options.changed();
      return;
    }
    const turn: ActiveTurn = { controller: new AbortController(), output: this.options.output(), exchange, locale, settled: false };
    this.active = turn;
    this.reply = { ...exchange, kind: "pending" };
    this.options.activity?.("submit", requestId, exchange.user);
    this.options.changed();
    try {
      await this.options.stream(messages, requestId, (event) => {
        if (this.active !== turn || turn.settled) return;
        switch (event.type) {
          case "delta":
            turn.exchange.answer += event.text;
            if (event.text) this.options.activity?.("stream", requestId, turn.exchange.user);
            turn.output.push(event.text);
            this.reply = { ...turn.exchange, kind: "pending" };
            break;
          case "delegate":
            // 對話歷史裡有用過記憶的回答（語音來源也一樣）：不自動交辦，改問使用者，標題用這一輪的原句。
            if (this.history.some(h => h.usedMemory)) this.options.delegateBlocked?.(turn.exchange.user, requestId, turn.locale);
            else this.options.delegated(event.title, requestId, turn.locale);
            break;
          case "delegate_blocked":
            this.options.delegateBlocked?.(event.title, requestId, turn.locale);
            break;
          case "memory_notice":
            turn.exchange.notice = event.message;
            this.reply = { ...turn.exchange, kind: "pending" };
            break;
          case "memory_revoked":
            // 記憶被撤銷：停止這一輪，含記憶的歷史一併清掉（不讓舊內容回灌）。
            turn.settled = true;
            turn.output.cancel();
            this.forgetMemoryHistory(true);
            this.reply = { ...turn.exchange, answer: "", kind: "error", message: event.message, action: null };
            break;
          case "done":
            turn.settled = true;
            turn.exchange.usedMemory = (event.memory_used ?? 0) > 0;
            this.commit(turn.exchange);
            this.reply = { ...turn.exchange, kind: "complete" };
            break;
          case "error":
            turn.settled = true;
            turn.output.cancel();
            this.reply = { ...turn.exchange, kind: "error", message: event.message, action: event.action };
            break;
        }
        this.options.changed();
      }, turn.controller.signal, turn.locale, memoryTurn);
      if (this.active === turn && !turn.settled) throw new Error("回覆連線已中斷，未收到完成確認。請再試一次。");
    } catch (error) {
      if (this.active !== turn) return;
      turn.settled = true;
      turn.output.cancel();
      this.reply = { ...turn.exchange, kind: "error", message: error instanceof Error ? error.message : "對話失敗，請再試一次。", action: null };
      this.options.changed();
    } finally {
      if (this.active === turn) turn.output.end();
    }
  }

  interrupt(): void {
    const turn = this.active;
    if (!turn) return;
    this.active = null;
    if (!turn.settled) {
      this.commit(turn.exchange, true);
      this.reply = { ...turn.exchange, kind: "interrupted" };
    }
    turn.controller.abort();
    turn.output.cancel();
    this.options.changed();
  }

  dismiss(): void {
    this.visible = false;
    this.interrupt();
    this.options.changed();
  }

  /**
   * 核心的記憶回條（記住、更正、選人）直接當這一輪的回覆，不呼叫模型。純記憶指令與回條不放進模型歷史：
   * 回條含記憶內容，放進去會讓之後換成沒有同意的服務帳號時，經由歷史收到記憶。
   */
  local(text: string, requestId: string, answer: string): void {
    this.interrupt();
    const exchange: Exchange = { requestId, user: text.trim(), answer, usedMemory: true };
    this.visible = true;
    this.reply = { ...exchange, kind: "complete" };
    this.options.changed();
  }

  /** 更正、忘記、換人或撤銷之後：只要有一輪用過記憶就清空歷史（分不開哪幾句受影響，16 §8）。 */
  forgetMemoryHistory(force = false): void {
    if (force || this.history.some(h => h.usedMemory)) this.history = [];
  }

  reset(): void {
    this.visible = false;
    this.interrupt();
    this.history = [];
    this.reply = { kind: "idle" };
    this.options.changed();
  }

  private commit(exchange: Exchange, interrupted = false): void {
    if (!exchange.answer.trim()) return;
    const suffix = interrupted ? "（回覆已被使用者打斷）" : "";
    const answer = exchange.answer.length + suffix.length <= MAX_MESSAGE_CHARS
      ? exchange.answer + suffix
      : exchange.answer.slice(0, MAX_MESSAGE_CHARS - 20 - suffix.length) + "（較早回覆僅保留前段）" + suffix;
    this.history.push({ turn: [{ role: "user", content: exchange.user }, { role: "assistant", content: answer }], usedMemory: exchange.usedMemory === true });
    this.history = this.history.slice(-9);
  }

  private messagesFor(exchange: Exchange): ChatTurn[] {
    const latest: ChatTurn = { role: "user", content: exchange.user };
    const bytes = (messages: ChatTurn[]) => new TextEncoder().encode(JSON.stringify({ messages, request_id: exchange.requestId })).length;
    if (bytes([latest]) > MAX_REQUEST_BYTES) throw new Error("這則訊息超過傳送大小限制，請縮短後再試。");
    const flat = () => this.history.flatMap(h => h.turn);
    while (this.history.length && bytes([...flat(), latest]) > MAX_REQUEST_BYTES) this.history.shift();
    return [...flat(), latest];
  }
}
