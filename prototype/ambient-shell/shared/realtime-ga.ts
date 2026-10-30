// MEM-3：OpenAI Realtime GA 事件的正規化（純函式；核心的旁路 server/apikey-call.ts 用，測試也用）。
// 只取記憶與工具需要的欄位，每個事件都帶來源標記：
//  - asr：上游語音辨識依麥克風音訊產生的使用者逐字稿（conversation.item.input_audio_transcription.completed）。
//    這是 API key 路徑上唯一被當成「使用者說的話」的來源；頁面與生成 UI 偽造不了，只能影響進到麥克風的聲音。
//  - assistant：模型自己念出的話（response.output_audio_transcript.done）。
//  - typed：資料通道上由頁面送出的 user 文字項目（打字、系統通知、注入的訊息）：一律不解析成記憶指令（和 MEM-2 打字不解析一致）。
//  - system：system 角色的對話項目（核心或頁面補的背景資料）。
// MEM-5 的自動整理只能從 asr 取候選；現在先把來源分開。session.* 只回傳類型，不帶 instructions 或任何內容。

/** 事件的來源標記。 */
export type GaSource = "asr" | "assistant" | "typed" | "system";

export type GaEvent =
  /** session.created／session.updated：只有類型，不含 instructions、工具或記憶區塊。 */
  | { kind: "session"; phase: "created" | "updated" }
  | { kind: "speech_started" }
  /** input_audio_buffer.committed：麥克風音訊緩衝被提交成一個使用者項目（只有這種項目的語音辨識逐字稿才算使用者語音）。 */
  | { kind: "committed"; item_id: string | null }
  /** 使用者語音辨識完成（source 一定是 asr）。 */
  | { kind: "user_final"; source: "asr"; text: string; item_id: string | null }
  /** 模型的語音逐字稿（source 一定是 assistant）。 */
  | { kind: "assistant_final"; source: "assistant"; text: string; item_id: string | null }
  /** 對話項目被加入（不帶內容）：typed／system 只用來說明它不是語音。 */
  | { kind: "item_added"; source: GaSource; item_id: string | null }
  /** core_tag：MEM-4b 核心自己送出的 response.create 帶的 response.metadata.nous_trigger（上游在 response 物件回送）；頁面或伺服器 VAD 觸發的是 null。 */
  | { kind: "response"; phase: "created" | "done"; response_id: string | null; core_tag: string | null }
  | { kind: "audio"; phase: "started" | "stopped" | "cleared" }
  /** response_id：MEM-4b 用來找出觸發這個回應的使用者項目（只有那一句的語音辨識逐字稿能當交辦原句）。 */
  | { kind: "function_call"; name: string; call_id: string; arguments: string; response_id: string | null }
  /** event_id：上游指出是哪一個用戶端事件出錯（核心只處理自己送出的事件的錯誤）。 */
  | { kind: "error"; code: string | null; message: string; event_id: string | null };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** 一個 GA 事件（已 JSON.parse）→ 正規化事件；不認得或不需要的回 null。 */
export function parseGaEvent(raw: unknown): GaEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  const type = str(event.type);
  if (!type) return null;
  switch (type) {
    case "session.created":
      return { kind: "session", phase: "created" };
    case "session.updated":
      return { kind: "session", phase: "updated" };
    case "input_audio_buffer.speech_started":
      return { kind: "speech_started" };
    case "input_audio_buffer.committed":
      return { kind: "committed", item_id: str(event.item_id) };
    case "conversation.item.input_audio_transcription.completed": {
      const text = str(event.transcript);
      return text === null ? null : { kind: "user_final", source: "asr", text, item_id: str(event.item_id) };
    }
    case "response.output_audio_transcript.done": {
      const text = str(event.transcript);
      return text === null ? null : { kind: "assistant_final", source: "assistant", text, item_id: str(event.item_id) };
    }
    case "conversation.item.added":
    case "conversation.item.created": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return null;
      const role = str(item.role);
      const content = Array.isArray(item.content) ? (item.content as { type?: unknown }[]) : [];
      // user 角色的文字項目只可能來自資料通道或旁路的 conversation.item.create（打字、通知、注入），不是語音。
      const source: GaSource | null = role === "system" ? "system"
        : role === "user" && content.some((c) => c?.type === "input_text") ? "typed"
          : role === "assistant" ? "assistant" : null;
      return source ? { kind: "item_added", source, item_id: str(item.id) } : null;
    }
    case "response.created":
    case "response.done": {
      const response = event.response as Record<string, unknown> | undefined;
      const metadata = response?.metadata as Record<string, unknown> | undefined;
      return { kind: "response", phase: type === "response.created" ? "created" : "done", response_id: str(response?.id), core_tag: metadata && typeof metadata === "object" ? str(metadata.nous_trigger) : null };
    }
    case "output_audio_buffer.started":
      return { kind: "audio", phase: "started" };
    case "output_audio_buffer.stopped":
      return { kind: "audio", phase: "stopped" };
    case "output_audio_buffer.cleared":
      return { kind: "audio", phase: "cleared" };
    case "response.function_call_arguments.done": {
      const name = str(event.name);
      const callId = str(event.call_id);
      return name && callId ? { kind: "function_call", name, call_id: callId, arguments: str(event.arguments) ?? "{}", response_id: str(event.response_id) } : null;
    }
    case "error": {
      const error = event.error as Record<string, unknown> | undefined;
      return { kind: "error", code: str(error?.code), message: str(error?.message) ?? "", event_id: str(error?.event_id) };
    }
    default:
      return null;
  }
}
