import "./style.css";
import { computeProgress, isActive, queueText, sortForProgress } from "../shared/progress.ts";
import { CHATGPT_USAGE_URL, type Artifact, type ExecutorMode, type ServerEvent, type SettingsView, type Task } from "../shared/types.ts";
import { ApiError, api, newRequestId, streamChat, subscribeEvents } from "./api.ts";
import { ConversationSession } from "./conversation.ts";
import { cameraShouldRun, matchCameraCommand, SenseController, zoneOf } from "./sense/controller.ts";
import type { PreviewTargets, SensePipeline } from "./sense/pipeline.ts";
import { DEFAULT_CAMERA_PREFS, type CameraPrefsPatch, type PointZone, type SensorState } from "../shared/sense.ts";
import {
  browserRealtimeDeps,
  realtimeSupported,
  RealtimeVoice,
  type ApprovalOutcome,
  type McpApprovalRequest,
  type RealtimePhase,
} from "./realtime.ts";
import { Brain } from "./brain.ts";
import { classifyDomain, DOMAINS, isDomain } from "../shared/domain.ts";
import { activityDescription, collectRegionActivity, type RegionActivity } from "./region-activity.ts";
import { formatCount } from "./format.ts";
import { homeStatusLine } from "../shared/home.ts";
import { classify } from "./intent.ts";
import { evaluateSurface } from "./presentation-policy.ts";
import { initialShell, reduceShell, type ShellEvent, type ShellState } from "./shell-state.ts";
import {
  progressStructureKey,
  refreshTimers,
  renderArtifact,
  renderError,
  renderNotice,
  renderProgress,
  renderSettings,
  renderConfirm,
  refreshCountdowns,
  updateLiveCounts,
  type ConfirmDetail,
  type ViewActions,
} from "./views.ts";
import { speakFinished, speakProgress } from "./speech-text.ts";
import {
  PushToTalk,
  VoiceConversation,
  hasVoiceConsent,
  saveVoiceConsent,
  speechSupported,
  type ConsentKind,
  type ConversationState,
} from "./voice.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** macOS App（Electron）的 preload 提供；在一般瀏覽器裡不存在。 */
interface DesktopBridge {
  openExternal(url: string): void;
  reportState(state: { voice: string; activeTasks: number }): void;
}
declare global {
  interface Window {
    nousDesktop?: DesktopBridge;
  }
}

const canvas = $<HTMLCanvasElement>("brain");
const regionActivity = $<HTMLParagraphElement>("region-activity");
const statusLine = $<HTMLParagraphElement>("status-line");
const caption = $<HTMLDivElement>("caption");
const form = $<HTMLFormElement>("command");
const input = $<HTMLInputElement>("command-input");
const micButton = $<HTMLButtonElement>("mic");
const micIndicator = $<HTMLSpanElement>("mic-indicator");
const consentBox = $<HTMLDivElement>("voice-consent");
const consentText = $<HTMLParagraphElement>("voice-consent-text");
const voiceModeButton = $<HTMLButtonElement>("voice-mode");
const voicePill = $<HTMLButtonElement>("voice-pill");
const subtitle = $<HTMLParagraphElement>("subtitle");
const engineLine = $<HTMLParagraphElement>("engine-line");
const commandError = $<HTMLParagraphElement>("command-error");
const surfaceRoot = $<HTMLDivElement>("surface-root");
const firstHint = $<HTMLParagraphElement>("first-hint");
const startConversation = $<HTMLButtonElement>("start-conversation");
const conversationReply = $<HTMLDivElement>("conversation-reply");
const conversationUser = $<HTMLParagraphElement>("conversation-user");
const conversationAnswer = $<HTMLParagraphElement>("conversation-answer");
const conversationStatus = $<HTMLParagraphElement>("conversation-status");
let developmentProvider: ExecutorMode | null = null;
let conversationEpoch = 0;
let pendingProviderSelection: { epoch: number; account: string } | null = null;

const brain = new Brain(canvas);
brain.start();

const tasks = new Map<string, Task>();
const artifacts = new Map<string, Artifact>();
const artifactErrors = new Map<string, string>();
/** 只有真實的使用者輸入會登記在這裡；Presentation Policy 以此驗證 user_request。 */
const userRequestIds = new Set<string>();
let shell: ShellState = initialShell;
let settings: SettingsView | null = null;
let connected = false;
let renderedKey: string | null = null;

// 按下說話的語音輸入（明確啟動，不做背景喚醒）。
const voice = new PushToTalk({
  onCaptureChange: () => render(),
  onInterim: (text) => {
    input.value = text;
  },
  onFinal: (text) => {
    input.value = text;
    void handleCommand(text);
  },
  onListeningChange: (listening) => {
    micIndicator.hidden = !listening;
    micButton.classList.toggle("recording", listening);
    micButton.setAttribute("aria-label", listening ? "停止收音" : "按下開始說話");
    render();
  },
  onError: showCommandError,
});

// 連續語音對話模式：開啟後不用按鍵，說完一句就處理一句，並用語音簡短回覆。
const VOICE_IDLE_MS = 90_000;
const conversation = new VoiceConversation(
  {
    onCaptureChange: () => render(),
    onPlaybackChange: () => render(),
    onUtterance: (text) => {
      session.interrupt();
      showSubtitle(`你：${text}`);
      void handleCommand(text);
    },
    onInterim: (text) => showSubtitle(`你：${text}…`, true),
    onStateChange: renderVoiceState,
    onBargeIn: () => {
      session.interrupt();
      brain.pulse("step");
    },
    onSentenceSpoken: () => brain.pulse("stream", "language"),
    onClosed: (reason) => {
      showSubtitle(reason);
      session.interrupt();
      dispatch({ type: "input.open" });
      showCommandError(reason);
    },
  },
  { idleMs: VOICE_IDLE_MS },
);
let pendingConsent: ConsentKind = "push";

// 即時語音模式（OpenAI Realtime）：有 OPENAI_API_KEY 時，「開始語音對話」改用語音直接對語音。
const REALTIME_IDLE_MS = 120_000;
/** 即時語音中交辦的任務：完成時請模型用語音轉告。 */
const realtimeTaskIds = new Set<string>();
const realtime = new RealtimeVoice(
  {
    onPhase: renderRealtimeState,
    onUserTranscript: (text) => {
      showSubtitle(`你：${text}`);
      handleCameraCommand(text);
    },
    onAssistantTranscript: (text) => showSubtitle(`Nous：${text}`),
    onDelegate: delegateFromRealtime,
    onGetTasks: async () => ({ ok: true, tasks: taskSummary() }),
    onWebSearch: webSearchFromRealtime,
    onHomeStatus: homeStatusFromRealtime,
    onApprovalPrompt: showApproval,
    onApprovalResolved: closeApproval,
    onToolActivity: (text) => showSubtitle(text),
    onClosed: (reason) => {
      sense.conversationEnded();
      showSubtitle(reason);
      dispatch({ type: "input.open" });
      showCommandError(reason);
    },
  },
  browserRealtimeDeps(async (sdp) => (await api.realtimeCall(sdp)).sdp),
  { idleMs: REALTIME_IDLE_MS },
);

