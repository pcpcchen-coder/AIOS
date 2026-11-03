import { spawn } from "node:child_process";
import type { TtsEngine } from "../../../shared/voice-relay.ts";
import type { PlaybackReceipt, RelayInventory, RelayJob, RelayOutput } from "./output.ts";

// VCR-2（docs/19 §5–§7）：Mac 內建 `say` 指令的實體輸出（mock=false）。聲音從 Mac 選定的喇叭播出，給旁邊的智慧音箱聽。
// - 只用絕對路徑 /usr/bin/say、參數陣列、不經 shell；stdin 關閉。
// - `say -v ?`／`say -a ?` 的輸出格式是依文件與常見範例寫的解析，還沒有在真的 Mac 上驗證過（這個批次只在 Linux 用假的 runner 測試）。
// - say 結束代碼 0 代表它把聲音送進指定裝置並播完；不是硬體回執，更不代表音箱照做（結果最多 unconfirmed）。
// - 沒有回音抑制：Nous 自己的麥克風可能聽到這段播音（已知風險，這批不處理）。

export const SAY_PATH = "/usr/bin/say";
/** say 的預設語速（每分鐘字數）；聲線的 rate 是倍率。 */
export const SAY_BASE_WPM = 175;

export interface SayRunOptions {
  signal: AbortSignal;
  /** 子行程真的啟動了（spawn 成功）才呼叫。 */
  onSpawn: () => void;
}
export type SayRunner = (file: string, args: string[], opts: SayRunOptions) => Promise<{ code: number | null; stdout: string }>;

export interface MacSayOutputOptions {
  run?: SayRunner;
  node?: "mac_local";
  now?: () => number;
}

export interface SayVoice {
  id: string;
  locale: string;
}
/**
 * 喇叭：id 用「名稱」（穩定；裝置表存這個），runtimeId 是 CoreAudio 的數字 ID（重新接上可能改變，只在播放當下用）。
 */
export interface SayDevice {
  id: string;
  name: string;
  runtimeId: string;
}

// 名稱與語系之間通常補空白對齊；名稱太長時可能只剩一個空白，所以用 \s+（語系的格式夠特別，不會誤判）。
const VOICE_LINE = /^(.+?)\s+([a-z]{2}_[A-Z]{2}|[a-z]{2}-[A-Z]{2}|[a-z]{2}_[0-9]{3})\s+#/;
const DEVICE_LINE = /^\s*(\d+)\s+(.+?)\s*$/;
const MARKUP = /\[\[|\]\]/;

/** `say -v ?`：每行「名稱 語系 # 範例句」。看不懂的行略過。 */
export function parseSayVoices(stdout: string): SayVoice[] {
  const out: SayVoice[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = VOICE_LINE.exec(line);
    if (!m) continue;
    const id = m[1]!.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, locale: m[2]!.replace("_", "-") });
  }
  return out;
}

/** `say -a ?`：每行「數字 ID 裝置名稱」。看不懂的行略過；同名的只留第一個。 */
export function parseSayDevices(stdout: string): SayDevice[] {
  const out: SayDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = DEVICE_LINE.exec(line);
    if (m && !out.some((d) => d.name === m[2])) out.push({ id: m[2]!, name: m[2]!, runtimeId: String(Number(m[1])) });
  }
  return out;
}

/** 增益 → say 的 [[volm]]（0–1）。正的增益沒辦法放大，一律截到 1。 */
export function sayVolume(gainDb: number): number {
  return Math.round(Math.min(1, 10 ** (gainDb / 20)) * 100) / 100;
}

/** 一整段文字：[[volm v]] 開頭，靜音用 [[slnc ms]]。所以文字一定以 "[[" 開頭，不會被 say 當成選項。 */
export function buildSayText(job: RelayJob): string {
  const parts = [`[[volm ${sayVolume(job.gainDb)}]]`];
  for (const s of job.segments) parts.push(s.kind === "silence" ? `[[slnc ${Math.max(0, Math.round(s.ms))}]]` : s.text);
  return parts.join(" ");
}

export function buildSayArgs(job: RelayJob, deviceId: string): string[] {
  const text = buildSayText(job);
  if (!text.startsWith("[[")) throw new Error("say text must start with [[");
  return ["-v", job.voiceId, "-r", String(Math.round(SAY_BASE_WPM * job.rate)), "-a", deviceId, text];
}

/** 預設的執行方式：spawn（不經 shell），中止時送 SIGTERM。 */
export const defaultSayRunner: SayRunner = (file, args, { signal, onSpawn }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 256_000) stdout += chunk;
    });
    child.once("spawn", onSpawn);
    child.once("error", (err) => done(() => reject(err)));
    child.once("close", (code) => done(() => (signal.aborted ? reject(new Error("aborted")) : resolve({ code, stdout }))));
  });

