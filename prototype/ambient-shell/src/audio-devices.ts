// 聲音輸入／輸出裝置（George 2026-11-01；docs/validation/audio-devices-2026-11-01.md）。renderer 內**唯一**呼叫
// getUserMedia({ audio }) 的地方（openMic），也是唯一把播放導到選定裝置的地方（applySink）；tests/audio-privacy.test.ts 靜態檢查。
// - openMic：選定的麥克風（exact deviceId）→ 找不到時用名稱找回 → 再不行用系統預設（fallback，畫面照實說）。偏好是系統預設時，
//   約束和加入這個功能之前完全相同（不帶 deviceId）。
// - applySink：選定的聲音輸出（setSinkId）；系統預設時不呼叫 setSinkId（除非這個元素之前被導到別的裝置，才改回 ""）。
// - AudioDevices：記住偏好、裝置清單（enumerateDevices＋devicechange）、真的開著的麥克風 track 與播放元素。
//   「使用中」只來自 track.getSettings().deviceId 與元素的 sinkId（以裝置事件為準），不是偏好。
// 不碰樣本：這裡只看得到 MediaStream、裝置清單與事件。src/audio/（只有 NOUS_WAKE=on 才載入）不 import 這個檔案，由 main.ts 注入。
// 按下說話與語音模式（Web Speech）、系統朗讀（speechSynthesis）瀏覽器不給選裝置，一律用 Mac 的系統輸入／輸出（畫面有提示）。

import {
  ALIAS_DEVICE_IDS,
  DEFAULT_AUDIO_PREFS,
  DEVICE_ID,
  DEVICE_LIST_MAX,
  preferredLabel,
  type AudioDevice,
  type AudioInUse,
  type AudioPrefs,
  type AudioReport,
} from "../shared/audio-devices.ts";

/** 即時語音、常駐聆聽與聲音登記共用的處理約束（同一裝置不同約束會互相影響，docs/17 §10.3）。 */
export const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

export interface DeviceInfoLike {
  deviceId: string;
  kind: string;
  label: string;
}

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<DeviceInfoLike[]>;
  addEventListener?(type: "devicechange", listener: () => void): void;
}

export interface DevicePref {
  id: string | null;
  label: string | null;
}

export interface OpenedMic {
  stream: MediaStream;
  /** 選定的裝置找不到，改用了系統預設。 */
  fallback: boolean;
}

const MISSING = new Set(["OverconstrainedError", "NotFoundError", "DevicesNotFoundError"]);
const isAlias = (id: string) => (ALIAS_DEVICE_IDS as readonly string[]).includes(id);

function stopAll(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** 以 exact deviceId 開；裝置不在時回 null（其他錯誤，例如權限被拒，照樣丟出）。拿到的卻是別支時也當成不在。 */
async function openExact(media: MediaDevicesLike, id: string, extra: { video?: false }): Promise<MediaStream | null> {
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: id } }, ...extra });
  } catch (err) {
    if (MISSING.has((err as { name?: string } | null)?.name ?? "")) return null;
    throw err;
  }
  const actual = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
  if (actual && actual !== id) {
    stopAll(stream);
    return null;
  }
  return stream;
}

/**
 * 開麥克風：系統預設時約束和以前完全相同；選定裝置時 exact → 名稱相同的裝置 → 系統預設（fallback: true）。
 * extra 只用來帶 video: false（聲音登記原本的寫法）。
 */
export async function openMic(media: MediaDevicesLike, pref: DevicePref, extra: { video?: false } = {}): Promise<OpenedMic> {
  if (pref.id === null) return { stream: await media.getUserMedia({ audio: { ...MIC_CONSTRAINTS }, ...extra }), fallback: false };
  const exact = await openExact(media, pref.id, extra);
  if (exact) return { stream: exact, fallback: false };
  if (pref.label && media.enumerateDevices) {
    const list = await media.enumerateDevices().catch(() => [] as DeviceInfoLike[]);
    const match = list.find((d) => d.kind === "audioinput" && d.label === pref.label && d.deviceId !== pref.id && !isAlias(d.deviceId));
    if (match) {
      const byLabel = await openExact(media, match.deviceId, extra);
      if (byLabel) return { stream: byLabel, fallback: false };
    }
  }
  return { stream: await media.getUserMedia({ audio: { ...MIC_CONSTRAINTS }, ...extra }), fallback: true };
}

