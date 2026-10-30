import { t, msg, getLocale, setLocale, onLocaleChange, transcriptText, applyStaticTranslations, type Locale } from "./i18n.ts";
import "./style.css";
import { computeProgress, isActive, queueText, sortForProgress } from "../shared/progress.ts";
import { CHATGPT_USAGE_URL, type Artifact, type ExecutorMode, type ServerEvent, type SettingsView, type Task } from "../shared/types.ts";
import { ApiError, api, newRequestId, streamChat, subscribeEvents, type HomeControlArgs, type RealtimeTicket } from "./api.ts";
import { ConversationSession } from "./conversation.ts";
import { cameraShouldRun, matchCameraCommand, SenseController, zoneOf } from "./sense/controller.ts";
import type { PreviewTargets, SensePipeline } from "./sense/pipeline.ts";
import { DEFAULT_CAMERA_PREFS, type CameraPrefsPatch, type PointZone, type SensorState } from "../shared/sense.ts";
import { formatSeconds } from "../shared/prefs.ts";
import { DEFAULT_VOICE_PREFS, idleTimeoutsMs, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import {
  browserRealtimeDeps,
  realtimeSupported,
  RealtimeVoice,
  type ApprovalOutcome,
  type ApprovalRequest,
  type HomeResult,
  type RealtimeCallbacks,
  type RealtimePhase,
} from "./realtime.ts";
import { browserWatchLevel, LiveVoice, orphanStopReport } from "./live-voice.ts";
import { greetingFor, idleSession, newInteractionId, openRealtime, type GreetingOnce, type RealtimeSession, type RealtimeStartSource, type SessionDecision } from "./realtime-session.ts";
import type { CallAnswer, LiveCoreEvent, LiveMemoryReason, RealtimeServerEvent, RouteId } from "../shared/realtime-route.ts";
import { Brain } from "./brain.ts";
import { classifyDomain, DOMAINS, isDomain } from "../shared/domain.ts";
import { activityDescription, collectRegionActivity, type RegionActivity } from "./region-activity.ts";
import { formatCount } from "./format.ts";
import { homeControlLine, homeStatusLine } from "../shared/home.ts";
import { classify, settingsReply } from "./intent.ts";
import { runDesktopCommand } from "./desktop-command.ts";
import { FamilyView } from "./family-view.ts";
import { HistoryView } from "./history-view.ts";
import { ProtectedTasks, vaultNotice } from "./protected-tasks.ts";
import type { TasksRequest, TasksResponse, VaultView } from "../shared/protected-tasks.ts";
import { MemoryView, MEMORY_BROWSER_UNAVAILABLE, memoryText, presenceLabel, receiptsText } from "./memory-view.ts";
import type { MemoryPresenceView, MemoryRequest, MemoryResponse, MemoryStatusView, MemoryTurnView } from "../shared/memory.ts";
import { IdentityClient, type WorkerLike } from "./sense/identity-client.ts";
import { AmbientIdentity } from "./sense/identity-ambient.ts";
import { LookTimeline } from "./look-timeline.ts";
import type { IdentityRequest, IdentityResponse } from "../shared/identity.ts";
import faceRuntime from "../shared/face-runtime.json" with { type: "json" };
import { evaluateSurface } from "./presentation-policy.ts";
import { blocksAutoTalk, initialShell, reduceShell, type ShellEvent, type ShellState } from "./shell-state.ts";
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
  speakText,
  speechSupported,
  type ConsentKind,
  type ConversationState,
} from "./voice.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** macOS App（Electron）的 preload 提供；在一般瀏覽器裡不存在。 */
interface DesktopBridge {
  readonly initialLocale?: Locale;
  onLocaleChange?(listener: (locale: Locale) => void): () => void;
  openExternal(url: string): void;
  /** settings：設定的版本字串；變了 App 就重新讀取設定，選單列不會留著舊的「（目前）」。 */
  reportState(state: { voice: string; activeTasks: number; settings: string; locale: Locale }): void;
  /** 家人辨識（只經 IPC 到 App 的核心；不走 HTTP）。舊版 App 沒有這一項。 */
  identity?(request: IdentityRequest): Promise<IdentityResponse>;
  /** 家庭記憶（docs/16 MEM-1；只經 IPC 到 App 的核心）。舊版 App 與瀏覽器版沒有這一項。 */
  memory?(request: MemoryRequest): Promise<MemoryResponse>;
  /** 本次人物世代改變的通知（不含內容）。 */
  onMemoryChange?(listener: () => void): () => void;
  /** MEM-4a：加密保存的任務（真實標題、成果、App 內搜尋、重做、刪除明文備份）；只經 IPC。舊版 App 與瀏覽器版沒有這一項。 */
  tasks?(request: TasksRequest): Promise<TasksResponse>;
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
const conversationPerson = $<HTMLParagraphElement>("conversation-person");
const conversationNotice = $<HTMLParagraphElement>("conversation-notice");
const memoryLine = $<HTMLParagraphElement>("memory-line");
const memoryPersonLabel = $<HTMLLabelElement>("memory-person-label");
const memoryPerson = $<HTMLSelectElement>("memory-person");
/** 記憶的本次人物（核心回的；只在輸入列與對話 Surface 顯示，不建常駐側欄）。 */
let memoryPresence: MemoryPresenceView | null = null;
let memoryProfiles: { id: string; name: string }[] = [];
/** 帶記憶的一輪想交辦：在對話 Surface 裡問「要交辦這件事嗎？」（標題是使用者原句）。 */
let pendingDelegate: { title: string; requestId: string } | null = null;
/** turn 的原句（卡片處理完後，純記憶指令的回條要配這一句顯示）。 */
const memoryTurnText = new Map<string, string>();
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
/** applySettings 收到不同的設定就加一；連同每次載入頁面不同的 pageLoadId 回報給 App（重新整理後版本重算也不會撞號）。 */
let settingsRevision = 0;
const pageLoadId = Math.random().toString(36).slice(2, 10);
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
    // 語音來源：不經記憶 IPC、不送 memory_turn（即時語音的記憶見 MEM-2；按下說話與語音模式要等 MEM-3）。
    void handleCommand(text, "speech");
  },
  onListeningChange: (listening) => {
    micIndicator.hidden = !listening;
    micButton.classList.toggle("recording", listening);
    micButton.setAttribute("aria-label", t(listening ? "停止收音" : "按下開始說話"));
    render();
  },
  onError: showCommandError,
});

/** 語音閒置秒數（voice.json，選單列或設定畫面可改）；收到核心的設定前用預設值。 */
function voicePrefs(): VoicePrefs {
  return settings?.voice ?? DEFAULT_VOICE_PREFS;
}

