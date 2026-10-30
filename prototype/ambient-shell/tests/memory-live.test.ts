import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveCoreEvent } from "../shared/realtime-route.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import { CANDIDATE_WINDOW_MS, CONFIRM_AFTER_MS, exactVoiceConfirm, exactYesNo, LiveMemoryBinding, VOICE_CONFIRM_WINDOW_MS, type LiveCallPort, type RevokeWhy } from "../server/memory/live.ts";
import { CONTEXT_MAX_BYTES, CONTEXT_MAX_FACTS } from "../server/memory/retrieve.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CHATGPT, CLAUDE, CODEX, enable, harness, manage, selectProfile, type Harness } from "./fixtures/memory-service.ts";

// MEM-2：ChatGPT 方案即時語音的記憶（server/memory/live.ts ＋ MemoryService）在 Linux 上能驗的部分：真 AES-GCM 快照、
// 假時鐘、假的 LiveCall（只記下送給模型的句子、送給頁面的事件與撤銷）。不是 Mac gate：沒有真的錄音、AEC 或上游 wire。
// 全部是虛構人物與內容。

let dir: string, key: Buffer;
const open: Harness[] = [];
function make(extra: Partial<Parameters<typeof harness>[0]> = {}): Harness {
  const h = harness({ dir, key, live: CODEX, ...extra });
  open.push(h);
  return h;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nous-memory-live-")); key = randomBytes(32); });
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.close())); rmSync(dir, { recursive: true, force: true }); });

/** 假的 LiveCall：sideband 與頁面都換成陣列。 */
class FakeCall implements LiveCallPort {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  active = true;
  readonly injected: { channel: string; text: string }[] = [];
  readonly events: LiveCoreEvent[] = [];
  readonly revokes: { why: RevokeWhy; rebuild: boolean }[] = [];
  readonly holds: boolean[] = [];
  constructor() { this.closed = new Promise(r => (this.resolveClosed = r)); }
  inject(channel: "speakable" | "commentary", text: string): void { if (this.active) this.injected.push({ channel, text }); }
  emit(event: LiveCoreEvent): void { if (this.active) this.events.push(event); }
  async revokeMemory(why: RevokeWhy, rebuild: boolean): Promise<void> { this.revokes.push({ why, rebuild }); this.end(); }
  hold(active: boolean): void { this.holds.push(active); }
  end(): void { this.active = false; this.resolveClosed(); }
  spoken(): string[] { return this.injected.filter(x => x.channel === "speakable").map(x => x.text); }
  cards(open = true): string[] { return this.events.filter((e): e is Extract<LiveCoreEvent, { kind: "memory_card" }> => e.kind === "memory_card" && e.open === open).map(e => e.card); }
  notices(): string[] { return this.events.filter((e): e is Extract<LiveCoreEvent, { kind: "memory_notice" }> => e.kind === "memory_notice").map(e => e.message); }
}

async function startLive(h: Harness, options: { lookToTalk?: boolean; rebuild?: boolean } = {}) {
  const binding = h.service.openLive({ lookToTalk: !!options.lookToTalk, rebuild: !!options.rebuild, now: () => h.clock.now });
  const call = new FakeCall();
  let block: string | null = null;
  let active = false;
  await binding.connect(async (b, _signal, memoryActive) => { block = b; active = memoryActive; binding.bind(call); return call; });
  binding.started();
  return { binding, call, block: block as string | null, active };
}

async function say(binding: LiveMemoryBinding, text: string, h: Harness) {
  binding.onUserFinal(text, h.clock.now);
  await binding.idle();
}
const hear = (binding: LiveMemoryBinding, text: string, h: Harness) => binding.onAssistantFinal(text, h.clock.now);
const advance = (h: Harness, ms: number) => { h.clock.now += ms; };

async function facts(h: Harness): Promise<MemoryFactView[]> {
  const list = await h.call({ op: "list" });
  return list.facts as MemoryFactView[];
}

