import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCall, LiveCoreEvent } from "../shared/realtime-route.ts";
import type { Task } from "../shared/types.ts";
import { classify } from "../src/intent.ts";
import { LiveVoice, LOCAL_COMMAND_DRAIN_MS, LOCAL_COMMAND_QUIET_MS, type LiveDeps } from "../src/live-voice.ts";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { RealtimeVoice, type HomeResult, type RealtimeCallbacks, type RealtimePhase } from "../src/realtime.ts";
import { matchCameraCommand } from "../src/sense/controller.ts";
import { initialShell, reduceShell, type ShellEvent, type ShellState } from "../src/shell-state.ts";
import { AssistantEcho, foldVoice, matchVoiceCommand, NO_RESULT_NOTICE, RealtimeLocalCommands } from "../src/voice-command.ts";
import { makeTask } from "./fixtures.ts";

// HIST-1 Mac F1：即時語音中說出的本機畫面指令（兩條路徑）。全部是 fixture：假的 WebRTC 資料通道與假的核心，
// 不需要麥克風、喇叭或網路；任務與成果是虛構資料。

/** 和 src/main.ts 同一組接線：userRequest 登記 id、dispatch 經 reduceShell，畫面以 Presentation Policy 檢查。 */
function shellHarness(tasks: Task[] = []) {
  let shell: ShellState = initialShell;
  let seq = 0;
  const userRequestIds = new Set<string>();
  const historyQueries: string[] = [];
  const taskMap = new Map(tasks.map((t) => [t.task_id, t]));
  const dispatch = (event: ShellEvent) => {
    shell = reduceShell(shell, event);
  };
  const commands = new RealtimeLocalCommands({
    userRequest: () => {
      const id = `req_voice_${++seq}`;
      userRequestIds.add(id);
      return id;
    },
    dispatch,
    openHistory: (requestId, query) => {
      historyQueries.push(query);
      dispatch({ type: "show.history", request_id: requestId });
    },
    latestArtifact: () => {
      const task = [...taskMap.values()].find((t) => t.status === "succeeded" && t.artifact_id);
      return task?.artifact_id ? { task_id: task.task_id, artifact_id: task.artifact_id } : null;
    },
    confirmOpen: () => shell.surface?.kind === "confirm",
  });
  const user: string[] = [];
  /** 顯示成字幕的助理逐字稿。 */
  const shown: string[] = [];
  const prompts: string[] = [];
  /** 和 src/main.ts 一樣：onPhase 也交給回音判斷。 */
  const callbacks = (onPhase: (p: RealtimePhase) => void = () => {}): RealtimeCallbacks => ({
    onPhase: (p) => {
      commands.notePhase(p);
      onPhase(p);
    },
    onAssistantPartial: (text) => commands.noteAssistantPartial(text),
    onUserTranscript: (text) => void user.push(text),
    onLocalCommand: (text) => matchCameraCommand(text) === null && commands.handle(text) !== null,
    onAssistantTranscript: (text) => {
      shown.push(text);
      commands.noteAssistant(text);
    },
    onDelegate: async (title) => ({ ok: true, title, status: "running" }),
    onGetTasks: async () => ({ ok: true, tasks: [] }),
    onWebSearch: async () => ({ ok: true, answer: "fixture", sources: [] }),
    onHomeStatus: async () => ({ ok: true }),
    onHomeControl: async () => ({ ok: false, error: "fixture" }),
    onHomeConfirm: async () => ({ ok: false, error: "fixture" }),
    onApprovalPrompt: (request) => void prompts.push(request.id),
    onApprovalResolved: () => {},
    onToolActivity: () => {},
    onClosed: () => {},
  });
  return {
    callbacks,
    dispatch,
    user,
    shown,
    prompts,
    historyQueries,
    userRequestIds,
    get shell() {
      return shell;
    },
    /** 目前的 Surface 通過 Presentation Policy（user_request 對到真實的請求 id）。 */
    allowed: () => evaluateSurface(shell.surface, { userRequestIds, tasks: taskMap }).allowed,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const DONE = makeTask({ task_id: "task_fixture_done", title: "虛構的晚餐計畫", status: "succeeded", artifact_id: "artifact_fixture_1", finished_at: "2026-10-31T08:00:00Z" });

// ─────────────── API key 路徑（RealtimeVoice，資料通道就在頁面） ───────────────

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
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 fake-offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.closed = true; this.connectionState = "closed"; }
  connect() { this.connectionState = "connected"; this.onconnectionstatechange?.(); }
}

