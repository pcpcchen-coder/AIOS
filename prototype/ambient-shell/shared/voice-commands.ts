// 語音／打字指令表的唯一資料來源：/help/commands 頁（server/commands-page.ts、選單列「語音指令表」）與 README 的
// 指令段落都由這裡產生。純資料，不 import src/（核心只打包 shared/）。表沒辦法從正規式推導，所以
// tests/voice-commands.test.ts 把每一句丟進真正的比對函式：結果不同、某條規則／意圖／確認語句／插話詞／模型工具
// 沒有列、或「在哪裡有效」與 LOCAL_ROUTING 推算的不同，測試就失敗。
import { formatSeconds, type SecondsPrefSpec } from "./prefs.ts";
import type { CameraSecondsKey, SecondsKey } from "./seconds-menu.ts";
import { CAMERA_PREFS } from "./sense.ts";
import type { SettingsView } from "./types.ts";
import { VOICE_PREFS } from "./voice-prefs.ts";

type NonEmpty<T> = readonly [T, ...T[]];

/** 一句話進來的四條路徑；值是表格欄名。 */
export const CHANNELS = {
  /** 在輸入框打字送出（即時語音開著時打字也走這裡）。 */
  typed: "打字",
  /** 按一下麥克風說一句（Chrome／Edge）。 */
  push_to_talk: "按麥克風",
  /** 瀏覽器語音模式（VoiceConversation）。 */
  voice_mode: "語音模式",
  /** 即時語音中用說的。 */
  realtime: "即時語音（說）",
} as const;
export type Channel = keyof typeof CHANNELS;
export const CHANNEL_KEYS = Object.keys(CHANNELS) as Channel[];

export type Matcher = "camera" | "intent" | "approval";

/**
 * 每條路徑依序執行哪些本機比對（src/main.ts 的路由；這是表裡唯一手寫的路由事實）：
 * - 打字、按麥克風、語音模式都走 handleCommand：鏡頭規則 → classify；classify 判為一般句子時，
 *   即時語音開著才送給 AI 並檢查確認語句（RealtimeVoice.sendText → checkApproval）。按麥克風與語音模式
 *   不會和即時語音同時開著，所以沒有確認語句。前面的比對認得就不再往下（firstClaimWins），
 *   例外見 alsoSendsText。
 * - 即時語音（說）：逐字稿同時跑鏡頭規則（onUserTranscript → handleCameraCommand）與確認語句（checkApproval），
 *   兩個互不攔截；不跑 classify，這句話也一定會送到 AI。
 */
export interface Routing {
  matchers: readonly Matcher[];
  firstClaimWins: boolean;
  /**
   * classify 認得、處理完仍把原文交給 realtime.sendText 的意圖（即時語音開著時；AI 回答，也會跑 checkApproval）。
   * 這些意圖在 sendText 之前已經 dispatch 了 show.*，確認卡開著時已被換掉而拒絕（main.ts dispatch 的 leftConfirm），
   * 所以 checkApproval 這時已經沒有確認卡可決定：確認語句在這裡不算有效（channelsFor 照樣不算）。
   */
  alsoSendsText?: readonly LocalIntentKind[];
}

export const LOCAL_ROUTING: Record<Channel, Routing> = {
  typed: { matchers: ["camera", "intent", "approval"], firstClaimWins: true, alsoSendsText: ["progress"] },
  push_to_talk: { matchers: ["camera", "intent"], firstClaimWins: true },
  voice_mode: { matchers: ["camera", "intent"], firstClaimWins: true },
  realtime: { matchers: ["camera", "approval"], firstClaimWins: false },
};

/**
 * 打字時會 dispatch show.*（換上進度、設定、成果或通知畫面）的意圖：即時語音確認卡開著時，換掉確認卡就算拒絕。
 * 測試比對 src/main.ts handleCommand 每個 case 是否（直接或經 selectProvider、cancelTask）dispatch show.*。
 */
export const REPLACES_CONFIRM_CARD: readonly LocalIntentKind[] = ["settings", "use_provider", "progress", "result", "stop"];

