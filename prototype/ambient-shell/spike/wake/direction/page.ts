// 喚醒方向性診斷頁（docs/validation/wake-direction-2026-11-08.md）。開發工具，不是產品畫面；只在 127.0.0.1:5184。
// 流程：getUserMedia（照頁面勾選的處理與聲道要求）→ AudioWorklet（discrete，看到每個實際聲道）→ 每個偵測器變體一個 worker
// （產品的 SherpaWasmDetector，門檻加上位移）。畫面顯示實際的 track 設定、聲道數、各聲道音量與每次觸發。
// 隱私：音訊只在記憶體（worklet → worker，主執行緒只收到音量數字與觸發事件）；不錄音、不建立 blob、不寫檔、不連外，
// 也不用瀏覽器儲存。結果只有次數，由使用者自己複製（匯出／匯入 JSON）。停止時斷開擷取、停止 track、結束 worker。

import manifest from "../../../shared/wake-runtime.json" with { type: "json" };
import { isWakeWorkerOut, type WakeRuntimeManifest } from "../../../shared/wake.ts";
import {
  ANGLES,
  DISTANCES,
  NEGATIVE_KINDS,
  POSITIVE_PHRASES,
  TRIALS_PER_CELL,
  cellCount,
  conditionLabel,
  emptyResults,
  knownKeys,
  nextCell,
  parseResults,
  planVariants,
  PRODUCT_VARIANT_ID,
  skippedVariants,
  plannedTrials,
  productMixRule,
  summarize,
  toCsv,
  type Angle,
  type Condition,
  type Distance,
  type NegativeKind,
  type Phrase,
  type Rate,
  type Results,
  type Trial,
  type Variant,
} from "./logic.ts";
import workletUrl from "./worklet.ts?worker&url";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const KEYWORDS = (manifest as WakeRuntimeManifest).keywords.entries.map((e) => e.id);
const PRODUCT_VARIANT = PRODUCT_VARIANT_ID;

const PHRASE_TEXT: Record<Phrase, string> = { hello: "Hello Nous", hey: "Hey Nous" };
const NEG_TEXT: Record<NegativeKind, string> = { tv: "電視 / TV", chat: "聊天 / Conversation" };
const MIX_TEXT: Record<ReturnType<typeof productMixRule>, string> = {
  copy: "單聲道，直接使用 / mono, used as is",
  average: "所有聲道平均 / average of all channels",
  "5.1": "5.1 喇叭混音公式 / 5.1 speaker down-mix",
  first_only: "只取第 1 聲道，其餘丟掉 / first channel only, others dropped",
};

