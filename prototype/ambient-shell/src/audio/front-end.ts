// AudioFrontEnd（docs/17 §10.3、ADR-0003；WK-01a）：NOUS_WAKE=on 時，renderer 內唯一呼叫 getUserMedia({ audio }) 的模組。
// - 常駐喚醒聆聽：來源 track → 擷取圖（AudioWorklet → worker，capture.ts）。狀態以裝置事件為準：只有 track 為 live
//   而且 worklet／worker 回報 started 之後才是 listening_local（17 §5.1）。
// - 即時語音改為租用：lease() 回傳來源的複製品（clone），通話結束時以 releaseLease(那一份複製品) 只歸還自己的那一份。租出期間斷開擷取圖（in_call），
//   KWS 暫停、環形緩衝清空；喚醒關閉時租用才開來源、最後一個租用結束就停止來源，行為等同今天。
// - Web Speech（按下說話、語音模式）自己開擷取：開始時 webSpeech(true) 完全讓出（released），結束時 webSpeech(false) 在下一個
//   macrotask 才重新取得；同一輪就來的租用（語音模式直接切到即時語音）會取消這次重新取得，不會同時有兩個 getUserMedia。
// - 暫停（使用者，只到本次執行結束）、睡眠、鎖定：停止來源；醒來、解鎖依偏好自動恢復（exact deviceId，找不到就 device_missing）。
// - WK-02 限速（rate_limited）：喚醒開始的通話超過每分鐘上限時暫停，時間到由控制器呼叫 resume("rate_limited") 自動恢復。
// - track ended → error（device_ended），不改用其他麥克風，也不在背景重試；只有使用者或系統事件才會再試一次。
// - 引擎檔案不在（runtime 不是 ok）時直接 error runtime_missing，**不開麥克風**。
// 這個檔案只看得到 MediaStream 與事件，拿不到樣本；樣本只在 worklet 與 worker（tests/audio-privacy.test.ts 靜態檢查）。

import type { WakeErrorReason, WakeReason, WakeReport, WakeRuntimeState, WakeState } from "../../shared/wake.ts";

/** 與即時語音相同的處理約束（同一裝置不同約束會互相影響，17 §10.3）。 */
export const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

export type CaptureFailure = "runtime_missing" | "runtime_load_failed";

export interface CaptureEvents {
  /** worklet 的樣本已經在 worker 處理（第一塊）。 */
  started(): void;
  detected(keywordIndex: number): void;
  failed(reason: CaptureFailure): void;
}

export interface CaptureGraph {
  /** 清空 worker 的環形緩衝、斷開 worklet、結束 worker。可重複呼叫。 */
  stop(): void;
}

export interface CaptureDeps {
  connect(stream: MediaStream, events: CaptureEvents): Promise<CaptureGraph>;
}

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface FrontEndDeps {
  /** 排到下一個 macrotask 執行（預設 setTimeout 0）；回傳取消。測試可注入。 */
  defer?(run: () => void): () => void;
  /** 沒有 mediaDevices（不支援的環境）時為 null。 */
  mediaDevices: MediaDevicesLike | null;
  capture: CaptureDeps;
  /** 喚醒引擎檔案的核對結果（核心的 settings.wake.runtime）；不是 ok 時不開麥克風。 */
  runtime(): WakeRuntimeState;
}

/** 是什麼讓擷取開始：enable 是使用者在選單打開（用預設麥克風）；其餘都沿用上次的麥克風（exact deviceId）。 */
export type StartHow = "enable" | "auto_resume" | "user_resume" | "reclaim" | "after_call";

export interface FrontEndEvents {
  state(report: WakeReport): void;
  detected(keywordIndex: number): void;
  /** 真的進入 listening_local；deviceId 給偏好保存（下次自動恢復時以 exact 指定）。 */
  listening(deviceId: string | null, how: StartHow): void;
}

type SystemPause = "sleep" | "lock" | "rate_limited";

