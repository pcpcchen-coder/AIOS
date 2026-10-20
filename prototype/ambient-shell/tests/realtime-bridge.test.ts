import { describe, expect, it } from "vitest";
import { buildRealtimeInstructions, RealtimeBridge, RealtimeError } from "../server/realtime.ts";
import { makeTask } from "./fixtures.ts";

type Call = { url: string; init: RequestInit };

function fakeOpenAI(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("RealtimeBridge", () => {
  it("mints a short-lived secret with the API key, then forwards the SDP offer with that secret only", async () => {
    const api = fakeOpenAI([
      new Response(JSON.stringify({ value: "ek_fixture", expires_at: 1 }), { status: 200 }),
      new Response("v=0 answer", { status: 201 }),
    ]);
    const bridge = new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: api.fetch });
    const result = await bridge.connect("v=0 offer", [makeTask({ title: "寫週報", status: "running" })]);
    expect(result).toEqual({ sdp: "v=0 answer", model: "gpt-realtime" });

    const [mint, call] = api.calls;
    expect(mint.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((mint.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-fixture");
    const session = JSON.parse(String(mint.init.body)).session;
    expect(session).toMatchObject({ type: "realtime", model: "gpt-realtime", audio: { output: { voice: "marin" }, input: { turn_detection: { type: "semantic_vad" } } } });
    expect(session.tools.map((t: { name: string }) => t.name)).toEqual(["delegate_task", "get_tasks", "end_conversation"]);
    expect(session.instructions).toContain("「寫週報」：進行中");

    expect(call.url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer ek_fixture");
    expect(call.init.body).toBe("v=0 offer");
    expect(JSON.stringify(call.init)).not.toContain("sk-fixture");
  });

  it("is unavailable without OPENAI_API_KEY and says where to set it", async () => {
    const bridge = new RealtimeBridge({ apiKey: null, model: "gpt-realtime", voice: "marin" });
    expect(bridge.info()).toMatchObject({ available: false, detail: expect.stringContaining("OPENAI_API_KEY") });
    await expect(bridge.connect("v=0", [])).rejects.toBeInstanceOf(RealtimeError);
  });

  it("explains an invalid key (401) and quota errors (429) in plain language", async () => {
    const unauthorized = fakeOpenAI([new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })]);
    const bad = new RealtimeBridge({ apiKey: "sk-bad", model: "gpt-realtime", voice: "marin", fetch: unauthorized.fetch });
    await expect(bad.connect("v=0", [])).rejects.toThrow(/OPENAI_API_KEY 無效/);

    const limited = fakeOpenAI([new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })]);
    const broke = new RealtimeBridge({ apiKey: "sk-x", model: "gpt-realtime", voice: "marin", fetch: limited.fetch });
    await expect(broke.connect("v=0", [])).rejects.toThrow(/429/);
  });

  it("instructions ask for Traditional Chinese, tool-based delegation and honest progress", () => {
    const text = buildRealtimeInstructions([]);
    expect(text).toContain("繁體中文");
    expect(text).toContain("delegate_task");
    expect(text).toContain("get_tasks");
    expect(text).toContain("目前沒有交辦的任務");
  });
});