/** 能導向輸出裝置的東西：HTMLMediaElement 與 AudioContext（Chromium 110 起都有 setSinkId）。 */
export interface SinkTarget {
  sinkId?: unknown;
  setSinkId?(id: string): Promise<void>;
}

export interface SinkResult {
  /** 實際導向的裝置；null＝系統預設。 */
  id: string | null;
  fallback: boolean;
}

/**
 * 把播放導到選定的聲音輸出。系統預設時不呼叫 setSinkId（新元素本來就是 ""）；之前導到別的裝置的元素才改回 ""。
 * outputs（有的話）是目前的輸出裝置清單：選定的裝置不在清單裡就不試，直接用名稱找、再不行回系統預設（fallback）。
 */
export async function applySink(target: SinkTarget, pref: DevicePref, outputs: readonly DeviceInfoLike[] | null = null): Promise<SinkResult> {
  const current = typeof target.sinkId === "string" ? target.sinkId : "";
  const toDefault = async (fallback: boolean): Promise<SinkResult> => {
    if (current !== "" && target.setSinkId) await target.setSinkId("").catch(() => undefined);
    return { id: null, fallback };
  };
  if (pref.id === null) return toDefault(false);
  if (!target.setSinkId) return { id: null, fallback: true };
  const listed = (id: string) => !outputs || outputs.some((d) => d.kind === "audiooutput" && d.deviceId === id);
  const candidates: string[] = [];
  if (listed(pref.id)) candidates.push(pref.id);
  if (pref.label && outputs) {
    const match = outputs.find((d) => d.kind === "audiooutput" && d.label === pref.label && !isAlias(d.deviceId) && d.deviceId !== pref.id);
    if (match) candidates.push(match.deviceId);
  }
  for (const id of candidates) {
    try {
      if (current !== id) await target.setSinkId(id);
      return { id, fallback: false };
    } catch {
      // 裝置不在或不能用：試下一個，最後回系統預設
    }
  }
  return toDefault(true);
}

export type AudioDeviceEvent =
  | { type: "changed" }
  /** 選定的麥克風找不到，這次用系統預設（label：選定的裝置名稱）。 */
  | { type: "input_fallback"; label: string | null }
  /** 之前找不到的麥克風又出現了（常駐聆聽在閒置時重新開）。 */
  | { type: "input_returned" }
  /** 選定的聲音輸出不見了（例如藍牙喇叭中斷），改由系統預設播放。 */
  | { type: "output_lost"; label: string | null }
  /** 選定的聲音輸出回來了，已改回它播放。 */
  | { type: "output_back"; label: string | null };

interface TrackLike {
  readyState: string;
  getSettings?(): { deviceId?: string };
  addEventListener?(type: "ended", listener: () => void): void;
  stop?(): void;
}

export interface AudioDevicesOptions {
  /** 「之前找不到的麥克風回來了」的去彈跳時間（毫秒）；藍牙或 USB 接上時 devicechange 常常連發。 */
  returnDebounceMs?: number;
  /** 單次計時器（預設 setTimeout）；回傳取消。測試注入假的。 */
  timer?(run: () => void, ms: number): () => void;
}

export const INPUT_RETURN_DEBOUNCE_MS = 500;

/**
 * 頁面內唯一的裝置管理者（main.ts、realtime.ts、speaker/recorder.ts 共用 audioDevices；常駐聆聽經 main.ts 注入）。
 * 偏好由 setPrefs 給（核心的 settings.audio.prefs）；清單在 start() 後讀一次，之後每次 devicechange 重讀。
 */