export class AudioFrontEnd {
  private wanted = false;
  private offReason: "pref_off" | null = null;
  private deviceId: string | null = null;
  private userPaused = false;
  private readonly systemPause = new Set<SystemPause>();
  private webSpeechActive = false;
  /** 排定中的 Web Speech 結束後重新取得（下一個 macrotask）；租用會取消它。 */
  private pendingReclaim: (() => void) | null = null;
  /** 來源 track 在通話中或暫停時結束（拔除）：等不再被擋時再照實報 device_ended，不在通話中顯示喚醒錯誤。 */
  private endedPending = false;
  private leases: MediaStream[] = [];
  private source: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private graph: CaptureGraph | null = null;
  /** 進行中的開始流程的世代；null＝沒有在開始。任何狀態改變都會讓舊世代失效。 */
  private starting: number | null = null;
  private gen = 0;
  private report: WakeReport = { state: "off", reason: null };

  constructor(
    private readonly deps: FrontEndDeps,
    private readonly events: FrontEndEvents,
  ) {}

  get current(): WakeReport {
    return this.report;
  }

  /** 測試與診斷用：目前有沒有來源 track（只看有無，不給 track 本身）。 */
  get hasSource(): boolean {
    return this.source !== null;
  }

  get leased(): boolean {
    return this.leases.length > 0;
  }

  /**
   * 偏好改變（設定讀到或選單切換）。on：how 為 enable（使用者剛打開，用預設麥克風）或 auto_resume（App 啟動時偏好已開，
   * 用 deviceId 指定的那一支）。off：停止來源、清空緩衝，狀態 off（pref_off）。
   */
  setPreference(on: boolean, deviceId: string | null, how: "enable" | "auto_resume"): void {
    this.deviceId = deviceId;
    if (on === this.wanted && on) return;
    if (!on) {
      // 第一次讀到「關閉」時狀態就是 off（沒有原因）；使用者關掉的才標 pref_off。
      if (this.wanted) this.offReason = "pref_off";
      this.userPaused = false;
      this.endedPending = false;
    }
    this.wanted = on;
    this.sync(how);
  }

  /** 使用者「暫停聆聽」（只到本次執行結束）或系統睡眠、鎖定。 */
  pause(reason: "user_pause" | SystemPause): void {
    if (reason === "user_pause") this.userPaused = true;
    else this.systemPause.add(reason);
    this.sync("user_resume");
  }

  /**
   * 使用者「繼續聆聽」，或系統醒來（sleep）、解鎖（lock）、限速時間到（rate_limited）。使用者暫停中時系統事件不恢復。
   * 限速結束不算自動恢復（不顯示「已恢復」字幕，沿用上次的麥克風）。
   */
  resume(reason: "user_pause" | SystemPause): void {
    if (reason === "user_pause") this.userPaused = false;
    else this.systemPause.delete(reason);
    this.sync(reason === "user_pause" || reason === "rate_limited" ? "user_resume" : "auto_resume");
  }

  /** Web Speech 開始（true：完全讓出麥克風）或結束（false：重新取得）。 */
  webSpeech(active: boolean): void {
    if (active) {
      this.cancelReclaim();
      if (this.webSpeechActive) return;
      this.webSpeechActive = true;
      this.sync("reclaim");
      return;
    }
    if (!this.webSpeechActive || this.pendingReclaim) return;
    const defer = this.deps.defer ?? ((run: () => void) => {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    });
    const cancel = defer(() => {
      if (this.pendingReclaim !== cancel) return;
      this.pendingReclaim = null;
      this.webSpeechActive = false;
      this.sync("reclaim");
    });
    this.pendingReclaim = cancel;
  }

  private cancelReclaim(): void {
    const cancel = this.pendingReclaim;
    this.pendingReclaim = null;
    cancel?.();
  }

