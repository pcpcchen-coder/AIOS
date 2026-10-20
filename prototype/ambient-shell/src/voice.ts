import {
  isLikelyEcho,
  isStopWord,
  MIN_ECHO_LENGTH_AFTER_SPEECH,
  normalizeSpeech,
  stripEcho,
  takeSentences,
} from "./echo.ts";

// 語音輸入：按下說話（PushToTalk）與連續語音對話模式（VoiceConversation）。
// 使用瀏覽器內建的 Web Speech API：Chrome／Edge 會把音訊送到瀏覽器供應商的雲端辨識，
// 因此兩種模式第一次使用前都要分別取得同意。不做背景喚醒、不保存音訊。

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResultLike> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return recognitionCtor() !== null;
}

/** 按下說話與連續語音模式分開同意：後者在模式開啟期間會持續把音訊送到雲端辨識。 */
export type ConsentKind = "push" | "continuous";

const CONSENT_KEY: Record<ConsentKind, string> = {
  push: "nous.voice.cloud-consent.v1",
  continuous: "nous.voice.continuous-consent.v1",
};

export function hasVoiceConsent(kind: ConsentKind = "push"): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY[kind]) === "yes";
  } catch {
    return false;
  }
}

export function saveVoiceConsent(kind: ConsentKind = "push"): void {
  try {
    localStorage.setItem(CONSENT_KEY[kind], "yes");
  } catch {
    // 無法保存時，下次再問一次即可。
  }
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "麥克風權限被拒絕，請改用文字輸入。",
  "service-not-allowed": "瀏覽器不允許使用語音辨識服務，請改用文字輸入。",
  "audio-capture": "找不到可用的麥克風。",
  network: "連不上語音辨識服務（需要網路）。",
  "no-speech": "沒有聽到聲音，請再試一次。",
  "language-not-supported": "此瀏覽器不支援繁體中文語音辨識。",
};

export interface VoiceCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onListeningChange(listening: boolean): void;
  onError(message: string): void;
}

export class PushToTalk {
  private recognition: RecognitionLike | null = null;
  /** 使用者中止（Esc／關閉輸入）時，已辨識的片段也不送出。 */
  private discard = false;

  constructor(private readonly callbacks: VoiceCallbacks) {}

  get active(): boolean {
    return this.recognition !== null;
  }

  start(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.recognition) return;
    const r = new Ctor();
    r.lang = "zh-TW";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    this.discard = false;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      this.callbacks.onInterim(finalText + interim);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted") this.callbacks.onError(ERROR_TEXT[e.error] ?? `語音辨識失敗（${e.error}）`);
    };
    r.onend = () => {
      this.recognition = null;
      this.callbacks.onListeningChange(false);
      if (!this.discard && finalText.trim()) this.callbacks.onFinal(finalText.trim());
    };
    this.recognition = r;
    this.callbacks.onListeningChange(true);
    r.start();
  }

  stop(): void {
    this.recognition?.stop();
  }

  abort(): void {
    if (!this.recognition) return;
    this.discard = true;
    this.recognition.abort();
  }
}

// ───────────── 連續語音對話模式（可插話） ─────────────

export type ConversationState = "off" | "listening" | "speaking";

export interface ConversationCallbacks {
  onUtterance(text: string): void;
  onInterim(text: string): void;
  onStateChange(state: ConversationState): void;
  /** 使用者開口打斷了正在念的回覆。 */
  onBargeIn(): void;
  /** 每句真正開始播放時回報，用來驅動電子腦脈衝。 */
  onSentenceSpoken?(): void;
  /** 模式因錯誤或閒置而自行關閉時呼叫，reason 會顯示並念出。 */
  onClosed(reason: string): void;
}

export interface ConversationOptions {
  /** 多久沒有聽到任何話就自動關閉（毫秒）。 */
  idleMs: number;
  /** 念完後多久內，聽到與剛念內容相同的話仍視為回音（毫秒）。 */
  echoTailMs?: number;
}

/** 一段串流回覆：邊收到文字邊逐句念出。 */
export interface ReplyHandle {
  push(text: string): void;
  end(): void;
  readonly cancelled: boolean;
  readonly done: Promise<void>;
}

const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