export class AudioDevices {
  private prefs: AudioPrefs = { ...DEFAULT_AUDIO_PREFS };
  private devices: DeviceInfoLike[] = [];
  private enumerated = false;
  private started = false;
  private readonly tracks = new Set<TrackLike>();
  private readonly sinks = new Map<SinkTarget | AudioContext, SinkResult | null>();
  private inputFallback = false;
  private outputFallback = false;
  /** 上一次看到的「選定的輸出在不在」：由在變成不在時說「已中斷」，回來時說「已改回」。 */
  private outputMissing = false;
  /** 上一次清單裡「選定的麥克風在不在」：只有由不在變成在時才通知 input_returned（每次出現最多一次）。 */
  private inputWasPresent = false;
  private cancelReturn: (() => void) | null = null;
  /** 每次重讀清單的世代：晚到的舊結果丟掉（enumerateDevices 可能重疊）。 */
  private refreshGen = 0;
  private readonly listeners = new Set<(event: AudioDeviceEvent) => void>();

  constructor(
    private readonly media: () => MediaDevicesLike | null,
    private readonly options: AudioDevicesOptions = {},
  ) {}

  /** 開始讀裝置清單並聽 devicechange（只做一次）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const media = this.media();
    media?.addEventListener?.("devicechange", () => void this.refresh());
    void this.refresh();
  }

  on(listener: (event: AudioDeviceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get current(): AudioPrefs {
    return this.prefs;
  }

  /** 選了特定的麥克風（不是系統預設）。 */
  get preferredInput(): boolean {
    return this.prefs.input_device_id !== null;
  }

  /** 核心的偏好（hello 或 settings.updated）。回傳哪一邊變了；輸出變了立即套到正在播的元素與提示音。 */
  setPrefs(next: AudioPrefs | undefined): { input: boolean; output: boolean } {
    const prefs = next ?? DEFAULT_AUDIO_PREFS;
    const input = prefs.input_device_id !== this.prefs.input_device_id || prefs.input_label !== this.prefs.input_label;
    const output = prefs.output_device_id !== this.prefs.output_device_id || prefs.output_label !== this.prefs.output_label;
    this.prefs = { ...prefs };
    // 換了麥克風：舊的「找不到」不再適用（下一次開才知道）；「在不在」以目前的清單重新起算。
    if (input) {
      this.inputFallback = false;
      this.cancelPendingReturn();
      this.inputWasPresent = this.prefs.input_device_id !== null && this.inputPresent();
    }
    if (output) {
      this.outputMissing = this.isOutputMissing();
      void this.reapplySinks(false);
    }
    if (input || output) this.emit({ type: "changed" });
    return { input, output };
  }

  /** 開麥克風（即時語音、常駐聆聽、聲音登記）。找不到選定的裝置時改用系統預設，並通知一次（同一個偏好只說一次）。 */
  async openInput(extra: { video?: false } = {}): Promise<MediaStream> {
    const media = this.media();
    if (!media) throw Object.assign(new Error("找不到可用的麥克風。"), { name: "NotFoundError" });
    const opened = await openMic(media, { id: this.prefs.input_device_id, label: this.prefs.input_label }, extra);
    const wasFallback = this.inputFallback;
    this.inputFallback = opened.fallback;
    for (const track of opened.stream.getAudioTracks() as unknown as TrackLike[]) this.watchTrack(track);
    if (opened.fallback && !wasFallback) this.emit({ type: "input_fallback", label: this.inputLabel() });
    this.emit({ type: "changed" });
    // 授權之後才有裝置名稱：第一次開麥克風後重讀一次清單。
    if (!this.labelsKnown()) void this.refresh();
    return opened.stream;
  }

  /**
   * 記下開著的麥克風 track。track.stop() 不會送 ended，所以把 stop 包起來：通話結束、常駐聆聽停止或登記結束停掉麥克風時，
   * 「使用中」立即更新（不必等下一次重畫）。
   */
  private watchTrack(track: TrackLike): void {
    this.tracks.add(track);
    track.addEventListener?.("ended", () => this.emit({ type: "changed" }));
    const stop = track.stop;
    if (typeof stop !== "function") return;
    try {
      track.stop = () => {
        stop.call(track);
        this.emit({ type: "changed" });
      };
    } catch {
      // 不能改寫時只靠 ended 與下一次重畫
    }
  }

  /** 播放元素或提示音開始：導到選定的輸出，並記住它（輸出改了或裝置變了時重新套用）。 */
  async sink(target: SinkTarget | AudioContext): Promise<void> {
    this.sinks.set(target, null);
    await this.applyTo(target);
  }