export class MacSayOutput implements RelayOutput {
  readonly mock = false;
  readonly node: "mac_local";
  private readonly run: SayRunner;
  private readonly now: () => number;
  private voiceList: SayVoice[] = [];
  private deviceList: SayDevice[] = [];
  private checkedAt: number | null = null;
  private error: string | null = null;

  constructor(options: MacSayOutputOptions = {}) {
    this.run = options.run ?? defaultSayRunner;
    this.node = options.node ?? "mac_local";
    this.now = options.now ?? Date.now;
  }

  voices(): readonly SayVoice[] {
    return this.voiceList;
  }
  devices(): readonly SayDevice[] {
    return this.deviceList;
  }

  inventory(): RelayInventory {
    return { voices: [...this.voiceList], devices: this.deviceList.map((d) => ({ id: d.id, name: d.name })), checkedAt: this.checkedAt, error: this.error };
  }

  /** 重新讀聲音與喇叭清單。失敗時清單是空的、error 是代碼（不丟錯）。 */
  private async list(flag: "-v" | "-a", signal?: AbortSignal): Promise<string | null> {
    try {
      const timeout = AbortSignal.timeout(10_000);
      const r = await this.run(SAY_PATH, [flag, "?"], { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, onSpawn: () => undefined });
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  }

  async refresh(): Promise<void> {
    const [v, a] = await Promise.all([this.list("-v"), this.list("-a")]);
    this.voiceList = v === null ? [] : parseSayVoices(v);
    this.deviceList = a === null ? [] : parseSayDevices(a);
    this.error = v === null ? "voices_failed" : a === null ? "devices_failed" : !this.voiceList.length ? "voices_unparsed" : !this.deviceList.length ? "devices_unparsed" : null;
    this.checkedAt = this.now();
  }

  voiceAvailable(node: string, engine: TtsEngine, voiceId: string): boolean {
    return node === this.node && engine === "macos_say" && this.voiceList.some((v) => v.id === voiceId);
  }

  async play(job: RelayJob, signal: AbortSignal): Promise<PlaybackReceipt> {
    const base = { jobId: job.jobId, outputNode: job.outputNode, outputDeviceId: job.outputDeviceId, mock: false };
    const notPlayed = (failure: NonNullable<PlaybackReceipt["failure"]>): PlaybackReceipt => ({ ...base, synthesisComplete: false, audioStarted: false, audioFinished: false, failure });
    if (job.outputNode !== this.node || job.engine !== "macos_say") return notPlayed("device_unavailable");
    if (!this.voiceList.some((v) => v.id === job.voiceId)) return notPlayed("synthesis_failed");
    // say 指令沒有音高參數：這批不支援 pitch≠0（不偷偷忽略）。
    if (job.pitch !== 0) return notPlayed("synthesis_failed");
    // 多一道防線：文字裡不能有 say 的控制標記（目錄驗證已擋）。
    if (job.segments.some((s) => s.kind === "speech" && MARKUP.test(s.text))) return notPlayed("synthesis_failed");
    // 每次播放前重新讀喇叭清單（喇叭重新接上時數字 ID 會變）；只用名稱比對，絕不用數字 ID 比對。找不到就不播。
    const listed = await this.list("-a", signal);
    if (signal.aborted) throw new Error("aborted");
    if (listed !== null) this.deviceList = parseSayDevices(listed);
    const device = listed === null ? undefined : this.deviceList.find((d) => d.name === job.outputDeviceId);
    if (!device) return notPlayed("device_unavailable");
    let args: string[];
    try {
      args = buildSayArgs(job, device.runtimeId);
    } catch {
      return notPlayed("synthesis_failed");
    }
    let started = false;
    let result: { code: number | null };
    try {
      result = await this.run(SAY_PATH, args, { signal, onSpawn: () => (started = true) });
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error("aborted");
      // 沒能啟動（例如 ENOENT）：確定沒有發出聲音。
      if (!started) return { ...notPlayed("start_failed"), synthesisComplete: false };
      return { ...base, synthesisComplete: false, audioStarted: true, audioFinished: false, failure: "interrupted" };
    }
    if (signal.aborted) throw new Error("aborted");
    if (!started) return notPlayed("start_failed");
    if (result.code === 0) return { ...base, synthesisComplete: true, audioStarted: true, audioFinished: true };
    // 啟動後非 0 結束（或被訊號終止）：可能播了一部分。
    return { ...base, synthesisComplete: false, audioStarted: true, audioFinished: false, failure: "interrupted" };
  }
}
