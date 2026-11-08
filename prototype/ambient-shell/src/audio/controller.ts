// 常駐喚醒聆聽的控制器（WK-01a）：把 AudioFrontEnd、自我觸發防護、本機提示音與觸發接在一起，給 src/main.ts 使用。
// WK-01 的終點：偵測 → 防護（播音、遠端播放、提示音期間與 3 秒去重）→ 本機提示音（可取消）→ 沒被取消才呼叫 onTrigger。
// 預設的 onTrigger 只顯示字幕「聽到了」並回到聆聽，**不開通話**；WK-02 以 setTriggerHandler 接上 startRealtime("wake_word")。
// WK-02 另外：subscribe（Companion activation=wake 的共用接口，只交付契約）、pauseFor（限速暫停、時間到自動恢復）、
// watchCall（喚醒開始的通話沒人出聲就結束，src/audio/wake-call.ts）。
// 時鐘、擷取、提示音都可注入；假偵測器只在 tests/fixtures/，測試見 tests/audio-front-end.test.ts。

import {
  WAKE_REASON_LABEL,
  WAKE_TEXT,
  type WakeActivation,
  type WakeActivationPort,
  type WakeReason,
  type WakeReport,
  type WakeRuntimeState,
  type WakeSettingsView,
  type WakeTrigger,
} from "../../shared/wake.ts";
import type { EarconPlayback, EarconPlayer } from "./earcon.ts";
import { AudioFrontEnd, type CaptureDeps, type MicOpener, type StartHow } from "./front-end.ts";
import { WakeGuard, type GuardSource } from "./guard.ts";
import { WakeCallWatch, type WakeCallOptions } from "./wake-call.ts";

export type PowerEvent = "suspend" | "resume" | "lock" | "unlock";
export type WakeCommand = "wake-off" | "wake-pause" | "wake-resume";
export const WAKE_COMMANDS: readonly WakeCommand[] = ["wake-off", "wake-pause", "wake-resume"];

/** WK-02 的接口：喚醒觸發後要做什麼（預設只顯示「聽到了」）。 */
export type WakeTriggerHandler = (trigger: WakeTrigger) => void;

export interface WakeHost {
  now(): number;
  /** 核心的 settings.wake.runtime。 */
  runtime(): WakeRuntimeState;
  /** 顯示字幕；text 與 values 都是共用翻譯表的原文（呼叫端翻譯後代入 {0}）。 */
  caption(text: string, ...values: string[]): void;
  /** 主視窗現在看得到嗎（document.visibilityState）。 */
  visible(): boolean;
  /** 主視窗變成看得到時通知（回傳取消）。 */
  onVisible(listener: () => void): () => void;
  /** 狀態改變（電子腦的小圖示、選單列）。 */
  state(report: WakeReport): void;
  newId(): string;
}

export interface WakeControllerDeps {
  /** 開麥克風（main.ts 注入 audioDevices：跟著「聲音輸入」設定）；不支援的環境為 null。 */
  mic: MicOpener | null;
  capture: CaptureDeps;
  earcon: EarconPlayer;
  /** 單次計時器（預設 setTimeout）；回傳取消。限速暫停的自動恢復用，測試注入假的。 */
  timer?(run: () => void, ms: number): () => void;
}

export class WakeController implements WakeActivationPort {
  readonly frontEnd: AudioFrontEnd;
  readonly guard: WakeGuard;
  private settings: WakeSettingsView | null = null;
  /** 選單列「關掉」已先停止收音，等核心保存成「關閉」前，不因為舊的設定再打開。 */
  private offRequested = false;
  private earconPlaying: EarconPlayback | null = null;
  private pendingResumeCaption: (() => void) | null = null;
  private lastErrorCaption: WakeReason | null = null;
  private trigger: WakeTriggerHandler;
  private readonly subscribers = new Set<(activation: WakeActivation) => void>();
  private cancelRateResume: (() => void) | null = null;
  private rateToken: { cancel(): void } | null = null;

  constructor(
    private readonly host: WakeHost,
    private readonly deps: WakeControllerDeps,
  ) {
    this.guard = new WakeGuard(host.now);
    this.trigger = () => host.caption(WAKE_TEXT.heard);
    this.frontEnd = new AudioFrontEnd(
      { mic: deps.mic, capture: deps.capture, runtime: () => host.runtime() },
      {
        state: (report) => this.onState(report),
        detected: (keyword) => void this.onDetected(keyword, deps.earcon),
        listening: (_deviceId, how) => this.onListening(how),
      },
    );
  }

  get state(): WakeReport {
    return this.frontEnd.current;
  }