  /** 播放元素或提示音結束。 */
  release(target: SinkTarget | AudioContext): void {
    if (!this.sinks.delete(target)) return;
    this.recomputeOutputFallback();
    this.emit({ type: "changed" });
  }

  /** 重讀裝置清單（devicechange）：輸出重新套用（不見了就回系統預設，回來了就改回去）；之前找不到的麥克風回來時通知。 */
  async refresh(): Promise<void> {
    const media = this.media();
    if (!media?.enumerateDevices) return;
    const gen = ++this.refreshGen;
    let list: DeviceInfoLike[];
    try {
      list = await media.enumerateDevices();
    } catch {
      return;
    }
    // 重疊的重讀：比這次晚開始的那一次已經（或將會）套用較新的清單，這次的結果丟掉。
    if (gen !== this.refreshGen) return;
    // 第一次讀到清單（App 剛開）時不說「已中斷」：喇叭本來就沒開，狀態列會照實寫「找不到」。之後的變化才說。
    const first = !this.enumerated;
    this.devices = list.filter((d) => (d.kind === "audioinput" || d.kind === "audiooutput") && typeof d.deviceId === "string");
    this.enumerated = true;
    this.noteInputPresence();
    await this.reapplySinks(!first);
    this.emit({ type: "changed" });
  }

  /** 給選單列（preload 再整理一次）與設定畫面的清單與狀態。只有名稱與 deviceId，不含任何聲音。 */
  report(): AudioReport {
    const list = (kind: string): AudioDevice[] => {
      const seen = new Set<string>();
      const out: AudioDevice[] = [];
      for (const d of this.devices) {
        if (d.kind !== kind || isAlias(d.deviceId) || !DEVICE_ID.test(d.deviceId) || seen.has(d.deviceId)) continue;
        seen.add(d.deviceId);
        out.push({ id: d.deviceId, label: d.label ?? "" });
        if (out.length >= DEVICE_LIST_MAX) break;
      }
      return out;
    };
    const inputs = list("audioinput");
    const outputs = list("audiooutput");
    const defaultInput = this.defaultLabel("audioinput");
    const defaultOutput = this.defaultLabel("audiooutput");
    return {
      inputs,
      outputs,
      default_input: defaultInput,
      default_output: defaultOutput,
      input_in_use: this.inputInUse(inputs, defaultInput),
      output_in_use: this.outputInUse(outputs, defaultOutput),
      input_fallback: this.inputFallback,
      output_fallback: this.outputFallback,
      labels: this.labelsKnown(),
    };
  }

  // ───────────── 內部 ─────────────