/** classify 的指令類意圖（不含 empty、task）；測試在編譯期比對 src/intent.ts 的 Intent。 */
export type LocalIntentKind = "voice_on" | "voice_off" | "settings" | "use_provider" | "dismiss" | "stop" | "progress" | "result";
export type Provider = "claude" | "chatgpt" | "mock";
/** 測試在編譯期比對 src/approval.ts 的 ApprovalDecision。 */
export type ApprovalDecision = "approve" | "reject";
/** 即時語音的模型工具；測試在編譯期比對 server/realtime.ts。 */
export type RealtimeToolName = "web_search" | "delegate_task" | "get_tasks" | "end_conversation" | "home_status" | "home_control";

/** 鏡頭規則的效果（CameraCommand 去掉字幕 say）。 */
export type CameraEffect = { preview: boolean } | { set: { active?: boolean; look_to_talk?: boolean; stop_gesture?: boolean } };

/** 比對函式對 says 每一句的實際結果。 */
export type Expect =
  | { matcher: "camera"; effect: CameraEffect }
  | { matcher: "intent"; kind: Exclude<LocalIntentKind, "use_provider"> }
  | { matcher: "intent"; kind: "use_provider"; provider: Provider }
  | { matcher: "approval"; decision: ApprovalDecision };

/** 頁面依目前設定判斷的前提（核心知道的才列；確認卡開著與否核心不知道，只寫文字）。 */
export type Live = "camera_enabled" | "realtime_available" | "realtime_web_search" | "realtime_home";

export interface LocalCommand {
  id: string;
  says: NonEmpty<string>;
  does: string;
  /** 必須等於由 LOCAL_ROUTING 與真正比對結果推算出的路徑（測試）。 */
  works: readonly Channel[];
  needs?: { text: string; live?: Live };
  note?: string;
  expect: Expect;
}

export interface BargeIn {
  says: NonEmpty<string>;
  does: string;
  works: readonly Channel[];
  needs: string;
  note: string;
}

/** 一句話各個比對函式怎麼看；caveat 的每一項都會被測試。 */
export interface Checks {
  camera?: CameraEffect | null;
  intent?: LocalIntentKind | "task";
  approval?: ApprovalDecision | null;
  stopWord?: boolean;
  /** 這些路徑上沒有任何本機比對會處理這句話。 */
  notLocalIn?: readonly Channel[];
}

/** 容易誤會的說法：照實寫實際行為。 */
export interface Caveat {
  id: string;
  cases: NonEmpty<{ says: string; checks: Checks }>;
  truth: string;
}

/** 即時語音中由模型決定的事：不是固定語句，不保證。 */
export interface AskTheAi {
  try: NonEmpty<string>;
  does: string;
  needs: { text: string; live?: Live };
}

export interface Control {
  id: string;
  how: string;
  does: string;
  /** 顯示目前（或預設）的秒數；這裡不寫數字。 */
  seconds?: SecondsKey;
}

const ALL: readonly Channel[] = ["typed", "push_to_talk", "voice_mode", "realtime"];
const HANDLE_COMMAND: readonly Channel[] = ["typed", "push_to_talk", "voice_mode"];
const CAMERA_NEEDS = { text: "需要 .env NOUS_CAMERA=on", live: "camera_enabled" } as const;
const CARD_NEEDS = { text: "只在即時語音的確認卡開著時" } as const;