async function apiKeyRoute(tasks: Task[] = [], overrides: Partial<RealtimeCallbacks> = {}) {
  vi.useFakeTimers();
  const h = shellHarness(tasks);
  const peer = new FakePeer();
  const track = { stop: vi.fn(), readyState: "live" };
  const phases: RealtimePhase[] = [];
  const voice = new RealtimeVoice(
    { ...h.callbacks((p) => phases.push(p)), ...overrides },
    {
      getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      playRemote: () => () => {},
      exchange: async () => "v=0 fake-answer",
    },
    { idleMs: 120_000 },
  );
  await voice.start();
  const ch = peer.channel;
  ch.emit({ type: "session.created" });
  ch.sent.length = 0;
  /** 伺服器 VAD：開口、說完、上游自動建立回應（id），然後才到逐字稿（上游常見的順序）。 */
  const userSays = (text: string, responseId = "resp_1") => {
    ch.emit({ type: "input_audio_buffer.speech_started" });
    ch.emit({ type: "input_audio_buffer.speech_stopped" });
    ch.emit({ type: "response.created", response: { id: responseId } });
    ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: text });
  };
  const cancels = () => ch.sent.filter((e) => e.type === "response.cancel");
  return { h, voice, ch, phases, userSays, cancels };
}

describe("API key route: spoken local commands open views like typed input, and the model turn is cancelled", () => {
  it("simplified 「进度如何」 opens the progress card with user_request and cancels this turn's response", async () => {
    const t = await apiKeyRoute();
    t.userSays("进度如何");
    expect(t.h.shell.surface).toMatchObject({ kind: "progress", visibility_reason: "user_request" });
    expect(t.h.userRequestIds.has(t.h.shell.surface!.request_id)).toBe(true);
    expect(t.h.allowed()).toBe(true);
    // 只取消這一輪的回應（resp_1）。
    expect(t.cancels()).toEqual([{ type: "response.cancel", response_id: "resp_1" }]);
    expect(t.ch.sent.map((e) => e.type)).toContain("output_audio_buffer.clear");
    expect(t.voice.current).toBe("listening");
    // 取消前已產生的半句不顯示字幕；這一輪結束後沒有再請模型回應（沒有 response.create）。
    t.ch.emit({ type: "response.output_audio_transcript.done", response_id: "resp_1", transcript: "目前有兩個任務" });
    t.ch.emit({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
    expect(t.h.shown).toEqual([]);
    expect(t.ch.sent.filter((e) => e.type === "response.create")).toEqual([]);
  });

  it("when the transcript arrives before the response is created, the response is cancelled as soon as it is created", async () => {
    const t = await apiKeyRoute();
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "看结果" });
    expect(t.cancels()).toEqual([]);
    t.ch.emit({ type: "response.created", response: { id: "resp_late" } });
    expect(t.cancels()).toEqual([{ type: "response.cancel", response_id: "resp_late" }]);
  });

  it("a get_tasks call the model already made is answered, but nothing is spoken for that turn", async () => {
    const t = await apiKeyRoute();
    t.userSays("进度如何", "resp_tool");
    t.ch.emit({ type: "response.function_call_arguments.done", name: "get_tasks", call_id: "call_1", arguments: "{}", response_id: "resp_tool" });
    t.ch.emit({ type: "response.done", response: { id: "resp_tool", status: "cancelled" } });
    await vi.waitFor(() => expect(t.ch.sent.some((e) => e.type === "conversation.item.create")).toBe(true));
    expect(t.ch.sent.filter((e) => e.type === "response.create")).toEqual([]);
  });

  it("「看結果」 opens the latest result (or the same notice as typing when there is none)", async () => {
    const t = await apiKeyRoute([DONE]);
    t.userSays("看結果");
    expect(t.h.shell.surface).toMatchObject({ kind: "artifact", task_id: DONE.task_id, artifact_id: DONE.artifact_id, visibility_reason: "user_request" });
    expect(t.h.allowed()).toBe(true);
    const none = await apiKeyRoute();
    none.userSays("看结果");
    expect(none.h.shell.surface).toMatchObject({ kind: "notice", message: NO_RESULT_NOTICE });
    expect(none.h.allowed()).toBe(true);
  });

  it("「搜尋成果 晚餐」 opens results history with the query; a simplified transcript keeps its own characters", async () => {
    const t = await apiKeyRoute();
    t.userSays("搜尋成果 晚餐");
    expect(t.h.shell.surface).toMatchObject({ kind: "history", visibility_reason: "user_request" });
    expect(t.h.historyQueries).toEqual(["晚餐"]);
    expect(t.h.allowed()).toBe(true);
    t.userSays("搜索成果 晚饭", "resp_2");
    expect(t.h.historyQueries).toEqual(["晚餐", "晚饭"]);
    t.userSays("成果纪录", "resp_3");
    expect(t.h.historyQueries).toEqual(["晚餐", "晚饭", ""]);
    expect(t.cancels()).toHaveLength(3);
  });

  it("「收起」 only closes the view: the call keeps going and nothing is cancelled except this turn's reply", async () => {
    const t = await apiKeyRoute();
    t.userSays("进度如何");
    expect(t.h.shell.surface?.kind).toBe("progress");
    t.userSays("收起", "resp_2");
    expect(t.h.shell.surface).toBeNull();
    expect(t.voice.on).toBe(true);
    expect(t.voice.current).toBe("listening");
    expect(t.cancels()).toHaveLength(2);
    // 下一句一般的話照常由模型回答，字幕也照常。
    t.userSays("新竹今天會下雨嗎", "resp_3");
    t.ch.emit({ type: "response.output_audio_transcript.done", response_id: "resp_3", transcript: "新竹今天多雲" });
    expect(t.cancels()).toHaveLength(2);
    expect(t.h.shown).toEqual(["新竹今天多雲"]);
  });

  it("English equivalents work too", async () => {
    const t = await apiKeyRoute([DONE]);
    t.userSays("Show progress.");
    expect(t.h.shell.surface?.kind).toBe("progress");
    t.userSays("show results", "r2");
    expect(t.h.shell.surface?.kind).toBe("artifact");
    t.userSays("search past results for dinner", "r3");
    expect(t.h.historyQueries).toEqual(["dinner"]);
    t.userSays("close the view", "r4");
    expect(t.h.shell.surface).toBeNull();
    expect(t.cancels()).toHaveLength(4);
  });

  it("negatives: long sentences, ID-02 F3 noise, assistant transcripts and echo are left to the model", async () => {
    const t = await apiKeyRoute([DONE]);
    for (const [i, text] of ["我想知道那個報告的進度如何", "進度如何你幫我寫一份報告", "被談", "对。", "好了沒", "剛才那份", "先這樣", "比賽結果", "交通狀況如何", "停止任務"].entries()) {
      t.userSays(text, `resp_n${i}`);
    }
    t.ch.emit({ type: "response.output_audio_transcript.done", transcript: "進度如何" });
    expect(t.h.shell.surface).toBeNull();
    expect(t.h.userRequestIds.size).toBe(0);
    expect(t.cancels()).toEqual([]);
    // 回音：Nous 正在念「要我幫你看結果嗎」（助理整句還沒到，只有 delta），麥克風收到的「看结果」和播放重疊，不當指令。
    t.ch.emit({ type: "response.created", response: { id: "resp_speak" } });
    t.ch.emit({ type: "output_audio_buffer.started" });
    t.ch.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_speak", delta: "要我幫你看結" });
    t.ch.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_speak", delta: "果嗎？" });
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "看结果" });
    expect(t.h.shell.surface).toBeNull();
    expect(t.cancels()).toEqual([]);
  });

  it("M3: a command the model itself prompted is the user's own answer once playback has stopped", async () => {
    const t = await apiKeyRoute([DONE]);
    t.ch.emit({ type: "response.created", response: { id: "resp_q" } });
    t.ch.emit({ type: "output_audio_buffer.started" });
    t.ch.emit({ type: "response.output_audio_transcript.done", response_id: "resp_q", transcript: "要看結果嗎？" });
    t.ch.emit({ type: "response.done", response: { id: "resp_q" } });
    t.ch.emit({ type: "output_audio_buffer.stopped" });
    vi.advanceTimersByTime(2_000);
    t.userSays("看結果", "resp_a");
    expect(t.h.shell.surface?.kind).toBe("artifact");
    expect(t.cancels()).toEqual([{ type: "response.cancel", response_id: "resp_a" }]);
  });

  it("the typed path is unchanged: sendText never runs the spoken matcher", async () => {
    const t = await apiKeyRoute();
    t.voice.sendText("进度如何");
    expect(t.h.shell.surface).toBeNull();
    expect(t.ch.sent.map((e) => e.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(classify("进度如何")).toEqual({ kind: "task", text: "进度如何" });
    expect(classify("進度如何")).toEqual({ kind: "progress" });
  });
});

