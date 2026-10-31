import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { speakInstructions } from "../server/apikey-call.ts";
import { CONFIRM_AFTER_MS, VOICE_CONFIRM_WINDOW_MS, type LiveCallPort, type RevokeWhy } from "../server/memory/live.ts";
import type { LiveCoreEvent } from "../shared/realtime-route.ts";
import { parseGaEvent } from "../shared/realtime-ga.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import { cards, ga, gaRoute, makeCtx, notices, settle, spoken, until, type GaCall } from "./fixtures/apikey.ts";
import { startFakeGa, type FakeGa } from "./fixtures/fake-sideband.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CLAUDE, CODEX, enable, harness, manage, OPENAI_RT, selectProfile, type Harness } from "./fixtures/memory-service.ts";

// MEM-3：API key 即時語音的記憶（server/apikey-call.ts ＋ server/memory/live.ts ＋ MemoryService）。MEM-2 的語音規則套到 GA 事件：
// 只有旁路上的語音辨識逐字稿（transcription.completed）能觸發；正例、反例、回音、沒有同意、頻率限制、候選、取消、確認卡衝突、
// recall_memory、交辦封鎖、撤銷、跨路徑一致性。假的 GA 伺服器（真 WebSocket）、假時鐘、真 AES-GCM 記憶。
// 不是 Mac gate：P1–P5 與錄音只能在 Mac 上用真 key 驗證。全部是虛構人物與內容。