export const CAMERA_COMMANDS: readonly LocalCommand[] = [
  { id: "preview-off", says: ["收起鏡頭畫面", "關閉鏡頭畫面", "鏡頭畫面收起來"], does: "只收起鏡頭畫面；鏡頭照常運作、不保存", works: ALL,
    expect: { matcher: "camera", effect: { preview: false } } },
  { id: "preview-on", says: ["顯示鏡頭畫面", "看一下鏡頭畫面"], does: "顯示縮小的鏡頭畫面（只在本頁，不寫檔、不外傳）", works: ALL,
    needs: { text: "鏡頭運作中", live: "camera_enabled" }, expect: { matcher: "camera", effect: { preview: true } } },
  { id: "look-off", says: ["關閉看著說話", "看著說話關掉"], does: "關閉看著說話（保存）", works: ALL, needs: CAMERA_NEEDS,
    expect: { matcher: "camera", effect: { set: { look_to_talk: false } } } },
  { id: "look-on", says: ["打開看著說話", "開啟看著說話"], does: "打開看著說話（保存）", works: ALL, needs: CAMERA_NEEDS,
    expect: { matcher: "camera", effect: { set: { look_to_talk: true } } } },
  { id: "palm-off", says: ["關閉手掌停止", "停用停止手勢"], does: "關閉手掌停止播報（保存）", works: ALL, needs: CAMERA_NEEDS,
    note: "即時語音確認卡開著時說，也會拒絕確認卡（見容易誤會）", expect: { matcher: "camera", effect: { set: { stop_gesture: false } } } },
  { id: "palm-on", says: ["打開手掌停止", "啟用停止手勢"], does: "打開手掌停止播報（保存）", works: ALL, needs: CAMERA_NEEDS,
    note: "即時語音確認卡開著時說，也會拒絕確認卡（見容易誤會）", expect: { matcher: "camera", effect: { set: { stop_gesture: true } } } },
  { id: "camera-off", says: ["關掉鏡頭", "鏡頭關起來", "請幫我關掉鏡頭吧"], does: "關閉鏡頭並保存；重新啟動也不會自己打開", works: ALL,
    needs: CAMERA_NEEDS, expect: { matcher: "camera", effect: { set: { active: false } } } },
  { id: "camera-on", says: ["打開鏡頭", "開啟鏡頭"], does: "開啟鏡頭並保存（狀態看右下角指示點）", works: ALL, needs: CAMERA_NEEDS,
    expect: { matcher: "camera", effect: { set: { active: true } } } },
];

export const INTENT_COMMANDS: { readonly [K in LocalIntentKind]: NonEmpty<LocalCommand> } = {
  voice_on: [
    { id: "voice-on", says: ["開啟語音模式", "語音對話", "打開語音模式"], works: HANDLE_COMMAND,
      does: "開始語音對話：有 OPENAI_API_KEY 時是即時語音，否則是瀏覽器語音模式",
      note: "即時語音中打這句沒有變化；語音模式中說，有即時語音時會換成即時語音", expect: { matcher: "intent", kind: "voice_on" } },
  ],
  voice_off: [
    { id: "voice-off", says: ["關閉語音模式", "結束語音對話", "語音模式關掉"], works: HANDLE_COMMAND,
      does: "結束語音模式或即時語音；任務照常", note: "即時語音中要用打的，用說的會交給 AI",
      expect: { matcher: "intent", kind: "voice_off" } },
  ],
  dismiss: [
    { id: "dismiss", says: ["收起", "回桌布", "先這樣", "關閉畫面"], works: HANDLE_COMMAND,
      does: "收起畫面，同時結束語音模式或即時語音；進行中的任務照常在背景執行", expect: { matcher: "intent", kind: "dismiss" } },
  ],
  settings: [
    { id: "settings", says: ["設定", "鏡頭設定", "切換引擎", "打開鏡頭設定"], works: HANDLE_COMMAND,
      does: "打開設定畫面（AI 引擎、語音秒數、鏡頭）", expect: { matcher: "intent", kind: "settings" } },
  ],
  use_provider: [
    { id: "use-claude", says: ["改用 Claude", "換成 Claude"], works: HANDLE_COMMAND, does: "交辦的工作改用 Claude",
      needs: { text: "需要 ANTHROPIC_API_KEY" }, expect: { matcher: "intent", kind: "use_provider", provider: "claude" } },
    { id: "use-chatgpt", says: ["改用 ChatGPT", "用 GPT"], works: HANDLE_COMMAND, does: "交辦的工作改用 ChatGPT",
      needs: { text: "需要先登入 ChatGPT" }, expect: { matcher: "intent", kind: "use_provider", provider: "chatgpt" } },
    { id: "use-mock", says: ["改用模擬模式"], works: HANDLE_COMMAND, does: "改用模擬引擎：假資料，不是真的 AI（開發用）",
      expect: { matcher: "intent", kind: "use_provider", provider: "mock" } },
  ],
  progress: [
    { id: "progress", says: ["進度如何", "做到哪了", "好了沒"], works: HANDLE_COMMAND,
      does: "打開進度畫面（語音模式中也念出真實狀態）；即時語音中打字時另由 AI 查詢後回答", expect: { matcher: "intent", kind: "progress" } },
  ],
  result: [
    { id: "result", says: ["看結果", "給我看成果", "剛才那份"], works: HANDLE_COMMAND,
      does: "打開最近完成的成果；還沒有時會說明", expect: { matcher: "intent", kind: "result" } },
  ],
  stop: [
    { id: "stop", says: ["停止任務", "不要做了", "取消"], works: HANDLE_COMMAND,
      does: "只有一個任務在跑就停止它；有多個時打開進度讓你選；沒有時會說明",
      note: "即時語音中用說的不會停止任務（AI 沒有停止任務的工具）", expect: { matcher: "intent", kind: "stop" } },
  ],
};

