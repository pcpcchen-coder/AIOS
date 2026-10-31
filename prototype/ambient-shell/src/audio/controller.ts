// 常駐喚醒聆聽的控制器（WK-01a）：把 AudioFrontEnd、自我觸發防護、本機提示音與觸發接在一起，給 src/main.ts 使用。
// WK-01 的終點：偵測 → 防護（播音、遠端播放、提示音期間與 3 秒去重）→ 本機提示音（可取消）→ 沒被取消才呼叫 onTrigger。
// 預設的 onTrigger 只顯示字幕「聽到了」並回到聆聽，**不開通話**；WK-02 以 setTriggerHandler 接上 startRealtime("wake_word")。
// 時鐘、擷取、提示音都可注入；假偵測器只在 tests/fixtures/，測試見 tests/audio-front-end.test.ts。

import { WAKE_REASON_LABEL, WAKE_TEXT, type WakeReason, type WakeReport, type WakeRuntimeState, type WakeSettingsView, type WakeTrigger } from "../../shared/wake.ts";
import type { EarconPlayback, EarconPlayer } from "./earcon.ts";
import { AudioFrontEnd, type CaptureDeps, type MediaDevicesLike, type StartHow } from "./front-end.ts";
import { WakeGuard, type GuardSource } from "./guard.ts";

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
  /** 保存上次真的在聽的麥克風（POST /api/settings/wake）。 */
  saveDeviceId(deviceId: string): Promise<void>;
  newId(): string;
}

export interface WakeControllerDeps {
  mediaDevices: MediaDevicesLike | null;
  capture: CaptureDeps;
  earcon: EarconPlayer;
}

export class WakeController {
  readonly frontEnd: AudioFrontEnd;
  readonly guard: WakeGuard;
  private settings: WakeSettingsView | null = null;
  /** 選單列「關掉」已先停止收音，等核心保存成「關閉」前，不因為舊的設定再打開。 */
  private offRequested = false;
  private earconPlaying: EarconPlayback | null = null;
  private pendingResumeCaption: (() => void) | null = null;
  private lastErrorCaption: WakeReason | null = null;
  private trigger: WakeTriggerHandler;

  constructor(
    private readonly host: WakeHost,
    deps: WakeControllerDeps,
  ) {
    this.guard = new WakeGuard(host.now);
    this.trigger = () => host.caption(WAKE_TEXT.heard);
    this.frontEnd = new AudioFrontEnd(
      { mediaDevices: deps.mediaDevices, capture: deps.capture, runtime: () => host.runtime() },
      {
        state: (report) => this.onState(report),
        detected: (keyword) => void this.onDetected(keyword, deps.earcon),
        listening: (deviceId, how) => this.onListening(deviceId, how),
      },
    );
  }

  get state(): WakeReport {
    return this.frontEnd.current;
  }

  /** WK-02：換成真正開通話的處理（startRealtime("wake_word")、限速、問候）。 */
  setTriggerHandler(handler: WakeTriggerHandler): void {
    this.trigger = handler;
  }

  /**
   * 核心設定（hello 或 settings.updated）。第一次讀到偏好為開＝App 啟動時自動恢復（exact deviceId）；
   * 之後由關變開＝使用者剛在選單打開（用預設麥克風）；由開變關＝停止。
   */
  applySettings(view: WakeSettingsView): void {
    const previous = this.settings;
    this.settings = view;
    if (this.offRequested) {
      if (view.wake_listen) return;
      this.offRequested = false;
    }
    if (!previous) {
      if (view.wake_listen) this.frontEnd.setPreference(true, view.device_id, "auto_resume");
      return;
    }
    if (previous.wake_listen === view.wake_listen) return;
    this.frontEnd.setPreference(view.wake_listen, view.device_id, view.wake_listen ? "enable" : "auto_resume");
  }

  /** 選單列的暫停、繼續與立即停止（不打開視窗）。認得的指令回 true。 */
  command(name: string): boolean {
    switch (name) {
      case "wake-off":
        this.offRequested = true;
        this.cancelEarcon();
        this.frontEnd.setPreference(false, null, "auto_resume");
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

  /** Web Speech（按下說話、語音模式）開始或結束收音。 */
  webSpeech(active: boolean): void {
    if (active) this.cancelEarcon();
    this.frontEnd.webSpeech(active);
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

  /** 自我觸發防護：Nous 念話（speakText）、即時語音播放。 */
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

  private onListening(deviceId: string | null, how: StartHow): void {
    if (deviceId && deviceId !== this.settings?.device_id) {
      if (this.settings) this.settings = { ...this.settings, device_id: deviceId };
      void this.host.saveDeviceId(deviceId).catch(() => undefined);
    }
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
    this.trigger({ wake_id: this.host.newId(), detected_at: detectedAt, keyword_index: keyword });
  }
}
