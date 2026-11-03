// AudioFrontEnd（docs/17 §10.3、ADR-0003；WK-01a）：NOUS_WAKE=on 時，renderer 內唯一擁有麥克風來源的模組。
// 麥克風一律經注入的 MicOpener（src/main.ts 給 src/audio-devices.ts 的 audioDevices.openInput）開：跟著「聲音輸入」設定，
// 這個檔案不呼叫 getUserMedia（tests/audio-privacy.test.ts 檢查）。
// - 常駐喚醒聆聽：來源 track → 擷取圖（AudioWorklet → worker，capture.ts）。狀態以裝置事件為準：只有 track 為 live
//   而且 worklet／worker 回報 started 之後才是 listening_local（17 §5.1）。
// - 即時語音改為租用：lease() 回傳來源的複製品（clone），通話結束時以 releaseLease(那一份複製品) 只歸還自己的那一份。租出期間斷開擷取圖（in_call），
//   KWS 暫停、環形緩衝清空；喚醒關閉時租用才開來源、最後一個租用結束就停止來源，行為等同今天。
// - Web Speech（按下說話、語音模式）自己開擷取：開始時 webSpeech(true) 完全讓出（released），結束時 webSpeech(false) 在下一個
//   macrotask 才重新取得；同一輪就來的租用（語音模式直接切到即時語音）會取消這次重新取得，不會同時有兩個 getUserMedia。
// - 暫停（使用者，只到本次執行結束）、睡眠、鎖定：停止來源；醒來、解鎖依偏好自動恢復，用「聲音輸入」選定的麥克風。
// - WK-02 限速（rate_limited）：喚醒開始的通話超過每分鐘上限時暫停，時間到由控制器呼叫 resume("rate_limited") 自動恢復。
// - 服務模式（service）：Mac 交給 Pi 使用時停止來源，只有「返回 Mac 使用」才解除，之後和解鎖一樣依偏好自動恢復。
// - 選定的麥克風找不到（開始、自動恢復）：audioDevices 改用系統預設並顯示字幕「找不到「X」，暫用系統預設」
//   （George 2026-11-01 改掉 WK-01a 原本「不改用其他麥克風」的規則）；它回來時 reopen() 在閒置時重新開。
// - track ended：選了特定麥克風時重新開一次（找不到就用系統預設）；系統預設的麥克風結束時照舊 error（device_ended），不在背景重試。
// - 「聲音輸入」改了：閒置時立即重開；通話中等這通結束（最後一份租用歸還）才換，下一通起使用。
// - 引擎檔案不在（runtime 不是 ok）時直接 error runtime_missing，**不開麥克風**。
// 這個檔案只看得到 MediaStream 與事件，拿不到樣本；樣本只在 worklet 與 worker（tests/audio-privacy.test.ts 靜態檢查）。

import type { WakeErrorReason, WakeReason, WakeReport, WakeRuntimeState, WakeState } from "../../shared/wake.ts";

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

/** 開麥克風（src/audio-devices.ts 的 audioDevices，由 main.ts 注入）：跟著「聲音輸入」設定，找不到就用系統預設。 */
export interface MicOpener {
  open(): Promise<MediaStream>;
  /** 選了特定的麥克風（不是系統預設）。 */
  preferred(): boolean;
}

export interface FrontEndDeps {
  /** 排到下一個 macrotask 執行（預設 setTimeout 0）；回傳取消。測試可注入。 */
  defer?(run: () => void): () => void;
  /** 沒有 mediaDevices（不支援的環境）時為 null。 */
  mic: MicOpener | null;
  capture: CaptureDeps;
  /** 喚醒引擎檔案的核對結果（核心的 settings.wake.runtime）；不是 ok 時不開麥克風。 */
  runtime(): WakeRuntimeState;
}

/** 是什麼讓擷取開始（決定 armed 的原因與「已恢復」字幕）；麥克風一律用「聲音輸入」設定。 */
export type StartHow = "enable" | "auto_resume" | "user_resume" | "reclaim" | "after_call";

export interface FrontEndEvents {
  state(report: WakeReport): void;
  detected(keywordIndex: number): void;
  /** 真的進入 listening_local（deviceId 只是實際的裝置，不保存；常駐聆聽跟著「聲音輸入」設定）。 */
  listening(deviceId: string | null, how: StartHow): void;
}

type SystemPause = "sleep" | "lock" | "rate_limited" | "service";

