import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoice, type ApprovalOutcome, type McpApprovalRequest, type RealtimeDeps, type RealtimePhase } from "../src/realtime.ts";

// 模擬 WebRTC：資料通道收發 OpenAI Realtime 事件，不需要麥克風、喇叭或網路。
class FakeChannel {
  readyState = "open";
  sent: Record<string, unknown>[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

class FakePeer {
  channel = new FakeChannel();
  connectionState = "new";
  remote: unknown = null;
  tracks = 0;
  closed = false;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() { this.tracks += 1; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 fake-offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(desc: unknown) { this.remote = desc; }
  close() { this.closed = true; }
}

function setup(overrides: Partial<RealtimeDeps> = {}) {
  vi.useFakeTimers();
  const peer = new FakePeer();
  const track = { stop: vi.fn() };
  const phases: RealtimePhase[] = [];
  const user: string[] = [];
  const assistant: string[] = [];
  const delegated: string[] = [];
  const closed: string[] = [];
  const exchanged: string[] = [];
  const searched: string[] = [];
  const homeQueries: { target: string; metric: string | null }[] = [];
  const approvals: McpApprovalRequest[] = [];
  const resolved: { id: string; approved: boolean; outcome: ApprovalOutcome }[] = [];
  const activity: string[] = [];
  const voice = new RealtimeVoice(
    {
      onPhase: (p) => phases.push(p),
      onUserTranscript: (t) => user.push(t),
      onAssistantTranscript: (t) => assistant.push(t),
      onDelegate: async (title) => {
        delegated.push(title);
        return { ok: true, title, status: "running" };
      },
      onGetTasks: async () => ({ ok: true, tasks: delegated.map((title) => ({ title, status: "running" })) }),
      onClosed: (r) => closed.push(r),
      onWebSearch: async (query) => {
        searched.push(query);
        return { ok: true, answer: "新竹今天多雲，22 到 27 度（fixture）", sources: ["fixture 氣象站"] };
      },
      onHomeStatus: async (target, metric) => {
        homeQueries.push({ target, metric });
        return { ok: true, status: "ok", scope: "客廳", devices: [{ device: "溫濕度計", readings: [{ name: "溫度", value: 26.5, unit: "°C" }] }] };
      },
      onApprovalPrompt: (request) => approvals.push(request),
      onApprovalResolved: (request, approved, outcome) => resolved.push({ id: request.id, approved, outcome }),
      onToolActivity: (text) => activity.push(text),
    },
    {
      getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      playRemote: () => () => {},
      exchange: async (sdp) => {
        exchanged.push(sdp);
        return "v=0 fake-answer";
      },
      ...overrides,
    },
    { idleMs: 120_000, approvalMs: 60_000 },
  );
  const ch = peer.channel;
  const sentTypes = () => ch.sent.map((e) => e.type);
  /** 使用者說一句話、模型用語音回答（伺服器 VAD 的完整事件順序）。 */
  function userSays(text: string) {
    ch.emit({ type: "input_audio_buffer.speech_started" });
    ch.emit({ type: "input_audio_buffer.speech_stopped" });
    ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: text });
  }
  function modelSpeaks(text: string) {
    ch.emit({ type: "response.created" });
    ch.emit({ type: "output_audio_buffer.started" });
    ch.emit({ type: "response.output_audio_transcript.done", transcript: text });
    ch.emit({ type: "response.done", response: { status: "completed" } });
    ch.emit({ type: "output_audio_buffer.stopped" });
  }
  return { voice, peer, ch, track, phases, user, assistant, delegated, closed, exchanged, searched, homeQueries, approvals, resolved, activity, sentTypes, userSays, modelSpeaks };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RealtimeVoice", () => {
  it("connects through the local core: mic track + data channel, SDP offer exchanged for the answer", async () => {
    const t = setup();
    await t.voice.start();
    expect(t.peer.tracks).toBe(1);
    expect(t.exchanged).toEqual(["v=0 fake-offer"]);
    expect(t.peer.remote).toEqual({ type: "answer", sdp: "v=0 fake-answer" });
    expect(t.voice.current).toBe("connecting");
    t.ch.emit({ type: "session.created" });
    expect(t.voice.current).toBe("listening");
    expect(t.voice.capturing).toBe(true);
  });

  it("keeps a continuous 5-round voice conversation: chat, delegate, barge-in, progress, goodbye", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });

    // 第 1 輪：一般聊天
    t.userSays("你好");
    expect(t.voice.current).toBe("thinking");
    t.modelSpeaks("嗨，有什麼我可以幫你？");
    expect(t.voice.current).toBe("listening");

    // 第 2 輪：交辦工作 → 工具結果交回 → 請模型接著說
    t.userSays("幫我寫一份專案進度報告");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_1", arguments: JSON.stringify({ title: "撰寫專案進度報告" }) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(t.sentTypes()).toContain("response.create"));
    expect(t.delegated).toEqual(["撰寫專案進度報告"]);
    const output = t.ch.sent.find((e) => e.type === "conversation.item.create") as { item: { call_id: string; output: string } };
    expect(output.item.call_id).toBe("call_1");
    expect(JSON.parse(output.item.output)).toMatchObject({ ok: true, status: "running" });
    t.modelSpeaks("好，我已經開始寫了，進度會顯示在畫面上。");

    // 第 3 輪：再交辦一件，模型說話時使用者插話（伺服器截斷播放）
    t.userSays("再幫我整理會議紀錄");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_2", arguments: JSON.stringify({ title: "整理會議紀錄" }) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(t.delegated).toHaveLength(2));
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "output_audio_buffer.started" });
    expect(t.voice.current).toBe("speaking");
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    expect(t.voice.current).toBe("hearing");
    t.ch.emit({ type: "output_audio_buffer.cleared" });
    t.ch.emit({ type: "response.done", response: { status: "cancelled" } });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "等一下，先告訴我進度" });

    // 第 4 輪：查進度（真實狀態由 get_tasks 提供）
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "get_tasks", call_id: "call_3", arguments: "{}" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => {
      const out = t.ch.sent.filter((e) => e.type === "conversation.item.create").at(-1) as { item: { call_id: string; output: string } };
      expect(out.item.call_id).toBe("call_3");
      expect(JSON.parse(out.item.output).tasks).toHaveLength(2);
    });
    t.modelSpeaks("兩件工作都在進行中。");

    // 第 5 輪：道別 → 念完就結束
    t.userSays("好，先這樣，再見");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "output_audio_buffer.started" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "end_conversation", call_id: "call_4", arguments: "{}" });
    const creates = t.sentTypes().filter((type) => type === "response.create").length;
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    expect(t.voice.on).toBe(true);
    t.ch.emit({ type: "output_audio_buffer.stopped" });
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual(["對話已結束。"]);
    expect(t.sentTypes().filter((type) => type === "response.create").length).toBe(creates);

    expect(t.user).toEqual(["你好", "幫我寫一份專案進度報告", "再幫我整理會議紀錄", "等一下，先告訴我進度", "好，先這樣，再見"]);
    expect(t.assistant).toEqual(["嗨，有什麼我可以幫你？", "好，我已經開始寫了，進度會顯示在畫面上。", "兩件工作都在進行中。"]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(t.peer.closed).toBe(true);
  });

  it("holds system notices until the current reply finishes", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    t.voice.notify("撰寫專案進度報告完成了");
    expect(t.sentTypes()).toEqual([]);
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    expect(t.sentTypes()).toEqual(["conversation.item.create", "response.create"]);
    const item = t.ch.sent[0] as { item: { content: { text: string }[] } };
    expect(item.item.content[0].text).toContain("（系統通知）撰寫專案進度報告完成了");
  });

  it("several tasks finishing at once are announced one reply at a time (no overlapping responses)", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.voice.notify("報告完成了");
    t.voice.notify("會議紀錄完成了");
    t.voice.notify("行程規劃完成了");
    expect(t.sentTypes().filter((type) => type === "response.create")).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      t.ch.emit({ type: "response.created" });
      t.ch.emit({ type: "response.done", response: { status: "completed" } });
    }
    expect(t.sentTypes().filter((type) => type === "response.create")).toHaveLength(3);
    const texts = t.ch.sent.filter((e) => e.type === "conversation.item.create").map((e) => (e as { item: { content: { text: string }[] } }).item.content[0].text);
    expect(texts).toEqual(["（系統通知）報告完成了", "（系統通知）會議紀錄完成了", "（系統通知）行程規劃完成了"]);
  });

  it("a rejected response request does not leave the session stuck", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.voice.notify("第一則");
    t.voice.notify("第二則");
    t.ch.emit({ type: "error", error: { code: "conversation_already_has_active_response", message: "busy" } });
    expect(t.sentTypes().filter((type) => type === "response.create")).toHaveLength(2);
  });

  it("ignores late events from a session that already ended", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.voice.stop();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "late", arguments: JSON.stringify({ title: "不該建立" }) });
    await Promise.resolve();
    expect(t.voice.on).toBe(false);
    expect(t.delegated).toEqual([]);
    expect(t.phases.at(-1)).toBe("off");
  });

  it("typed text joins the same live conversation", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.voice.sendText("幫我規劃下週行程");
    expect(t.sentTypes()).toEqual(["conversation.item.create", "response.create"]);
  });

  it("Esc interrupts playback without ending the session", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "output_audio_buffer.started" });
    t.voice.interrupt();
    expect(t.sentTypes()).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(t.voice.current).toBe("listening");
    expect(t.voice.on).toBe(true);
  });

  it("closes after idling so a forgotten session does not keep billing", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    vi.advanceTimersByTime(120_001);
    expect(t.voice.on).toBe(false);
    expect(t.closed[0]).toContain("沒有說話");
  });

  it("reports a denied microphone and stays off", async () => {
    const t = setup({ getMicrophone: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    await t.voice.start();
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual(["麥克風權限被拒絕，無法使用即時語音。"]);
  });

  it("surfaces a failed connection (for example an invalid API key) and releases the microphone", async () => {
    const t = setup({ exchange: async () => { throw new Error("連線即時語音失敗：OPENAI_API_KEY 無效或未授權（401）。"); } });
    await t.voice.start();
    expect(t.voice.on).toBe(false);
    expect(t.closed[0]).toContain("401");
    expect(t.track.stop).toHaveBeenCalled();
  });
});