async function pinAll(h: Harness, subject?: string | null): Promise<void> {
  const token = await manage(h);
  const list = await h.call({ op: "list", token, ...(subject !== undefined ? { subject } : {}) });
  for (const f of list.facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
}

/** George（釘選：不吃香菜、喜歡藍色；沒有釘選：不喝茶）＋全家共用（釘選：家裡週末吃素），允許 Claude 與 codex。 */
async function george(extra: Partial<Parameters<typeof harness>[0]> = {}, allow = [CLAUDE, CODEX]): Promise<Harness> {
  const h = make(extra);
  await enable(h, "George", allow);
  await h.turn("記住，我不吃香菜");
  await h.turn("記住，我喜歡藍色");
  await pinAll(h);
  await h.turn("記住，我不喝茶");
  const token = await manage(h);
  await h.call({ op: "edit", id: null, subject: null, value: "家裡週末吃素", token });
  await pinAll(h, null);
  const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
  await h.call({ op: "select", profile: status.profiles.find(p => p.name === "George")!.id, token: await manage(h) });
  return h;
}

describe("phrase matchers (anchored, like exactApproval)", () => {
  it("accepts only the exact confirmation phrases (Traditional, Simplified, English); generic yes words never count", () => {
    expect(exactVoiceConfirm("確認記住")).toBe("remember");
    expect(exactVoiceConfirm("确认记住。")).toBe("remember");
    expect(exactVoiceConfirm("Confirm forget!")).toBe("forget");
    expect(exactVoiceConfirm("確認更正")).toBe("correct");
    for (const text of ["好", "是", "好的", "確認", "確認執行", "好的確認記住喔", "確認記住這個優惠", "請說確認記住", "記住"]) expect(exactVoiceConfirm(text)).toBeNull();
    expect(exactYesNo("是的。")).toBe("yes");
    expect(exactYesNo("不是")).toBe("no");
    expect(exactYesNo("是的話就好")).toBeNull();
  });
});

describe.skipIf(!realLockAvailable)("MEM-2 connect-time bundle and consent", () => {
  it("bundles only pinned memory (person + household, at most 4) under a whole-call lease; unpinned stays out", async () => {
    const h = await george();
    const { call, block, binding } = await startLive(h);
    expect(block).toContain("不吃香菜");
    expect(block).toContain("喜歡藍色");
    expect(block).toContain("家裡週末吃素");
    expect(block).not.toContain("不喝茶");
    expect(call.events).toContainEqual(expect.objectContaining({ kind: "memory", used: 3, reason: null }));
    expect(binding.callerPort()!.blocked()).toBe(true);
    // 釘選超過 4 筆：連線時只送 4 筆。
    const token = await manage(h);
    for (const v of ["喜歡爵士樂", "怕冷"]) await h.call({ op: "edit", id: null, subject: null, value: v, token });
    await pinAll(h, null);
    call.end();
    const second = await startLive(h);
    expect((second.block!.match(/"text":/g) ?? []).length).toBe(4);
  });

  it("uses only the separate codex consent: ChatGPT consent alone sends nothing and says why; no Codex login has no account", async () => {
    const h = await george({}, [CLAUDE, CHATGPT]);
    const { call, block, binding, active } = await startLive(h);
    expect(block).toBeNull();
    expect(call.events).toContainEqual(expect.objectContaining({ kind: "memory", used: 0, reason: "no_consent" }));
    // Minor 1：沒有 codex 同意時和 MEM-2 之前一樣：沒有記憶規則、沒有 recall_memory（caller 沒有記憶）。
    expect(active).toBe(false);
    expect(binding.memoryActive).toBe(false);
    expect(binding.callerPort()).toBeNull();
    // M4：沒有同意時，語音指令只出畫面卡，不念任何句子（不透露有沒有符合的記憶或筆數），也不插「還沒有保存」。
    for (const text of ["記住，我不喝咖啡", "忘記我喜歡藍色", "忘記我喜歡紫色", "你記得我什麼？", "記住，我不吃香菜"]) {
      await say(binding, text, h);
      advance(h, 1000);
    }
    hear(binding, "好的，我記住了。", h);
    expect(call.injected).toEqual([]);
    expect(call.cards().length).toBeGreaterThan(0);
    call.end();
    const other = mkdtempSync(join(tmpdir(), "nous-memory-live-nologin-"));
    const noLogin = harness({ dir: other, key, live: null });
    open.push(noLogin);
    await enable(noLogin, "Amy", [CLAUDE]);
    const second = await startLive(noLogin);
    expect(second.block).toBeNull();
    expect(second.call.events).toContainEqual(expect.objectContaining({ kind: "memory", reason: "no_account" }));
  });

  it("recall_memory: same 8-fact / 4 KB caps, delivered through the lease, refused after revocation", async () => {
    const h = make();
    await enable(h, "George", [CODEX]);
    for (let i = 0; i < 12; i++) await h.turn(`記住，晚餐不要${"很長的說明".repeat(20)}第${i}種菜`);
    const { call, binding } = await startLive(h);
    expect(binding.callerPort()!.blocked()).toBe(false);
    const out = await binding.callerPort()!.recall("晚餐吃什麼", new AbortController().signal) as { facts: { text: string }[] };
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.length).toBeLessThanOrEqual(CONTEXT_MAX_FACTS);
    expect(Buffer.byteLength(out.facts.map(f => JSON.stringify(f)).join("\n"))).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
    expect(binding.callerPort()!.blocked()).toBe(true);
    await selectProfile(h, null);
    await binding.idle();
    expect(call.revokes).toEqual([{ why: "presence", rebuild: true }]);
    expect(await binding.callerPort()!.recall("晚餐吃什麼", new AbortController().signal)).toMatchObject({ ok: false });
  });
});