  /** 設定頁的「喚醒詞門檻調整」（還沒讀到設定時是 0＝產品原本的門檻）；擷取 worker 建立時讀。 */
  get thresholdOffset(): number {
    return this.settings?.wake_threshold_offset ?? 0;
  }

  /** WK-02：換成真正開通話的處理（startRealtime("wake_word")、限速、問候）。 */
  setTriggerHandler(handler: WakeTriggerHandler): void {
    this.trigger = handler;
  }

  /** Companion activation=wake 的共用接口（WK-02 只交付契約）：每次觸發通知一次，只有識別碼、時間與關鍵詞編號。 */
  subscribe(listener: (activation: WakeActivation) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * WK-02 限速：喚醒開始的通話超過每分鐘上限（核心拒絕並給 retry_after_ms）。暫停聆聽（paused／rate_limited），
   * ms 後自動恢復；再次呼叫時以新的時間為準。
   */
  pauseFor(reason: "rate_limited", ms: number): void {
    this.cancelRateResume?.();
    this.cancelRateResume = null;
    this.rateToken = null;
    this.cancelEarcon();
    this.frontEnd.pause(reason);
    const timer = this.deps.timer ?? ((run: () => void, delay: number) => {
      const id = setTimeout(run, delay);
      return () => clearTimeout(id);
    });
    // 以這次的 token 比對（不在計時器回呼裡讀還沒指定的 cancel；計時器同步執行也安全）。
    const token = { cancel: () => {} };
    this.rateToken = token;
    token.cancel = timer(() => {
      if (this.rateToken !== token) return;
      this.rateToken = null;
      this.cancelRateResume = null;
      this.frontEnd.resume(reason);
    }, Math.max(0, ms));
    if (this.rateToken === token) this.cancelRateResume = () => token.cancel();
  }

  /** WK-02：喚醒開始的通話的「沒人出聲就結束」計時（src/audio/wake-call.ts）。 */
  watchCall(options: Omit<WakeCallOptions, "now">): WakeCallWatch {
    return new WakeCallWatch({ now: this.host.now, ...options });
  }

  /**
   * 核心設定（hello 或 settings.updated）。第一次讀到偏好為開＝App 啟動時自動恢復；
   * 之後由關變開＝使用者剛在選單打開；由開變關＝停止。麥克風一律跟著「聲音輸入」設定（舊的 device_id 不再使用）。
   */
  applySettings(view: WakeSettingsView): void {
    const previous = this.settings;
    this.settings = view;
    if (this.offRequested) {
      if (view.wake_listen) return;
      this.offRequested = false;
    }
    if (!previous) {
      if (view.wake_listen) this.frontEnd.setPreference(true, "auto_resume");
      return;
    }
    // 門檻調整值改了：聆聽中就以新門檻重建擷取（閒置時立即，通話中等這通結束，同「聲音輸入」改了）。
    if ((previous.wake_threshold_offset ?? 0) !== (view.wake_threshold_offset ?? 0) && view.wake_listen && previous.wake_listen) this.frontEnd.reopen();
    if (previous.wake_listen === view.wake_listen) return;
    this.frontEnd.setPreference(view.wake_listen, view.wake_listen ? "enable" : "auto_resume");
  }

  /** 選單列的暫停、繼續與立即停止（不打開視窗）。認得的指令回 true。 */
  command(name: string): boolean {
    switch (name) {
      case "wake-off":
        this.offRequested = true;
        this.cancelEarcon();
        this.frontEnd.setPreference(false, "auto_resume");
        return true;
      case "wake-pause":
        this.cancelEarcon();
        this.frontEnd.pause("user_pause");
        return true;
      case "wake-resume":
        this.frontEnd.resume("user_pause");
        return true;
      default:
        return false;
    }
  }

  /** 系統睡眠、醒來、鎖定、解鎖（App 主程序轉來的列舉值）。 */
  power(event: PowerEvent): void {
    if (event === "suspend" || event === "lock") {
      this.cancelEarcon();
      this.frontEnd.pause(event === "suspend" ? "sleep" : "lock");
    } else this.frontEnd.resume(event === "resume" ? "sleep" : "lock");
  }

  /**
   * 服務模式（App 主程序轉來的 enter／exit）：進入時停止收音（paused／service），只有離開才解除；離開後和解鎖一樣依偏好自動恢復。
   * 不改保存的偏好。
   */
  service(active: boolean): void {
    if (active) {
      this.cancelEarcon();
      this.frontEnd.pause("service");
    } else this.frontEnd.resume("service");
  }

  /** Web Speech（按下說話、語音模式）開始或結束收音。 */
  webSpeech(active: boolean): void {
    if (active) this.cancelEarcon();
    this.frontEnd.webSpeech(active);
  }

  /** 「聲音輸入」改了或之前找不到的麥克風回來了：閒置時重開，通話中等這通結束（AudioFrontEnd.reopen）。 */
  inputChanged(): void {
    this.frontEnd.reopen();
  }

  /** 即時語音租用麥克風（兩條路徑的 getMicrophone）。 */
  lease(): Promise<MediaStream> {
    this.cancelEarcon();
    return this.frontEnd.lease();
  }

  /** 通話結束：兩條路徑的 releaseMicrophone(自己的那一份)，只歸還那一份複製品。 */
  releaseLease(stream: MediaStream): void {
    this.frontEnd.releaseLease(stream);
  }

  /** 保險：呼叫端確認已經沒有任何進行中或開始中的通話時，歸還所有還沒歸還的複製品。 */
  releaseAllLeases(): void {
    this.frontEnd.releaseAllLeases();
  }

  /** 自我觸發防護：Nous 念話（speakText）、即時語音播放、處理中提示音（cue）。 */
  begin(source: Exclude<GuardSource, "earcon">): void {
    this.guard.begin(source);
  }

  end(source: Exclude<GuardSource, "earcon">): void {
    this.guard.end(source);
  }

  /** Esc、張掌停止、說「收起」：提示音播放中就取消（不觸發）。回傳是否真的取消了。 */
  cancelEarcon(): boolean {
    const playing = this.earconPlaying;
    if (!playing) return false;
    this.earconPlaying = null;
    playing.cancel();
    return true;
  }

  dispose(): void {
    this.cancelRateResume?.();
    this.cancelRateResume = null;
    this.rateToken = null;
    this.subscribers.clear();
    this.cancelEarcon();
    this.pendingResumeCaption?.();
    this.pendingResumeCaption = null;
    this.frontEnd.dispose();
  }

  // ───────────── 內部 ─────────────

  private onState(report: WakeReport): void {
    this.host.state(report);
    if (report.state !== "listening_local") this.cancelEarcon();
    // 停用時連防護的計數與去重時間一起歸零。
    if (report.state === "off") this.guard.reset();
    // 同一個原因只說一次（例如引擎缺少時，每通電話結束後不再重複）；真的聽到或關掉之後才重新計算。
    if (report.state === "listening_local" || report.state === "off") this.lastErrorCaption = null;
    if (report.state === "error" && report.reason && report.reason !== this.lastErrorCaption) {
      this.lastErrorCaption = report.reason;
      const stopped = report.reason === "device_ended" || report.reason === "runtime_load_failed";
      this.host.caption(stopped ? WAKE_TEXT.stopped : WAKE_TEXT.failed, WAKE_REASON_LABEL[report.reason]);
    }
  }

  private onListening(how: StartHow): void {
    // 一次性恢復字幕：只在自動恢復（App 啟動、睡眠或鎖定回來）成功時；主視窗看不到就等它出現再顯示一次。
    if (how !== "auto_resume") return;
    this.pendingResumeCaption?.();
    this.pendingResumeCaption = null;
    if (this.host.visible()) {
      this.host.caption(WAKE_TEXT.resumed);
      return;
    }
    const stop = this.host.onVisible(() => {
      stop();
      if (this.pendingResumeCaption !== stop) return;
      this.pendingResumeCaption = null;
      if (this.frontEnd.current.state === "listening_local") this.host.caption(WAKE_TEXT.resumed);
    });
    this.pendingResumeCaption = stop;
  }

  private async onDetected(keyword: number, earcon: EarconPlayer): Promise<void> {
    if (this.earconPlaying || this.guard.check() !== null) return;
    const detectedAt = this.host.now();
    const playback = earcon.play();
    this.earconPlaying = playback;
    this.guard.begin("earcon");
    let played = false;
    try {
      played = await playback.done;
    } finally {
      this.guard.end("earcon");
      if (this.earconPlaying === playback) this.earconPlaying = null;
    }
    // 取消、或提示音期間離開了聆聽（暫停、通話、睡眠）：不觸發。
    if (!played || this.frontEnd.current.state !== "listening_local") return;
    const trigger: WakeTrigger = { wake_id: this.host.newId(), detected_at: detectedAt, keyword_index: keyword };
    this.trigger(trigger);
    for (const listener of [...this.subscribers]) {
      try {
        listener({ activation: "wake", ...trigger });
      } catch {
        // 訂閱者的錯誤不影響喚醒
      }
    }
  }
}