/**
 * 像 ChatGPT 語音模式的對話迴圈：麥克風在念回覆時也持續收音。
 * 收到的文字若大致就是正在念的內容，視為喇叭回音而忽略；出現新的字就當作使用者插話，
 * 立刻停止念並改聽使用者說話。戴耳機時沒有回音，插話最靈敏。
 */
export class VoiceConversation {
  private recognition: RecognitionLike | null = null;
  private state: ConversationState = "off";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private networkErrors = 0;
  private reply: Reply | null = null;
  /** 最近念出（或正在念）的內容與結束時間，用來辨認回音。 */
  private spoken = "";
  private spokenEndedAt = 0;
  /** 插話當下的念出內容，用來清掉該句辨識結果開頭的回音。 */
  private bargeSpoken: string | null = null;

  constructor(
    private readonly callbacks: ConversationCallbacks,
    private readonly options: ConversationOptions,
  ) {}

  get current(): ConversationState {
    return this.state;
  }

  get on(): boolean {
    return this.state !== "off";
  }

  start(): void {
    if (this.on || !recognitionCtor()) return;
    this.networkErrors = 0;
    this.setState("listening");
    this.resetIdle();
    this.listen();
  }

  stop(): void {
    if (!this.on) return;
    this.clearIdle();
    this.reply?.cancel();
    this.reply = null;
    speechSynthesis?.cancel();
    this.setState("off");
    const r = this.recognition;
    this.recognition = null;
    r?.abort();
  }

  /** 開始一段新回覆（會取代尚未念完的上一段）。模式關閉時回傳不會發聲的空回覆。 */
  beginReply(): ReplyHandle {
    if (this.reply) {
      this.reply.cancel();
      speechSynthesis?.cancel();
    }
    if (!this.on) return Reply.noop();
    const reply = new Reply({
      onStart: () => {
        if (this.reply === reply) this.setState("speaking");
      },
      onPlaybackEnd: () => {
        if (this.reply === reply && this.on) this.setState("listening");
      },
      onSentence: (sentence) => {
        this.spoken = `${this.spoken}${sentence}`.slice(-400);
        this.callbacks.onSentenceSpoken?.();
      },
      onFinish: () => {
        if (this.reply !== reply) return;
        this.reply = null;
        this.spokenEndedAt = Date.now();
        if (this.on) {
          this.setState("listening");
          this.resetIdle();
        }
      },
    });
    this.spoken = "";
    this.reply = reply;
    return reply;
  }

  /** 念出一段固定短句。 */
  speak(text: string): Promise<void> {
    const reply = this.beginReply();
    reply.push(text);
    reply.end();
    return reply.done;
  }

  /** 中斷正在念的內容（Esc、點擊或偵測到插話），回到聆聽。 */
  interrupt(): void {
    if (!this.reply) return;
    this.bargeSpoken = this.spoken;
    this.reply.cancel();
    this.reply = null;
    speechSynthesis?.cancel();
    this.spokenEndedAt = Date.now();
    if (this.on) this.setState("listening");
    this.callbacks.onBargeIn();
  }

  private isEcho(text: string): boolean {
    const speaking = this.reply !== null;
    if (!speaking) {
      const recent = Date.now() - this.spokenEndedAt < (this.options.echoTailMs ?? 2500);
      // 念完後的短回應（「好」「對」）是使用者說的，不當回音。
      if (!recent || normalizeSpeech(text).length < MIN_ECHO_LENGTH_AFTER_SPEECH) return false;
    }
    return isLikelyEcho(text, this.spoken);
  }