// ─────────────── ChatGPT 方案路徑（LiveVoice：資料通道＋核心轉送的 sideband 逐字稿） ───────────────

async function liveRoute(tasks: Task[] = [], overrides: Partial<RealtimeCallbacks> = {}) {
  vi.useFakeTimers();
  const h = shellHarness(tasks);
  const peer = new FakePeer();
  const track = { stop: vi.fn(), readyState: "live" };
  let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
  const muted: boolean[] = [];
  const stopReplies: unknown[] = [];
  let ended = 0;
  const inputs: string[] = [];
  const deps: LiveDeps = {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 live-answer",
    input: async (kind, text) => void inputs.push(`${kind}:${text}`),
    hostResult: async () => {},
    approval: async () => {},
    end: async () => void ended++,
    subscribe: (hs) => {
      handlers = hs;
      return () => (handlers = null);
    },
    watchLevel: () => () => {},
    setMuted: (m) => void muted.push(m),
    speak: () => {},
    stopReply: async (turn) => void stopReplies.push(turn),
  };
  const voice = new LiveVoice({ ...h.callbacks(), ...overrides }, deps, { idleMs: 120_000 });
  await voice.start();
  peer.connect();
  peer.channel.emit({ type: "session.started", session: {} });
  const core = (event: LiveCoreEvent) => handlers!.core(event);
  const host = (call: HostCall) => handlers!.host(call);
  const finalUser = (text: string, id: string | null = null) => peer.channel.emit({ type: "turn.done", turn: { role: "user", transcript: text, ...(id ? { id } : {}) } });
  const partialUser = (text: string) => peer.channel.emit({ type: "input_transcript.added", item: { text } });
  const assistant = (text: string) => peer.channel.emit({ type: "turn.done", turn: { role: "assistant", transcript: text } });
  return { h, voice, peer, core, host, finalUser, partialUser, assistant, muted, inputs, stopReplies: () => stopReplies, ended: () => ended, isMuted: () => muted.at(-1) === true };
}

