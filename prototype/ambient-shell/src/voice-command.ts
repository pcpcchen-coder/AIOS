import { normalizeSpeech } from "./echo.ts";
import { classify, normalizeCommand } from "./intent.ts";
import { taiwanText } from "./zh-tw.ts";
import type { ShellEvent } from "./shell-state.ts";

// HIST-1 Mac F1：即時語音中，使用者自己說的「進度如何」「看結果」「搜尋成果 晚餐」「收起」由 Nous 在本機處理，
// 和打字同樣打開畫面（user_request＋真實的 request id），這一輪不讓模型另外回答。
//
// 只用使用者自己的 final 逐字稿（RealtimeCallbacks.onLocalCommand；未完成的逐字稿、助理逐字稿都不會進來），
// 先把簡體折成繁體（上游 ASR 常給簡體：「进度如何」），再交給既有的 classify；classify 認得之後，還要整句符合
// 這裡更窄的說法（整句就是指令，不是含這些字的長句）。認不出、可能是回音或有疑問時一律回 null，照舊交給模型。
// 只開或關畫面：不停止任務（「停止」「取消」照舊不在這裡）、不換引擎、不改設定，也不結束通話（「收起」只關畫面）。
// 模型工具不能打開任何 Surface；這裡是頁面依使用者逐字稿決定（HIST-1 的規則不變）。

export type VoiceCommand =
  | { kind: "progress" }
  | { kind: "result" }
  /** query 取自原本的逐字稿（簡體也保留原字，搜尋本身會折疊）；空字串是列出全部。 */
  | { kind: "history"; query: string }
  | { kind: "dismiss" };

export type VoiceCommandKind = VoiceCommand["kind"];
export const VOICE_COMMAND_KINDS: readonly VoiceCommandKind[] = ["progress", "result", "history", "dismiss"];

/** 整句超過這個長度（碼位）就不當指令（「搜尋成果 晚餐」7 個字；長句交給模型）。英文（全是 ASCII）另算。 */
export const VOICE_COMMAND_MAX_CHARS = 24;
export const VOICE_COMMAND_MAX_CHARS_EN = 60;
/** 成果紀錄的查詢詞上限（碼位）；英文另算。 */
export const VOICE_HISTORY_QUERY_MAX = 16;
export const VOICE_HISTORY_QUERY_MAX_EN = 40;

/**
 * 指令說法裡會出現的簡體字 → 繁體（一對一、都在 BMP，所以長度不變，查詢詞的位置可以直接對回原文）。
 * 只用於比對，不改原文、不保存。一對多的字（划、制、准、里、于）只折成指令說法用到的那一個。
 */
const VOICE_S2T: Record<string, string> = Object.fromEntries([
  "进進", "结結", "么麼", "样樣", "吗嗎", "没沒", "录錄", "纪紀", "记記", "寻尋", "关關", "闭閉", "画畫", "来來", "显顯",
  "开開", "启啟", "给給", "刚剛", "这這", "过過", "状狀", "态態", "况況", "务務", "现現", "历歷", "办辦", "询詢", "于於",
  "里裡", "视視", "隐隱", "设設", "镜鏡", "头頭", "写寫", "规規", "划劃", "产產", "拟擬", "计計", "译譯", "较較", "制製",
  "准準", "备備", "总總", "后後", "着著", "并並", "帮幫", "请請", "烦煩", "别別", "终終", "个個", "语語", "对對", "话話",
  "动動", "换換", "离離", "报報", "儿兒", "论論", "运運", "达達", "问問", "们們", "时時", "说說", "还還", "听聽",
].map((pair) => [pair[0]!, pair.slice(1)]));
const VOICE_S2T_PATTERN = new RegExp(`[${Object.keys(VOICE_S2T).join("")}]`, "gu");

/** 比對用的簡轉繁（長度不變）。台灣繁體轉換器（src/zh-tw.ts）沒載好或英文介面時的備援。 */
export function foldVoice(text: string): string {
  return text.replace(VOICE_S2T_PATTERN, (ch) => VOICE_S2T[ch] ?? ch);
}