describe.skipIf(!realLockAvailable)("MEM-2 voice remember/correct/forget only create cards", () => {
  it("does not say the person's name when the naming setting is off (codex consent present)", async () => {
    const h = await george({ identity: { candidate: () => null, people: () => [], nameAllowed: () => false } });
    const { call, binding } = await startLive(h);
    await say(binding, "記住，我不喝咖啡", h);
    expect(call.spoken().at(-1)).toBe("（記憶確認）「要記住：不喝咖啡。請說『確認記住』。」");
    expect(call.spoken().join("")).not.toContain("George");
  });

  it("memory that is off leaves the call exactly as before MEM-2 (no rules, no recall tool, no cards, no inserted sentences)", async () => {
    const h = make();
    const { call, binding, active } = await startLive(h);
    expect(active).toBe(false);
    expect(binding.callerPort()).toBeNull();
    await say(binding, "記住，我不喝咖啡", h);
    hear(binding, "好的，我記住了。", h);
    expect(call.injected).toEqual([]);
    expect(call.events).toEqual([]);
  });

  it("parses the core's own sideband transcript into a voice card; nothing is written without confirmation", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    const before = (await facts(h)).length;
    await say(binding, "記住，我不喝咖啡", h);
    expect(call.cards()).toHaveLength(1);
    expect(call.spoken().at(-1)).toBe("（記憶確認）「要記住：不喝咖啡，記在 George 名下。請說『確認記住』。」");
    const view = await h.call({ op: "card_view", card: call.cards()[0] });
    expect(view).toMatchObject({ ok: true, origin: "live", card: { kind: "voice_confirm", action: "remember", heard: "記住，我不喝咖啡", value: "不喝咖啡", subject_name: "George", options: ["confirm", "household", "cancel"] } });
    await say(binding, "忘記我喜歡藍色", h);
    await say(binding, "更正：我喝熱茶", h);
    expect((await facts(h)).length).toBe(before);
    // SSE 事件只有卡片 ID、數字與固定句，沒有內容。
    expect(JSON.stringify(call.events)).not.toMatch(/咖啡|藍色|熱茶|香菜/);
  });

  it("refuses minors, third parties, quotes, sensitive data and the TV pattern without a card", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    await say(binding, "電視說記住我喜歡吃辣", h);
    await say(binding, "記住我媽不吃牛肉", h);
    await say(binding, "記住，「我不吃牛肉」", h);
    await say(binding, "記住我的密碼是 1234", h);
    expect(call.cards()).toEqual([]);
    expect(call.notices()).toHaveLength(4);
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "profile_minor", profile: status.profiles[0]!.id, minor: true, token });
    // 標記未成年會換世代：帶著記憶的通話被撤銷；新通話一樣不准從語音寫入。
    expect(call.revokes).toHaveLength(1);
    const next = await startLive(h);
    await say(next.binding, "記住，我不喝咖啡", h);
    expect(next.call.cards()).toEqual([]);
    expect(next.call.notices().at(-1)).toContain("未成年");
  });

  it("treats echoes of the assistant and of core-injected sentences as echo (no card)", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    hear(binding, "我可以幫你記住，我不喝咖啡。", h);
    advance(h, 2000);
    await say(binding, "記住，我不喝咖啡", h);
    expect(call.cards()).toEqual([]);
    advance(h, 11_000);
    await say(binding, "記住，我不喝咖啡", h);
    expect(call.cards()).toHaveLength(1);
    // 核心剛送出的問句被麥克風收進來：不再出卡。
    await say(binding, "要記住不喝咖啡記在 George 名下", h);
    expect(call.cards()).toHaveLength(1);
  });

  it("limits voice cards to 3 per minute and one at a time (a new card replaces the old one)", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    for (const v of ["不喝咖啡", "喜歡爵士樂", "怕冷", "喜歡貓"]) {
      await say(binding, `記住，我${v}`, h);
      advance(h, 1000);
    }
    expect(call.cards()).toHaveLength(3);
    expect(call.cards(false)).toHaveLength(2);
    expect(call.notices().at(-1)).toContain("語音確認卡太多了");
    advance(h, 60_000);
    await say(binding, "記住，我喜歡貓", h);
    expect(call.cards()).toHaveLength(4);
  });

  it("corrects the model's own 「記住了」 claim when no receipt landed, but not when it reads the core's receipt", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    hear(binding, "好的，我記住了。", h);
    expect(call.spoken().at(-1)).toMatch(/^（系統通知）還沒有保存/);
    expect(call.notices()).toContain("還沒有保存：記憶要經過確認才會保存");
    advance(h, 20_000);
    await say(binding, "記住，我不喝咖啡", h);
    hear(binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    const claims = () => call.notices().filter(n => n.startsWith("還沒有保存")).length;
    const count = claims();
    advance(h, 2000);
    await say(binding, "確認記住", h);
    hear(binding, "已記住。", h);
    hear(binding, "好的，我會記得。", h);
    expect(claims()).toBe(count);
    // 畫面也顯示固定的回條（不含內容）。
    expect(call.notices()).toContain("已記住。");
  });
});