// 連續語音對話模式：開啟後不用按鍵，說完一句就處理一句，並用語音簡短回覆。
const conversation = new VoiceConversation(
  {
    onCaptureChange: () => render(),
    onPlaybackChange: () => render(),
    onUtterance: (text) => {
      session.interrupt();
      showTranscript("user", text);
      void handleCommand(text, "speech");
    },
    onInterim: (text) => showTranscript("user", text, true, true),
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
  { idleMs: idleTimeoutsMs(undefined).voice_mode },
);
let pendingConsent: ConsentKind = "push";

// 即時語音模式：「開始語音對話」改用語音直接對語音。兩條路徑：ChatGPT 方案（Codex 登入，gpt-live-1-codex）
// 與 OpenAI API key（gpt-realtime）。路徑在開始時由本機核心決定（/api/realtime/start），之後不中途換。
/** 即時語音中交辦的任務：完成時請模型用語音轉告。 */
const realtimeTaskIds = new Set<string>();
/** 兩條路徑共用的 callbacks（工具、字幕、確認卡、腦區光脈衝都在這裡）：只建一次。 */
const realtimeCallbacks: RealtimeCallbacks = {
  onPhase: renderRealtimeState,
  onUserTranscript: (text) => {
    showTranscript("user", text);
    handleCameraCommand(text);
  },
  onAssistantTranscript: (text) => showTranscript("assistant", text),
  onDelegate: delegateFromRealtime,
  // MEM-4a：App 裡由核心依這條路徑的記憶同意給真實標題或外殼（George 2026-10-30）；瀏覽器版照舊。
  onGetTasks: async () => ({ ok: true, tasks: protectedTasks.available ? taskSummary(await protectedTasks.voiceTasks(realtimeTicket?.route === "live" ? "live" : "api_key")) : taskSummary() }),
  onWebSearch: webSearchFromRealtime,
  onHomeStatus: homeStatusFromRealtime,
  onHomeControl: homeControlFromRealtime,
  onHomeConfirm: homeConfirmFromRealtime,
  onApprovalPrompt: showApproval,
  onApprovalResolved: closeApproval,
  onToolActivity: (text) => showSubtitle(text),
  onClosed: (reason) => {
    ambient.endInteraction();
    endRealtimeTicket();
    sense.conversationEnded();
    showSubtitle(reason);
    dispatch({ type: "input.open" });
    showCommandError(reason);
  },
};
/** 還沒開始過時是閒置物件，載入時讀 on／current 都安全。 */
let realtime: RealtimeSession = idleSession();
/** 這次工作階段的路徑、計費與擁有者憑證（只在這個頁面）。 */
let realtimeTicket: SessionDecision | null = null;
let realtimeStarting = false;
let realtimeLocale: Locale = getLocale();
/** 進行中的開始流程；stopRealtime 中止它，之後的 await 回來時不會再開麥克風。 */
let realtimeStart: AbortController | null = null;
/** 這個頁面的 SSE 串流 ID（hello 帶來）；開始 ChatGPT 方案路徑時交給核心。 */
let sseClientId: string | null = null;
const liveListeners = new Set<(event: RealtimeServerEvent) => void>();
let liveAudio: HTMLAudioElement | null = null;
/** MEM-2：最後一個即時語音播放元素拆掉時是不是已暫停（停播核對用；MEM-3 起兩條路徑共用）。 */
let liveAudioPaused = true;
/** MEM-2：這通即時語音通話的記憶狀態（只有筆數與原因代碼；人物名稱來自 IPC 的 memoryPresence）。MEM-3 起兩條路徑共用。 */
let liveMemory: { used: number; reason: LiveMemoryReason | null } | null = null;
/** MEM-3：這通 API key 通話由核心處理、頁面略過的工具（POST /api/realtime/call 的回應帶來）。 */
let realtimeCoreTools: readonly string[] = [];
/** MEM-2：這個頁面開過的工作階段憑證（結束後收到記憶撤銷時仍要回報停播；MEM-3 起兩條路徑都記）。 */
const liveTickets = new Map<string, RealtimeTicket>();
/** 「這次沒有用到記憶：…尚未允許」每條路徑每次執行只說一次。 */
const consentNoticeShown = new Set<RouteId>();

/** MEM-3：沒有同意、沒有帳號時的原因依路徑不同（同意對象與帳號不同）。 */
const ROUTE_MEMORY_REASON: Record<RouteId, Partial<Record<LiveMemoryReason, string>>> = {
  live: {},
  api_key: {
    no_consent: "未用記憶（OpenAI API key 即時語音尚未允許）",
    no_account: "未用記憶（沒有設定 OPENAI_API_KEY）",
  },
};
const CONSENT_NOTICE: Record<RouteId, string> = {
  live: "這次沒有用到記憶：ChatGPT 方案即時語音尚未允許",
  api_key: "這次沒有用到記憶：OpenAI API key 即時語音尚未允許",
};
/**
 * 記憶沒設定或已關閉：狀態列什麼都不顯示（和 MEM-2 的 live 一樣）。記憶不可用（unavailable）照實顯示「未用記憶（記憶目前不可用）」，
 * 不說成「此路徑未啟用記憶」。
 */
const QUIET_MEMORY_REASONS: ReadonlySet<LiveMemoryReason> = new Set(["not_setup", "disabled"]);

function memoryReasonText(route: RouteId, reason: LiveMemoryReason): string {
  return ROUTE_MEMORY_REASON[route][reason] ?? LIVE_MEMORY_REASON[reason];
}

/** MEM-2：即時語音通話沒有用到記憶的原因（固定句，頁面翻譯）。 */
const LIVE_MEMORY_REASON: Record<LiveMemoryReason, string> = {
  not_setup: "未用記憶（記憶尚未設定）",
  disabled: "未用記憶（記憶已關閉）",
  unavailable: "未用記憶（記憶目前不可用）",
  no_consent: "未用記憶（ChatGPT 方案即時語音尚未允許）",
  no_account: "未用記憶（沒有 ChatGPT 方案登入）",
  route_disabled: "未用記憶（這次執行期間已停用）",
  waiting_candidate: "未用記憶（等你確認本次人物）",
  no_pinned: "未用記憶（沒有釘選的記憶；需要時才查）",
  route_off: "此路徑未啟用記憶",
  no_control: "未用記憶（接不上核心的控制連線，這通不帶記憶）",
  busy: "未用記憶（另一通即時語音正在使用記憶）",
};

/** MEM-2：live 通話的記憶事件。SSE 只帶卡片 ID、筆數與固定句；卡片內容經 IPC card_view 取得。 */
function onLiveMemoryEvent(event: Extract<LiveCoreEvent, { kind: "memory" | "memory_card" | "memory_notice" | "delegate_blocked" }>): void {
  switch (event.kind) {
    case "memory":
      liveMemory = { used: event.used, reason: event.reason };
      noteConsentNotice(event.reason);
      render();
      break;
    case "memory_card":
      if (!event.open) {
        if (memoryView.showing(event.card) && shell.surface?.kind === "memory") dispatch({ type: "dismiss" });
        break;
      }
      void memoryView.showLiveCard(event.card).then((shown) => { if (shown) dispatch({ type: "show.memory", request_id: userRequest() }); });
      break;
    case "memory_notice":
      showSubtitle(t(event.message));
      break;
    case "delegate_blocked": {
      const title = event.title;
      memoryView.showDelegate(title, () => void delegateDirect(title));
      dispatch({ type: "show.memory", request_id: userRequest() });
      break;
    }
  }
}

/** 沒有同意：每條路徑每次執行只說一次。 */
function noteConsentNotice(reason: LiveMemoryReason | null): void {
  const route = realtimeTicket?.route ?? "live";
  if (reason !== "no_consent" || consentNoticeShown.has(route)) return;
  consentNoticeShown.add(route);
  showSubtitle(t(CONSENT_NOTICE[route]));
}

/**
 * MEM-2：記憶撤銷後頁面已停播並回報：清掉字幕、逐字稿畫面、交辦卡與記憶卡，顯示原因（不念）。
 * rebuild：自動開一通新的（核心走被撤銷那通的路徑、不問候；第一句是固定句：live 由核心送，API key 由頁面送）。
 */
function onLiveRevoked(message: string, rebuild: boolean, accepted: boolean): void {
  liveMemory = null;
  pendingDelegate = null;
  ambient.endInteraction();
  endRealtimeTicket();
  if (shell.surface?.kind === "memory") dispatch({ type: "dismiss" });
  hideSubtitle();
  showSubtitle(t(message), true);
  // 停播回報沒被採用：不重建（核心逾時後會強制靜音並另外通知），避免和強制靜音、停用路徑互相競爭。
  if (rebuild && accepted) startRealtime("user", { rebuild: true });
  else {
    sense.conversationEnded();
    dispatch({ type: "input.open" });
  }
  render();
}

function ticketOf(decision: SessionDecision): RealtimeTicket {
  return { session_id: decision.session_id, owner: decision.owner };
}

/** API key 路徑的工作階段結束時告訴核心（設定畫面的「進行中」才會清掉）；live 由 LiveVoice 自己結束。 */
function endRealtimeTicket(): void {
  const ticket = realtimeTicket;
  realtimeTicket = null;
  if (ticket?.route === "api_key") void api.realtimeEnd(ticketOf(ticket)).catch(() => undefined);
  render();
}

function stopRealtime(): void {
  ambient.endInteraction();
  realtimeStart?.abort();
  realtimeStart = null;
  realtimeStarting = false;
  realtime.stop();
  endRealtimeTicket();
}

function makeRealtimeSession(decision: SessionDecision, greeting: GreetingOnce | null, rebuild = false): RealtimeSession {
  const next = createRealtimeSession(decision, greeting, rebuild);
  // 和其他計時器一樣：建構時用預設值，再套用目前的設定（applySettings 之後的改動也走 setIdleMs）。
  next.setIdleMs(idleTimeoutsMs(settings?.voice).realtime);
  return next;
}

/** 播放遠端聲音並記下播放元素（MEM-2 停播核對、靜音；MEM-3 起兩條路徑共用）。 */
function trackedPlayRemote(stream: MediaStream): () => void {
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream;
  liveAudio = audio;
  liveAudioPaused = false;
  void audio.play().catch(() => {});
  return () => {
    // MEM-2：先靜音再暫停、拿掉來源（停播核對要看 paused）。
    audio.muted = true;
    audio.pause();
    audio.srcObject = null;
    liveAudioPaused = audio.paused;
    if (liveAudio === audio) liveAudio = null;
  };
}

/** 只收這個工作階段的 SSE realtime.host／realtime.live（兩條路徑共用）。 */
function subscribeSession(sessionId: string, handlers: { host(call: Extract<RealtimeServerEvent, { type: "realtime.host" }>["call"]): void; core(event: LiveCoreEvent): void }): () => void {
  const listener = (event: RealtimeServerEvent) => {
    if (event.session_id !== sessionId) return;
    if (event.type === "realtime.host") handlers.host(event.call);
    else handlers.core(event.event);
  };
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

function createRealtimeSession(decision: SessionDecision, greeting: GreetingOnce | null, rebuild = false): RealtimeSession {
  const ticket = ticketOf(decision);
  if (decision.route === "api_key") {
    // MEM-3：/call 的回應帶這通的記憶狀態與核心處理的工具（沒有記憶層時為 null 與空陣列，行為和 MEM-2 之前一樣）。
    realtimeCoreTools = [];
    const base = browserRealtimeDeps(async (sdp) => {
      // 帶 ticket 的呼叫一定是 CallAnswer；舊的核心沒有 core_tools／memory 欄位時當成沒有。
      const answer = (await api.realtimeCall(sdp, ticket)) as Partial<CallAnswer> & { sdp: string };
      realtimeCoreTools = answer.core_tools ?? [];
      const status = answer.memory ?? null;
      liveMemory = status && !(status.reason && QUIET_MEMORY_REASONS.has(status.reason)) ? status : null;
      noteConsentNotice(status?.reason ?? null);
      render();
      return answer.sdp;
    });
    return new RealtimeVoice(realtimeCallbacks, {
      ...base,
      playRemote: trackedPlayRemote,
      core: {
        subscribe: (handlers) => subscribeSession(ticket.session_id, handlers),
        hostResult: async (callId, output) => void (await api.realtimeHostResult(ticket, callId, output)),
        approval: async (report) => void (await api.realtimeApproval(ticket, report)),
        stopped: async (evidence) => (await api.realtimeStopped(ticket, evidence)).accepted,
        playback: async () => void (await api.realtimePlayback(ticket)),
        setMuted: (muted) => {
          if (liveAudio) liveAudio.muted = muted;
        },
        audioPaused: () => liveAudioPaused && (!liveAudio || liveAudio.paused),
        cancelSpeech: () => {
          try { globalThis.speechSynthesis?.cancel(); } catch { /* 沒有語音合成 */ }
        },
        speak: (text) => void speakText(text, { locale: realtimeLocale }).catch(() => undefined),
        memoryEvent: onLiveMemoryEvent,
        revoked: onLiveRevoked,
        coreTools: () => realtimeCoreTools,
      },
    }, { idleMs: idleTimeoutsMs(undefined).realtime, greeting, rebuild, rebuildLine: t("好，已經更新了。") });
  }
  const base = browserRealtimeDeps(async (sdp) => (await api.realtimeCall(sdp, ticket)).sdp);
  return new LiveVoice(
    realtimeCallbacks,
    {
      getMicrophone: base.getMicrophone,
      createPeer: base.createPeer,
      playRemote: trackedPlayRemote,
      exchange: base.exchange,
      input: async (kind, text) => void (await api.realtimeInput(ticket, kind, text)),
      hostResult: async (callId, output) => void (await api.realtimeHostResult(ticket, callId, output)),
      approval: async (report) => void (await api.realtimeApproval(ticket, report)),
      end: async () => void (await api.realtimeEnd(ticket)),
      subscribe: (handlers) => subscribeSession(ticket.session_id, handlers),
      watchLevel: browserWatchLevel,
      setMuted: (muted) => {
        if (liveAudio) liveAudio.muted = muted;
      },
      speak: (text) => void speakText(text, { locale: realtimeLocale }).catch(() => undefined),
      stopped: async (evidence) => (await api.realtimeStopped(ticket, evidence)).accepted,
      audioPaused: () => liveAudioPaused && (!liveAudio || liveAudio.paused),
      cancelSpeech: () => {
        try { globalThis.speechSynthesis?.cancel(); } catch { /* 沒有語音合成 */ }
      },
      memoryEvent: onLiveMemoryEvent,
      revoked: onLiveRevoked,
    },
    { idleMs: idleTimeoutsMs(undefined).realtime, greeting },
  );
}

/** 說出並顯示計費通知；語音合成卡住時最多等 8 秒，再開麥克風。 */
async function announceRealtime(notice: string): Promise<void> {
  showSubtitle(notice, true);
  await Promise.race([speakText(notice, { locale: realtimeLocale }).catch(() => undefined), new Promise((r) => setTimeout(r, 8_000))]);
}

const session = new ConversationSession({
  stream: streamChat,
  output: () => {
    const reply = conversation.beginReply();
    return { push: (text) => reply.push(text), end: () => reply.end(), cancel: () => reply.cancel() };
  },
  activity: (kind, _requestId, text) => brain.pulse(kind, classifyDomain(text)),
  changed: () => render(),
  delegated: (title, requestId, locale) => void delegateTask(title, requestId, locale),
  // MEM-4a：核心已建立受保護交辦的任務（標題是使用者原句；畫面經 IPC 讀回真實標題）。
  delegatedTask: (task, requestId) => {
    if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
    protectedTasks.noteUpdate(task);
    dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
    dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
  },
  // 帶記憶的一輪不自動交辦（docs/16 §9、M15）：出卡片問使用者，標題用使用者原句。
  delegateBlocked: (title, requestId) => {
    pendingDelegate = { title, requestId };
    render();
  },
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
  if (!settings || JSON.stringify(settings) !== JSON.stringify(value)) settingsRevision++;
  settings = value;
  // 只有值真的改變、而且語音正開著時才從現在重新倒數（setIdleMs 內判斷）；無關的設定更新不延長倒數。
  const idle = idleTimeoutsMs(value.voice);
  conversation.setIdleMs(idle.voice_mode);
  realtime.setIdleMs(idle.realtime);
  if (value.camera && !value.camera.active) cameraOffPending = false; // 伺服器已保存「關掉」
  if (value.camera && wasActive !== undefined && value.camera.active !== wasActive) cameraFailed = false;
  syncCamera();
  // 設定或家人辨識狀態改變：看著說話時的同步辨識重新向核心確認（不中斷正在進行的取樣）。
  ambient.refresh();
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

/**
 * 一般聊天。桌面版的打字來源先經記憶 IPC（turn）：核心解析「記住／更正／忘記／我是 X」，回回條、卡片與要送的聊天文字，
 * 以及一次性的 memory_turn；/api/chat 帶它，核心才取用記憶。語音來源與瀏覽器版不經記憶（不送 memory_turn）。
 */
async function converse(text: string, requestId: string, source: "typed" | "speech" = "typed"): Promise<void> {
  const requestLocale = conversation.on ? conversation.locale : getLocale();
  const epoch = ++conversationEpoch;
  try {
    const bridge = window.nousDesktop?.memory;
    if (bridge && source === "typed") {
      // 先經記憶：純記憶指令（「記住…」「我是 X」）不需要先登入任何模型服務；要送聊天時才 prepareConversation。
      input.value = "";
      const res = await bridge({ op: "turn", text, request_id: requestId });
      if (epoch !== conversationEpoch) return;
      if (res.ok && res.op === "turn") {
        applyMemoryTurn(res, text, requestId, requestLocale);
        return;
      }
      // 記憶 IPC 失敗：一般聊天照常，照實說這次沒有用到記憶。
      if (!await sendChat(text, requestId, requestLocale, null, epoch)) return;
      showSubtitle(t("記憶目前不可用；這次沒有用到記憶"));
      return;
    }
    if (!await prepareConversation(requestId, epoch) || epoch !== conversationEpoch) return;
    input.value = "";
    dispatch({ type: "dismiss" });
    hideSubtitle();
    await session.send(text, requestId, requestLocale);
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    dispatch({ type: "input.open" });
    showCommandError(error instanceof Error ? error.message : "無法開始對話。");
  }
}

/** 核心的 turn 結果：本次人物、回條、卡片或要送的聊天（帶 memory_turn）。卡片在時先處理卡片，問題稍後再送。 */
function applyMemoryTurn(view: MemoryTurnView & { status?: MemoryStatusView }, userText: string, requestId: string, locale: Locale): void {
  memoryTurnText.set(requestId, userText);
  if (memoryTurnText.size > 32) memoryTurnText.delete(memoryTurnText.keys().next().value!);
  setMemoryPresence(view.presence, view.status?.profiles.map(p => ({ id: p.id, name: p.name })));
  if (view.history_reset) session.forgetMemoryHistory();
  if (view.card) {
    memoryView.showCard(view.card, requestId, view.chat, view.status ?? null);
    dispatch({ type: "show.memory", request_id: requestId });
    return;
  }
  const receipts = receiptsText(view.receipts);
  const notice = memoryText(view.notice);
  if (view.chat) {
    const extra = [receipts, notice].filter(Boolean).join("\n");
    void sendChat(view.chat.text, requestId, locale, view.chat.memory_turn, conversationEpoch).then((sent) => { if (sent && extra) showSubtitle(extra, true); });
    return;
  }
  dispatch({ type: "dismiss" });
  hideSubtitle();
  // 只有記憶指令：核心的固定回條就是這一輪的回覆（不呼叫模型）。
  session.local(userText, requestId, receipts || notice || t("沒有需要保存的內容。"));
}

/** 送一般聊天（需要時先準備模型服務）；epoch 已換（使用者又做了別的事）就不送。回傳是否送出。 */
async function sendChat(text: string, requestId: string, locale: Locale, memoryTurn: string | null, epoch: number): Promise<boolean> {
  if (!await prepareConversation(requestId, epoch) || epoch !== conversationEpoch) return false;
  dispatch({ type: "dismiss" });
  hideSubtitle();
  await session.send(text, requestId, locale, memoryTurn);
  return true;
}

/**
 * 本次人物世代改變（換人、暫停、OS 鎖定、閒置、刪除家人、更正、忘記）：用過記憶的對話歷史清空，標示更新。
 * 核心的 turn 回應與主程序推來的通知都會帶新的世代。
 */
function setMemoryPresence(presence: MemoryPresenceView | null, profiles?: { id: string; name: string }[]): void {
  if (presence && memoryPresence && presence.epoch !== memoryPresence.epoch) {
    session.forgetMemoryHistory(true);
    pendingDelegate = null;
  }
  memoryPresence = presence;
  if (profiles) memoryProfiles = profiles;
  render();
}

/** 讀本次人物（status 不開記憶檔、不碰 Keychain）；記憶沒開時不顯示標示，但仍追蹤世代。 */
async function refreshMemoryStatus(): Promise<void> {
  const bridge = window.nousDesktop?.memory;
  if (!bridge) return;
  const res = await bridge({ op: "status" });
  if (!res.ok || res.op !== "status") return;
  setMemoryPresence(res.presence, res.state === "ready" ? res.profiles.map(p => ({ id: p.id, name: p.name })) : undefined);
}
window.nousDesktop?.onMemoryChange?.(() => void refreshMemoryStatus());

function closeConversation(): void {
  conversationEpoch++;
  session.dismiss();
  conversation.stop();
  stopRealtime();
  voice.abort();
  hideSubtitle();
  dispatch({ type: "dismiss" });
  render();
}

function openConversation(): void {
  dismissFirstHint();
  if (realtimeReady()) {
    startRealtime("user");
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
async function delegateTask(title: string, requestId: string, locale: Locale = getLocale()): Promise<void> {
  const epoch = conversationEpoch;
  const stillCurrent = () => {
    const { reply, visible } = session.view;
    return epoch === conversationEpoch && visible
      && (reply.kind === "pending" || reply.kind === "complete") && reply.requestId === requestId;
  };
  try {
    const task = await api.createTask(title, requestId, locale);
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
  showAuthoredSpeech(text);
  void conversation.speak(t(text));
}

type SubtitleSource = { kind: "message" | "authoredSpeech"; text: string } | { kind: "transcript"; speaker: "user" | "assistant"; text: string; interim: boolean };
let subtitleSource: SubtitleSource = { kind: "message", text: "" };
let commandErrorSource = "";
let subtitleTimer: ReturnType<typeof setTimeout> | null = null;
function hideSubtitle(): void {
  if (subtitleTimer) clearTimeout(subtitleTimer);
  subtitleTimer = null;
  subtitle.hidden = true;
}

function renderSubtitle(): void {
  const source = subtitleSource;
  subtitle.textContent = source.kind === "transcript" ? transcriptText(source.speaker, source.text, source.interim)
    : source.kind === "authoredSpeech" ? transcriptText("assistant", t(source.text)) : t(source.text);
}

function showTranscript(speaker: "user" | "assistant", text: string, sticky = false, interim = false): void {
  subtitleSource = { kind: "transcript", speaker, text, interim };
  presentSubtitle(sticky);
}

function showAuthoredSpeech(text: string): void {
  subtitleSource = { kind: "authoredSpeech", text };
  presentSubtitle(false);
}

function showSubtitle(text: string, sticky = false): void {
  subtitleSource = { kind: "message", text };
  presentSubtitle(sticky);
}

function presentSubtitle(sticky: boolean): void {
  renderSubtitle();
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
  voicePill.textContent = msg`${t(VOICE_STATE_LABEL[state])}（點此關閉）`;
  voicePill.dataset.state = state;
  voiceModeButton.classList.toggle("recording", state !== "off");
  voiceModeButton.setAttribute("aria-label", state === "off" ? t("開啟語音對話模式") : t("關閉語音對話模式"));
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
let sensorDetail = "";
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
previewClose.setAttribute("aria-label", t("收起鏡頭畫面"));
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
  stale.dataset.i18n = "影像中斷";
  stale.textContent = t("影像中斷");
  const text = document.createElement("figcaption");
  text.dataset.i18n = label;
  text.textContent = t(label);
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

/** 家人辨識的推論 worker（ID-01 畫面與 ID-02 看著說話共用同一個檔案；各自建立、各自結束）。 */
function createIdentityWorker(): WorkerLike {
  return new Worker(new URL("./sense/identity-worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

/**
 * 看著說話時同步辨識（docs/14 ID-02）：只有 macOS App、三個設定（看著說話、打招呼、稱名）都開、settings.identity 可用而且
 * 沒有限制、家人辨識畫面沒開時才啟用。只在面向停留期間與問候決策前取樣；不延長看著說話的秒數。
 */
function ambientEnabled(): boolean {
  const cam = settings?.camera;
  const id = settings?.identity;
  return !!window.nousDesktop?.identity && !!cam?.enabled && cam.active && cam.look_to_talk && cam.look_to_talk_greet && cam.look_to_talk_greet_name
    && !!id?.available && !id.limited_reason && !blocksAutoTalk(shell.surface);
}

/** 看著說話問候的時序（只有相對毫秒，印到 DevTools console；Mac 實測用）。 */
const lookTimeline = new LookTimeline(() => performance.now(), (line) => console.info(line));

const ambient = new AmbientIdentity({
  bridge: window.nousDesktop?.identity ? { identity: (request) => window.nousDesktop!.identity!(request) } : null,
  enabled: ambientEnabled,
  createSampler: (onFrame, onState) =>
    new IdentityClient({ source: { sampleFrame: () => pipeline?.sampleFrame() ?? Promise.resolve(null) }, createWorker: createIdentityWorker, onFrame, onState }),
  model: faceRuntime.model_version,
  now: () => performance.now(),
  // 記憶的互動結束：人離開鏡頭或多人入鏡時暫停本次人物（只能降權）。
  onPresenceBreak: (reason) => void window.nousDesktop?.memory?.({ op: "suspend", reason }).then((res) => { if (res.ok && res.op === "suspend") setMemoryPresence(res.presence); }),
});

const sense = new SenseController({
  now: () => performance.now(),
  isTalking: () => realtime.on || conversation.current !== "off",
  // 家人辨識畫面開著時不自動開始對話：startRealtime 會收起畫面，打斷登記或試認。
  canAutoTalk: () => !blocksAutoTalk(shell.surface) && !!settings?.realtime?.available && realtimeSupported() && hasVoiceConsent("realtime"),
  prefs: () => settings?.camera ?? DEFAULT_CAMERA_PREFS,
  // 看著說話開始的對話：連上後依「看著說話時先打招呼」請模型先打一次招呼。
  startTalk: () => startRealtime("look_to_talk"),
  // 同步辨識只讀感知狀態，決定取樣與追蹤世代；看著說話的計時不看它。
  onSense: (snapshot) => ambient.update(snapshot),
  interruptSpeech: () => {
    if (realtime.current === "speaking") realtime.interrupt();
    else if (conversation.current === "speaking") conversation.interrupt();
  },
  onLeave: () => {
    // 人離開：待確認的外部動作不執行、收起畫面、結束即時語音（避免對空房間持續計費）。
    if (realtime.pendingApproval) realtime.resolveApproval(false, "dismissed");
    if (shell.surface) dispatch({ type: "dismiss" });
    if (realtime.on || realtimeStarting) stopRealtime();
    closePreview();
  },
  setScale: (scale) => {
    // 字級與內容面板（docs/10 §2：遠一點放大）；電子腦只有頂端縮略圖跟著它。
    document.documentElement.style.setProperty("--distance-scale", String(scale));
    brain.setDistanceScale(scale);
  },
  // 待機的電子腦靠近時放大（設定「靠近時電子腦放大倍率」）。
  setBrainZoom: (factor) => {
    document.body.dataset.brainZoom = String(factor);
    brain.setProximityZoom(factor);
  },
  setPresence: (present) => {
    document.body.dataset.present = present ? "yes" : "no";
    if (present) lookTimeline.mark("present");
  },
  setFacing: (facing) => {
    document.body.dataset.facing = facing ? "yes" : "no";
    if (facing) lookTimeline.mark("facing");
  },
  pointTo: (zone) => {
    pointedZone = zone;
    applyPointing();
  },
  setSensor: (state: SensorState, detail: string) => {
    sensorState = state;
    sensorDetail = detail;
    sensorIndicator.hidden = state === "off";
    sensorIndicator.dataset.state = state;
    sensorIndicator.title = t("{0}（按一下顯示／收起鏡頭畫面）", t(detail));
    sensorIndicator.textContent = state === "ok" ? t("鏡頭") : state === "starting" ? t("鏡頭啟動中") : t("鏡頭：{0}", t(detail));
    sensorPreview.dataset.state = state;
    if (state === "off" || state === "error" || state === "starting") closePreview();
    if (state === "error") {
      cameraFailed = true;
      showSubtitle(detail);
    }
  },
});
setInterval(() => sense.tick(), 200);

// 家人辨識（docs/14 ID-01）：只由選單列打開；畫面收起時停止取樣、丟掉記憶體中的樣本與 session。
const familyView = new FamilyView({
  bridge: window.nousDesktop?.identity ? { identity: (request) => window.nousDesktop!.identity!(request) } : null,
  source: { sampleFrame: () => pipeline?.sampleFrame() ?? Promise.resolve(null) },
  createWorker: createIdentityWorker,
  model: faceRuntime.model_version,
  dismiss: () => dispatch({ type: "dismiss" }),
});

const memoryView = new MemoryView({
  bridge: window.nousDesktop?.memory ? { memory: (request) => window.nousDesktop!.memory!(request) } : null,
  dismiss: () => dispatch({ type: "dismiss" }),
  resolved: (view, requestId) => applyMemoryTurn(view, memoryTurnText.get(requestId) ?? "", requestId, getLocale()),
  // MEM-2：即時語音的卡：回條只顯示（模型已經聽到了，不經 /api/chat 續送），語音的固定回條由核心送。
  liveResolved: (view) => {
    setMemoryPresence(view.presence);
    if (shell.surface?.kind === "memory") dispatch({ type: "dismiss" });
    const text = receiptsText(view.receipts);
    if (text) showSubtitle(text);
  },
  changed: (_receipt, historyReset, presence) => {
    if (historyReset) session.forgetMemoryHistory();
    if (presence) setMemoryPresence(presence);
  },
});

// 成果紀錄（HIST-1）：只由使用者的說法、進度卡的「搜尋全部成果」或選單列「成果紀錄…」打開；模型工具不能打開。
/**
 * MEM-4a：macOS App 加密保存任務時，SSE 只給外殼；畫面經 IPC 讀回真實標題與成果（只用來畫畫面）。
 * 給模型的頻道（get_tasks、即時語音的完成通知）照樣用外殼。
 */
const protectedTasks = new ProtectedTasks(window.nousDesktop?.tasks ? (request) => window.nousDesktop!.tasks!(request) : null, () => render());
/** 畫面上顯示的任務（加密任務換成 IPC 讀回的內容；沒有 IPC 時是翻成目前語言的固定句）。 */
const shown = (task: Task): Task => protectedTasks.display(task);

/** 重做：App 經 IPC（核心用自己保存的原句；記憶放行時重新取用目前的記憶）；沒有 IPC 時沿用重試。 */
async function redoTask(taskId: string, requestId: string): Promise<Task> {
  const created = protectedTasks.available ? (await protectedTasks.redo(taskId, requestId)).task : await api.redoTask(taskId, requestId);
  if (!tasks.has(created.task_id)) tasks.set(created.task_id, created);
  dispatch({ type: "task.submitted", task_id: created.task_id, request_id: requestId });
  dispatch({ type: "task.updated", task: tasks.get(created.task_id)! });
  return created;
}

const historyView = new HistoryView({
  // MEM-4a：App 內的成果紀錄經 IPC 搜尋加密任務的真實內容；刪除仍走 HTTP（只有任務 ID）。
  api: protectedTasks.available
    ? { searchHistory: (query) => protectedTasks.search(query), getHistory: (taskId) => protectedTasks.detail(taskId), deleteHistory: (taskId, requestId) => api.deleteHistory(taskId, requestId) }
    : api,
  // macOS App 裡 window.confirm 是原生對話框；瀏覽器裡是瀏覽器的確認框。
  confirm: (message) => window.confirm(message),
  requestId: userRequest,
  redo: async (task, requestId) => {
    // 沿用重試：建立新任務（retry_of 指向原任務），換成前景任務的進度。
    await redoTask(task.task_id, requestId);
    return null;
  },
  shells: !protectedTasks.available,
  dismiss: () => dispatch({ type: "dismiss" }),
  // 一般瀏覽器可以另開 /history；macOS App 的視窗不開新分頁。
  browserLink: !window.nousDesktop,
});

function openHistory(requestId: string, query = "", fromMenu = false): void {
  // MEM-4a（George 的 D2）：只有選單列「成果紀錄…」打開時，才請核心給看其他家人的帶記憶任務（核心再核對點擊時間）。
  protectedTasks.setAllScope(fromMenu);
  historyView.open(query);
  dispatch({ type: "show.history", request_id: requestId });
}

/** 「要交辦這件事嗎？」按「交辦」：用使用者原句建立任務（新的 user_request，不帶記憶、不帶模型改寫）。 */
async function delegateDirect(title: string): Promise<void> {
  const requestId = userRequest();
  try {
    const task = await api.createTask(title, requestId, getLocale());
    if (!tasks.has(task.task_id)) tasks.set(task.task_id, task);
    dispatch({ type: "task.submitted", task_id: task.task_id, request_id: requestId });
    dispatch({ type: "task.updated", task: tasks.get(task.task_id)! });
  } catch (err) {
    showSubtitle(msg`交辦失敗：${(err as Error).message}`);
  }
}

memoryPerson.addEventListener("change", () => {
  const bridge = window.nousDesktop?.memory;
  if (!bridge) return;
  const profile = memoryPerson.value === "" ? null : memoryPerson.value;
  // 主視窗的「本次人物」選單：使用者直接選定（換人會撤銷舊世代，用過記憶的對話歷史清空）。
  void bridge({ op: "select", profile, card: memoryPresence?.select_card }).then((res) => {
    if (res.ok && res.op === "select") {
      session.forgetMemoryHistory();
      setMemoryPresence(res.presence, res.status.profiles.map(p => ({ id: p.id, name: p.name })));
    } else if (!res.ok) showCommandError(res.message);
  });
});

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

/** 語音閒置秒數（設定畫面的 −／+）。回傳失敗說明；成功時為 null。 */
async function updateVoicePrefs(patch: VoicePrefsPatch): Promise<string | null> {
  try {
    applySettings(await api.updateVoice(patch));
    render();
    return null;
  } catch (err) {
    return `語音秒數沒有保存：${(err as Error).message}`;
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

/**
 * source：只有看著說話（鏡頭）開始的會打招呼（George 2026-10-23）；其他一律 user。
 * rebuild：MEM-2 記憶撤銷後的自動重建（只走 live、不問候、保留「記憶已更新」字幕）。
 */
function startRealtime(source: RealtimeStartSource, options: { rebuild?: boolean } = {}): void {
  if (realtime.on || realtimeStarting) return;
  if (!hasVoiceConsent("realtime")) {
    askConsent("realtime");
    return;
  }
  const rebuild = options.rebuild === true;
  liveMemory = null;
  conversationEpoch++;
  voice.abort();
  conversation.stop();
  session.dismiss();
  if (!rebuild) {
    hideSubtitle();
    dispatch({ type: "dismiss" });
  }
  realtimeStarting = true;
  realtimeLocale = getLocale();
  const start = new AbortController();
  realtimeStart = start;
  // 一次開始一個招呼：改路徑時兩個工作階段共用，所以計費通知之後照樣打招呼、但整次最多一次。
  // ID-02：看著說話開始的互動綁定當下的追蹤世代（頁面的鍵 interaction）；核心在 /api/realtime/start 另外發出互動 ID
  // （coreInteraction），問候決策只認核心發出、工作階段真的連上的那一個。送出前由核心決定稱名或只說「我在」（只有 API key
  // 路徑的 instructions 會帶著組好的短句經過這裡）。同意說明延後的不會走到這裡（上面已 return）。
  const interaction = newInteractionId();
  let coreInteraction: string | null = null;
  const greeting = rebuild ? null : greetingFor(source, () => (settings?.camera ?? DEFAULT_CAMERA_PREFS).look_to_talk_greet, {
    interaction,
    locale: realtimeLocale,
    decide: async (route) => {
      const content = await ambient.decide(interaction, route, coreInteraction);
      lookTimeline.mark("decided");
      return content;
    },
    settled: () => ambient.endInteraction(interaction),
  });
  if (greeting) {
    ambient.beginInteraction(interaction, realtimeLocale);
    lookTimeline.mark("start");
  }
  // 路徑在開麥克風前決定；auto 改用 API key 時先說出計費通知。
  void openRealtime({
    start: async () => {
      const decision = await api.realtimeStart(sseClientId, source, realtimeLocale, rebuild);
      coreInteraction = decision.ok ? (decision.interaction ?? null) : null;
      return decision;
    },
    makeSession: (decision) => makeRealtimeSession(decision, greeting, rebuild),
    announce: announceRealtime,
    refused: (message) => {
      ambient.endInteraction(interaction);
      showSubtitle(message);
      dispatch({ type: "input.open" });
      showCommandError(message);
    },
    began: (next, decision) => {
      realtime = next;
      realtimeTicket = decision;
      // MEM-3：兩條路徑都記下憑證（結束後收到記憶撤銷時仍要回報停播）。
      liveTickets.set(decision.session_id, ticketOf(decision));
      if (liveTickets.size > 8) liveTickets.delete(liveTickets.keys().next().value!);
      render();
    },
  }, start.signal)
    .catch((err: unknown) => {
      ambient.endInteraction(interaction);
      if (start.signal.aborted) return;
      const message = `無法開始即時語音：${err instanceof Error ? err.message : String(err)}`;
      showSubtitle(message);
      showCommandError(message);
    })
    .finally(() => {
      // 只清自己的狀態：中止之後又開始了新的一次時，不動新的那次。
      if (realtimeStart === start) {
        realtimeStart = null;
        realtimeStarting = false;
      }
      // 開始失敗或被中止：時序照實印出已有的部分（改路徑成功時要等 API key 的就緒、決策與首音，見 renderRealtimeState）。
      if (!realtime.on) lookTimeline.end();
      render();
    });
}

const REALTIME_STATE_LABEL: Record<Exclude<RealtimePhase, "off">, string> = {
  connecting: "● 即時語音 · 連線中",
  listening: "● 即時語音 · 聆聽中",
  hearing: "● 即時語音 · 正在聽你說",
  thinking: "● 即時語音 · 思考中",
  speaking: "● 即時語音 · 回覆中（可直接插話）",
};

function renderRealtimeState(phase: RealtimePhase): void {
  if (phase === "listening") lookTimeline.mark("ready");
  else if (phase === "speaking") lookTimeline.mark("first_audio");
  // live 建立失敗、正在改用 API key 時（realtimeStarting）不結束：要記到 API key 路徑的就緒、問候決策與首音。
  else if (phase === "off" && !realtimeStarting) lookTimeline.end();
  voicePill.hidden = phase === "off";
  if (phase !== "off") voicePill.textContent = msg`${t(REALTIME_STATE_LABEL[phase])}（點此結束）`;
  voicePill.dataset.state = phase === "off" ? "off" : phase === "speaking" ? "speaking" : "listening";
  voiceModeButton.classList.toggle("recording", phase !== "off");
  voiceModeButton.setAttribute("aria-label", phase === "off" ? t("開始語音對話") : t("結束即時語音"));
  render();
}

/** 模型在即時語音中決定交辦的工作：建立任務、顯示進度，並把真實狀態交還給模型。 */
async function delegateFromRealtime(title: string): Promise<Record<string, unknown>> {
  const requestId = userRequest();
  const created = await api.createTask(title, requestId, realtimeLocale);
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
    // ChatGPT 方案路徑的查詢帶工作階段憑證：本機核心改用 Codex 額度查（不需要 OPENAI_API_KEY）。
    // MEM-3：帶記憶的 API key 通話也帶憑證：工作階段被撤銷後核心回 403，晚到的查詢不再執行。沒有記憶的 API key 通話照舊不帶
    // （事件串流重連時核心會結束它的紀錄，但通話本身還在，查詢不能因此失敗）。
    const ticketed = realtimeTicket && (realtimeTicket.route === "live" || realtimeCoreTools.length > 0);
    const result = await api.webSearch(query, ticketed ? ticketOf(realtimeTicket!) : undefined);
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
    showSubtitle(homeStatusLine(result, getLocale()));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSubtitle(message);
    return { ok: false, error: message };
  }
}

/**
 * 模型要控制家電：本機核心帶權杖送到中控，等中控回讀（可能要十幾秒），字幕先顯示「控制中」再換成真實結果。
 * 結果只放字幕，不換畫面：換掉開著的確認卡會被當成拒絕。
 */
async function homeControlFromRealtime(args: HomeControlArgs): Promise<HomeResult> {
  brain.pulse("step", classifyDomain(args.target));
  showSubtitle(`控制中：${args.target}`, true);
  try {
    const result = await api.homeControl(args);
    showSubtitle(homeControlLine(result, getLocale()));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSubtitle(message);
    return { ok: false, error: message };
  }
}

/** 家電確認卡的答案交給本機核心；同意時字幕顯示執行中與真實結果（對話已結束也照樣顯示）。 */
async function homeConfirmFromRealtime(confirmId: string, approve: boolean): Promise<HomeResult> {
  const detail = pendingConfirms.get(confirmId);
  if (approve && detail?.kind === "home") showSubtitle(`控制中：${detail.device}`, true);
  try {
    const result = await api.homeConfirm(confirmId, approve);
    if (approve) showSubtitle(homeControlLine(result, getLocale()));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (approve) showSubtitle(message);
    return { ok: false, error: message };
  }
}

/** 目前顯示中的確認卡（OpenAI 的 mcp_approval_request，或家電的 needs_confirmation）。 */
const pendingConfirms = new Map<string, ConfirmDetail>();

/** 需要確認的動作：顯示確認卡，等使用者說「確認執行」或「取消」，不需要按任何東西。 */
function showApproval(request: ApprovalRequest, expiresAt: number): void {
  if (request.kind === "home") {
    pendingConfirms.set(request.id, { kind: "home", device: request.device, room: request.room, action: request.action, expiresAt });
    dispatch({ type: "show.confirm", request_id: request.id, message: `武陵居 · ${request.device}：${request.action}` });
    return;
  }
  pendingConfirms.set(request.id, { kind: "mcp", server: request.server, name: request.name, arguments: request.arguments, expiresAt });
  dispatch({ type: "show.confirm", request_id: request.id, message: `${request.server} · ${request.name}` });
}

function closeApproval(request: ApprovalRequest, _approved: boolean, outcome: ApprovalOutcome): void {
  pendingConfirms.delete(request.id);
  if (outcome === "timeout") showSubtitle("確認逾時，沒有執行。");
  if (shell.surface?.kind === "confirm" && shell.surface.request_id === request.id) dispatch({ type: "dismiss" });
  else render();
}

/** get_tasks 工具的回傳：最近的任務與真實進度。 */
function taskSummary(source: Iterable<Task> = tasks.values()): Record<string, unknown>[] {
  return sortForProgress(source).slice(0, 8).map((task) => {
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
    stopRealtime();
    showSubtitle("即時語音已結束。");
    return;
  }
  if (!conversation.on) return;
  session.interrupt();
  conversation.stop();
  showSubtitle("語音模式已關閉。");
}

/** 同意說明裡的計費句：依下一次會用的路徑。 */
function realtimeBillingSentence(): string {
  const rt = settings?.realtime;
  if (rt?.route === "live") {
    const fallback = rt.preference === "auto" && rt.routes.some((r) => r.id === "api_key" && r.available) ? t("；ChatGPT 方案不能用時會改用 OPENAI_API_KEY 依用量計費，並先告訴你") : "";
    return msg`這次計費：${t(rt.billing_line ?? "")}，用你在 Nous 登入的 ChatGPT 方案${fallback}`;
  }
  return msg`這次計費：${t(rt?.billing_line ?? "OpenAI API key 計費")}，使用你在 .env 設定的 OPENAI_API_KEY，依用量計費`;
}

/** 同意說明；閒置秒數用目前的設定（選單列可改），不寫死。 */
function consentMessage(kind: ConsentKind): string {
  const idle = voicePrefs();
  switch (kind) {
    case "realtime":
      return msg`即時語音模式像 ChatGPT 語音模式：開啟期間麥克風音訊會即時串流到 OpenAI（${realtimeBillingSentence()}），AI 直接用語音回答，你隨時可以插話。要它做較長的工作時會交辦成背景任務，仍用目前選擇的引擎執行。說「再見」（由 AI 判斷）、點右上角指示、按 Esc 或 ${t(formatSeconds(idle.realtime_idle_s))}沒說話就會結束。本系統不保存音訊。要開啟嗎？`;
    case "push":
      return t("語音辨識使用瀏覽器內建服務；在 Chrome／Edge 中，音訊會傳到瀏覽器供應商（例如 Google）的雲端辨識。只有在你按下麥克風時才收音，本系統不保存音訊。要啟用嗎？");
    case "continuous":
      return msg`語音模式是對話：開啟期間會持續收音（包含 Nous 說話時，才能讓你插話），你說的話會傳到瀏覽器供應商（例如 Google）的雲端辨識，並送到目前的 AI 引擎回答，回覆用電腦語音念出。建議戴耳機，插話會更準。說「關閉語音模式」、點右上角指示或 ${t(formatSeconds(idle.voice_idle_s))}沒說話就會關閉。本系統不保存音訊。要開啟嗎？`;
  }
}

function askConsent(kind: ConsentKind): void {
  pendingConsent = kind;
  consentText.textContent = t(consentMessage(kind));
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
  const leftFamily = shell.surface?.kind === "family" && next.surface?.surface_id !== shell.surface.surface_id;
  const leftMemory = shell.surface?.kind === "memory" && next.surface?.surface_id !== shell.surface.surface_id;
  const enteredFamily = next.surface?.kind === "family" && next.surface.surface_id !== shell.surface?.surface_id;
  shell = next;
  // 收起只關畫面：停止取樣並丟掉記憶體中的樣本與 session，不刪已存的家人資料。
  if (leftFamily) familyView.close();
  if (leftMemory && next.surface?.kind !== "memory") memoryView.close();
  if (enteredFamily) familyView.open();
  // 家人辨識畫面開著時不做看著說話的同步辨識（核心也拒絕）；收起後重新確認（gallery 可能剛改過）。
  if (leftFamily || enteredFamily) ambient.refresh();
  // 確認卡被收起或被其他畫面取代：視為不同意，外部動作不執行。
  if (leftConfirm && pendingConfirms.has(leftConfirm) && realtime.pendingApproval?.id === leftConfirm) {
    realtime.resolveApproval(false, "dismissed");
  }
  if (!wasListening && shell.listening) {
    form.hidden = false;
    input.focus();
    // 第一次打開輸入列時讀本次人物：status 不開記憶檔、不碰 Keychain。
    if (!memoryPresence) void refreshMemoryStatus();
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
  if (event.type === "realtime.host" || event.type === "realtime.live") {
    // 只有擁有工作階段的頁面會收到（核心只送到開始它的 SSE 串流）。
    // MEM-2：已結束的工作階段（停播未確認）的固定句回條沒有人訂閱，直接顯示。
    // MEM-2：已經不在這通上（同時按了結束、已拆掉）時收到記憶撤銷：仍回報停播，避免被當成停播未確認而停用整條路徑。
    if (event.type === "realtime.live") {
      const orphan = orphanStopReport(event, realtime.on ? realtimeTicket?.session_id ?? null : null, liveTickets, !liveAudio || liveAudio.paused);
      if (orphan) {
        void api.realtimeStopped(orphan.ticket, orphan.evidence).catch(() => undefined);
        return;
      }
    }
    if (event.type === "realtime.live" && event.event.kind === "memory_notice" && event.session_id !== realtimeTicket?.session_id) {
      showSubtitle(t(event.event.message), true);
      return;
    }
    for (const listener of liveListeners) listener(event);
    return;
  }
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
    const previous = sseClientId;
    sseClientId = event.client_id ?? null;
    // MEM-3：帶記憶的 API key 通話也一樣（核心已經掛斷）。
    const coreOwned = realtimeTicket?.route === "live" || (realtimeTicket?.route === "api_key" && realtimeCoreTools.length > 0);
    if (previous && previous !== sseClientId && coreOwned && realtime.on) {
      // 事件串流斷過：核心已經結束了這個工作階段（不假裝重連）。
      const message = realtimeTicket?.route === "live" ? "與本機核心的事件連線中斷，ChatGPT 方案即時語音已結束。" : "與本機核心的事件連線中斷，即時語音已結束。";
      realtime.stop();
      realtimeCallbacks.onClosed(message);
      void speakText(message).catch(() => undefined);
    }
    applySettings(event.settings);
    tasks.clear();
    for (const t of event.tasks) tasks.set(t.task_id, t);
    void protectedTasks.loadAll();
    void refreshVault();
    render();
    return;
  }
  if (event.type === "task.deleted") {
    // 成果紀錄裡確認刪除的任務（任何一個頁面刪的都一樣）：從畫面移除；正在看它的成果畫面由 Presentation Policy 收起。
    tasks.delete(event.task_id);
    protectedTasks.forget(event.task_id);
    if (event.artifact_id) {
      artifacts.delete(event.artifact_id);
      artifactErrors.delete(event.artifact_id);
    }
    historyView.taskDeleted(event.task_id);
    render();
    return;
  }
  if (event.type !== "task.updated") return;
  const prev = tasks.get(event.task.task_id);
  tasks.set(event.task.task_id, event.task);
  protectedTasks.noteUpdate(event.task);
  firePulses(prev, event.task);
  const wasForeground = shell.mode === "working" && shell.foreground_task_id === event.task.task_id;
  dispatch({ type: "task.updated", task: event.task });
  historyView.taskUpdated(shown(event.task));
  if (realtimeTaskIds.has(event.task.task_id) && !isActive(event.task)) {
    // 即時語音中交辦的任務結束：請模型用一句話轉告（不論是否還在前景）。MEM-4a：模型只拿到外殼。
    realtimeTaskIds.delete(event.task.task_id);
    if (realtime.on) realtime.notify(speakFinished(event.task));
  } else if (wasForeground && shell.mode !== "working") {
    // 只有前景任務結束才念；收起後的背景任務保持安靜。本機語音合成，念畫面上的標題。
    say(speakFinished(shown(event.task)));
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

async function handleCommand(text: string, source: "typed" | "speech" = "typed"): Promise<void> {
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
      {
        // macOS App 的設定頁只有帳號與登入：照實指出其他設定在選單列。App 沒有瀏覽器語音模式，say 不會出聲，
        // 所以語音模式沒開時直接顯示字幕。
        const desktop = !!window.nousDesktop;
        const reply = settingsReply(text, { desktop, cameraEnabled: !!settings?.camera?.enabled });
        if (desktop && !conversation.on) showAuthoredSpeech(reply);
        else say(reply);
      }
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
    case "history":
      input.value = "";
      historyView.open(intent.query);
      dispatch({ type: "show.history", request_id: requestId });
      say(intent.query ? msg`這是「${intent.query.slice(0, 18)}」的搜尋結果。` : t("這是成果紀錄。"));
      return;
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
        showTranscript("user", intent.text);
        realtime.sendText(intent.text);
        return;
      }
      await converse(intent.text, requestId, source);
      return;
  }
}

async function cancelTask(taskId: string, requestId: string): Promise<void> {
  try {
    const task = await api.cancelTask(taskId);
    tasks.set(task.task_id, task);
    dispatch({ type: "show.progress", request_id: requestId });
    say(`正在停止：${shown(task).title.slice(0, 18)}。`);
  } catch (err) {
    const message = `無法停止任務：${(err as Error).message}`;
    dispatch({ type: "show.progress", request_id: requestId, message });
    say(message);
  }
}

const actions: ViewActions = {
  cancel: (taskId) => void cancelTask(taskId, userRequest()),
  redo(taskId) {
    const requestId = userRequest();
    void redoTask(taskId, requestId).catch((err) => dispatch({ type: "show.notice", request_id: requestId, message: msg`無法重做：${(err as Error).message}` }));
  },
  async retry(taskId) {
    const requestId = userRequest();
    try {
      // MEM-4a：App 經 IPC 重做（核心用自己保存的原句；記憶放行時重新取用目前的記憶，不沿用舊依賴）。
      if (protectedTasks.available) {
        await redoTask(taskId, requestId);
        return;
      }
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
  openHistory: () => openHistory(userRequest()),
  dismiss: () => dispatch({ type: "dismiss" }),
  openSettings: () => dispatch({ type: "show.settings", request_id: userRequest() }),
  selectProvider: (provider) => void selectProvider(provider, userRequest()),
  updateCamera(patch) {
    const requestId = userRequest();
    void updateCameraPrefs(patch).then((error) => {
      if (error) dispatch({ type: "show.settings", request_id: requestId, message: error });
    });
  },
  updateVoice(patch) {
    const requestId = userRequest();
    void updateVoicePrefs(patch).then((error) => {
      if (error) dispatch({ type: "show.settings", request_id: requestId, message: error });
    });
  },
  openCameraPreview: () => openPreview(userRequest()),
  updateRealtime(patch) {
    const requestId = userRequest();
    void api.updateRealtime(patch).then(
      (next) => {
        applySettings(next);
        const message = realtime.on ? "已保存；這次即時語音維持原本的路徑，下一次開始才改用。" : "已保存；下一次開始即時語音時生效。";
        dispatch({ type: "show.settings", request_id: requestId, message });
      },
      (err: unknown) => dispatch({ type: "show.settings", request_id: requestId, message: `即時語音設定沒有保存：${(err as Error).message}` }),
    );
  },
  codexLogin: (method) => void codexLogin(method, userRequest()),
  async codexCancel() {
    const next = await api.codexCancel().catch(() => null);
    if (next) applySettings(next);
    render();
  },
  async codexLogout() {
    const requestId = userRequest();
    try {
      const result = await api.codexLogout();
      applySettings(result.settings);
      dispatch({ type: "show.settings", request_id: requestId, message: result.revoked ? "已登出即時語音用的 ChatGPT 方案。" : "已在本機登出，但未確認遠端撤銷。" });
    } catch (err) {
      dispatch({ type: "show.settings", request_id: requestId, message: `登出失敗：${(err as Error).message}` });
    }
  },
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

/** 即時語音用的 Codex 登入：瀏覽器流程開授權頁；裝置代碼流程開驗證頁並在設定顯示代碼。結果由伺服器事件回報。 */
async function codexLogin(method: "browser" | "device", requestId: string): Promise<void> {
  const desktop = window.nousDesktop;
  const popup = desktop ? null : window.open("about:blank", "_blank");
  try {
    const result = await api.codexLogin(method);
    const url = result.method === "browser" ? result.authorize_url : result.verification_url;
    if (desktop) desktop.openExternal(url);
    else if (popup) {
      popup.opener = null;
      popup.location.href = url;
    } else window.open(url, "_blank", "noopener");
    const message = result.method === "browser" ? "已開啟 ChatGPT 方案（Codex）登入頁。" : `${result.note ? `${result.note}。` : ""}請在開啟的頁面輸入代碼：${result.user_code}`;
    dispatch({ type: "show.settings", request_id: requestId, message });
  } catch (err) {
    popup?.close();
    dispatch({ type: "show.settings", request_id: requestId, message: `無法開始 ChatGPT 方案登入：${(err as Error).message}` });
  }
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
  commandErrorSource = message;
  commandError.textContent = t(message);
  commandError.hidden = false;
}

// ───────────── 繪製 ─────────────

function render(): void {
  const fgRaw = shell.foreground_task_id ? tasks.get(shell.foreground_task_id) : undefined;
  const fg = fgRaw ? shown(fgRaw) : undefined;
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
  conversationStatus.textContent = t({ idle: "", listening: "正在聆聽，你可以直接說話", thinking: "正在等待回覆，你可以插話", speaking: "正在回覆，你可以直接插話", error: "對話暫時中斷，可重試或開啟設定" }[phase]);
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
  renderMemoryLine();

  renderStatusLine();
  renderEngineLine();
  voiceModeButton.setAttribute("aria-label", realtime.current !== "off" ? t("結束即時語音") : conversation.current !== "off" ? t("關閉語音對話模式") : t("開啟語音對話模式"));
  if (realtime.current !== "off") voicePill.textContent = t("{0}（點此結束）", t(REALTIME_STATE_LABEL[realtime.current]));
  else if (conversation.current !== "off") voicePill.textContent = t("{0}（點此關閉）", t(VOICE_STATE_LABEL[conversation.current]));
  reportDesktopState();
  renderCaption(fg);
  renderSurface();
}

let reportedDesktopState = "";
/**
 * 告訴 App 目前狀態（選單列圖示在收音時改變樣式），以及設定是否變了：頁面收到核心推送的 settings.updated
 * （設定畫面、語音或打字指令、其他分頁改的都算）時版本加一，App 收到新版本就重新讀取設定、重建選單列。
 */
function reportDesktopState(): void {
  const desktop = window.nousDesktop;
  if (!desktop) return;
  const state = {
    voice: realtime.on ? realtime.current : conversation.on ? conversation.current : "off",
    activeTasks: [...tasks.values()].filter(isActive).length,
    settings: `${pageLoadId}.${settingsRevision}`,
    locale: getLocale(),
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
  runDesktopCommand(command, {
    voice: () => (realtime.on || conversation.on ? disableVoiceMode() : openConversation()),
    progress: actions.showProgress,
    settings: actions.openSettings,
    type: () => dispatch({ type: "input.open" }),
    cameraPreview: actions.openCameraPreview,
    family: () => dispatch({ type: "show.family", request_id: userRequest() }),
    memory: () => {
      memoryView.openManager();
      dispatch({ type: "show.memory", request_id: userRequest() });
    },
    history: () => openHistory(userRequest(), "", true),
    vault: () => void refreshVault(true),
  });
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
  conversationUser.textContent = msg`你：${reply.user}`;
  // 「本次人物」只在輸入列與這個對話 Surface 顯示（不建常駐側欄）。
  const person = window.nousDesktop?.memory && settings?.memory?.enabled ? presenceLabel(memoryPresence) : "";
  conversationPerson.hidden = !person;
  conversationPerson.textContent = person;
  conversationNotice.hidden = !("notice" in reply && reply.notice);
  conversationNotice.textContent = "notice" in reply && reply.notice ? t(reply.notice) : "";
  const provider = settings?.provider ?? "chatgpt";
  const answer = reply.answer || (reply.kind === "pending" ? "…" : t("沒有收到文字回覆。"));
  conversationAnswer.textContent = `${t(PROVIDER_LABEL[provider])}：${answer}${reply.kind === "error" ? `\n${t(reply.message)}` : reply.kind === "interrupted" ? t("\n已打斷回覆。") : ""}`;
  renderDelegatePrompt(reply.requestId);
}

/** 「要交辦這件事嗎？」：這一輪用到記憶，所以不自動交辦；按「交辦」才用使用者原句建立任務（docs/16 §9、M15）。 */
function renderDelegatePrompt(requestId: string): void {
  const existing = document.getElementById("delegate-prompt");
  const pending = pendingDelegate && pendingDelegate.requestId === requestId ? pendingDelegate : null;
  const key = pending ? `${getLocale()}:${pending.requestId}` : "";
  if (existing?.dataset.key === key && pending) return;
  existing?.remove();
  if (!pending) return;
  const box = document.createElement("div");
  box.id = "delegate-prompt";
  box.className = "delegate-prompt";
  box.dataset.key = key;
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", t("要交辦這件事嗎？"));
  const question = document.createElement("p");
  question.textContent = msg`要交辦這件事嗎？「${pending.title}」（這一輪用到了記憶，所以沒有自動交辦）`;
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn btn--primary";
  yes.textContent = t("交辦");
  yes.addEventListener("click", () => { pendingDelegate = null; void delegateDirect(pending.title); render(); });
  const no = document.createElement("button");
  no.type = "button";
  no.className = "btn btn--ghost";
  no.textContent = t("不用");
  no.addEventListener("click", () => { pendingDelegate = null; render(); });
  box.append(question, yes, no);
  conversationReply.append(box);
}

/** 輸入列的記憶狀態：桌面版且記憶開啟時顯示「本次人物」選單；瀏覽器版明示不可用。 */
function renderMemoryLine(): void {
  const desktop = !!window.nousDesktop?.memory;
  if (!desktop) {
    memoryLine.hidden = false;
    memoryPersonLabel.textContent = t(MEMORY_BROWSER_UNAVAILABLE);
    memoryPerson.hidden = true;
    return;
  }
  const enabled = !!settings?.memory?.enabled && !!memoryPresence;
  memoryLine.hidden = !enabled;
  if (!enabled) return;
  memoryPersonLabel.textContent = presenceLabel(memoryPresence);
  memoryPerson.hidden = false;
  const options: [string, string][] = [["", t("全家共用（不選人物）")], ...memoryProfiles.map(p => [p.id, p.name] as [string, string])];
  const key = JSON.stringify([getLocale(), options]);
  if (memoryPerson.dataset.key !== key) {
    memoryPerson.replaceChildren(...options.map(([value, label]) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; }));
    memoryPerson.dataset.key = key;
  }
  memoryPerson.value = memoryPresence?.state === "selected" ? memoryPresence.profile ?? "" : "";
}

function renderStatusLine(): void {
  if (!connected) {
    statusLine.textContent = t("與本機核心的連線中斷，正在重新連線…");
    statusLine.className = "status-line status-line--warn";
    statusLine.hidden = false;
  } else if (settings?.provider === "mock") {
    statusLine.textContent = t("模擬模式 · 未呼叫 AI 模型");
    statusLine.title = t("說「設定」可以切換到 Claude 或 ChatGPT");
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
  // 路徑與計費一律照實顯示：進行中的工作階段用它自己的路徑；偏好改了只影響下一次。
  const rt = settings.realtime;
  const activeLine = realtimeTicket?.billing_line ?? rt?.active?.billing_line ?? null;
  if (realtime.on) {
    const next = rt?.billing_line && rt.billing_line !== activeLine ? msg`（下次開始時改用：${t(rt.billing_line)}）` : "";
    engineLine.append(msg`即時語音：${t(activeLine ?? rt?.billing_line ?? "—")}${next}｜`);
    // MEM-2／MEM-3：這通即時語音通話的本次人物與記憶筆數（或沒有用到記憶的原因，依路徑）；不含內容。
    const route = realtimeTicket?.route ?? null;
    if (route && liveMemory && liveMemory.reason === "route_off") {
      // 這條路徑的記憶還沒放行：記憶開著時照實標示（和 MEM-2 的 API key 路徑一樣）。
      if (window.nousDesktop?.memory && settings.memory?.enabled) engineLine.append(t("此路徑未啟用記憶｜"));
    } else if (route && liveMemory && window.nousDesktop?.memory) {
      const name = memoryPresence?.state === "selected" ? memoryPresence.name : null;
      const why = t(liveMemory.reason ? memoryReasonText(route, liveMemory.reason) : "未用記憶");
      engineLine.append(name
        ? liveMemory.used > 0 ? msg`本次人物：${name} · 記憶 ${liveMemory.used} 筆｜` : msg`本次人物：${name} · ${why}｜`
        : liveMemory.used > 0 ? msg`本次人物：未選定 · 記憶 ${liveMemory.used} 筆｜` : msg`本次人物：未選定 · ${why}｜`);
    }
    // API key 路徑沒有記憶狀態（舊的核心或沒有事件串流）而記憶開著：照實標示沒有用到。
    else if (route === "api_key" && !liveMemory && window.nousDesktop?.memory && settings.memory?.enabled) engineLine.append(t("此路徑未啟用記憶｜"));
    engineLine.append(t("交辦工作："));
  }
  if (settings.provider === "chatgpt") {
    const link = document.createElement("a");
    link.href = CHATGPT_USAGE_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("管理用量");
    engineLine.append(t("使用 ChatGPT 方案 · "), link);
  } else {
    engineLine.append(msg`引擎：${t(PROVIDER_LABEL[settings.provider])} · 說「設定」可切換`);
  }
  if (!realtime.on && rt) engineLine.append(msg`｜即時語音：${t(rt.billing_line ?? "不可用")}`);
  engineLine.hidden = false;
}

function renderCaption(fg: Task | undefined): void {
  if (shell.mode !== "working" || !fg || shell.listening) {
    caption.hidden = true;
    return;
  }
  const p = computeProgress(fg);
  let detail: string;
  if (fg.status === "queued") detail = t(queueText(fg, tasks.values()));
  else if (fg.status === "cancelling") detail = t("停止中…");
  else if (p.total === null) detail = t("規劃步驟中…");
  else if (p.current) {
    const chars = p.current.step.output_chars;
    detail = msg`步驟 ${p.current.index} / ${p.total}：${p.current.step.title}${chars ? msg` · 已產生 ${formatCount(chars)} 字` : ""}`;
  } else detail = msg`${p.done} / ${p.total} 步完成`;

  caption.replaceChildren(
    line("caption-title", msg`正在處理：${fg.title}`),
    line("caption-detail", detail),
    line("caption-hint", t("按 Esc 或說「收起」回到桌布，任務會在背景繼續")),
  );
  if (fg.mode === "mock") caption.prepend(line("caption-mock", t("模擬")));
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
      console.warn(t("[presentation-policy] 拒絕呈現："), decision.reason, s);
      queueMicrotask(() => dispatch({ type: "dismiss" }));
    }
    if (renderedKey !== null) surfaceRoot.replaceChildren();
    renderedKey = null;
    return;
  }

  const rawTask = s.task_id ? tasks.get(s.task_id) : undefined;
  const task = rawTask ? shown(rawTask) : undefined;
  const key = getLocale() + ":" + (
    s.kind === "family" || s.kind === "memory" || s.kind === "history"
      ? s.surface_id // 家人辨識畫面自己更新內容，不隨設定重建（重建會打斷取樣）
      : s.kind === "settings"
      ? `${s.surface_id}:${JSON.stringify(settings)}:${s.message ?? ""}`
      : s.kind === "progress"
      ? `${s.surface_id}:${progressStructureKey([...tasks.values()].map(shown))}:${s.message ?? ""}`
      : s.kind === "artifact"
        ? `${s.surface_id}:${artifacts.has(s.artifact_id!)}:${artifactErrors.has(s.artifact_id!)}`
        : `${s.surface_id}:${task?.updated_at ?? ""}:${task?.title ?? ""}`);
  if (key === renderedKey) {
    updateLiveCounts(surfaceRoot, tasks);
    return;
  }

  const previous = surfaceRoot.firstElementChild as HTMLElement | null;
  const sameSurface = renderedKey?.startsWith(`${getLocale()}:${s.surface_id}:`) ?? false;
  const scrollTop = sameSurface && previous ? previous.scrollTop : 0;

  let el: HTMLElement;
  const confirm = s.kind === "confirm" ? pendingConfirms.get(s.request_id) : undefined;
  if (confirm) el = renderConfirm(confirm);
  else if (s.kind === "family") el = familyView.element;
  // 記憶卡與記憶管理自己更新內容（等 IPC 回應、原生確認時不重建）。
  else if (s.kind === "memory") el = memoryView.element;
  // 成果紀錄自己更新內容（搜尋、詳細頁、刪除確認時不重建）。
  else if (s.kind === "history") el = historyView.element;
  // macOS App 的設定以選單列為主體：頁面只畫帳號與登入（瀏覽器版畫完整設定畫面）。
  else if (s.kind === "settings") el = renderSettings(settings, s.message, actions, { desktop: !!window.nousDesktop });
  else if (s.kind === "progress") el = renderProgress([...tasks.values()].map(shown), s.message, actions);
  else if (s.kind === "artifact" && task) {
    const artifactId = s.artifact_id!;
    el = renderArtifact(task, artifacts.get(artifactId) ?? null, artifactErrors.get(artifactId) ?? null, actions);
    if (!artifacts.has(artifactId) && !artifactErrors.has(artifactId)) void loadArtifact(artifactId, task);
  } else if (s.kind === "error" && task) el = renderError(task, actions);
  else el = renderNotice(s.message ?? "", actions);

  if (sameSurface) el.classList.add("no-enter");
  surfaceRoot.replaceChildren(el);
  el.scrollTop = scrollTop;
  renderedKey = key;
  if (pointedZone) applyPointing();
}

async function loadArtifact(artifactId: string, task?: Task): Promise<void> {
  try {
    // MEM-4a：加密保存的成果只經 IPC（HTTP 一律 404）。
    if (task?.protected && protectedTasks.available) artifacts.set(artifactId, await protectedTasks.artifact(task.task_id));
    else if (task?.protected) throw new Error(t("受保護的任務，請在 App 內查看"));
    else artifacts.set(artifactId, await api.getArtifact(artifactId));
  } catch (err) {
    artifactErrors.set(artifactId, err instanceof ApiError ? `無法載入成果：${err.message}` : err instanceof Error && err.message ? err.message : "無法載入成果");
  }
  render();
}

/** MEM-4a：加密搬遷與明文備份的提示（不是 Surface；和交辦卡一樣是輸入列旁的一個小提示）。 */
let vault: VaultView | null = null;
let vaultDismissed = false;
/** 使用者從選單列「刪除明文備份…」打開（審查 minor 8：平常不在每次啟動都出現）。 */
let vaultManual = false;
async function refreshVault(manual = false): Promise<void> {
  if (manual) { vaultManual = true; vaultDismissed = false; }
  vault = await protectedTasks.status();
  renderVaultPrompt();
}

function renderVaultPrompt(): void {
  const existing = document.getElementById("vault-prompt");
  const notice = vaultDismissed ? null : vaultNotice(vault, vaultManual);
  const key = notice ? `${getLocale()}:${notice.text}:${notice.canDelete}` : "";
  if (existing?.dataset.key === key && notice) return;
  existing?.remove();
  if (!notice) return;
  const box = document.createElement("div");
  box.id = "vault-prompt";
  box.className = "delegate-prompt vault-prompt";
  box.dataset.key = key;
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", t("任務加密保存"));
  const text = document.createElement("p");
  text.textContent = notice.text;
  box.append(text);
  if (notice.canDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn--danger";
    del.textContent = t("刪除明文備份");
    // 核心先跳原生確認；使用者在對話框按「刪除明文備份」才刪。
    del.addEventListener("click", () => void protectedTasks.deleteBackups().then((out) => {
      if (out) { vault = out.vault; showSubtitle(msg`已刪除明文備份（${String(out.deleted)} 個資料夾）`); }
      renderVaultPrompt();
    }));
    box.append(del);
  }
  const later = document.createElement("button");
  later.type = "button";
  later.className = "btn btn--ghost";
  later.textContent = t(notice.canDelete ? "稍後" : "知道了");
  later.addEventListener("click", () => { vaultDismissed = true; vaultManual = false; renderVaultPrompt(); });
  box.append(later);
  document.body.append(box);
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
  // 畫面裡的輸入欄（成果紀錄的搜尋框、日期、下拉選單等）自己接收按鍵，不打開指令列。
  if (target.closest("input, textarea, select, [contenteditable]")) return;
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
  if (pendingConsent === "realtime") startRealtime("user");
  else if (pendingConsent === "continuous") enableVoiceMode();
  else voice.start();
});
$<HTMLButtonElement>("consent-no").addEventListener("click", () => {
  consentBox.hidden = true;
  input.focus();
});

render();

applyStaticTranslations();
window.nousDesktop?.onLocaleChange?.(setLocale);
onLocaleChange(() => {
  const selected = getLocale();
  const revision = settingsRevision;
  void api.getSettings(selected).then(value => {
    if (getLocale() !== selected || settingsRevision !== revision) return;
    applySettings(value, true);
    render();
  }).catch(() => {});
  applyStaticTranslations();
  if (!subtitle.hidden) renderSubtitle();
  if (!commandError.hidden) commandError.textContent = t(commandErrorSource);
  if (!consentBox.hidden) consentText.textContent = t(consentMessage(pendingConsent));
  previewClose.setAttribute("aria-label", t("收起鏡頭畫面"));
  micButton.setAttribute("aria-label", t(voice.active ? "停止收音" : "按下開始說話"));
  sensorIndicator.title = t("{0}（按一下顯示／收起鏡頭畫面）", t(sensorDetail));
  sensorIndicator.textContent = sensorState === "ok" ? t("鏡頭") : sensorState === "starting" ? t("鏡頭啟動中") : t("鏡頭：{0}", t(sensorDetail));
  render();
});
