import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realtimeTranscription, RealtimeBridge, RealtimeError, ZH_TW_TRANSCRIPTION_PROMPT } from "../server/realtime.ts";
import { convertsLocale, isPromptEcho, SHARED_CHARS, TAIWAN_KEEP, TRADITIONAL_FORMS } from "../shared/zh-tw.ts";
import { matchApproval } from "../shared/approval.ts";
import { taiwanize, taiwanTranscript } from "../shared/zh-tw-opencc.ts";
import { getLocale, setLocale } from "../src/i18n.ts";
import { RealtimeVoice, type RealtimeDeps } from "../src/realtime.ts";
import { PushToTalk, VoiceConversation } from "../src/voice.ts";
import { preloadTaiwan, taiwanText } from "../src/zh-tw.ts";
import { classify } from "../src/intent.ts";
import { AssistantEcho } from "../src/voice-command.ts";

// 語音逐字稿轉成台灣繁體（George 2026-10-31；HIST-1 F1、ID-02 F3／F11）。全部是 fixture：沒有真的麥克風、上游 ASR 或 OpenAI。
// 規則：shared/zh-tw.ts（OpenCC s2tw；有只存在於繁體的字時只換簡體字，否則整句轉；台／念／了解 保留台灣日常寫法）。

afterEach(() => {
  setLocale("zh-TW");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("converter: Simplified → Taiwan Traditional (OpenCC s2tw, two-signal gate)", () => {
  // 審查的探針（scratchpad/zhtw-review/probe*.ts）整理成固定的期望值。
  const SIMPLIFIED: [string, string][] = [
    ["进度如何", "進度如何"], ["看结果", "看結果"], ["对。", "對。"], ["记住，我不吃香菜", "記住，我不吃香菜"], ["准备晚饭", "準備晚飯"],
    ["确认执行", "確認執行"], ["停止任务", "停止任務"], ["帮 George 写一封感谢客户的信", "幫 George 寫一封感謝客戶的信"],
    ["帮我给妈妈发一封邮件", "幫我給媽媽發一封郵件"], ["明天下午三点提醒我开会", "明天下午三點提醒我開會"], ["我的头发太长了", "我的頭髮太長了"],
    ["这个软件的视频打不开", "這個軟件的視頻打不開"], ["请把数据保存到文件夹", "請把數據保存到文件夾"], ["台湾的天气怎么样", "台灣的天氣怎麼樣"],
    ["他在念书", "他在念書"], ["干净的衣服在后面", "乾淨的衣服在後面"], ["皇后吃了面条和面包", "皇后吃了麵條和麵包"],
    ["我发现只有一只猫", "我發現只有一隻貓"], ["钟表店的钟先生", "鐘錶店的鐘先生"], ["你在哪里？里面", "你在哪裡？裡面"],
    ["划船和计划", "划船和計劃"], ["系统的关系，系鞋带", "系統的關係，繫鞋帶"], ["制度和制造", "制度和製造"], ["批准和准确", "批准和準確"],
    ["其余的人", "其餘的人"], ["干杯！干涉", "乾杯！干涉"], ["你还记得我说过什么吗", "你還記得我說過什麼嗎"], ["台风来了", "颱風來了"],
    ["了望台", "瞭望台"], ["这本书很好看", "這本書很好看"], ["打开灯", "打開燈"], ["关掉客厅的灯", "關掉客廳的燈"], ["等着我们", "等著我們"],
    ["后来怎么了", "後來怎麼了"], ["划船比赛很划算", "划船比賽很划算"], ["我了解这个问题", "我了解這個問題"],
    ["张伟和王芳", "張偉和王芳"], ["我叫陈小明", "我叫陳小明"], ["李云龙说", "李雲龍說"], ["郭台铭", "郭台銘"], ["台积电", "台積電"],
    ["明天 3:30 pm 开会 😀", "明天 3:30 pm 開會 😀"], ["发邮件给 Alice@example.com", "發郵件給 Alice@example.com"],
  ];
  // 只有兩邊共用字的短句（舊的閘門會整句略過）：現在整句轉。
  const SHORT: [string, string][] = [
    ["我愿意", "我願意"], ["好极了", "好極了"], ["苹果", "蘋果"], ["万一下雨", "萬一下雨"], ["什么种类", "什麼種類"], ["胜利", "勝利"],
    ["价格多少", "價格多少"], ["广告", "廣告"], ["叶子", "葉子"], ["确定", "確定"], ["准备好了", "準備好了"], ["适合我", "適合我"],
    ["根据天气", "根據天氣"], ["好的，后天", "好的，後天"], ["几点", "幾點"], ["出发吧", "出發吧"], ["面试", "面試"], ["一百万", "一百萬"],
    ["干嘛", "幹嘛"], ["里面有什么", "裡面有什麼"], ["下周一", "下週一"], ["台北几度", "台北幾度"], ["确认", "確認"], ["对", "對"],
    ["这个", "這個"], ["谢谢", "謝謝"], ["挂了", "掛了"], ["采访", "採訪"], ["厘米", "釐米"], ["朴素", "樸素"], ["症状", "症狀"],
    ["卷发", "捲髮"], ["系统", "系統"], ["发烧", "發燒"], ["党", "黨"], ["斗争", "鬥爭"], ["千万", "千萬"], ["面包和蛋糕", "麵包和蛋糕"],
  ];
  const TRADITIONAL = [
    "台灣的天氣怎麼樣", "我了解你的意思", "他在念書", "不要干涉我", "乾杯！", "後面有人", "皇后很美", "一碗面條", "麵包很好吃", "頭髮太長了",
    "我發現只有一隻貓", "鐘錶店的鍾先生", "鄰里之間，裡面", "划船和計劃", "穿著衣服，着急", "系統的關係，繫鞋帶", "制度和製造", "批准和準確",
    "其餘的人，余光中", "幫我寫信給 George", "明天下午三點提醒我開會", "記住我喜歡喝咖啡", "你還記得我說過什麼嗎", "颱風來了", "瞭望台", "什麽事", "這麼好",
    "划船", "頭髮", "划算", "乾淨", "著", "裡", "裏", "着", "這台 Mac", "念完", "若干", "里長", "面試", "只有", "系統", "週末", "計畫", "軟體",
    "影片", "資料", "網路", "列印", "計程車", "捷運", "便當", "機車", "滑鼠", "找之前關於晚餐的成果", "確認執行", "停止任務", "收起",
  ];
  // 繁體句子裡夾一兩個簡體字：只換簡體字（與緊鄰的同一個簡體詞），其他繁體與共用字保留。
  const MIXED: [string, string][] = [
    ["幫我寫信给媽媽", "幫我寫信給媽媽"], ["台灣的天氣怎么樣", "台灣的天氣怎麼樣"], ["鍾先生说他的头發", "鍾先生說他的頭發"], ["余光中说过", "余光中說過"],
    ["不要干涉，说吧", "不要干涉，說吧"], ["吃了麵包，面条也说好", "吃了麵包，麵條也說好"], ["乾杯这里", "乾杯這裡"], ["念書这件事", "念書這件事"],
    ["系統出错了", "系統出錯了"], ["這个钟很準", "這個鐘很準"], ["他着急地说", "他著急地說"], ["台北和台中说", "台北和台中說"],
    ["瞭望台说", "瞭望台說"], ["了望台说", "瞭望台說"], ["只有一只说", "只有一隻說"],
    ["鄰里之間说", "鄰里之間說"], ["他住在里長家附近，说", "他住在里長家附近，說"], ["千里之外说", "千里之外說"], ["乾隆皇后说", "乾隆皇后說"],
    ["余先生说", "余先生說"], ["我姓于，说", "我姓于，說"], ["范先生说", "范先生說"], ["沈先生说", "沈先生說"], ["朴先生说", "朴先生說"],
    ["我們這裡说", "我們這裡說"], ["在後面说", "在後面說"], ["了解说", "了解說"], ["这里的瞭望台", "這裡的瞭望台"],
  ];

  it("converts Simplified transcripts (HIST-1 / ID-02 and the review's sentences)", () => {
    for (const [simplified, traditional] of SIMPLIFIED) expect(taiwanize(simplified), simplified).toBe(traditional);
  });

  it("converts short sentences made only of shared characters (確定／萬一／價格…)", () => {
    for (const [simplified, traditional] of SHORT) expect(taiwanize(simplified), simplified).toBe(traditional);
  });

  it("never changes Traditional input (the review's 27 sentences, edge cases and Taiwan words)", () => {
    for (const text of TRADITIONAL) expect(taiwanize(text), text).toBe(text);
  });

  it("mixed text converts only the Simplified characters; 里長、鄰里、余、于、范、沈、朴、了解 stay", () => {
    for (const [mixed, expected] of MIXED) expect(taiwanize(mixed), mixed).toBe(expected);
  });

  it("names: a shared character after 姓／叫 or before 先生／小姐／太太 stays in whole-Simplified text", () => {
    expect(taiwanize("我叫余小明")).toBe("我叫余小明");
    expect(taiwanize("余先生来了")).toBe("余先生來了");
    expect(taiwanize("范小姐来了")).toBe("范小姐來了");
    expect(taiwanize("姓于")).toBe("姓于");
    expect(taiwanize("其余的人")).toBe("其餘的人");
  });

  it("Taiwan forms: 台／念 kept, 了解 kept but 了望→瞭望, 发布→發布 (not 發佈)", () => {
    expect(taiwanize("台湾")).toBe("台灣");
    expect(taiwanize("念给我听")).toBe("念給我聽");
    expect(taiwanize("我了解")).toBe("我了解");
    expect(taiwanize("了望")).toBe("瞭望");
    expect(taiwanize("发布消息")).toBe("發布消息");
    expect(TAIWAN_KEEP).toEqual({ 台: "臺", 念: "唸" });
  });

  it("Action Gate confirmations spoken in Simplified match shared/approval.ts after conversion", () => {
    for (const phrase of ["确定寄出", "确定送出", "确定付款", "确定发布", "确定执行", "确定删除", "确认执行"]) {
      expect(matchApproval(taiwanize(phrase)), phrase).toBe("approve");
    }
    expect(taiwanize("确定发布")).toBe("確定發布");
  });

  it("is idempotent: converting the output again changes nothing", () => {
    for (const [input] of [...SIMPLIFIED, ...SHORT, ...MIXED]) {
      const once = taiwanize(input);
      expect(taiwanize(once), input).toBe(once);
    }
  });

  it("every Traditional source string in the shared translation catalogs stays byte-for-byte unchanged", () => {
    const keys = ["shared/messages.en.json", "src/messages.en.json", "server/messages.en.json"].flatMap((file) => {
      const catalog = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<string, unknown>;
      return Object.keys(catalog);
    });
    expect(keys.length).toBeGreaterThan(500);
    // HIST-1 F1 的說明故意引用簡體的「进度如何」（說明打字不做簡轉繁）：那一則本來就含簡體字，不算繁體原文。
    const traditional = keys.filter((key) => !key.includes("「进度如何」"));
    expect(keys.length - traditional.length).toBe(1);
    expect(traditional.filter((key) => taiwanize(key) !== key)).toEqual([]);
  });

  it("English, numbers, emoji and other languages are a no-op", () => {
    for (const text of ["search past results for dinner", "Hej, lovs.", "OK 123", "Call George at 0912-345-678", "🎉🎉", "こんにちは", "안녕하세요", "", "   "]) expect(taiwanize(text)).toBe(text);
  });

  it("uses s2tw, not s2twp: Mainland vocabulary keeps the speaker's words (only the characters change)", () => {
    expect(taiwanize("软件")).toBe("軟件");
    expect(taiwanize("视频")).toBe("視頻");
    expect(taiwanize("数据")).toBe("數據");
    expect(taiwanize("打开进度")).toBe("打開進度");
    expect(taiwanize("保存设置")).toBe("保存設置");
  });

  it("known limitation: text with no Simplified-only character and no other clue keeps 着", () => {
    expect(taiwanize("他穿着衣服，着急")).toBe("他穿着衣服，着急");
  });

  it("the character lists are what the rules say", () => {
    expect([...SHARED_CHARS]).toHaveLength(203);
    for (const ch of ["台", "干", "里", "后", "划", "了", "念", "面", "只", "系", "周", "游", "制", "确", "万", "价"]) expect(SHARED_CHARS).toContain(ch);
    for (const ch of ["发", "冲", "这", "们", "说", "对"]) expect(SHARED_CHARS).not.toContain(ch);
    expect(TRADITIONAL_FORMS).toBe("麽緼苧藴輼醖");
  });

  it("drops the transcription prompt echoed back on noise (converted first)", () => {
    expect(isPromptEcho(ZH_TW_TRANSCRIPTION_PROMPT)).toBe(true);
    expect(isPromptEcho(taiwanize("以下是台湾繁体中文（正体字）的对话。"))).toBe(true);
    expect(isPromptEcho("以下是台灣繁體中文")).toBe(true);
    expect(isPromptEcho("以下是台灣繁體中文（正體字）的對話。進度如何")).toBe(true);
    expect(isPromptEcho("以下是")).toBe(false);
    expect(isPromptEcho("台灣繁體中文怎麼說")).toBe(false);
    expect(isPromptEcho("進度如何")).toBe(false);
    expect(isPromptEcho("")).toBe(false);
  });

  it("locale gate: only en is left alone", () => {
    expect(convertsLocale("en")).toBe(false);
    expect(convertsLocale("zh-TW")).toBe(true);
    expect(convertsLocale(undefined)).toBe(true);
    expect(taiwanTranscript("进度如何", "en")).toBe("进度如何");
    expect(taiwanTranscript("进度如何", "zh-TW")).toBe("進度如何");
    expect(taiwanTranscript("进度如何", undefined)).toBe("進度如何");
  });
});

describe("page: taiwanText (lazy OpenCC chunk)", () => {
  it("converts in the zh UI once loaded, and is a no-op in the en UI", async () => {
    await preloadTaiwan();
    expect(getLocale()).toBe("zh-TW");
    expect(taiwanText("看结果")).toBe("看結果");
    expect(taiwanText("看結果")).toBe("看結果");
    setLocale("en");
    expect(taiwanText("看结果")).toBe("看结果");
    expect(taiwanText("看结果", "zh-TW")).toBe("看結果");
  });
});

describe("page: local command matching sees the converted text", () => {
  it("HIST-1 F1 phrases match the local commands after conversion", async () => {
    await preloadTaiwan();
    expect(classify(taiwanText("进度如何"))).toEqual({ kind: "progress" });
    expect(classify(taiwanText("看结果"))).toEqual({ kind: "result" });
    expect(classify(taiwanText("停止任务"))).toEqual({ kind: "stop" });
    expect(classify(taiwanText("找之前关于晚饭的成果"))).toEqual({ kind: "history", query: "晚飯" });
  });

  it("AssistantEcho: assistant partials are accumulated and converted as one text, so a Traditional user echo of a split Simplified phrase still matches", async () => {
    await preloadTaiwan();
    let now = 1_000;
    const echo = new AssistantEcho(() => now);
    echo.notePhase("speaking");
    echo.notePartial("我的头");
    echo.notePartial("发太长了");
    now += 500;
    expect(echo.isEcho("我的頭髮太長了")).toBe(true);
    echo.note("目前没有进行中的任务");
    expect(echo.isEcho("目前沒有進行中的任務")).toBe(true);
    expect(echo.isEcho("新竹天氣如何")).toBe(false);
  });

  it("typed text is never converted: only the speech/transcript producers call the converter", () => {
    const callers = ["src/main.ts", "src/realtime.ts", "src/live-voice.ts", "src/voice.ts", "src/realtime-tools.ts", "src/voice-command.ts", "src/intent.ts", "src/api.ts"].filter((file) =>
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8").includes("taiwanText("));
    // realtime-tools：模型產生的交辦標題；voice-command：回音比對（只比對、不改原文）。都不是使用者打的字。
    expect(callers).toEqual(["src/realtime.ts", "src/live-voice.ts", "src/voice.ts", "src/realtime-tools.ts", "src/voice-command.ts"]);
  });
});

class Recognition {
  static instances: Recognition[] = [];
  lang = "";
  onaudiostart: (() => void) | null = null;
  onaudioend: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  constructor() { Recognition.instances.push(this); }
  start() {}
  stop() {}
  abort() {}
  result(transcript: string, isFinal: boolean) {
    this.results([[transcript, isFinal]]);
  }
  /** 一次送出多段結果（Chrome 會把一句話切成幾段）。 */
  results(parts: [string, boolean][]) {
    this.onresult?.({ resultIndex: 0, results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  }
}

describe("page: Web Speech results (Chrome zh-TW can still return Simplified)", () => {
  it("push-to-talk: interim and final text are Taiwan Traditional in zh; unchanged in en", async () => {
    await preloadTaiwan();
    vi.stubGlobal("window", { SpeechRecognition: Recognition });
    Recognition.instances = [];
    const interim: string[] = [];
    const finals: string[] = [];
    const input = new PushToTalk({ onInterim: (t) => interim.push(t), onFinal: (t) => finals.push(t), onListeningChange: () => {}, onError: () => {} });
    input.start();
    const r = Recognition.instances[0]!;
    expect(r.lang).toBe("zh-TW");
    r.result("进度", false);
    r.result("进度如何", true);
    r.onend?.();
    expect(interim).toEqual(["進度", "進度如何"]);
    expect(finals).toEqual(["進度如何"]);

    // 一句話被切成兩段（我的头｜发太长了）：累積後整段轉換，「头发」→「頭髮」（逐段轉會變成「頭發」）。
    input.start();
    const split = Recognition.instances.at(-1)!;
    split.results([["我的头", false], ["发太长了", false]]);
    expect(interim.at(-1)).toBe("我的頭髮太長了");
    split.results([["我的头", true], ["发太长了", true]]);
    split.onend?.();
    expect(finals.at(-1)).toBe("我的頭髮太長了");

    setLocale("en");
    input.start();
    const en = Recognition.instances.at(-1)!;
    en.result("看结果", true);
    en.onend?.();
    expect(finals.at(-1)).toBe("看结果");
  });

  it("voice mode: a Simplified utterance becomes Traditional; a Simplified echo of Nous's own Traditional speech is still recognized as echo", async () => {
    await preloadTaiwan();
    vi.useFakeTimers();
    vi.stubGlobal("window", { SpeechRecognition: Recognition });
    class Utterance { lang = ""; onend: (() => void) | null = null; onstart: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) {} }
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    vi.stubGlobal("speechSynthesis", { cancel: () => {}, getVoices: () => [], speak: () => {} });
    Recognition.instances = [];
    const utterances: string[] = [];
    const conversation = new VoiceConversation(
      { onUtterance: (t) => utterances.push(t), onInterim() {}, onStateChange() {}, onBargeIn() {}, onClosed() {} },
      { idleMs: 90_000 },
    );
    conversation.start();
    const r = Recognition.instances.at(-1)!;
    r.result("记住，我不吃香菜", true);
    expect(utterances).toEqual(["記住，我不吃香菜"]);

    // Nous 念出（繁體）之後剛結束：麥克風收到同一句的簡體辨識結果，轉換後比對仍是回音，不當成使用者說的話。
    const internals = conversation as unknown as { spoken: string; spokenEndedAt: number };
    internals.spoken = "已經開始準備晚飯的規劃，進度會顯示在畫面上。";
    internals.spokenEndedAt = Date.now();
    r.result("已经开始准备晚饭的规划，进度会显示在画面上", true);
    expect(utterances).toEqual(["記住，我不吃香菜"]);
    conversation.stop();
  });
});

class FakeChannel {
  readyState = "open";
  sent: Record<string, unknown>[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function apiKeyPage() {
  vi.useFakeTimers();
  const channel = new FakeChannel();
  const peer = {
    ontrack: null, onconnectionstatechange: null, connectionState: "new",
    addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
  };
  const track = { stop() {} };
  const deps: RealtimeDeps = {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 answer",
  };
  const user: string[] = [];
  const delegated: string[] = [];
  const assistant: string[] = [];
  const voice = new RealtimeVoice(
    {
      onPhase() {}, onUserTranscript: (t) => user.push(t), onAssistantTranscript: (t) => assistant.push(t),
      onDelegate: async (title: string) => (delegated.push(title), {}), onGetTasks: async () => ({}), onWebSearch: async () => ({}), onHomeStatus: async () => ({}),
      onHomeControl: async () => ({ ok: false, error: "unused" }), onHomeConfirm: async () => ({ ok: false, error: "unused" }),
      onApprovalPrompt() {}, onApprovalResolved() {}, onToolActivity() {}, onClosed() {},
    },
    deps,
    { idleMs: 120_000, approvalMs: 60_000 },
  );
  return { voice, channel, user, assistant, delegated };
}

describe("page: API key data channel", () => {
  it("user and assistant transcripts reach subtitles and local commands as Taiwan Traditional (zh)", async () => {
    await preloadTaiwan();
    const t = apiKeyPage();
    await t.voice.start();
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "进度如何" });
    t.channel.emit({ type: "response.output_audio_transcript.done", transcript: "目前没有进行中的任务。" });
    expect(t.user).toEqual(["進度如何"]);
    expect(t.assistant).toEqual(["目前沒有進行中的任務。"]);
    t.voice.stop();
  });

  it("the transcription prompt echoed back on noise is dropped, not shown or treated as speech", async () => {
    await preloadTaiwan();
    const t = apiKeyPage();
    await t.voice.start();
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "以下是台湾繁体中文（正体字）的对话。" });
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: ZH_TW_TRANSCRIPTION_PROMPT });
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "看结果" });
    expect(t.user).toEqual(["看結果"]);
    t.voice.stop();
  });

  it("a model-generated delegate_task title in Simplified becomes Taiwan Traditional (zh)", async () => {
    await preloadTaiwan();
    const t = apiKeyPage();
    await t.voice.start();
    t.channel.emit({ type: "response.created", response: { id: "r1" } });
    t.channel.emit({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", response_id: "r1", arguments: JSON.stringify({ title: "规划一周晚饭" }) });
    await vi.waitFor(() => expect(t.delegated).toEqual(["規劃一週晚飯"]));
    t.voice.stop();
  });

  it("en UI: transcripts pass through unchanged", async () => {
    await preloadTaiwan();
    setLocale("en");
    const t = apiKeyPage();
    await t.voice.start();
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "进度如何" });
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "show progress" });
    expect(t.user).toEqual(["进度如何", "show progress"]);
    t.voice.stop();
  });
});