  private listen(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || !this.on) return;
    const r = new Ctor();
    r.lang = "zh-TW";
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    let fatal: string | null = null;
    r.onresult = (e) => {
      if (this.recognition !== r) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript;
        if (!res.isFinal) {
          interim += text;
          continue;
        }
        this.resetIdle();
        this.networkErrors = 0;
        const bargeSpoken = this.bargeSpoken;
        this.bargeSpoken = null;
        if (bargeSpoken !== null) {
          const cleaned = stripEcho(text, bargeSpoken);
          if (normalizeSpeech(cleaned)) this.callbacks.onUtterance(cleaned);
        } else if (!this.isEcho(text) && normalizeSpeech(text)) {
          this.callbacks.onUtterance(text.trim());
        }
      }
      if (!interim) return;
      this.resetIdle();
      const barge = isStopWord(interim) || (normalizeSpeech(interim).length >= 2 && !isLikelyEcho(interim, this.spoken));
      if (this.reply && barge) {
        this.interrupt(); // 使用者插話
      }
      if (!this.reply && !this.isEcho(interim)) this.callbacks.onInterim(interim);
    };
    r.onerror = (e) => {
      if (FATAL_ERRORS.has(e.error)) fatal = ERROR_TEXT[e.error] ?? `語音辨識失敗（${e.error}）`;
      else if (e.error === "network" && ++this.networkErrors >= 3) fatal = ERROR_TEXT.network;
    };
    r.onend = () => {
      if (this.recognition !== r) return; // 已被 stop() 取代
      this.recognition = null;
      if (fatal) {
        this.close(fatal);
        return;
      }
      // 連續辨識會在靜音或一段時間後自行結束；模式開著就重新開始聽。
      if (this.on) setTimeout(() => this.on && !this.recognition && this.listen(), 150);
    };
    this.recognition = r;
    try {
      r.start();
    } catch {
      this.recognition = null;
      this.close("無法啟動語音辨識。");
    }
  }

  private close(reason: string): void {
    this.stop();
    this.callbacks.onClosed(reason);
  }

  private resetIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.reply) {
        this.resetIdle(); // 正在念時不算閒置
        return;
      }
      this.close("一段時間沒有聽到指令，語音模式已關閉。");
    }, this.options.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private setState(state: ConversationState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }
}

interface ReplyEvents {
  onStart(): void;
  onPlaybackEnd(): void;
  onSentence(sentence: string): void;
  onFinish(): void;
}

/** 逐句排入瀏覽器 TTS；取消時丟掉尚未念的句子。 */
class Reply implements ReplyHandle {
  private buffer = "";
  private queue: string[] = [];
  private speaking = false;
  private ended = false;
  private _cancelled = false;
  private resolve: () => void = () => {};
  readonly done = new Promise<void>((r) => (this.resolve = r));
  private events: ReplyEvents | null;

  constructor(events: ReplyEvents | null) {
    this.events = events;
  }

  static noop(): Reply {
    const r = new Reply(null);
    r._cancelled = true;
    r.resolve();
    return r;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  push(text: string): void {
    if (this._cancelled || this.ended) return;
    const { sentences, rest } = takeSentences(this.buffer + text);
    this.buffer = rest;
    this.queue.push(...sentences);
    this.pump();
  }

  end(): void {
    if (this._cancelled || this.ended) return;
    this.ended = true;
    if (normalizeSpeech(this.buffer)) this.queue.push(this.buffer.trim());
    this.buffer = "";
    this.pump();
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.queue = [];
    this.finish();
  }

  private pump(): void {
    if (this._cancelled || this.speaking) return;
    const sentence = this.queue.shift();
    if (sentence === undefined) {
      if (this.ended) this.finish();
      return;
    }
    this.speaking = true;
    void speakText(sentence, { cancelOthers: false, onStart: () => {
      if (this._cancelled) return;
      this.events?.onStart();
      this.events?.onSentence(sentence);
    } }).then(() => {
      this.events?.onPlaybackEnd();
      this.speaking = false;
      this.pump();
    });
  }

  private finish(): void {
    if (!this.events) return;
    const events = this.events;
    this.events = null;
    events.onFinish();
    this.resolve();
  }
}

/** 以瀏覽器 TTS 念出短句；部分瀏覽器不觸發 onend，所以加上依長度估算的逾時保護。 */
export function speakText(text: string, options: { cancelOthers?: boolean; onStart?: () => void } = {}): Promise<void> {
  const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  if (!synth) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    const voice = synth.getVoices().find((v) => v.lang === "zh-TW") ?? synth.getVoices().find((v) => v.lang.startsWith("zh"));
    if (voice) u.voice = voice;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    const guard = setTimeout(finish, 2000 + text.length * 300);
    u.onstart = () => options.onStart?.();
    u.onend = finish;
    u.onerror = finish;
    if (options.cancelOthers ?? true) synth.cancel();
    synth.speak(u);
  });
}