const session = new ConversationSession({
  stream: streamChat,
  output: () => {
    const reply = conversation.beginReply();
    return { push: (text) => reply.push(text), end: () => reply.end(), cancel: () => reply.cancel() };
  },
  activity: (kind, _requestId, text) => brain.pulse(kind, classifyDomain(text)),
  changed: () => render(),
  delegated: (title, requestId) => void delegateTask(title, requestId),
});

function accountKey(value: SettingsView): string {
  return JSON.stringify([value.chatgpt.email, value.chatgpt.signed_in, value.chatgpt.plan_usage, value.chatgpt.needs_reauth]);
}

function applySettings(value: SettingsView, preserveEntry = false): void {
  if (settings && (settings.provider !== value.provider || accountKey(settings) !== accountKey(value))) {
    const expectedSelection = settings.provider !== "chatgpt" && value.provider === "chatgpt"
      && pendingProviderSelection?.epoch === conversationEpoch
      && pendingProviderSelection.account === accountKey(value);
    if (!preserveEntry && !expectedSelection) conversationEpoch++;
    session.reset();
    conversation.stop();
    hideSubtitle();
  }
  const wasActive = settings?.camera?.active;
  settings = value;
  if (value.camera && !value.camera.active) cameraOffPending = false; // 伺服器已保存「關掉」
  if (value.camera && wasActive !== undefined && value.camera.active !== wasActive) cameraFailed = false;
  syncCamera();
}

function chatGPTAvailable(): boolean {
  return !!settings?.providers.find((provider) => provider.id === "chatgpt")?.available
    && settings.chatgpt.signed_in && settings.chatgpt.plan_usage && !settings.chatgpt.needs_reauth;
}

async function prepareConversation(requestId: string, epoch: number): Promise<boolean> {
  if (!connected || !settings) {
    dispatch({ type: "input.open" });
    showCommandError("尚未連線到本機核心，請稍候再試。");
    return false;
  }
  if (settings.provider === developmentProvider && settings.providers.find((provider) => provider.id === developmentProvider)?.available) return true;
  if (chatGPTAvailable()) {
    if (settings.provider !== "chatgpt") {
      const selection = { epoch, account: accountKey(settings) };
      pendingProviderSelection = selection;
      try {
        const next = await api.selectProvider("chatgpt");
        if (epoch !== conversationEpoch) return false;
        if (accountKey(next) !== selection.account) {
          applySettings(next);
          return false;
        }
        applySettings(next, true);
      } finally {
        if (pendingProviderSelection === selection) pendingProviderSelection = null;
      }
    }
    return epoch === conversationEpoch;
  }
  dispatch({ type: "show.settings", request_id: requestId, message: "請先按 Continue with ChatGPT 登入自己的帳號。完成後按「開始語音對話」，也可直接打字。" });
  return false;
}

async function converse(text: string, requestId: string): Promise<void> {
  const epoch = ++conversationEpoch;
  try {
    if (!await prepareConversation(requestId, epoch) || epoch !== conversationEpoch) return;
    input.value = "";
    dispatch({ type: "dismiss" });
    hideSubtitle();
    await session.send(text, requestId);
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    dispatch({ type: "input.open" });
    showCommandError(error instanceof Error ? error.message : "無法開始對話。");
  }
}

function closeConversation(): void {
  conversationEpoch++;
  session.dismiss();
  conversation.stop();
  realtime.stop();
  voice.abort();
  hideSubtitle();
  dispatch({ type: "dismiss" });
  render();
}

function openConversation(): void {
  dismissFirstHint();
  if (realtimeReady()) {
    startRealtime();
    return;
  }
  const requestId = userRequest();
  const epoch = ++conversationEpoch;
  if (settings?.provider === "chatgpt" && chatGPTAvailable() || settings?.provider === developmentProvider) {
    enableVoiceMode();
  } else {
    void prepareConversation(requestId, epoch).then((ready) => {
      if (ready && epoch === conversationEpoch) {
        dispatch({ type: "input.open" });
        showCommandError("ChatGPT 已就緒。按語音按鈕開始，或直接輸入訊息。");
      }
    }).catch((error: unknown) => {
      if (epoch !== conversationEpoch) return;
      dispatch({ type: "input.open" });
      showCommandError(error instanceof Error ? error.message : "無法連線到 ChatGPT。");
    });
  }
}

/** AI 在對話中決定交辦的工作：建立背景任務並在電子腦下方顯示進度。 */
async function delegateTask(title: string, requestId: string): Promise<void> {
  const epoch = conversationEpoch;
  const stillCurrent = () => {
    const { reply, visible } = session.view;
    return epoch === conversationEpoch && visible
      && (reply.kind === "pending" || reply.kind === "complete") && reply.requestId === requestId;
  };
  try {
    const task = await api.createTask(title, requestId);
    if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
    if (!stillCurrent()) {
      render();
      return;
    }
    dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
    dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
  } catch (err) {
    if (stillCurrent()) showSubtitle(`交辦失敗：${(err as Error).message}`);
  }
}

/** 語音模式開啟時念出回覆並顯示字幕；文字模式下不出聲。 */
function say(text: string): void {
  if (!conversation.on) return;
  showSubtitle(`Nous：${text}`);
  void conversation.speak(text);
}

let subtitleTimer: ReturnType<typeof setTimeout> | null = null;
function hideSubtitle(): void {
  if (subtitleTimer) clearTimeout(subtitleTimer);
  subtitleTimer = null;
  subtitle.hidden = true;
}

function showSubtitle(text: string, sticky = false): void {
  subtitle.textContent = text;
  subtitle.hidden = false;
  if (subtitleTimer) clearTimeout(subtitleTimer);
  if (!sticky) subtitleTimer = setTimeout(() => (subtitle.hidden = true), 6000);
}

const VOICE_STATE_LABEL: Record<ConversationState, string> = {
  off: "",
  listening: "● 語音模式 · 聆聽中",
  speaking: "● 語音模式 · 回覆中（可直接插話）",
};

function renderVoiceState(state: ConversationState): void {
  voicePill.hidden = state === "off";
  voicePill.textContent = `${VOICE_STATE_LABEL[state]}（點此關閉）`;
  voicePill.dataset.state = state;
  voiceModeButton.classList.toggle("recording", state !== "off");
  voiceModeButton.setAttribute("aria-label", state === "off" ? "開啟語音對話模式" : "關閉語音對話模式");
  render();
}