describe("RealtimeVoice tools", () => {
  it("web_search: queries through the local core, returns the answer to the model, then asks it to speak", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.userSays("新竹今天天氣如何");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "web_search", call_id: "c1", arguments: JSON.stringify({ query: "新竹市今天天氣" }) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(t.searched).toEqual(["新竹市今天天氣"]);
    expect(t.activity).toContain("上網查詢：新竹市今天天氣");
    const output = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output");
    expect(JSON.parse(String((output!.item as { output: string }).output))).toMatchObject({ ok: true, answer: expect.stringContaining("新竹") });
    expect(t.sentTypes().at(-1)).toBe("response.create");
  });

  it("home_status: asks the local core for real readings and hands them to the model", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.userSays("客廳現在幾度");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "home_status", call_id: "h1", arguments: JSON.stringify({ target: "客廳", metric: "temperature" }) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(t.homeQueries).toEqual([{ target: "客廳", metric: "temperature" }]);
    expect(t.activity).toContain("查詢家裡：客廳");
    const output = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output");
    expect(JSON.parse(String((output!.item as { output: string }).output))).toMatchObject({ status: "ok", devices: [{ readings: [{ value: 26.5 }] }] });
    expect(t.sentTypes().at(-1)).toBe("response.create");
  });

  it("home_status without a target reports the error to the model instead of querying", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "home_status", call_id: "h2", arguments: "{}" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await vi.runAllTicks();
    await Promise.resolve();

    expect(t.homeQueries).toEqual([]);
    const output = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output");
    expect(JSON.parse(String((output!.item as { output: string }).output))).toEqual({ ok: false, error: "缺少要查的房間或設備" });
  });

  it("MCP approval by voice: shows the card, asks the model to explain, approves only on the fixed phrase", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    const item = { type: "mcp_approval_request", id: "apr_1", server_label: "mail", name: "send_email", arguments: "{\"to\":\"王經理\"}" };
    t.ch.emit({ type: "conversation.item.added", item });
    t.ch.emit({ type: "conversation.item.done", item });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });

    expect(t.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    // 回應結束後請模型用一句話說明確認卡，但還不能接著執行。
    const notice = t.ch.sent.find((e) => JSON.stringify(e).includes("確認執行"));
    expect(notice).toBeTruthy();
    t.modelSpeaks("要寄信給王經理，確定的話請說確認執行。");

    // 「好」不算確認。
    t.userSays("好");
    expect(t.resolved).toEqual([]);
    expect(t.ch.sent.some((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response")).toBe(false);

    // 實際順序：說完後伺服器 VAD 先建立自動回應，轉錄稍後才到。
    const before = t.sentTypes().filter((x) => x === "response.create").length;
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "確認執行。" });
    expect(t.resolved).toEqual([{ id: "apr_1", approved: true, outcome: "said_approve" }]);
    const response = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response");
    expect(response!.item).toMatchObject({ id: "mcp_approval_apr_1", approval_request_id: "apr_1", approve: true });
    // 自動回應還在進行：不重疊送出 response.create，等它結束才接著回應一次。
    expect(t.sentTypes().filter((x) => x === "response.create").length).toBe(before);
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    expect(t.sentTypes().filter((x) => x === "response.create").length).toBe(before + 1);
  });

  it("MCP approval: saying 取消 rejects with a reason", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "apr_2", server_label: "mail", name: "send", arguments: "{}" } });
    t.userSays("不要，取消");
    const response = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response");
    expect(response!.item).toMatchObject({ approval_request_id: "apr_2", approve: false, reason: "使用者說取消" });
    expect(t.resolved).toEqual([{ id: "apr_2", approved: false, outcome: "said_reject" }]);
  });

  it("MCP approval: no answer within the time limit rejects automatically", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "apr_3", server_label: "cms", name: "publish", arguments: "{}" } });
    vi.advanceTimersByTime(60_000);
    expect(t.resolved).toEqual([{ id: "apr_3", approved: false, outcome: "timeout" }]);
    const response = t.ch.sent.find((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response");
    expect(response!.item).toMatchObject({ approve: false });
  });

  it("MCP approval: dismissing the card and closing the session both reject", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "a", server_label: "s", name: "x", arguments: "{}" } });
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "b", server_label: "s", name: "y", arguments: "{}" } });
    expect(t.approvals.map((a) => a.id)).toEqual(["a"]);
    t.voice.resolveApproval(false, "dismissed");
    expect(t.approvals.map((a) => a.id)).toEqual(["a", "b"]);
    t.voice.stop();
    expect(t.resolved).toEqual([
      { id: "a", approved: false, outcome: "dismissed" },
      { id: "b", approved: false, outcome: "closed" },
    ]);
  });

  it("MCP call finishing after response.done triggers one follow-up response", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.mcp_call.in_progress" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    expect(t.sentTypes().filter((x) => x === "response.create")).toHaveLength(0);
    t.ch.emit({ type: "response.output_item.done", item: { type: "mcp_call", server_label: "calendar", name: "list_events" } });
    expect(t.sentTypes().filter((x) => x === "response.create")).toHaveLength(1);
    expect(t.activity).toContain("已使用 calendar：list_events");
  });
});