/** 回音比對用：先轉台灣繁體（兩邊都轉，使用者逐字稿已轉過、再轉不變），再用折疊表補漏，最後正規化。 */
function comparable(text: string): string {
  return normalizeSpeech(foldVoice(taiwanText(text)));
}

const EDGE_PUNCT_START = /^[\s，,。.!！?？~～…、]+/;
const EDGE_PUNCT_END = /[\s，,。.!！?？~～…、]+$/;
/** 去掉頭尾標點之後，句中還有這些就是兩句以上，不當指令。 */
const SENTENCE_BREAK = /[。.!！?？；;\n]/;
const TRAILING_PARTICLE = /(?:吧|啊|呀|喔|哦|啦)$/;

// 整句就是指令的說法（已折成繁體、去掉客氣話與頭尾標點；classify 也要先認得）。「好了沒」「剛才那份」「先這樣」
// 這類在對話中指涉不明的短句不在這裡：照舊交給模型。
// 只說「進度」不算（審查 minor 1）：要問句（如何／怎麼樣／怎樣／呢）或「看／打開／顯示／查看」開頭。
const ZH_PROGRESS = /^(?:(?:現在|目前)(?:的)?)?(?:任務)?(?:進度|進展)(?:(?:如何|怎麼樣|怎樣)呢?|呢)$|^(?:看|打開|顯示|查看)(?:一下)?(?:任務)?進度$|^做到哪(?:裡|兒)?了?$/;
const ZH_RESULT = /^(?:看|給我看|打開|顯示|拿出)(?:一下)?(?:最新|最近|剛才|剛剛)?(?:的)?(?:結果|成果)$/;
const ZH_DISMISS = /^(?:收起(?:來)?|回(?:到)?桌布|關閉(?:畫面|視窗))$/;
const EN_PROGRESS = /^(?:show|view) (?:task )?progress$|^(?:show|view) status$/;
const EN_RESULT = /^(?:show|view) (?:latest )?results?$|^latest results?$/;
const EN_DISMISS = /^(?:dismiss|(?:hide|close) (?:the )?(?:view|window))$/;