function enableVoiceMode(): void {
  const ready = settings && (settings.provider === "chatgpt" && chatGPTAvailable()
    || settings.provider === developmentProvider && settings.providers.some((provider) => provider.id === developmentProvider && provider.available));
  if (!ready) {
    void prepareConversation(userRequest(), ++conversationEpoch).catch((error: unknown) => showCommandError(error instanceof Error ? error.message : "無法連線。"));
    return;
  }
  if (!speechSupported()) {
    dispatch({ type: "input.open" });
    showCommandError("這個瀏覽器不支援語音辨識，仍可直接打字對話。語音請使用 Chrome 或 Edge。");
    return;
  }
  if (!hasVoiceConsent("continuous")) {
    askConsent("continuous");
    return;
  }
  voice.abort();
  dispatch({ type: "dismiss" });
  conversation.start();
  say("語音模式已開啟，直接跟我說話就好，我說話時你也可以打斷我。");
}

// ───────────── 雙目鏡頭（docs/11） ─────────────
// 影像只在本機處理；這裡只收到在場、面向、手勢、指向等事件。手勢與指向不觸發任何外部動作。

const sensorIndicator = document.createElement("button");
sensorIndicator.type = "button";
sensorIndicator.className = "sensor-indicator";
sensorIndicator.hidden = true;
document.body.append(sensorIndicator);
let pipeline: SensePipeline | null = null;
let pointedZone: PointZone | null = null;
/** 最後一次的鏡頭裝置狀態（來自管線事件，不是設定）。 */
let sensorState: SensorState = "off";
/**
 * 這個視窗剛說了「鏡頭關掉」但伺服器還沒回報 active=false：防止尚未保存時收到舊的 hello 把鏡頭又打開。
 * 清除：伺服器回報 active=false，或使用者開鏡頭。
 */
let cameraOffPending = false;
/** 上次啟動失敗：不在每次 hello／settings.updated 重試；使用者再次開啟或 active 改變時才重試。 */
let cameraFailed = false;

// 鏡頭畫面：使用者要求才出現（user_request），不保存，重新整理後一定是收起。與 sensorIndicator 一樣是 ShellState 之外的覆蓋層。
const PREVIEW_W = 256;
const PREVIEW_H = 144;
const sensorPreview = document.createElement("div");
sensorPreview.className = "sensor-preview";
sensorPreview.hidden = true;
const previewTargets: PreviewTargets = { live: previewCanvas(), diff: previewCanvas() };
const previewClose = document.createElement("button");
previewClose.type = "button";
previewClose.className = "sensor-preview-close";
previewClose.textContent = "×";
previewClose.setAttribute("aria-label", "收起鏡頭畫面");
previewClose.addEventListener("click", () => closePreview());
sensorPreview.append(
  previewClose,
  previewTile(previewTargets.live, "即時影像（左眼）· 只在本機"),
  previewTile(previewTargets.diff, "左右眼差異 · 只在本機"),
);
document.body.append(sensorPreview);
/** 唯一的預覽狀態；null = 收起。 */
let previewRequestId: string | null = null;

function previewCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = PREVIEW_W;
  c.height = PREVIEW_H;
  return c;
}

function previewTile(target: HTMLCanvasElement, label: string): HTMLElement {
  const figure = document.createElement("figure");
  const stale = document.createElement("span");
  stale.className = "sensor-preview-stale";
  stale.textContent = "影像中斷";
  const text = document.createElement("figcaption");
  text.textContent = label;
  figure.append(target, stale, text);
  return figure;
}

/** 只在鏡頭運作中（含暫時中斷）時打開；其他狀態說明原因。 */
function openPreview(requestId: string): void {
  if (sensorState !== "ok" && sensorState !== "degraded") {
    showSubtitle(settings?.camera?.enabled ? "鏡頭沒有在運作，無法顯示鏡頭畫面。" : "鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）。");
    return;
  }
  previewRequestId = requestId;
  sensorPreview.dataset.visibilityReason = "user_request";
  sensorPreview.dataset.requestId = requestId;
  sensorPreview.hidden = false;
  document.body.dataset.cameraPreview = "open";
  pipeline?.setPreview(previewTargets);
}

/** 只收起畫面，不關鏡頭（收起 ≠ 停止）。 */
function closePreview(): void {
  previewRequestId = null;
  sensorPreview.hidden = true;
  delete sensorPreview.dataset.visibilityReason;
  delete sensorPreview.dataset.requestId;
  delete document.body.dataset.cameraPreview;
  pipeline?.setPreview(null);
}

sensorIndicator.addEventListener("click", () => (previewRequestId ? closePreview() : openPreview(userRequest())));

const sense = new SenseController({
  now: () => performance.now(),
  isTalking: () => realtime.on || conversation.current !== "off",
  canAutoTalk: () => !!settings?.realtime?.available && realtimeSupported() && hasVoiceConsent("realtime"),
  prefs: () => settings?.camera ?? DEFAULT_CAMERA_PREFS,
  startTalk: () => startRealtime(),
  interruptSpeech: () => {
    if (realtime.current === "speaking") realtime.interrupt();
    else if (conversation.current === "speaking") conversation.interrupt();
  },
  onLeave: () => {
    // 人離開：待確認的外部動作不執行、收起畫面、結束即時語音（避免對空房間持續計費）。
    if (realtime.pendingApproval) realtime.resolveApproval(false, "dismissed");
    if (shell.surface) dispatch({ type: "dismiss" });
    if (realtime.on) realtime.stop();
    closePreview();
  },
  setScale: (scale) => document.documentElement.style.setProperty("--distance-scale", String(scale)),
  setPresence: (present) => (document.body.dataset.present = present ? "yes" : "no"),
  setFacing: (facing) => (document.body.dataset.facing = facing ? "yes" : "no"),
  pointTo: (zone) => {
    pointedZone = zone;
    applyPointing();
  },
  setSensor: (state: SensorState, detail: string) => {
    sensorState = state;
    sensorIndicator.hidden = state === "off";
    sensorIndicator.dataset.state = state;
    sensorIndicator.title = `${detail}（按一下顯示／收起鏡頭畫面）`;
    sensorIndicator.textContent = state === "ok" ? "鏡頭" : state === "starting" ? "鏡頭啟動中" : `鏡頭：${detail}`;
    sensorPreview.dataset.state = state;
    if (state === "off" || state === "error" || state === "starting") closePreview();
    if (state === "error") {
      cameraFailed = true;
      showSubtitle(detail);
    }
  },
});
setInterval(() => sense.tick(), 200);

/** 把指向的區塊對到畫面上可選的項目；只是選定（亮框），不展開、不送出（06 §4.4）。 */
function applyPointing(): void {
  const items = [...surfaceRoot.querySelectorAll<HTMLElement>("[data-selectable]")];
  let target: HTMLElement | null = null;
  for (const el of items) {
    const rect = el.getBoundingClientRect();
    const hit = pointedZone !== null && zoneOf(rect.left + rect.width / 2, window.innerWidth) === pointedZone;
    el.classList.toggle("pointed", hit && target === null);
    if (hit && target === null) target = el;
  }
  const label = target?.dataset.label ?? null;
  if (realtime.on && label) realtime.addContext(`（系統狀態）使用者正用手指著畫面上的「${label}」。使用者說「這個」時指的是它；指向只是選定，不代表要執行任何動作。`);
}

