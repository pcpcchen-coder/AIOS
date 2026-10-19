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

// ───────────── 連續語音對話模式 ─────────────

export type ConversationState = "off" | "listening" | "speaking";

export interface ConversationCallbacks {
  onUtterance(text: string): void;
  onInterim(text: string): void;
  onStateChange(state: ConversationState): void;
  /** 模式因錯誤或閒置而自行關閉時呼叫，reason 會顯示並念出。 */
  onClosed(reason: string): void;
}

export interface ConversationOptions {
  /** 多久沒有聽到任何話就自動關閉（毫秒）。 */
  idleMs: number;
}

const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

/**
 * 開啟後輪流「聆聽 → 辨識一句 → 交給呼叫端 → 念出回覆 → 再聆聽」。
 * 念的時候暫停收音，避免把自己的語音當成新指令（AC-17）；閒置逾時自動關閉，
 * 讓雲端辨識不會無限期開著。
 */
export class VoiceConversation {
  private recognition: RecognitionLike | null = null;
  private state: ConversationState = "off";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private speakToken = 0;
  private networkErrors = 0;

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
    this.speakToken += 1;
    speechSynthesis?.cancel();
    this.setState("off");
    this.recognition?.abort();
    this.recognition = null;
  }

  /** 念出一段短句；念完（或逾時保護）後恢復聆聽。模式關閉時直接略過。 */
  speak(text: string): Promise<void> {
    if (!this.on || !text) return Promise.resolve();
    const token = ++this.speakToken;
    this.recognition?.abort();
    this.recognition = null;
    this.setState("speaking");
    return speakText(text).then(() => {
      if (token !== this.speakToken || !this.on) return;
      this.setState("listening");
      this.resetIdle();
      setTimeout(() => {
        if (token === this.speakToken && this.state === "listening" && !this.recognition) this.listen();
      }, 250);
    });
  }

  /** 中斷正在念的內容（Esc 或點擊），回到聆聽。 */
  interrupt(): void {
    if (this.state !== "speaking") return;
    this.speakToken += 1;
    speechSynthesis?.cancel();
    this.setState("listening");
    this.listen();
  }

  private listen(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.state !== "listening") return;
    const r = new Ctor();
    r.lang = "zh-TW";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    let fatal: string | null = null;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      this.resetIdle();
      this.callbacks.onInterim(finalText + interim);
    };
    r.onerror = (e) => {
      if (FATAL_ERRORS.has(e.error)) fatal = ERROR_TEXT[e.error] ?? `語音辨識失敗（${e.error}）`;
      else if (e.error === "network" && ++this.networkErrors >= 3) fatal = ERROR_TEXT.network;
    };
    r.onend = () => {
      if (this.recognition !== r) return; // 已被 speak()/stop() 取代
      this.recognition = null;
      if (fatal) {
        this.close(fatal);
        return;
      }
      const text = finalText.trim();
      if (text) {
        this.networkErrors = 0;
        this.callbacks.onUtterance(text);
      }
      // 沒聽到話（no-speech）或呼叫端沒有要念東西時，繼續聆聽。
      if (this.state === "listening" && !this.recognition) this.listen();
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
    this.idleTimer = setTimeout(() => this.close("一段時間沒有聽到指令，語音模式已關閉。"), this.options.idleMs);
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

/** 以瀏覽器 TTS 念出短句；部分瀏覽器不觸發 onend，所以加上依長度估算的逾時保護。 */
export function speakText(text: string): Promise<void> {
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
    u.onend = finish;
    u.onerror = finish;
    synth.cancel();
    synth.speak(u);
  });
}