export const APPROVAL_COMMANDS: { readonly [D in ApprovalDecision]: NonEmpty<LocalCommand> } = {
  approve: [
    { id: "approve", says: ["確認執行", "確定寄出", "確認發布"], works: ["typed", "realtime"], needs: CARD_NEEDS,
      does: "同意這一次外部動作（寄出、發布…）或家電指令",
      note: "「確認」或「確定」後面要接動作：執行、寄出、送出、寄送、發送、發布、刪除、付款、購買、下單、建立、新增、修改、更新；只說「好」「可以」「確認」不算",
      expect: { matcher: "approval", decision: "approve" } },
  ],
  reject: [
    { id: "reject", says: ["算了", "不要執行", "不同意"], works: ["typed", "realtime"], needs: CARD_NEEDS,
      does: "拒絕這一次外部動作或家電指令", note: "句中有取消、不要、別、算了、停止、不用、不行、不同意、拒絕，一律算拒絕（寧可不做也不誤做）",
      expect: { matcher: "approval", decision: "reject" } },
    { id: "reject-said-cancel", says: ["取消"], works: ["realtime"], needs: CARD_NEEDS,
      does: "拒絕這一次外部動作或家電指令", note: "用打的「取消」先被當成停止任務（見容易誤會）",
      expect: { matcher: "approval", decision: "reject" } },
  ],
};

export const BARGE_IN: BargeIn = {
  says: ["停", "停停", "停一下", "暫停", "先停", "等等", "等一下", "等一等", "stop", "wait"],
  does: "Nous 念回覆時立刻停下來聽你說（不取消任務）",
  works: ["voice_mode"],
  needs: "語音模式中、Nous 正在念回覆時",
  note: "以這些詞開頭也算（「停止任務」「等等我」也會打斷）；此外任何兩個字以上、不像 Nous 自己聲音的話也會打斷。打斷後這句話照一般規則處理。即時語音中直接開口，由 OpenAI 偵測後截斷播放",
};

