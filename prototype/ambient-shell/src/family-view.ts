import { t, msg, getLocale, onLocaleChange } from "./i18n.ts";
// 「家人辨識」Surface（docs/14 ID-01、ADR-0001）：只由選單列「鏡頭與語音設定 → 家人辨識…」打開（visibility_reason
// user_request）。內容：家人列表、新增家人（名稱 → 本人同意 → 自動取樣）、刪除、試認、資料說明。
// - 辨識只在這個畫面內運作（登記與試認）；收起只丟記憶體中的樣本與管理 session，不刪已存的資料。
// - 身分資料只經 macOS App 的 IPC（window.nousDesktop.identity）與核心往來；瀏覽器版明示不可用。
// - 比對、證據、名稱驗證與寫檔都在核心；這裡不算分數，也看不到分數。門檻未校準，試認畫面照實標示。

import {
  CALIBRATION_MIN,
  CALIBRATION_VERIFY_STRANGERS,
  FAMILY_MAX,
  parseFamilyName,
  speakableName,
  VOICE_KEYWORD_SAMPLES,
  VOICE_UTTERANCE_SAMPLES,
  type FaceModelVersion,
  type SpeakerModelVersion,
  type FamilyMember,
  type IdentityObservation,
  type IdentityState,
  type IdentityRequest,
  type IdentityManageStatus,
  type IdentityResponse,
  type CalibrationReport,
  type VoiceObservation,
  type VoiceSegment,
} from "../shared/identity.ts";
import { greetingSentence } from "../shared/sense.ts";
import { EnrollmentCollector, ENROLL_TARGET } from "./family-enroll.ts";
import { QUALITY_LABEL } from "./sense/face/quality.ts";
import { IdentityClient, type ClientFrame, type ClientState, type FrameSource, type WorkerLike } from "./sense/identity-client.ts";
import type { FrameOptions } from "./sense/identity-protocol.ts";
import { CalibrationPanel, type CalibrationPreview } from "./face-calibration-view.ts";
import type { SenseSample } from "./face-calibration.ts";
import type { FaceTuning, FaceTuningView } from "../shared/face-tuning.ts";
import { VoiceRecorder, type MicSource, type SegmentResult, type SpeakerWorkerLike } from "./speaker/recorder.ts";

export interface FamilyBridge {
  identity(request: IdentityRequest): Promise<IdentityResponse>;
}

export interface FamilyViewDeps {
  /** macOS App 的 IPC；瀏覽器版為 null。 */
  bridge: FamilyBridge | null;
  source: FrameSource;
  createWorker: () => WorkerLike;
  model: FaceModelVersion;
  /** 收起（dispatch dismiss）；只關畫面。 */
  dismiss: () => void;
  /** 「校正人臉辨識」用：目前的感知狀態、鏡頭畫面、校正值與保存。未提供時不顯示校正。 */
  sense?: () => SenseSample | null;
  preview?: (targets: CalibrationPreview | null) => void;
  tuning?: () => FaceTuningView | undefined;
  applyTuning?: (change: Partial<FaceTuning> | "reset", calibrated: boolean) => Promise<string | null>;
  /** SP-01 聲音登記：麥克風來源（租用常駐喚醒或自己開）、講者 worker 與模型版本。未提供時（瀏覽器版）不顯示聲音。 */
  voice?: { mic: MicSource; createWorker: () => SpeakerWorkerLike; model: SpeakerModelVersion };
  /** 測試用：等待（錄音窗、提示之間的停頓）。 */
  wait?: (ms: number) => Promise<void>;
  /**
   * SP-03a 校準的陌生聲音：系統內建的朗讀聲音（預設 window.speechSynthesis）。voices 回可用的聲音，speak 念完才 resolve。
   * 未提供時不顯示「播放陌生聲音」。
   */
  tts?: { voices(): { name: string; lang: string }[]; speak(text: string, voice: string): Promise<void> };
}

/** 新增家人時要登記什麼（George 2026-11-01：可以只錄聲音）。 */
export type EnrollMode = "face" | "voice" | "both";

/**
 * 聲音登記的提示（George 2026-11-01 選「喚醒詞 5 次＋朗讀 3 句」，docs/17 §11.3）。喚醒詞兩個都錄，之後喚醒時不論說哪一個都能比；
 * 朗讀句是一般家中會說的話。每段：叮一聲 → 錄音窗 → 至少要有 min_ms 的人聲，不夠就同一句再錄（最多 3 次）。
 */
export const VOICE_PROMPTS: readonly { kind: "keyword" | "utterance"; text: string; window_ms: number; min_ms: number }[] = [
  { kind: "keyword", text: "Hey Nous", window_ms: 2500, min_ms: 400 },
  { kind: "keyword", text: "Hello Nous", window_ms: 2500, min_ms: 400 },
  { kind: "keyword", text: "Hey Nous", window_ms: 2500, min_ms: 400 },
  { kind: "keyword", text: "Hello Nous", window_ms: 2500, min_ms: 400 },
  { kind: "keyword", text: "Hey Nous", window_ms: 2500, min_ms: 400 },
  { kind: "utterance", text: "今天天氣很好，我們去公園散步吧。", window_ms: 6000, min_ms: 1500 },
  { kind: "utterance", text: "請幫我把客廳的燈打開，謝謝。", window_ms: 6000, min_ms: 1500 },
  { kind: "utterance", text: "明天早上七點叫我起床。", window_ms: 6000, min_ms: 1200 },
];
const VOICE_TRIES = 3;

/** SP-03a 校準時你要念的：10 次喚醒詞（兩個輪流）＋10 句和登記不同的話。 */
export const CALIBRATION_MEMBER_PROMPTS: readonly { kind: VoiceSegment; text: string; window_ms: number; min_ms: number }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ kind: "keyword" as const, text: i % 2 ? "Hello Nous" : "Hey Nous", window_ms: 2500, min_ms: 400 })),
  ...[
    "幫我看一下今天新竹的天氣。",
    "把冷氣調到二十六度。",
    "晚上想吃什麼，給我一點建議。",
    "提醒我下午三點要開會。",
    "播一點輕鬆的音樂好嗎？",
    "明天要不要帶傘出門？",
    "幫我查一下最近的新聞。",
    "客廳有點暗，把燈調亮一點。",
    "週末有什麼好玩的地方？",
    "幫我記一下要買牛奶和雞蛋。",
  ].map((text) => ({ kind: "utterance" as const, text, window_ms: 6000, min_ms: 2000 })),
];

/** SP-03a 陌生聲音念的句子（依朗讀聲音的語言挑）。 */
export const CALIBRATION_STRANGER_LINES = {
  keyword: ["Hey Nous", "Hello Nous"],
  zh: ["今天天氣不錯，我們出去走走吧。", "請把客廳的燈關掉，謝謝。", "晚餐想吃麵還是飯？", "明天早上要早一點出門。", "這首歌很好聽，再放一次。"],
  en: ["What's the weather like today?", "Please turn off the lights in the living room.", "Remind me to call my mother tonight.", "I would like a cup of coffee.", "Let's go for a walk after dinner."],
} as const;

/** SP-02a「試認聲音」：念一次喚醒詞、一句短句，各自看認成誰（喚醒詞只和喚醒詞模板比，短句只和朗讀模板比）。 */
export const VOICE_TEST_PROMPTS: readonly { kind: VoiceSegment; text: string; window_ms: number; min_ms: number }[] = [
  { kind: "keyword", text: "Hey Nous", window_ms: 2500, min_ms: 400 },
  { kind: "utterance", text: "請幫我把客廳的燈打開，謝謝。", window_ms: 6000, min_ms: 1500 },
];

export const VOICE_EXPLANATION =
  "聲音登記只在這台 Mac 上運作：錄音只在記憶體裡算成聲音特徵（一串數字）後就丟掉，不存錄音、不上傳；只保存加密的特徵，只用來稱呼，" +
  "不作為解鎖、付款或任何授權的依據。請在安靜的地方、由本人用平常的音量念。";