  private emit(event: AudioDeviceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 聽的一方出錯不影響裝置管理
      }
    }
  }

  private labelsKnown(): boolean {
    return this.devices.some((d) => d.label !== "");
  }

  private inputLabel(): string | null {
    return preferredLabel(this.prefs.input_device_id, this.prefs.input_label, this.listed("audioinput"));
  }

  private outputLabel(): string | null {
    return preferredLabel(this.prefs.output_device_id, this.prefs.output_label, this.listed("audiooutput"));
  }

  private listed(kind: string): AudioDevice[] {
    return this.devices.filter((d) => d.kind === kind && !isAlias(d.deviceId)).map((d) => ({ id: d.deviceId, label: d.label }));
  }

  /**
   * 選定的麥克風由不在變成在、而且上次開時改用了系統預設：去彈跳後通知一次 input_returned（常駐聆聽在閒置時重開）。
   * 一直在清單裡卻 exact 開不起來時不會重複通知（要先消失再出現才會再通知）。
   */
  private noteInputPresence(): void {
    const present = this.prefs.input_device_id !== null && this.inputPresent();
    const appeared = present && !this.inputWasPresent;
    this.inputWasPresent = present;
    if (!present) {
      this.cancelPendingReturn();
      return;
    }
    if (!appeared || !this.inputFallback) return;
    this.cancelPendingReturn();
    const timer = this.options.timer ?? ((run: () => void, ms: number) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    });
    const id = this.prefs.input_device_id;
    const token = { cancel: () => {} };
    this.cancelReturn = () => token.cancel();
    token.cancel = timer(() => {
      if (this.cancelReturn === null) return;
      this.cancelReturn = null;
      if (this.prefs.input_device_id === id && this.inputWasPresent && this.inputFallback) this.emit({ type: "input_returned" });
    }, this.options.returnDebounceMs ?? INPUT_RETURN_DEBOUNCE_MS);
  }

  private cancelPendingReturn(): void {
    const cancel = this.cancelReturn;
    this.cancelReturn = null;
    cancel?.();
  }

  private inputPresent(): boolean {
    const { input_device_id: id, input_label: label } = this.prefs;
    return this.devices.some((d) => d.kind === "audioinput" && (d.deviceId === id || (!!label && d.label === label)));
  }

  private isOutputMissing(): boolean {
    const { output_device_id: id, output_label: label } = this.prefs;
    if (id === null || !this.enumerated) return false;
    return !this.devices.some((d) => d.kind === "audiooutput" && (d.deviceId === id || (!!label && d.label === label)));
  }

  private defaultLabel(kind: string): string | null {
    const entry = this.devices.find((d) => d.kind === kind && d.deviceId === "default");
    const label = entry?.label.replace(/^Default\s*-\s*/i, "").replace(/^預設\s*[-－]\s*/, "") ?? "";
    return label || null;
  }

  private inputInUse(inputs: AudioDevice[], defaultLabel: string | null): AudioInUse | null {
    for (const track of this.tracks) {
      if (track.readyState !== "live") {
        this.tracks.delete(track);
        continue;
      }
      const id = track.getSettings?.().deviceId ?? null;
      if (!id || isAlias(id)) return { id: null, label: defaultLabel ?? "" };
      return { id, label: inputs.find((d) => d.id === id)?.label ?? "" };
    }
    return null;
  }

  private outputInUse(outputs: AudioDevice[], defaultLabel: string | null): AudioInUse | null {
    for (const result of this.sinks.values()) {
      if (!result) continue;
      if (result.id === null || isAlias(result.id)) return { id: null, label: defaultLabel ?? "" };
      return { id: result.id, label: outputs.find((d) => d.id === result.id)?.label ?? "" };
    }
    return null;
  }

  private async applyTo(target: SinkTarget | AudioContext): Promise<void> {
    const pref = { id: this.prefs.output_device_id, label: this.prefs.output_label };
    // AudioContext.setSinkId（Chromium 110 起）不在 TypeScript 的 lib 型別裡：以 SinkTarget 的形狀使用。
    const result = await applySink(target as SinkTarget, pref, this.enumerated ? this.devices : null);
    if (!this.sinks.has(target)) return;
    this.sinks.set(target, result);
    this.recomputeOutputFallback();
    this.emit({ type: "changed" });
  }

  /** 正在播的元素有任何一個改用了系統預設就是 fallback；沒有在播時看選定的裝置在不在清單裡。 */
  private recomputeOutputFallback(): void {
    const results = [...this.sinks.values()].filter((r): r is SinkResult => r !== null);
    this.outputFallback = results.length > 0 ? results.some((r) => r.fallback) : this.isOutputMissing();
  }

  /** 輸出偏好或裝置清單變了：每個正在播的元素重新套用；選定的裝置不見或回來時通知一次。 */
  private async reapplySinks(announce: boolean): Promise<void> {
    const missing = this.isOutputMissing();
    const was = this.outputMissing;
    this.outputMissing = missing;
    this.recomputeOutputFallback();
    await Promise.all([...this.sinks.keys()].map((target) => this.applyTo(target)));
    if (!announce || this.prefs.output_device_id === null || missing === was) return;
    this.emit(missing ? { type: "output_lost", label: this.outputLabel() } : { type: "output_back", label: this.outputLabel() });
  }
}

/** 頁面共用的一份（沒有 navigator.mediaDevices 的環境回 null：開麥克風時照實丟出 NotFoundError）。 */
export const audioDevices = new AudioDevices(() =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" ? (navigator.mediaDevices as unknown as MediaDevicesLike) : null,
);