export const CAVEATS: readonly Caveat[] = [
  { id: "end-conversation", cases: [{ says: "結束對話", checks: { camera: null, intent: "task" } }],
    truth: "不是本機指令。打字、按麥克風或語音模式中會當成一句話交給 AI；即時語音中由 AI 判斷要不要結束（不保證）。要確定結束：點右上角的語音指示、按畫面上的「結束對話」按鈕，或打「關閉語音模式」（語音模式中用說的也可以）" },
  { id: "start-voice", cases: [{ says: "開始語音對話", checks: { camera: null, intent: "task" } }],
    truth: "這是按鈕與選單的名稱，說出或打出來不是指令（會交給 AI）。請說「開啟語音模式」、按畫面上的按鈕，或在 App 按 ⌥⌘V" },
  { id: "goodbye", cases: [{ says: "再見", checks: { camera: null, intent: "task" } }],
    truth: "本機不認。只有即時語音中 AI 可能因此結束對話（由模型判斷）；其他時候會當成一句話交給 AI" },
  { id: "bare-stop", cases: [{ says: "停", checks: { intent: "task", stopWord: true } }],
    truth: "語音模式中 Nous 正在念時會打斷播報；這個字之後仍會當成一句話交給 AI，不會停止任務。要停止任務請說「停止任務」" },
  { id: "english-stop", cases: [{ says: "stop", checks: { intent: "stop", stopWord: true } }],
    truth: "語音模式中先打斷播報，接著當成「停止任務」：有進行中的任務會被停止" },
  { id: "typed-cancel", cases: [{ says: "取消", checks: { intent: "stop", approval: "reject" } }],
    truth: "打字、按麥克風或語音模式中是「停止任務」。即時語音確認卡開著時，用說的才是單純拒絕；用打的會先當成停止任務，停止任務會換上進度或通知畫面，而確認卡被換掉也算拒絕：確認卡被拒絕，有進行中的任務時也會被停止" },
  { id: "palm-rejects-card", cases: [
      { says: "關閉手掌停止", checks: { camera: { set: { stop_gesture: false } }, approval: "reject" } },
      { says: "停用停止手勢", checks: { camera: { set: { stop_gesture: false } }, approval: "reject" } },
      { says: "打開手掌停止", checks: { camera: { set: { stop_gesture: true } }, approval: "reject" } },
      { says: "啟用停止手勢", checks: { camera: { set: { stop_gesture: true } }, approval: "reject" } },
    ],
    truth: "即時語音確認卡開著時說這幾句，除了改手掌停止的設定，也會因為含「停止」而拒絕確認卡。用打的不會（鏡頭規則先處理，不再檢查確認語句）" },
  { id: "camera-in-realtime", cases: [{ says: "關掉鏡頭", checks: { camera: { set: { active: false } }, approval: null } }],
    truth: "即時語音中說鏡頭指令：本機照做，這句話也仍會送到 AI，AI 可能另外回應" },
  { id: "dismiss-ends-voice", cases: [{ says: "收起", checks: { intent: "dismiss" } }],
    truth: "收起畫面的同時也會結束語音模式或即時語音；進行中的任務不會停止（停止任務才會）" },
  { id: "typed-replaces-card", cases: [
      { says: "進度如何", checks: { intent: "progress", approval: null } },
      { says: "設定", checks: { intent: "settings", approval: null } },
      { says: "看結果", checks: { intent: "result", approval: null } },
      { says: "改用 Claude", checks: { intent: "use_provider", approval: null } },
      { says: "停止任務", checks: { intent: "stop", approval: "reject" } },
    ],
    truth: "即時語音確認卡開著時打這些字：會換上進度、設定、成果或通知畫面，確認卡被換掉就算拒絕，外部動作不執行（即使這句話本身不是確認或取消的說法）。要同意請打或說「確認執行」等確認語句" },
  { id: "realtime-not-local", cases: [
      { says: "停止任務", checks: { intent: "stop", approval: "reject" } },
      { says: "進度如何", checks: { intent: "progress", notLocalIn: ["realtime"] } },
      { says: "收起", checks: { intent: "dismiss", notLocalIn: ["realtime"] } },
    ],
    truth: "即時語音中用說的，這些都不在本機處理，會交給 AI：問進度 AI 會查真實狀態回答；AI 沒有停止任務或收起畫面的工具。要停止任務，請打「停止任務」或按進度畫面上的停止按鈕；要收起，請打「收起」、按 Esc 或點畫面上的按鈕。Esc 只會打斷說話或收起畫面，不會停止任務。確認卡開著時，含「停止」的話會拒絕確認卡" },
  { id: "home-confirm-with-stop", cases: [{ says: "確認執行停止播放", checks: { approval: "reject" } }],
    truth: "確認卡開著時，這句話因為含「停止」而算取消，家電指令不會執行。要同意只說「確認執行」，不要把動作接在後面" },
  { id: "card-ok-is-not-yes", cases: [{ says: "好", checks: { approval: null, camera: null } }],
    truth: "確認卡開著時只說「好」不算同意，也不算取消：指令不會送出，確認卡繼續等你說「確認執行」或「取消」，60 秒後自動取消" },
  { id: "home-aircon", cases: [{ says: "冷氣調 26 度", checks: { camera: null, approval: null, notLocalIn: ["realtime"] } }],
    truth: "不是本機指令，會交給 AI。AIFA 冷氣：先讀控制器記得的設定再送出 26 度，讀不到的項目用預設值並說出來；冷氣不會回報，所以只會說「已送出，請確認」，不會說調好了，冷氣關著時也不代表會開機（要開請說「開冷氣」）。紅外線遙控的冷氣只能按它的遙控鍵；色溫（2500–9000 K）只用在燈" },
  { id: "home-room-wide", cases: [{ says: "客廳的燈全部關掉", checks: { camera: null, approval: null, notLocalIn: ["realtime"] } }],
    truth: "一次只控制一台：說整個房間或「全部」時，AI 會問你是哪一台，不會一次關掉整個房間" },
  { id: "substring-progress", cases: [{ says: "交通狀況如何", checks: { camera: null, intent: "progress" } }],
    truth: "14 個字以內、句中有「進度」「狀態」「狀況」「好了沒」「做到哪」等詞（又沒有寫、整理、規劃等交辦動詞）就算查進度：例如「交通狀況如何」會打開進度，不會交給 AI。想問 AI 請把句子說完整，或用即時語音" },
  { id: "substring-result", cases: [{ says: "比賽結果", checks: { camera: null, intent: "result" } }],
    truth: "同樣地，短句中有「結果」「成果」「給我看」「拿出來」等詞就算看成果：例如「比賽結果」會打開最近的成果，不會交給 AI" },
];