export const FAMILY_EXPLANATION =
  "家人辨識只在這台 Mac 上運作：只保存加密的臉部特徵（不存照片、不上傳），只用來稱呼你，不作為解鎖、付款或任何授權的依據。" +
  "每位家人都要本人在場並同意；未成年家人由家長確認。隨時可以刪除。";
/**
 * 雲端稱名的揭露（ID-02）：登記同意與一次性說明都用這段。看過（登記同意或按「我知道了」）之前，核心不稱名。
 */
export const CLOUD_NAMING_NOTICE =
  "開啟「打招呼時稱呼認出的家人」時，看著說話認出家人後，名字會以一句短句（例如「George，我在」）送到雲端語音供應商" +
  "（ChatGPT 方案或 OpenAI API key，看你用哪一條即時語音路徑）；對話中說出的話也會照常送到那裡。臉部影像與特徵不會送出。" +
  "可以在選單列「鏡頭與語音設定」關掉，關掉後只說「我在」。";
export const FAMILY_BACKUP_NOTE =
  "刪除後新的資料無法還原；但在此之前已存在的 Time Machine 備份或 APFS 本機快照，可能仍保有舊的加密檔（這台 Mac 的應用程式金鑰不會輪換，舊檔理論上仍可解開）。";
export const UNCALIBRATED_LABEL = "門檻未校準：結果只供參考，可能認錯或認不出來";

type Phase =
  | { kind: "opening" }
  | { kind: "unavailable"; message: string }
  | { kind: "list" }
  | { kind: "name"; draft: string; minor: boolean; error: string | null }
  | { kind: "consent"; name: string; minor: boolean; consent: boolean; guardian: boolean; mode: EnrollMode; person_id?: string }
  | { kind: "capture"; name: string; minor: boolean; guardian: boolean; hint: string; then_voice: boolean; person_id?: string }
  | {
      kind: "voice";
      name: string;
      minor: boolean;
      guardian: boolean;
      person_id?: string;
      /** 目前第幾段（0 起算）；loading 時還沒開始。 */
      step: number;
      state: "loading" | "get_ready" | "listening" | "processing";
      hint: string | null;
    }
  | {
      kind: "voice_test";
      step: number;
      state: "loading" | "get_ready" | "listening" | "processing" | "done";
      hint: string | null;
      /** 每段的結果（已翻譯的文字）：名字、認不出來、分不出是誰… */
      results: { kind: VoiceSegment; label: string }[];
    }
  | { kind: "submitting"; name: string }
  | { kind: "calibrate" }
  | {
      kind: "voice_calibrate";
      report: CalibrationReport | null;
      /** 誰的樣本（家人 person_id）。 */
      member: string | null;
      run: null | { kind: "member" | "stranger"; step: number; total: number; state: "loading" | "get_ready" | "listening" | "processing"; text: string; hint: string | null };
    };

type RawText = { readonly raw: string };
type Child = Node | string | RawText | null | undefined | false;
const raw = (text: string): RawText => ({ raw: text });

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, ["aria-label", "title", "placeholder"].includes(k) ? t(v) : v);
  for (const c of children) {
    if (typeof c === "string") el.append(c);
    else if (c && "raw" in c) el.append(c.raw);
    else if (c) el.append(c);
  }
  return el;
}