describe.skipIf(!realLockAvailable)("George 2026-10-30: spoken confirmation is the primary way, the screen card the alternative", () => {
  async function ask(h: Harness, sentence = "記住，我不喝咖啡") {
    const live = await startLive(h);
    await say(live.binding, sentence, h);
    return live;
  }

  it("positive: the anchored phrase after the question was read, within 15 s, saves once as voice_confirmed and speaks a fixed receipt", async () => {
    const h = await george();
    const { call, binding } = await ask(h);
    advance(h, 2500);
    hear(binding, "要記住：不喝咖啡，記在 George 名下。請說『確認記住』。", h);
    advance(h, VOICE_CONFIRM_WINDOW_MS - 1000);
    await say(binding, "确认记住", h);
    const saved = (await facts(h)).find(f => f.text === "不喝咖啡")!;
    expect(saved).toMatchObject({ source: "voice_confirmed", excerpt: "記住，我不喝咖啡" });
    expect(call.spoken().at(-1)).toBe("（記憶確認）「已記住。」");
    // 回條不重念內容；卡片作廢。
    expect(call.cards(false)).toHaveLength(1);
    // 同一張卡只能確認一次。
    await say(binding, "確認記住", h);
    expect((await facts(h)).filter(f => f.text === "不喝咖啡")).toHaveLength(1);
    expect(await h.service.voiceConfirm(call.cards()[0]!)).toEqual({ status: "receipt_expired" });
  });

  it("negatives: generic 「好」, timeout, echo, a person change, the TV pattern and an unread question never save", async () => {
    const h = await george();
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    const token = await manage(h);
    await h.call({ op: "setup", token, enabled: true, subject: { kind: "name", name: "Amy" }, allow: [{ provider: CODEX.provider, account: CODEX.account! }] });
    const georgeId = status.profiles[0]!.id;
    await h.call({ op: "select", profile: georgeId, token });
    const saved = async () => (await facts(h)).some(f => f.text === "不喝咖啡");

    // 泛稱的「好」「是」與電視句型。
    let live = await ask(h);
    hear(live.binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    advance(h, 1000);
    for (const text of ["好", "是", "好的確認記住喔", "確認記住這個優惠"]) await say(live.binding, text, h);
    expect(await saved()).toBe(false);
    live.call.end();

    // 問句還沒念完（沒有助理逐字稿）：不採用。
    advance(h, 61_000);
    live = await ask(h);
    advance(h, 1000);
    await say(live.binding, "確認記住", h);
    expect(await saved()).toBe(false);
    expect(live.call.notices().at(-1)).toContain("沒有採用這次的確認");
    live.call.end();

    // 逾時：念完後超過 15 秒。
    advance(h, 61_000);
    live = await ask(h);
    hear(live.binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    advance(h, VOICE_CONFIRM_WINDOW_MS + 1);
    await say(live.binding, "確認記住", h);
    expect(await saved()).toBe(false);
    expect(live.call.notices().at(-1)).toContain("確認時間已過");
    live.call.end();

    // 回音：另一則助理逐字稿（不是問句）剛說過確認詞。
    advance(h, 61_000);
    live = await ask(h);
    hear(live.binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    advance(h, 500);
    hear(live.binding, "你只要說確認記住就可以", h);
    advance(h, 1500);
    await say(live.binding, "確認記住", h);
    expect(await saved()).toBe(false);
    live.call.end();

    // 世代改變：問完之後換成 Amy。
    advance(h, 61_000);
    live = await ask(h);
    hear(live.binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    const pendingCard = live.call.cards()[0]!;
    const amy = (await h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] }).profiles.find(p => p.name === "Amy")!.id;
    await selectProfile(h, amy);
    advance(h, 2000);
    await say(live.binding, "確認記住", h);
    expect(await h.service.voiceConfirm(pendingCard)).toEqual({ status: "receipt_expired" });
    expect(await saved()).toBe(false);
  });

  it("review M1: an echo of the question's tail (speech starting before the question finished playing) is not a confirmation", async () => {
    const h = await george();
    const { binding } = await ask(h);
    hear(binding, "要記住：不喝咖啡，記在 George 名下。請說『確認記住』。", h);
    // 喇叭還在播問句尾端，麥克風收到「確認記住」：開口時間早於「問句逐字稿＋CONFIRM_AFTER_MS」。
    advance(h, 300);
    binding.onUserSpeechStart(h.clock.now);
    advance(h, 700);
    await say(binding, "確認記住", h);
    expect((await facts(h)).some(f => f.text === "不喝咖啡")).toBe(false);
    // 有 sideband 的助理音訊結束事件時，以它為準：結束之前開口不算，之後開口才算。
    advance(h, 200);
    binding.onAssistantAudioDone(h.clock.now);
    advance(h, 100);
    binding.onUserSpeechStart(h.clock.now - 200);
    await say(binding, "確認記住", h);
    expect((await facts(h)).some(f => f.text === "不喝咖啡")).toBe(false);
    advance(h, 400);
    await say(binding, "確認記住", h);
    expect((await facts(h)).find(f => f.text === "不喝咖啡")).toMatchObject({ source: "voice_confirmed" });
  });

  it(`review M1: the model saying the phrase by itself (or anything not matching the question) never marks the question read (CONFIRM_AFTER_MS ${CONFIRM_AFTER_MS})`, async () => {
    const h = await george();
    const { call, binding } = await ask(h);
    // 模型沒照念問句，自己說了確認詞，或說了別的話：都不算問句念完。
    hear(binding, "確認記住", h);
    advance(h, 500);
    hear(binding, "好的，要確認記住的話請告訴我", h);
    advance(h, 3000);
    await say(binding, "確認記住", h);
    expect((await facts(h)).some(f => f.text === "不喝咖啡")).toBe(false);
    expect(call.notices().at(-1)).toContain("沒有採用這次的確認");
    // 模型朗讀的「記住，…」只是助理逐字稿，不會被解析成指令（16 M06）；它被麥克風收回來也是回音。
    hear(binding, "記住，我不吃牛肉", h);
    advance(h, 1000);
    await say(binding, "記住，我不吃牛肉", h);
    expect(call.cards()).toHaveLength(1);
  });

  it("review Minor 7: the 3-per-minute limit is per core (a rebuilt call does not reset it) and pick cards count and replace too", async () => {
    const h = await george();
    const token = await manage(h);
    await h.call({ op: "edit", id: null, subject: null, value: "家裡喜歡藍色窗簾", token });
    let live = await startLive(h);
    await say(live.binding, "記住，我不喝咖啡", h);
    await say(live.binding, "忘記藍色", h);
    // 第二張（挑選卡）取代第一張。
    expect(live.call.cards()).toHaveLength(2);
    expect(live.call.cards(false)).toContain(live.call.cards()[0]);
    live.call.end();
    live = await startLive(h, { rebuild: true });
    await say(live.binding, "記住，我喜歡貓", h);
    await say(live.binding, "記住，我喜歡狗", h);
    expect(live.call.cards()).toHaveLength(1);
    expect(live.call.notices().at(-1)).toContain("語音確認卡太多了");
  });

  it("「取消」 voids the card; the on-screen card still works as the alternative and records a click (explicit)", async () => {
    const h = await george();
    let live = await ask(h);
    hear(live.binding, "要記住：不喝咖啡，記在 George 名下。請說確認記住。", h);
    await say(live.binding, "取消", h);
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「好，沒有保存。」");
    expect(await h.service.voiceConfirm(live.call.cards()[0]!)).toEqual({ status: "receipt_expired" });
    live.call.end();
    advance(h, 61_000);
    live = await ask(h);
    const res = await h.call({ op: "card_answer", card: live.call.cards()[0], choice: "confirm" });
    expect(res).toMatchObject({ ok: true, op: "card_answer", chat: null });
    expect((res.receipts as { status: string }[]).map(r => r.status)).toEqual(["saved"]);
    expect((await facts(h)).find(f => f.text === "不喝咖啡")).toMatchObject({ source: "explicit" });
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「已記住。」");
  });

  it("forget by voice: hold first, then commit, then the call carrying memory is revoked and rebuilt (never re-reading the content)", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    await say(binding, "忘記我喜歡藍色", h);
    expect(call.spoken().at(-1)).toBe("（記憶確認）「要忘記『喜歡藍色』這筆記憶。請說『確認忘記』。」");
    hear(binding, "要忘記喜歡藍色這筆記憶。請說確認忘記。", h);
    advance(h, 2000);
    const spokenBefore = call.spoken().length;
    await say(binding, "確認忘記", h);
    await new Promise(r => setTimeout(r, 0));
    expect(call.holds).toEqual([true]);
    expect(call.revokes).toEqual([{ why: "updated", rebuild: true }]);
    expect((await facts(h)).some(f => f.text === "喜歡藍色")).toBe(false);
    // 撤銷之後舊通話沒有再說任何話。
    expect(call.spoken().length).toBe(spokenBefore);
    // 重建的新通話：記憶包不含被忘記的內容。
    const next = await startLive(h, { rebuild: true });
    expect(next.block).toContain("不吃香菜");
    expect(next.block).not.toContain("藍色");
  });
});

describe.skipIf(!realLockAvailable)("face candidate by voice (selection only)", () => {
  async function withCandidate() {
    let candidate: { person_id: string; name: string; at: number } | null = null;
    const identity = { candidate: () => candidate, people: () => [{ person_id: "fam_000000000000000000000001", name: "George", minor: false }] };
    const h = await george({ identity });
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "link_face", profile: status.profiles[0]!.id, person: "fam_000000000000000000000001", token });
    await selectProfile(h, null);
    const set = (value: typeof candidate) => { candidate = value; };
    return { h, set };
  }

  it("asks once after the greeting; an anchored 「是」 within 10 s and the same tracking generation selects and late-attaches the person's pinned memory", async () => {
    const { h, set } = await withCandidate();
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now });
    const { call, binding, block } = await startLive(h, { lookToTalk: true });
    expect(block).toBeNull();
    expect(call.events).toContainEqual(expect.objectContaining({ kind: "memory", reason: "waiting_candidate" }));
    binding.afterGreeting(true);
    expect(call.spoken().at(-1)).toBe("（記憶確認）「這次用 George 的偏好嗎？」");
    hear(binding, "這次用 George 的偏好嗎？", h);
    advance(h, 2000);
    await say(binding, "是的", h);
    await binding.idle();
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected", name: "George" });
    const commentary = call.injected.filter(x => x.channel === "commentary").map(x => x.text).join("\n");
    expect(commentary).toMatch(/^（記憶資料）/);
    expect(commentary).toContain("不吃香菜");
    expect(binding.callerPort()!.blocked()).toBe(true);
  });

  it("review Minor 2: 「是」 counts only after the question was read and finished playing", async () => {
    const { h, set } = await withCandidate();
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true });
    binding.afterGreeting(true);
    advance(h, 3000);
    await say(binding, "是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
    expect(call.notices().at(-1)).toContain("沒有採用這次的回答");
    hear(binding, "這次用 George 的偏好嗎？", h);
    advance(h, 500);
    await say(binding, "是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
    advance(h, 1500);
    await say(binding, "是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected", name: "George" });
  });

  it("a one-character 「好」 is not mistaken for an echo of the greeting 「George，你好」", async () => {
    const { h, set } = await withCandidate();
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now });
    const { binding } = await startLive(h, { lookToTalk: true });
    hear(binding, "George，你好", h);
    binding.afterGreeting(true);
    hear(binding, "這次用 George 的偏好嗎？", h);
    advance(h, 2000);
    await say(binding, "好", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "selected", name: "George" });
  });

  it("does not name the person when the greeting did not; 「不是」 uses household only and is not asked again; late or changed candidates are refused", async () => {
    const { h, set } = await withCandidate();
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now });
    let live = await startLive(h, { lookToTalk: true });
    live.binding.afterGreeting(false);
    hear(live.binding, "這次要用你的偏好嗎？", h);
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「這次要用你的偏好嗎？」");
    advance(h, 2000);
    await say(live.binding, "不是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
    const commentary = live.call.injected.filter(x => x.channel === "commentary").map(x => x.text).join("\n");
    expect(commentary).toContain("家裡週末吃素");
    expect(commentary).not.toContain("香菜");
    live.call.end();
    // 同一個辨識決策不再問。
    live = await startLive(h, { lookToTalk: true });
    live.binding.afterGreeting(true);
    expect(live.call.spoken().some(t => t.includes("偏好"))).toBe(false);
    live.call.end();
    // 新的決策：超過 10 秒才說「是」→ 不選。
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now + 1 });
    live = await startLive(h, { lookToTalk: true });
    live.binding.afterGreeting(true);
    advance(h, CANDIDATE_WINDOW_MS + 1);
    await say(live.binding, "是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
    live.call.end();
    // 追蹤世代改變（候選換成另一個決策）：「是」不選人。
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now + 2 });
    live = await startLive(h, { lookToTalk: true });
    live.binding.afterGreeting(true);
    hear(live.binding, "這次用 George 的偏好嗎？", h);
    set({ person_id: "fam_000000000000000000000001", name: "George", at: h.clock.now + 3 });
    advance(h, 2000);
    await say(live.binding, "是", h);
    expect((await h.call({ op: "status" })).presence).toMatchObject({ state: "unselected" });
    expect(live.call.notices().at(-1)).toContain("候選已失效");
  });
});