function log(line: string): void {
  const el = $<HTMLPreElement>("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${el.textContent ?? ""}`.slice(0, 20000);
}

function setStatus(state: "off" | "starting" | "listening" | "error", text: string): void {
  const el = $<HTMLSpanElement>("status");
  el.dataset.state = state;
  el.textContent = text;
}

// ───────────── 狀態 ─────────────

interface Detector {
  variant: Variant;
  worker: Worker;
  state: "loading" | "listening" | "error";
  detections: number;
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  mute: GainNode;
  condition: string;
  channels: number | null;
  detectors: Detector[];
}

interface ActiveTrial {
  angle: Angle;
  distance: Distance;
  phrase: Phrase;
  end: number;
  hits: Record<string, boolean>;
  timer: number;
}

interface ActiveNegative {
  kind: NegativeKind;
  started: number;
  triggers: Record<string, number>;
  timer: number;
}

let session: Session | null = null;
let trial: ActiveTrial | null = null;
let negative: ActiveNegative | null = null;
let results: Results = emptyResults();
let unprompted = 0;
/** 這次開頁以來記下的測試（復原只刪這些，不會刪到匯入的或其他條件的）。 */
let added: Trial[] = [];

// ───────────── 選單 ─────────────

function fillSelect(id: string, items: readonly { value: string; text: string }[], keep = true): void {
  const el = $<HTMLSelectElement>(id);
  const prev = el.value;
  el.replaceChildren(...items.map((i) => new Option(i.text, i.value)));
  if (keep && items.some((i) => i.value === prev)) el.value = prev;
}

fillSelect("angle", ANGLES.map((a) => ({ value: String(a), text: `${a}°` })));
fillSelect("distance", DISTANCES.map((d) => ({ value: d, text: d.replace("m", " m") })));
fillSelect("phrase", POSITIVE_PHRASES.map((p) => ({ value: p, text: PHRASE_TEXT[p] })));
fillSelect("negkind", NEGATIVE_KINDS.map((k) => ({ value: k, text: NEG_TEXT[k] })));

async function refreshDevices(): Promise<void> {
  const list = (await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  fillSelect("device", [{ value: "", text: "系統預設 / System default" }, ...list.map((d, i) => ({ value: d.deviceId, text: d.label || `麥克風 ${i + 1} / Microphone ${i + 1}` }))]);
}

/** 還沒開始時的條件名稱（用選單上的麥克風名稱；系統預設時開始後會換成實際裝置的名稱）。 */
function previewCondition(): string {
  const sel = $<HTMLSelectElement>("device");
  return conditionLabel(readCondition(), sel.value ? sel.selectedOptions[0]?.text ?? null : null);
}

function readCondition(): Condition {
  return {
    echoCancellation: $<HTMLInputElement>("ec").checked,
    noiseSuppression: $<HTMLInputElement>("ns").checked,
    autoGainControl: $<HTMLInputElement>("agc").checked,
    channels: $<HTMLSelectElement>("channels").value === "max" ? "max" : "default",
  };
}

const selectedCell = () => ({
  angle: Number($<HTMLSelectElement>("angle").value) as Angle,
  distance: $<HTMLSelectElement>("distance").value as Distance,
  phrase: $<HTMLSelectElement>("phrase").value as Phrase,
});

function showCell(): void {
  const c = selectedCell();
  const cond = session?.condition ?? previewCondition();
  const done = results.trials.filter((t) => t.condition === cond).length;
  $<HTMLSpanElement>("cell").textContent = `此格 / This cell: ${cellCount(results, cond, c.angle, c.distance, c.phrase)}/${TRIALS_PER_CELL}　全部 / Total: ${done}/${plannedTrials()}`;
}

// ───────────── 開始／停止 ─────────────

async function start(): Promise<void> {
  if (session) return;
  $<HTMLButtonElement>("start").disabled = true;
  setStatus("starting", "取得麥克風中 / acquiring microphone");
  const cond = readCondition();
  const deviceId = $<HTMLSelectElement>("device").value;
  const audio: MediaTrackConstraints = {
    echoCancellation: cond.echoCancellation,
    noiseSuppression: cond.noiseSuppression,
    autoGainControl: cond.autoGainControl,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    ...(cond.channels === "max" ? { channelCount: { ideal: 8 } } : {}),
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    setStatus("error", `無法取得麥克風 / cannot open the microphone: ${(err as Error).name ?? err}`);
    $<HTMLButtonElement>("start").disabled = false;
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== "live") {
    for (const t of stream.getTracks()) t.stop();
    setStatus("error", "音軌不是 live / audio track is not live");
    $<HTMLButtonElement>("start").disabled = false;
    return;
  }
  track.addEventListener("ended", () => stop("麥克風已中斷 / microphone ended"));
  void refreshDevices();
  const ctx = new AudioContext();
  try {
    await ctx.resume().catch(() => undefined);
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
    setStatus("error", `AudioWorklet 載入失敗 / AudioWorklet failed: ${String(err)}`);
    $<HTMLButtonElement>("start").disabled = false;
    return;
  }
  const node = new AudioWorkletNode(ctx, "nous-wake-direction", { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: "max", channelInterpretation: "discrete" });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  const source = ctx.createMediaStreamSource(stream);
  const s: Session = { stream, ctx, node, source, mute, condition: conditionLabel(cond, track.label || null), channels: null, detectors: [] };
  session = s;
  node.port.onmessage = (event: MessageEvent<{ type?: string; channels?: number; rmsDb?: number[]; peaks?: number[] }>) => {
    if (session !== s || event.data?.type !== "levels") return;
    const { channels = 0, rmsDb = [], peaks = [] } = event.data;
    if (s.channels === null && channels > 0) {
      s.channels = channels;
      spawnDetectors(s);
      showInfo(s);
    }
    showLevels(rmsDb, peaks);
  };
  source.connect(node);
  showInfo(s);
  showCell();
  $<HTMLButtonElement>("stop").disabled = false;
  setStatus("starting", "載入偵測器中 / loading detectors");
  log(`開始 / started: ${s.condition}`);
}

function spawnDetectors(s: Session): void {
  const deltas = [...document.querySelectorAll<HTMLInputElement>("input.delta")].filter((i) => i.checked).map((i) => Number(i.value));
  const perChannel = $<HTMLInputElement>("perchannel").checked;
  const plan = planVariants(s.channels ?? 1, deltas, perChannel);
  const skipped = skippedVariants(s.channels ?? 1, deltas, perChannel);
  if (skipped > 0) log(`偵測器上限 10 個，略過 ${skipped} 個（少勾幾個門檻）/ detector limit is 10; ${skipped} skipped (untick some offsets)`);
  const ports: MessagePort[] = [];
  for (const variant of plan) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const d: Detector = { variant, worker, state: "loading", detections: 0 };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (session !== s || !isWakeWorkerOut(event.data)) return;
      const m = event.data;
      if (m.type === "started") d.state = "listening";
      else if (m.type === "load_error") {
        d.state = "error";
        log(`${variant.id}: ${m.reason === "runtime_missing" ? "引擎檔案不在，先執行 npm run wake:setup -- --product / engine files missing" : "引擎載入失敗（下載或雜湊不符）/ engine failed to load (download or hash)"}`);
      } else if (m.type === "detected") onDetected(d, m.keyword_index);
      renderDetectors(s);
    };
    worker.onerror = () => {
      d.state = "error";
      renderDetectors(s);
    };
    const channel = new MessageChannel();
    worker.postMessage({ type: "init", sampleRate: s.ctx.sampleRate, delta: variant.delta }, [channel.port2]);
    ports.push(channel.port1);
    s.detectors.push(d);
  }
  s.node.port.postMessage({ type: "routes", sources: plan.map((v) => v.source) }, ports);
  renderDetectors(s);
}