type Call = { url: string; init: RequestInit };
function fakeOpenAI(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const transcriptionOf = (call: Call) => JSON.parse(String(call.init.body)).session.audio.input.transcription;

describe("API key session: transcription prompt (zh only, fail-safe)", () => {
  it("zh asks gpt-4o-mini-transcribe for Taiwan Traditional; en carries no prompt", async () => {
    expect(realtimeTranscription("zh-TW")).toEqual({ model: "gpt-4o-mini-transcribe", language: "zh", prompt: ZH_TW_TRANSCRIPTION_PROMPT });
    expect(realtimeTranscription("en")).toEqual({ model: "gpt-4o-mini-transcribe", language: "en" });
    for (const locale of ["zh-TW", "en"] as const) {
      const api = fakeOpenAI([new Response(JSON.stringify({ value: "ek_fixture" }), { status: 200 }), new Response("v=0 answer", { status: 201 })]);
      const bridge = new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: api.fetch });
      await bridge.connect("v=0 offer", [], locale);
      expect(transcriptionOf(api.calls[0]!)).toEqual(realtimeTranscription(locale));
    }
  });

  it("a 400 pointing at the transcription prompt retries once without it; the call still starts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = fakeOpenAI([
      new Response(JSON.stringify({ error: { message: "Unknown parameter", param: "session.audio.input.transcription.prompt" } }), { status: 400 }),
      new Response(JSON.stringify({ value: "ek_fixture" }), { status: 200 }),
      new Response("v=0 answer", { status: 201 }),
    ]);
    const bridge = new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: api.fetch });
    await expect(bridge.connect("v=0 offer", [], "zh-TW")).resolves.toMatchObject({ sdp: "v=0 answer" });
    expect(api.calls.map((c) => c.url.split("/").at(-1))).toEqual(["client_secrets", "client_secrets", "calls"]);
    expect(transcriptionOf(api.calls[0]!).prompt).toBe(ZH_TW_TRANSCRIPTION_PROMPT);
    expect(transcriptionOf(api.calls[1]!)).toEqual({ model: "gpt-4o-mini-transcribe", language: "zh" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain(ZH_TW_TRANSCRIPTION_PROMPT);
    warn.mockRestore();
  });

  it("other 400s are not retried (unchanged error handling)", async () => {
    const api = fakeOpenAI([new Response(JSON.stringify({ error: { message: "bad voice", param: "session.audio.output.voice" } }), { status: 400 })]);
    const bridge = new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: api.fetch });
    const err = await bridge.connect("v=0 offer", [], "zh-TW").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeError);
    expect((err as RealtimeError).rejectedParam).toBe("session.audio.output.voice");
    expect(api.calls).toHaveLength(1);
  });
});
