import type { Locale } from "../shared/i18n.mjs";
import type { ChatEvent, ChatTurn } from "./api.ts";

interface Exchange {
  requestId: string;
  user: string;
  answer: string;
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
  stream(messages: ChatTurn[], requestId: string, event: (value: ChatEvent) => void, signal: AbortSignal, locale?: Locale): Promise<void>;
  output(): ConversationOutput;
  changed(): void;
  activity?(kind: "submit" | "stream", requestId: string, text: string): void;
  delegated(title: string, requestId: string, locale?: Locale): void;
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
  private history: ChatTurn[][] = [];
  private active: ActiveTurn | null = null;
  private reply: ConversationReply = { kind: "idle" };
  private visible = false;

  constructor(private readonly options: ConversationOptions) {}

  get view(): Readonly<{ reply: ConversationReply; visible: boolean }> {
    return { reply: this.reply, visible: this.visible };
  }

  async send(text: string, requestId: string, locale?: Locale): Promise<void> {
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
            this.options.delegated(event.title, requestId, turn.locale);
            break;
          case "done":
            turn.settled = true;
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
      }, turn.controller.signal, turn.locale);
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
    this.history.push([{ role: "user", content: exchange.user }, { role: "assistant", content: answer }]);
    this.history = this.history.slice(-9);
  }

  private messagesFor(exchange: Exchange): ChatTurn[] {
    const latest: ChatTurn = { role: "user", content: exchange.user };
    const bytes = (messages: ChatTurn[]) => new TextEncoder().encode(JSON.stringify({ messages, request_id: exchange.requestId })).length;
    if (bytes([latest]) > MAX_REQUEST_BYTES) throw new Error("這則訊息超過傳送大小限制，請縮短後再試。");
    while (this.history.length && bytes([...this.history.flat(), latest]) > MAX_REQUEST_BYTES) this.history.shift();
    return [...this.history.flat(), latest];
  }
}