describe("ChatGPT-plan route: spoken local commands open views, and this turn's reply is muted", () => {
  it("simplified 「进度如何」 opens the progress card with user_request, mutes playback and tells the core (stop-reply)", async () => {
    const t = await liveRoute();
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    t.partialUser("进度");
    t.finalUser("进度如何", "u1");
    expect(t.h.shell.surface).toMatchObject({ kind: "progress", visibility_reason: "user_request" });
    expect(t.h.allowed()).toBe(true);
    expect(t.isMuted()).toBe(true);
    expect(t.stopReplies()).toEqual([{ scope: "turn", response_id: null }]);
    expect(t.voice.current).toBe("listening");
    // 核心轉送同一則（同 item_id）：不會再開一次、不會再登記請求。
    t.core({ kind: "transcript", role: "user", text: "进度如何", final: true, item_id: "u1" });
    expect(t.h.userRequestIds.size).toBe(1);
    // 模型這一輪想說的話（助理逐字稿）、同一句晚到的片段：仍然靜音，字幕也不顯示。
    t.assistant("目前有兩個任務在進行。");
    t.partialUser("进度如");
    expect(t.isMuted()).toBe(true);
    expect(t.h.shown).toEqual([]);
    // 使用者又開口：恢復，下一輪照常念、照常顯示。
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    expect(t.isMuted()).toBe(false);
    t.finalUser("新竹今天會下雨嗎", "u2");
    t.assistant("新竹今天多雲。");
    expect(t.h.shown).toEqual(["新竹今天多雲。"]);
  });

  it("the core's sideband copy alone (no data-channel transcript) is handled the same way", async () => {
    const t = await liveRoute([DONE]);
    t.core({ kind: "transcript", role: "user", text: "看结果", final: true, item_id: "u9" });
    expect(t.h.shell.surface).toMatchObject({ kind: "artifact", artifact_id: DONE.artifact_id });
    expect(t.h.allowed()).toBe(true);
    expect(t.isMuted()).toBe(true);
  });

  it("the mute ends on a new user final, typing, a system notice, or after LOCAL_COMMAND_QUIET_MS", async () => {
    const t = await liveRoute();
    t.finalUser("进度如何");
    expect(t.isMuted()).toBe(true);
    t.finalUser("新竹今天會下雨嗎");
    expect(t.isMuted()).toBe(false);
    t.finalUser("收起");
    expect(t.isMuted()).toBe(true);
    t.voice.sendText("幫我查天氣");
    expect(t.isMuted()).toBe(false);
    t.finalUser("看结果");
    t.voice.notify("任務完成了");
    expect(t.isMuted()).toBe(false);
    t.finalUser("进度如何");
    vi.advanceTimersByTime(LOCAL_COMMAND_QUIET_MS - 1);
    expect(t.isMuted()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.isMuted()).toBe(false);
  });

  it("「搜尋成果 晚餐」 opens history with the query; 「收起」 closes the view and the call continues", async () => {
    const t = await liveRoute();
    t.finalUser("搜尋成果 晚餐");
    expect(t.h.shell.surface?.kind).toBe("history");
    expect(t.h.historyQueries).toEqual(["晚餐"]);
    expect(t.h.allowed()).toBe(true);
    t.finalUser("收起来");
    expect(t.h.shell.surface).toBeNull();
    expect(t.voice.on).toBe(true);
    expect(t.ended()).toBe(0);
    expect(t.inputs).toEqual([]);
  });

  it("negatives: partial transcripts, assistant transcripts, echo, long sentences and noise do nothing locally", async () => {
    const t = await liveRoute([DONE]);
    t.partialUser("进度如何");
    t.assistant("進度如何");
    t.finalUser("被談");
    t.finalUser("对。");
    t.finalUser("我想知道那個報告的進度如何");
    t.finalUser("進度");
    expect(t.h.shell.surface).toBeNull();
    expect(t.h.userRequestIds.size).toBe(0);
    expect(t.stopReplies()).toEqual([]);
    expect(t.muted).toEqual([]);
    // M3：模型提示「你可以說收起」、播放已經停了（沒有在念）之後使用者說「收起」：是使用者自己說的，照常在本機處理。
    t.h.dispatch({ type: "show.progress", request_id: "req_typed_fixture" });
    t.assistant("你可以說「收起」來關掉畫面。");
    t.finalUser("收起");
    expect(t.h.shell.surface).toBeNull();
    expect(t.stopReplies()).toEqual([{ scope: "turn", response_id: null }]);
  });

  it("teardown unmutes and clears the timer", async () => {
    const t = await liveRoute();
    t.finalUser("进度如何");
    t.voice.stop();
    expect(t.isMuted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("review regressions (scenarios A–E from the F1 review probes)", () => {
  it("A (live)：an earlier turn's delegation finishing during the quiet is heard and subtitled", async () => {
    const t = await liveRoute();
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    t.finalUser("幫我查明天新竹天氣", "u1");
    t.core({ kind: "delegation", id: "d1", state: "started" });
    t.assistant("我查一下。");
    vi.advanceTimersByTime(500);
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    t.finalUser("进度如何", "u2");
    expect(t.isMuted()).toBe(true);
    t.core({ kind: "delegation", id: "d1", state: "finished" });
    expect(t.isMuted()).toBe(false);
    t.assistant("明天新竹多雲，最高 27 度。");
    expect(t.h.shown).toEqual(["我查一下。", "明天新竹多雲，最高 27 度。"]);
  });

  it("A' (live)：a delegation this turn started (the model answering the command itself) stays muted until its reply", async () => {
    const t = await liveRoute();
    t.peer.channel.emit({ type: "input_audio_buffer.speech_started" });
    t.finalUser("进度如何", "u1");
    t.core({ kind: "delegation", id: "d_own", state: "started" });
    t.assistant("我查一下。");
    expect(t.isMuted()).toBe(true);
    t.core({ kind: "delegation", id: "d_own", state: "finished" });
    expect(t.isMuted()).toBe(true);
    t.assistant("目前有兩個任務在進行。");
    vi.advanceTimersByTime(LOCAL_COMMAND_DRAIN_MS);
    expect(t.isMuted()).toBe(false);
    expect(t.h.shown).toEqual([]);
  });

  it("B (live)：a memory confirmation card during the quiet ends it; the core's question is audible and subtitled", async () => {
    const t = await liveRoute();
    t.finalUser("进度如何", "u1");
    expect(t.isMuted()).toBe(true);
    t.core({ kind: "memory_card", card: "card_fixture_1", open: true } as LiveCoreEvent);
    expect(t.isMuted()).toBe(false);
    t.assistant("（記憶確認）要我記住你喜歡咖啡嗎？請說確認記住或取消。");
    expect(t.h.shown).toEqual(["（記憶確認）要我記住你喜歡咖啡嗎？請說確認記住或取消。"]);
  });

  it("C (live)：an Action Gate confirmation card during the quiet ends it; the model's explanation is audible and subtitled", async () => {
    const needsConfirm = { ok: true, status: "needs_confirmation", confirm_id: "home_c1", device: "書房燈", room: "書房", action: "關閉", expires_in_s: 90, message: "需要確認（fixture）" } as unknown as HomeResult;
    const t = await liveRoute([DONE], { onHomeControl: async () => needsConfirm });
    t.finalUser("看结果", "u1");
    expect(t.isMuted()).toBe(true);
    t.host({ call_id: "hc_1", name: "home_control", arguments: JSON.stringify({ target: "書房燈", command: "power", value: false }) });
    await vi.waitFor(() => expect(t.h.prompts).toEqual(["home_c1"]));
    expect(t.isMuted()).toBe(false);
    t.assistant("書房燈要關掉，請說確認執行或取消。");
    expect(t.h.shown).toEqual(["書房燈要關掉，請說確認執行或取消。"]);
  });

  it("the live quiet is capped at LOCAL_COMMAND_QUIET_MS (8 s) when no reply ever arrives", async () => {
    const t = await liveRoute();
    t.finalUser("进度如何", "u1");
    vi.advanceTimersByTime(LOCAL_COMMAND_QUIET_MS - 1);
    expect(t.isMuted()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.isMuted()).toBe(false);
    expect(LOCAL_COMMAND_QUIET_MS).toBe(8_000);
  });

  it("D (API key, M1)：an earlier turn's tool result arriving after the local command still gets response.create", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const t = await apiKeyRoute([], { onDelegate: () => new Promise((resolve) => (finish = resolve)) });
    t.userSays("幫我整理晚餐菜單", "r1");
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", arguments: JSON.stringify({ title: "整理晚餐菜單" }), response_id: "r1" });
    t.ch.emit({ type: "response.done", response: { id: "r1" } });
    t.ch.sent.length = 0;
    t.userSays("进度如何", "r2");
    expect(t.h.shell.surface?.kind).toBe("progress");
    expect(t.cancels()).toEqual([{ type: "response.cancel", response_id: "r2" }]);
    t.ch.emit({ type: "response.done", response: { id: "r2", status: "cancelled" } });
    finish({ ok: true, title: "整理晚餐菜單", status: "done" });
    await vi.waitFor(() => expect(t.ch.sent.map((e) => e.type)).toContain("response.create"));
    expect(t.ch.sent.filter((e) => e.type === "conversation.item.create").map((e) => (e.item as { type: string }).type)).toEqual(["function_call_output"]);
  });

  it("D' (API key, M1)：the same, when this turn's response is created only after the transcript", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const t = await apiKeyRoute([], { onDelegate: () => new Promise((resolve) => (finish = resolve)) });
    t.userSays("幫我整理晚餐菜單", "r1");
    t.ch.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", arguments: JSON.stringify({ title: "整理晚餐菜單" }), response_id: "r1" });
    t.ch.emit({ type: "response.done", response: { id: "r1" } });
    t.ch.sent.length = 0;
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "进度如何" });
    t.ch.emit({ type: "response.created", response: { id: "r2" } });
    expect(t.cancels()).toEqual([{ type: "response.cancel", response_id: "r2" }]);
    t.ch.emit({ type: "response.done", response: { id: "r2", status: "cancelled" } });
    finish({ ok: true, title: "整理晚餐菜單", status: "done" });
    await vi.waitFor(() => expect(t.ch.sent.map((e) => e.type)).toContain("response.create"));
  });

  it("E (API key, minor 3)：a late transcript after this turn's response is done opens the view and cancels nothing later", async () => {
    const t = await apiKeyRoute();
    t.ch.emit({ type: "input_audio_buffer.speech_started" });
    t.ch.emit({ type: "input_audio_buffer.speech_stopped" });
    t.ch.emit({ type: "response.created", response: { id: "r3" } });
    t.ch.emit({ type: "response.output_audio_transcript.done", response_id: "r3", transcript: "目前有一個任務在進行。" });
    t.ch.emit({ type: "response.done", response: { id: "r3" } });
    t.ch.sent.length = 0;
    t.ch.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "进度如何" });
    expect(t.h.shell.surface?.kind).toBe("progress");
    expect(t.ch.sent).toEqual([]);
    // 之後的系統通知照常回答（沒有被預先取消）。
    t.voice.notify("任務完成了");
    t.ch.emit({ type: "response.created", response: { id: "r_notice" } });
    expect(t.cancels()).toEqual([]);
  });

  it("minor 2：with a confirm card open, progress/result/history are left to the model (replacing the card would reject it); 收起 still closes it like Esc", async () => {
    const t = await apiKeyRoute([DONE]);
    t.h.dispatch({ type: "show.confirm", request_id: "confirm_fixture", message: "fixture" });
    for (const [i, text] of ["进度如何", "看结果", "搜尋成果 晚餐"].entries()) t.userSays(text, `rc${i}`);
    expect(t.h.shell.surface?.kind).toBe("confirm");
    expect(t.cancels()).toEqual([]);
    t.userSays("收起", "rc_dismiss");
    expect(t.h.shell.surface).toBeNull();
  });
});

