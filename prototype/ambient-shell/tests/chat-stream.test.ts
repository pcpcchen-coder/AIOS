import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat, type ChatEvent } from "../src/api.ts";

afterEach(() => vi.unstubAllGlobals());

function response(chunks: string[], cancelled?: () => void): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    cancel: cancelled,
  }));
}

const frame = (event: ChatEvent) => `data: ${JSON.stringify(event)}\n\n`;

describe("chat stream transport", () => {
  it("consumes split UTF8 frames and requires a terminal done", async () => {
    const data = frame({ type: "delta", text: "你好" }) + frame({ type: "done", model: null });
    vi.stubGlobal("fetch", async () => response([data.slice(0, 12), data.slice(12)]));
    const events: ChatEvent[] = [];
    await streamChat([{ role: "user", content: "嗨" }], "req_stream01", (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: "delta", text: "你好" }, { type: "done", model: null }]);
  });

  it("normalizes CRLF even when CR and LF arrive in separate chunks", async () => {
    const data = frame({ type: "done", model: null }).replaceAll("\n", "\r\n");
    const split = data.indexOf("\r") + 1;
    vi.stubGlobal("fetch", async () => response([data.slice(0, split), data.slice(split)]));
    const events: ChatEvent[] = [];
    await streamChat([{ role: "user", content: "嗨" }], "req_stream02", (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: "done", model: null }]);
  });

  it("does not treat premature EOF as completed conversation", async () => {
    vi.stubGlobal("fetch", async () => response([frame({ type: "delta", text: "半個回覆" })]));
    await expect(streamChat([{ role: "user", content: "嗨" }], "req_stream03", () => {}, new AbortController().signal)).rejects.toThrow(/未收到完成確認/);
  });

  it("accepts terminal provider error without fabricating done", async () => {
    vi.stubGlobal("fetch", async () => response([frame({ type: "error", message: "登入失效", action: "chatgpt_sign_in" })]));
    const events: ChatEvent[] = [];
    await streamChat([{ role: "user", content: "嗨" }], "req_stream04", (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: "error", message: "登入失效", action: "chatgpt_sign_in" }]);
  });
});
