import { computeProgress, sortForProgress } from "../shared/progress.ts";
import { HOME_COMMANDS } from "../shared/home.ts";
import type { RealtimeBaseInfo, Task } from "../shared/types.ts";
import type { McpServerConfig } from "./config.ts";

// 即時語音的 API key 路徑（OpenAI Realtime GA，語音直接對語音），也是兩條路徑共用的工具表與規則文字。
// 瀏覽器用 WebRTC 直接和 OpenAI 串流音訊，但連線建立（SDP 交換）經過本機核心：用 .env 的 OPENAI_API_KEY
// 先換一把短效的 client secret，再代為送出 SDP。API key 只留在本機核心，不會送到瀏覽器。
// 另一條路徑是 ChatGPT 方案（Codex 登入，gpt-live-1-codex），見 server/live-route.ts。
// 注意：Sign in with ChatGPT（chatgpt-auth.ts）的權杖仍然不能用在即時語音（實測推論會 server_error）；
// 即時語音的方案額度要用 Nous 自己的 Codex 登入（codex-auth.ts）。

const API = "https://api.openai.com/v1";
const RETRIES = 1;

export interface RealtimeOptions {
  apiKey: string | null;
  /** NOUS_REALTIME_MODEL，預設 gpt-realtime。 */
  model: string;
  /** NOUS_REALTIME_VOICE，預設 marin。 */
  voice: string;
  /** 是否提供 web_search 工具（本機核心能用 OPENAI_API_KEY 上網查詢時為 true）。 */
  webSearch?: boolean;
  /** 直接掛到 Realtime 工作階段的遠端 MCP 伺服器；由 OpenAI 端連線並執行。 */
  mcp?: McpServerConfig[];
  /** 背景任務是否能上網（只影響說明文字）。 */
  taskWebSearch?: boolean;
  /** 是否提供 home_status 與 home_control 工具（已設定武陵居中控時為 true）。 */
  home?: boolean;
  fetch?: typeof fetch;
  /** 5xx 重試前的等待（毫秒），測試時設 0。 */
  retryDelayMs?: number;
}

export interface RealtimeCapabilities {
  webSearch: boolean;
  mcp: McpServerConfig[];
  /** 背景任務是否能上網。 */
  taskWebSearch?: boolean;
  /** 能查詢與控制武陵居的家電。 */
  home?: boolean;
}

const WEB_SEARCH_TOOL = {
  type: "function",
  name: "web_search",
  description:
    "上網查即時或最新的資訊：天氣、新聞、股價、匯率、營業時間、交通、賽事、產品規格、最近發生的事等。回傳簡短答案與來源。需要最新資料時一定要用，不要憑記憶回答。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "查詢內容，具體寫出地點與時間（例如「新竹市今天天氣與降雨機率」）" } },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export const HOME_STATUS_TOOL = {
  type: "function",
  name: "home_status",
  description:
    "查武陵居家裡的感測值與設備狀態（溫度、濕度、二氧化碳、PM2.5、設備在不在線等），由家裡的中控回報。這個工具只查詢；要開關或調整家電用 home_control。",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "房間、設備名稱或「全家」，照使用者的說法填（例如「客廳」「客廳主燈」「全家」）" },
      metric: {
        type: "string",
        description: "要查的讀值，可省略",
        enum: ["temperature", "humidity", "co2", "pm25", "pm10", "voc", "formaldehyde", "illuminance", "battery", "power_usage", "energy", "presence", "motion", "leak", "contact"],
      },
    },
    required: ["target"],
    additionalProperties: false,
  },
} as const;