export class AudioFrontEnd {
  private wanted = false;
  private offReason: "pref_off" | null = null;
  private deviceId: string | null = null;
  /** 「聲音輸入」在通話中改了：最後一份租用歸還時才重開來源（下一通起使用）。 */
  private reopenPending = false;
  /** 選定的麥克風 track 結束後已經重開過一次（真的聽到之後才重新計算）。 */
  private endedRetried = false;
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
   * 偏好改變（設定讀到或選單切換）。on：how 為 enable（使用者剛打開）或 auto_resume（App 啟動時偏好已開）；
   * 兩者都用「聲音輸入」選定的麥克風。off：停止來源、清空緩衝，狀態 off（pref_off）。
   */
  setPreference(on: boolean, how: "enable" | "auto_resume"): void {
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
   * 「聲音輸入」改了，或之前找不到的麥克風回來了：閒置時（聆聽中或準備中）停掉來源、照新的設定重開；
   * 有租用（通話、聲音登記）時等最後一份歸還才換，正在進行的通話不受影響。沒有來源時什麼都不做（下次開就用新的）。
   */
  reopen(): void {
    if (this.leases.length > 0) {
      this.reopenPending = true;
      return;
    }
    if (!this.source && this.starting === null) return;
    this.invalidate();
    this.stopGraph();
    this.stopSource();
    this.sync("reclaim");
  }

  /**
   * 即時語音租用麥克風：回傳來源串流的複製品。來源已在時直接複製（同一個裝置、同一條來源），沒有時經 MicOpener 開一條。
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
        if (!this.deps.mic) throw Object.assign(new Error("找不到可用的麥克風。"), { name: "NotFoundError" });
        stream = await this.deps.mic.open();
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
    if (this.leases.length === 0) this.afterLastLease();
  }

  /** 保險：沒有任何進行中的通話時（呼叫端確認），歸還所有還沒歸還的複製品。 */
  releaseAllLeases(): void {
    if (this.leases.length === 0) return;
    for (const stream of this.leases) stopTracks(stream);
    this.leases = [];
    this.afterLastLease();
  }

  /** 最後一份租用歸還：通話中改過「聲音輸入」就先停掉舊來源，再照偏好回到聆聽（或停止）。 */
  private afterLastLease(): void {
    if (this.reopenPending) {
      this.reopenPending = false;
      this.invalidate();
      this.stopGraph();
      this.stopSource();
    }
    this.sync("after_call");
  }

  /** 結束（頁面卸載）：停止一切。 */
  dispose(): void {
    this.cancelReclaim();
    this.wanted = false;
    this.reopenPending = false;
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
    if (this.systemPause.has("service")) return { state: "paused", reason: "service" };
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
      if (!this.deps.mic) return this.fail("unsupported");
      this.setState("armed", how === "auto_resume" ? "auto_resume" : "starting");
      if (!this.source || this.track?.readyState !== "live") {
        let stream: MediaStream;
        try {
          // 選定的麥克風找不到時 MicOpener 已改用系統預設（並顯示字幕）；這裡只會收到權限或沒有任何麥克風的錯誤。
          stream = await this.deps.mic.open();
        } catch (err) {
          if (gen !== this.gen) return;
          return this.fail(micError(err, this.deps.mic.preferred()));
        }
        if (gen !== this.gen) {
          stopTracks(stream);
          return;
        }
        if (this.source) stopTracks(this.source);
        if (!this.adopt(stream)) return this.fail("audio_failed");
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
    this.endedRetried = false;
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
    // 拔除或系統停止。選了特定麥克風時重開一次（George 2026-11-01：找不到就暫用系統預設，並顯示字幕）；
    // 系統預設的麥克風結束、或重開過還是結束時照舊：來源清掉，偏好開著時記下，等沒有通話、沒有暫停時才照實報 device_ended
    // （偏好關著時通話中拔掉麥克風，不會出現喚醒錯誤）。
    this.invalidate();
    this.stopGraph();
    this.source = null;
    this.track = null;
    if (this.wanted) {
      if (this.deps.mic?.preferred() && !this.endedRetried) this.endedRetried = true;
      else this.endedPending = true;
    }
    this.sync("reclaim");
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

/** getUserMedia 的錯誤對到原因碼；選了特定裝置而連系統預設也找不到時是 device_missing。 */
export function micError(err: unknown, exact: boolean): WakeErrorReason {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "permission_denied";
  if (name === "OverconstrainedError" || ((name === "NotFoundError" || name === "DevicesNotFoundError") && exact)) return "device_missing";
  return "audio_failed";
}