/** 唯一決定鏡頭開關的地方；冪等（管線的 start／stop 重複呼叫不發事件），每次設定更新與指令都呼叫。 */
function syncCamera(): void {
  if (cameraShouldRun(settings?.camera, cameraOffPending, cameraFailed)) void startCamera();
  else pipeline?.stop();
}

async function startCamera(): Promise<void> {
  const { SensePipeline } = await import("./sense/pipeline.ts");
  // 載入模組期間可能已收到「鏡頭關掉」。
  if (!settings?.camera || !cameraShouldRun(settings.camera, cameraOffPending, cameraFailed)) return;
  pipeline ??= new SensePipeline(settings.camera, (event) => sense.handle(event));
  await pipeline.start();
}

/**
 * 設定畫面、語音、打字、即時語音逐字稿：所有鏡頭使用者設定都走這一條。
 * 「關掉」先在本機釋放鏡頭再送出，不等網路。回傳失敗說明；成功時為 null。
 */
async function updateCameraPrefs(patch: CameraPrefsPatch): Promise<string | null> {
  if (patch.active === false) cameraOffPending = true;
  if (patch.active === true) {
    cameraOffPending = false;
    cameraFailed = false;
  }
  syncCamera();
  try {
    applySettings(await api.updateCamera(patch));
    render();
    return null;
  } catch (err) {
    // 保存失敗（核心回 500）與核心未連線都走這裡：核心仍是上次保存的設定。
    return patch.active === false
      ? `鏡頭已在這個視窗關閉，但沒有保存（${(err as Error).message}）；重新整理或重新啟動後，會依上次保存的設定決定是否開啟。`
      : `鏡頭設定沒有保存：${(err as Error).message}`;
  }
}

/** 鏡頭、鏡頭畫面、看著說話、手掌停止：本機規則處理，不經模型。 */
function handleCameraCommand(text: string): boolean {
  const command = matchCameraCommand(text);
  if (!command) return false;
  if ("preview" in command) {
    if (command.preview) openPreview(userRequest());
    else closePreview();
  } else if (!settings?.camera?.enabled) {
    showSubtitle("鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）。");
  } else {
    void updateCameraPrefs(command.set).then((error) => showSubtitle(error ?? command.say));
  }
  return true;
}

// ───────────── 即時語音（OpenAI Realtime） ─────────────

function realtimeReady(): boolean {
  return !!settings?.realtime?.available && realtimeSupported();
}

function startRealtime(): void {
  if (realtime.on) return;
  if (!hasVoiceConsent("realtime")) {
    askConsent("realtime");
    return;
  }
  conversationEpoch++;
  voice.abort();
  conversation.stop();
  session.dismiss();
  hideSubtitle();
  dispatch({ type: "dismiss" });
  void realtime.start();
}

const REALTIME_STATE_LABEL: Record<Exclude<RealtimePhase, "off">, string> = {
  connecting: "● 即時語音 · 連線中",
  listening: "● 即時語音 · 聆聽中",
  hearing: "● 即時語音 · 正在聽你說",
  thinking: "● 即時語音 · 思考中",
  speaking: "● 即時語音 · 回覆中（可直接插話）",
};

function renderRealtimeState(phase: RealtimePhase): void {
  voicePill.hidden = phase === "off";
  if (phase !== "off") voicePill.textContent = `${REALTIME_STATE_LABEL[phase]}（點此結束）`;
  voicePill.dataset.state = phase === "off" ? "off" : phase === "speaking" ? "speaking" : "listening";
  voiceModeButton.classList.toggle("recording", phase !== "off");
  voiceModeButton.setAttribute("aria-label", phase === "off" ? "開始語音對話" : "結束即時語音");
  render();
}

/** 模型在即時語音中決定交辦的工作：建立任務、顯示進度，並把真實狀態交還給模型。 */
async function delegateFromRealtime(title: string): Promise<Record<string, unknown>> {
  const requestId = userRequest();
  const created = await api.createTask(title, requestId);
  if (!tasks.has(created.task_id)) tasks.set(created.task_id, created);
  realtimeTaskIds.add(created.task_id);
  dispatch({ type: "task.submitted", task_id: created.task_id, request_id: requestId });
  dispatch({ type: "task.updated", task: tasks.get(created.task_id)! });
  const task = tasks.get(created.task_id)!;
  return {
    ok: true,
    title: task.title,
    status: task.status,
    engine: PROVIDER_LABEL[task.mode],
    note: task.status === "queued" ? queueText(task, tasks.values()) : "已開始處理，進度顯示在電子腦下方",
  };
}