function stop(reason = ""): void {
  const s = session;
  if (!s) return;
  if (negative) toggleNegative();
  if (trial) {
    clearTimeout(trial.timer);
    trial = null;
    $<HTMLParagraphElement>("trialout").textContent = "本次未記錄 / not recorded";
  }
  session = null;
  s.node.port.postMessage({ type: "stop" });
  s.node.port.onmessage = null;
  s.source.disconnect();
  s.node.disconnect();
  s.mute.disconnect();
  for (const t of s.stream.getTracks()) t.stop();
  void s.ctx.close().catch(() => undefined);
  for (const d of s.detectors) {
    d.worker.onmessage = null;
    d.worker.postMessage({ type: "close" });
    const w = d.worker;
    setTimeout(() => w.terminate(), 200);
  }
  $<HTMLButtonElement>("start").disabled = false;
  $<HTMLButtonElement>("stop").disabled = true;
  $<HTMLButtonElement>("trial").disabled = true;
  $<HTMLButtonElement>("neg").disabled = true;
  $<HTMLDivElement>("meters").replaceChildren();
  setStatus("off", "關閉 / off");
  log(`停止 / stopped${reason ? `: ${reason}` : ""}`);
}

// ───────────── 顯示 ─────────────

function row(k: string, v: string): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const a = document.createElement("td");
  a.className = "k";
  a.textContent = k;
  const b = document.createElement("td");
  b.textContent = v;
  tr.append(a, b);
  return tr;
}

const yesNo = (v: unknown) => (v === true ? "開 / on" : v === false ? "關 / off" : "瀏覽器沒有回報 / not reported");