function button(label: string, onClick: () => void, variant = "", disabled = false): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${variant}`.trim() }, t(label));
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * 登記時預覽問候會怎麼念（只在這個畫面顯示使用者自己打的名稱，不送出）。實際句子由核心從固定清單挑（依時段、避開上一次），
 * 組句時用同一組規則再驗一次（權威在核心）。
 */
export function namePreview(draft: string): string {
  if (!parseFamilyName(draft).ok) return "";
  const name = speakableName(draft);
  return name
    ? msg`看著說話認出時會說像「${greetingSentence(name, getLocale())}」「嗨，${name}」這樣的短句（依時段也可能是「早安，${name}」）。`
    : t("這個名稱不會被念出來：認出時只說「我在」之類不含名字的短句（像句子、指令或含不能念的符號）。");
}

/** 刪除家人後連結記憶的處理結果（核心照實回報；失敗時家人資料已刪，記憶要到「記憶…」處理）。 */
export function memoryNote(res: IdentityResponse): string {
  if (!res.ok || (res.op !== "delete" && res.op !== "clear_all") || !res.memory || res.memory === "none") return "";
  return res.memory === "deleted" ? "連結的記憶也已刪除。" : res.memory === "unlinked" ? "連結的記憶已解除連結並保留（可在「記憶…」查看或刪除）。" : "連結的記憶沒有處理成功：請到選單列「記憶…」查看並刪除。";
}

/** 核心給的觀測 → 畫面上的一句話（不含分數）。 */
export function observationText(obs: IdentityObservation | null, people: readonly FamilyMember[]): string {
  if (!obs) return t("辨識中…");
  switch (obs.state) {
    case "matched": {
      const who = people.find((p) => p.person_id === obs.person_id);
      return who ? msg`認得：${who.name}` : t("辨識中…");
    }
    case "unknown":
      return t("不認得");
    case "ambiguous":
      return obs.reason === "multi_face" ? t("畫面裡有多張臉（不會任選一位）") : t("分不清是哪一位");
    case "unavailable":
      switch (obs.reason) {
        case "quality":
          return t("品質不足");
        case "no_face":
          return t("沒有看到臉");
        case "no_gallery":
          return t("還沒有可以比對的家人");
        default:
          return t("辨識中…");
      }
  }
}

/** 剛登記的家人（同名時取最新的一位）。 */
function newestNamed(people: readonly FamilyMember[], name: string): FamilyMember | undefined {
  return people.filter((p) => p.name === name).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export class FamilyView {
  readonly element: HTMLElement;
  private phase: Phase = { kind: "opening" };
  private session: string | null = null;
  private people: FamilyMember[] = [];
  private status: IdentityManageStatus | null = null;
  /** 取樣世代：整個畫面期間單調遞增，每個新的取樣器都接著用（不從 0 重來）。 */
  private sampleGen = 0;
  private notice: string | null = null;
  private error: string | null = null;
  private trying = false;
  private observation: IdentityObservation | null = null;
  private clientState: ClientState | null = null;
  private quality: string | null = null;
  private probing = false;
  private busy = false;
  private client: IdentityClient | null = null;
  private readonly collector = new EnrollmentCollector(ENROLL_TARGET);
  /** 每次打開或收起加一；晚到的 IPC 回應若世代不符就丟掉。 */
  private openGen = 0;
  private renderedKey: string | null = null;
  /** 打開後直接進入「校正人臉辨識」（選單列「校正人臉辨識…」）。 */
  private calibrateOnOpen = false;
  private readonly calibration: CalibrationPanel;
  private recorder: VoiceRecorder | null = null;
  /** 錄音時的音量（0–1，四捨五入到 0.05 才會重畫）。 */
  private level = 0;
  /** 每次開始或取消錄音加一；舊的錄音流程看到世代不符就停。 */
  private voiceGen = 0;

  constructor(private readonly deps: FamilyViewDeps) {
    this.calibration = new CalibrationPanel({
      startSampling: (onFrame, options) => this.startClient(onFrame, options),
      stopSampling: () => this.stopClient(),
      probe: (frame) => this.probeOnce(frame),
      hasPeople: () => this.people.length > 0,
      clientLine: () => (this.client ? this.clientLine() : null),
      sense: () => this.deps.sense?.() ?? null,
      preview: (targets) => this.deps.preview?.(targets),
      tuning: () => this.deps.tuning?.(),
      applyTuning: (change, calibrated) => this.deps.applyTuning?.(change, calibrated) ?? Promise.resolve("這個版本不能保存校正值"),
      changed: () => this.render(),
      back: () => this.backToList(),
    });
    this.element = h("section", { class: "surface surface--family", role: "region", "data-visibility-reason": "user_request" });
    this.render();
    onLocaleChange(() => { this.renderedKey = null; this.render(); });
  }

  /** 打開畫面：向核心開管理 session（主程序只在使用者 10 秒內點過選單列時允許）。 */
  open(mode: "list" | "calibrate" = "list"): void {
    this.calibrateOnOpen = mode === "calibrate";
    const gen = ++this.openGen;
    this.phase = { kind: "opening" };
    this.render();
    if (!this.deps.bridge) {
      this.phase = { kind: "unavailable", message: "家人辨識：瀏覽器版不可用（只在 macOS App 提供）。" };
      this.render();
      return;
    }
    void this.call({ op: "open_session" }, gen);
  }

  /** 收起：停止取樣、丟掉記憶體中的樣本與 session；已存的家人資料不動。 */
  close(): void {
    this.openGen++;
    if (this.phase.kind === "calibrate") this.calibration.close();
    this.calibrateOnOpen = false;
    this.stopClient();
    this.stopVoice();
    this.collector.discard();
    const session = this.session;
    this.session = null;
    this.trying = false;
    this.observation = null;
    this.notice = this.error = null;
    if (session && this.deps.bridge) void this.deps.bridge.identity({ op: "close_session", session }).catch(() => undefined);
    this.phase = { kind: "opening" };
    this.renderedKey = null;
  }

  private async call(request: IdentityRequest, gen = this.openGen): Promise<IdentityResponse | null> {
    let res: IdentityResponse;
    try {
      res = await this.deps.bridge!.identity(request);
    } catch (err) {
      res = { ok: false, code: "unavailable", message: `家人辨識沒有回應：${err instanceof Error ? err.message : String(err)}` };
    }
    if (gen !== this.openGen) return null;
    if (res.ok && "people" in res) {
      this.session = res.session;
      this.people = res.people;
      this.status = res.status;
      if (this.phase.kind === "opening") {
        this.phase = { kind: "list" };
        if (this.calibrateOnOpen) this.startCalibration();
      }
    } else if (!res.ok && (res.code === "no_session" || res.code === "not_user_initiated" || (res.code === "unavailable" && request.op === "open_session"))) {
      this.stopClient();
      this.session = null;
      this.phase = { kind: "unavailable", message: res.message };
    }
    this.render();
    return res;
  }

  // ───────────── 試認 ─────────────

  private toggleTry(): void {
    if (this.trying) {
      this.trying = false;
      this.stopClient();
    } else {
      this.trying = true;
      this.observation = null;
      this.startClient((frame) => this.onTryFrame(frame));
    }
    this.render();
  }

  private onTryFrame(frame: ClientFrame): void {
    this.quality = frame.quality === "ok" ? null : QUALITY_LABEL[frame.quality];
    if (this.probing || !this.session) {
      frame.feature?.fill(0);
      return;
    }
    this.probing = true;
    const request: IdentityRequest = {
      op: "probe",
      session: this.session,
      gen: frame.gen,
      face_count: frame.face_count,
      quality: frame.quality,
      model: this.deps.model,
      ...(frame.feature ? { feature: Array.from(frame.feature) } : {}),
    };
    frame.feature?.fill(0);
    void this.call(request).then((res) => {
      this.probing = false;
      if (res?.ok && res.op === "probe" && this.trying) this.observation = res.observation;
      else if (res && !res.ok && res.code !== "rate_limited") this.error = res.message;
      this.render();
    });
  }

  // ───────────── 新增家人 ─────────────

  private startEnroll(): void {
    this.stopTry();
    this.notice = this.error = null;
    this.phase = { kind: "name", draft: "", minor: false, error: null };
    this.render();
  }

  /** 臉與聲音各自能不能新增（鏡頭與臉的模型、講者模型分開判斷）。 */
  private canFace(): boolean {
    const st = this.status;
    return !!st && st.state === "ready" && !st.limited_reason;
  }

  private canVoice(): boolean {
    const st = this.status;
    return !!this.deps.voice && !!st && st.state === "ready" && st.voice_models === "ok";
  }

  /** 已登記的家人：錄（或重錄）聲音、只有聲音的家人補拍臉。都要再勾一次本人同意。 */
  private startFor(person: FamilyMember, mode: "face" | "voice"): void {
    this.stopTry();
    this.notice = this.error = null;
    this.phase = { kind: "consent", name: person.name, minor: person.minor, consent: false, guardian: false, mode, person_id: person.person_id };
    this.render();
  }

  private submitName(draft: string, minor: boolean): void {
    const parsed = parseFamilyName(draft);
    if (!parsed.ok) {
      this.phase = { kind: "name", draft, minor, error: parsed.error };
      this.render();
      return;
    }
    const mode: EnrollMode = this.canFace() ? "face" : "voice";
    this.phase = { kind: "consent", name: parsed.name, minor, consent: false, guardian: false, mode };
    this.render();
  }

  private beginFromConsent(phase: Extract<Phase, { kind: "consent" }>): void {
    if (phase.mode === "voice") void this.startVoice(phase.name, phase.minor, phase.guardian, phase.person_id);
    else this.startCapture(phase.name, phase.minor, phase.guardian, phase.mode === "both", phase.person_id);
  }

  private startCapture(name: string, minor: boolean, guardian: boolean, thenVoice = false, personId?: string): void {
    this.collector.discard();
    this.phase = { kind: "capture", name, minor, guardian, hint: "載入辨識模型…", then_voice: thenVoice, ...(personId ? { person_id: personId } : {}) };
    this.startClient((frame) => this.onCaptureFrame(frame));
    this.render();
  }

  private onCaptureFrame(frame: ClientFrame): void {
    const phase = this.phase;
    if (phase.kind !== "capture") return;
    const event = this.collector.push(frame);
    frame.feature?.fill(0);
    if (event.kind === "reset") {
      phase.hint = event.reason === "multi_face" ? "畫面裡有多張臉：已取的樣本全部丟棄，請只留一個人" : "追蹤中斷：已取的樣本全部丟棄，重新開始";
    } else if (event.kind === "slow") {
      phase.hint = `相鄰畫格隔了 ${(event.gap_ms / 1000).toFixed(1)} 秒（超過 0.5 秒，電腦可能太忙），暫時取不到樣本`;
    } else if (event.kind === "waiting") {
      phase.hint = event.quality === "ok" ? this.collector.prompt : QUALITY_LABEL[event.quality];
    } else if (event.kind === "sampled") {
      phase.hint = this.collector.prompt;
    } else if (event.kind === "done") {
      this.stopClient();
      void this.submitEnroll(phase.name, phase.minor, phase.guardian, phase.then_voice, phase.person_id);
      return;
    }
    this.render();
  }

  private async submitEnroll(name: string, minor: boolean, guardian: boolean, thenVoice = false, personId?: string): Promise<void> {
    if (!this.session) return;
    const samples = this.collector.takeSamples();
    this.collector.discard();
    this.phase = { kind: "submitting", name };
    this.render();
    const res = await this.call({
      op: "enroll",
      session: this.session,
      name,
      minor,
      guardian_confirmed: guardian,
      consent: true,
      model: this.deps.model,
      samples,
      ...(personId ? { person_id: personId } : {}),
    });
    for (const s of samples) s.fill(0);
    // 等待期間 session 可能失效（call 已把畫面改成不可用）。
    if (!res || (this.phase as Phase).kind === "unavailable") return;
    this.phase = { kind: "list" };
    if (!res.ok) {
      this.error = res.message;
      this.render();
      return;
    }
    this.notice = personId ? msg`已幫「${name}」登記臉。` : msg`已登記「${name}」。`;
    // 「兩個都做」：臉保存成功後接著錄聲音（同一位家人；同意在前一步已勾過）。
    const created = personId ?? newestNamed(this.people, name)?.person_id;
    if (thenVoice && created && this.canVoice()) {
      void this.startVoice(name, minor, guardian, created);
      return;
    }
    this.render();
  }

  // ───────────── 聲音登記（SP-01） ─────────────

  private stopVoice(): void {
    this.voiceGen++;
    this.recorder?.stop();
    this.recorder = null;
    this.level = 0;
  }

  private wait(ms: number): Promise<void> {
    return this.deps.wait ? this.deps.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 依序錄 8 段：每段先顯示要念的字與「準備」，叮一聲後才開始錄；人聲不夠就同一句重錄。全部完成才把特徵送到核心
   * （錄音本身留在 worker，算完特徵就以 0 覆寫）。取消、收起或 session 失效時立即停止麥克風。
   */
  private async startVoice(name: string, minor: boolean, guardian: boolean, personId?: string): Promise<void> {
    const voice = this.deps.voice;
    if (!voice || !this.session) return;
    this.stopTry();
    this.stopVoice();
    const gen = ++this.voiceGen;
    const phase: Extract<Phase, { kind: "voice" }> = { kind: "voice", name, minor, guardian, step: 0, state: "loading", hint: null, ...(personId ? { person_id: personId } : {}) };
    this.phase = phase;
    this.render();
    const recorder = await this.openRecorder(gen);
    if (!recorder || gen !== this.voiceGen) return;
    const keyword: number[][] = [];
    const utterance: number[][] = [];
    for (let i = 0; i < VOICE_PROMPTS.length; i++) {
      const prompt = VOICE_PROMPTS[i]!;
      const got = await this.recordPrompt(recorder, gen, phase, i, prompt);
      if (gen !== this.voiceGen) return;
      if (!got) return this.voiceFailed("錄了幾次都沒有錄清楚，聲音沒有保存。請在安靜的地方、靠近電腦再試一次。");
      (prompt.kind === "keyword" ? keyword : utterance).push(got);
    }
    this.stopVoice();
    await this.submitVoice(name, minor, guardian, personId, keyword, utterance);
  }

  /** 錄一段：顯示要念的字與「準備」，叮一聲後才開始錄；人聲不夠就同一句重錄（最多 VOICE_TRIES 次）。回傳特徵或 null。 */
  private async recordPrompt(
    recorder: VoiceRecorder,
    gen: number,
    phase: { step: number; state: string; hint: string | null },
    step: number,
    prompt: { window_ms: number; min_ms: number },
  ): Promise<number[] | null> {
    let got: SegmentResult | null = null;
    for (let attempt = 0; attempt < VOICE_TRIES && !got?.feature; attempt++) {
      if (gen !== this.voiceGen) return null;
      phase.step = step;
      phase.state = "get_ready";
      this.render();
      await this.wait(attempt === 0 ? 900 : 1500);
      if (gen !== this.voiceGen) return null;
      recorder.chime();
      await this.wait(250);
      phase.state = "listening";
      phase.hint = null;
      this.render();
      got = await recorder.record(prompt.window_ms, prompt.min_ms, (ms) => this.wait(ms));
      if (gen !== this.voiceGen) return null;
      phase.state = "processing";
      if (!got.feature) phase.hint = got.problem === "too_quiet" ? "沒有聽到聲音，請靠近一點、大聲一點再念一次" : got.problem === "too_short" ? "念得太短或沒錄完整，請再念一次" : "這段沒有處理成功，請再念一次";
      this.render();
    }
    return got?.feature ?? null;
  }

  private voiceFailed(message: string): void {
    this.stopVoice();
    this.phase = { kind: "list" };
    this.error = message;
    this.render();
  }

  /** 開錄音器（載入模型、打開麥克風）；失敗時回到列表並顯示原因。 */
  private async openRecorder(gen: number): Promise<VoiceRecorder | null> {
    const voice = this.deps.voice!;
    const recorder = new VoiceRecorder({
      mic: voice.mic,
      createWorker: voice.createWorker,
      onLevel: (rms) => {
        const lv = Math.min(1, Math.round(rms * 12 * 20) / 20);
        if (lv !== this.level) {
          this.level = lv;
          this.render();
        }
      },
    });
    this.recorder = recorder;
    try {
      await recorder.start();
      return recorder;
    } catch (err) {
      if (gen === this.voiceGen) this.voiceFailed(msg`沒辦法開始錄音：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * SP-02a「試認聲音」：念一次喚醒詞、一句短句，核心各自回認成誰（不含分數）。和喚醒時的比對是同一套規則與門檻（未校準）。
   */
  private async startVoiceTest(): Promise<void> {
    if (!this.deps.voice || !this.session) return;
    this.stopTry();
    this.stopVoice();
    this.notice = this.error = null;
    const gen = ++this.voiceGen;
    const phase: Extract<Phase, { kind: "voice_test" }> = { kind: "voice_test", step: 0, state: "loading", hint: null, results: [] };
    this.phase = phase;
    this.render();
    const recorder = await this.openRecorder(gen);
    if (!recorder || gen !== this.voiceGen) return;
    for (let i = 0; i < VOICE_TEST_PROMPTS.length; i++) {
      const prompt = VOICE_TEST_PROMPTS[i]!;
      const feature = await this.recordPrompt(recorder, gen, phase, i, prompt);
      if (gen !== this.voiceGen) return;
      if (!feature) return this.voiceFailed("錄了幾次都沒有錄清楚。請在安靜的地方、靠近電腦再試一次。");
      if (!this.session) return;
      const res = await this.call({ op: "voice_test", session: this.session, segment: prompt.kind, model: this.deps.voice.model, feature });
      if (gen !== this.voiceGen) return;
      if (!res?.ok || res.op !== "voice_test") return this.voiceFailed(res && !res.ok ? res.message : "試認沒有完成");
      phase.results.push({ kind: prompt.kind, label: this.voiceLabel(res.observation) });
      this.render();
    }
    this.stopVoice();
    phase.state = "done";
    this.render();
  }

  // ───────────── SP-03a 聲音校準 ─────────────

  private async openVoiceCalibration(): Promise<void> {
    if (!this.session || !this.deps.voice) return;
    this.stopTry();
    this.stopVoice();
    this.notice = this.error = null;
    const member = this.people.find((p) => p.voice === "enrolled")?.person_id ?? null;
    const phase: Extract<Phase, { kind: "voice_calibrate" }> = { kind: "voice_calibrate", report: null, member, run: null };
    this.phase = phase;
    this.render();
    const res = await this.call({ op: "calib_status", session: this.session });
    if (this.phase !== phase) return;
    if (res?.ok && res.op === "calib_status") phase.report = res.report;
    else if (res && !res.ok) this.error = res.message;
    this.render();
  }

  /** 錄你的樣本：10 次喚醒詞＋10 句話，每段叮一聲再念；每段都送一筆試驗。 */
  private async runCalibrationMember(phase: Extract<Phase, { kind: "voice_calibrate" }>): Promise<void> {
    const voice = this.deps.voice;
    if (!voice || !this.session || !phase.member || phase.run) return;
    const gen = ++this.voiceGen;
    const run = { kind: "member" as const, step: 0, total: CALIBRATION_MEMBER_PROMPTS.length, state: "loading" as const, text: "", hint: null };
    phase.run = run;
    this.render();
    const recorder = await this.openRecorder(gen);
    if (!recorder || gen !== this.voiceGen) return;
    for (let i = 0; i < CALIBRATION_MEMBER_PROMPTS.length; i++) {
      const prompt = CALIBRATION_MEMBER_PROMPTS[i]!;
      run.text = prompt.text;
      const feature = await this.recordPrompt(recorder, gen, run, i, prompt);
      if (gen !== this.voiceGen) return;
      if (!feature) continue;
      const res = await this.call({ op: "calib_trial", session: this.session, label: "member", person_id: phase.member, segment: prompt.kind, voiced_ms: prompt.min_ms, model: voice.model, feature });
      if (gen !== this.voiceGen) return;
      if (res?.ok && res.op === "calib_trial") phase.report = res.report;
      else if (res && !res.ok) return this.calibrationFailed(phase, res.message);
      this.render();
    }
    this.stopVoice();
    phase.run = null;
    this.render();
  }

  /**
   * 陌生聲音：用系統內建的朗讀聲音從喇叭念喚醒詞與句子，經真的麥克風收進來（和平常的收音一樣），每段送一筆 stranger 試驗。
   * 收集階段每種片段 30 筆，套用門檻之後（驗證）每種 50 筆。聲音依序輪流；沒錄到人聲的那段不算。
   */
  private async runCalibrationStrangers(phase: Extract<Phase, { kind: "voice_calibrate" }>): Promise<void> {
    const voice = this.deps.voice;
    const tts = this.deps.tts;
    if (!voice || !tts || !this.session || phase.run) return;
    const voices = tts.voices().filter((v) => /^(zh|en)/i.test(v.lang));
    if (voices.length === 0) return this.calibrationFailed(phase, "這台 Mac 沒有可用的中文或英文朗讀聲音");
    const perSegment = phase.report?.applied_at ? CALIBRATION_VERIFY_STRANGERS : CALIBRATION_MIN.stranger;
    const plan: { kind: VoiceSegment; text: string; voice: { name: string; lang: string } }[] = [];
    for (let i = 0; i < perSegment; i++) {
      const v = voices[i % voices.length]!;
      plan.push({ kind: "keyword", text: CALIBRATION_STRANGER_LINES.keyword[i % 2]!, voice: v });
      const lines = /^zh/i.test(v.lang) ? CALIBRATION_STRANGER_LINES.zh : CALIBRATION_STRANGER_LINES.en;
      plan.push({ kind: "utterance", text: lines[i % lines.length]!, voice: v });
    }
    const gen = ++this.voiceGen;
    const run = { kind: "stranger" as const, step: 0, total: plan.length, state: "loading" as "loading" | "get_ready" | "listening" | "processing", text: "", hint: null as string | null };
    phase.run = run;
    this.render();
    const recorder = await this.openRecorder(gen);
    if (!recorder || gen !== this.voiceGen) return;
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      run.step = i;
      run.text = `${item.voice.name}：${item.text}`;
      run.state = "listening";
      this.render();
      const windowMs = item.kind === "keyword" ? 3000 : 7000;
      const minMs = item.kind === "keyword" ? 300 : 2000;
      const recording = recorder.record(windowMs, minMs, (ms) => this.wait(ms));
      await this.wait(200);
      await tts.speak(item.text, item.voice.name).catch(() => undefined);
      const got = await recording;
      if (gen !== this.voiceGen) return;
      if (!got.feature) continue;
      const res = await this.call({ op: "calib_trial", session: this.session, label: "stranger", segment: item.kind, voiced_ms: got.voiced_ms, model: voice.model, feature: got.feature });
      if (gen !== this.voiceGen) return;
      if (res?.ok && res.op === "calib_trial") phase.report = res.report;
      else if (res && !res.ok) return this.calibrationFailed(phase, res.message);
      this.render();
      await this.wait(300);
    }
    this.stopVoice();
    phase.run = null;
    this.render();
  }

  private calibrationFailed(phase: Extract<Phase, { kind: "voice_calibrate" }>, message: string): void {
    this.stopVoice();
    phase.run = null;
    this.error = message;
    this.render();
  }

  private async calibrationAction(phase: Extract<Phase, { kind: "voice_calibrate" }>, op: "calib_apply" | "calib_clear"): Promise<void> {
    if (!this.session || phase.run) return;
    this.busy = true;
    this.render();
    const res = await this.call({ op, session: this.session });
    this.busy = false;
    if (res?.ok && (res.op === "calib_apply" || res.op === "calib_clear")) {
      phase.report = res.report;
      this.notice = op === "calib_apply" ? "已套用建議門檻；接著播放陌生聲音並錄你的樣本來驗證。" : "已清除聲音校準資料。";
    } else if (res && !res.ok && res.code !== "declined") this.error = res.message;
    this.render();
  }

  private voiceCalibrationStep(phase: Extract<Phase, { kind: "voice_calibrate" }>): HTMLElement {
    const r = phase.report;
    const run = phase.run;
    const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
    const num = (x: number | null) => (x === null ? "—" : x.toFixed(2));
    const segs = (r?.segments ?? []).map((g) =>
      h(
        "div",
        { class: "calib-seg" },
        h("h4", {}, t(g.segment === "keyword" ? "喚醒詞" : "話語")),
        h("p", { class: "small" }, msg`收集：你的樣本 ${g.member_trials}／${CALIBRATION_MIN.member}，陌生聲音 ${g.stranger_trials}／${CALIBRATION_MIN.stranger}`),
        h("p", { class: "small" }, msg`你的分數：最低 ${num(g.member_min)}、中位數 ${num(g.member_median)}；陌生聲音最高 ${num(g.stranger_max)}`),
        h("p", { class: "small" }, g.proposed ? msg`建議門檻 ${g.proposed.match.toFixed(2)}（在你的樣本上約 ${pct(g.proposed_reject_rate)} 認不出來）` : t("資料還不夠，沒有建議門檻")),
        h("p", { class: "small" }, msg`目前門檻 ${g.current.match.toFixed(2)}（${t(g.applied ? "已套用校準值" : "未校準的起點值")}）`),
        g.applied
          ? h("p", { class: "small" }, msg`驗證：陌生聲音 ${g.verify.stranger_trials}／${CALIBRATION_VERIFY_STRANGERS}，被認成家人 ${g.verify.false_accepts} 次；你的樣本 ${g.verify.member_trials}，認不出 ${g.verify.rejects} 次`)
          : null,
        h("p", { class: g.calibrated ? "notice" : "muted small" }, t(g.calibrated ? "已校準：這種片段可以只憑聲音叫名字" : g.applied && g.verify.false_accepts > 0 ? "沒有通過：有陌生聲音被認成家人，請清除後重新收集" : "還沒校準")),
      ),
    );
    const members = this.people.filter((p) => p.voice === "enrolled");
    const select = h("select", { "aria-label": "誰的樣本" });
    for (const p of members) {
      const o = h("option", { value: p.person_id }, p.name);
      if (p.person_id === phase.member) o.setAttribute("selected", "selected");
      select.append(o);
    }
    select.addEventListener("change", () => {
      phase.member = select.value || null;
    });
    const meter = h("div", { class: "voice-meter", "aria-hidden": "true" }, h("div", { class: "voice-meter-fill", style: `width:${Math.round(this.level * 100)}%` }));
    const running = run
      ? h(
          "div",
          { class: `voice-step voice-step--${run.state}`, "aria-live": "polite" },
          h("p", { class: "muted small" }, msg`第 ${run.step + 1}／${run.total} 段`),
          h("p", { class: "voice-status" }, t(run.state === "loading" ? "載入聲音模型、打開麥克風…" : run.kind === "stranger" ? "電腦朗讀中，請保持安靜：" : run.state === "get_ready" ? "準備，聽到「叮」再念" : run.state === "listening" ? "請念：" : "處理中…")),
          run.text ? h("p", { class: "voice-prompt" }, run.kind === "stranger" ? run.text : t(run.text)) : null,
          meter,
          run.hint ? h("p", { class: "notice" }, t(run.hint)) : null,
          h("div", { class: "actions" }, button(t("停止"), () => this.calibrationFailed(phase, "已停止；已收的資料會保留。"), "btn--ghost")),
        )
      : null;
    const anyProposed = !!r?.segments.some((g) => g.proposed);
    return h(
      "div",
      { class: "family-step voice-calibration" },
      h("h3", {}, t("聲音校準")),
      h("p", { class: "muted small" }, t("只存每段聲音和每位家人比對的分數（加密），不存錄音或聲音特徵。先收集你的樣本與電腦朗讀的陌生聲音、套用建議門檻，再用新的一輪驗證：陌生聲音全部沒有被認成家人，才會只憑聲音叫名字。")),
      ...segs,
      running,
      run
        ? null
        : h(
            "div",
            { class: "actions" },
            members.length > 1 ? select : null,
            button(t("錄我的聲音（約 3 分鐘）"), () => void this.runCalibrationMember(phase), "btn--primary", !phase.member || this.busy),
            this.deps.tts ? button(t("播放陌生聲音（電腦朗讀）"), () => void this.runCalibrationStrangers(phase), "", this.busy) : null,
            button(t("套用建議門檻"), () => void this.calibrationAction(phase, "calib_apply"), "", !anyProposed || this.busy),
            button(t("清除校準資料"), () => void this.calibrationAction(phase, "calib_clear"), "btn--ghost", !r || this.busy),
            button(t("完成"), () => this.backToList(), "btn--ghost"),
          ),
    );
  }

  private voiceLabel(o: VoiceObservation): string {
    if (o.state === "matched") return msg`認出：${this.people.find((p) => p.person_id === o.person_id)?.name ?? t("（已刪除的家人）")}`;
    if (o.state === "ambiguous") return t("分不出是哪一位（太像兩位家人）");
    if (o.state === "unknown") return t("認不出來");
    return t(o.reason === "no_enrollment" ? "還沒有家人登記聲音" : "沒辦法比對");
  }

  private async submitVoice(name: string, minor: boolean, guardian: boolean, personId: string | undefined, keyword: number[][], utterance: number[][]): Promise<void> {
    if (!this.session || !this.deps.voice || keyword.length !== VOICE_KEYWORD_SAMPLES || utterance.length !== VOICE_UTTERANCE_SAMPLES) return;
    this.phase = { kind: "submitting", name };
    this.render();
    const res = await this.call({
      op: "enroll_voice",
      session: this.session,
      consent: true,
      model: this.deps.voice.model,
      keyword,
      utterance,
      ...(minor ? { guardian_confirmed: guardian } : {}),
      ...(personId ? { person_id: personId } : { name, minor }),
    });
    for (const f of [...keyword, ...utterance]) f.fill(0);
    if (!res || (this.phase as Phase).kind === "unavailable") return;
    this.phase = { kind: "list" };
    if (res.ok) this.notice = msg`已保存「${name}」的聲音。`;
    else this.error = res.message;
    this.render();
  }

  private async removeVoice(person: FamilyMember): Promise<void> {
    if (!this.session || this.busy) return;
    this.stopTry();
    this.notice = this.error = null;
    this.busy = true;
    this.render();
    const res = await this.call({ op: "delete_voice", session: this.session, person_id: person.person_id });
    this.busy = false;
    if (res && this.phase.kind !== "unavailable") {
      if (res.ok) this.notice = (person.face ? msg`已刪除「${person.name}」的聲音。` : msg`已刪除「${person.name}」。`) + (memoryNote(res) ? ` ${memoryNote(res)}` : "");
      else if (res.code !== "declined") this.error = res.message;
    }
    this.render();
  }

  // ───────────── 刪除與清除 ─────────────

  private async remove(person: FamilyMember): Promise<void> {
    if (!this.session || this.busy) return;
    this.stopTry();
    this.busy = true;
    this.notice = this.error = null;
    this.render();
    // 永久刪除：核心會先跳出原生確認（Action Gate），被拒就不寫檔。
    const res = await this.call({ op: "delete", session: this.session, person_id: person.person_id });
    this.busy = false;
    if (res?.ok) this.notice = t(`已永久刪除「${person.name}」的家人資料。`) + t(memoryNote(res));
    else if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  private async clearAll(): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    this.render();
    const res = await this.call({ op: "clear_all", session: this.session });
    this.busy = false;
    if (res?.ok) this.notice = t("已清除全部家人資料。") + t(memoryNote(res));
    else if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  // ───────────── 校正人臉辨識 ─────────────

  /** 畫面已開著時，選單列「校正人臉辨識…」直接進入校正；session 還沒開好就等開好再進。 */
  calibrate(): void {
    if (this.session && this.phase.kind !== "opening" && this.phase.kind !== "unavailable") this.startCalibration();
    else this.calibrateOnOpen = true;
  }

  private startCalibration(): void {
    this.calibrateOnOpen = false;
    this.stopTry();
    this.notice = this.error = null;
    this.phase = { kind: "calibrate" };
    this.calibration.open();
    this.render();
  }

  /** 校正時的試認：一次一格，只回狀態（matched／unknown…），不含是哪一位或分數。 */
  private async probeOnce(frame: ClientFrame): Promise<IdentityState | null> {
    if (!this.session) {
      frame.feature?.fill(0);
      return null;
    }
    const request: IdentityRequest = {
      op: "probe",
      session: this.session,
      gen: frame.gen,
      face_count: frame.face_count,
      quality: frame.quality,
      model: this.deps.model,
      ...(frame.feature ? { feature: Array.from(frame.feature) } : {}),
    };
    frame.feature?.fill(0);
    const res = await this.call(request);
    return res?.ok && res.op === "probe" ? res.observation.state : null;
  }

  // ───────────── 取樣器 ─────────────

  private startClient(onFrame: (frame: ClientFrame) => void, frameOptions?: () => FrameOptions): void {
    this.stopClient();
    this.clientState = null;
    this.quality = null;
    this.client = new IdentityClient({
      generation: () => ++this.sampleGen,
      source: this.deps.source,
      createWorker: this.deps.createWorker,
      onFrame,
      ...(frameOptions ? { frameOptions } : {}),
      onState: (state) => {
        this.clientState = state;
        const phase = this.phase;
        if (phase.kind === "capture" && state.kind === "ready") phase.hint = this.collector.prompt;
        this.render();
      },
    });
    this.client.start();
  }

  private stopClient(): void {
    this.client?.stop();
    this.client = null;
    this.probing = false;
  }

  private stopTry(): void {
    if (!this.trying) return;
    this.trying = false;
    this.observation = null;
    this.stopClient();
  }

  private backToList(): void {
    if (this.phase.kind === "calibrate") this.calibration.close();
    this.calibrateOnOpen = false;
    this.stopClient();
    this.stopVoice();
    this.collector.discard();
    this.phase = { kind: "list" };
    this.render();
  }

  // ───────────── 畫面 ─────────────

  /**
   * 內容沒變就不重畫：取樣時每秒最多 4 次回應，每次都換掉整個 DOM 會讓按鈕在按下與放開之間被替換，點不到「停止試認」或「取消」。
   */
  private render(): void {
    const key = JSON.stringify([
      getLocale(), this.phase,
      this.people,
      this.status,
      this.notice,
      this.error,
      this.busy,
      this.trying ? observationText(this.observation, this.people) : null,
      this.clientLine(),
      this.quality,
      this.collector.count,
      this.phase.kind === "calibrate" ? this.calibration.renderKey() : null,
      this.phase.kind === "voice" || this.phase.kind === "voice_test" || this.phase.kind === "voice_calibrate" ? this.level : null,
    ]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const header = h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, t("鏡頭與語音設定")), h("h2", {}, t("家人辨識")));
    const body = this.body();
    const footer = h(
      "footer",
      { class: "surface-footer" },
      button(t("收起"), () => this.deps.dismiss(), "btn--ghost"),
      h("span", { class: "hint" }, t("收起只關畫面，已登記的家人不會被刪除")),
    );
    this.element.replaceChildren(header, ...body.filter((c): c is Node => !!c && typeof c !== "string"), footer);
  }

  private body(): Child[] {
    const phase = this.phase;
    const messages: Child[] = [this.notice ? h("p", { class: "notice" }, t(this.notice)) : null, this.error ? h("p", { class: "error-text" }, t(this.error)) : null];
    if (phase.kind === "opening") return [h("p", { class: "muted" }, t("正在開啟…"))];
    if (phase.kind === "unavailable") return [h("p", { class: "error-text" }, t(phase.message)), this.explanation()];
    if (phase.kind === "name") return [...messages, this.nameStep(phase)];
    if (phase.kind === "consent") return [...messages, this.consentStep(phase)];
    if (phase.kind === "capture") return [...messages, this.captureStep(phase)];
    if (phase.kind === "voice") return [...messages, this.voiceStep(phase)];
    if (phase.kind === "voice_test") return [...messages, this.voiceTestStep(phase)];
    if (phase.kind === "voice_calibrate") return [...messages, this.voiceCalibrationStep(phase)];
    if (phase.kind === "submitting") return [h("p", { class: "muted" }, msg`正在保存「${phase.name}」…（請在系統對話框確認）`)];
    if (phase.kind === "calibrate") return [...messages, this.calibration.render()];
    return [...messages, this.statusLines(), this.namingNotice(), this.list(), this.actions(), this.trying ? this.tryPanel() : null, this.explanation()];
  }

  private statusLines(): HTMLElement | null {
    const st = this.status;
    if (!st) return null;
    const lines: Child[] = [];
    if (st.limited_reason) lines.push(h("p", { class: "notice" }, t(st.limited_reason)));
    if (st.backup_exclusion === "failed") lines.push(h("p", { class: "notice" }, t("無法把家人資料夾排除在 Time Machine 之外：備份可能含有加密檔。")));
    if (st.needs_reenroll > 0) lines.push(h("p", { class: "notice" }, msg`${st.needs_reenroll} 位家人登記時的模型版本與目前不同，不會被辨識；請刪除後重新登記。`));
    if (st.damaged > 0) lines.push(h("p", { class: "notice" }, msg`${st.damaged} 位家人的特徵資料不完整（壞資料），不會被辨識；請刪除後重新登記。`));
    if (this.deps.voice && st.state === "ready" && st.voice_models !== "ok") {
      lines.push(h("p", { class: "notice" }, t(st.voice_models === "hash_mismatch" ? "聲音模型雜湊不符，已停用錄製聲音；只能查看與刪除聲音。" : "聲音模型未安裝（在專案資料夾執行 npm run speaker:setup 後重新啟動 Nous），暫時不能錄製聲音。")));
    }
    return lines.length > 0 ? h("div", { class: "family-status" }, ...lines) : null;
  }

  /** 雲端稱名的一次性說明：沒看過時顯示「我知道了」；看過之後只在資料說明裡保留同一段文字。 */
  private namingNotice(): HTMLElement | null {
    const st = this.status;
    if (!st || st.naming_notice_seen) return null;
    return h(
      "div",
      { class: "family-status" },
      h("p", { class: "notice" }, t(CLOUD_NAMING_NOTICE)),
      h("p", { class: "muted small" }, t("按「我知道了」之前，即使認出家人也只說「我在」。")),
      h("div", { class: "actions" }, button("我知道了", () => void this.ackNaming(), "btn--primary", this.busy)),
    );
  }

  private async ackNaming(): Promise<void> {
    if (!this.session || this.busy) return;
    const res = await this.call({ op: "ack_naming", session: this.session });
    if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  private list(): HTMLElement {
    if (this.people.length === 0) return h("p", { class: "muted" }, t("還沒有登記家人。"));
    const ul = h("ul", { class: "family-list" });
    for (const p of this.people) {
      const date = new Date(p.created_at);
      const when = Number.isNaN(date.getTime()) ? "" : msg`${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} 登記`;
      ul.append(
        h(
          "li",
          { class: "family-person" },
          h("div", { class: "family-person-text" }, h("strong", {}, raw(p.name)), h("span", { class: "muted small" }, when)),
          p.minor ? h("span", { class: "chip" }, t("未成年")) : null,
          this.deps.voice ? h("span", { class: p.face ? "chip" : "chip chip--muted" }, t(p.face ? "臉：已登記" : "臉：未登記")) : null,
          this.deps.voice
            ? h("span", { class: p.voice === "needs_reenroll" ? "chip chip--failed" : p.voice === "enrolled" ? "chip" : "chip chip--muted" }, t(p.voice === "enrolled" ? "聲音：已登記" : p.voice === "needs_reenroll" ? "聲音：需重錄" : "聲音：未登記"))
            : null,
          p.needs_reenroll ? h("span", { class: "chip chip--failed" }, t("需重新登記")) : null,
          p.damaged ? h("span", { class: "chip chip--failed" }, t("壞資料")) : null,
          this.deps.voice && !p.damaged ? button(p.voice === "none" ? t("錄製聲音") : t("重錄聲音"), () => this.startFor(p, "voice"), "btn--ghost", !this.canVoice() || this.busy) : null,
          this.deps.voice && !p.face && !p.damaged ? button(t("補拍臉"), () => this.startFor(p, "face"), "btn--ghost", !this.canFace() || this.busy) : null,
          this.deps.voice && p.voice !== "none" && p.face ? button(t("刪除聲音"), () => void this.removeVoice(p), "btn--ghost", this.busy) : null,
          button(t("刪除"), () => void this.remove(p), "btn--ghost", this.busy),
        ),
      );
    }
    return ul;
  }

  private actions(): HTMLElement {
    const st = this.status;
    const ready = this.canFace();
    const full = this.people.length >= (st?.max ?? FAMILY_MAX);
    const row = h(
      "div",
      { class: "actions" },
      // SP-01：鏡頭沒開但聲音模型可用時，仍可新增只有聲音的家人。
      button(full ? `新增家人（已滿 ${st?.max ?? FAMILY_MAX} 位）` : "新增家人", () => this.startEnroll(), "btn--primary", !(ready || this.canVoice()) || full || this.busy),
      button(this.trying ? "停止試認" : "試認", () => this.toggleTry(), "", !ready || this.busy),
      // SP-02a：有家人登記聲音、講者模型可用時才能試認聲音（不需要鏡頭）。
      this.deps.voice && this.people.some((p) => p.voice === "enrolled") ? button("試認聲音", () => void this.startVoiceTest(), "", !this.canVoice() || this.busy) : null,
      // SP-03a：聲音校準（有家人登記聲音時）。
      this.deps.voice && this.people.some((p) => p.voice === "enrolled") ? button("聲音校準", () => void this.openVoiceCalibration(), "btn--ghost", !this.canVoice() || this.busy) : null,
      this.deps.tuning?.() ? button("校正人臉辨識", () => this.startCalibration(), "btn--ghost", this.busy) : null,
    );
    // 只有檔案損壞才提供清除；解不開金鑰（可能只是沒允許鑰匙圈）是可以重試的，不誘導清除。
    if (st?.state === "corrupt") row.append(button("清除全部家人資料…", () => void this.clearAll(), "btn--ghost", this.busy));
    return row;
  }

  private clientLine(): string | null {
    const s = this.clientState;
    if (!s || s.kind === "loading") return t("載入辨識模型…");
    if (s.kind === "no_camera") return t("鏡頭沒有在運作（選單列「鏡頭與語音設定」的「鏡頭」要打開）");
    if (s.kind === "error") return t(s.message);
    return null;
  }

  private tryPanel(): HTMLElement {
    const line = this.clientLine();
    return h(
      "div",
      { class: "family-try", "aria-live": "polite" },
      h("p", { class: "family-result" }, line && this.clientState?.kind !== "ready" ? line : observationText(this.observation, this.people)),
      this.quality && this.observation?.reason === "quality" ? h("p", { class: "muted small" }, t(this.quality)) : null,
      h("p", { class: "muted small" }, t(UNCALIBRATED_LABEL)),
    );
  }

  private nameStep(phase: Extract<Phase, { kind: "name" }>): HTMLElement {
    const input = h("input", { type: "text", maxlength: "16", value: phase.draft, "aria-label": "家人的名稱", placeholder: "例如：George" });
    input.value = phase.draft;
    const minor = h("input", { type: "checkbox" });
    minor.checked = phase.minor;
    const preview = h("p", { class: "muted small", "aria-live": "polite" }, namePreview(phase.draft));
    input.addEventListener("input", () => { phase.draft = input.value; preview.textContent = namePreview(input.value); });
    minor.addEventListener("change", () => { phase.minor = minor.checked; });
    return h(
      "div",
      { class: "family-step" },
      h("h3", {}, t("新增家人：名稱")),
      h("p", { class: "muted small" }, t("Nous 會用這個名稱稱呼他（1–16 個字，不能有換行或 < > { } [ ] ` \" \\）。")),
      input,
      preview,
      h("label", { class: "family-check" }, minor, t(" 這位家人未成年（需要家長確認同意）")),
      phase.error ? h("p", { class: "error-text" }, t(phase.error)) : null,
      h("div", { class: "actions" }, button(t("下一步"), () => this.submitName(input.value, minor.checked), "btn--primary"), button(t("取消"), () => this.backToList(), "btn--ghost")),
    );
  }

  private consentStep(phase: Extract<Phase, { kind: "consent" }>): HTMLElement {
    const consent = h("input", { type: "checkbox" });
    consent.checked = phase.consent;
    const guardian = h("input", { type: "checkbox" });
    guardian.checked = phase.guardian;
    const label = phase.mode === "voice" ? "開始錄音" : phase.mode === "both" ? "開始（先拍臉再錄音）" : "開始取樣";
    const next = button(t(label), () => this.beginFromConsent({ ...phase, guardian: guardian.checked }), "btn--primary", !phase.consent || (phase.minor && !phase.guardian));
    const sync = () => {
      phase.consent = consent.checked;
      phase.guardian = guardian.checked;
      next.disabled = !phase.consent || (phase.minor && !phase.guardian);
    };
    consent.addEventListener("change", sync);
    guardian.addEventListener("change", sync);
    // 新增家人時選要登記什麼；已登記的家人（person_id）只做指定的那一項。
    const modes: Child = phase.person_id || !this.deps.voice
      ? null
      : h(
          "div",
          { class: "family-modes", role: "radiogroup", "aria-label": "要登記什麼" },
          ...(["face", "voice", "both"] as const).map((m) => {
            const input = h("input", { type: "radio", name: "family-mode", value: m });
            input.checked = phase.mode === m;
            input.disabled = (m !== "voice" && !this.canFace()) || (m !== "face" && !this.canVoice());
            input.addEventListener("change", () => {
              if (!input.checked) return;
              phase.mode = m;
              this.renderedKey = null;
              this.render();
            });
            return h("label", { class: "family-check" }, input, t(m === "face" ? " 只拍臉" : m === "voice" ? " 只錄聲音" : " 兩個都做"));
          }),
        );
    const title = phase.person_id ? (phase.mode === "voice" ? msg`錄製聲音：${phase.name}` : msg`補拍臉：${phase.name}`) : msg`新增家人：${phase.name}`;
    const how =
      phase.mode === "voice"
        ? msg`接著請 ${phase.name} 在安靜的地方坐在電腦前：每聽到「叮」就念畫面上的字，先念 ${VOICE_KEYWORD_SAMPLES} 次喚醒詞、再念 ${VOICE_UTTERANCE_SAMPLES} 句短句，大約 1 分鐘。保存前還會跳出系統確認。`
        : msg`接著請 ${phase.name} 一個人面對鏡頭，依提示轉動頭部；品質合格時會自動取 ${ENROLL_TARGET} 張。保存前還會跳出系統確認。` +
          (phase.mode === "both" ? ` ${t("臉保存後接著錄聲音。")}` : "");
    return h(
      "div",
      { class: "family-step" },
      h("h3", {}, title),
      modes,
      h("p", {}, t(phase.mode === "face" ? FAMILY_EXPLANATION : phase.mode === "voice" ? VOICE_EXPLANATION : `${FAMILY_EXPLANATION} ${VOICE_EXPLANATION}`)),
      h("p", {}, t(CLOUD_NAMING_NOTICE)),
      phase.person_id ? null : h("p", { class: "muted small" }, namePreview(phase.name)),
      h("p", { class: "muted small" }, t(FAMILY_BACKUP_NOTE)),
      h("label", { class: "family-check" }, consent, msg` ${phase.name} 本人在場，已聽過說明並同意`),
      phase.minor ? h("label", { class: "family-check" }, guardian, t(" 我是家長，確認同意登記這位未成年家人")) : null,
      h("p", { class: "muted small" }, how),
      h("div", { class: "actions" }, next, button(t("取消"), () => this.backToList(), "btn--ghost")),
    );
  }

  private captureStep(phase: Extract<Phase, { kind: "capture" }>): HTMLElement {
    const line = this.clientLine();
    return h(
      "div",
      { class: "family-step", "aria-live": "polite" },
      h("h3", {}, msg`取樣中：${phase.name}`),
      h("p", { class: "family-result" }, line ?? t(phase.hint)),
      h("p", { class: "muted small" }, msg`已取 ${this.collector.count}／${ENROLL_TARGET} 張（只在記憶體，不存照片）。中途出現多張臉或追蹤中斷會整批重來。`),
      h("div", { class: "actions" }, button(t("取消"), () => this.backToList(), "btn--ghost")),
    );
  }

  private voiceStep(phase: Extract<Phase, { kind: "voice" }>): HTMLElement {
    const prompt = VOICE_PROMPTS[phase.step]!;
    const total = VOICE_PROMPTS.length;
    const status =
      phase.state === "loading" ? t("載入聲音模型、打開麥克風…") : phase.state === "get_ready" ? t("準備，聽到「叮」再念") : phase.state === "listening" ? t("請念：") : t("處理中…");
    const meter = h("div", { class: "voice-meter", "aria-hidden": "true" }, h("div", { class: "voice-meter-fill", style: `width:${Math.round(this.level * 100)}%` }));
    return h(
      "div",
      { class: `family-step voice-step voice-step--${phase.state}`, "aria-live": "polite" },
      h("h3", {}, msg`錄製聲音：${phase.name}`),
      phase.state === "loading" ? null : h("p", { class: "muted small" }, msg`第 ${phase.step + 1}／${total} 段（${prompt.kind === "keyword" ? t("喚醒詞") : t("短句")}）`),
      h("p", { class: "voice-status" }, status),
      phase.state === "loading" ? null : h("p", { class: "voice-prompt" }, t(prompt.text)),
      meter,
      phase.hint ? h("p", { class: "notice" }, t(phase.hint)) : null,
      h("p", { class: "muted small" }, t("錄音只在記憶體裡算成聲音特徵，算完就丟掉；不存錄音、不上傳。")),
      h("div", { class: "actions" }, button(t("取消"), () => this.backToList(), "btn--ghost")),
    );
  }

  private voiceTestStep(phase: Extract<Phase, { kind: "voice_test" }>): HTMLElement {
    const prompt = VOICE_TEST_PROMPTS[phase.step]!;
    const done = phase.state === "done";
    const status =
      phase.state === "loading" ? t("載入聲音模型、打開麥克風…") : phase.state === "get_ready" ? t("準備，聽到「叮」再念") : phase.state === "listening" ? t("請念：") : done ? t("試認完成") : t("處理中…");
    const meter = h("div", { class: "voice-meter", "aria-hidden": "true" }, h("div", { class: "voice-meter-fill", style: `width:${Math.round(this.level * 100)}%` }));
    const results = h("ul", { class: "voice-results" }, ...phase.results.map((r) => h("li", {}, msg`${r.kind === "keyword" ? t("喚醒詞") : t("短句")}：${r.label}`)));
    return h(
      "div",
      { class: `family-step voice-step voice-step--${done ? "done" : phase.state}`, "aria-live": "polite" },
      h("h3", {}, t("試認聲音")),
      h("p", { class: "voice-status" }, status),
      done || phase.state === "loading" ? null : h("p", { class: "voice-prompt" }, t(prompt.text)),
      done ? null : meter,
      phase.hint ? h("p", { class: "notice" }, t(phase.hint)) : null,
      phase.results.length ? results : null,
      h("p", { class: "muted small" }, t(UNCALIBRATED_LABEL)),
      h("p", { class: "muted small" }, t("只憑聲音不會叫名字：門檻校準之前，喚醒時聲音只用來確認或取消認臉的結果。")),
      h(
        "div",
        { class: "actions" },
        done ? button(t("再試一次"), () => void this.startVoiceTest(), "btn--primary") : null,
        button(done ? t("完成") : t("取消"), () => this.backToList(), "btn--ghost"),
      ),
    );
  }

  private explanation(): HTMLElement {
    return h(
      "div",
      { class: "family-explain" },
      h("p", { class: "muted small" }, t(FAMILY_EXPLANATION)),
      h("p", { class: "muted small" }, t(CLOUD_NAMING_NOTICE)),
      h("p", { class: "muted small" }, t(FAMILY_BACKUP_NOTE)),
    );
  }
}