export const ASK_THE_AI: { readonly [T in RealtimeToolName]: AskTheAi } = {
  end_conversation: { try: ["再見", "結束對話", "先這樣", "不用了"], does: "AI 判斷你要結束時道別並結束即時語音（不保證每次都結束）；ChatGPT 方案路徑上整句只說「再見」「掰掰」「拜拜」「結束對話」時，Nous 也會在道別念完後結束（備援）",
    needs: { text: "即時語音", live: "realtime_available" } },
  get_tasks: { try: ["任務做好了沒", "報告寫到哪了"], does: "AI 查詢真實任務狀態後用說的回答", needs: { text: "即時語音", live: "realtime_available" } },
  web_search: { try: ["新竹今天會下雨嗎"], does: "AI 上網查詢後回答，字幕顯示來源", needs: { text: "即時語音與上網查詢（ChatGPT 方案路徑用 Codex 額度；API key 路徑需要 OPENAI_API_KEY）", live: "realtime_web_search" } },
  delegate_task: { try: ["幫我寫一份下週出差規劃"], does: "AI 判斷是較長的工作時交辦成背景任務，進度顯示在電子腦下方",
    needs: { text: "即時語音", live: "realtime_available" } },
  home_status: { try: ["客廳現在幾度"], does: "查武陵居的感測值與設備狀態",
    needs: { text: "即時語音與武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）", live: "realtime_home" } },
  home_control: { try: ["客廳主燈關掉", "書桌燈調到 60%", "色溫調到 3000K", "冷氣調 26 度", "電視大聲一點"],
    does: "請中控控制一台家電，照中控的回讀說結果：確認了才說好了；「已送出、未確認」要你看一下，不算成功。AIFA 冷氣（開關、溫度、模式、風量）與紅外線家電（一次按一個遙控鍵）沒有回讀，只會說「已送出，請確認」。一次一台",
    needs: { text: "即時語音與武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）", live: "realtime_home" } },
};