let server: FakeGa;
let dir: string, key: Buffer;
const open: Harness[] = [];
beforeEach(async () => {
  server = await startFakeGa();
  dir = mkdtempSync(join(tmpdir(), "nous-memory-apikey-"));
  key = randomBytes(32);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(extra: Partial<Parameters<typeof harness>[0]> = {}): Harness {
  const h = harness({ dir, key, live: CODEX, apiKey: OPENAI_RT, release: { api_key: true }, ...extra });
  open.push(h);
  return h;
}

async function pinAll(h: Harness, subject?: string | null): Promise<void> {
  const token = await manage(h);
  const list = await h.call({ op: "list", token, ...(subject !== undefined ? { subject } : {}) });
  for (const f of list.facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
}

/** George（釘選：不吃香菜、喜歡藍色；沒有釘選：不喝茶）＋全家共用（釘選：家裡週末吃素）。 */
async function george(extra: Partial<Parameters<typeof harness>[0]> = {}, allow = [CLAUDE, OPENAI_RT, CODEX]): Promise<Harness> {
  const h = make(extra);
  await enable(h, "George", allow);
  await h.turn("記住，我不吃香菜");
  await h.turn("記住，我喜歡藍色");
  await pinAll(h);
  await h.turn("記住，我不喝茶");
  const token = await manage(h);
  await h.call({ op: "edit", id: null, subject: null, value: "家裡週末吃素", token });
  await pinAll(h, null);
  const status = (await h.call({ op: "status" })) as unknown as { profiles: { id: string; name: string }[] };
  await h.call({ op: "select", profile: status.profiles.find((p) => p.name === "George")!.id, token: await manage(h) });
  return h;
}

/** 只有沒釘選的記憶（這通帶記憶規則，但連線時不帶任何內容、沒有 lease）。 */
async function unpinned(): Promise<Harness> {
  const h = make();
  await enable(h, "George", [CLAUDE, OPENAI_RT, CODEX]);
  await h.turn("記住，我不喝茶");
  return h;
}

async function startCall(h: Harness, options: { lookToTalk?: boolean; rebuild?: boolean } = {}) {
  const probe = makeCtx(h.clock, options);
  const { route, bindings, logs } = gaRoute(server, h);
  const call = (await route.connect("v=0 offer", probe.ctx)) as GaCall;
  const conn = await server.next();
  await conn.waitFor((e) => e.type === "session.update");
  const binding = bindings[0]!;
  const t = {
    call, conn, probe, binding, logs,
    user: async (text: string) => { ga.user(conn, text); await settle(binding); },
    hear: async (text: string) => { ga.assistant(conn, text); await settle(binding); },
    said: () => spoken(conn),
  };
  return t;
}
const advance = (h: Harness, ms: number) => { h.clock.now += ms; };
const QUESTION = "要記住：不喝咖啡，記在 George 名下。請說『確認記住』。";
const quoted = (sentence: string) => speakInstructions(`（記憶確認）「${sentence}」`);

async function factsOf(h: Harness): Promise<MemoryFactView[]> {
  return (await h.call({ op: "list" })).facts as MemoryFactView[];
}

describe("GA event normalization (pure)", () => {
  it("tags sources: only the ASR transcript is the user's voice; typed and system items carry no content; session.* carries only the type", () => {
    expect(parseGaEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "記住，我不喝咖啡" })).toEqual({ kind: "user_final", source: "asr", text: "記住，我不喝咖啡", item_id: "i1" });
    expect(parseGaEvent({ type: "conversation.item.added", item: { id: "i2", role: "user", content: [{ type: "input_text", text: "記住，我不喝咖啡" }] } })).toEqual({ kind: "item_added", source: "typed", item_id: "i2" });
    expect(parseGaEvent({ type: "conversation.item.added", item: { id: "i3", role: "system", content: [{ type: "input_text", text: "（記憶資料）x" }] } })).toEqual({ kind: "item_added", source: "system", item_id: "i3" });
    expect(parseGaEvent({ type: "session.updated", session: { instructions: "SECRET" } })).toEqual({ kind: "session", phase: "updated" });
    expect(parseGaEvent({ type: "response.output_audio_transcript.done", transcript: "好" })).toMatchObject({ kind: "assistant_final", source: "assistant" });
    expect(parseGaEvent({ type: "response.output_audio.delta", delta: "AAAA" })).toBeNull();
  });
});

describe.skipIf(!realLockAvailable)("MEM-3: only the sideband's ASR transcript is the user's voice", () => {
  it("typed or injected user text and the model reading a command never create a card; the ASR transcript does", async () => {
    const h = await george();
    const t = await startCall(h);
    ga.typed(t.conn, "記住，我不喝咖啡");
    await settle(t.binding);
    await t.hear("記住，我不喝咖啡");
    expect(cards(t.probe.events)).toEqual([]);
    // 回音時窗（10 秒）之後，使用者自己說出同一句：語音辨識的逐字稿才算。
    advance(h, 11_000);
    await t.user("記住，我不喝咖啡");
    expect(cards(t.probe.events)).toHaveLength(1);
    expect(t.said().at(-1)).toBe(quoted(QUESTION));
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 review: only committed microphone items, stale titles, response.create collisions", () => {
  it("a transcription for an item never committed from the microphone buffer is ignored", async () => {
    const h = await george();
    const t = await startCall(h);
    ga.uncommitted(t.conn, "記住，我不喝咖啡");
    await settle(t.binding);
    expect(cards(t.probe.events)).toEqual([]);
    await t.user("記住，我不喝咖啡");
    expect(cards(t.probe.events)).toHaveLength(1);
  });

  it("a typed item after the last utterance clears the delegation title (no stale sentence on the card)", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("幫我寫一份晚餐菜單報告");
    ga.typed(t.conn, "幫我查明天的行程");
    ga.functionCall(t.conn, "delegate_task", { title: "行程" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect(JSON.parse((output.item as { output: string }).output)).toMatchObject({ status: "delegate_blocked" });
    expect(t.probe.events.some((e) => e.kind === "delegate_blocked")).toBe(false);
  });

  it("the core's line survives the page's own response.created and is resent once after a collision error carrying its own event_id", async () => {
    const h = await george();
    const t = await startCall(h);
    server.autoRespond = false;
    await t.user("記住，我不喝咖啡");
    const first = await t.conn.waitFor((e) => e.type === "response.create");
    const id = String(first.event_id);
    expect(id).toMatch(/^nous_core_/);
    // 頁面自己的回應開始（沒有核心的 event_id）：核心的句子不能被當成已送出而丟掉。
    t.conn.send({ type: "response.created", response: { id: "resp_page" } });
    server.error(t.conn, "conversation_already_has_active_response", id);
    t.conn.send({ type: "response.done", response: { id: "resp_page" } });
    await until(() => t.conn.received.filter((e) => e.type === "response.create").length === 2);
    const creates = t.conn.received.filter((e) => e.type === "response.create");
    expect((creates[1]!.response as { instructions: string }).instructions).toBe((first.response as { instructions: string }).instructions);
    expect(creates[1]!.event_id).not.toBe(id);
  });

  it("an error from the page's own request never re-queues the core's line (no double reading)", async () => {
    const h = await george();
    const t = await startCall(h);
    server.autoRespond = false;
    await t.user("記住，我不喝咖啡");
    const first = await t.conn.waitFor((e) => e.type === "response.create");
    server.error(t.conn, "conversation_already_has_active_response", "evt_page_request");
    t.conn.send({ type: "response.created", response: { id: "resp_core" } });
    t.conn.send({ type: "response.done", response: { id: "resp_core" } });
    await settle(t.binding);
    expect(t.conn.received.filter((e) => e.type === "response.create")).toEqual([first]);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 spoken confirmation (same rules as MEM-2)", () => {
  it("positive: the anchored phrase after the question was read and played, within 15 s, saves once as voice_confirmed", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("記住，我不喝咖啡");
    advance(h, 2500);
    await t.hear(QUESTION);
    advance(h, VOICE_CONFIRM_WINDOW_MS - 1000);
    await t.user("确认记住");
    expect((await factsOf(h)).find((f) => f.text === "不喝咖啡")).toMatchObject({ source: "voice_confirmed", excerpt: "記住，我不喝咖啡" });
    expect(t.said().at(-1)).toBe(quoted("已記住。"));
    // 同一張卡只能確認一次。
    await t.user("確認記住");
    expect((await factsOf(h)).filter((f) => f.text === "不喝咖啡")).toHaveLength(1);
  });

  it("negatives: generic 「好」, before the question was read, an echo of the question, and a timeout never save", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("記住，我不喝咖啡");
    await t.user("確認記住");
    expect(notices(t.probe.events).at(-1)).toContain("沒有採用這次的確認");
    advance(h, 1000);
    await t.hear(QUESTION);
    await t.user(QUESTION);
    await t.user("好");
    advance(h, VOICE_CONFIRM_WINDOW_MS + CONFIRM_AFTER_MS + 1000);
    await t.user("確認記住");
    expect(notices(t.probe.events).at(-1)).toContain("確認時間已過");
    expect((await factsOf(h)).some((f) => f.text === "不喝咖啡")).toBe(false);
  });

  it("the page's playback report only extends the window: speech before the later report is not a confirmation", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("記住，我不喝咖啡");
    advance(h, 1000);
    await t.hear(QUESTION);
    ga.audioStopped(t.conn);
    await settle(t.binding);
    advance(h, 4000);
    t.call.playback!();
    // 旁路的音訊結束是 4 秒前，頁面晚到的播放結束把時窗延到現在；之前開口的不算。
    advance(h, -500);
    await t.user("確認記住");
    expect(notices(t.probe.events).at(-1)).toContain("沒有採用這次的確認");
    advance(h, 1500);
    ga.speechStarted(t.conn);
    await settle(t.binding);
    await t.user("確認記住");
    expect((await factsOf(h)).some((f) => f.text === "不喝咖啡")).toBe(true);
  });

  it("「取消」 voids the card with a fixed sentence; nothing is saved", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("記住，我不喝咖啡");
    advance(h, 1000);
    await t.hear(QUESTION);
    advance(h, 2500);
    await t.user("取消");
    expect(cards(t.probe.events, false)).toHaveLength(1);
    expect(t.said().at(-1)).toBe(quoted("好，沒有保存。"));
    expect((await factsOf(h)).some((f) => f.text === "不喝咖啡")).toBe(false);
  });

  it("limits voice cards to 3 per minute", async () => {
    const h = await george();
    const t = await startCall(h);
    for (const v of ["不喝咖啡", "不吃辣", "喜歡爵士樂", "怕冷"]) {
      await t.user(`記住，我${v}`);
      advance(h, 1000);
    }
    expect(cards(t.probe.events)).toHaveLength(3);
    expect(notices(t.probe.events).at(-1)).toContain("語音確認卡太多了");
  });

  it("corrects the model's own 「記住了」 claim with a fixed notice (no receipt landed)", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.hear("好的，我記住了。");
    expect(t.said().at(-1)).toBe(speakInstructions("（系統通知）還沒有保存。要保存，請照畫面上的確認卡做。"));
    expect(notices(t.probe.events)).toContain("還沒有保存：記憶要經過確認才會保存");
  });

  it("an open MCP or home confirmation card: no voice memory card, and 「取消」 is left to that card", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("記住，我不喝咖啡");
    advance(h, 1000);
    await t.hear(QUESTION);
    advance(h, 2500);
    t.probe.approval.open = true;
    await t.user("取消");
    expect(cards(t.probe.events, false)).toEqual([]);
    await t.user("記住，我不吃辣");
    expect(cards(t.probe.events)).toHaveLength(1);
    expect(notices(t.probe.events).at(-1)).toContain("畫面上有另一張確認卡");
    // 審查 Minor 4：等待中的語音卡沒有被新的指令取代或作廢；確認卡關掉後仍可用說的確認。
    expect(cards(t.probe.events, false)).toEqual([]);
    t.probe.approval.open = false;
    await t.user("確認記住");
    expect((await factsOf(h)).some((f) => f.text === "不喝咖啡")).toBe(true);
    expect((await factsOf(h)).some((f) => f.text === "不吃辣")).toBe(false);
  });

  it("without openai_realtime consent for the current scope: cards only, no spoken metadata", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    const before = t.said().length;
    const token = await manage(h);
    const status = (await h.call({ op: "status" })) as unknown as { presence: { profile: string } };
    for (const subject of [{ kind: "profile", profile: status.presence.profile }, { kind: "household" }]) {
      await h.call({ op: "setup", token, enabled: true, subject, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account! }] });
    }
    await settle(t.binding);
    await t.user("記住，我不喝咖啡");
    await t.user("你記得我什麼？");
    expect(cards(t.probe.events).length).toBeGreaterThan(0);
    expect(t.said().length).toBe(before);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 core tools on the sideband", () => {
  it("recall_memory: the core answers on the sideband (function_call_output, then response.create) and takes a lease", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    expect(t.binding.carriesMemory()).toBe(false);
    ga.functionCall(t.conn, "recall_memory", { query: "喝茶" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect(JSON.parse((output.item as { output: string }).output)).toMatchObject({ facts: [{ text: "不喝茶" }] });
    await until(() => t.conn.received.filter((e) => e.type === "response.create").length > 0);
    expect(t.binding.carriesMemory()).toBe(true);
  });

  it("delegate_task while carrying memory: blocked, the title is the user's own last ASR sentence, nothing reaches the page", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("幫我寫一份晚餐菜單報告");
    ga.functionCall(t.conn, "delegate_task", { title: "晚餐菜單（模型改寫，含不吃香菜）" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect(JSON.parse((output.item as { output: string }).output)).toMatchObject({ ok: false, status: "delegate_blocked" });
    expect(t.probe.events).toContainEqual({ kind: "delegate_blocked", title: "幫我寫一份晚餐菜單報告" });
    expect(t.probe.hostCalls).toEqual([]);
  });

  it("delegate_task before any memory is in the call: the core asks the page through ToolHost as usual", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    ga.functionCall(t.conn, "delegate_task", { title: "寫週報" });
    await until(() => t.probe.hostCalls.length === 1);
    expect(t.probe.hostCalls[0]).toMatchObject({ name: "delegate_task", args: { title: "寫週報" } });
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect(JSON.parse((output.item as { output: string }).output)).toEqual({ ok: true, status: "queued" });
  });

  it("F7 (ID-02 Mac)：after a palm stop the core hands this turn's late delegate_task result back without response.create; the task still runs; the next turn speaks", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    ga.speechStarted(t.conn);
    ga.functionCall(t.conn, "delegate_task", { title: "寫週報" });
    await until(() => t.probe.hostCalls.length === 1);
    t.call.stopReply!();
    // 工作照常交辦：核心等待的 host call 沒有被中止，頁面交回後核心收下結果。
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect(JSON.parse((output.item as { output: string }).output)).toEqual({ ok: true, status: "queued" });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.conn.received.filter((e) => e.type === "response.create")).toEqual([]);
    expect(t.logs.some((line) => line.includes("停止回覆之後才回來"))).toBe(true);
    expect(t.probe.events.some((e) => e.kind === "closed")).toBe(false);

    // 使用者再開口：新的一輪的工具結果照常請模型接著說。
    ga.speechStarted(t.conn);
    ga.functionCall(t.conn, "delegate_task", { title: "整理照片" }, "call_second");
    await until(() => t.probe.hostCalls.length === 2);
    t.probe.hostCalls[1]!.resolve({ ok: true, status: "queued" });
    await until(() => t.conn.received.filter((e) => e.type === "response.create").length === 1);
  });

  it("F7 review race (regression)：a speech_started (「停」, echo, noise) before the stop-reply POST does not un-silence the stopped response; attribution is by response_id", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    ga.speechStarted(t.conn);
    t.conn.send({ type: "response.created", response: { id: "resp_1" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_1", response_id: "resp_1", arguments: JSON.stringify({ title: "寫週報" }) });
    await until(() => t.probe.hostCalls.length === 1);
    ga.speechStarted(t.conn); // 舉手同時說「停」：輪次先加一
    await new Promise((r) => setTimeout(r, 20));
    t.call.stopReply!();
    t.conn.send({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    await new Promise((r) => setTimeout(r, 40));
    expect(t.conn.received.filter((e) => e.type === "response.create")).toEqual([]);
  });

  it("F7 review minor 3：a system notice after the stop is a new response; its core tool result is spoken", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    t.conn.send({ type: "response.created", response: { id: "resp_old" } });
    t.call.stopReply!();
    t.conn.send({ type: "response.done", response: { id: "resp_old", status: "cancelled" } });
    ga.typed(t.conn, "（系統通知）任務完成了");
    t.conn.send({ type: "response.created", response: { id: "resp_notice" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_n", response_id: "resp_notice", arguments: JSON.stringify({ title: "下一步" }) });
    await until(() => t.probe.hostCalls.length === 1);
    t.conn.send({ type: "response.done", response: { id: "resp_notice", status: "completed" } });
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    await until(() => t.conn.received.filter((e) => e.type === "response.create").length === 1);
  });

  it("F7：a core continuation already sent but not yet created at the stop is cancelled by the core when it is created", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    server.autoRespond = false;
    t.conn.send({ type: "response.created", response: { id: "resp_a" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "call_a", response_id: "resp_a", arguments: JSON.stringify({ title: "寫週報" }) });
    t.conn.send({ type: "response.done", response: { id: "resp_a", status: "completed" } });
    await until(() => t.probe.hostCalls.length === 1);
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    const create = await t.conn.waitFor((e) => e.type === "response.create");
    t.call.stopReply!();
    t.conn.send({ type: "response.created", response: { id: "resp_cont", metadata: { nous_trigger: create.event_id } } });
    await t.conn.waitFor((e) => e.type === "response.cancel");
    expect(t.conn.received.find((e) => e.type === "response.cancel")).toMatchObject({ response_id: "resp_cont" });
  });

  it("other tools on the sideband are left to the page (not answered by the core)", async () => {
    const h = await unpinned();
    const t = await startCall(h);
    ga.functionCall(t.conn, "web_search", { query: "新竹天氣" });
    await settle(t.binding);
    expect(t.conn.received.some((e) => e.type === "conversation.item.create")).toBe(false);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 face candidate after the page's greeting", () => {
  it("asks once after the greeting turn ends; an anchored 「是」 selects and late-attaches pinned memory as a system item", async () => {
    let candidate: { person_id: string; name: string; at: number } | null = null;
    const identity = { candidate: () => candidate, people: () => [{ person_id: "fam_000000000000000000000001", name: "George", minor: false }] };
    const h = await george({ identity });
    const token = await manage(h);
    const status = (await h.call({ op: "status" })) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "link_face", profile: status.profiles[0]!.id, person: "fam_000000000000000000000001", token });
    await selectProfile(h, null);
    candidate = { person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now };
    const t = await startCall(h, { lookToTalk: true });
    expect(t.call.memoryStatus?.()).toMatchObject({ reason: "waiting_candidate" });
    t.call.greetingDecided!(true);
    await t.hear("嗨，George");
    expect(t.said().at(-1)).toBe(quoted("這次用 George 的偏好嗎？"));
    await t.hear("這次用 George 的偏好嗎？");
    advance(h, 2000);
    await t.user("是的");
    await until(() => t.conn.received.some((e) => (e.item as { role?: string } | undefined)?.role === "system"));
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected", name: "George" });
    const system = t.conn.received.filter((e) => (e.item as { role?: string } | undefined)?.role === "system").map((e) => JSON.stringify(e)).join("\n");
    expect(system).toContain("（記憶資料）");
    expect(system).toContain("不吃香菜");
    expect(t.binding.carriesMemory()).toBe(true);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 revocation: two stops (stop report + core hangup)", () => {
  it("forget by voice: hold, then closed{memory_revoked, rebuild}, hangup, sideband closed, stop report awaited; nothing more is sent", async () => {
    const h = await george();
    const t = await startCall(h);
    await t.user("忘記我喜歡藍色");
    expect(t.said().at(-1)).toBe(quoted("要忘記『喜歡藍色』這筆記憶。請說『確認忘記』。"));
    await t.hear("要忘記喜歡藍色這筆記憶。請說確認忘記。");
    advance(h, 2000);
    await t.user("確認忘記");
    await until(() => server.hangups.length > 0);
    const kinds = t.probe.events.map((e) => e.kind);
    expect(kinds.indexOf("hold")).toBeLessThan(kinds.indexOf("closed"));
    expect(t.probe.events.find((e) => e.kind === "closed")).toMatchObject({ reason: "memory_revoked", rebuild: true });
    expect(server.hangups).toEqual(["rtc_test"]);
    await t.conn.waitClosed();
    expect(t.probe.stop.asked).toBe(1);
    expect((await factsOf(h)).some((f) => f.text === "喜歡藍色")).toBe(false);
    const sent = t.conn.received.length;
    ga.user(t.conn, "記住，我不吃辣");
    await settle();
    expect(t.conn.received.length).toBe(sent);
  });

  it("no stop report within 1.5 s: forced silence and only the api_key route is disabled until restart (live keeps its memory)", async () => {
    const h = await george();
    const t = await startCall(h);
    t.probe.stop.report = null;
    await selectProfile(h, null);
    await until(() => t.probe.silenced.length > 0);
    expect(t.probe.silenced).toEqual(["即時語音停止未確認；這條路徑的記憶已停用"]);
    await until(() => (h.service as unknown as { boundary: { routeBlock(r: string): string | null } }).boundary.routeBlock("api_key") === "stop_unconfirmed");
    const boundary = (h.service as unknown as { boundary: { routeEnabled(r: string): boolean } }).boundary;
    expect(boundary.routeEnabled("live")).toBe(true);
    expect((await h.service.voiceContext("live", "")).reason).not.toBe("route_disabled");
    expect((await h.service.voiceContext("api_key", "")).reason).toBe("route_disabled");
    // 審查 Minor 9：執行期間停用的路徑也不算有同意（不念任何記憶中繼資料）。
    expect(h.service.voiceConsented("api_key")).toBe(false);
    expect(h.service.voiceConsented("live")).toBe(true);
  });

  it.each([
    ["OS lock ends without rebuild", (h: Harness) => h.service.suspendAll(), { rebuild: false, waits: true }],
    ["navigation or renderer gone ends and does not wait for a stop report", (h: Harness) => h.service.closeSessions(), { rebuild: false, waits: false }],
  ] as const)("%s", async (_name, trigger, expected) => {
    const h = await george();
    const t = await startCall(h);
    trigger(h);
    await until(() => t.probe.events.some((e) => e.kind === "closed"));
    await until(() => server.hangups.length > 0);
    expect(t.probe.events.find((e) => e.kind === "closed")).toMatchObject({ reason: "memory_revoked", rebuild: expected.rebuild });
    await settle();
    expect(t.probe.stop.asked).toBe(expected.waits ? 1 : 0);
  });

  it("a sideband drop ends the call: closed connection_lost and a hangup (the control plane is gone)", async () => {
    const h = await george();
    const t = await startCall(h);
    t.conn.drop();
    await until(() => t.probe.events.some((e) => e.kind === "closed"));
    expect(t.probe.events.find((e) => e.kind === "closed")).toMatchObject({ reason: "connection_lost" });
    await until(() => server.hangups.length > 0);
  });

  it("a rebuilt call records the page's fixed first sentence for echo checks (the user's echo of it is ignored)", async () => {
    const h = await george();
    const t = await startCall(h, { rebuild: true });
    await t.user("好，已經更新了");
    expect(cards(t.probe.events)).toEqual([]);
    expect(notices(t.probe.events)).toEqual([]);
  });
});

/** 假的 live 通話（MEM-2 的 LiveCall 換成陣列），給跨路徑一致性用。 */
class FakeLive implements LiveCallPort {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  active = true;
  readonly injected: { channel: string; text: string }[] = [];
  readonly events: LiveCoreEvent[] = [];
  readonly revokes: { why: RevokeWhy; rebuild: boolean }[] = [];
  constructor() { this.closed = new Promise((r) => (this.resolveClosed = r)); }
  inject(channel: "speakable" | "commentary", text: string): void { if (this.active) this.injected.push({ channel, text }); }
  emit(event: LiveCoreEvent): void { if (this.active) this.events.push(event); }
  async revokeMemory(why: RevokeWhy, rebuild: boolean): Promise<void> { this.revokes.push({ why, rebuild }); this.end(); }
  hold(): void {}
  end(): void { this.active = false; this.resolveClosed(); }
}

async function startLive(h: Harness) {
  const binding = h.service.openLive({ lookToTalk: false, rebuild: false, now: () => h.clock.now });
  const call = new FakeLive();
  let block: string | null = null;
  await binding.connect(async (b) => { block = b; binding.bind(call); return call; });
  binding.started();
  return { binding, call, block: block as string | null };
}

describe.skipIf(!realLockAvailable)("MEM-3 review: busy when another voice call has memory rules", () => {
  it("a live call with memory rules but no lease yet still makes the API key call busy (no sideband, no rules); once it ends the next call gets memory", async () => {
    const h = await unpinned();
    const live = await startLive(h);
    expect(live.binding.memoryActive).toBe(true);
    expect(live.binding.carriesMemory()).toBe(false);
    const { route } = gaRoute(server, h);
    const busy = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    expect(busy.memoryStatus?.()).toEqual({ used: 0, reason: "busy" });
    expect(server.upgrades).toBe(0);
    live.call.end();
    await new Promise((r) => setTimeout(r, 0));
    const next = await route.connect("v=0 offer", makeCtx(h.clock).ctx);
    expect(next.coreTools).toEqual(["recall_memory", "delegate_task"]);
    await next.close("ended");
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 cross-route consistency (live ↔ API key)", () => {
  it("remember on live, recall on the API key route; forget on the API key route, gone from the next live call", async () => {
    const h = await george();
    const live = await startLive(h);
    live.binding.onUserFinal("記住，我不喝咖啡", h.clock.now);
    await live.binding.idle();
    advance(h, 1000);
    live.binding.onAssistantFinal(QUESTION, h.clock.now);
    advance(h, 2500);
    live.binding.onUserFinal("確認記住", h.clock.now);
    await live.binding.idle();
    expect((await factsOf(h)).find((f) => f.text === "不喝咖啡")).toMatchObject({ source: "voice_confirmed" });
    live.call.end();

    const t = await startCall(h);
    ga.functionCall(t.conn, "recall_memory", { query: "喝咖啡" });
    const output = await t.conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    expect((output.item as { output: string }).output).toContain("不喝咖啡");
    await t.user("忘記我不喝咖啡");
    advance(h, 1000);
    await t.hear("要忘記不喝咖啡這筆記憶。請說確認忘記。");
    advance(h, 2500);
    await t.user("確認忘記");
    await until(() => t.probe.events.some((e) => e.kind === "closed"));
    expect((await factsOf(h)).some((f) => f.text === "不喝咖啡")).toBe(false);

    const next = await startLive(h);
    for (let i = 0; i < 3; i++) {
      const out = await next.binding.callerPort()!.recall("喝咖啡", new AbortController().signal);
      expect(JSON.stringify(out)).not.toContain("不喝咖啡");
    }
  });

  it("fallback consent: codex consent alone gives the API key route no memory (no_consent); with both, both routes get the same pinned block", async () => {
    const codexOnly = await george({}, [CLAUDE, CODEX]);
    const { route } = gaRoute(server, codexOnly);
    const call = await route.connect("v=0 offer", makeCtx(codexOnly.clock).ctx);
    expect(call.memoryStatus?.()).toEqual({ used: 0, reason: "no_consent" });
    await codexOnly.close();
    open.splice(open.indexOf(codexOnly), 1);
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "nous-memory-apikey-"));

    const both = await george();
    const live = await startLive(both);
    live.call.end();
    await new Promise((r) => setTimeout(r, 0));
    const t = await startCall(both);
    const update = (await t.conn.waitFor((e) => e.type === "session.update")) as { session: { instructions: string } };
    expect(live.block).not.toBeNull();
    expect(update.session.instructions.endsWith(live.block!)).toBe(true);
  });
});