function showInfo(s: Session): void {
  const track = s.stream.getAudioTracks()[0];
  const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings & { channelCount?: number; sampleRate?: number; latency?: number };
  const caps = (track?.getCapabilities?.() ?? {}) as { channelCount?: { min?: number; max?: number }; sampleRate?: { min?: number; max?: number } };
  const range = (r?: { min?: number; max?: number }) => (r ? `${r.min ?? "?"}–${r.max ?? "?"}` : "瀏覽器沒有回報 / not reported");
  $<HTMLTableSectionElement>("info").replaceChildren(
    row("裝置 / Device", track?.label || "—"),
    row("條件 / Condition", s.condition),
    row("echoCancellation（實際 / actual）", yesNo(st.echoCancellation)),
    row("noiseSuppression（實際 / actual）", yesNo(st.noiseSuppression)),
    row("autoGainControl（實際 / actual）", yesNo(st.autoGainControl)),
    row("track channelCount", st.channelCount === undefined ? "瀏覽器沒有回報 / not reported" : String(st.channelCount)),
    row("track sampleRate", st.sampleRate === undefined ? "瀏覽器沒有回報 / not reported" : `${st.sampleRate} Hz`),
    row("裝置能力 / Capabilities channelCount", range(caps.channelCount)),
    row("裝置能力 / Capabilities sampleRate", range(caps.sampleRate)),
    row("AudioContext sampleRate（KWS 前會轉成 16 kHz / resampled to 16 kHz）", `${s.ctx.sampleRate} Hz`),
    row("實際送進 Web Audio 的聲道數 / Channels reaching Web Audio", s.channels === null ? "等待第一塊 / waiting for audio" : String(s.channels)),
    row("產品目前怎麼混成單聲道 / How the product mixes to mono", s.channels === null ? "—" : MIX_TEXT[productMixRule(s.channels)]),
  );
}

function showLevels(rmsDb: number[], peaks: number[]): void {
  const box = $<HTMLDivElement>("meters");
  if (box.children.length !== rmsDb.length) {
    box.replaceChildren(
      ...rmsDb.map((_, i) => {
        const line = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = `聲道 / Channel ${i + 1} `;
        const meter = document.createElement("meter");
        meter.min = -90;
        meter.max = 0;
        meter.low = -60;
        meter.high = -12;
        meter.setAttribute("aria-label", `聲道 ${i + 1} 音量 / Channel ${i + 1} level`);
        const text = document.createElement("span");
        line.append(label, meter, text);
        return line;
      }),
    );
  }
  rmsDb.forEach((db, i) => {
    const line = box.children[i] as HTMLDivElement;
    (line.children[1] as HTMLMeterElement).value = Math.max(-90, db);
    line.children[2]!.textContent = ` RMS ${db <= -120 ? "−∞" : db.toFixed(1)} dBFS　peak ${(peaks[i] ?? 0).toFixed(3)}`;
  });
}

function sourceText(v: Variant): string {
  if (v.source.kind === "product") return "產品混音 / product mix";
  if (v.source.kind === "average") return "全部平均 / average all";
  return `只用聲道 ${v.source.index + 1} / channel ${v.source.index + 1} only`;
}

const STATE_TEXT = { loading: "載入中 / loading", listening: "聆聽中 / listening", error: "無法使用 / unavailable" } as const;