function englishCore(text: string): string {
  return text.toLowerCase().replace(/^please\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * 一句使用者 final 逐字稿是不是明確的本機畫面指令。不是、或有疑問時回 null（照舊交給模型）。
 * 這裡不看回音；回音由 RealtimeLocalCommands 依最近的助理逐字稿判斷。
 */
export function matchVoiceCommand(transcript: string): VoiceCommand | null {
  const raw = transcript.trim();
  const ascii = /^[\x00-\x7F]+$/.test(raw);
  if (!raw || [...raw].length > (ascii ? VOICE_COMMAND_MAX_CHARS_EN : VOICE_COMMAND_MAX_CHARS)) return null;
  const folded = foldVoice(raw);
  const bare = folded.replace(EDGE_PUNCT_START, "").replace(EDGE_PUNCT_END, "");
  if (!bare || SENTENCE_BREAK.test(bare)) return null;
  const intent = classify(folded);
  const core = ascii ? englishCore(bare) : normalizeCommand(bare).replace(/\s+/g, "").replace(TRAILING_PARTICLE, "");
  switch (intent.kind) {
    case "progress":
      return (ascii ? EN_PROGRESS : ZH_PROGRESS).test(core) ? { kind: "progress" } : null;
    case "result":
      return (ascii ? EN_RESULT : ZH_RESULT).test(core) ? { kind: "result" } : null;
    case "dismiss":
      return (ascii ? EN_DISMISS : ZH_DISMISS).test(core) ? { kind: "dismiss" } : null;
    case "history": {
      // 英文查詢詞結尾的 please 不算查詢詞（"search my results for dinner please"）。
      const query = ascii ? intent.query.replace(/[,\s]*please$/i, "").trim() : intent.query;
      if ([...query].length > (ascii ? VOICE_HISTORY_QUERY_MAX_EN : VOICE_HISTORY_QUERY_MAX)) return null;
      // 查詢詞用使用者原本的字（折疊長度不變，位置相同）；找不到對應位置時用折疊後的字。
      const at = query ? folded.lastIndexOf(query) : -1;
      return { kind: "history", query: at >= 0 ? raw.slice(at, at + query.length) : query };
    }
    default:
      return null;
  }
}

/** 使用者逐字稿被這段時間內的助理逐字稿包含（或包含它）才可能是回音（同 server/memory/live.ts 的 ECHO_WINDOW_MS）。 */
export const VOICE_ECHO_WINDOW_MS = 10_000;
/**
 * 審查 M3：回音一定和播放重疊：使用者這句話開口時 Nous 正在播放，或播放停下不到這麼久（毫秒）就開口（喇叭尾音與延遲）。
 * 播放停下之後才開口的同一句話（模型問「要看結果嗎？」，使用者答「看結果」）是使用者自己說的。
 */
export const VOICE_ECHO_PLAYBACK_GRACE_MS = 1_500;
/** 不知道這句話何時開口時（沒有看到聆聽→聽到的轉變）：播放停下這麼久之內收到的逐字稿都算可能重疊。 */
export const VOICE_ECHO_FALLBACK_MS = 3_000;

type Phase = "off" | "connecting" | "listening" | "hearing" | "thinking" | "speaking";

/**
 * 最近的助理逐字稿（整句與說到一半的片段；只在頁面記憶體，不保存、不記 log）與播放時間：喇叭念的話被麥克風收到時，
 * 不當成使用者的指令。要同時符合：文字被助理說過的話包含（或包含它），而且這句話和播放重疊。
 */
export class AssistantEcho {
  private recent: { norm: string; at: number }[] = [];
  private partial: { norm: string; at: number } = { norm: "", at: 0 };
  /** 片段的原文（累積後整段轉台灣繁體，切開的詞才不會轉錯）。 */
  private partialRaw = "";
  private playing = false;
  private playbackEndedAt: number | null = null;
  private userStartedAt: number | null = null;
  private phase: Phase = "off";

  constructor(private readonly now: () => number = Date.now) {}

  note(text: string): void {
    const norm = comparable(text);
    this.partial = { norm: "", at: 0 };
    this.partialRaw = "";
    if (!norm) return;
    const at = this.now();
    this.recent = [...this.recent.filter((x) => at - x.at <= VOICE_ECHO_WINDOW_MS), { norm, at }].slice(-8);
  }

  /** 助理說到一半的片段（資料通道的 delta 或未完成的逐字稿）：使用者逐字稿可能比助理的整句先到。 */
  notePartial(text: string): void {
    if (!comparable(text)) return;
    const at = this.now();
    const base = at - this.partial.at <= VOICE_ECHO_WINDOW_MS ? this.partialRaw : "";
    // 片段可能是增量或累積的：兩種都接起來，比對「包含」不受影響。累積的原文整段轉換後再正規化。
    this.partialRaw = (base + text).slice(-500);
    this.partial = { norm: comparable(this.partialRaw), at };
  }

  /** 工作階段的階段（speaking＝真的在播放；hearing＝使用者開口）。 */
  notePhase(phase: Phase): void {
    const at = this.now();
    if (phase === "speaking") this.playing = true;
    else if (this.playing) {
      this.playing = false;
      this.playbackEndedAt = at;
    }
    if (phase === "hearing" && this.phase !== "hearing") this.userStartedAt = at;
    this.phase = phase;
  }

  isEcho(text: string): boolean {
    const norm = comparable(text);
    if (!norm) return true;
    const at = this.now();
    const texts = [...this.recent, this.partial].filter((x) => x.norm && at - x.at <= VOICE_ECHO_WINDOW_MS);
    if (!texts.some((x) => x.norm.includes(norm) || norm.includes(x.norm))) return false;
    return this.overlappedPlayback(at);
  }

  private overlappedPlayback(at: number): boolean {
    if (this.playing) return true;
    if (this.playbackEndedAt === null) return false;
    if (this.userStartedAt !== null && at - this.userStartedAt <= VOICE_ECHO_WINDOW_MS) {
      return this.playbackEndedAt >= this.userStartedAt - VOICE_ECHO_PLAYBACK_GRACE_MS;
    }
    return at - this.playbackEndedAt <= VOICE_ECHO_FALLBACK_MS;
  }

  clear(): void {
    this.recent = [];
    this.partial = { norm: "", at: 0 };
    this.playing = false;
    this.playbackEndedAt = null;
    this.userStartedAt = null;
    this.phase = "off";
  }
}

/** 主程式提供的動作：和打字的 handleCommand 用同一組（userRequest、dispatch、openHistory、最近的成果）。 */
export interface VoiceCommandHost {
  /** 登記一個真實的使用者請求 id（Presentation Policy 以此驗證 user_request）。 */
  userRequest(): string;
  dispatch(event: ShellEvent): void;
  openHistory(requestId: string, query: string): void;
  latestArtifact(): { task_id: string; artifact_id: string } | null;
  /**
   * 審查 minor 2：確認卡（外部動作）開著嗎？開著時換上別的畫面就等於拒絕確認卡，所以進度、成果、成果紀錄不在本機處理
   * （照舊交給模型）；「收起」仍會關掉確認卡＝拒絕，和 Esc 一樣。
   */
  confirmOpen?(): boolean;
}

/** 打字「看結果」沒有成果時的同一句說明（src/main.ts handleCommand）。 */
export const NO_RESULT_NOTICE = "還沒有完成的成果。問「進度如何」可以看目前狀態。";

/**
 * 即時語音的本機畫面指令（兩條路徑共用，main.ts 建一次）。handle 回傳執行了哪個指令（null＝沒有，照舊交給模型）；
 * 回傳非 null 時，呼叫端（RealtimeVoice／LiveVoice）讓這一輪的模型回答不出聲。
 */
export class RealtimeLocalCommands {
  private readonly echo: AssistantEcho;

  constructor(private readonly host: VoiceCommandHost, now: () => number = Date.now) {
    this.echo = new AssistantEcho(now);
  }

  /** 助理逐字稿（回音判斷用）。 */
  noteAssistant(text: string): void {
    this.echo.note(text);
  }

  noteAssistantPartial(text: string): void {
    this.echo.notePartial(text);
  }

  /** 即時語音的階段（播放與開口時間，回音判斷用）。 */
  notePhase(phase: Phase): void {
    this.echo.notePhase(phase);
  }

  /** 通話結束時清掉回音清單。 */
  reset(): void {
    this.echo.clear();
  }

  handle(transcript: string): VoiceCommand | null {
    const command = matchVoiceCommand(transcript);
    if (!command || this.echo.isEcho(transcript)) return null;
    if (command.kind !== "dismiss" && this.host.confirmOpen?.()) return null;
    // 這一則逐字稿事件的請求 id：和打字一樣由 userRequest() 登記，Surface 帶 user_request。
    const requestId = this.host.userRequest();
    switch (command.kind) {
      case "progress":
        this.host.dispatch({ type: "show.progress", request_id: requestId });
        break;
      case "result": {
        const latest = this.host.latestArtifact();
        if (latest) this.host.dispatch({ type: "show.artifact", request_id: requestId, task_id: latest.task_id, artifact_id: latest.artifact_id });
        else this.host.dispatch({ type: "show.notice", request_id: requestId, message: NO_RESULT_NOTICE });
        break;
      }
      case "history":
        this.host.openHistory(requestId, command.query);
        break;
      case "dismiss":
        // 只關畫面：不結束通話、不取消任務（同即時語音中按 Esc）。
        this.host.dispatch({ type: "dismiss" });
        break;
    }
    return command;
  }
}
