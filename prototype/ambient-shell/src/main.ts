import "./style.css";
import { computeProgress, isActive } from "../shared/progress.ts";
import { CHATGPT_USAGE_URL, type Artifact, type ExecutorMode, type ServerEvent, type SettingsView, type Task } from "../shared/types.ts";
import { ApiError, api, newRequestId, streamChat, subscribeEvents, type ChatTurn } from "./api.ts";
import { Brain } from "./brain.ts";
import { formatCount } from "./format.ts";
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
  updateLiveCounts,
  type ViewActions,
} from "./views.ts";
import { speakFinished, speakProgress, speakSubmitted } from "./speech-text.ts";
import {
  PushToTalk,
  VoiceConversation,
  hasVoiceConsent,
  saveVoiceConsent,
  speakText,
  speechSupported,
  type ConsentKind,
  type ConversationState,
} from "./voice.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("brain");
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
    onUtterance: (text) => {
      chatAbort?.abort(); // 新的一句話取代還在產生的回覆
      chatAbort = null;
      showSubtitle(`你：${text}`);
      void handleCommand(text);
    },
    onInterim: (text) => showSubtitle(`你：${text}…`, true),
    onStateChange: renderVoiceState,
    onBargeIn: () => {
      // 使用者插話：停止念、也停止還在產生的回覆。
      chatAbort?.abort();
      chatAbort = null;
      brain.pulse("step");
    },
    onSentenceSpoken: () => brain.pulse("stream"),
    onClosed: (reason) => {
      showSubtitle(reason);
      void speakText(reason);
    },
  },
  { idleMs: VOICE_IDLE_MS },
);
let pendingConsent: ConsentKind = "push";

// 對話記錄只存在這個頁面的記憶體中，不寫檔。
const CHAT_HISTORY_LIMIT = 20;
let chatHistory: ChatTurn[] = [];
let chatAbort: AbortController | null = null;

/** 語音對話：把使用者的話送給目前的 AI 引擎，邊收邊念；需要長時間工作時由 AI 交辦成任務。 */
async function converse(text: string, requestId: string): Promise<void> {
  chatAbort?.abort();
  const controller = new AbortController();
  chatAbort = controller;
  chatHistory = [...chatHistory, { role: "user" as const, content: text }].slice(-CHAT_HISTORY_LIMIT);
  while (chatHistory[0]?.role === "assistant") chatHistory.shift();
  const reply = conversation.beginReply();
  let answer = "";
  showSubtitle("Nous：…", true);
  try {
    await streamChat(
      chatHistory,
      requestId,
      (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "delta") {
          answer += event.text;
          reply.push(event.text);
          showSubtitle(`Nous：${answer}`, true);
        } else if (event.type === "delegate") {
          void delegateTask(event.title, requestId);
        } else if (event.type === "error") {
          answer = answer || event.message;
          reply.push(event.message);
          showSubtitle(`Nous：${event.message}`);
        }
      },
      controller.signal,
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = `對話失敗：${(err as Error).message}`;
      reply.push(message);
      showSubtitle(message);
    }
  } finally {
    reply.end();
    if (chatAbort === controller) chatAbort = null;
    if (answer) {
      const content = controller.signal.aborted ? `${answer}……（被使用者打斷）` : answer;
      chatHistory = [...chatHistory, { role: "assistant" as const, content }].slice(-CHAT_HISTORY_LIMIT);
    }
    if (!controller.signal.aborted) showSubtitle(answer ? `Nous：${answer}` : "Nous：（沒有回覆）");
  }
}

/** AI 在對話中決定交辦的工作：建立背景任務並在電子腦下方顯示進度。 */
async function delegateTask(title: string, requestId: string): Promise<void> {
  try {
    const task = await api.createTask(title, requestId);
    if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
    dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
    dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
  } catch (err) {
    showSubtitle(`交辦失敗：${(err as Error).message}`);
  }
}

/** 語音模式開啟時念出回覆並顯示字幕；文字模式下不出聲。 */
function say(text: string): void {
  if (!conversation.on) return;
  showSubtitle(`Nous：${text}`);
  void conversation.speak(text);
}

let subtitleTimer: ReturnType<typeof setTimeout> | null = null;
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
  if (!speechSupported()) {
    dispatch({
      type: "show.notice",
      request_id: userRequest(),
      message: "這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge。",
    });
    return;
  }
  if (!hasVoiceConsent("continuous")) {
    askConsent("continuous");
    return;
  }
  voice.abort();
  dispatch({ type: "input.close" });
  conversation.start();
  say("語音模式已開啟，直接跟我說話就好，我說話時你也可以打斷我。");
}

function disableVoiceMode(): void {
  if (!conversation.on) return;
  chatAbort?.abort();
  chatAbort = null;
  conversation.stop();
  showSubtitle("語音模式已關閉。");
}

const CONSENT_TEXT: Record<ConsentKind, string> = {
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
  const next = reduceShell(shell, event);
  if (next === shell) return;
  const wasListening = shell.listening;
  shell = next;
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
    settings = event.settings;
    // 使用者按下的登入剛完成：切換到 ChatGPT，沿用該次點擊的請求顯示設定與說明。
    if (wasPending && !settings.chatgpt.pending_login && loginRequestId) {
      const requestId = loginRequestId;
      loginRequestId = null;
      if (settings.chatgpt.signed_in && settings.chatgpt.plan_usage && settings.provider !== "chatgpt") {
        void selectProvider("chatgpt", requestId);
      } else {
        dispatch({ type: "show.settings", request_id: requestId });
      }
      if (settings.chatgpt.signed_in) say("已登入 ChatGPT。");
    }
    render();
    return;
  }
  if (event.type === "hello") {
    settings = event.settings;
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
  // 只有前景任務結束才念；收起後的背景任務保持安靜。
  if (wasForeground && shell.mode !== "working") say(speakFinished(event.task));
  render();
}