export const HOME_CONTROL_TOOL = {
  type: "function",
  name: "home_control",
  description:
    "控制武陵居家裡的一台設備：開關、亮度、燈的色溫、顏色、音量、靜音、播放／暫停／停止、窗簾；AIFA 冷氣的開關、設定溫度（ac_temperature）、模式、風量、擺風；紅外線家電（電視、電風扇等）按一個遙控鍵（press）。由家裡的中控執行，回傳真實結果：燈、插座等會回讀確認；冷氣與紅外線家電沒有回讀，最多只會「已送出」，不會確認。一次只控制一台；整個房間或全家一起控制還不支援。不是 AIFA 的冷氣（Tuya、Home Assistant）與無線按鈕還不能用語音控制。",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "一台設備的名稱，照使用者的說法填（例如「客廳主燈」「書桌燈」「冷氣」「電視」）；度數、按鍵不要放在這裡" },
      command: {
        type: "string",
        description:
          "power 開關；brightness 亮度；color_temperature 燈的色溫（K，不是冷氣溫度）；color 顏色；volume 音量數字（紅外線家電不能用）；mute 靜音；play／pause／stop 播放控制；cover 窗簾；ac_temperature AIFA 冷氣的設定溫度（攝氏）；ac_mode 冷氣模式；ac_fan 冷氣風量；ac_swing 冷氣擺風；press 紅外線家電按一個遙控鍵",
        enum: [...HOME_COMMANDS],
      },
      value: {
        type: "string",
        description:
          "power／mute：true 或 false；brightness／volume：0 到 100；color_temperature：2500 到 9000；color：#RRGGBB；cover：open、close 或 stop；ac_temperature：攝氏整數，例如 26（通常 17 到 30）；ac_mode：auto、cool 或 dry；ac_fan：auto、low、medium、high、up（調大一格）或 down（調小一格）；ac_swing：auto 或 fixed_1 到 fixed_5；press：power、volume_up、volume_down、mute、channel_up、channel_down、fan_speed、oscillate，或使用者說的按鍵名稱；play／pause／stop 不用填",
      },
    },
    required: ["target", "command"],
    additionalProperties: false,
  },
} as const;

