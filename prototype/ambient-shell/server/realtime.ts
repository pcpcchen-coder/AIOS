import { computeProgress, sortForProgress } from "../shared/progress.ts";
import type { RealtimeInfo, Task } from "../shared/types.ts";
import type { McpServerConfig } from "./config.ts";

// 即時語音模式（OpenAI Realtime，語音直接對語音）：瀏覽器用 WebRTC 直接和 OpenAI 串流音訊，
// 但連線建立（SDP 交換）經過本機核心：用 .env 的 OPENAI_API_KEY 先換一把短效的 client secret，
// 再代為送出 SDP。API key 只留在本機核心，不會送到瀏覽器。
// ChatGPT 方案登入雖然能換到 client secret，實測推論會 server_error，所以這裡只用 API key。

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
  /** 是否提供 home_status 工具（已設定武陵居中控時為 true）。 */
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
  /** 能查武陵居家電狀態（唯讀）。 */
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

const HOME_STATUS_TOOL = {
  type: "function",
  name: "home_status",
  description:
    "查武陵居家裡的感測值與設備狀態（溫度、濕度、二氧化碳、PM2.5、設備在不在線等），由家裡的中控回報。只能查詢，不能控制家電。",
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
  return [...functions, ...(caps.home ? [HOME_STATUS_TOOL] : []), ...mcp];
}

const STATUS_TEXT: Record<Task["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  succeeded: "已完成",
  failed: "失敗",
  cancelling: "停止中",
  cancelled: "已停止",
};

export function buildRealtimeInstructions(
  tasks: Iterable<Task>,
  now = new Date(),
  caps: RealtimeCapabilities = { webSearch: false, mcp: [] },
): string {
  const list = sortForProgress(tasks)
    .slice(0, 6)
    .map((t) => {
      const p = computeProgress(t);
      return `- 「${t.title}」：${STATUS_TEXT[t.status]}${p.total === null ? "" : `，${p.done}/${p.total} 步`}`;
    });
  const abilities: string[] = [];
  if (caps.webSearch) {
    abilities.push(
      "你可以上網：需要即時或最新資訊（天氣、新聞、股價、匯率、營業時間、交通、最近的事）時，立刻呼叫 web_search，不要憑記憶回答。呼叫前先說一句「我查一下」。回答講結論和數字，來源會顯示在畫面上，不用念網址。",
    );
  }
  if (caps.home) {
    abilities.push(
      "你可以查武陵居家裡的狀態：使用者問室內溫度、濕度、空氣品質或設備在不在線時呼叫 home_status，不要用猜的。回答講房間、數字和單位；readings 的 value 是 null 就說「沒有讀值」，不要說 0；data 是「快照」或「過期資料」時，依 time 與 minutes_ago 說是什麼時候、多久前的資料，不要說成現在的值。status 是 ambiguous 時問使用者是哪一個；not_found 就說家裡找不到這個名字；no_such_reading 就說那裡沒有能量這項的設備。目前只能查詢，不能開關或調整家電；使用者要控制家電時，照實說這個功能還沒開放。",
    );
  }
  if (caps.mcp.length) {
    const names = caps.mcp.map((m) => (m.server_description ? `${m.server_label}（${m.server_description}）` : m.server_label));
    abilities.push(
      `你也接上了這些外部服務，可以直接使用它們的工具：${names.join("、")}。需要確認的動作（寄出、發布、刪除等），系統會在畫面顯示確認卡；你用一句話說明要做什麼、對象和影響，請使用者說「確認執行」或「取消」。使用者要說出「確認執行」才會執行，只說「好」不算，你也不能替使用者確認。沒有執行時照實說。`,
    );
  }
  abilities.push(`需要較長時間產出的工作（報告、整理、規劃、研究）交給背景任務${caps.taskWebSearch ? "，背景任務也能上網查資料" : ""}。`);
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

  info(): RealtimeInfo {
    const { webSearch, mcp, home } = this.caps;
    const tools = [webSearch ? "上網查詢" : null, home ? "家電狀態查詢" : null, ...mcp.map((m) => `MCP：${m.server_label}`)]
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