/** 模型要上網查詢：本機核心代查，字幕顯示來源；失敗時照實交還給模型。 */
async function webSearchFromRealtime(query: string): Promise<Record<string, unknown>> {
  brain.pulse("step", classifyDomain(query));
  try {
    const result = await api.webSearch(query);
    if (result.sources.length) showSubtitle(`來源：${result.sources.map((s) => s.title).slice(0, 3).join("、")}`);
    return { ok: true, answer: result.answer, sources: result.sources.map((s) => s.title) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSubtitle(message);
    return { ok: false, error: message };
  }
}

/** 模型要查家電狀態：本機核心帶權杖問中控，字幕顯示讀值與資料時間；失敗時照實交還給模型。 */
async function homeStatusFromRealtime(target: string, metric: string | null): Promise<Record<string, unknown>> {
  brain.pulse("step", classifyDomain(target));
  try {
    const result = await api.homeStatus(target, metric);
    showSubtitle(homeStatusLine(result));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSubtitle(message);
    return { ok: false, error: message };
  }
}

/** 目前顯示中的外部動作確認卡（來自 OpenAI 的 mcp_approval_request）。 */
const pendingConfirms = new Map<string, ConfirmDetail>();

/** 外部服務要執行需要核准的動作：顯示確認卡，等使用者說「確認執行」或「取消」，不需要按任何東西。 */
function showApproval(request: McpApprovalRequest, expiresAt: number): void {
  pendingConfirms.set(request.id, { server: request.server, name: request.name, arguments: request.arguments, expiresAt });
  dispatch({ type: "show.confirm", request_id: request.id, message: `${request.server} · ${request.name}` });
}

function closeApproval(request: McpApprovalRequest, _approved: boolean, outcome: ApprovalOutcome): void {
  pendingConfirms.delete(request.id);
  if (outcome === "timeout") showSubtitle("確認逾時，沒有執行。");
  if (shell.surface?.kind === "confirm" && shell.surface.request_id === request.id) dispatch({ type: "dismiss" });
  else render();
}

/** get_tasks 工具的回傳：最近的任務與真實進度。 */
function taskSummary(): Record<string, unknown>[] {
  return sortForProgress(tasks.values()).slice(0, 8).map((task) => {
    const p = computeProgress(task);
    return {
      title: task.title,
      status: task.status,
      progress: p.total === null ? null : `${p.done}/${p.total}`,
      ...(task.status === "queued" ? { note: queueText(task, tasks.values()) } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
  });
}

function disableVoiceMode(): void {
  if (realtime.on) {
    realtime.stop();
    showSubtitle("即時語音已結束。");
    return;
  }
  if (!conversation.on) return;
  session.interrupt();
  conversation.stop();
  showSubtitle("語音模式已關閉。");
}

const CONSENT_TEXT: Record<ConsentKind, string> = {
  realtime:
    "即時語音模式像 ChatGPT 語音模式：開啟期間麥克風音訊會即時串流到 OpenAI（使用你在 .env 設定的 OPENAI_API_KEY，依用量計費），AI 直接用語音回答，你隨時可以插話。要它做較長的工作時會交辦成背景任務，仍用目前選擇的引擎執行。說「再見」或「結束對話」、點右上角指示、按 Esc 或 2 分鐘沒說話就會結束。本系統不保存音訊。要開啟嗎？",
  push:
    "語音辨識使用瀏覽器內建服務；在 Chrome／Edge 中，音訊會傳到瀏覽器供應商（例如 Google）的雲端辨識。只有在你按下麥克風時才收音，本系統不保存音訊。要啟用嗎？",
  continuous:
    "語音模式是對話：開啟期間會持續收音（包含 Nous 說話時，才能讓你插話），你說的話會傳到瀏覽器供應商（例如 Google）的雲端辨識，並送到目前的 AI 引擎回答，回覆用電腦語音念出。建議戴耳機，插話會更準。說「關閉語音模式」、點右上角指示或 90 秒沒說話就會關閉。本系統不保存音訊。要開啟嗎？",
};

function askConsent(kind: ConsentKind): void {
  pendingConsent = kind;
  consentText.textContent = CONSENT_TEXT[kind];
  dispatch({ type: "input.open" });
  consentBox.hidden = false;
}

function userRequest(): string {
  const id = newRequestId();
  userRequestIds.add(id);
  return id;
}

function dispatch(event: ShellEvent): void {
  if (event.type.startsWith("show.")) {
    conversationEpoch++;
    session.dismiss();
    hideSubtitle();
  }
  const next = reduceShell(shell, event);
  if (next === shell) return;
  const wasListening = shell.listening;
  const leftConfirm = shell.surface?.kind === "confirm" && next.surface?.surface_id !== shell.surface.surface_id ? shell.surface.request_id : null;
  shell = next;
  // 確認卡被收起或被其他畫面取代：視為不同意，外部動作不執行。
  if (leftConfirm && pendingConfirms.has(leftConfirm) && realtime.pendingApproval?.id === leftConfirm) {
    realtime.resolveApproval(false, "dismissed");
  }
  if (!wasListening && shell.listening) {
    form.hidden = false;
    input.focus();
  }
  if (wasListening && !shell.listening) {
    voice.abort();
    consentBox.hidden = true;
    commandError.hidden = true;
  }
  render();
}

// ───────────── 伺服器事件 ─────────────

function onServerEvent(event: ServerEvent): void {
  if (event.type === "settings.updated") {
    const wasPending = settings?.chatgpt.pending_login;
    applySettings(event.settings);
    // 使用者按下的登入剛完成：切換到 ChatGPT，沿用該次點擊的請求顯示設定與說明。
    if (wasPending && !event.settings.chatgpt.pending_login && loginRequestId) {
      const requestId = loginRequestId;
      loginRequestId = null;
      if (event.settings.chatgpt.signed_in && event.settings.chatgpt.plan_usage && event.settings.provider !== "chatgpt") {
        void selectProvider("chatgpt", requestId);
      } else {
        dispatch({ type: "show.settings", request_id: requestId });
      }
      if (event.settings.chatgpt.signed_in) {
        showCommandError("已登入 ChatGPT，按「開始語音對話」後才會收音。");
      }
    }
    render();
    return;
  }
  if (event.type === "hello") {
    applySettings(event.settings);
    tasks.clear();
    for (const t of event.tasks) tasks.set(t.task_id, t);
    render();
    return;
  }
  const prev = tasks.get(event.task.task_id);
  tasks.set(event.task.task_id, event.task);
  firePulses(prev, event.task);
  const wasForeground = shell.mode === "working" && shell.foreground_task_id === event.task.task_id;
  dispatch({ type: "task.updated", task: event.task });
  if (realtimeTaskIds.has(event.task.task_id) && !isActive(event.task)) {
    // 即時語音中交辦的任務結束：請模型用一句話轉告（不論是否還在前景）。
    realtimeTaskIds.delete(event.task.task_id);
    if (realtime.on) realtime.notify(speakFinished(event.task));
  } else if (wasForeground && shell.mode !== "working") {
    // 只有前景任務結束才念；收起後的背景任務保持安靜。
    say(speakFinished(event.task));
  }
  render();
}

/** 把真實狀態變化轉成光脈衝；沒有事件就沒有脈衝。 */
function firePulses(prev: Task | undefined, next: Task): void {
  if (!prev) {
    brain.pulse("submit", next.status === "running" && !next.plan_ready ? "planning" : null);
    return;
  }
  if (prev.status !== next.status) {
    if (next.status === "succeeded") brain.pulse("success");
    if (next.status === "failed") brain.pulse("error");
  }
  next.steps.forEach((step, i) => {
    const before = prev.steps[i];
    const domain = isDomain(step.domain) ? step.domain : null;
    if (step.status !== before?.status) {
      if (step.status === "running") brain.pulse("step", domain);
      if (step.status === "done") brain.pulse("stepDone", domain);
    }
    if (step.output_chars !== null && step.output_chars !== (before?.output_chars ?? null)) brain.pulse("stream", domain);
  });
}

subscribeEvents({
  onEvent: onServerEvent,
  onConnectionChange(value) {
    connected = value;
    render();
  },
});

// ───────────── 指令 ─────────────

function latestArtifactTask(): Task | undefined {
  return [...tasks.values()]
    .filter((t) => t.status === "succeeded" && t.artifact_id)
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""))[0];
}

async function handleCommand(text: string): Promise<void> {
  if (handleCameraCommand(text)) {
    dispatch({ type: "input.close" });
    return;
  }
  const intent = classify(text);
  if (intent.kind === "empty") {
    dispatch({ type: "input.close" });
    return;
  }
  const requestId = userRequest();
  switch (intent.kind) {
    case "voice_on":
      input.value = "";
      openConversation();
      return;
    case "voice_off":
      input.value = "";
      disableVoiceMode();
      return;
    case "settings":
      input.value = "";
      dispatch({ type: "show.settings", request_id: requestId });
      say(settings?.camera?.enabled ? "這是 AI 引擎與鏡頭設定。" : "這是 AI 引擎設定。");
      return;
    case "use_provider":
      input.value = "";
      await selectProvider(intent.provider, requestId);
      return;
    case "dismiss":
      input.value = "";
      closeConversation();
      return;
    case "progress":
      input.value = "";
      dispatch({ type: "show.progress", request_id: requestId });
      // 即時語音中由 AI 查詢真實進度後用語音回答，對話不中斷。
      if (realtime.on) realtime.sendText(text);
      else say(speakProgress(tasks.values()));
      return;
    case "result": {
      input.value = "";
      const task = latestArtifactTask();
      if (task?.artifact_id) {
        dispatch({ type: "show.artifact", request_id: requestId, task_id: task.task_id, artifact_id: task.artifact_id });
        say(`這是「${task.title.slice(0, 18)}」的成果。`);
      } else {
        const message = "還沒有完成的成果。問「進度如何」可以看目前狀態。";
        dispatch({ type: "show.notice", request_id: requestId, message });
        say(message);
      }
      return;
    }
    case "stop": {
      input.value = "";
      const active = [...tasks.values()].filter((t) => t.status === "queued" || t.status === "running");
      if (active.length === 0) {
        dispatch({ type: "show.notice", request_id: requestId, message: "目前沒有進行中的任務。" });
        say("目前沒有進行中的任務。");
      } else if (active.length === 1) {
        await cancelTask(active[0].task_id, requestId);
      } else {
        const message = `有 ${active.length} 個任務進行中，請在下方選擇要停止哪一個。`;
        dispatch({ type: "show.progress", request_id: requestId, message });
        say(message);
      }
      return;
    }
    case "task":
      if (realtime.on) {
        input.value = "";
        showSubtitle(`你：${intent.text}`);
        realtime.sendText(intent.text);
        return;
      }
      await converse(intent.text, requestId);
      return;
  }
}

async function cancelTask(taskId: string, requestId: string): Promise<void> {
  try {
    const task = await api.cancelTask(taskId);
    tasks.set(task.task_id, task);
    dispatch({ type: "show.progress", request_id: requestId });
    say(`正在停止：${task.title.slice(0, 18)}。`);
  } catch (err) {
    const message = `無法停止任務：${(err as Error).message}`;
    dispatch({ type: "show.progress", request_id: requestId, message });
    say(message);
  }
}

const actions: ViewActions = {
  cancel: (taskId) => void cancelTask(taskId, userRequest()),
  async retry(taskId) {
    const requestId = userRequest();
    try {
      const task = await api.retryTask(taskId, requestId);
      if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
      dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
      dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
    } catch (err) {
      dispatch({ type: "show.notice", request_id: requestId, message: `無法重試：${(err as Error).message}` });
    }
  },
  openArtifact: (taskId, artifactId) =>
    dispatch({ type: "show.artifact", request_id: userRequest(), task_id: taskId, artifact_id: artifactId }),
  showProgress: () => dispatch({ type: "show.progress", request_id: userRequest() }),
  dismiss: () => dispatch({ type: "dismiss" }),
  openSettings: () => dispatch({ type: "show.settings", request_id: userRequest() }),
  selectProvider: (provider) => void selectProvider(provider, userRequest()),
  updateCamera(patch) {
    const requestId = userRequest();
    void updateCameraPrefs(patch).then((error) => {
      if (error) dispatch({ type: "show.settings", request_id: requestId, message: error });
    });
  },
  openCameraPreview: () => openPreview(userRequest()),
  chatgptLogin: (mode) => void chatgptLogin(mode, userRequest()),
  async chatgptCancel() {
    const next = await api.chatgptCancel().catch(() => null);
    if (next) applySettings(next);
    render();
  },
  async chatgptLogout() {
    const requestId = userRequest();
    conversationEpoch++;
    session.reset();
    conversation.stop();
    try {
      const result = await api.chatgptLogout();
      applySettings(result.settings);
      dispatch({
        type: "show.settings",
        request_id: requestId,
        message: result.revoked ? "已登出 ChatGPT。" : "已在本機登出，但未確認遠端撤銷；可到 ChatGPT 設定中斷開 Nous。",
      });
    } catch (err) {
      dispatch({ type: "show.settings", request_id: requestId, message: `登出失敗：${(err as Error).message}` });
    }
    render();
  },
  async ackWelcome() {
    const next = await api.chatgptWelcomeAck().catch(() => null);
    if (next) applySettings(next);
    render();
  },
};

const PROVIDER_LABEL: Record<ExecutorMode, string> = { claude: "Claude", chatgpt: "ChatGPT", mock: "模擬模式" };

/** 切換 AI 引擎；ChatGPT 未登入時改為顯示設定並請使用者按登入（開新分頁需要使用者點擊）。 */
async function selectProvider(provider: ExecutorMode, requestId: string): Promise<void> {
  const info = settings?.providers.find((p) => p.id === provider);
  if (info && !info.available) {
    const message =
      provider === "chatgpt"
        ? "要先登入 ChatGPT：請按「Continue with ChatGPT」，在新分頁完成登入。"
        : `${info.label} 目前不可用：${info.detail}。`;
    dispatch({ type: "show.settings", request_id: requestId, message });
    say(message);
    return;
  }
  try {
    if (provider !== "chatgpt") developmentProvider = provider;
    else developmentProvider = null;
    applySettings(await api.selectProvider(provider));
    dispatch({ type: "show.settings", request_id: requestId, message: `已切換到 ${PROVIDER_LABEL[provider]}。關閉設定後按「開始語音對話」，或直接打字。` });
    say(`已切換到 ${PROVIDER_LABEL[provider]}。`);
  } catch (err) {
    const message = `無法切換：${(err as Error).message}`;
    dispatch({ type: "show.settings", request_id: requestId, message });
    say(message);
  }
  render();
}

/**
 * 開始 Sign in with ChatGPT：先在點擊當下開空白分頁（避免被擋彈出視窗），
 * 取得授權網址後再導向；登入結果由伺服器事件回報。
 */
let loginRequestId: string | null = null;

async function chatgptLogin(mode: "auto" | "new", requestId: string): Promise<void> {
  conversationEpoch++;
  session.reset();
  conversation.stop();
  loginRequestId = requestId;
  // App 內用系統瀏覽器登入（Google 等登入頁會擋內嵌視窗）。
  const desktop = window.nousDesktop;
  const popup = desktop ? null : window.open("about:blank", "_blank");
  try {
    const { authorize_url } = await api.chatgptLogin(mode);
    if (desktop) {
      desktop.openExternal(authorize_url);
      return;
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = authorize_url;
    } else {
      window.location.assign(authorize_url);
    }
  } catch (err) {
    popup?.close();
    dispatch({ type: "show.settings", request_id: requestId, message: `無法開始登入：${(err as Error).message}` });
  }
}

function showCommandError(message: string): void {
  commandError.textContent = message;
  commandError.hidden = false;
}

// ───────────── 繪製 ─────────────

function render(): void {
  const fg = shell.foreground_task_id ? tasks.get(shell.foreground_task_id) : undefined;
  const fgProgress = fg ? computeProgress(fg) : null;
  const live = realtime.current;
  const phase = live !== "off"
    ? live === "speaking" ? "speaking" : live === "thinking" || live === "connecting" ? "thinking" : "listening"
    : conversation.current === "speaking" ? "speaking"
    : session.view.reply.kind === "pending" ? "thinking"
    : conversation.on || voice.active ? "listening"
    : session.view.visible && session.view.reply.kind === "error" ? "error" : "idle";
  document.body.dataset.conversationState = phase;
  canvas.dataset.conversationState = phase;
  conversationStatus.textContent = { idle: "", listening: "正在聆聽，你可以直接說話", thinking: "正在等待回覆，你可以插話", speaking: "正在回覆，你可以直接插話", error: "對話暫時中斷，可重試或開啟設定" }[phase];
  conversationStatus.hidden = phase === "idle";
  const activity = collectRegionActivity({
    tasks: [...tasks.values()], reply: session.view.reply,
    conversationVisible: session.view.visible && shell.surface === null,
    capture: { push: voice.capturing, continuous: conversation.capturing || realtime.capturing }, playback: conversation.playing || realtime.playing,
  });
  renderRegionActivity(activity);
  brain.setState({
    activity,
    conversation: phase,
    listening: voice.capturing || conversation.capturing || realtime.capturing,
    working: [...tasks.values()].some(isActive),
    layout: shell.surface ? "top" : "center",
    progress:
      shell.mode === "working" && fgProgress?.total ? fgProgress.done / fgProgress.total : null,
  });

  document.body.dataset.mode = shell.mode;
  document.body.classList.toggle("listening", shell.listening);
  document.body.classList.toggle("has-surface", shell.surface !== null);
  form.hidden = !shell.listening;
  startConversation.hidden = conversation.on || realtime.on || shell.listening || shell.surface !== null;
  renderConversation();

  renderStatusLine();
  renderEngineLine();
  reportDesktopState();
  renderCaption(fg);
  renderSurface();
}

let reportedDesktopState = "";
/** 告訴 App 目前狀態（選單列圖示在收音時改變樣式）。 */
function reportDesktopState(): void {
  const desktop = window.nousDesktop;
  if (!desktop) return;
  const state = {
    voice: realtime.on ? realtime.current : conversation.on ? conversation.current : "off",
    activeTasks: [...tasks.values()].filter(isActive).length,
  };
  const key = JSON.stringify(state);
  if (key === reportedDesktopState) return;
  reportedDesktopState = key;
  desktop.reportState(state);
}

// App 選單列的指令。
window.addEventListener("nous:command", (event) => {
  const command = (event as CustomEvent<string>).detail;
  dismissFirstHint();
  if (command === "voice") {
    if (realtime.on || conversation.on) disableVoiceMode();
    else openConversation();
  } else if (command === "progress") actions.showProgress();
  else if (command === "settings") actions.openSettings();
  else if (command === "type") dispatch({ type: "input.open" });
});

function renderRegionActivity(activity: readonly RegionActivity[]): void {
  const ids = DOMAINS.filter((d) => activity.some((a) => a.domain === d)).join(" ");
  document.body.dataset.activeRegions = ids;
  canvas.dataset.activeRegions = ids;
  regionActivity.hidden = activity.length === 0;
  regionActivity.textContent = [...new Set(activity.map(activityDescription))].join("；");
  const topic = activity.find((a) => a.source === "topic");
  const task = activity.find((a) => a.source === "task-step" || a.source === "task-planning");
  const requestId = topic?.owner ?? (task && "requestId" in task ? task.requestId : undefined);
  regionActivity.dataset.visibilityReason = activity.length ? requestId ? "user_request" : "sensor_status" : "";
  if (requestId) regionActivity.dataset.requestId = requestId;
  else delete regionActivity.dataset.requestId;
}

function renderConversation(): void {
  const view = session.view;
  const reply = view.reply;
  const allowed = reply.kind !== "idle" && evaluateSurface({
    surface_id: `conversation_${reply.requestId}`, kind: "conversation", visibility_reason: "user_request",
    request_id: reply.requestId, task_id: null, artifact_id: null, message: null,
  }, { userRequestIds, tasks, pendingConfirmIds: new Set(pendingConfirms.keys()) }).allowed;
  conversationReply.hidden = !view.visible || !allowed || shell.surface !== null;
  document.body.classList.toggle("has-conversation", !conversationReply.hidden);
  if (reply.kind === "idle") return;
  conversationReply.dataset.requestId = reply.requestId;
  conversationReply.dataset.visibilityReason = "user_request";
  conversationReply.dataset.status = reply.kind;
  conversationUser.textContent = `你：${reply.user}`;
  const provider = settings?.provider ?? "chatgpt";
  const answer = reply.answer || (reply.kind === "pending" ? "…" : "沒有收到文字回覆。");
  conversationAnswer.textContent = `${PROVIDER_LABEL[provider]}：${answer}${reply.kind === "error" ? `\n${reply.message}` : reply.kind === "interrupted" ? "\n已打斷回覆。" : ""}`;
}

function renderStatusLine(): void {
  if (!connected) {
    statusLine.textContent = "與本機核心的連線中斷，正在重新連線…";
    statusLine.className = "status-line status-line--warn";
    statusLine.hidden = false;
  } else if (settings?.provider === "mock") {
    statusLine.textContent = "模擬模式 · 未呼叫 AI 模型";
    statusLine.title = "說「設定」可以切換到 Claude 或 ChatGPT";
    statusLine.className = "status-line status-line--mock";
    statusLine.hidden = false;
  } else {
    statusLine.hidden = true;
  }
}

/** 在輸入列下方標示目前引擎；使用 ChatGPT 方案時依指引顯示並附上管理用量連結。 */
function renderEngineLine(): void {
  if (!settings) {
    engineLine.hidden = true;
    return;
  }
  engineLine.replaceChildren();
  if (realtime.on) engineLine.append(`即時語音：OpenAI ${settings.realtime?.model ?? "Realtime"}（API key 計費）｜交辦工作：`);
  if (settings.provider === "chatgpt") {
    const link = document.createElement("a");
    link.href = CHATGPT_USAGE_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "管理用量";
    engineLine.append("使用 ChatGPT 方案 · ", link);
  } else {
    engineLine.append(`引擎：${PROVIDER_LABEL[settings.provider]} · 說「設定」可切換`);
  }
  engineLine.hidden = false;
}

function renderCaption(fg: Task | undefined): void {
  if (shell.mode !== "working" || !fg || shell.listening) {
    caption.hidden = true;
    return;
  }
  const p = computeProgress(fg);
  let detail: string;
  if (fg.status === "queued") detail = queueText(fg, tasks.values());
  else if (fg.status === "cancelling") detail = "停止中…";
  else if (p.total === null) detail = "規劃步驟中…";
  else if (p.current) {
    const chars = p.current.step.output_chars;
    detail = `步驟 ${p.current.index} / ${p.total}：${p.current.step.title}${chars ? ` · 已產生 ${formatCount(chars)} 字` : ""}`;
  } else detail = `${p.done} / ${p.total} 步完成`;

  caption.replaceChildren(
    line("caption-title", `正在處理：${fg.title}`),
    line("caption-detail", detail),
    line("caption-hint", "按 Esc 或說「收起」回到桌布，任務會在背景繼續"),
  );
  if (fg.mode === "mock") caption.prepend(line("caption-mock", "模擬"));
  caption.hidden = false;
}

function line(cls: string, text: string): HTMLElement {
  const el = document.createElement("p");
  el.className = cls;
  el.textContent = text;
  return el;
}

function renderSurface(): void {
  const s = shell.surface;
  const decision = evaluateSurface(s, { userRequestIds, tasks, pendingConfirmIds: new Set(pendingConfirms.keys()) });
  if (!s || !decision.allowed) {
    if (s && !decision.allowed) {
      console.warn("[presentation-policy] 拒絕呈現：", decision.reason, s);
      queueMicrotask(() => dispatch({ type: "dismiss" }));
    }
    if (renderedKey !== null) surfaceRoot.replaceChildren();
    renderedKey = null;
    return;
  }

  const task = s.task_id ? tasks.get(s.task_id) : undefined;
  const key =
    s.kind === "settings"
      ? `${s.surface_id}:${JSON.stringify(settings)}:${s.message ?? ""}`
      : s.kind === "progress"
      ? `${s.surface_id}:${progressStructureKey(tasks.values())}:${s.message ?? ""}`
      : s.kind === "artifact"
        ? `${s.surface_id}:${artifacts.has(s.artifact_id!)}:${artifactErrors.has(s.artifact_id!)}`
        : `${s.surface_id}:${task?.updated_at ?? ""}`;
  if (key === renderedKey) {
    updateLiveCounts(surfaceRoot, tasks);
    return;
  }

  const previous = surfaceRoot.firstElementChild as HTMLElement | null;
  const sameSurface = renderedKey?.startsWith(`${s.surface_id}:`) ?? false;
  const scrollTop = sameSurface && previous ? previous.scrollTop : 0;

  let el: HTMLElement;
  const confirm = s.kind === "confirm" ? pendingConfirms.get(s.request_id) : undefined;
  if (confirm) el = renderConfirm(confirm);
  else if (s.kind === "settings") el = renderSettings(settings, s.message, actions);
  else if (s.kind === "progress") el = renderProgress([...tasks.values()], s.message, actions);
  else if (s.kind === "artifact" && task) {
    const artifactId = s.artifact_id!;
    el = renderArtifact(task, artifacts.get(artifactId) ?? null, artifactErrors.get(artifactId) ?? null, actions);
    if (!artifacts.has(artifactId) && !artifactErrors.has(artifactId)) void loadArtifact(artifactId);
  } else if (s.kind === "error" && task) el = renderError(task, actions);
  else el = renderNotice(s.message ?? "", actions);

  if (sameSurface) el.classList.add("no-enter");
  surfaceRoot.replaceChildren(el);
  el.scrollTop = scrollTop;
  renderedKey = key;
  if (pointedZone) applyPointing();
}

async function loadArtifact(artifactId: string): Promise<void> {
  try {
    artifacts.set(artifactId, await api.getArtifact(artifactId));
  } catch (err) {
    artifactErrors.set(artifactId, err instanceof ApiError ? `無法載入成果：${err.message}` : "無法載入成果");
  }
  render();
}

setInterval(() => {
  refreshTimers(surfaceRoot);
  refreshCountdowns(surfaceRoot);
}, 1000);

// ───────────── 輸入 ─────────────

form.addEventListener("submit", (e) => {
  e.preventDefault();
  commandError.hidden = true;
  void handleCommand(input.value);
});

input.addEventListener("input", () => {
  commandError.hidden = true;
});

canvas.addEventListener("click", (e) => {
  dismissFirstHint();
  if (brain.hitTest(e.clientX, e.clientY)) openConversation();
  else if (shell.listening && !input.value.trim()) dispatch({ type: "input.close" });
});

window.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  dismissFirstHint();
  if (e.key === "Escape") {
    e.preventDefault();
    if (realtime.current === "speaking") realtime.interrupt();
    // 即時語音中有畫面（進度、成果）開著時，Esc 只關畫面，對話繼續。
    else if (realtime.on && shell.surface !== null) dispatch({ type: "dismiss" });
    else if (conversation.current === "speaking") conversation.interrupt();
    else closeConversation();
    return;
  }
  if (document.activeElement === input || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, a, summary, details")) return;
  const printable = e.key.length === 1 || e.key === "Process";
  if (!shell.listening && (printable || e.key === "Enter")) {
    if (e.key === " " || e.key === "Enter") e.preventDefault();
    dispatch({ type: "input.open" });
  }
});