/** 模型可以呼叫的工具：上網查詢由本機核心代查，交辦工作與查詢進度由瀏覽器端用既有的任務 API 處理。 */
export const REALTIME_TOOLS = [
  WEB_SEARCH_TOOL,
  {
    type: "function",
    name: "delegate_task",
    description:
      "把使用者明確要求、需要較長時間產出的工作（寫報告、整理資料、做規劃、比較研究、翻譯長文等）交辦成背景任務。查詢類問題（天氣、新聞、單一事實）用 web_search 直接回答，不要交辦；一般聊天也不要呼叫。",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "任務描述，一句話寫清楚要產出什麼（繁體中文）" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_tasks",
    description: "查詢目前交辦任務的真實狀態與進度。使用者問進度、問做好了沒時呼叫，不要用猜的。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "end_conversation",
    description: "使用者要結束對話（說再見、結束對話、先這樣、不用了）時呼叫；呼叫的同時用一句話道別。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** 依實際可用的能力組出工作階段的工具清單：函式工具＋遠端 MCP 伺服器。 */
export function buildRealtimeTools(caps: RealtimeCapabilities): Record<string, unknown>[] {
  const functions = REALTIME_TOOLS.filter((t) => caps.webSearch || t.name !== "web_search");
  const mcp = caps.mcp.map((server) => ({ type: "mcp", ...server }));
  return [...functions, ...(caps.home ? [HOME_STATUS_TOOL, HOME_CONTROL_TOOL] : []), ...mcp];
}

const STATUS_TEXT: Record<Task["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  succeeded: "已完成",
  failed: "失敗",
  cancelling: "停止中",
  cancelled: "已停止",
};

/** 目前的任務（最多 6 個、含真實進度）；兩條路徑的說明文字共用。 */
export function taskLines(tasks: Iterable<Task>): string[] {
  return sortForProgress(tasks)
    .slice(0, 6)
    .map((t) => {
      const p = computeProgress(t);
      return `- 「${t.title}」：${STATUS_TEXT[t.status]}${p.total === null ? "" : `，${p.done}/${p.total} 步`}`;
    });
}

/**
 * 工具的使用規則（上網查詢、家電、MCP、背景任務）。API key 路徑的語音模型與 ChatGPT 方案路徑的
 * LiveToolCaller 拿到的是同一份文字。
 */
export function realtimeToolRules(caps: RealtimeCapabilities): string[] {
  const abilities: string[] = [];
  if (caps.webSearch) {
    abilities.push(
      "你可以上網：需要即時或最新資訊（天氣、新聞、股價、匯率、營業時間、交通、最近的事）時，立刻呼叫 web_search，不要憑記憶回答。呼叫前先說一句「我查一下」。回答講結論和數字，來源會顯示在畫面上，不用念網址。",
    );
  }
  if (caps.home) {
    abilities.push(
      "你可以查武陵居家裡的狀態：使用者問室內溫度、濕度、空氣品質或設備在不在線時呼叫 home_status，不要用猜的。回答講房間、數字和單位；readings 的 value 是 null 就說「沒有讀值」，不要說 0；data 是「快照」或「過期資料」時，依 time 與 minutes_ago 說是什麼時候、多久前的資料，不要說成現在的值。status 是 ambiguous 時問使用者是哪一個，使用者選了之後 target 照候選名稱一字不差填（包括「（AIFA）」「（紅外線遙控）」）；not_found 就說家裡找不到這個名字；no_such_reading 就說那裡沒有能量這項的設備。",
      "你也可以控制武陵居的家電：使用者要開關或調整一台設備（燈、插座、音響、窗簾）時，先說一句「好，我請中控處理」，再呼叫 home_control，一次一台。依回傳的 status 說話：confirmed 才說已經做好；unconfirmed 是已送出但設備還沒確認，請使用者看一下有沒有反應，不要說成功（why 是 no_reply 時說不確定有沒有執行）；failed 照 message 說沒有成功的原因；refused 表示指令沒有送出，照 message 說；ambiguous 問是哪一台，使用者選了之後 target 照候選名稱一字不差填（包括「（AIFA）」「（紅外線遙控）」），不要自己改寫；not_found 說家裡找不到這個名字。needs_confirmation 時用一句話說要對哪台設備做什麼，請使用者說「確認執行」或「取消」；不要再呼叫 home_control，也不能替使用者確認，結果會用系統通知送來。busy 表示另一張確認卡還沒處理完，這個指令沒有送出：請使用者先回答那張卡，之後再說一次。整個房間或全家一起控制還不支援，請使用者指定一台。color_temperature 是燈的色溫（K），不是冷氣溫度。",
      "AIFA 冷氣：開關用 power；設定溫度用 ac_temperature（「冷氣調 26 度」是 target「冷氣」、value「26」）；模式 ac_mode、風量 ac_fan（「風量調小」是 down）、擺風 ac_swing。「開冷氣 26 度」要呼叫兩次：先 power true，等結果回來再 ac_temperature 26，兩個結果都照說。紅外線家電（電視、電風扇等）：開關用 power、靜音用 mute，其他鍵用 press（「大聲一點」是 press volume_up）；一次只按一下，使用者要按好幾下時，按一下之後請他再說一次。冷氣與紅外線家電沒有回讀，結果不會是 confirmed：why 是 one_way 時說「已送出，請看一下有沒有反應」，不要說已經開了、關了或調好了；有 key 時說按了哪個鍵；toggle 表示按的是切換鍵（電源切換鍵或靜音鍵），按一下切換一次，不能說開了、關了、靜音了或取消靜音了；cloud_no_reply 說雲端沒有回覆、不確定有沒有送出；controller_reported 只能說成「控制器回報…」，那不是冷氣的實際狀態；defaults_used 有內容時要說哪些設定用了預設值；有 note 時照說。關冷氣的 note 提到定時時：AIOS 讀不到定時，不能說確實有定時被取消，也不能說冷氣已經關了。不是 AIFA 的冷氣（Tuya、Home Assistant）與無線按鈕還不能用語音控制，使用者要求時照實說。",
    );
  }
  if (caps.mcp.length) {
    const names = caps.mcp.map((m) => (m.server_description ? `${m.server_label}（${m.server_description}）` : m.server_label));
    abilities.push(
      `你也接上了這些外部服務，可以直接使用它們的工具：${names.join("、")}。需要確認的動作（寄出、發布、刪除等），系統會在畫面顯示確認卡；你用一句話說明要做什麼、對象和影響，請使用者說「確認執行」或「取消」。使用者要說出「確認執行」才會執行，只說「好」不算，你也不能替使用者確認。沒有執行時照實說。`,
    );
  }
  abilities.push(`需要較長時間產出的工作（報告、整理、規劃、研究）交給背景任務${caps.taskWebSearch ? "，背景任務也能上網查資料" : ""}。`);
  return abilities;
}

export function buildRealtimeInstructions(
  tasks: Iterable<Task>,
  now = new Date(),
  caps: RealtimeCapabilities = { webSearch: false, mcp: [] },
): string {
  const list = taskLines(tasks);
  const abilities = realtimeToolRules(caps);
  return [
    "你是 Nous，使用者桌面上的語音助理，正在和使用者即時語音對話。",
    "一律用繁體中文（台灣口音與用語）說話，口語、自然、簡短，通常一到三句。",
    "使用者隨時會插話；被打斷後以使用者的新內容為準，不要重複剛才的話。",
    ...abilities,
    "工具回傳的結果才是事實；工具失敗或查不到時照實說，不確定的事要說是推測。",
    "使用者明確要你做需要較長時間產出的工作時，呼叫 delegate_task 交辦成背景任務，然後用一句話告訴使用者已經開始做、進度會顯示在畫面上。不要自己把長篇內容念出來。",
    "使用者問進度時呼叫 get_tasks，依真實狀態回答；排隊中的任務要說明輪到時會自動開始。",
    "收到以「（系統通知）」開頭的訊息時，用一句話轉告使用者，不要逐字念。",
    "使用者要結束對話時，用一句話道別並呼叫 end_conversation。",
    `今天日期：${now.toISOString().slice(0, 10)}。`,
    list.length ? `目前的任務：\n${list.join("\n")}` : "目前沒有交辦的任務。",
  ].join("\n");
}

/**
 * ChatGPT 方案路徑（gpt-live-1-codex）的語音層說明。這個模型沒有工具：需要做事時交辦（delegation），
 * 由 LiveToolCaller 用同一份工具表執行。改寫自 OpenClaw realtime-quicksilver-instructions.ts:4-10，加上 Nous 的誠實規則。
 */
export function buildLiveInstructions(tasks: Iterable<Task>, now: Date, caps: { mcp: readonly unknown[] }): string {
  const list = taskLines(tasks);
  return [
    "你是 Nous 的語音層，使用者桌面上的語音助理，正在和使用者即時語音對話。你自己沒有任何工具。",
    "一律用繁體中文（台灣口音與用語）說話，口語、自然、簡短，通常一到三句。",
    "使用者隨時會插話；被打斷後以使用者的新內容為準，不要重複剛才的話。",
    "需要做事時（上網查詢、查家裡狀態、控制家電、交辦背景工作、查任務進度、結束對話），一律交辦（delegate），每個請求只交辦一次，等結果回來。",
    "只轉述交辦結果；結果回來之前不能說已經做好、查到或開了（例如不能說「燈開了」）。結果說失敗或不確定時照實說。",
    "交辦結果在 speakable 頻道時，用自己的話自然說出；commentary 頻道是安靜的背景，不要念出來。不要提到交辦、頻道或系統。",
    "使用者說「確認執行」或「取消」時也照樣交辦；你不能替使用者確認任何事。",
    "收到以「（系統通知）」開頭的內容時，用一句話轉告使用者，不要逐字念。",
    "收到以「（開場）」開頭的內容時，只用一句話自然地打招呼並問需要什麼，不要念出或轉述這段內容。",
    "使用者要結束對話（說再見、結束對話、先這樣）時，交辦「結束對話」，並用一句話道別。",
    ...(caps.mcp.length ? ["外部服務（MCP）在 ChatGPT 方案路徑不能用；使用者要求時照實說，需要時請他到設定（macOS App：選單列「即時語音」）把路徑切換到 API key。"] : []),
    `今天日期：${now.toISOString().slice(0, 10)}。`,
    list.length ? `目前的任務：\n${list.join("\n")}` : "目前沒有交辦的任務。",
  ].join("\n");
}

export class RealtimeError extends Error {
  constructor(message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options);
  }
}

export class RealtimeBridge {
  private readonly fetch: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(private readonly options: RealtimeOptions) {
    this.fetch = options.fetch ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }

  private get caps(): RealtimeCapabilities {
    return {
      webSearch: !!this.options.webSearch,
      mcp: this.options.mcp ?? [],
      taskWebSearch: !!this.options.taskWebSearch,
      home: !!this.options.home,
    };
  }

  info(): RealtimeBaseInfo {
    const { webSearch, mcp, home } = this.caps;
    const tools = [webSearch ? "上網查詢" : null, home ? "家電查詢與控制" : null, ...mcp.map((m) => `MCP：${m.server_label}`)]
      .filter(Boolean)
      .join("、");
    return this.options.apiKey
      ? {
          available: true,
          model: this.options.model,
          web_search: webSearch,
          home,
          mcp: mcp.map((m) => m.server_label),
          detail: `OpenAI Realtime（${this.options.model}），使用 .env 的 OPENAI_API_KEY，依用量計費${tools ? `；工具：${tools}` : ""}`,
        }
      : { available: false, model: this.options.model, web_search: false, mcp: [], detail: "未設定 OPENAI_API_KEY（在 .env 填入後重新啟動）" };
  }

  /** 用 API key 建立短效 client secret，代為送出瀏覽器的 SDP offer，回傳 SDP answer。 */
  async connect(offerSdp: string, tasks: Iterable<Task>): Promise<{ sdp: string; model: string }> {
    const { apiKey, model, voice } = this.options;
    if (!apiKey) throw new RealtimeError("尚未設定 OPENAI_API_KEY，無法使用即時語音。", 409);
    const session = {
      type: "realtime",
      model,
      instructions: buildRealtimeInstructions(tasks, new Date(), this.caps),
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: "zh" },
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
          noise_reduction: { type: "near_field" },
        },
        output: { voice },
      },
      tools: buildRealtimeTools(this.caps),
      tool_choice: "auto",
    };
    const minted = await this.request(`${API}/realtime/client_secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session }),
    }, "建立即時語音工作階段");
    const secret = ((await minted.json()) as { value?: string }).value;
    if (!secret) throw new RealtimeError("OpenAI 沒有回傳即時語音的 client secret。", 502);

    const answer = await this.request(`${API}/realtime/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: offerSdp,
    }, "連線即時語音");
    return { sdp: await answer.text(), model };
  }

  private async request(url: string, init: RequestInit, stage: string): Promise<Response> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(url, init);
      } catch (err) {
        if (attempt < RETRIES) continue;
        throw new RealtimeError(`${stage}失敗：無法連線到 OpenAI（網路中斷或被阻擋）。`, 502, { cause: err });
      }
      // OpenAI 偶爾回暫時性的 5xx（實測建立工作階段時出現過），稍等重試一次。
      if (res.status >= 500 && attempt < RETRIES) {
        await res.text().catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      break;
    }
    if (res.ok) return res;
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 200);
    try {
      message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // 保留原文
    }
    if (res.status === 401) throw new RealtimeError(`${stage}失敗：OPENAI_API_KEY 無效或未授權（401）。請檢查 .env 後重新啟動。`, 502);
    if (res.status === 429) throw new RealtimeError(`${stage}失敗：OpenAI 額度不足或超過速率限制（429）：${message}`, 502);
    throw new RealtimeError(`${stage}失敗（HTTP ${res.status}）：${message}`, 502);
  }
}
