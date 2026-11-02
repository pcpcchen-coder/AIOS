import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveCoreEvent } from "../shared/realtime-route.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import { CONFIRM_AFTER_MS, declinesDefault, DEFAULT_BACKSTOP_MS, DEFAULT_SELECT_MS, exactVoiceConfirm, exactYesNo, LiveMemoryBinding, VOICE_CONFIRM_WINDOW_MS, type LiveCallPort, type RevokeWhy } from "../server/memory/live.ts";
import { CONTEXT_MAX_BYTES, CONTEXT_MAX_FACTS } from "../server/memory/retrieve.ts";
import { DEFAULT_DECLINE_MS, DEFAULT_GRACE_MS } from "../server/memory/service.ts";
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

/** 記憶預設選人的假計時器：記下要叫醒的工作，fire() 一次叫醒全部（binding 自己用假時鐘判斷時間到了沒）。 */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  readonly timer = (run: () => void, _ms: number): (() => void) => {
    const id = this.next++;
    this.pending.set(id, run);
    return () => { this.pending.delete(id); };
  };
  async fire(binding: LiveMemoryBinding): Promise<void> {
    const runs = [...this.pending.values()];
    this.pending.clear();
    for (const run of runs) run();
    await binding.idle();
    await binding.idle();
  }
}