  /**
   * 即時語音租用麥克風：回傳來源串流的複製品。來源已在時直接複製（同一個裝置、同一條來源），沒有時以即時語音原本的約束開一條。
   * 失敗時丟出 getUserMedia 的錯誤（呼叫端照舊依 name 顯示原因）。
   */
  async lease(): Promise<MediaStream> {
    // Web Speech 剛結束、還沒重新取得：直接交給這次租用，不另外開一條。
    if (this.pendingReclaim) {
      this.cancelReclaim();
      this.webSpeechActive = false;
    }
    // 租出期間不跑 KWS：先停擷取圖（清空緩衝），讓進行中的開始流程失效。
    this.invalidate();
    this.stopGraph();
    let source = this.source && this.track?.readyState === "live" ? this.source : null;
    if (!source) {
      let stream: MediaStream;
      try {
        if (!this.deps.mediaDevices) throw Object.assign(new Error("找不到可用的麥克風。"), { name: "NotFoundError" });
        stream = await this.deps.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS } });
      } catch (err) {
        // 通話拿不到麥克風：喚醒照原本的狀態繼續（或停著），錯誤交回即時語音照舊顯示。
        this.sync("after_call");
        throw err;
      }
      if (this.source) stopTracks(this.source);
      if (!this.adopt(stream)) {
        this.sync("after_call");
        throw Object.assign(new Error("找不到可用的麥克風。"), { name: "NotFoundError" });
      }
      source = stream;
    }
    const clone = source.clone();
    this.leases.push(clone);
    this.sync("after_call");
    return clone;
  }

  /**
   * 通話結束：只歸還並停止**這一份**複製品（可重複呼叫）。過時的工作階段晚到的歸還不會停掉新通話的複製品。
   * 沒有租用時，偏好仍開、沒有暫停就回到聆聽，否則停止來源。
   */
  releaseLease(stream: MediaStream): void {
    const index = this.leases.indexOf(stream);
    if (index < 0) return;
    this.leases.splice(index, 1);
    stopTracks(stream);
    if (this.leases.length === 0) this.sync("after_call");
  }

  /** 保險：沒有任何進行中的通話時（呼叫端確認），歸還所有還沒歸還的複製品。 */
  releaseAllLeases(): void {
    if (this.leases.length === 0) return;
    for (const stream of this.leases) stopTracks(stream);
    this.leases = [];
    this.sync("after_call");
  }

  /** 結束（頁面卸載）：停止一切。 */
  dispose(): void {
    this.cancelReclaim();
    this.wanted = false;
    this.invalidate();
    this.stopGraph();
    for (const stream of this.leases) stopTracks(stream);
    this.leases = [];
    this.stopSource();
    this.setState("off", null);
  }

  // ───────────── 內部 ─────────────

  private blocked(): WakeReport | null {
    if (!this.wanted) return { state: "off", reason: this.offReason };
    if (this.leases.length > 0) return { state: "in_call", reason: "realtime" };
    if (this.webSpeechActive) return { state: "released", reason: "web_speech" };
    if (this.userPaused) return { state: "paused", reason: "user_pause" };
    if (this.systemPause.has("lock")) return { state: "paused", reason: "lock" };
    if (this.systemPause.has("sleep")) return { state: "paused", reason: "sleep" };
    if (this.systemPause.has("rate_limited")) return { state: "paused", reason: "rate_limited" };
    return null;
  }

  private sync(how: StartHow): void {
    const blocked = this.blocked();
    if (!blocked && this.endedPending) {
      this.endedPending = false;
      this.fail("device_ended");
      return;
    }
    if (blocked) {
      this.invalidate();
      this.stopGraph();
      if (this.leases.length === 0) this.stopSource();
      this.setState(blocked.state, blocked.reason);
      return;
    }
    if (this.graph || this.starting !== null) return;
    void this.start(how);
  }

  private async start(how: StartHow): Promise<void> {
    const gen = ++this.gen;
    this.starting = gen;
    try {
      if (this.deps.runtime() !== "ok") return this.fail("runtime_missing");
      if (!this.deps.mediaDevices) return this.fail("unsupported");
      this.setState("armed", how === "auto_resume" ? "auto_resume" : "starting");
      const exact = how !== "enable" && this.deviceId !== null ? this.deviceId : null;
      if (!this.source || this.track?.readyState !== "live") {
        let stream: MediaStream;
        try {
          stream = await this.deps.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, ...(exact ? { deviceId: { exact } } : {}) } });
        } catch (err) {
          if (gen !== this.gen) return;
          return this.fail(micError(err, exact !== null));
        }
        if (gen !== this.gen) {
          stopTracks(stream);
          return;
        }
        if (this.source) stopTracks(this.source);
        if (!this.adopt(stream)) return this.fail("audio_failed");
        // 不改用其他麥克風：指定的裝置拿到的卻是別支（瀏覽器不該這樣做，但照實檢查）就當成找不到。
        const actual = this.track?.getSettings?.().deviceId;
        if (exact && actual && actual !== exact) return this.fail("device_missing");
      }
      const source = this.source!;
      let graph: CaptureGraph;
      try {
        graph = await this.deps.capture.connect(source, {
          started: () => this.onStarted(gen, how),
          detected: (keyword) => {
            if (gen === this.gen && this.report.state === "listening_local") this.events.detected(keyword);
          },
          failed: (reason) => {
            if (gen === this.gen) this.fail(reason);
          },
        });
      } catch {
        if (gen !== this.gen) return;
        return this.fail("audio_failed");
      }
      if (gen !== this.gen) {
        graph.stop();
        return;
      }
      this.graph = graph;
    } finally {
      if (this.starting === gen) this.starting = null;
    }
  }

  private onStarted(gen: number, how: StartHow): void {
    if (gen !== this.gen || !this.graph || this.track?.readyState !== "live") return;
    if (this.report.state === "listening_local") return;
    this.deviceId = this.track.getSettings?.().deviceId ?? this.deviceId;
    this.setState("listening_local", null);
    this.events.listening(this.deviceId, how);
  }

  /** 接手新的來源串流；音軌不是 live 時停止並回 false。 */
  private adopt(stream: MediaStream): boolean {
    const track = stream.getAudioTracks()[0] ?? null;
    if (!track || track.readyState !== "live") {
      stopTracks(stream);
      this.source = null;
      this.track = null;
      return false;
    }
    this.source = stream;
    this.track = track;
    track.addEventListener("ended", () => this.onEnded(track));
    return true;
  }

  private onEnded(track: MediaStreamTrack): void {
    if (track !== this.track) return;
    // 拔除或系統停止：不換裝置、不重試。來源清掉；偏好開著時記下，等沒有通話、沒有暫停時才照實報錯
    // （偏好關著時通話中拔掉麥克風，不會出現喚醒錯誤）。
    this.invalidate();
    this.stopGraph();
    this.source = null;
    this.track = null;
    if (this.wanted) this.endedPending = true;
    this.sync("after_call");
  }

  private fail(reason: WakeErrorReason): void {
    this.invalidate();
    this.stopGraph();
    if (this.leases.length === 0) this.stopSource();
    this.setState("error", reason);
  }

  private invalidate(): void {
    this.gen++;
    this.starting = null;
  }

  private stopGraph(): void {
    const graph = this.graph;
    this.graph = null;
    graph?.stop();
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null;
    this.track = null;
    if (source) stopTracks(source);
  }

  private setState(state: WakeState, reason: WakeReason | null): void {
    if (this.report.state === state && this.report.reason === reason) return;
    this.report = { state, reason };
    this.events.state(this.report);
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** getUserMedia 的錯誤對到原因碼；指定裝置卻找不到時是 device_missing。 */
export function micError(err: unknown, exact: boolean): WakeErrorReason {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "permission_denied";
  if (name === "OverconstrainedError" || ((name === "NotFoundError" || name === "DevicesNotFoundError") && exact)) return "device_missing";
  return "audio_failed";
}