describe.skipIf(!realLockAvailable)("revocation table: rebuild or end", () => {
  it.each([
    ["menu selection", async (h: Harness) => { await selectProfile(h, null); }, { why: "presence", rebuild: true }],
    ["multi-face", async (h: Harness) => { await h.call({ op: "suspend", reason: "multi_face" }); }, { why: "suspended", rebuild: true }],
    ["tracking lost", async (h: Harness) => { await h.call({ op: "suspend", reason: "tracking_lost" }); }, { why: "suspended", rebuild: true }],
    ["OS lock", async (h: Harness) => { h.service.suspendAll(); }, { why: "os_lock", rebuild: false }],
    ["navigation or renderer gone", async (h: Harness) => { h.service.closeSessions(); }, { why: "closed", rebuild: false }],
    ["codex consent withdrawn", async (h: Harness) => {
      const token = await manage(h);
      const status = await h.call({ op: "status" }) as unknown as { presence: { profile: string } };
      await h.call({ op: "setup", token, enabled: true, subject: { kind: "profile", profile: status.presence.profile }, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account! }] });
    }, { why: "updated", rebuild: true }],
    ["memory turned off", async (h: Harness) => {
      const token = await manage(h);
      await h.call({ op: "setup", token, enabled: false, subject: { kind: "household" }, allow: [] });
    }, { why: "updated", rebuild: true }],
    ["profile deleted", async (h: Harness) => {
      const token = await manage(h);
      const status = await h.call({ op: "status" }) as unknown as { presence: { profile: string } };
      await h.call({ op: "profile_delete", profile: status.presence.profile, token });
    }, { why: "profile_deleted", rebuild: false }],
  ] as const)("%s", async (_name, trigger, expected) => {
    const h = await george();
    const { call, binding } = await startLive(h);
    await trigger(h);
    await binding.idle();
    await new Promise(r => setTimeout(r, 0));
    expect(call.revokes).toEqual([expected]);
  });

  it("a rebuilt call after withdrawing codex consent carries no memory", async () => {
    const h = await george();
    const { call } = await startLive(h);
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { presence: { profile: string } };
    await h.call({ op: "setup", token, enabled: true, subject: { kind: "profile", profile: status.presence.profile }, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account! }] });
    await h.call({ op: "setup", token, enabled: true, subject: { kind: "household" }, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account! }] });
    expect(call.revokes).toHaveLength(1);
    const next = await startLive(h, { rebuild: true });
    expect(next.block).toBeNull();
    expect(next.call.events).toContainEqual(expect.objectContaining({ kind: "memory", reason: "no_consent" }));
  });

  it("a call without memory is not revoked; a typed 「我是 X」 attaches the new person's pinned memory instead", async () => {
    const h = await george();
    await selectProfile(h, null);
    const token = await manage(h);
    const household = (await h.call({ op: "list", token, subject: null })).facts as MemoryFactView[];
    for (const f of household) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: false, token });
    const { call, binding, block } = await startLive(h);
    expect(block).toBeNull();
    await say(binding, "我是 George", h);
    await binding.idle();
    expect(call.revokes).toEqual([]);
    expect(call.injected.filter(x => x.channel === "commentary").map(x => x.text).join("")).toContain("不吃香菜");
  });
});

describe.skipIf(!realLockAvailable)("delegation block and the inspect card", () => {
  it("blocks delegation only once memory is in the call; the title is the user's own last sideband sentence", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    await say(binding, "幫我寫一份晚餐菜單報告", h);
    const port = binding.callerPort()!;
    expect(port.blocked()).toBe(true);
    port.delegateBlocked("幫我寫一份晚餐菜單報告");
    expect(call.events).toContainEqual({ kind: "delegate_blocked", title: "幫我寫一份晚餐菜單報告" });
  });

  it("「你記得我什麼？」 shows a card (content only via IPC card_view) and tells the model only the count", async () => {
    const h = await george();
    const { call, binding } = await startLive(h);
    await say(binding, "你記得我什麼？", h);
    expect(call.spoken().at(-1)).toBe("（系統通知）已在畫面列出 4 筆記憶。");
    const view = await h.call({ op: "card_view", card: call.cards()[0] });
    expect((view.card as { kind: string; facts: MemoryFactView[] }).facts.map(f => f.text).sort()).toEqual(["不吃香菜", "不喝茶", "喜歡藍色", "家裡週末吃素"].sort());
  });
});