async function startLive(h: Harness, options: { lookToTalk?: boolean; rebuild?: boolean; timers?: FakeTimers } = {}) {
  const binding = h.service.openLive({ lookToTalk: !!options.lookToTalk, rebuild: !!options.rebuild, now: () => h.clock.now, ...(options.timers ? { timer: options.timers.timer } : {}) });
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

  it("memory default (George 2026-11-02): whole-sentence no; near-misses like 「不是我做的」「不要開燈」 are ordinary sentences", () => {
    for (const text of ["不要不要", "不用不用", "no no", "不要，用全家的", "不要 用全家共用", "No, use the household memory", "please don't", "Please don't.", "全家的就好", "用全家共用好了", "household only", "不，我是說別的", "不要", "不要了", "不用，謝謝", "不是我", "不是我啦", "不對", "不好", "算了", "等一下", "別", "No.", "nope", "Not me", "that's not me", "don't", "wait", "我不是 George", "不是George", "I'm not George", "不要用我的記憶", "別用 George 的記憶", "不用記憶", "換人", "改用全家共用的記憶", "use household memory"]) {
      expect(declinesDefault(text, "George"), text).toBe(true);
    }
    for (const text of ["不要開燈", "全家的晚餐吃什麼", "household chores today", "不用擔心這個", "no problem", "not now, play music", "不是我做的", "不是我說的", "我不是很餓", "不要太辣", "好", "可以", "是", "幫我查天氣", "不是Mary的錯", "等一下再開燈", "no problem", "not now, play music"]) {
      expect(declinesDefault(text, "George"), text).toBe(false);
    }
    expect(declinesDefault("我不是 Mary", "George")).toBe(false);
    expect(declinesDefault("我不是 George", null)).toBe(false);
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

describe.skipIf(!realLockAvailable)("memory default by voice (George 2026-11-02; selection only, no card)", () => {
  const PERSON = "fam_000000000000000000000001";
  async function withCandidate(allow = [CLAUDE, CODEX]) {
    let candidate: { person_id: string; name: string; at: number } | null = null;
    const identity = { candidate: () => candidate, people: () => [{ person_id: PERSON, name: "George", minor: false }] };
    const h = await george({ identity }, allow);
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "link_face", profile: status.profiles[0]!.id, person: PERSON, token });
    await selectProfile(h, null);
    const set = (value: typeof candidate) => { candidate = value; };
    return { h, set, timers: new FakeTimers() };
  }
  const presence = async (h: Harness) => (await h.call({ op: "status" })).presence;
  const commentary = (call: FakeCall) => call.injected.filter(x => x.channel === "commentary").map(x => x.text).join("\n");
  const defaults = (call: FakeCall) => call.events.filter((e): e is Extract<LiveCoreEvent, { kind: "memory_default" }> => e.kind === "memory_default").map(e => e.phase);
  const QUESTION = "（記憶確認）「我要用 George 的記憶，好嗎？」";

  it("asks by voice after the greeting (no card); silence for 8 s after the question finished selects and late-attaches the person's pinned memory", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding, block } = await startLive(h, { lookToTalk: true, timers });
    expect(block).toBeNull();
    expect(call.events).toContainEqual(expect.objectContaining({ kind: "memory", reason: "waiting_candidate" }));
    binding.afterGreeting(true);
    expect(call.spoken().at(-1)).toBe(QUESTION);
    expect(call.cards()).toEqual([]);
    expect(defaults(call)).toEqual(["proposed"]);
    hear(binding, "我要用 George 的記憶，好嗎？", h);
    // 問句逐字稿之後：沒有音訊結束事件時 1.8 秒算播完，再 8 秒。
    advance(h, CONFIRM_AFTER_MS + DEFAULT_SELECT_MS - 1);
    await timers.fire(binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    advance(h, 1);
    await timers.fire(binding);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    expect(defaults(call)).toEqual(["proposed", "selected"]);
    expect(commentary(call)).toMatch(/^（記憶資料）/);
    expect(commentary(call)).toContain("不吃香菜");
    expect(binding.callerPort()!.blocked()).toBe(true);
    expect(h.service.currentPersonId()).toBe(PERSON);
  });

  it("the audio-done event moves the 8 s window; the 12 s backstop selects when the question was never read", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    let live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    hear(live.binding, "我要用 George 的記憶，好嗎？", h);
    advance(h, 3000);
    live.binding.onAssistantAudioDone(h.clock.now);
    advance(h, DEFAULT_SELECT_MS - 1);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    advance(h, 1);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "selected" });
    live.call.end();
    // 一直沒念出：送出後 12 秒。選單改回全家共用＝對預設選定說不要（10 分鐘內不再對 George 預設選人），所以先讓時間過去。
    await selectProfile(h, null);
    advance(h, DEFAULT_DECLINE_MS + 1);
    set({ person_id: PERSON, name: "George", at: h.clock.now + 5 });
    live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    expect(live.call.spoken().at(-1)).toBe(QUESTION);
    advance(h, DEFAULT_BACKSTOP_MS - 1);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    advance(h, 1);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
  });

  it("the next non-no sentence after the question finished selects BEFORE that sentence is processed (it uses George's memory)", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    hear(binding, "我要用 George 的記憶，好嗎？", h);
    // 搶在問句播完之前說的一般的話：不選定，照常處理（只用全家共用）。
    advance(h, 500);
    await say(binding, "今天天氣如何", h);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    advance(h, 2000);
    await say(binding, "記住，我不喝咖啡", h);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    // 這一句用 George 的範圍處理：確認問句記在 George 名下。
    expect(call.spoken().at(-1)).toBe("（記憶確認）「要記住：不喝咖啡，記在 George 名下。請說『確認記住』。」");
    expect(commentary(call)).toContain("不吃香菜");
    // 已選定：計時器不會再做任何事。
    await timers.fire(binding);
    expect(defaults(call)).toEqual(["proposed", "selected"]);
  });

  it("「好」 right after the question selects (not mistaken for an echo of the greeting 「George，你好」)", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { binding } = await startLive(h, { lookToTalk: true, timers });
    hear(binding, "George，你好", h);
    binding.afterGreeting(true);
    hear(binding, "我要用 George 的記憶，好嗎？", h);
    advance(h, 2000);
    await say(binding, "好", h);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
  });

  it("a whole-sentence no counts any time after the question was sent (talk-over ok): household only, said once, not asked again this interaction", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    let live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(false);
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「我要用你的記憶，好嗎？」");
    advance(h, 300);
    await say(live.binding, "不要", h);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「好，這次只用全家共用的記憶。」");
    expect(defaults(live.call)).toEqual(["proposed", "declined"]);
    expect(commentary(live.call)).toContain("家裡週末吃素");
    expect(commentary(live.call)).not.toContain("香菜");
    // 時間到也不選定；這通不再問（聲音候選也不問）。
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(live.binding.voiceCandidate(true)).toBe(false);
    live.call.end();
    // 同一個辨識決策（同一次互動）的下一通也不再問。
    live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    expect(live.call.spoken().some(t => t.includes("記憶，好嗎"))).toBe(false);
  });

  it("near-misses 「不是我做的」「不要開燈」 are not a no: they select and go on as ordinary sentences; 「我不是 George」 is a no", async () => {
    for (const [text, selected] of [["不是我做的", true], ["不要開燈", true], ["我不是 George", false], ["不是我", false]] as const) {
      const { h, set, timers } = await withCandidate();
      set({ person_id: PERSON, name: "George", at: h.clock.now });
      const { binding } = await startLive(h, { lookToTalk: true, timers });
      binding.afterGreeting(true);
      hear(binding, "我要用 George 的記憶，好嗎？", h);
      advance(h, 2000);
      await say(binding, text, h);
      expect(await presence(h), text).toMatchObject({ state: selected ? "selected" : "unselected" });
      await h.close();
    }
  });

  it("「我是 X」 replaces the default: it selects X through the parser instead (not the household sentence)", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    advance(h, 500);
    await say(binding, "我是 George", h);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    expect(call.spoken().some(t => t.includes("全家共用"))).toBe(false);
    expect(defaults(call)).toEqual(["proposed", "declined"]);
  });

  it("selection re-checks the candidate: the camera now sees another family member → 「鏡頭看到的是另一位家人」; a new decision → expired; both use household only", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    let live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    set({ person_id: "fam_000000000000000000000002", name: "Mary", at: h.clock.now });
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(live.call.notices()).toContain("鏡頭看到的是另一位家人，這次只用全家共用的記憶");
    expect(live.call.spoken().at(-1)).toBe("（記憶確認）「鏡頭看到的是另一位家人，這次只用全家共用的記憶。」");
    expect(commentary(live.call)).toContain("家裡週末吃素");
    live.call.end();
    advance(h, DEFAULT_DECLINE_MS + 1);
    set({ person_id: PERSON, name: "George", at: h.clock.now + 1 });
    live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    set({ person_id: PERSON, name: "George", at: h.clock.now + 2 });
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(live.call.notices()).toContain("候選已失效，這次只用全家共用的記憶");
  });

  it("SP-02a: a different voice before selection (IdentityService → voiceDisagrees) cancels the default", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    h.service.voiceDisagrees();
    await binding.idle();
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(call.notices()).toContain("鏡頭和聲音不一致，這次只用全家共用的記憶");
    expect(defaults(call)).toEqual(["proposed", "declined"]);
  });

  it("the call ending inside the window selects nothing", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    call.end();
    await binding.idle();
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(timers.pending.size).toBe(0);
  });

  it("without consent for the route: nothing is spoken; the screen line can say 「不是我」 (card_answer decline); otherwise it selects 8 s after it was shown", async () => {
    const { h, set, timers } = await withCandidate([CLAUDE, CHATGPT]);
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    let live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    expect(live.call.injected).toEqual([]);
    const card = (live.call.events.find(e => e.kind === "memory_default") as { card: string }).card;
    expect(await h.call({ op: "card_view", card })).toMatchObject({ ok: true, card: { kind: "face_candidate", name: "George" }, origin: "live" });
    // 語音的「好」不算（沒有問）。
    advance(h, 2000);
    await say(live.binding, "好", h);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    const declined = await h.call({ op: "card_answer", card, choice: "decline" });
    expect((declined.receipts as { message: string }[])[0]!.message).toBe("這次只用全家共用的記憶");
    await live.binding.idle();
    advance(h, DEFAULT_SELECT_MS);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    expect(defaults(live.call)).toEqual(["proposed", "declined"]);
    live.call.end();
    // 說過不要：這次互動（10 分鐘內）對 George 不再預設選人，新的辨識決策也一樣。
    set({ person_id: PERSON, name: "George", at: h.clock.now + 1 });
    live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    expect(defaults(live.call)).toEqual([]);
    live.call.end();
    advance(h, DEFAULT_DECLINE_MS + 1);
    set({ person_id: PERSON, name: "George", at: h.clock.now + 2 });
    live = await startLive(h, { lookToTalk: true, timers });
    live.binding.afterGreeting(true);
    advance(h, DEFAULT_SELECT_MS);
    await timers.fire(live.binding);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    expect(live.call.injected).toEqual([]);
  });

  it("SP-02b: a voice candidate later in the call is asked once (service.offerVoiceCandidate); the next sentence selects", async () => {
    const { h, set, timers } = await withCandidate();
    const { call, binding } = await startLive(h, { timers });
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    h.service.offerVoiceCandidate(true);
    expect(call.spoken().at(-1)).toBe(QUESTION);
    expect(binding.voiceCandidate(true)).toBe(false);
    hear(binding, "我要用 George 的記憶，好嗎？", h);
    advance(h, 2000);
    await say(binding, "幫我查明天的天氣", h);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    expect(h.service.currentPersonId()).toBe(PERSON);
  });

  it("SP-02b: without the naming permission the question has no name", async () => {
    const { h, set, timers } = await withCandidate();
    const { call } = await startLive(h, { timers });
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    h.service.offerVoiceCandidate(false);
    expect(call.spoken().at(-1)).toBe("（記憶確認）「我要用你的記憶，好嗎？」");
    expect(h.service.currentPersonId()).toBeNull();
  });

  it("SP-02b: no voice candidate question while the opening (look-to-talk / wake) candidate is still pending", async () => {
    const { h, set, timers } = await withCandidate();
    const waiting = await startLive(h, { lookToTalk: true, timers });
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    expect(waiting.binding.voiceCandidate(true)).toBe(false);
  });

  it("review 1: a voice sample of another family member arriving after the default selected (within 10 s) undoes it → household only, mismatch line, not asked again; after 10 s it is only logged", async () => {
    for (const late of [false, true]) {
      const { h, set, timers } = await withCandidate();
      set({ person_id: PERSON, name: "George", at: h.clock.now });
      const { call, binding } = await startLive(h, { lookToTalk: true, timers });
      binding.afterGreeting(true);
      hear(binding, "我要用 George 的記憶，好嗎？", h);
      advance(h, 2000);
      await say(binding, "幫我想晚餐", h);
      expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
      advance(h, late ? DEFAULT_GRACE_MS + 1 : 3000);
      h.service.voiceDisagrees();
      await binding.idle();
      await new Promise(r => setTimeout(r, 0));
      if (late) {
        expect(await presence(h), "after the grace window: G2 log only").toMatchObject({ state: "selected", name: "George" });
      } else {
        expect(await presence(h)).toMatchObject({ state: "unselected" });
        expect(call.notices()).toContain("鏡頭和聲音不一致，這次只用全家共用的記憶");
        expect(defaults(call)).toEqual(["proposed", "selected", "declined"]);
        // 這次互動不再對 George 預設選人（新的決策也一樣）。
        set({ person_id: PERSON, name: "George", at: h.clock.now + 1 });
        const next = await startLive(h, { lookToTalk: true, timers });
        next.binding.afterGreeting(true);
        expect(defaults(next.call)).toEqual([]);
      }
      await h.close();
    }
  });

  it("review 1: the voice mismatch arriving while the selection is in flight cancels it, in both orderings (before the core re-check, and right after it)", async () => {
    for (const order of ["before", "after"] as const) {
      const { h, set, timers } = await withCandidate();
      set({ person_id: PERSON, name: "George", at: h.clock.now });
      const original = h.service.answerLiveCandidate.bind(h.service);
      h.service.answerLiveCandidate = async (card, accept) => {
        if (order === "before") h.service.voiceDisagrees();
        const result = await original(card, accept);
        if (order === "after") h.service.voiceDisagrees();
        return result;
      };
      const { call, binding } = await startLive(h, { lookToTalk: true, timers });
      binding.afterGreeting(true);
      advance(h, DEFAULT_BACKSTOP_MS);
      await timers.fire(binding);
      await new Promise(r => setTimeout(r, 0));
      expect(await presence(h), order).toMatchObject({ state: "unselected" });
      expect(call.notices(), order).toContain("鏡頭和聲音不一致，這次只用全家共用的記憶");
      expect(defaults(call), order).not.toContain("selected");
      expect(defaults(call).at(-1), order).toBe("declined");
      await h.close();
    }
  });

  it("review 4: a no persists for the interaction across a rebuilt call and a new binding (SP-02b ask included)", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const first = await startLive(h, { lookToTalk: true, timers });
    first.binding.afterGreeting(true);
    await say(first.binding, "不要", h);
    first.call.end();
    // 重建的通話與新的聲音決策：不問。
    const rebuilt = await startLive(h, { rebuild: true, timers });
    set({ person_id: PERSON, name: "George", at: h.clock.now + 7 });
    h.service.offerVoiceCandidate(true);
    expect(rebuilt.call.spoken().some(t => t.includes("記憶，好嗎"))).toBe(false);
    rebuilt.call.end();
    // 10 分鐘後（或認出另一位家人、選了某位家人之後）才會再對 George 預設選人。
    advance(h, DEFAULT_DECLINE_MS + 1);
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const later = await startLive(h, { lookToTalk: true, timers });
    later.binding.afterGreeting(true);
    expect(later.call.spoken().at(-1)).toBe(QUESTION);
  });

  it("review 7: a person change or revocation while waiting emits declined so the page line never sticks", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await selectProfile(h, status.profiles[0]!.id);
    await binding.idle();
    expect(defaults(call)).toEqual(["proposed", "declined"]);
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(binding);
    expect(defaults(call)).toEqual(["proposed", "declined"]);
  });

  it("review 9: a route hand-off (close fallback) carries the waiting default to the next binding with the same card and deadline, without asking again", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const first = await startLive(h, { lookToTalk: true, timers });
    first.binding.afterGreeting(true);
    const card = (first.call.events.find(e => e.kind === "memory_default") as { card: string }).card;
    first.binding.handOff();
    first.call.end();
    await first.binding.idle();
    advance(h, 1000);
    const next = await startLive(h, { lookToTalk: true, timers });
    expect(next.call.events).toContainEqual({ kind: "memory_default", card, phase: "proposed" });
    next.binding.afterGreeting(true);
    expect(next.call.spoken().some(t => t.includes("記憶，好嗎"))).toBe(false);
    advance(h, DEFAULT_BACKSTOP_MS - 1000 - 1);
    await timers.fire(next.binding);
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    advance(h, 1);
    await timers.fire(next.binding);
    expect(await presence(h)).toMatchObject({ state: "selected", name: "George" });
    // 一般結束（沒有 handOff）不帶到下一通。
  });

  it("undo later: 「不是我」 by voice after the default selected → household only (the call carrying memory is revoked and rebuilt); no re-ask", async () => {
    const { h, set, timers } = await withCandidate();
    set({ person_id: PERSON, name: "George", at: h.clock.now });
    const { call, binding } = await startLive(h, { lookToTalk: true, timers });
    binding.afterGreeting(true);
    advance(h, DEFAULT_BACKSTOP_MS);
    await timers.fire(binding);
    expect(await presence(h)).toMatchObject({ state: "selected" });
    advance(h, 1000);
    await say(binding, "不是我", h);
    await new Promise(r => setTimeout(r, 0));
    expect(await presence(h)).toMatchObject({ state: "unselected" });
    // 帶著記憶的通話立刻被撤銷（重建的新通話第一句是固定句），所以舊通話不再送提示。
    expect(call.revokes).toEqual([{ why: "presence", rebuild: true }]);
    const next = await startLive(h, { rebuild: true, timers });
    next.binding.afterGreeting(true);
    h.service.offerVoiceCandidate(true);
    expect(next.call.spoken().some(t => t.includes("記憶，好嗎"))).toBe(false);
    // 沒有選定時，「不是我」只是一般的話。
    expect(await h.service.voiceTurn("不是我")).toEqual({ kind: "none" });
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
