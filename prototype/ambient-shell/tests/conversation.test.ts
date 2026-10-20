import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/conversation.ts";
import type { ChatEvent, ChatTurn } from "../src/api.ts";

function setup() {
  const requests: { messages: ChatTurn[]; event(value: ChatEvent): void; signal: AbortSignal; resolve(): void }[] = [];
  const outputs: { text: string; ended: boolean; cancelled: boolean }[] = [];
  const delegated: string[] = [];
  const session = new ConversationSession({
    stream: (messages, _id, event, signal) => new Promise<void>((resolve) => requests.push({ messages, event, signal, resolve })),
    output: () => {
      const value = { text: "", ended: false, cancelled: false };
      outputs.push(value);
      return { push: (text) => { value.text += text; }, end: () => { value.ended = true; }, cancel: () => { value.cancelled = true; } };
    },
    changed: () => {},
    delegated: (title, id) => delegated.push(`${id}:${title}`),
  });
  function finish(index: number, answer: string) {
    requests[index].event({ type: "delta", text: answer });
    requests[index].event({ type: "done", model: "fixture" });
    requests[index].resolve();
  }
  return { session, requests, outputs, delegated, finish };
}

describe("ConversationSession", () => {
  it("voice and text consumers continue the same completed conversation", async () => {
    const t = setup();
    const voice = t.session.send("語音問題", "req_voice001");
    t.finish(0, "第一個回答。");
    await voice;
    const text = t.session.send("文字追問", "req_text0001");
    expect(t.requests[1].messages).toEqual([
      { role: "user", content: "語音問題" }, { role: "assistant", content: "第一個回答。" }, { role: "user", content: "文字追問" },
    ]);
    t.finish(1, "文字回答。");
    await text;
    expect(t.session.view).toMatchObject({ visible: true, reply: { kind: "complete", answer: "文字回答。" } });
  });

  it("interrupts synchronously and ignores stale deltas, delegation and finalizers", async () => {
    const t = setup();
    const first = t.session.send("第一句", "req_first001");
    t.requests[0].event({ type: "delta", text: "部分回答" });
    const second = t.session.send("插話", "req_second01");
    expect(t.requests[0].signal.aborted).toBe(true);
    expect(t.outputs[0].cancelled).toBe(true);
    expect(t.requests[1].messages[1].content).toContain("被使用者打斷");
    t.requests[0].event({ type: "delta", text: "舊內容" });
    t.requests[0].event({ type: "delegate", title: "舊任務" });
    t.requests[0].resolve();
    await first;
    expect(t.outputs[1].ended).toBe(false);
    expect(t.delegated).toEqual([]);
    t.finish(1, "新回答");
    await second;
    expect(t.session.view.reply).toMatchObject({ answer: "新回答", user: "插話" });
  });

  it("drops unanswered turns and errors rather than fabricating assistant history", async () => {
    const t = setup();
    const first = t.session.send("失敗問題", "req_error001");
    t.requests[0].event({ type: "error", message: "請重新登入", action: "chatgpt_sign_in" });
    t.requests[0].resolve();
    await first;
    expect(t.session.view.reply).toMatchObject({ kind: "error", action: "chatgpt_sign_in" });
    const second = t.session.send("重試", "req_retry001");
    expect(t.requests[1].messages).toEqual([{ role: "user", content: "重試" }]);
    t.finish(1, "成功");
    await second;
  });

  it("dismiss remains hidden after old asynchronous output", async () => {
    const t = setup();
    const pending = t.session.send("問題", "req_dismiss1");
    t.session.dismiss();
    t.requests[0].event({ type: "delta", text: "不能重新顯示" });
    t.requests[0].event({ type: "done", model: null });
    t.requests[0].resolve();
    await pending;
    expect(t.session.view.visible).toBe(false);
    expect(t.requests[0].signal.aborted).toBe(true);
  });

  it("provider reset aborts and removes old-account history", async () => {
    const t = setup();
    const first = t.session.send("帳號A", "req_account1");
    t.requests[0].event({ type: "delta", text: "私密內容" });
    t.session.reset();
    const second = t.session.send("帳號B", "req_account2");
    expect(t.requests[1].messages).toEqual([{ role: "user", content: "帳號B" }]);
    t.requests[0].resolve();
    await first;
    t.finish(1, "新內容");
    await second;
  });

  it("trims whole exchanges by serialized UTF8 bytes and caps history message lengths", async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) {
      const pending = t.session.send(`問題${i}` + "字".repeat(1800), `req_bytes00${i}`);
      const request = t.requests[i];
      expect(new TextEncoder().encode(JSON.stringify({ messages: request.messages, request_id: `req_bytes00${i}` })).length).toBeLessThan(16 * 1024);
      expect(request.messages.every((message) => message.content.length <= 4000)).toBe(true);
      expect(request.messages[0].role).toBe("user");
      t.finish(i, "答".repeat(4500));
      await pending;
    }
  });

  it("rejects an oversized current message visibly without starting transport", async () => {
    const t = setup();
    await t.session.send("字".repeat(4001), "req_oversize1");
    expect(t.requests).toHaveLength(0);
    expect(t.session.view).toMatchObject({ visible: true, reply: { kind: "error" } });
  });

  it("requires a terminal result even when an injected transport resolves early", async () => {
    const t = setup();
    const pending = t.session.send("問題", "req_terminal1");
    t.requests[0].event({ type: "delta", text: "不完整" });
    t.requests[0].resolve();
    await pending;
    expect(t.session.view.reply.kind).toBe("error");
    expect(t.outputs[0].cancelled).toBe(true);
  });
});
