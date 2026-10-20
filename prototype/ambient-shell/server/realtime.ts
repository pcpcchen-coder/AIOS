import { computeProgress, sortForProgress } from "../shared/progress.ts";
import type { RealtimeInfo, Task } from "../shared/types.ts";

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
  fetch?: typeof fetch;
  /** 5xx 重試前的等待（毫秒），測試時設 0。 */
  retryDelayMs?: number;
}

/** 模型可以呼叫的工具：交辦工作與查詢進度都由瀏覽器端用既有的任務 API 處理。 */
export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "delegate_task",
    description:
      "把使用者明確要求、需要較長時間產出的工作（寫報告、整理資料、做規劃、翻譯長文等）交辦成背景任務。一般聊天和簡短問答不要呼叫。",
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

const STATUS_TEXT: Record<Task["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  succeeded: "已完成",
  failed: "失敗",
  cancelling: "停止中",
  cancelled: "已停止",
};

export function buildRealtimeInstructions(tasks: Iterable<Task>, now = new Date()): string {
  const list = sortForProgress(tasks)
    .slice(0, 6)
    .map((t) => {
      const p = computeProgress(t);
      return `- 「${t.title}」：${STATUS_TEXT[t.status]}${p.total === null ? "" : `，${p.done}/${p.total} 步`}`;
    });
  return [
    "你是 Nous，使用者桌面上的語音助理，正在和使用者即時語音對話。",
    "一律用繁體中文（台灣口音與用語）說話，口語、自然、簡短，通常一到三句。",
    "使用者隨時會插話；被打斷後以使用者的新內容為準，不要重複剛才的話。",
    "你沒有上網、讀寫檔案或寄信的能力；不確定的事要說是推測，做不到的事直接說。",
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

  info(): RealtimeInfo {
    return this.options.apiKey
      ? { available: true, model: this.options.model, detail: `OpenAI Realtime（${this.options.model}），使用 .env 的 OPENAI_API_KEY，依用量計費` }
      : { available: false, model: this.options.model, detail: "未設定 OPENAI_API_KEY（在 .env 填入後重新啟動）" };
  }

  /** 用 API key 建立短效 client secret，代為送出瀏覽器的 SDP offer，回傳 SDP answer。 */
  async connect(offerSdp: string, tasks: Iterable<Task>): Promise<{ sdp: string; model: string }> {
    const { apiKey, model, voice } = this.options;
    if (!apiKey) throw new RealtimeError("尚未設定 OPENAI_API_KEY，無法使用即時語音。", 409);
    const session = {
      type: "realtime",
      model,
      instructions: buildRealtimeInstructions(tasks),
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: "zh" },
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
          noise_reduction: { type: "near_field" },
        },
        output: { voice },
      },
      tools: REALTIME_TOOLS,
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
