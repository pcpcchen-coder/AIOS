// 按住說話（明確啟動）的語音輸入。使用瀏覽器內建的 Web Speech API：
// Chrome／Edge 會把音訊送到瀏覽器供應商的雲端辨識，因此第一次使用前必須取得同意。
// 只在使用者按下麥克風後收音，不做背景喚醒、不保存音訊。

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

const CONSENT_KEY = "nous.voice.cloud-consent.v1";

export function hasVoiceConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

export function saveVoiceConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, "yes");
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