/** 把真實狀態變化轉成光脈衝；沒有事件就沒有脈衝。 */
function firePulses(prev: Task | undefined, next: Task): void {
  if (!prev) {
    brain.pulse("submit");
    return;
  }
  if (prev.status !== next.status) {
    if (next.status === "succeeded") brain.pulse("success");
    if (next.status === "failed") brain.pulse("error");
  }
  next.steps.forEach((step, i) => {
    const before = prev.steps[i];
    if (step.status !== before?.status) {
      if (step.status === "running") brain.pulse("step");
      if (step.status === "done") brain.pulse("stepDone");
    }
    if (step.output_chars !== null && step.output_chars !== (before?.output_chars ?? null)) brain.pulse("stream");
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
  const intent = classify(text);
  if (intent.kind === "empty") {
    dispatch({ type: "input.close" });
    return;
  }
  const requestId = userRequest();
  switch (intent.kind) {
    case "voice_on":
      input.value = "";
      enableVoiceMode();
      return;
    case "voice_off":
      input.value = "";
      disableVoiceMode();
      return;
    case "settings":
      input.value = "";
      dispatch({ type: "show.settings", request_id: requestId });
      say("這是 AI 引擎設定。");
      return;
    case "use_provider":
      input.value = "";
      await selectProvider(intent.provider, requestId);
      return;
    case "dismiss":
      input.value = "";
      dispatch({ type: "dismiss" });
      say("好。");
      return;
    case "progress":
      input.value = "";
      dispatch({ type: "show.progress", request_id: requestId });
      say(speakProgress(tasks.values()));
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
      // 語音模式是對話：交給 AI 回答，需要時由 AI 自行交辦任務；文字輸入維持直接交辦。
      if (conversation.on) await converse(intent.text, requestId);
      else await submitTask(intent.text, requestId);
      return;
  }
}

async function submitTask(text: string, requestId: string): Promise<void> {
  form.classList.add("busy");
  try {
    const task = await api.createTask(text, requestId);
    if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
    input.value = "";
    dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
    // 若事件比回應先到、任務已有新狀態，立即套用。
    dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
    say(speakSubmitted(task));
  } catch (err) {
    const message = `沒有交辦成功：${(err as Error).message}`;
    if (conversation.on) say(message);
    else showCommandError(message);
  } finally {
    form.classList.remove("busy");
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
  chatgptLogin: (mode) => void chatgptLogin(mode, userRequest()),
  async chatgptCancel() {
    settings = await api.chatgptCancel().catch(() => settings);
    render();
  },
  async chatgptLogout() {
    const requestId = userRequest();
    try {
      const result = await api.chatgptLogout();
      settings = result.settings;
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
    settings = await api.chatgptWelcomeAck().catch(() => settings);
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
    settings = await api.selectProvider(provider);
    dispatch({ type: "show.settings", request_id: requestId, message: `已切換到 ${PROVIDER_LABEL[provider]}。` });
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
  loginRequestId = requestId;
  const popup = window.open("about:blank", "_blank");
  try {
    const { authorize_url } = await api.chatgptLogin(mode);
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
  brain.setState({
    listening: shell.listening || voice.active || conversation.current === "listening",
    working: [...tasks.values()].some(isActive),
    layout: shell.surface ? "top" : "center",
    progress:
      shell.mode === "working" && fgProgress?.total ? fgProgress.done / fgProgress.total : null,
  });

  document.body.dataset.mode = shell.mode;
  document.body.classList.toggle("listening", shell.listening);
  document.body.classList.toggle("has-surface", shell.surface !== null);
  form.hidden = !shell.listening;

  renderStatusLine();
  renderEngineLine();
  renderCaption(fg);
  renderSurface();
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
  if (fg.status === "queued") detail = "排隊中，等待開始";
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
  const decision = evaluateSurface(s, { userRequestIds, tasks });
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
  if (s.kind === "settings") el = renderSettings(settings, s.message, actions);
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
  if (brain.hitTest(e.clientX, e.clientY)) dispatch({ type: "input.open" });
  else if (shell.listening && !input.value.trim()) dispatch({ type: "input.close" });
});

window.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  dismissFirstHint();
  if (e.key === "Escape") {
    e.preventDefault();
    if (conversation.current === "speaking") conversation.interrupt();
    else if (shell.listening) dispatch({ type: "input.close" });
    else if (shell.surface || shell.mode === "working") dispatch({ type: "dismiss" });
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

if (speechSupported()) {
  micButton.hidden = false;
  voiceModeButton.hidden = false;
  micButton.addEventListener("click", () => {
    commandError.hidden = true;
    if (conversation.on) return; // 語音模式已在收音
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
  voiceModeButton.addEventListener("click", () => {
    commandError.hidden = true;
    if (conversation.on) disableVoiceMode();
    else enableVoiceMode();
  });
  voicePill.addEventListener("click", disableVoiceMode);
  $<HTMLButtonElement>("consent-yes").addEventListener("click", () => {
    saveVoiceConsent(pendingConsent);
    consentBox.hidden = true;
    if (pendingConsent === "continuous") enableVoiceMode();
    else voice.start();
  });
  $<HTMLButtonElement>("consent-no").addEventListener("click", () => {
    consentBox.hidden = true;
    input.focus();
  });
}

render();
