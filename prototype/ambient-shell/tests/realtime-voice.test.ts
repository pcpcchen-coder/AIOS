import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeVoice, type ApprovalOutcome, type ApprovalRequest, type HomeResult, type RealtimeDeps, type RealtimePhase } from "../src/realtime.ts";
import type { HomeControlArgs } from "../src/api.ts";
import { homeControlLine, type HomeControlResult } from "../shared/home.ts";

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

interface HomeFixture {
  /** home_control 的回傳；預設是已確認。 */
  control?: (args: HomeControlArgs) => HomeResult;
  /** 確認卡答案的回傳；預設同意＝已確認、不同意＝declined。可回傳 Promise 模擬執行中。 */
  confirm?: (id: string, approve: boolean) => HomeResult | Promise<HomeResult>;
}

const CONFIRMED: HomeResult = { ok: true, status: "confirmed", device: "客廳主燈", room: "客廳", action: "關閉", message: "設備回讀已確認（fixture）" };

function setup(overrides: Partial<RealtimeDeps> = {}, home: HomeFixture = {}) {
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
  const approvals: ApprovalRequest[] = [];
  /** 每張確認卡出現時，資料通道已送出幾個事件（檢查卡片比工具結果先排好）。 */
  const promptedAt: number[] = [];
  /** 每張確認卡的倒數終點（毫秒）。 */
  const expiries: number[] = [];
  const homeControls: HomeControlArgs[] = [];
  const homeConfirms: { id: string; approve: boolean }[] = [];
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
      onHomeControl: async (args) => {
        homeControls.push(args);
        return home.control?.(args) ?? CONFIRMED;
      },
      onHomeConfirm: async (id, approve) => {
        homeConfirms.push({ id, approve });
        return home.confirm
          ? home.confirm(id, approve)
          : approve
            ? CONFIRMED
            : { ok: true, status: "refused", reason: "declined", message: "沒有確認，書房燈關閉沒有執行。（fixture）", device: "書房燈", room: "書房" };
      },
      onApprovalPrompt: (request, expiresAt) => {
        approvals.push(request);
        expiries.push(expiresAt);
        promptedAt.push(peer.channel.sent.length);
      },
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
  return { voice, peer, ch, track, phases, user, assistant, delegated, closed, exchanged, searched, homeQueries, homeControls, homeConfirms, approvals, promptedAt, expiries, resolved, activity, sentTypes, userSays, modelSpeaks };
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

describe("RealtimeVoice home_control", () => {
  const NEEDS: HomeResult = { ok: true, status: "needs_confirmation", confirm_id: "home_c1", device: "書房燈", room: "書房", action: "關閉", expires_in_s: 60 };
  const outputs = (t: ReturnType<typeof setup>) =>
    t.ch.sent.filter((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output").map((e) => JSON.parse(String((e.item as { output: string }).output)));
  const notices = (t: ReturnType<typeof setup>) =>
    t.ch.sent
      .map((e) => (e.item as { role?: string; content?: { text?: string }[] } | undefined))
      .filter((item) => item?.role === "user" && item.content?.[0]?.text?.startsWith("（系統通知）"))
      .map((item) => item!.content![0].text!);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** 模型說「好，我請中控處理」並呼叫 home_control（照實際順序：這輪回應先結束，工具結果稍後才交回）。 */
  async function callControl(t: ReturnType<typeof setup>, args: Record<string, unknown>) {
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "home_control", call_id: "hc", arguments: JSON.stringify(args) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await flush();
  }

  it("allow: the local core runs the command, the real result goes back to the model, then it speaks", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.userSays("客廳主燈關掉");
    await callControl(t, { target: "客廳主燈", command: "power", value: "false" });
    expect(t.homeControls).toEqual([{ target: "客廳主燈", command: "power", value: "false" }]);
    expect(outputs(t)).toEqual([CONFIRMED]);
    expect(t.sentTypes().at(-1)).toBe("response.create");
    expect(t.approvals).toEqual([]);
  });

  it("H1b: an AIFA ac_temperature call and its one_way result go straight through to the model (fixture), like any other command", async () => {
    const ONE_WAY: HomeResult = {
      ok: true,
      status: "unconfirmed",
      why: "one_way",
      device: "冷氣",
      room: "客廳",
      action: "設定 26 度",
      message: "已透過 AIFA 連線送出；控制器狀態不代表冷氣實際反應，請現場確認（fixture）",
      sent_settings: "冷氣、26 度、風量低、擺風自動",
    };
    const t = setup({}, { control: () => ONE_WAY });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.userSays("冷氣調 26 度");
    await callControl(t, { target: "冷氣", command: "ac_temperature", value: "26" });
    expect(t.homeControls).toEqual([{ target: "冷氣", command: "ac_temperature", value: "26" }]);
    expect(outputs(t)).toEqual([ONE_WAY]);
    expect(t.sentTypes().at(-1)).toBe("response.create");
    expect(homeControlLine(ONE_WAY as HomeControlResult)).toBe("⏳ 客廳 冷氣 設定 26 度：已送出，請確認");
  });

  it("missing target or command is reported to the model without calling the core", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "客廳主燈" });
    expect(t.homeControls).toEqual([]);
    expect(outputs(t)).toEqual([{ ok: false, error: "缺少要控制的設備或動作" }]);
  });

  it("needs_confirmation: the card is queued before the result goes back, no MCP notice, and the model is still asked to speak", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    expect(t.approvals).toEqual([{ kind: "home", id: "home_c1", device: "書房燈", room: "書房", action: "關閉", expiresAt: Date.now() + 60_000 }]);
    const outputIndex = t.ch.sent.findIndex((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output");
    expect(t.promptedAt[0]).toBeLessThanOrEqual(outputIndex);
    expect(JSON.stringify(t.ch.sent)).not.toContain("外部服務");
    // 家電卡不佔 MCP 的計數：工具結果交回後照樣請模型說話（請使用者確認）。
    expect(t.sentTypes().at(-1)).toBe("response.create");
    expect(t.voice.pendingApproval).toMatchObject({ kind: "home", id: "home_c1" });
  });

  it("saying 確認執行 sends the answer to the local core, never to OpenAI, and the result arrives as one notice after the reply", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.modelSpeaks("要關書房燈，確定的話請說確認執行。");

    t.userSays("好");
    expect(t.homeConfirms).toEqual([]);

    const before = t.sentTypes().filter((x) => x === "response.create").length;
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "確認執行。" });
    await flush();
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: true }]);
    expect(t.resolved).toEqual([{ id: "home_c1", approved: true, outcome: "said_approve" }]);
    expect(t.ch.sent.some((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response")).toBe(false);
    // 自動回應還在進行：通知排隊，等這輪結束才送，且只送一次 response.create。
    expect(notices(t)).toEqual([]);
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    expect(notices(t)).toEqual(["（系統通知）客廳主燈「關閉」已由設備回讀確認。"]);
    expect(t.sentTypes().filter((x) => x === "response.create").length).toBe(before + 1);
  });

  it("「確認執行停止播放」 counts as a rejection because it contains 停止", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.userSays("確認執行停止播放");
    await flush();
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
  });

  it("saying 取消 tells the core and adds context without forcing another reply", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.modelSpeaks("要關書房燈嗎？");
    const before = t.sentTypes().filter((x) => x === "response.create").length;
    t.userSays("取消");
    await flush();
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
    expect(t.resolved).toEqual([{ id: "home_c1", approved: false, outcome: "said_reject" }]);
    expect(notices(t)).toEqual([]);
    expect(JSON.stringify(t.ch.sent.at(-1))).toContain("沒有執行");
    expect(t.sentTypes().filter((x) => x === "response.create").length).toBe(before);
  });

  it("timeout and a dismissed card tell the core and the model that nothing ran; closing only tells the core", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.modelSpeaks("要關書房燈嗎？請說確認執行或取消。");
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(t.resolved).toEqual([{ id: "home_c1", approved: false, outcome: "timeout" }]);
    expect(notices(t)).toEqual(["（系統通知）家電指令沒有執行：沒有確認，書房燈關閉沒有執行。（fixture）"]);

    t.modelSpeaks("好，沒有關。");
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.voice.resolveApproval(false, "dismissed");
    await flush();
    expect(t.homeConfirms.map((c) => c.approve)).toEqual([false, false]);

    await callControl(t, { target: "書房燈", command: "power", value: false });
    const sent = t.ch.sent.length;
    t.voice.stop();
    await flush();
    expect(t.resolved.at(-1)).toEqual({ id: "home_c1", approved: false, outcome: "closed" });
    expect(t.homeConfirms).toHaveLength(3);
    expect(t.ch.sent.length).toBe(sent);
  });

  it("a home card is never queued behind another card: the core drops it and the model hears busy", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "apr_m", server_label: "mail", name: "send", arguments: "{}" } });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    expect(t.approvals.map((a) => a.id)).toEqual(["apr_m"]);
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
    expect(outputs(t)).toEqual([expect.objectContaining({ ok: true, status: "busy", device: "書房燈", action: "關閉" })]);
    expect(t.activity.at(-1)).toContain("另一張確認卡還開著");
    // 說出的「確認執行」只回答 MCP 那張卡，不會把家電指令一起確認。
    t.userSays("確認執行");
    await flush();
    expect(t.ch.sent.filter((e) => (e.item as { type?: string } | undefined)?.type === "mcp_approval_response")).toHaveLength(1);
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
    expect(t.voice.pendingApproval).toBeNull();

    // 卡處理完之後再說一次：照常排出家電卡。
    await callControl(t, { target: "書房燈", command: "power", value: false });
    expect(t.approvals.map((a) => a.id)).toEqual(["apr_m", "home_c1"]);
    t.userSays("確認執行");
    await flush();
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }, { id: "home_c1", approve: true }]);
  });

  it("a second home card while one is open is also busy", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    await callControl(t, { target: "書房燈", command: "power", value: true });
    expect(t.approvals).toHaveLength(1);
    expect(outputs(t).map((o) => o.status)).toEqual(["needs_confirmation", "busy"]);
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
  });

  it("an MCP card that arrives while a home card is open waits, and asks the model to explain it when it surfaces", async () => {
    const t = setup({}, { control: () => NEEDS });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.modelSpeaks("要關書房燈嗎？");
    t.ch.emit({ type: "conversation.item.done", item: { type: "mcp_approval_request", id: "apr_m", server_label: "mail", name: "send", arguments: "{}" } });
    expect(t.approvals.map((a) => a.id)).toEqual(["home_c1"]);
    expect(JSON.stringify(t.ch.sent)).not.toContain("外部服務「mail」");
    t.userSays("取消");
    await flush();
    expect(t.homeConfirms).toEqual([{ id: "home_c1", approve: false }]);
    expect(t.approvals.map((a) => a.id)).toEqual(["home_c1", "apr_m"]);
    t.modelSpeaks("好，沒有關。");
    expect(notices(t).some((n) => n.includes("外部服務「mail」要執行「send」"))).toBe(true);
  });

  it("the home card never outlives the server's confirm id", async () => {
    const t = setup({}, { control: () => ({ ...NEEDS, expires_in_s: 20 }) });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    expect(t.expiries).toEqual([Date.now() + 20_000]);
    vi.advanceTimersByTime(19_999);
    expect(t.resolved).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.resolved).toEqual([{ id: "home_c1", approved: false, outcome: "timeout" }]);

    // 伺服器給的期限比 60 秒長時，仍是 60 秒。
    const u = setup({}, { control: () => ({ ...NEEDS, expires_in_s: 90 }) });
    await u.voice.start();
    u.ch.emit({ type: "session.created" });
    await callControl(u, { target: "書房燈", command: "power", value: false });
    expect(u.expiries).toEqual([Date.now() + 60_000]);
  });

  it("a home result is spoken without waiting for an MCP call that is still running", async () => {
    const t = setup();
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.mcp_call.in_progress" });
    t.ch.emit({ type: "response.function_call_arguments.done", name: "home_control", call_id: "hc", arguments: JSON.stringify({ target: "客廳主燈", command: "power", value: false }) });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    await flush();
    expect(outputs(t)).toEqual([CONFIRMED]);
    expect(t.sentTypes().filter((x) => x === "response.create")).toHaveLength(1);
    // MCP 之後才結束：它自己再接著回應一次。
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    t.ch.emit({ type: "response.output_item.done", item: { type: "mcp_call", server_label: "calendar", name: "list_events" } });
    expect(t.sentTypes().filter((x) => x === "response.create")).toHaveLength(2);
  });

  it("holds the idle timer while a confirmed command is still running, and drops its result after the session ends", async () => {
    let finish: (r: HomeResult) => void = () => {};
    const t = setup({}, { control: () => NEEDS, confirm: (_id, approve) => (approve ? new Promise<HomeResult>((r) => (finish = r)) : CONFIRMED) });
    await t.voice.start();
    t.ch.emit({ type: "session.created" });
    await callControl(t, { target: "書房燈", command: "power", value: false });
    t.modelSpeaks("要關書房燈嗎？");
    t.userSays("確認執行");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    vi.advanceTimersByTime(130_000);
    expect(t.closed).toEqual([]);
    finish(CONFIRMED);
    await flush();
    expect(notices(t).at(-1)).toContain("已由設備回讀確認");
    t.ch.emit({ type: "response.created" });
    t.ch.emit({ type: "response.done", response: { status: "completed" } });
    vi.advanceTimersByTime(121_000);
    expect(t.closed).toHaveLength(1);

    // 另一次對話：執行中就結束，晚到的結果不再通知（字幕由 main.ts 顯示）。
    const u = setup({}, { control: () => NEEDS, confirm: (_id, approve) => (approve ? new Promise<HomeResult>((r) => (finish = r)) : CONFIRMED) });
    await u.voice.start();
    u.ch.emit({ type: "session.created" });
    await callControl(u, { target: "書房燈", command: "power", value: false });
    u.userSays("確認執行");
    u.voice.stop();
    const sent = u.ch.sent.length;
    finish(CONFIRMED);
    await flush();
    expect(u.ch.sent.length).toBe(sent);
  });
});