function dismissFirstHint(): void {
  firstHint.classList.add("gone");
}
setTimeout(dismissFirstHint, 9000);

// ───────────── 語音（按下說話／語音模式） ─────────────

startConversation.addEventListener("click", openConversation);
$<HTMLButtonElement>("conversation-close").addEventListener("click", closeConversation);
$<HTMLButtonElement>("conversation-settings").addEventListener("click", () => dispatch({ type: "show.settings", request_id: userRequest() }));
$<HTMLButtonElement>("conversation-type").addEventListener("click", () => dispatch({ type: "input.open" }));

if (speechSupported()) {
  micButton.hidden = false;
  micButton.addEventListener("click", () => {
    commandError.hidden = true;
    if (conversation.on || realtime.on) return; // 語音模式已在收音
    if (voice.active) {
      voice.stop();
      return;
    }
    if (!hasVoiceConsent("push")) {
      askConsent("push");
      return;
    }
    voice.start();
  });
}
if (speechSupported() || realtimeSupported()) {
  voiceModeButton.hidden = false;
  voiceModeButton.addEventListener("click", () => {
    commandError.hidden = true;
    if (conversation.on || realtime.on) disableVoiceMode();
    else openConversation();
  });
}
voicePill.addEventListener("click", disableVoiceMode);
$<HTMLButtonElement>("consent-yes").addEventListener("click", () => {
  saveVoiceConsent(pendingConsent);
  consentBox.hidden = true;
  if (pendingConsent === "realtime") startRealtime();
  else if (pendingConsent === "continuous") enableVoiceMode();
  else voice.start();
});
$<HTMLButtonElement>("consent-no").addEventListener("click", () => {
  consentBox.hidden = true;
  input.focus();
});

render();