function renderDetectors(s: Session): void {
  $<HTMLTableSectionElement>("detectors").replaceChildren(
    ...s.detectors.map((d) => {
      const tr = document.createElement("tr");
      for (const text of [`${d.variant.id}${d.variant.id === PRODUCT_VARIANT ? "（產品 / product）" : ""}`, sourceText(d.variant), STATE_TEXT[d.state], String(d.detections)]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  const product = s.detectors.find((d) => d.variant.id === PRODUCT_VARIANT);
  const count = s.detectors.filter((d) => d.state === "listening").length;
  // 全部載入完（聆聽中或無法使用）才開放測試，免得早期的測試少了還在載入的偵測器（包括產品那一個）。
  const listening = count > 0 && !s.detectors.some((d) => d.state === "loading");
  if (count > 0 && !listening) setStatus("starting", `載入偵測器中 / loading detectors（${count}/${s.detectors.length}）`);
  else if (listening) setStatus("listening", `本機聆聽中 / listening locally（${count}/${s.detectors.length}）${product?.state === "error" ? "　產品偵測器無法使用 / product detector unavailable" : ""}`);
  else if (s.detectors.length > 0 && s.detectors.every((d) => d.state === "error")) setStatus("error", "偵測器都無法使用 / no detector is available");
  $<HTMLButtonElement>("trial").disabled = !listening || !!negative;
  $<HTMLButtonElement>("neg").disabled = !listening || !!trial;
}

// ───────────── 觸發、測試與負樣本 ─────────────

function onDetected(d: Detector, keywordIndex: number): void {
  d.detections++;
  const keyword = KEYWORDS[keywordIndex] ?? `#${keywordIndex}`;
  if (trial && performance.now() <= trial.end && d.variant.id in trial.hits) {
    trial.hits[d.variant.id] = true;
    log(`✅ ${d.variant.id}  ${keyword}`);
    showTrialProgress();
  } else if (negative && d.variant.id in negative.triggers) {
    negative.triggers[d.variant.id]! += 1;
    log(`⚠️ 負樣本觸發 / negative trigger  ${d.variant.id}  ${keyword}`);
  } else {
    if (d.variant.id === PRODUCT_VARIANT) unprompted++;
    $<HTMLSpanElement>("unprompted").textContent = String(unprompted);
    log(`· 未提示觸發 / unprompted  ${d.variant.id}  ${keyword}`);
  }
}

function beep(ctx: AudioContext): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.15;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function showTrialProgress(): void {
  if (!trial) return;
  const left = Math.max(0, (trial.end - performance.now()) / 1000);
  const product = trial.hits[PRODUCT_VARIANT];
  $<HTMLParagraphElement>("trialout").textContent = `請說 / Say “${PHRASE_TEXT[trial.phrase]}”（${trial.angle}°、${trial.distance.replace("m", " m")}）… ${left.toFixed(1)} s ${product ? "✅" : ""}`;
}

function startTrial(): void {
  const s = session;
  if (!s || trial || negative || $<HTMLButtonElement>("trial").disabled) return;
  const cell = selectedCell();
  const listening = s.detectors.filter((d) => d.state === "listening");
  const windowS = Math.min(15, Math.max(2, Number($<HTMLInputElement>("window").value) || 5));
  const beepOn = $<HTMLInputElement>("beep").checked;
  if (beepOn) beep(s.ctx);
  const startAt = performance.now() + (beepOn ? 200 : 0);
  trial = { ...cell, end: startAt + windowS * 1000, hits: Object.fromEntries(listening.map((d) => [d.variant.id, false])), timer: 0 };
  const tick = () => {
    if (!trial) return;
    if (performance.now() >= trial.end) return finishTrial();
    showTrialProgress();
    trial.timer = window.setTimeout(tick, 100);
  };
  tick();
  renderDetectors(s);
}

function finishTrial(): void {
  const t = trial;
  const s = session;
  trial = null;
  if (!t || !s) return;
  const record: Trial = { condition: s.condition, angle: t.angle, distance: t.distance, phrase: t.phrase, hits: t.hits };
  results.trials.push(record);
  added.push(record);
  const product = t.hits[PRODUCT_VARIANT];
  const others = Object.entries(t.hits).filter(([id]) => id !== PRODUCT_VARIANT).map(([id, hit]) => `${id} ${hit ? "✅" : "❌"}`).join("　");
  const out = $<HTMLParagraphElement>("trialout");
  out.className = `big ${product ? "hit" : "miss"}`;
  out.textContent = `${product === undefined ? "產品偵測器不可用 / product detector unavailable" : product ? "✅ 喚醒 / woke" : "❌ 沒有喚醒 / missed"}　${others}`;
  $<HTMLButtonElement>("undo").disabled = false;
  if ($<HTMLInputElement>("advance").checked && cellCount(results, s.condition, t.angle, t.distance, t.phrase) >= TRIALS_PER_CELL) {
    const next = nextCell(results, s.condition);
    if (next) {
      $<HTMLSelectElement>("angle").value = String(next.angle);
      $<HTMLSelectElement>("distance").value = next.distance;
      $<HTMLSelectElement>("phrase").value = next.phrase;
      log(`下一格 / next cell: ${next.angle}°、${next.distance}、${PHRASE_TEXT[next.phrase]}`);
    } else log("這個條件的 160 次都完成了 / all 160 trials done for this condition");
  }
  showCell();
  renderResults();
  renderDetectors(s);
}

function undoLast(): void {
  if (trial) return;
  const last = added.pop();
  if (!last) return;
  const index = results.trials.lastIndexOf(last);
  if (index >= 0) results.trials.splice(index, 1);
  // 回到被刪的那一格（自動換格之後復原，重說的那次才會記在原本的格子）
  $<HTMLSelectElement>("angle").value = String(last.angle);
  $<HTMLSelectElement>("distance").value = last.distance;
  $<HTMLSelectElement>("phrase").value = last.phrase;
  $<HTMLButtonElement>("undo").disabled = added.length === 0;
  $<HTMLParagraphElement>("trialout").textContent = "已刪除上一次 / last trial removed";
  showCell();
  renderResults();
}

function toggleNegative(): void {
  const s = session;
  const btn = $<HTMLButtonElement>("neg");
  if (negative) {
    clearTimeout(negative.timer);
    const seconds = (performance.now() - negative.started) / 1000;
    if (s) results.negatives.push({ condition: s.condition, kind: negative.kind, seconds, triggers: negative.triggers });
    log(`負樣本結束 / negative ended: ${NEG_TEXT[negative.kind]} ${Math.round(seconds)} s`);
    negative = null;
    btn.textContent = "開始負樣本 / Start negative";
    renderResults();
    if (s) renderDetectors(s);
    return;
  }
  if (!s || trial) return;
  const listening = s.detectors.filter((d) => d.state === "listening");
  negative = { kind: $<HTMLSelectElement>("negkind").value as NegativeKind, started: performance.now(), triggers: Object.fromEntries(listening.map((d) => [d.variant.id, 0])), timer: 0 };
  btn.textContent = "結束負樣本 / Stop negative";
  const tick = () => {
    if (!negative) return;
    const product = negative.triggers[PRODUCT_VARIANT] ?? 0;
    $<HTMLSpanElement>("negout").textContent = `${NEG_TEXT[negative.kind]}　${Math.round((performance.now() - negative.started) / 1000)} s　產品誤觸 / product false triggers: ${product}`;
    negative.timer = window.setTimeout(tick, 1000);
  };
  tick();
  renderDetectors(s);
}

// ───────────── 結果 ─────────────

const pct = (r: Rate) => (r.rate === null ? "—" : `${r.hits}/${r.n}（${Math.round(r.rate * 100)}%）`);
const ci = (r: Rate) => (r.low === null || r.high === null ? "" : ` [${Math.round(r.low * 100)}–${Math.round(r.high * 100)}%]`);

function renderResults(): void {
  const keys = knownKeys(results);
  const current = session?.condition ?? previewCondition();
  const conditions = [...new Set([current, ...keys.conditions])];
  fillSelect("rcond", conditions.map((c) => ({ value: c, text: c })));
  const variants = [...new Set([PRODUCT_VARIANT, ...keys.variants])];
  fillSelect("rvar", variants.map((v) => ({ value: v, text: v === PRODUCT_VARIANT ? `${v}（產品 / product）` : v })));
  const sum = summarize(results, $<HTMLSelectElement>("rcond").value, $<HTMLSelectElement>("rvar").value);
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const h of ["方向 / Angle", ...DISTANCES.flatMap((d) => POSITIVE_PHRASES.map((p) => `${d.replace("m", " m")} ${PHRASE_TEXT[p]}`)), "方向合計（95% 區間）/ Angle total (95% CI)"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  table.append(head);
  for (const a of ANGLES) {
    const tr = document.createElement("tr");
    const cells = [`${a}°`, ...DISTANCES.flatMap((d) => POSITIVE_PHRASES.map((p) => pct(sum.cells[a]![d]![p]!))), pct(sum.byAngle[a]!) + ci(sum.byAngle[a]!)];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    table.append(tr);
  }
  const lines = [
    `整體 / Overall: ${pct(sum.overall)}${ci(sum.overall)}`,
    `距離 / Distance: ${DISTANCES.map((d) => `${d} ${pct(sum.byDistance[d]!)}`).join("　")}`,
    `喚醒詞 / Phrase: ${POSITIVE_PHRASES.map((p) => `${PHRASE_TEXT[p]} ${pct(sum.byPhrase[p]!)}`).join("　")}`,
    `方向差距（最高 − 最低）/ Direction spread (best − worst): ${sum.spread === null ? "—" : `${Math.round(sum.spread * 100)} 個百分點 / points`}　最差方向 / Worst: ${sum.worstAngles.map((a) => `${a}°`).join("、") || "—"}`,
    `負樣本 / Negatives: ${NEGATIVE_KINDS.map((k) => {
      const n = sum.negatives[k]!;
      return `${NEG_TEXT[k]} ${n.triggers} 次 / times ÷ ${Math.round(n.seconds)} s = ${n.perHour === null ? "—" : n.perHour.toFixed(2)} 次每小時 / per hour`;
    }).join("　")}`,
  ];
  const text = document.createElement("p");
  text.innerText = lines.join("\n");
  $<HTMLDivElement>("summary").replaceChildren(table, text);
}

// ───────────── 接線 ─────────────

$<HTMLButtonElement>("start").addEventListener("click", () => void start());
$<HTMLButtonElement>("stop").addEventListener("click", () => stop());
$<HTMLButtonElement>("refresh").addEventListener("click", () => void refreshDevices());
$<HTMLButtonElement>("trial").addEventListener("click", () => startTrial());
$<HTMLButtonElement>("undo").addEventListener("click", () => undoLast());
$<HTMLButtonElement>("neg").addEventListener("click", () => toggleNegative());
for (const id of ["angle", "distance", "phrase"]) $<HTMLSelectElement>(id).addEventListener("change", showCell);
for (const id of ["rcond", "rvar"]) $<HTMLSelectElement>(id).addEventListener("change", renderResults);
for (const id of ["ec", "ns", "agc", "channels"]) $<HTMLElement>(id).addEventListener("change", () => {
  showCell();
  renderResults();
});
$<HTMLButtonElement>("export").addEventListener("click", () => {
  $<HTMLTextAreaElement>("io").value = JSON.stringify(results);
  $<HTMLPreElement>("csv").textContent = toCsv(results);
});
$<HTMLButtonElement>("import").addEventListener("click", () => {
  try {
    const imported = parseResults($<HTMLTextAreaElement>("io").value);
    // 匯入是「取代」，不是合併：同一份貼兩次不會把次數算兩倍。
    if ((results.trials.length > 0 || results.negatives.length > 0) && !window.confirm("匯入會取代目前的結果，先匯出備份。繼續？/ Importing replaces the current results. Export a backup first. Continue?")) return;
    results = imported;
    added = [];
    $<HTMLButtonElement>("undo").disabled = true;
    log(`已匯入 / imported: ${imported.trials.length} 次測試 / trials, ${imported.negatives.length} 段負樣本 / negative runs`);
    showCell();
    renderResults();
  } catch (err) {
    log(`匯入失敗 / import failed: ${(err as Error).message}`);
  }
});
$<HTMLButtonElement>("clear").addEventListener("click", () => {
  if (!window.confirm("清除全部結果？先匯出備份。/ Clear all results? Export a backup first.")) return;
  results = emptyResults();
  added = [];
  $<HTMLButtonElement>("undo").disabled = true;
  unprompted = 0;
  $<HTMLSpanElement>("unprompted").textContent = "0";
  showCell();
  renderResults();
});
// 空白鍵一律是「說一次」：焦點在按鈕上時也不讓瀏覽器按下那個按鈕（否則按過「刪除上一次」或「停止」後，空白鍵會再刪一次或停止）。
// 只有在輸入框、文字區、下拉選單裡才保留空白鍵原本的作用。按鈕點完就放掉焦點，雙重保險。
const typing = (target: EventTarget | null) => target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== "checkbox";
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || typing(event.target)) return;
  event.preventDefault();
  if (!event.repeat) startTrial();
});
document.addEventListener("keyup", (event) => {
  if (event.code === "Space" && !typing(event.target)) event.preventDefault();
});
document.addEventListener("click", (event) => {
  if (event.target instanceof HTMLButtonElement) event.target.blur();
});
window.addEventListener("pagehide", () => stop());

void refreshDevices();
showCell();
renderResults();