export const CONTROLS: readonly Control[] = [
  { id: "esc", how: "Esc", does: "即時語音 Nous 說話時：打斷（ChatGPT 方案路徑沒有取消回覆的指令，只會把這段回覆靜音）；即時語音中有畫面開著：只收起畫面；語音模式念回覆時：打斷；其他時候：收起畫面並結束語音" },
  { id: "voice-pill", how: "點右上角的語音指示", does: "結束語音模式或即時語音" },
  { id: "palm", how: "舉起張開的手掌", does: "停止 Nous 說話，不取消任務（需要鏡頭與「手掌停止播報」）" },
  { id: "look", how: "面向螢幕", does: "看著說話：面向這麼久之後自動開始即時語音（需要鏡頭與即時語音，而且這個視窗之前已同意過即時語音的說明；沒同意過不會自動開始，請先按「開始語音對話」同意一次）", seconds: "look_to_talk_s" },
  { id: "look-cooldown", how: "對話結束後", does: "這段時間內看著說話不再自動開始", seconds: "look_to_talk_cooldown_s" },
  { id: "voice-idle", how: "語音模式沒說話", does: "自動關閉語音模式（Nous 等回覆、念回覆時不計時）", seconds: "voice_idle_s" },
  { id: "realtime-idle", how: "即時語音沒說話", does: "自動結束即時語音，避免持續計費或用掉方案額度（Nous 回覆、查資料、等確認時不計時）", seconds: "realtime_idle_s" },
  { id: "app-window", how: "⌥⌘N（App）", does: "叫出／收起視窗" },
  { id: "app-voice", how: "⌥⌘V（App）", does: "開始／結束語音對話" },
  { id: "app-commands", how: "⌘/（App）", does: "打開這張語音指令表" },
];

/** 頁面依目前設定加註；README 不帶（null）。 */
export interface CommandContext {
  cameraEnabled: boolean;
  realtimeAvailable: boolean;
  webSearch: boolean;
  home: boolean;
  seconds: Partial<Record<SecondsKey, number>>;
}

export function commandContext(view: SettingsView): CommandContext {
  return {
    cameraEnabled: !!view.camera?.enabled,
    realtimeAvailable: !!view.realtime?.available,
    webSearch: !!view.realtime?.available && !!view.realtime.web_search,
    home: !!view.realtime?.available && !!view.realtime.home,
    seconds: Object.fromEntries((view.seconds ?? []).map((row) => [row.key, row.value])),
  };
}

export interface TableRow {
  id: string;
  cells: string[];
  /** 目前不成立的前提（「目前：鏡頭未啟用」）；README 一律 null。 */
  unmet: string | null;
}

export interface TableSection {
  id: string;
  title: string;
  intro: string | null;
  columns: string[];
  rows: TableRow[];
}

export const COMMANDS_INTRO =
  "這張表由程式產生，測試會把每一句丟進本機的比對規則確認結果（tests/voice-commands.test.ts）。" +
  "打字＝在輸入框打字（即時語音開著時打字也算）；按麥克風＝按一下麥克風說一句（Chrome／Edge）；語音模式＝瀏覽器語音模式；" +
  "即時語音（說）＝即時語音中用說的。macOS App 沒有瀏覽器語音辨識，只有打字與即時語音。";

const LOCAL_COLUMNS = ["你可以說", "會做什麼", ...CHANNEL_KEYS.map((c) => CHANNELS[c]), "條件與注意"];

function quote(phrases: readonly string[]): string {
  return phrases.map((p) => `「${p}」`).join("");
}

function unmet(live: Live | undefined, ctx: CommandContext | null): string | null {
  if (!ctx || !live) return null;
  if (live === "camera_enabled") return ctx.cameraEnabled ? null : "目前：鏡頭未啟用";
  if (live === "realtime_available") return ctx.realtimeAvailable ? null : "目前：即時語音不可用";
  if (live === "realtime_web_search") return ctx.webSearch ? null : "目前：上網查詢不可用";
  return ctx.home ? null : "目前：未設定武陵居中控";
}

function localRow(row: LocalCommand, ctx: CommandContext | null): TableRow {
  const notes = [row.needs?.text, row.note].filter(Boolean).join("；");
  return {
    id: row.id,
    cells: [quote(row.says), row.does, ...CHANNEL_KEYS.map((c) => (row.works.includes(c) ? "✓" : "—")), notes],
    unmet: unmet(row.needs?.live, ctx),
  };
}

function secondsText(key: SecondsKey, ctx: CommandContext | null): string {
  const spec: SecondsPrefSpec = key in VOICE_PREFS ? VOICE_PREFS[key as keyof typeof VOICE_PREFS] : CAMERA_PREFS[key as CameraSecondsKey];
  const current = ctx?.seconds[key];
  const where = "選單列「秒數設定」或設定畫面可調";
  return current === undefined
    ? `預設 ${formatSeconds(spec.default)}，${where}`
    : `目前 ${formatSeconds(current)}（預設 ${formatSeconds(spec.default)}），${where}`;
}