describe("AssistantEcho (review M3)", () => {
  it("is echo only when the text matches what Nous said AND the utterance overlapped playback (+1.5 s)", () => {
    let now = 0;
    const echo = new AssistantEcho(() => now);
    echo.notePhase("speaking");
    echo.notePartial("要看");
    echo.notePartial("結果嗎？");
    // 使用者逐字稿比助理整句先到：片段也算。
    expect(echo.isEcho("看结果")).toBe(true);
    now = 1_000;
    echo.note("要看結果嗎？");
    echo.notePhase("listening");
    // 播放停下 1 秒內開口：仍算重疊。
    now = 2_000;
    echo.notePhase("hearing");
    expect(echo.isEcho("看結果")).toBe(true);
    // 播放停下 2 秒後才開口：使用者自己的回答。
    echo.notePhase("thinking");
    now = 3_000;
    echo.notePhase("listening");
    echo.notePhase("hearing");
    expect(echo.isEcho("看結果")).toBe(false);
    // 文字不同：就算重疊也不是回音（使用者插話下指令）。
    echo.notePhase("speaking");
    expect(echo.isEcho("收起")).toBe(false);
  });
});

describe("matchVoiceCommand", () => {
  it("a trailing please is not part of an English history query", () => {
    expect(matchVoiceCommand("search my results for dinner please")).toEqual({ kind: "history", query: "dinner" });
    expect(matchVoiceCommand("search past results for dinner, please.")).toEqual({ kind: "history", query: "dinner" });
  });

  it("folds simplified to traditional without changing length", () => {
    for (const text of ["进度如何", "看结果", "搜索成果 晚饭", "关闭画面", "收起来"]) expect(foldVoice(text)).toHaveLength(text.length);
    expect(foldVoice("进度如何")).toBe("進度如何");
  });

  it("accepts only whole, short command utterances of the four view kinds", () => {
    const yes: [string, string][] = [
      ["进度如何", "progress"], ["進度如何？", "progress"], ["進度如何呢", "progress"], ["進度呢", "progress"], ["做到哪了", "progress"], ["請問進度呢", "task"], ["看一下进度", "progress"],
      ["看结果", "result"], ["給我看成果", "result"], ["幫我看結果吧", "result"],
      ["收起", "dismiss"], ["收起來吧", "dismiss"], ["回桌布", "dismiss"], ["关闭画面", "dismiss"],
      ["搜尋成果 晚餐", "history"], ["找之前關於晚餐的成果", "history"], ["成果紀錄", "history"],
      ["show progress", "progress"], ["show results", "result"], ["dismiss", "dismiss"], ["search my results for dinner", "history"], ["view progress", "progress"],
    ];
    for (const [text, kind] of yes) expect(matchVoiceCommand(text)?.kind ?? "task", text).toBe(kind);
    const no = [
      "我想知道那個報告的進度如何", "進度如何，然後幫我寫一份報告", "进度如何？你好", "被談", "对。", "對", "好", "嗯",
      "好了沒", "完成了嗎", "剛才那份", "先這樣", "關閉", "隱藏", "結果", "比賽結果", "交通狀況如何", "今天天氣狀況",
      "設定", "改用 Claude", "進度", "进度", "progress", "task progress", "停止任務", "取消", "stop", "close", "hide", "results", "status", "search results for flights to Tokyo",
      "搜尋成果 晚餐然後幫我寫一份菜單", "搜尋成果 這是一段非常非常長的查詢詞已經超過十六個字了吧",
    ];
    for (const text of no) expect(matchVoiceCommand(text), text).toBeNull();
  });
});

describe("wiring in src/main.ts", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("spoken commands use userRequest(), the same dispatch and openHistory, and only close the view on 收起", () => {
    const block = main.slice(main.indexOf("const realtimeCommands = new RealtimeLocalCommands({"), main.indexOf("const realtimeCallbacks: RealtimeCallbacks"));
    expect(block).toContain("userRequest,");
    expect(block).toContain("dispatch,");
    expect(block).toContain("openHistory: (requestId, query) => openHistory(requestId, query)");
    expect(block).not.toMatch(/closeConversation|stopRealtime|cancelTask/);
    expect(main).toContain("realtimeCommands.noteAssistant(text);");
    const tools = readFileSync(new URL("../src/realtime-tools.ts", import.meta.url), "utf8");
    expect(tools).not.toMatch(/RealtimeLocalCommands|voice-command/);
  });
});
