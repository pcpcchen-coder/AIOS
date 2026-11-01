// 常駐喚醒聆聽的瀏覽器擷取圖（WK-01a）：來源串流 → AudioWorklet → MessageChannel → module worker（wake-worker.ts）。
// 主執行緒只收到 worker 的事件（isWakeWorkerOut 檢查過的 started／detected／load_error），收不到樣本。
// stop()：先斷開 worklet（不再有新樣本），叫 worker 清空環形緩衝並釋放偵測器，等 worker 回 closed（最多 100 ms）才 terminate，
// 這樣以 0 覆寫真的會在 worker 結束前執行；再關掉 AudioContext。來源 track 由 front-end.ts 管。
// 「矯正喚醒詞…」用同一個擷取圖與 worker（mode: "calibrate"）：主執行緒只送指令（開始／結束一段、比較、丟掉），收到的只有結果事件。
// 比較進行中 worker 可能 100 ms 內回不了 closed：那時直接 terminate，worker 的記憶體（含錄音）隨之釋放。

import { isWakeWorkerOut } from "../../shared/wake.ts";
import workletUrl from "./capture-worklet.ts?worker&url";
import type { CaptureDeps, CaptureEvents, CaptureGraph, CaptureOptions } from "./front-end.ts";

/** stop() 等 worker 回報清空完成的上限。 */
export const WORKER_CLOSE_TIMEOUT_MS = 100;

export function browserCapture(): CaptureDeps {
  return {
    async connect(stream: MediaStream, events: CaptureEvents, options: CaptureOptions = { overrides: null }): Promise<CaptureGraph> {
      const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AudioCtx) throw new Error("AudioContext unavailable");
      const ctx = new AudioCtx();
      let worker: Worker | null = null;
      let node: AudioWorkletNode | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let mute: GainNode | null = null;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        node?.port.postMessage({ type: "stop" });
        source?.disconnect();
        node?.disconnect();
        mute?.disconnect();
        void ctx.close().catch(() => undefined);
        const w = worker;
        if (!w) return;
        let done = false;
        const terminate = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          w.onmessage = null;
          w.terminate();
        };
        const timer = setTimeout(terminate, WORKER_CLOSE_TIMEOUT_MS);
        w.onmessage = (event: MessageEvent<unknown>) => {
          if (isWakeWorkerOut(event.data) && event.data.type === "closed") terminate();
        };
        w.postMessage({ type: "clear" });
        w.postMessage({ type: "close" });
      };
      try {
        // 背景視窗或沒有使用者手勢時 AudioContext 可能是 suspended：明確 resume（Mac gate 檢查視窗隱藏時是否持續）。
        await ctx.resume().catch(() => undefined);
        await ctx.audioWorklet.addModule(workletUrl);
        // 單聲道：明確把多聲道麥克風依喇叭規則混成一聲道。
        node = new AudioWorkletNode(ctx, "nous-wake-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
        // 接到音量 0 的輸出，確保 worklet 一直被排程處理；不會發出聲音。
        mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        const channel = new MessageChannel();
        worker = new Worker(new URL("./wake-worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (stopped || !isWakeWorkerOut(event.data)) return;
          const message = event.data;
          const cal = options.calibrate;
          if (message.type === "started") events.started();
          else if (message.type === "detected") events.detected(message.keyword_index);
          else if (message.type === "load_error") events.failed(message.reason);
          else if (message.type === "clip") cal?.clip(message.clip, message.keyword_index);
          else if (message.type === "scan") cal?.scan(message.candidate, message.clip, message.keyword_index);
          else if (message.type === "sweep_done") cal?.sweepDone();
        };
        worker.onerror = () => {
          if (!stopped) events.failed("runtime_load_failed");
        };
        worker.postMessage({ type: "init", sampleRate: ctx.sampleRate, mode: options.calibrate ? "calibrate" : "listen", overrides: options.overrides }, [channel.port2]);
        node.port.postMessage({ type: "port" }, [channel.port1]);
        source = ctx.createMediaStreamSource(stream);
        source.connect(node);
      } catch (err) {
        stop();
        throw err;
      }
      if (!options.calibrate) return { stop };
      const w = worker;
      const send = (run: () => void) => { if (!stopped) run(); };
      return {
        stop,
        calibration: {
          beginClip: () => send(() => w.postMessage({ type: "clip_begin" })),
          endClip: () => send(() => w.postMessage({ type: "clip_end" })),
          sweep: (candidates, clips) => send(() => w.postMessage({ type: "sweep", candidates, clips })),
          discard: () => send(() => w.postMessage({ type: "discard" })),
        },
      };
    },
  };
}