/** 表的段落，依固定順序；頁面與 README 共用。ctx 為 null 時不加註目前狀態。 */
export function commandSections(ctx: CommandContext | null): TableSection[] {
  const intents = INTENT_COMMANDS;
  return [
    { id: "camera", title: "鏡頭", intro: "可以加客氣話（請、幫我…吧）；否定與問句（「不要打開鏡頭」「鏡頭怎麼關」）不算指令。", columns: LOCAL_COLUMNS,
      rows: CAMERA_COMMANDS.map((r) => localRow(r, ctx)) },
    { id: "conversation", title: "對話與畫面", intro: "只認 14 個字以內、沒有交辦動詞的短句。", columns: LOCAL_COLUMNS,
      rows: [...intents.voice_on, ...intents.voice_off, ...intents.dismiss, ...intents.settings, ...intents.use_provider].map((r) => localRow(r, ctx)) },
    { id: "tasks", title: "任務", intro: null, columns: LOCAL_COLUMNS,
      rows: [...intents.progress, ...intents.result, ...intents.stop].map((r) => localRow(r, ctx)) },
    { id: "approval", title: "外部動作確認", intro: "外部服務要寄出、發布等動作，或中控設為需要確認的家電時，出現確認卡；由本機固定語句判斷，不由 AI 轉述。60 秒沒回應或收起確認卡都不執行。家電確認卡要等中控提供每台設備的語音設定（H2）才會出現，目前家電一律直接執行。", columns: LOCAL_COLUMNS,
      rows: [...APPROVAL_COMMANDS.approve, ...APPROVAL_COMMANDS.reject].map((r) => localRow(r, ctx)) },
    { id: "barge-in", title: "插話", intro: null, columns: LOCAL_COLUMNS,
      rows: [{ id: "barge-in", unmet: null,
        cells: [quote(BARGE_IN.says), BARGE_IN.does, ...CHANNEL_KEYS.map((c) => (BARGE_IN.works.includes(c) ? "✓" : "—")), `${BARGE_IN.needs}；${BARGE_IN.note}`] }] },
    { id: "caveats", title: "容易誤會", intro: "每一句的比對結果都由測試確認。", columns: ["這句話", "實際上會怎樣"],
      rows: CAVEATS.map((c) => ({ id: c.id, cells: [quote([...new Set(c.cases.map((x) => x.says))]), c.truth], unmet: null })) },
    { id: "ask", title: "可以問 AI（即時語音，由模型判斷，不保證）", intro: "這些不是固定語句：AI 依你的意思決定要不要用對應的工具。", columns: ["可以這樣問", "AI 可能會做什麼", "條件"],
      rows: (Object.keys(ASK_THE_AI) as RealtimeToolName[]).map((tool) => {
        const row = ASK_THE_AI[tool];
        return { id: `ai-${tool}`, cells: [quote(row.try), row.does, `需要${row.needs.text}`], unmet: unmet(row.needs.live, ctx) };
      }) },
    { id: "controls", title: "不用說話", intro: null, columns: ["操作", "作用"],
      rows: CONTROLS.map((c) => ({ id: c.id, cells: [c.how, c.seconds ? `${c.does}；${secondsText(c.seconds, ctx)}` : c.does], unmet: null })) },
  ];
}

export const COMMANDS_BEGIN = "<!-- voice-commands:begin（由 shared/voice-commands.ts 產生：npm run docs:commands；請勿手改） -->";
export const COMMANDS_END = "<!-- voice-commands:end -->";

/** README 的指令段落（不含目前狀態）。 */
export function renderCommandsMarkdown(): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const lines: string[] = [COMMANDS_INTRO, ""];
  for (const section of commandSections(null)) {
    lines.push(`#### ${section.title}`, "");
    if (section.intro) lines.push(section.intro, "");
    lines.push(`| ${section.columns.map(cell).join(" | ")} |`, `|${section.columns.map(() => "---").join("|")}|`);
    for (const row of section.rows) lines.push(`| ${row.cells.map(cell).join(" | ")} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
