import { RING_LENGTH_CHOICES, RING_TONES, type AlarmsView, type RingTone } from "../shared/alarm.ts";
import { repeatText } from "../shared/alarm-schedule.ts";
import { TERMINAL_CAMERA_SCOPE } from "./terminal-camera.ts";
import { WITHDRAWN_TEXT } from "./protected-tasks.ts";
import { t, msg, getLocale, setLocale, useLocale, uiText } from "./i18n.ts";
import DOMPurify from "dompurify";
import { confirmIcon } from "./icons.ts";
import { marked } from "marked";
import { computeProgress, isActive, sortForProgress, summarize } from "../shared/progress.ts";
import { CHATGPT_USAGE_URL, type Artifact, type ExecutorMode, type SettingsView, type Task, type TaskStep } from "../shared/types.ts";
import { CAMERA_PREF_KEYS, CAMERA_PREFS, stepCameraPref, type CameraNumberKey, type CameraPrefsPatch, type CameraSettings } from "../shared/sense.ts";
import { formatNumberPref, formatSeconds, stepPref } from "../shared/prefs.ts";
import { VOICE_PREF_KEYS, VOICE_PREFS, type VoicePrefs, type VoicePrefsPatch } from "../shared/voice-prefs.ts";
import { callMeterText } from "../shared/call-meter.ts";
import { isLiveVoice, ROUTE_PREFERENCE_LABEL, ROUTE_PREFERENCES, unavailableText, type RealtimePrefsPatch } from "../shared/realtime-route.ts";
import type { RealtimeInfo } from "../shared/types.ts";
import { durationLabel, formatCacheSize, googlePickBusy, MEMORIES_STATE_TEXT, MEMORIES_TEXT, type MemoriesGoogleView, type MemoriesPrefsPatch, type MemoriesSettingsView } from "../shared/memories.ts";
import { CLOCK_TEXT, type ClockPrefsPatch, type ClockSettingsView } from "../shared/clock.ts";
import { HOME_CORNER_TEXT, type HomeCornerPrefsPatch, type HomeCornerSettingsView } from "../shared/home-corner.ts";
import { PROACTIVE_TEXT, type ProactivePrefs, type ProactivePrefsPatch, type ProactiveSettingsView, type WeatherFetchState, type CalendarFetchState } from "../shared/proactive.ts";
import { AUDIO_TEXT, inputStatus, outputStatus, preferredLabel, type AudioDevice, type AudioLine, type AudioPrefs, type AudioPrefsPatch, type AudioReport } from "../shared/audio-devices.ts";
import type { IntegrationServiceStatus, IntegrationStatusView, ToolResultStatus } from "../shared/integrations.ts";
import { GENRES, MUSIC_SERVICES, type IntentId, type MusicService, type Rate, type RelayRefusal, type RelayTrial, type TrialSummary, type VoiceRelayIntentView, type VoiceRelayPart, type VoiceRelayPreview, type VoiceRelayTargetView, type VoiceRelayTemplateView, type VoiceRelayView } from "../shared/voice-relay.ts";
import type { VoiceRelayAdoptBody, VoiceRelayPlayBody, VoiceRelayPreviewBody, VoiceRelayProfileBody, VoiceRelaySlots, VoiceRelayTargetBody, VoiceRelayTrialBody, VoiceRelayUnadoptBody } from "./api.ts";
import { dayNightReasonText, VOICE_VOLUME_TEXT } from "./voice-volume.ts";
import { WAKE_THRESHOLD_OFFSETS, type WakePrefsPatch, type WakeSettingsView } from "../shared/wake.ts";
import { VOICE_VOLUME_DEFAULT, VOICE_VOLUME_MAX, VOICE_VOLUME_MIN, type VoiceVolumeRequest } from "../shared/voice-volume.ts";
import { brightOptions, darkOptions, DEFAULT_LUMA_THRESHOLDS, NIGHT_VOLUME_DEFAULT, type LumaThresholds, type DayNightDecision, type DayNightMode, type DayNightOverride, type DayNightPatch, type DayNightPrefs, type LightLevel } from "../shared/day-night.ts";
import { frameStatsText, PERFORMANCE_PROFILES, PERFORMANCE_TEXT, rendererText, type FrameStats, type PerformanceProfile, type RendererReadout } from "./performance.ts";
import { SEARCH_ERROR_TEXT, SEARCH_TEXT, type SearchPanel } from "./search-panel.ts";
import { STEP_ICON, TASK_STATUS_LABEL, formatClock, formatCount, formatDuration } from "./format.ts";

export interface ViewActions {
  cancel(taskId: string): void;
  retry(taskId: string): void;
  /** MEM-4a：撤銷後的成果「重做」（重新取用目前的記憶，不沿用舊依賴）。 */
  redo?(taskId: string): void;
  openArtifact(taskId: string, artifactId: string): void;
  showProgress(): void;
  dismiss(): void;
  openSettings(): void;
  selectProvider(provider: ExecutorMode): void;
  chatgptLogin(mode: "auto" | "new"): void;
  chatgptCancel(): void;
  chatgptLogout(): void;
  ackWelcome(): void;
  /** 鏡頭設定的開關與 −／+：送出單一鍵的 patch（數值已依 CAMERA_PREFS 夾在範圍內）。 */
  updateCamera(patch: CameraPrefsPatch): void;
  /** 顯示鏡頭畫面（只是畫面，不保存）。 */
  openCameraPreview(): void;
  /** 語音閒置秒數的 −／+：送出單一鍵的 patch（數值已依 VOICE_PREFS 夾在範圍內）。 */
  updateVoice(patch: VoicePrefsPatch): void;
  /** 聲音輸入／輸出裝置（id 與名稱；null＝系統預設）。舊的測試替身沒有這一項時不畫選單。 */
  updateAudio?(patch: AudioPrefsPatch): void;
  /** PRO-1「主動提醒」。 */
  updateProactive?(patch: ProactivePrefsPatch): void;
  /** CLK-1「右上角時鐘與天氣」的兩個顯示開關。 */
  updateClock?(patch: ClockPrefsPatch): void;
  /** ALARM-1：「鬧鐘與定時器」開關與清除（POST /api/settings/alarms、/api/alarms/clear）。 */
  updateAlarms?(patch: { enabled?: boolean; ring_tone?: RingTone; ring_s?: number }): void;
  /** ALARM-3：試聽鈴聲 4 秒。 */
  previewTone?(tone: RingTone): void;
  clearAlarms?(): void;
  /** ALARM-2：設定頁的鬧鐘管理（POST /api/alarms/alarms/*）。 */
  addAlarm?(input: { time: string; repeat: string; label: string }): void;
  setAlarmEnabled?(id: string, enabled: boolean): void;
  deleteAlarm?(id: string): void;
  updateHomeCorner?(patch: HomeCornerPrefsPatch): void;
  /** MEMO-1「回憶模式」。 */
  updateMemories?(patch: MemoriesPrefsPatch): void;
  /** MEMO-2：Google 相簿的挑選、取消與清除快取。 */
  memoriesGoogle?(action: "pick" | "cancel" | "clear"): void;
  /** macOS App：用系統瀏覽器開外部網址（Google 相簿挑選頁不能放進 iframe）。 */
  openExternal?(url: string): void;
  /** SP-1：重新檢查整合服務狀態。 */
  refreshIntegrations?(): void;
  /** VCR-2：設定頁「語音中繼（實驗）」的按鈕（沒有時只畫狀態、按鈕停用）。 */
  voiceRelay?: VoiceRelayActions;
  /** 即時語音的路徑偏好與 ChatGPT 方案路徑的聲音（下一次開始才生效）。 */
  updateRealtime(patch: RealtimePrefsPatch): void;
  /** 即時語音用的 Codex 登入（和上面的 Continue with ChatGPT 分開）。 */
  codexLogin(method: "browser" | "device"): void;
  codexCancel(): void;
  codexLogout(): void;
  /** 進度卡的「搜尋全部成果」（HIST-1）：打開成果紀錄。 */
  openHistory(): void;
  /** 這台裝置的畫面效能：立即套用並保存在這個頁面。 */
  setPerformance?(profile: PerformanceProfile): void;
  /** 「使用 GPU 繪製（WebGL）」：立即切換並保存在這個頁面。 */
  setGpuDrawing?(on: boolean): void;
  /** VOL-1：這台裝置的對話音量（立即套用並保存在這個頁面）。 */
  setVoiceVolume?(request: VoiceVolumeRequest): void;
  /** VOL-2：夜間時段與「用鏡頭亮度判斷」（立即套用並保存在這個頁面）。 */
  setDayNight?(patch: DayNightPatch): void;
  /** LUX-1：這台裝置的鏡頭亮暗門檻。 */
  setLumaThresholds?(next: LumaThresholds): void;
  /** 喚醒偏好（目前只有設定頁的「喚醒詞門檻」；寫入核心的 wake.json）。 */
  updateWake?(patch: WakePrefsPatch): void;
}

export const MAX_LISTED = 8;

type RawText = { readonly raw: string };
export type Child = Node | string | RawText | null | undefined | false;
/** 資料（使用者原句、模型輸出、任務內容）：當成文字節點加入，不翻譯、不解析成 HTML。 */
export const raw = (text: string): RawText => ({ raw: text });

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, ["aria-label", "title", "placeholder"].includes(k) ? t(v) : v);
  for (const c of children) {
    if (typeof c === "string") el.append(c);
    else if (c && "raw" in c) el.append(c.raw);
    else if (c) el.append(c);
  }
  return el;
}

function usageLink(label = t("管理用量"), variant = ""): HTMLAnchorElement {
  return h("a", { class: `btn ${variant}`.trim(), href: CHATGPT_USAGE_URL, target: "_blank", rel: "noopener noreferrer" }, label);
}

export function button(label: string, onClick: () => void, variant = ""): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${variant}`.trim() }, t(label));
  b.addEventListener("click", onClick);
  return b;
}

/** 經過時間只顯示真實時鐘差，由外部每秒刷新。 */
function elapsed(since: string | null, until: string | null): HTMLElement | null {
  if (!since) return null;
  const el = h("span", { class: "elapsed", "data-since": since, "data-until": until ?? "" });
  refreshElapsed(el);
  return el;
}

function refreshElapsed(el: HTMLElement): void {
  const since = Date.parse(el.dataset.since ?? "");
  const until = el.dataset.until ? Date.parse(el.dataset.until) : Date.now();
  el.textContent = formatDuration(until - since);
}

export function refreshTimers(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".elapsed").forEach(refreshElapsed);
}

export function surfaceShell(kind: string, ...children: Child[]): HTMLElement {
  return h("section", { class: `surface surface--${kind}`, role: "region" }, ...children);
}

function footer(actions: ViewActions, ...extra: Child[]): HTMLElement {
  return h(
    "footer",
    { class: "surface-footer" },
    ...extra,
    button(t("收起"), actions.dismiss, "btn--ghost"),
    h("span", { class: "hint" }, t("也可以說／打「收起」，任務會在背景繼續")),
  );
}

// ───────────── 進度 ─────────────

export function renderProgress(tasks: Task[], message: string | null, actions: ViewActions): HTMLElement {
  const sorted = sortForProgress(tasks);
  const s = summarize(sorted);
  const parts = [
    s.active && msg`${s.active} 個進行中`,
    s.succeeded && msg`${s.succeeded} 個已完成`,
    s.failed && msg`${s.failed} 個失敗`,
    s.cancelled && msg`${s.cancelled} 個已停止`,
  ].filter(Boolean);

  const header = h(
    "header",
    { class: "surface-header" },
    h("p", { class: "eyebrow" }, t("任務進度")),
    h("h2", {}, sorted.length ? parts.join(" · ") : t("目前沒有交辦的任務")),
  );

  const list = h("ol", { class: "task-list" });
  for (const task of sorted.slice(0, MAX_LISTED)) list.append(renderTaskCard(task, actions));
  const more =
    sorted.length > MAX_LISTED ? h("p", { class: "muted" }, msg`另有 ${sorted.length - MAX_LISTED} 個較早的任務未列出`) : null;
  // 成果紀錄（HIST-1）只在使用者按下這顆按鈕時打開；不是常駐入口。
  const history = sorted.length > 0 ? h("div", { class: "actions history-entry" }, button(t("搜尋全部成果"), actions.openHistory)) : null;

  return surfaceShell(
    "progress",
    header,
    message && h("p", { class: "notice" }, t(message)),
    sorted.length ? list : h("p", { class: "muted" }, t("說出或輸入一件事交辦給我，之後問「進度如何」就會看到這裡。")),
    more,
    history,
    footer(actions),
  );
}

function renderTaskCard(task: Task, actions: ViewActions): HTMLElement {
  const progress = computeProgress(task);
  const head = h(
    "div",
    { class: "task-head" },
    h("span", { class: `chip chip--${task.status}` }, t(TASK_STATUS_LABEL[task.status])),
    task.mode === "mock" && h("span", { class: "chip chip--mock", title: "未呼叫任何模型" }, t("模擬")),
    task.mode === "chatgpt" && h("span", { class: "chip chip--chatgpt", title: "使用 ChatGPT 方案" }, "ChatGPT"),
    h("h3", { class: "task-title" }, raw(task.title)),
  );

  const fill = h("div", { class: "bar-fill" });
  const bar = h("div", { class: `bar ${progress.total === null ? "bar--unknown" : ""}`.trim() }, fill);
  if (progress.percent !== null) fill.style.width = `${progress.percent}%`;

  const ratio =
    progress.total === null
      ? task.status === "queued"
        ? t("等待開始")
        : t("規劃中：步驟數尚未確定")
      : msg`${progress.done} / ${progress.total} 步 · ${progress.percent}%`;
  const meta = h(
    "div",
    { class: "bar-meta" },
    h("span", { class: "ratio" }, ratio),
    h(
      "span",
      { class: "muted" },
      msg`${formatClock(task.created_at)} 交辦 · ${isActive(task) ? t("已花") : t("共花")} `,
      elapsed(task.created_at, task.finished_at),
    ),
  );

  const steps = h("ol", { class: "steps" });
  task.steps.forEach((step, i) => steps.append(renderStep(task.task_id, i, step)));

  const buttons: HTMLElement[] = [];
  if (task.status === "queued" || task.status === "running") {
    buttons.push(button(t("停止任務"), () => actions.cancel(task.task_id), "btn--danger"));
  }
  if (task.status === "succeeded" && task.artifact_id) {
    const artifactId = task.artifact_id;
    buttons.push(button(t("查看成果"), () => actions.openArtifact(task.task_id, artifactId), "btn--primary"));
  }
  if (task.status === "failed" || task.status === "cancelled") {
    buttons.push(button(t("重試"), () => actions.retry(task.task_id)));
  } else if (task.withdrawn && task.status === "succeeded" && actions.redo) {
    const redo = actions.redo;
    buttons.push(button(t("重做"), () => redo(task.task_id)));
  }

  return h(
    "li",
    // data-selectable：可被手臂指向選定（docs/11）；只是選定，不觸發任何動作。
    { class: `task-card task-card--${task.status}`, "data-selectable": "", "data-label": task.title },
    head,
    bar,
    meta,
    task.steps.length > 0 && steps,
    task.error && h("p", { class: "error-text" }, t(task.error)),
    // MEM-4a：用到的記憶被撤銷：成果內容已移除，只留外殼與重做（重做會重新取用目前的記憶）。
    task.withdrawn && h("p", { class: "muted" }, t(WITHDRAWN_TEXT)),
    task.cancel_reason === "memory_revoked" && h("p", { class: "muted" }, t("用到的記憶已被撤銷，任務已停止，沒有產生成果。")),
    task.model && h("p", { class: "muted small" }, msg`模型：${task.model}`),
    buttons.length > 0 && h("div", { class: "actions" }, ...buttons),
  );
}

export function renderStep(taskId: string, index: number, step: TaskStep): HTMLElement {
  const chars = h("span", { "data-chars": `${taskId}:${index}` }, charsText(step));
  const time = step.status === "running" || step.status === "done" ? elapsed(step.started_at, step.finished_at) : null;
  return h(
    "li",
    { class: `step step--${step.status}` },
    h("span", { class: "step-icon", "aria-hidden": "true" }, STEP_ICON[step.status]),
    h("span", { class: "step-title" }, raw(step.title)),
    h("span", { class: "step-meta" }, chars, time),
  );
}

function charsText(step: TaskStep): string {
  return step.status === "running" && step.output_chars !== null ? msg`已產生 ${formatCount(step.output_chars)} 字 · ` : "";
}

/**
 * 進度面板的結構簽章：只有狀態、步驟或結果改變時才重建 DOM，
 * 串流字數則用 updateLiveCounts 就地更新，避免按鈕在點擊途中被替換。
 */
export function progressStructureKey(tasks: Iterable<Task>): string {
  return [...tasks]
    // F3：標題與步驟標題也在鍵裡：受保護任務的真實內容（IPC）晚於外殼到達時，進度卡才會重畫，不會一直停在固定句。
    .map((t) => JSON.stringify([t.task_id, t.status, t.plan_ready, t.steps.map((s) => [s.status, s.title]), t.artifact_id ?? "", t.title]))
    .sort()
    .join("|");
}

export function updateLiveCounts(root: ParentNode, tasks: ReadonlyMap<string, Task>): void {
  root.querySelectorAll<HTMLElement>("[data-chars]").forEach((el) => {
    const [taskId, index] = (el.dataset.chars ?? "").split(":");
    const step = tasks.get(taskId)?.steps[Number(index)];
    if (step) el.textContent = charsText(step);
  });
}

// ───────────── 成果 ─────────────

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** 成果是資料不是程式：轉成 HTML 後一律消毒，並禁止會發出網路請求或執行的標籤。 */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "picture", "video", "audio", "source", "iframe", "object", "embed", "form", "input", "style", "svg", "math"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

/** 成果的標題列、內容與註記（能力缺口、假設）：成果畫面與成果紀錄的詳細頁共用。 */
export function artifactSections(
  task: Task,
  artifact: Artifact | null,
  loadError: string | null,
): { header: HTMLElement; body: HTMLElement; notes: HTMLElement[] } {
  const metaParts = [
    artifact ? `v${artifact.version}` : null,
    task.finished_at ? msg`${formatClock(task.finished_at)} 完成` : null,
    artifact?.mode === "mock"
      ? t("模擬（未呼叫模型）")
      : artifact?.mode === "chatgpt"
        ? msg`ChatGPT 方案 · ${artifact.model ?? ""}`
        : artifact?.model
          ? msg`模型 ${artifact.model}`
          : null,
  ].filter(Boolean);

  const body = h("article", { class: "markdown" });
  if (artifact) body.innerHTML = renderMarkdown(artifact.content);
  else body.append(h("p", { class: loadError ? "error-text" : "muted" }, loadError ? t(loadError) : t("載入成果中…")));

  const notes: HTMLElement[] = [];
  if (artifact && artifact.capability_gaps.length > 0) {
    notes.push(listBlock(t("能力缺口／尚未完成"), artifact.capability_gaps));
  }
  if (artifact && artifact.assumptions.length > 0) notes.push(listBlock(t("假設"), artifact.assumptions));

  const header = h(
    "header",
    { class: "surface-header" },
    h("p", { class: "eyebrow" }, msg`成果${metaParts.length ? " · " + metaParts.join(" · ") : ""}`),
    h("h2", {}, raw(task.title)),
    artifact?.status === "partial" && h("p", { class: "notice" }, t("這份成果不完整，請看下方的缺口說明。")),
  );
  return { header, body, notes };
}

export function renderArtifact(
  task: Task,
  artifact: Artifact | null,
  loadError: string | null,
  actions: ViewActions,
): HTMLElement {
  const { header, body, notes } = artifactSections(task, artifact, loadError);
  return surfaceShell(
    "artifact",
    header,
    body,
    ...notes,
    footer(actions, button(t("看進度"), actions.showProgress)),
  );
}

function listBlock(title: string, items: string[]): HTMLElement {
  return h("details", { class: "notes", open: "" }, h("summary", {}, title), h("ul", {}, ...items.map((i) => h("li", {}, raw(i)))));
}

// ───────────── 失敗與提示 ─────────────

export function renderError(task: Task, actions: ViewActions): HTMLElement {
  return surfaceShell(
    "error",
    h(
      "header",
      { class: "surface-header" },
      h("p", { class: "eyebrow" }, t("任務失敗")),
      h("h2", {}, raw(task.title)),
    ),
    h("p", { class: "error-text" }, task.error ? t(task.error) : t("未知原因")),
    h("p", { class: "muted" }, t("沒有產生成果。你可以重試，或改用其他說法交辦。")),
    footer(
      actions,
      task.error_action === "manage_chatgpt_usage" && usageLink(t("管理用量"), "btn--primary"),
      task.error_action === "chatgpt_sign_in" && button(t("開啟設定"), actions.openSettings, "btn--primary"),
      button(t("重試"), () => actions.retry(task.task_id), task.error_action ? "" : "btn--primary"),
      button(t("看進度"), actions.showProgress),
    ),
  );
}

// ───────────── 設定（AI 引擎） ─────────────

export interface SettingsRenderOptions {
  terminalCamera?: boolean;
  /**
   * 在 macOS App 裡（頁面有 window.nousDesktop）：設定以選單列為主體，這頁只留帳號與登入和狀態，
   * 不畫和選單列重複的引擎選擇、即時語音路徑與聲音、語音秒數、鏡頭與手勢。瀏覽器版（false）畫完整的設定畫面。
   */
  desktop?: boolean;
  /** 頁面的裝置清單與真的在用的裝置（src/audio-devices.ts）；沒有時「聲音」段只畫系統預設與保存的選擇。 */
  audio?: AudioReport | null;
  /** SP-1：整合服務的按需狀態（只有 NOUS_AIL=on、settings.integrations 存在時才畫）。 */
  integrations?: IntegrationPanelState | null;
  /** VCR-2：語音中繼診斷區的按需狀態（只有核心註冊了 voice_relay、settings.voice_relay 為 true 時才畫）。 */
  voiceRelay?: VoiceRelayPanelState | null;
  /** 這台裝置的畫面效能（src/performance.ts）；沒有時不畫。 */
  performance?: PerformancePanelState | null;
  /** VOL-1／VOL-2：這台裝置的對話音量（日間、夜間與判斷）；沒有時不畫。 */
  voiceVolume?: VoiceVolumePanelState | null;
}

export interface VoiceVolumePanelState {
  day: number;
  night: number;
  decision: DayNightDecision;
  prefs: DayNightPrefs;
  /** 夠新的鏡頭讀值（設定關閉、鏡頭沒開或太舊時 null）。 */
  light: { luma: number; level: LightLevel | null } | null;
  /** LUX-1：這台裝置的亮暗門檻（沒給時不顯示調整）。 */
  thresholds?: LumaThresholds;
  /** DN-2：還有效的手動切換。 */
  override?: DayNightOverride | null;
  /** DN-2：設定存在核心（Mac 與 Pi 共用）；false 時沒有手動切換按鈕。 */
  shared?: boolean;
}

export interface PerformancePanelState {
  profile: PerformanceProfile;
  /** 電子腦實測的格數與繪製時間；設定頁開著時每秒由 refreshPerformanceReadout 更新。 */
  stats: FrameStats | null;
  /** 「使用 GPU 繪製（WebGL）」開關；沒給時視為關閉。 */
  gpu?: boolean;
  /** 真的在用的繪製方式（Brain.rendererStatus）；沒給時當成一般繪製。 */
  renderer?: RendererReadout | null;
}

/** SP-1：設定頁「App 整合」段的狀態（打開設定頁時才向核心查，不在背景輪詢）。 */
export interface IntegrationPanelState {
  view: IntegrationStatusView | null;
  loading: boolean;
  /** 查詢本身失敗（核心沒有回覆）：照實說查不到，不顯示舊結果當成現在。 */
  error: boolean;
}

/**
 * 介面語言切換。persist=false：只換這一頁、不寫進共用的語言偏好（成果紀錄獨立網頁用，免得在瀏覽器換語言時連 App 一起換）；
 * hint=false：不顯示「新語音對話使用所選語言」的說明（沒有語音的頁面）。
 */
export function languageSelector(options: { persist?: boolean; hint?: boolean } = {}): HTMLElement {
  const select = h("select", { "aria-label": t("介面語言"), "data-locale-select": "", id: "interface-language" });
  for (const [value, label] of [["zh-TW", "繁體中文"], ["en", "English"]]) {
    const option = h("option", { value }, raw(label!));
    option.selected = getLocale() === value;
    select.append(option);
  }
  const change = options.persist === false ? useLocale : setLocale;
  select.addEventListener("change", () => change(select.value === "en" ? "en" : "zh-TW"));
  return h("section", { class: "camera-settings language-settings" },
    h("label", {}, t("語言 / Language"), select),
    options.hint !== false && h("p", { class: "muted small" }, t("介面立即切換；新語音對話使用所選語言，既有對話與成果不會改寫。")));
}

/** App 內設定頁的說明：其他設定在選單列的哪裡。 */
export const DESKTOP_SETTINGS_NOTE =
  "其他設定在選單列的 Nous 圖示裡：切換引擎在「AI 引擎」；即時語音的路徑與聲音在「即時語音」；鏡頭開關、秒數與倍率在「鏡頭與語音設定」。";

export function renderSettings(
  settings: SettingsView | null,
  message: string | null,
  actions: ViewActions,
  options: SettingsRenderOptions = {},
): HTMLElement {
  if (!settings) return surfaceShell("settings", h("p", { class: "muted" }, t("正在讀取設定…")), footer(actions));
  if (options.desktop) return renderDesktopAccounts(settings, message, actions, options.audio ?? null, options.integrations ?? null, options.voiceRelay ?? null, options.performance ?? null, options.voiceVolume ?? null);
  const g = settings.chatgpt;

  const list = h("ul", { class: "provider-list" });
  for (const p of settings.providers) {
    const selected = p.id === settings.provider;
    const item = h(
      "li",
      { class: `provider${selected ? " provider--selected" : ""}` },
      h("div", { class: "provider-text" }, h("strong", {}, t(p.label)), h("span", { class: "muted small" }, t(p.detail))),
    );
    if (selected) item.append(h("span", { class: "chip chip--running" }, t("使用中")));
    else if (p.available) item.append(button(t("改用"), () => actions.selectProvider(p.id)));
    else if (p.id === "chatgpt") item.append(button("Continue with ChatGPT", () => actions.chatgptLogin("auto"), "btn--primary"));
    else item.append(h("span", { class: "muted small" }, t("不可用")));
    list.append(item);
  }

  const account = chatgptAccount(settings, actions);
  const welcome = chatgptWelcome(settings, actions);

  return surfaceShell(
    "settings",
    h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, t("設定")), h("h2", {}, t("AI 引擎")), languageSelector()),
    message && h("p", { class: "notice" }, t(message)),
    g.last_error && h("p", { class: "error-text" }, t(g.last_error)),
    welcome,
    list,
    account.length > 0 && h("div", { class: "account" }, ...account),
    settings.realtime && renderRealtimeSettings(settings.realtime, actions),
    h("p", { class: "muted small" }, t("新交辦的任務會用目前選擇的引擎；已在執行的任務不受影響。")),
    settings.voice && renderVoiceSettings(settings.voice, !!settings.realtime?.available, actions),
    settings.camera && renderCameraSettings(settings.camera, !!settings.realtime?.available, actions, !!options.terminalCamera),
    settings.audio && renderAudioSettings(settings.audio.prefs, options.audio ?? null, actions),
    options.voiceVolume && renderVoiceVolumeSettings(options.voiceVolume, actions),
    settings.wake && renderWakeThresholdSettings(settings.wake, actions),
    options.performance && renderPerformanceSettings(options.performance, actions),
    settings.proactive && renderProactiveSettings(settings.proactive, actions),
    settings.clock && renderClockSettings(settings.clock, actions),
    settings.alarms && renderAlarmSettings(settings.alarms, actions),
    settings.home_corner && renderHomeCornerSettings(settings.home_corner, actions),
    settings.memories && renderMemoriesSettings(settings.memories, actions, false),
    settings.integrations && !settings.integrations.builtin_only && options.integrations && renderIntegrationStatus(options.integrations, actions),
    settings.voice_relay === true && options.voiceRelay && renderVoiceRelay(options.voiceRelay, actions),
    // 家人辨識只在 macOS App（加密保存需要 safeStorage）；瀏覽器版照實說不可用，不提供任何操作。
    settings.identity && !settings.identity.available && h("p", { class: "muted small" }, msg`家人辨識：${uiText(settings.identity.disabled_reason ?? "不可用")}`),
    footer(actions),
  );
}

/**
 * macOS App 內的設定頁：只有帳號與登入（ChatGPT 引擎帳號、即時語音用的 Codex 帳號）和狀態。
 * 引擎選擇、即時語音路徑與聲音、秒數、鏡頭與手勢都在選單列，這裡不重複畫。
 */
function renderDesktopAccounts(settings: SettingsView, message: string | null, actions: ViewActions, audio: AudioReport | null, integrations: IntegrationPanelState | null, voiceRelay: VoiceRelayPanelState | null, performance: PerformancePanelState | null, voiceVolume: VoiceVolumePanelState | null = null): HTMLElement {
  const g = settings.chatgpt;
  const account = chatgptAccount(settings, actions, true);
  // 瀏覽器版的「Continue with ChatGPT」在引擎清單裡；這頁沒有引擎清單，未登入時直接放登入按鈕。
  if (!g.pending_login && !g.signed_in && !g.needs_reauth) {
    account.push(h("div", { class: "actions" }, button("Continue with ChatGPT", () => actions.chatgptLogin("auto"), "btn--primary")));
  }
  const current = settings.providers.find((p) => p.id === settings.provider);
  return surfaceShell(
    "settings",
    h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, t("設定")), h("h2", {}, t("帳號與登入")), languageSelector()),
    message && h("p", { class: "notice" }, t(message)),
    g.last_error && h("p", { class: "error-text" }, t(g.last_error)),
    chatgptWelcome(settings, actions),
    h(
      "section",
      { class: "camera-settings" },
      h("h3", {}, t("ChatGPT（AI 引擎）")),
      h("p", { class: "muted small" }, msg`目前的引擎：${t(current?.label ?? settings.provider)}${current && !current.available ? msg`（不可用：${uiText(current.detail)}）` : ""}`),
      account.length > 0 && h("div", { class: "account" }, ...account),
    ),
    settings.realtime && renderRealtimeSettings(settings.realtime, actions, { desktop: true }),
    // 聲音輸入／輸出（George 2026-11-01）：選單列「聲音」與這裡都能選，寫入同一個 audio.json。
    settings.audio && renderAudioSettings(settings.audio.prefs, audio, actions),
    voiceVolume && renderVoiceVolumeSettings(voiceVolume, actions),
    // 喚醒詞門檻（George 2026-11-08）：只在設定頁，寫入核心的 wake.json。
    settings.wake && renderWakeThresholdSettings(settings.wake, actions),
    performance && renderPerformanceSettings(performance, actions),
    // PRO-1：選單列「主動提醒」與這裡都能改，寫入同一個 proactive.json。
    settings.proactive && renderProactiveSettings(settings.proactive, actions),
    // CLK-1：選單列「右上角時鐘與天氣」與這裡都能改，寫入同一個 clock.json。
    settings.clock && renderClockSettings(settings.clock, actions),
    settings.alarms && renderAlarmSettings(settings.alarms, actions),
    // HOME-1：選單列「左上角家中狀態」與這裡都能改，寫入同一個 home-corner.json。
    settings.home_corner && renderHomeCornerSettings(settings.home_corner, actions),
    // MEMO-1：選單列「回憶模式」與這裡都能改，寫入同一個 memories.json。
    settings.memories && renderMemoriesSettings(settings.memories, actions, true),
    settings.integrations && !settings.integrations.builtin_only && integrations && renderIntegrationStatus(integrations, actions),
    settings.voice_relay === true && voiceRelay && renderVoiceRelay(voiceRelay, actions),
    h("p", { class: "muted small" }, t(DESKTOP_SETTINGS_NOTE)),
    footer(actions),
  );
}

/**
 * VOL-1：這台裝置的對話音量（George 2026-11-07）：小聲一點／大聲一點／恢復預設，和說「你講話大聲一點」是同一個設定。
 * 只調 Nous 說話的播放元素，最大就是系統音量；每台裝置各自保存在頁面。
 * VOL-2：分日間與夜間兩組（各有三個按鈕），上方一行照實寫現在用哪一個與原因；夜間時段與「用鏡頭亮度判斷」可以改。
 */
export function renderVoiceVolumeSettings(state: VoiceVolumePanelState, actions: ViewActions): HTMLElement {
  const disabled = !actions.setVoiceVolume;
  const { decision, prefs } = state;
  const row = (period: DayNightMode) => {
    const volume = period === "night" ? state.night : state.day;
    const resetTo = period === "night" ? NIGHT_VOLUME_DEFAULT : VOICE_VOLUME_DEFAULT;
    const down = button(VOICE_VOLUME_TEXT.down, () => actions.setVoiceVolume?.({ change: "down", period }));
    const up = button(VOICE_VOLUME_TEXT.up, () => actions.setVoiceVolume?.({ change: "up", period }));
    const reset = button(VOICE_VOLUME_TEXT.reset, () => actions.setVoiceVolume?.({ change: "reset", period }), "btn--ghost");
    down.disabled = disabled || volume <= VOICE_VOLUME_MIN;
    up.disabled = disabled || volume >= VOICE_VOLUME_MAX;
    reset.disabled = disabled || volume === resetTo;
    const label = t(period === "night" ? VOICE_VOLUME_TEXT.night : VOICE_VOLUME_TEXT.day);
    return h(
      "li",
      { class: "pref", "data-volume-period": period },
      h(
        "div",
        { class: "provider-text" },
        h("strong", {}, label),
        h("span", { class: "muted small", "data-voice-volume": "" }, t(VOICE_VOLUME_TEXT.current, String(volume))),
        decision.mode === period && h("span", { class: "chip chip--running" }, t(VOICE_VOLUME_TEXT.inUse)),
      ),
      h("div", { class: "actions" }, down, up, reset),
    );
  };
  const hourSelect = (label: string, current: number, patch: (hour: number) => Partial<DayNightPrefs>) => {
    const el = h("select", { "aria-label": t(label) }) as HTMLSelectElement;
    for (let hour = 0; hour < 24; hour++) {
      const opt = h("option", { value: String(hour) }, `${String(hour).padStart(2, "0")}:00`) as HTMLOptionElement;
      if (hour === current) {
        opt.setAttribute("selected", "");
        opt.selected = true;
      }
      el.append(opt);
    }
    el.disabled = !actions.setDayNight;
    el.addEventListener("change", () => {
      if (Number(el.value) !== current) actions.setDayNight?.(patch(Number(el.value)));
    });
    return h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label))), el);
  };
  const cameraButton = button(prefs.use_camera ? "開" : "關", () => actions.setDayNight?.({ use_camera: !prefs.use_camera }), prefs.use_camera ? "btn--primary" : "");
  cameraButton.setAttribute("aria-pressed", String(prefs.use_camera));
  cameraButton.setAttribute("aria-label", t("{0}：{1}", t(VOICE_VOLUME_TEXT.camera), prefs.use_camera ? t("開") : t("關")));
  cameraButton.disabled = !actions.setDayNight;
  const screenButton = button(prefs.screen_off ? "開" : "關", () => actions.setDayNight?.({ screen_off: !prefs.screen_off }), prefs.screen_off ? "btn--primary" : "");
  screenButton.setAttribute("aria-pressed", String(prefs.screen_off));
  screenButton.setAttribute("aria-label", t("{0}：{1}", t(VOICE_VOLUME_TEXT.screenOff), prefs.screen_off ? t("開") : t("關")));
  screenButton.setAttribute("data-screen-off", "");
  screenButton.disabled = !actions.setDayNight;
  const effectsButton = button(prefs.night_effects ? "開" : "關", () => actions.setDayNight?.({ night_effects: !prefs.night_effects }), prefs.night_effects ? "btn--primary" : "");
  effectsButton.setAttribute("aria-pressed", String(prefs.night_effects));
  effectsButton.setAttribute("aria-label", t("{0}：{1}", t(VOICE_VOLUME_TEXT.effects), prefs.night_effects ? t("開") : t("關")));
  effectsButton.setAttribute("data-night-effects", "");
  effectsButton.disabled = !actions.setDayNight;
  return h(
    "section",
    { class: "camera-settings voice-volume-settings" },
    h("h3", {}, t(VOICE_VOLUME_TEXT.title)),
    h("p", { "data-day-night": "", role: "status" }, dayNightLine(state)),
    state.shared && manualRow(state, actions),
    h("ul", { class: "pref-list" }, row("day"), row("night")),
    h(
      "ul",
      { class: "pref-list" },
      hourSelect(VOICE_VOLUME_TEXT.hoursStart, prefs.night_start_h, (hour) => ({ night_start_h: hour })),
      hourSelect(VOICE_VOLUME_TEXT.hoursEnd, prefs.night_end_h, (hour) => ({ night_end_h: hour })),
      h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(VOICE_VOLUME_TEXT.camera)), h("span", { class: "muted small" }, t(VOICE_VOLUME_TEXT.cameraNote))), cameraButton),
      h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(VOICE_VOLUME_TEXT.effects)), h("span", { class: "muted small" }, t(VOICE_VOLUME_TEXT.effectsNote))), effectsButton),
      state.shared && h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(VOICE_VOLUME_TEXT.screenOff)), h("span", { class: "muted small" }, t(VOICE_VOLUME_TEXT.screenOffNote))), screenButton),
    ),
    h("p", { class: "muted small", "data-light": "" }, lightLine(state)),
    state.thresholds && thresholdRows(state.thresholds, actions),
    h("p", { class: "muted small" }, t(VOICE_VOLUME_TEXT.hoursNote)),
    h("p", { class: "muted small" }, t(VOICE_VOLUME_TEXT.note)),
  );
}

/** 設定頁「喚醒詞門檻」的文字（中文是翻譯表的鍵）。 */
export const WAKE_THRESHOLD_TEXT = {
  title: "喚醒詞門檻",
  label: "門檻調整",
  options: {
    "-0.1": "更容易喚醒（−0.10）",
    "-0.05": "稍微容易（−0.05）",
    "0": "預設（0）",
    "0.05": "稍微嚴格（+0.05）",
    "0.1": "更不容易誤觸（+0.10）",
  } as Record<string, string>,
  current: "目前門檻：{0}",
  note: "數字越小越容易喚醒，也越容易被電視或聊天誤觸；數字越大越不容易誤觸，但可能要說兩次。改了立即套用，通話中等這通結束；所有連到這台核心的裝置共用。",
} as const;

/** HELLO_NOUS → Hello Nous */
function phraseLabel(id: string): string {
  return id.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

/**
 * 喚醒詞門檻調整（George 2026-11-08；docs/validation/wake-threshold-2026-11-08.md）：加到每個喚醒詞門檻上的調整值，
 * 五個選項（−0.10～+0.10），預設 0＝產品原本的門檻。只有 NOUS_WAKE=on（settings.wake 存在）時畫。
 */
export function renderWakeThresholdSettings(wake: WakeSettingsView, actions: ViewActions): HTMLElement {
  const current = wake.wake_threshold_offset ?? 0;
  const select = h("select", { "aria-label": t(WAKE_THRESHOLD_TEXT.label), "data-wake-threshold": "" }) as HTMLSelectElement;
  for (const value of WAKE_THRESHOLD_OFFSETS) {
    const opt = h("option", { value: String(value) }, t(WAKE_THRESHOLD_TEXT.options[String(value)]!)) as HTMLOptionElement;
    if (value === current) {
      opt.setAttribute("selected", "");
      opt.selected = true;
    }
    select.append(opt);
  }
  select.disabled = !actions.updateWake;
  select.addEventListener("change", () => {
    const next = Number(select.value);
    if (next !== current && (WAKE_THRESHOLD_OFFSETS as readonly number[]).includes(next)) actions.updateWake?.({ wake_threshold_offset: next });
  });
  const thresholds = (wake.thresholds ?? []).map((x) => `${phraseLabel(x.phrase)} ${x.threshold.toFixed(2)}`).join(getLocale() === "en" ? ", " : "、");
  return h(
    "section",
    { class: "camera-settings wake-threshold-settings" },
    h("h3", {}, t(WAKE_THRESHOLD_TEXT.title)),
    h("ul", { class: "pref-list" }, h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(WAKE_THRESHOLD_TEXT.label))), select)),
    thresholds && h("p", { class: "muted small", "data-wake-thresholds": "" }, t(WAKE_THRESHOLD_TEXT.current, thresholds)),
    h("p", { class: "muted small" }, t(WAKE_THRESHOLD_TEXT.note)),
  );
}

function dayNightLine(state: VoiceVolumePanelState): string {
  return dayNightReasonText(state.decision, state.prefs, state.override ?? null, t);
}

/** DN-2：手動切換的四個按鈕（自動／現在是白天／切到夜間／今晚維持日間）；目前選的那一個 aria-pressed＝true。 */
function manualRow(state: VoiceVolumePanelState, actions: ViewActions): HTMLElement {
  const text = VOICE_VOLUME_TEXT.manual;
  const override = state.override ?? null;
  const current = !override ? "auto" : override.mode === "day" && override.scope === "tonight" ? "tonightDay" : override.mode;
  const make = (key: "auto" | "day" | "night" | "tonightDay", patch: DayNightPatch) => {
    const pressed = current === key;
    const el = button(text[key], () => actions.setDayNight?.(patch), pressed ? "btn--primary" : "");
    el.setAttribute("aria-pressed", String(pressed));
    el.setAttribute("data-day-night-manual", key);
    el.disabled = !actions.setDayNight;
    return el;
  };
  return h(
    "div",
    { class: "pref-list" },
    h("strong", {}, t(text.title)),
    h(
      "div",
      { class: "actions" },
      make("auto", { override: "auto" }),
      make("day", { override: "day", scope: "now" }),
      make("night", { override: "night", scope: "now" }),
      make("tonightDay", { override: "day", scope: "tonight" }),
    ),
    h("p", { class: "muted small" }, t(text.note)),
  );
}

/** LUX-1：兩個門檻下拉選單（選項保證算暗比算亮至少低 5）與恢復預設。 */
function thresholdRows(th: LumaThresholds, actions: ViewActions): HTMLElement {
  const text = VOICE_VOLUME_TEXT.thresholds;
  const select = (label: string, key: "dark" | "bright", options: number[]) => {
    const el = h("select", { "aria-label": t(label), [`data-luma-${key}`]: "" }) as HTMLSelectElement;
    for (const v of options) {
      const opt = h("option", { value: String(v) }, String(v)) as HTMLOptionElement;
      if (v === th[key]) {
        opt.setAttribute("selected", "");
        opt.selected = true;
      }
      el.append(opt);
    }
    el.disabled = !actions.setLumaThresholds;
    el.addEventListener("change", () => {
      const v = Number(el.value);
      if (v !== th[key]) actions.setLumaThresholds?.({ ...th, [key]: v });
    });
    return h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label))), el);
  };
  const isDefault = th.dark === DEFAULT_LUMA_THRESHOLDS.dark && th.bright === DEFAULT_LUMA_THRESHOLDS.bright;
  const reset = button(t(text.reset, String(DEFAULT_LUMA_THRESHOLDS.dark), String(DEFAULT_LUMA_THRESHOLDS.bright)), () => actions.setLumaThresholds?.({ ...DEFAULT_LUMA_THRESHOLDS }), "btn--ghost");
  reset.setAttribute("data-luma-reset", "");
  reset.disabled = !actions.setLumaThresholds || isDefault;
  return h(
    "div",
    {},
    h("ul", { class: "pref-list" }, select(text.dark, "dark", darkOptions(th.bright)), select(text.bright, "bright", brightOptions(th.dark))),
    h("div", { class: "actions" }, reset),
    h("p", { class: "muted small" }, t(text.note)),
  );
}

function lightLine(state: VoiceVolumePanelState): string {
  if (!state.prefs.use_camera) return t(VOICE_VOLUME_TEXT.light.off);
  if (!state.light) return t(VOICE_VOLUME_TEXT.light.unknown);
  const level = state.light.level === "dark" ? VOICE_VOLUME_TEXT.light.dark : state.light.level === "bright" ? VOICE_VOLUME_TEXT.light.bright : VOICE_VOLUME_TEXT.light.middle;
  return t(VOICE_VOLUME_TEXT.light.reading, String(Math.round(state.light.luma)), t(level));
}

/**
 * 這台裝置的畫面效能（George 2026-11-05，Pi 4 終端機）：完整／平衡／省電，選了立即套用、只存在這個頁面。
 * 只改電子腦的繪製與背景模糊；收音、播放與即時語音不受影響。實測數字來自電子腦每一格的計時。
 * 另有「使用 GPU 繪製（WebGL）」開關（2026-11-07，方案 B）：和三檔正交、預設關；「目前」一行照實寫真的在用哪一種與改回的原因。
 */
export function renderPerformanceSettings(state: PerformancePanelState, actions: ViewActions): HTMLElement {
  const choices = h("div", { class: "actions perf-choices", role: "radiogroup", "aria-label": PERFORMANCE_TEXT.group });
  for (const profile of PERFORMANCE_PROFILES) {
    const selected = state.profile === profile;
    const choice = h(
      "button",
      { type: "button", class: `btn perf-choice${selected ? " btn--primary" : ""}`, role: "radio", "aria-checked": String(selected) },
      h("strong", {}, t(PERFORMANCE_TEXT.label[profile])),
      h("span", { class: "small" }, t(PERFORMANCE_TEXT.detail[profile])),
    );
    choice.addEventListener("click", () => actions.setPerformance?.(profile));
    choice.disabled = !actions.setPerformance;
    choices.append(choice);
  }
  const gpu = state.gpu === true;
  const gpuButton = button(gpu ? "開" : "關", () => actions.setGpuDrawing?.(!gpu), gpu ? "btn--primary" : "");
  gpuButton.setAttribute("aria-pressed", String(gpu));
  gpuButton.setAttribute("aria-label", t("{0}：{1}", t(PERFORMANCE_TEXT.gpu), gpu ? t("開") : t("關")));
  gpuButton.disabled = !actions.setGpuDrawing;
  const gpuList = h(
    "ul",
    { class: "pref-list" },
    h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(PERFORMANCE_TEXT.gpu)), h("span", { class: "muted small" }, t(PERFORMANCE_TEXT.gpuNote))), gpuButton),
  );
  return h(
    "section",
    { class: "camera-settings performance-settings" },
    h("h3", {}, t(PERFORMANCE_TEXT.title)),
    choices,
    gpuList,
    h("p", { class: "muted small" }, t(PERFORMANCE_TEXT.note)),
    h("p", { class: "muted small", "data-perf-renderer": "" }, t(rendererText(state.renderer ?? null))),
    h("p", { class: "muted small", "data-perf-readout": "" }, performanceReadout(state.stats)),
  );
}

function performanceReadout(stats: FrameStats | null): string {
  const { source, values } = frameStatsText(stats);
  return t(source, ...values);
}

/** 設定頁開著時每秒更新實測數字與目前的繪製方式（只改文字，不重建設定頁）。 */
export function refreshPerformanceReadout(root: ParentNode, stats: FrameStats | null, renderer?: RendererReadout | null): void {
  root.querySelectorAll<HTMLElement>("[data-perf-readout]").forEach((el) => { el.textContent = performanceReadout(stats); });
  if (renderer === undefined) return;
  root.querySelectorAll<HTMLElement>("[data-perf-renderer]").forEach((el) => { el.textContent = t(rendererText(renderer)); });
}

/** ChatGPT 引擎帳號：登入中、已登入（重新授權／用量／其他帳號／登出）、需要重新登入。 */
function chatgptAccount(settings: SettingsView, actions: ViewActions, desktop = false): Child[] {
  const g = settings.chatgpt;
  const account: Child[] = [];
  if (g.pending_login) {
    account.push(
      // App 的外部連結由系統瀏覽器打開（desktop/main.mjs setWindowOpenHandler），不是新分頁。
      h("p", { class: "notice" }, desktop ? t("已在瀏覽器開啟 ChatGPT 登入。完成後會自動回到這裡。") : t("已在新分頁開啟 ChatGPT 登入。完成後會自動回到這裡。")),
      button(t("取消登入"), actions.chatgptCancel, "btn--ghost"),
    );
  } else if (g.signed_in) {
    account.push(
      h("p", { class: "small" }, msg`ChatGPT 帳號：${g.email ?? t("已登入")}${g.plan_usage ? "" : t("（未授權使用方案額度）")}`),
      h(
        "div",
        { class: "actions" },
        !g.plan_usage && button(t("重新授權"), () => actions.chatgptLogin("auto"), "btn--primary"),
        usageLink(),
        button(t("使用其他帳號"), () => actions.chatgptLogin("new")),
        button(t("登出 ChatGPT"), actions.chatgptLogout, "btn--ghost"),
      ),
    );
  } else if (g.needs_reauth) {
    account.push(button(t("重新登入 ChatGPT"), () => actions.chatgptLogin("auto"), "btn--primary"));
  }
  return account;
}

/** 第一次以 ChatGPT 方案使用時的說明（UI/UX guidelines）。 */
function chatgptWelcome(settings: SettingsView, actions: ViewActions): HTMLElement | null {
  const g = settings.chatgpt;
  return settings.provider === "chatgpt" && g.signed_in && g.plan_usage && !g.welcome_ack
      ? h(
          "div",
          { class: "welcome" },
          h("strong", {}, t("你正在使用 ChatGPT 方案")),
          h("p", {}, t("在 Nous 交辦的 AI 任務會使用你的 ChatGPT 方案額度。可以到 ChatGPT 設定管理用量。")),
          button(t("知道了"), actions.ackWelcome, "btn--primary"),
        )
      : null;
}

/**
 * 即時語音：路徑（自動／ChatGPT 方案／API key）、每條路徑的狀態與計費、即時語音用的 Codex 登入。
 * 計費一律照實顯示；切換只影響下一次開始，進行中的工作階段維持原本的路徑。
 * options.desktop：macOS App 內只畫狀態與 Codex 帳號，路徑與聲音的按鈕在選單列「即時語音」。
 */
export function renderRealtimeSettings(rt: RealtimeInfo, actions: ViewActions, options: SettingsRenderOptions = {}): HTMLElement {
  const active = rt.active;
  // 費用防護：進行中的通話另顯示通話時間／上限與約略 tokens（核心最近一次的設定；頁面報到的 usage，不是帳單）。
  const meter = active ? callMeterText({ route: active.route, startedAt: active.started_at ?? null, maxMs: (active.max_call_s ?? 0) * 1000, usage: active.usage ?? null }, Date.now(), t) : "";
  const status = active
    ? msg`進行中：${t(active.billing_line)}${rt.billing_line && rt.billing_line !== active.billing_line ? msg`（下次開始時改用：${t(rt.billing_line)}）` : ""}` + (meter && active.max_call_s ? ` · ${meter}` : "")
    : rt.billing_line
      ? msg`下次開始：${t(rt.billing_line)}`
      : msg`不可用：${uiText(rt.detail)}`;
  const prefs = h("div", { class: "actions", role: "radiogroup", "aria-label": "即時語音路徑" });
  for (const pref of ROUTE_PREFERENCES) {
    const selected = rt.preference === pref;
    const b = button(ROUTE_PREFERENCE_LABEL[pref], () => actions.updateRealtime({ route: pref }), selected ? "btn--primary" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(selected));
    prefs.append(b);
  }
  const routes = h("ul", { class: "provider-list" });
  for (const r of rt.routes) {
    const label = r.id === "live" ? t("ChatGPT 方案（Codex 登入）") : "OpenAI API key";
    const item = h(
      "li",
      { class: `provider${active?.route === r.id ? " provider--selected" : ""}` },
      h(
        "div",
        { class: "provider-text" },
        h("strong", {}, `${label} · ${t(r.billing_line)}`),
        h("span", { class: "muted small" }, r.available ? msg`可用 · 工具：${uiText(r.tools)}` : msg`不可用：${uiText(r.reason ? unavailableText(r.reason) : r.detail)}`),
      ),
    );
    if (active?.route === r.id) item.append(h("span", { class: "chip chip--running" }, t("進行中")));
    routes.append(item);
  }
  const live = rt.routes.find((r) => r.id === "live");
  const voices = live
    ? h(
        "div",
        { class: "actions", role: "radiogroup", "aria-label": "ChatGPT 方案路徑的聲音" },
        ...live.voices.map((v) => {
          const selected = live.voice === v;
          const b = button(v, () => isLiveVoice(v) && actions.updateRealtime({ live_voice: v }), selected ? "btn--primary" : "btn--ghost");
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", String(selected));
          return b;
        }),
      )
    : null;
  const account: Child[] = [];
  const a = rt.live_account;
  if (a) {
    if (a.pending?.method === "browser") {
      account.push(h("p", { class: "notice" }, msg`已在瀏覽器開啟 ChatGPT 方案（Codex）登入（回呼埠 ${a.pending.port}）。完成後會自動更新。`), button(t("取消登入"), actions.codexCancel, "btn--ghost"));
    } else if (a.pending?.method === "device") {
      account.push(
        h("p", { class: "notice" }, msg`到 ${a.pending.verification_url} 輸入代碼：${a.pending.user_code}`),
        button(t("取消登入"), actions.codexCancel, "btn--ghost"),
      );
    } else if (a.signed_in) {
      account.push(
        h("p", { class: "small" }, msg`即時語音用的 ChatGPT 方案：${a.email ?? t("已登入")}${a.plan ? ` · ${a.plan}` : ""}`),
        h("div", { class: "actions" }, usageLink(), button(t("登出（即時語音）"), actions.codexLogout, "btn--ghost")),
      );
    } else {
      account.push(
        h(
          "div",
          { class: "actions" },
          button(a.needs_reauth ? t("重新登入 ChatGPT 方案（Codex）") : t("用 ChatGPT 方案登入（Codex）"), () => actions.codexLogin("browser"), "btn--primary"),
          button(t("用裝置代碼登入"), () => actions.codexLogin("device")),
        ),
      );
    }
    if (a.last_error) account.push(h("p", { class: "error-text" }, t(a.last_error)));
  }
  if (options.desktop) {
    return h(
      "section",
      { class: "camera-settings" },
      h("h3", {}, t("即時語音（ChatGPT 方案（Codex）帳號）")),
      h("p", { class: "small" }, h("strong", {}, status)),
      routes,
      ...account,
      h(
        "p",
        { class: "muted small" },
        t("這個登入只給即時語音用，和上面 AI 引擎的 ChatGPT 帳號分開；Nous 不讀也不改 Codex CLI 的 ~/.codex。路徑與聲音在選單列「即時語音」切換，只影響下一次開始。"),
      ),
    );
  }
  return h(
    "section",
    { class: "camera-settings" },
    h("h3", {}, t("即時語音")),
    h("p", { class: "small" }, h("strong", {}, status)),
    prefs,
    routes,
    live && h("p", { class: "muted small" }, t("ChatGPT 方案路徑的聲音：")),
    voices,
    ...account,
    h(
      "p",
      { class: "muted small" },
      t("這個登入只給即時語音用，和上面的 Continue with ChatGPT 分開；Nous 不讀也不改 Codex CLI 的 ~/.codex。MCP 只在 API key 路徑可用。切換只影響下一次開始。"),
    ),
  );
}

/** 語音閒置秒數：逐項走 VOICE_PREFS（順序、標籤、提示、範圍都從那裡來）；不需要鏡頭。 */
function renderVoiceSettings(voice: VoicePrefs, realtimeAvailable: boolean, actions: ViewActions): HTMLElement {
  const list = h("ul", { class: "pref-list" });
  for (const key of VOICE_PREF_KEYS) {
    const spec = VOICE_PREFS[key];
    const value = voice[key];
    const minus = button("−", () => actions.updateVoice({ [key]: stepPref(spec, value, -1) }));
    const plus = button("+", () => actions.updateVoice({ [key]: stepPref(spec, value, 1) }));
    minus.disabled = value <= spec.min;
    plus.disabled = value >= spec.max;
    minus.setAttribute("aria-label", msg`${t(spec.label)}減少`);
    plus.setAttribute("aria-label", msg`${t(spec.label)}增加`);
    const hint = (key === "realtime_idle_s" || key === "realtime_max_call_s" || key === "search_close_s") && !realtimeAvailable ? msg`${t(spec.hint)}；即時語音目前不可用` : t(spec.hint);
    list.append(
      h(
        "li",
        { class: "pref" },
        h("div", { class: "provider-text" }, h("strong", {}, t(spec.label)), h("span", { class: "muted small" }, hint)),
        h("div", { class: "stepper" }, minus, h("span", { class: "stepper-value" }, t(formatSeconds(value))), plus),
      ),
    );
  }
  return h("section", { class: "camera-settings" }, h("h3", {}, t("語音")), list, h("p", { class: "muted small" }, t("改了立即生效：開著的語音從現在起重新計時。macOS App 在選單列「鏡頭與語音設定」調整。")));
}

/** 狀態句：原文翻譯，裝置名稱照原樣代入（「系統預設」等介面字才翻譯）。 */
function audioLine(line: AudioLine): string {
  const ui = new Set<string>([AUDIO_TEXT.systemDefault, AUDIO_TEXT.unknownDevice]);
  return t(line.text, ...line.values.map((value) => (ui.has(value) ? t(value) : value)));
}

/** 下拉選單的一個裝置名稱（資料，不翻譯）；沒授權前名稱是空的，用「麥克風 1」這類編號。 */
function deviceName(device: AudioDevice, index: number, kind: "input" | "output"): string {
  return device.label || t(kind === "input" ? AUDIO_TEXT.unnamedInput : AUDIO_TEXT.unnamedOutput, index + 1);
}

/**
 * 聲音輸入／輸出（George 2026-11-01）：兩個下拉選單、真的在用的裝置與提示。選了就保存（POST /api/settings/audio）；
 * 輸出立即生效，麥克風在通話中改時下一通起使用。按下說話與系統朗讀瀏覽器不給選裝置，一律用系統輸入／輸出（照實提示）。
 */
export function renderAudioSettings(prefs: AudioPrefs, report: AudioReport | null, actions: ViewActions): HTMLElement {
  const list = h("ul", { class: "pref-list" });
  const row = (kind: "input" | "output") => {
    const devices = report ? (kind === "input" ? report.inputs : report.outputs) : [];
    const id = kind === "input" ? prefs.input_device_id : prefs.output_device_id;
    const saved = kind === "input" ? prefs.input_label : prefs.output_label;
    const current = kind === "input" ? report?.default_input : report?.default_output;
    const title = kind === "input" ? AUDIO_TEXT.input : AUDIO_TEXT.output;
    const select = h("select", { "aria-label": title, name: `audio-${kind}` });
    const option = (value: string, label: string, selected: boolean) => {
      const o = h("option", { value }, label);
      if (selected) o.setAttribute("selected", "");
      (o as HTMLOptionElement).selected = selected;
      return o;
    };
    select.append(option("", current ? t(AUDIO_TEXT.systemDefaultNow, current) : t(AUDIO_TEXT.systemDefault), id === null));
    devices.forEach((device, i) => select.append(option(device.id, deviceName(device, i, kind), device.id === id)));
    // 選定的裝置不在清單裡（拔掉了）：仍列出來，讓畫面照實顯示目前的選擇。清單還沒讀到時寫「尚未回報」，不說找不到。
    if (id !== null && !devices.some((d) => d.id === id)) {
      const name = preferredLabel(id, saved, devices) ?? t(AUDIO_TEXT.unknownDevice);
      select.append(option(id, t(devices.length === 0 ? AUDIO_TEXT.notReportedOption : AUDIO_TEXT.notFoundOption, name), true));
    }
    (select as HTMLSelectElement).disabled = !actions.updateAudio;
    select.addEventListener("change", () => {
      const value = (select as HTMLSelectElement).value;
      const device = devices.find((d) => d.id === value);
      if (value === id || (value === "" && id === null)) return;
      const label = device?.label || null;
      const patch: AudioPrefsPatch = kind === "input"
        ? { input_device_id: value || null, input_label: value ? label : null }
        : { output_device_id: value || null, output_label: value ? label : null };
      actions.updateAudio?.(patch);
    });
    const status = kind === "input" ? inputStatus(prefs, report) : outputStatus(prefs, report);
    list.append(
      h(
        "li",
        { class: "pref" },
        h("div", { class: "provider-text" }, h("strong", {}, t(title)), h("span", { class: "muted small", role: "status" }, audioLine(status))),
        select,
      ),
    );
  };
  row("input");
  row("output");
  // 「處理中音效」（George 2026-11-02）：背景任務執行中的聲納提示音；寫入同一個 audio.json。關掉只停聲音，電子腦照舊。
  const cueOn = prefs.processing_cue !== false;
  const cue = button(cueOn ? "開" : "關", () => actions.updateAudio?.({ processing_cue: !cueOn }), cueOn ? "btn--primary" : "");
  cue.setAttribute("aria-pressed", String(cueOn));
  cue.setAttribute("aria-label", t("{0}：{1}", t(AUDIO_TEXT.processingCue), cueOn ? t("開") : t("關")));
  cue.disabled = !actions.updateAudio;
  list.append(
    h(
      "li",
      { class: "pref" },
      h("div", { class: "provider-text" }, h("strong", {}, t(AUDIO_TEXT.processingCue)), h("span", { class: "muted small" }, t(AUDIO_TEXT.processingCueNote))),
      cue,
    ),
  );
  return h(
    "section",
    { class: "camera-settings audio-settings" },
    h("h3", {}, t(AUDIO_TEXT.group)),
    list,
    report && !report.labels && h("p", { class: "muted small" }, t(AUDIO_TEXT.needPermission)),
    h("p", { class: "muted small" }, t(AUDIO_TEXT.bluetoothHint)),
    h("p", { class: "muted small" }, t(AUDIO_TEXT.systemSpeechHint)),
  );
}

const PROACTIVE_STATE: Record<WeatherFetchState, string> = { ok: PROACTIVE_TEXT.stateOk, failed: PROACTIVE_TEXT.stateFailed, none: PROACTIVE_TEXT.stateNone, no_place: PROACTIVE_TEXT.stateNoPlace };
const CALENDAR_STATE: Record<CalendarFetchState, string> = { ok: PROACTIVE_TEXT.calOk, failed: PROACTIVE_TEXT.calFailed, none: PROACTIVE_TEXT.calNone, not_connected: PROACTIVE_TEXT.calNotConnected };

/**
 * PRO-1「主動提醒」：總開關、天氣開關、時段與地點（下拉選單）、最近一次查天氣的狀態（不含天氣內容）與資料出處。
 * 改了就保存（POST /api/settings/proactive）。
 */
export function renderProactiveSettings(view: ProactiveSettingsView, actions: ViewActions): HTMLElement {
  const prefs = view.prefs;
  const list = h("ul", { class: "pref-list" });
  const toggle = (label: string, note: string, on: boolean, patch: ProactivePrefsPatch, enabled = true) => {
    const b = button(on ? "開" : "關", () => actions.updateProactive?.(patch), on ? "btn--primary" : "");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", t("{0}：{1}", t(label), on ? t("開") : t("關")));
    b.disabled = !actions.updateProactive || !enabled;
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label)), h("span", { class: "muted small" }, t(note))), b));
  };
  const select = (label: string, options: { value: string; label: string; disabled?: boolean }[], current: string, patch: (value: string) => ProactivePrefsPatch) => {
    const el = h("select", { "aria-label": t(label) }) as HTMLSelectElement;
    for (const o of options) {
      const opt = h("option", { value: o.value }, o.label) as HTMLOptionElement;
      if (o.value === current) {
        opt.setAttribute("selected", "");
        opt.selected = true;
      }
      opt.disabled = o.disabled === true;
      el.append(opt);
    }
    el.disabled = !actions.updateProactive;
    el.addEventListener("change", () => {
      if (el.value !== current) actions.updateProactive?.(patch(el.value));
    });
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label))), el));
  };
  toggle(PROACTIVE_TEXT.enabled, PROACTIVE_TEXT.enabledNote, prefs.enabled, { enabled: !prefs.enabled });
  toggle(PROACTIVE_TEXT.weather, PROACTIVE_TEXT.weatherNote, prefs.weather, { weather: !prefs.weather }, prefs.enabled);
  if (view.calendar) toggle(PROACTIVE_TEXT.calendar, PROACTIVE_TEXT.calendarNote, prefs.calendar !== false, { calendar: prefs.calendar === false }, prefs.enabled);
  const hour = (n: number) => t(PROACTIVE_TEXT.hour, n);
  select(PROACTIVE_TEXT.start, view.start_hours.map((n) => ({ value: String(n), label: hour(n), disabled: n >= prefs.end_hour })), String(prefs.start_hour), (v) => ({ start_hour: Number(v) }));
  select(PROACTIVE_TEXT.end, view.end_hours.map((n) => ({ value: String(n), label: hour(n), disabled: n <= prefs.start_hour })), String(prefs.end_hour), (v) => ({ end_hour: Number(v) }));
  const auto = view.place?.auto ? t(PROACTIVE_TEXT.auto, t(view.place.label)) : t(PROACTIVE_TEXT.autoNone);
  select(PROACTIVE_TEXT.place, [{ value: "", label: auto }, ...view.places.map((p) => ({ value: p.id, label: t(p.label) }))], prefs.place ?? "", (v) => ({ place: (v || null) as ProactivePrefs["place"] }));
  return h(
    "section",
    { class: "camera-settings proactive-settings" },
    h("h3", {}, t(PROACTIVE_TEXT.group)),
    list,
    !view.place && h("p", { class: "muted small" }, t(PROACTIVE_TEXT.noPlace)),
    h("p", { class: "muted small", role: "status" }, t(PROACTIVE_STATE[view.weather.state])),
    view.calendar && h("p", { class: "muted small", role: "status" }, t(CALENDAR_STATE[view.calendar.state])),
  );
}

/** CLK-1「右上角時鐘與天氣」：Mac 視窗與 Pi 終端機各一個開關；改了就保存（POST /api/settings/clock）。 */
export function renderClockSettings(view: ClockSettingsView, actions: ViewActions): HTMLElement {
  const list = h("ul", { class: "pref-list" });
  const toggle = (label: string, note: string, on: boolean, patch: ClockPrefsPatch) => {
    const b = button(on ? "開" : "關", () => actions.updateClock?.(patch), on ? "btn--primary" : "");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", t("{0}：{1}", t(label), on ? t("開") : t("關")));
    b.disabled = !actions.updateClock;
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label)), h("span", { class: "muted small" }, t(note))), b));
  };
  toggle(CLOCK_TEXT.main, CLOCK_TEXT.mainNote, view.prefs.main, { main: !view.prefs.main });
  toggle(CLOCK_TEXT.terminal, CLOCK_TEXT.terminalNote, view.prefs.terminal, { terminal: !view.prefs.terminal });
  return h("section", { class: "camera-settings clock-settings" }, h("h3", {}, t(CLOCK_TEXT.group)), list, h("p", { class: "muted small" }, t(CLOCK_TEXT.note)));
}

/**
 * ALARM-1「鬧鐘與定時器」（George 2026-11-09）：開關（關掉＝不提供工具、不排程、不響，已建立的保留）與「清除全部」。
 * 定時器本身用說的建立；這裡只列出目前的定時器數量，不是常駐清單。
 */
export function renderAlarmSettings(view: AlarmsView, actions: ViewActions): HTMLElement {
  const on = view.prefs.enabled;
  const b = button(on ? "開" : "關", () => actions.updateAlarms?.({ enabled: !on }), on ? "btn--primary" : "");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", t("{0}：{1}", t("鬧鐘與定時器"), on ? t("開") : t("關")));
  b.disabled = !actions.updateAlarms;
  const clear = button("清除全部", () => actions.clearAlarms?.(), "btn--ghost");
  clear.disabled = !actions.clearAlarms;
  clear.setAttribute("data-alarm-clear", "");
  const count = view.timers.length + view.alarms.length;
  // ALARM-2：鬧鐘清單只在設定頁（不是常駐畫面）：時間、重複、開關與刪除，以及新增一個。
  const alarmRows = view.alarms.map((a) => {
    const toggle = button(a.enabled ? "開" : "關", () => actions.setAlarmEnabled?.(a.id, !a.enabled), a.enabled ? "btn--primary" : "");
    toggle.setAttribute("aria-pressed", String(a.enabled));
    toggle.setAttribute("aria-label", t("{0}：{1}", `${a.time}${a.label ? ` ${a.label}` : ""}`, a.enabled ? t("開") : t("關")));
    toggle.disabled = !actions.setAlarmEnabled || !on;
    const del = button("刪除", () => actions.deleteAlarm?.(a.id), "btn--ghost");
    del.disabled = !actions.deleteAlarm || !on;
    const when = a.days.length ? repeatText(a.days, getLocale() === "en" ? "en" : "zh-TW") : a.date ?? "";
    const next = a.next_at !== null ? t("下一次 {0}", new Date(a.next_at).toLocaleString(getLocale() === "en" ? "en-US" : "zh-TW", { timeZone: view.time_zone, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })) : t("不會響");
    return h("li", { class: "pref", "data-alarm-id": a.id }, h("div", { class: "provider-text" }, h("strong", {}, `${a.time}${a.label ? `　${a.label}` : ""}`), h("span", { class: "muted small" }, `${when} · ${next}`)), h("div", { class: "actions" }, toggle, del));
  });
  const time = h("input", { type: "time", value: "07:00", "aria-label": t("鬧鐘時間") }) as HTMLInputElement;
  const repeat = h("select", { "aria-label": t("重複") }) as HTMLSelectElement;
  for (const [value, label] of [["once", "單次"], ["daily", "每天"], ["weekdays", "工作日"], ["weekends", "週末"]] as const) repeat.append(h("option", { value }, t(label)));
  const label = h("input", { type: "text", maxlength: "40", placeholder: t("名字（可不填）"), "aria-label": t("鬧鐘名字") }) as HTMLInputElement;
  const add = button("新增鬧鐘", () => actions.addAlarm?.({ time: time.value, repeat: repeat.value, label: label.value }), "btn--primary");
  add.disabled = !actions.addAlarm || !on;
  // ALARM-3：鈴聲（三種，可試聽）與響多久。
  const TONE_TEXT: Record<RingTone, [string, string]> = {
    classic: ["經典短嗶", "四聲短嗶，清楚但不刺耳"],
    chime: ["柔和鐘聲", "三個下行的鐘聲，比較溫和"],
    pulse: ["急促電子音", "快速的高音短嗶，最容易叫醒"],
  };
  const toneRows = RING_TONES.map((tone) => {
    const selected = view.prefs.ring_tone === tone;
    const pick = button(selected ? "使用中" : "使用", () => actions.updateAlarms?.({ ring_tone: tone }), selected ? "btn--primary" : "");
    pick.setAttribute("aria-pressed", String(selected));
    pick.setAttribute("aria-label", t("{0}：{1}", t(TONE_TEXT[tone][0]), selected ? t("使用中") : t("使用")));
    pick.disabled = !actions.updateAlarms || !on;
    const listen = button("試聽", () => actions.previewTone?.(tone), "btn--ghost");
    listen.setAttribute("aria-label", t("試聽 {0}", t(TONE_TEXT[tone][0])));
    listen.disabled = !actions.previewTone;
    return h("li", { class: "pref", "data-ring-tone": tone }, h("div", { class: "provider-text" }, h("strong", {}, t(TONE_TEXT[tone][0])), h("span", { class: "muted small" }, t(TONE_TEXT[tone][1]))), h("div", { class: "actions" }, listen, pick));
  });
  const length = h("select", { "aria-label": t("響鈴長度") }) as HTMLSelectElement;
  for (const s of RING_LENGTH_CHOICES) {
    const opt = h("option", { value: String(s) }, t("{0} 分鐘", s / 60)) as HTMLOptionElement;
    if (s === view.prefs.ring_s) {
      opt.setAttribute("selected", "");
      opt.selected = true;
    }
    length.append(opt);
  }
  if (!(RING_LENGTH_CHOICES as readonly number[]).includes(view.prefs.ring_s)) {
    const opt = h("option", { value: String(view.prefs.ring_s) }, t("{0} 秒", view.prefs.ring_s)) as HTMLOptionElement;
    opt.selected = true;
    length.prepend(opt);
  }
  length.disabled = !actions.updateAlarms || !on;
  length.addEventListener("change", () => actions.updateAlarms?.({ ring_s: Number(length.value) }));
  return h(
    "section",
    { class: "camera-settings alarm-settings" },
    h("h3", {}, t("鬧鐘與定時器")),
    h(
      "ul",
      { class: "pref-list" },
      h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t("鬧鐘與定時器")), h("span", { class: "muted small" }, t("用說的設定（「計時 10 分鐘」「泡麵 3 分鐘」）；時間到時在建立的那台響，那台不在線時每個畫面都響。關掉後不響，已建立的保留。"))), b),
      h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t("清除全部")), h("span", { class: "muted small" }, count ? t("目前有 {0} 個定時器或鬧鐘；清除會一併停止響鈴與刪掉紀錄。", count) : t("刪掉所有定時器、鬧鐘、響鈴與紀錄。"))), clear),
    ),
    h("h4", {}, t("鈴聲")),
    h("ul", { class: "pref-list" }, ...toneRows, h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t("響鈴長度")), h("span", { class: "muted small" }, t("時間到後響多久；沒人停就自動停止並記錄。"))), length)),
    h("p", { class: "muted small" }, t("到期前 30 秒畫面開始倒數，最後 10 秒每秒「滴」一聲（只在會響的那台）。")),
    h("h4", {}, t("鬧鐘清單")),
    alarmRows.length ? h("ul", { class: "pref-list alarm-list" }, ...alarmRows) : h("p", { class: "muted small" }, t("還沒有鬧鐘。可以說「明天早上 7 點叫我」「每個工作天 6:30 叫我」，或在下面新增。")),
    h("div", { class: "alarm-add" }, time, repeat, label, add),
    h("p", { class: "muted small" }, t("響鈴的音量跟這台裝置的對話音量（日間／夜間）；{0} 秒內由小漸強，響 {1} 分鐘沒人停就自動停止並記錄。", view.prefs.ramp_s, Math.round(view.prefs.ring_s / 60))),
    h("p", { class: "muted small" }, t("鬧鐘不會比 {0}% 更小聲；貪睡 {1} 分鐘。鬧鐘用這台 Mac 的時區（{2}）。", view.prefs.alarm_min_volume, Math.round(view.prefs.snooze_s / 60), view.time_zone)),
  );
}

/** HOME-1「左上角家中狀態」：Mac 視窗與 Pi 終端機各一個開關；改了就保存（POST /api/settings/home-corner）。 */
export function renderHomeCornerSettings(view: HomeCornerSettingsView, actions: ViewActions): HTMLElement {
  const list = h("ul", { class: "pref-list" });
  const toggle = (label: string, note: string, on: boolean, patch: HomeCornerPrefsPatch) => {
    const b = button(on ? "開" : "關", () => actions.updateHomeCorner?.(patch), on ? "btn--primary" : "");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", t("{0}：{1}", t(label), on ? t("開") : t("關")));
    b.disabled = !actions.updateHomeCorner;
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label)), h("span", { class: "muted small" }, t(note))), b));
  };
  toggle(HOME_CORNER_TEXT.main, HOME_CORNER_TEXT.mainNote, view.prefs.main, { main: !view.prefs.main });
  toggle(HOME_CORNER_TEXT.terminal, HOME_CORNER_TEXT.terminalNote, view.prefs.terminal, { terminal: !view.prefs.terminal });
  return h("section", { class: "camera-settings home-corner-settings" }, h("h3", {}, t(HOME_CORNER_TEXT.group)), list, h("p", { class: "muted small" }, t(HOME_CORNER_TEXT.note)));
}

/** MEMO-1「回憶模式」：總開關、影片聲音、停留與閒置秒數、來源狀態（只有數量）。改了就保存（POST /api/settings/memories）。 */
export function renderMemoriesSettings(view: MemoriesSettingsView, actions: ViewActions, desktop: boolean): HTMLElement {
  const prefs = view.prefs;
  const list = h("ul", { class: "pref-list" });
  const toggle = (label: string, note: string, on: boolean, patch: MemoriesPrefsPatch, enabled = true) => {
    const b = button(on ? "開" : "關", () => actions.updateMemories?.(patch), on ? "btn--primary" : "");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", t("{0}：{1}", t(label), on ? t("開") : t("關")));
    b.disabled = !actions.updateMemories || !enabled;
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label)), h("span", { class: "muted small" }, t(note))), b));
  };
  const select = (label: string, options: readonly number[], current: number, patch: (value: number) => MemoriesPrefsPatch) => {
    const el = h("select", { "aria-label": t(label) }) as HTMLSelectElement;
    for (const n of options) {
      const d = durationLabel(n);
      const opt = h("option", { value: String(n) }, t(d.text, d.value)) as HTMLOptionElement;
      if (n === current) {
        opt.setAttribute("selected", "");
        opt.selected = true;
      }
      el.append(opt);
    }
    el.disabled = !actions.updateMemories || !prefs.enabled;
    el.addEventListener("change", () => {
      if (Number(el.value) !== current) actions.updateMemories?.(patch(Number(el.value)));
    });
    list.append(h("li", { class: "pref" }, h("div", { class: "provider-text" }, h("strong", {}, t(label))), el));
  };
  toggle(MEMORIES_TEXT.enabled, MEMORIES_TEXT.enabledNote, prefs.enabled, { enabled: !prefs.enabled });
  toggle(MEMORIES_TEXT.videoSound, MEMORIES_TEXT.videoSoundNote, prefs.video_sound, { video_sound: !prefs.video_sound }, prefs.enabled);
  select(MEMORIES_TEXT.dwell, view.dwell_options, prefs.dwell_s, (v) => ({ dwell_s: v as MemoriesSettingsView["prefs"]["dwell_s"] }));
  select(MEMORIES_TEXT.idle, view.idle_options, prefs.idle_s, (v) => ({ idle_s: v as MemoriesSettingsView["prefs"]["idle_s"] }));
  return h(
    "section",
    { class: "camera-settings memories-settings" },
    h("h3", {}, t(MEMORIES_TEXT.group)),
    list,
    h("p", { class: "muted small", role: "status" }, t(MEMORIES_STATE_TEXT[view.source.state], view.source.photos, view.source.videos)),
    view.google && renderMemoriesGoogle(view.google, actions, desktop),
  );
}

/** 「清除 Google 快取」按第一次後的確認期限（重新繪製時保留）。 */
let googleClearArmedUntil = 0;
const GOOGLE_CLEAR_CONFIRM_MS = 5_000;

/** MEMO-2「Google 相簿」：快取狀態、挑選（QR code 給手機掃描）、下載進度、取消與清除。Pi 頁面與 Mac 頁面都能挑選。 */
function renderMemoriesGoogle(g: MemoriesGoogleView, actions: ViewActions, desktop: boolean): HTMLElement {
  const busy = googlePickBusy(g.phase);
  const status = g.available
    ? t(MEMORIES_TEXT.googleStatus, g.photos, g.videos, formatCacheSize(g.bytes))
    : t(MEMORIES_TEXT.googleUnavailable, t(g.unavailable_reason ?? ""));
  const pick = button(MEMORIES_TEXT.googlePick, () => actions.memoriesGoogle?.("pick"), "btn--primary");
  pick.disabled = !actions.memoriesGoogle || !g.available || busy;
  const armed = () => Date.now() < googleClearArmedUntil;
  const clear = button(armed() ? MEMORIES_TEXT.googleClearConfirm : MEMORIES_TEXT.googleClear, () => {
    if (armed()) {
      googleClearArmedUntil = 0;
      actions.memoriesGoogle?.("clear");
      return;
    }
    googleClearArmedUntil = Date.now() + GOOGLE_CLEAR_CONFIRM_MS;
    clear.textContent = t(MEMORIES_TEXT.googleClearConfirm);
    setTimeout(() => {
      if (!armed()) clear.textContent = t(MEMORIES_TEXT.googleClear);
    }, GOOGLE_CLEAR_CONFIRM_MS);
  });
  clear.disabled = !actions.memoriesGoogle || g.photos + g.videos === 0;
  const buttons = h("div", { class: "actions" }, pick, busy && button(MEMORIES_TEXT.googleCancel, () => actions.memoriesGoogle?.("cancel")), clear);

  let phaseLine: string | null = null;
  if (g.phase === "starting") phaseLine = t(MEMORIES_TEXT.googleStarting);
  else if (g.phase === "downloading" && g.progress) phaseLine = t(MEMORIES_TEXT.googleProgress, g.progress.done, g.progress.total);
  else if (g.phase === "done" && g.progress) phaseLine = t(MEMORIES_TEXT.googleDone, g.progress.done, g.progress.skipped);
  else if (g.phase === "cancelled") phaseLine = t(MEMORIES_TEXT.googleCancelled);

  let waiting: HTMLElement | null = null;
  if (g.phase === "waiting_pick" && g.picker_uri) {
    const uri = g.picker_uri;
    const expires = g.expires_at === null ? null
      : new Date(g.expires_at).toLocaleTimeString(getLocale() === "en" ? "en-US" : "zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    waiting = h(
      "div",
      { class: "memories-google-pick" },
      h("img", { src: g.paths.qr, alt: t(MEMORIES_TEXT.googleQrAlt), width: "200", height: "200" }),
      h("p", { class: "muted small" }, t(MEMORIES_TEXT.googleScanHint)),
      // 網址是資料（可選取複製），不翻譯。
      h("p", { class: "small" }, h("code", {}, uri)),
      expires && h("p", { class: "muted small" }, t(MEMORIES_TEXT.googleExpires, expires)),
      desktop && actions.openExternal && button(MEMORIES_TEXT.googleOpen, () => actions.openExternal?.(uri)),
    );
  }
  return h(
    "div",
    { class: "memories-google" },
    h("h4", {}, t(MEMORIES_TEXT.googleGroup)),
    h("p", { class: "muted small", role: "status" }, status),
    phaseLine && h("p", { class: "muted small", role: "status" }, phaseLine),
    g.error && h("p", { class: "error-text" }, t(g.error)),
    waiting,
    buttons,
    h("p", { class: "muted small" }, t(MEMORIES_TEXT.googleNoSync)),
    h("p", { class: "muted small" }, t(MEMORIES_TEXT.googleNoPlace)),
  );
}

/** 鏡頭與手勢：逐項走 CAMERA_PREFS（順序、標籤、提示、範圍都從那裡來）。 */
function renderCameraSettings(camera: CameraSettings, realtimeAvailable: boolean, actions: ViewActions, terminal = false): HTMLElement {
  const title = h("h3", {}, t("鏡頭與手勢"));
  if (!camera.enabled) {
    return h("section", { class: "camera-settings" }, title, h("p", { class: "muted small" }, t("鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）。")));
  }
  const list = h("ul", { class: "pref-list" });
  for (const key of CAMERA_PREF_KEYS) {
    const spec = CAMERA_PREFS[key];
    let control: HTMLElement;
    if (spec.kind === "bool") {
      const on = camera[key] as boolean;
      control = button(on ? t("開") : t("關"), () => actions.updateCamera({ [key]: !on }), on ? "btn--primary" : "");
      control.setAttribute("aria-pressed", String(on));
      control.setAttribute("aria-label", `${t(spec.label)}：${on ? t("開") : t("關")}`);
    } else {
      const k = key as CameraNumberKey;
      const value = camera[k];
      const minus = button("−", () => actions.updateCamera({ [k]: stepCameraPref(k, value, -1) }));
      const plus = button("+", () => actions.updateCamera({ [k]: stepCameraPref(k, value, 1) }));
      minus.disabled = value <= spec.min;
      plus.disabled = value >= spec.max;
      minus.setAttribute("aria-label", msg`${t(spec.label)}減少`);
      plus.setAttribute("aria-label", msg`${t(spec.label)}增加`);
      const shown = spec.kind === "seconds" ? msg`${value} 秒` : t(formatNumberPref(spec, value));
      control = h("div", { class: "stepper" }, minus, h("span", { class: "stepper-value" }, shown), plus);
    }
    const hint = key === "look_to_talk" && !realtimeAvailable ? msg`${t(spec.hint)}；需要即時語音（目前不可用）` : t(spec.hint);
    list.append(
      h(
        "li",
        // 秒數與「看著說話時先打招呼」都是看著說話的子項，縮排顯示。
        { class: `pref${spec.kind === "seconds" || key === "look_to_talk_greet" || key === "look_to_talk_greet_name" ? " pref--sub" : ""}` },
        h("div", { class: "provider-text" }, h("strong", {}, t(spec.label)), h("span", { class: "muted small" }, hint)),
        control,
      ),
    );
  }
  return h(
    "section",
    { class: "camera-settings" },
    title,
    terminal && h("p", { class: "muted small" }, t(TERMINAL_CAMERA_SCOPE)),
    list,
    h("div", { class: "actions" }, button(t("顯示鏡頭畫面"), actions.openCameraPreview)),
    h(
      "p",
      { class: "muted small" },
      msg`安裝（.env）：${camera.label} · ${camera.left_first ? t("左半為左眼") : t("右半為左眼")} · 螢幕寬 ${camera.screen_width_mm} mm · 鏡頭偏移 ${camera.screen_offset_mm} mm`,
    ),
  );
}

export function renderNotice(message: string, actions: ViewActions): HTMLElement {
  return surfaceShell("notice", h("p", { class: "notice-text" }, t(message)), footer(actions));
}

/**
 * 即時語音的查詢結果（docs/10 §5 的例外，George 2026-11-09）：候選、選定那一則的重點（念到的那一點亮起）或失敗。
 * 標題、網站與重點都是資料（不翻譯）；查詢詞是模型寫的查詢。錯誤顯示分類後翻譯過的固定句（核心原文是中文）。
 */
export function renderSearch(panel: SearchPanel, actions: ViewActions): HTMLElement {
  const close = h(
    "footer",
    { class: "surface-footer" },
    button(t("收起"), actions.dismiss, "btn--ghost"),
    h("span", { class: "hint" }, t(SEARCH_TEXT.dismissHint)),
  );
  let body: HTMLElement[];
  if (panel.mode === "candidates") {
    const list = h("ol", { class: "search-candidates" });
    for (const c of panel.candidates) {
      const badge = h("span", { class: "search-badge" }, String(c.n));
      badge.setAttribute("aria-label", t(SEARCH_TEXT.badge, c.n));
      list.append(h(
        "li",
        { class: "search-candidate", "data-selectable": "", "data-label": c.title },
        badge,
        h("div", { class: "search-candidate-text" }, h("p", { class: "search-title" }, raw(c.title)), h("p", { class: "search-host" }, raw(c.host), ...uncitedNote(c.cited))),
      ));
    }
    body = [h("p", { class: "eyebrow search-eyebrow" }, t(SEARCH_TEXT.candidatesEyebrow)), h("p", { class: "search-query" }, raw(panel.query)), list];
  } else if (panel.mode === "reading") {
    const c = panel.candidate;
    const points = c.summarized
      ? h("ol", { class: "search-points", "aria-label": SEARCH_TEXT.points }, ...c.points.map((p, i) => h(
        "li",
        { class: `search-point${panel.active === i ? " is-active" : panel.active !== null ? " is-dim" : ""}`, ...(panel.active === i ? { "aria-current": "true" } : {}) },
        raw(p),
      )))
      : h("p", { class: "search-unsummarized" }, t(SEARCH_TEXT.unsummarized));
    body = [
      h("p", { class: "eyebrow search-eyebrow" }, t(SEARCH_TEXT.readingEyebrow, c.n)),
      h("h2", { class: "search-title" }, raw(c.title)),
      points,
      h("p", { class: "search-host" }, h("span", { class: "search-source-label" }, t(SEARCH_TEXT.source)), " ", raw(c.host), ...uncitedNote(c.cited)),
    ];
  } else {
    body = [
      h("p", { class: "eyebrow search-eyebrow" }, t(SEARCH_TEXT.failedEyebrow)),
      h("p", { class: "search-query" }, raw(panel.query)),
      h("p", { class: "search-error" }, t(SEARCH_ERROR_TEXT[panel.error])),
    ];
  }
  return h("section", { class: `surface surface--search surface--search-${panel.mode}`, role: "region", "aria-label": SEARCH_TEXT.region }, ...body, close);
}

/** 這次查詢沒有回來源（citations），網址只是模型寫的：照樣顯示，但註明沒有核對。 */
function uncitedNote(cited: boolean | undefined): (HTMLElement | string)[] {
  return cited === false ? [" · ", h("span", { class: "search-uncited" }, t(SEARCH_TEXT.uncited))] : [];
}

/** 跟讀：只換亮起的那一點，不重建畫面（念的時候每個片段都可能換點）；視窗矮時把亮起的那一點捲進畫面。 */
export function applySearchHighlight(root: ParentNode, active: number | null): void {
  root.querySelectorAll<HTMLElement>(".search-point").forEach((el, i) => {
    el.classList.toggle("is-active", active === i);
    el.classList.toggle("is-dim", active !== null && active !== i);
    if (active === i) {
      el.setAttribute("aria-current", "true");
      el.scrollIntoView?.({ block: "nearest" });
    } else el.removeAttribute("aria-current");
  });
}

export type ConfirmDetail =
  | { kind: "mcp"; server: string; name: string; arguments: string; expiresAt: number }
  | { kind: "home"; device: string; room: string | null; action: string; expiresAt: number };

/** 確認卡：遠處也看得到動作、對象與參數；用說的確認，不需要按任何東西。 */
export function renderConfirm(detail: ConfirmDetail): HTMLElement {
  const remaining = Math.max(0, Math.round((detail.expiresAt - Date.now()) / 1000));
  let eyebrow = t("請確認");
  let title: string;
  let body: HTMLElement | null = null;
  if (detail.kind === "home") {
    eyebrow = t("請確認 · 武陵居家電");
    const where = detail.room && !detail.device.includes(detail.room) ? `${detail.room} ${detail.device}` : detail.device;
    title = `${where}：${t(detail.action)}`;
  } else {
    let args = detail.arguments;
    try {
      args = JSON.stringify(JSON.parse(detail.arguments), null, 2);
    } catch {
      // 保留原文
    }
    title = `${detail.server} · ${detail.name}`;
    body = h("pre", { class: "confirm-args" }, raw(args.slice(0, 1200)));
  }
  return surfaceShell(
    "confirm",
    h(
      "header",
      { class: "surface-header confirm-head" },
      confirmIcon(88),
      h("div", {}, h("p", { class: "eyebrow confirm-eyebrow" }, eyebrow), h("h2", {}, raw(title))),
    ),
    ...(body ? [body] : []),
    h(
      "p",
      { class: "confirm-say" },
      t("說「"),
      h("strong", {}, t("確認執行")),
      t("」執行，說「"),
      h("strong", {}, t("取消")),
      t("」放棄"),
    ),
    h("p", { class: "muted small" }, t("只說「好」不算。"), h("span", { class: "confirm-countdown", "data-expires": String(detail.expiresAt) }, msg`${remaining} 秒`), t(" 後沒有回應會自動取消。")),
  );
}

/** 每秒更新確認卡的倒數。 */
export function refreshCountdowns(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".confirm-countdown").forEach((el) => {
    const expires = Number(el.dataset.expires);
    if (Number.isFinite(expires)) el.textContent = msg`${Math.max(0, Math.round((expires - Date.now()) / 1000))} 秒`;
  });
}

/** SP-1：服務的顯示名稱（Adapter ID → 固定句）。 */
const INTEGRATION_LABEL: Record<string, string> = {
  spotify_soloist: "Pi 上的 Spotify 播放器",
  gmail_gog: "寄信給自己（Gmail，gog）",
  home: "武陵居家電（中控）",
  google_calendar: "Google 日曆（gog）",
  lg_tv: "客廳 LG 電視",
  mock: "模擬整合（mock，測試用）",
};

const HEALTH_TEXT: Record<IntegrationServiceStatus["health"], string> = {
  available: "可用",
  unavailable: "不可用",
  unknown: "狀態不明",
};

/** 原因代碼 → 固定句（核心只給代碼，沒有網址、帳號或播放內容）。 */
const HEALTH_REASON_TEXT: Record<IntegrationServiceStatus["reason"], string> = {
  ok: "已連線",
  not_configured: "沒有啟用",
  connection_refused: "連不上（Pi 離線、SSH 通道中斷、Soloist 沒有執行或版本已過期）",
  connection_closed: "連線在回報前中斷",
  timeout: "沒有在時限內回覆",
  bad_reply: "回覆的格式看不懂",
  expired: "版本已過期",
  taken_over: "已登入，但不是目前使用中的 Spotify 播放裝置",
  not_ready: "Soloist 沒有登入 Spotify",
  error: "檢查時出錯",
  unreachable: "連不上（電視可能關機待機或不在網路上）",
  not_paired: "還沒配對（在 Mac 上執行 npm run tv:pair）",
};

/**
 * SP-1：設定頁「App 整合」段。打開設定頁時查一次（30 秒內不重查），「重新檢查」強制再查。
 * 只畫核心回的健康與原因代碼；available 只在核心實際連上並確認時出現。
 */
export function renderIntegrationStatus(state: IntegrationPanelState, actions: ViewActions): HTMLElement {
  const rows: Child[] = [];
  if (state.error) rows.push(h("p", { class: "error-text small" }, t("查不到整合服務的狀態（核心沒有回覆）。")));
  else if (!state.view) rows.push(h("p", { class: "muted small" }, t("正在檢查…")));
  else if (!state.view.services.length) rows.push(h("p", { class: "muted small" }, t("沒有啟用任何整合服務。")));
  else {
    const list = h("ul", { class: "provider-list" });
    for (const s of state.view.services) {
      const label = t(INTEGRATION_LABEL[s.service] ?? s.service);
      const time = s.checked_at ? new Date(s.checked_at).toLocaleTimeString(getLocale() === "en" ? "en-US" : "zh-TW", { hour12: false }) : null;
      list.append(
        h(
          "li",
          { class: "provider" },
          h(
            "div",
            { class: "provider-text" },
            h("strong", {}, label),
            h("span", { class: "muted small" }, msg`${t(HEALTH_TEXT[s.health])}：${t(HEALTH_REASON_TEXT[s.reason])}`),
            time && h("span", { class: "muted small" }, msg`檢查時間：${time}`),
            s.service === "spotify_soloist" && h("span", { class: "muted small" }, t("只顯示狀態；Spotify 語音控制沒有取得授權，沒有開放。")),
            s.service === "gmail_gog" && h("span", { class: "muted small" }, t("「可用」只代表 Mac 上的 gog 能執行；有沒有登入 Gmail，要看寄信的結果。")),
            s.service === "google_calendar" && h("span", { class: "muted small" }, t("「可用」只代表 Mac 上的 gog 能執行；有沒有授權 Google 日曆，要看查行程的結果。")),
            s.service === "lg_tv" && h("span", { class: "muted small" }, t("電視待機時連不上是正常的；說「開電視」會用網路喚醒。")),
          ),
          h("span", { class: `chip${s.health === "available" ? " chip--running" : ""}` }, t(HEALTH_TEXT[s.health])),
        ),
      );
    }
    rows.push(list);
  }
  return h(
    "section",
    { class: "camera-settings", "aria-label": t("App 整合") },
    h("h3", {}, t("App 整合")),
    ...rows,
    actions.refreshIntegrations && h("div", { class: "actions" }, button(state.loading ? t("檢查中…") : t("重新檢查"), () => actions.refreshIntegrations?.())),
  );
}

// ───────────── VCR-2：語音中繼（實驗）診斷區 ─────────────

/** 設定頁「語音中繼（實驗）」段的狀態（打開設定頁、核心註冊了 voice_relay 時才查；不在背景輪詢）。 */
export interface VoiceRelayPanelState {
  view: VoiceRelayView | null;
  loading: boolean;
  /** 查詢本身失敗：照實說查不到，不拿舊結果當成現在。 */
  error: boolean;
  /** 有操作在等核心回覆（播放、保存）：按鈕暫停，避免重複送出。 */
  busy: boolean;
  /** 最近一次操作的固定句（中文原文，畫面再翻譯；不含使用者資料）。 */
  notice: string | null;
  /** 試聽用聲線（只在這頁有效）：目標 id → 聲線 id；沒有時用目標選定的聲線。 */
  chosen: Record<string, string>;
  /** 「新增 Google Home Mini」表單選的語言（決定聲音清單）。 */
  createLocale: VoiceRelayLocale;
  /** 最近一次「預覽文字」的結果。 */
  preview: { target_id: string; intent_id: IntentId; template_id: string; result: VoiceRelayPreview } | null;
  /** 最近一次播放（只由「測試喚醒／測試整句」按鈕觸發）。 */
  played: VoiceRelayPlayed | null;
  /** 試驗紀錄的草稿（播放整句後才出現）。 */
  trial: VoiceRelayTrialDraft;
}

export type VoiceRelayLocale = "zh-TW" | "en-US";

export interface VoiceRelayPlayed {
  target_id: string;
  intent_id: IntentId;
  template_id: string;
  template_version: number;
  voice_profile_id: string;
  part: VoiceRelayPart;
  status: ToolResultStatus;
  /** 診斷解析被拒絕時的原因（固定代碼）。 */
  reason: RelayRefusal | null;
}

export interface VoiceRelayTrialDraft {
  wake: RelayTrial["wake"] | null;
  command: RelayTrial["command"] | null;
  evidence: "visual" | "human_confirmed";
}

export function emptyVoiceRelayPanel(): VoiceRelayPanelState {
  return { view: null, loading: false, error: false, busy: false, notice: null, chosen: {}, createLocale: "zh-TW", preview: null, played: null, trial: { wake: null, command: null, evidence: "visual" } };
}

/** 診斷區的動作（main.ts 實作；全部只由使用者按鈕觸發，沒有自動播放）。 */
export interface VoiceRelayActions {
  refresh(): void;
  createTarget(body: VoiceRelayTargetBody): void;
  setEnabled(targetId: string, enabled: boolean): void;
  chooseProfile(targetId: string, profileId: string): void;
  saveProfile(body: VoiceRelayProfileBody): void;
  setCreateLocale(locale: VoiceRelayLocale): void;
  preview(body: VoiceRelayPreviewBody): void;
  play(body: VoiceRelayPlayBody): void;
  adopt(body: VoiceRelayAdoptBody): void;
  unadopt(body: VoiceRelayUnadoptBody): void;
  setTrial(patch: Partial<VoiceRelayTrialDraft>): void;
  recordTrial(body: VoiceRelayTrialBody): void;
}

/** 拒絕原因 → 固定句（核心只給代碼）。 */
export const RELAY_REFUSAL_TEXT: Record<RelayRefusal, string> = {
  unknown_target: "找不到這個目標",
  target_disabled: "這個目標已停用",
  unsupported_intent: "這個目標不支援這個命令",
  invalid_slots: "命令的參數不對",
  ambiguous_template: "有不只一組說法符合，沒有播放",
  not_reviewed: "這組說法還沒有採用",
  policy_blocked: "政策不允許（例如 Spotify 或音樂服務不明）",
  tts_unavailable: "這台機器沒有這個聲音",
  output_unavailable: "找不到指定的喇叭",
  diagnostic_invalid: "診斷選的說法或聲線不屬於這個目標",
};

/** 播放結果 → 固定句。永遠不說「成功」：音箱有沒有照做沒有回讀。 */
const RELAY_PLAY_TEXT: Record<ToolResultStatus, string> = {
  confirmed: "已發出語音命令，結果未確認",
  unconfirmed: "已發出語音命令，結果未確認",
  unknown: "結果不明：可能已播出一部分，也可能沒有",
  needs_confirmation: "需要確認，沒有播放",
  refused: "沒有播放（被拒絕）",
  failed: "播放失敗，沒有發出聲音",
};

const RELAY_INTENT_LABEL: Record<IntentId, string> = {
  "music.next": "下一首",
  "music.pause": "暫停音樂",
  "music.resume": "繼續播放音樂",
  "music.play_genre": "播放某類音樂",
  "volume.set": "設定音量",
  "light.power": "開關燈",
  "light.brightness": "調整燈的亮度",
  "assistant.timer": "計時器",
};

const RELAY_GENRE_LABEL: Record<(typeof GENRES)[number], string> = {
  pop: "流行",
  jazz: "爵士",
  classical: "古典",
  rock: "搖滾",
  lofi: "Lo-fi",
  kids: "兒歌",
};

const RELAY_MUSIC_LABEL: Record<MusicService, string> = {
  youtube_music: "YouTube Music",
  apple_music: "Apple Music",
  spotify: "Spotify",
  other: "其他",
  unknown: "不知道",
};

const RELAY_LOCALE_LABEL: Record<VoiceRelayLocale, string> = { "zh-TW": "中文（台灣）", "en-US": "英文（美國）" };

const relayRate = (r: Rate): string => (r.den === 0 ? "N/A" : `${r.num}/${r.den}`);

/** 試驗統計：分母是 0 寫 N/A，沒有任何已審閱的正向試驗寫「未測試」，不捏造數字。 */
export function relayTrialSummaryText(summary: TrialSummary | undefined): string {
  if (!summary || summary.status === "NOT_TESTED") return t("未測試");
  return t("喚醒 {0}、命令 {1}、整體 {2}", relayRate(summary.wakeRate), relayRate(summary.commandRate), relayRate(summary.endToEndRate));
}

function relaySelect(label: string, options: [string, string][], selected: string | null, onChange?: (value: string) => void): HTMLSelectElement {
  const select = h("select", { "aria-label": label });
  for (const [value, text] of options) {
    const o = h("option", { value }, text);
    if (value === selected) o.setAttribute("selected", "");
    (o as HTMLOptionElement).selected = value === selected;
    select.append(o);
  }
  if (selected !== null) select.value = selected;
  if (onChange) select.addEventListener("change", () => onChange(select.value));
  return select;
}

function relayNumber(label: string, value: number, min: number, max: number, step: number): HTMLInputElement {
  const input = h("input", { type: "number", "aria-label": label, min: String(min), max: String(max), step: String(step), value: String(value) });
  input.value = String(value);
  return input;
}

function relayButton(label: string, onClick: () => void, disabled: boolean, variant = ""): HTMLButtonElement {
  const b = button(label, onClick, variant);
  b.disabled = disabled;
  return b;
}

/**
 * VCR-2：設定頁「語音中繼（實驗）」段。只有核心註冊了 voice_relay（settings.voice_relay）才畫。
 * 播放只由按鈕觸發；播放結果最多說「已發出、結果未確認」，音箱有沒有照做要使用者自己記錄。
 */
export function renderVoiceRelay(state: VoiceRelayPanelState, actions: ViewActions): HTMLElement {
  const relay = actions.voiceRelay;
  const rows: Child[] = [];
  const view = state.view;
  if (state.error) rows.push(h("p", { class: "error-text small" }, t("查不到語音中繼的狀態（核心沒有回覆）。")));
  else if (!view) rows.push(h("p", { class: "muted small" }, t("正在讀取…")));
  else {
    rows.push(
      h("p", { class: "small" }, view.mode === "mac" ? t("模式：Mac 喇叭實際發聲") : t("模式：模擬：不會發出聲音")),
      view.restart_required && h("p", { class: "notice small" }, t("目標或燈的清單已變更，重新啟動 Nous 後模型才能使用新的清單。")),
      h("p", { class: "muted small" }, t("播放成功只代表聲音已送出，不代表音箱照做。")),
      h("p", { class: "muted small" }, t("沒有回音抑制：Nous 自己的麥克風可能聽到這些播放。")),
    );
    const out = view.output;
    const time = out.checked_at ? new Date(out.checked_at).toLocaleTimeString(getLocale() === "en" ? "en-US" : "zh-TW", { hour12: false }) : null;
    rows.push(
      h(
        "div",
        { class: "provider-text" },
        h("span", { class: "small" }, t("聲音 {0} 個、喇叭 {1} 個", out.voices.length, out.devices.length)),
        time ? h("span", { class: "muted small" }, t("讀取時間：{0}", time)) : h("span", { class: "muted small" }, t("還沒有讀取聲音與喇叭")),
        out.error && h("span", { class: "error-text small" }, t("讀取聲音與喇叭時出錯，清單可能不完整。")),
      ),
      relay && h("div", { class: "actions" }, relayButton(state.busy ? "處理中…" : "重新讀取聲音與喇叭", () => relay.refresh(), state.busy)),
    );
    // 示範目標（fake 模式、沒有設定檔）也可以新增：新增後示範目標會被取代。
    if (!view.targets.length || view.fixtures_active) rows.push(renderRelayCreate(state, view, relay));
    for (const target of view.targets) rows.push(renderRelayTarget(state, view, target, relay));
  }
  if (state.notice) rows.push(h("p", { class: "error-text small", role: "status" }, t(state.notice)));
  return h("section", { class: "camera-settings voice-relay", "aria-label": "語音中繼" }, h("h3", {}, t("語音中繼（實驗）")), ...rows);
}

function renderRelayCreate(state: VoiceRelayPanelState, view: VoiceRelayView, relay: VoiceRelayActions | undefined): HTMLElement {
  const locale = state.createLocale;
  const localeSelect = relaySelect("語言", (["zh-TW", "en-US"] as const).map((l) => [l, t(RELAY_LOCALE_LABEL[l])]), locale, (v) => relay?.setCreateLocale(v === "en-US" ? "en-US" : "zh-TW"));
  const deviceSelect = relaySelect("喇叭", view.output.devices.map((d) => [d.id, d.name]), view.output.devices[0]?.id ?? null);
  const voices = view.output.voices.filter((v) => v.locale === locale);
  const voiceSelect = relaySelect("聲音", voices.map((v) => [v.id, v.id]), voices[0]?.id ?? null);
  const musicSelect = relaySelect("音樂服務", MUSIC_SERVICES.map((m) => [m, t(RELAY_MUSIC_LABEL[m])]), "youtube_music");
  const ready = !!relay && !state.busy && view.output.devices.length > 0 && voices.length > 0;
  return h(
    "div",
    { class: "voice-relay-form", "aria-label": "新增 Google Home Mini" },
    h("strong", {}, t("新增 Google Home Mini")),
    h("label", { class: "small" }, t("語言"), localeSelect),
    h("label", { class: "small" }, t("喇叭"), deviceSelect),
    h("label", { class: "small" }, t("聲音"), voiceSelect),
    h("label", { class: "small" }, t("音樂服務"), musicSelect),
    h("p", { class: "muted small" }, t("音樂服務選 Spotify 或「不知道」時，音樂命令會被政策擋下。")),
    view.fixtures_active && h("p", { class: "muted small" }, t("新增後會取代示範目標。")),
    !voices.length && h("p", { class: "muted small" }, t("這個語言沒有可用的聲音。")),
    !view.output.devices.length && h("p", { class: "muted small" }, t("沒有讀到喇叭。")),
    h(
      "div",
      { class: "actions" },
      relayButton("新增", () => {
        const music = MUSIC_SERVICES.find((m) => m === musicSelect.value) ?? "unknown";
        relay?.createTarget({ locale, output_device_id: deviceSelect.value, voice_id: voiceSelect.value, music_service: music });
      }, !ready, "btn--primary"),
    ),
  );
}

function renderRelayTarget(state: VoiceRelayPanelState, view: VoiceRelayView, target: VoiceRelayTargetView, relay: VoiceRelayActions | undefined): HTMLElement {
  const busy = state.busy || !relay;
  const device = view.output.devices.find((d) => d.id === target.output_device_id || d.name === target.output_device_id);
  const chosenId = state.chosen[target.id] && target.profiles.some((p) => p.id === state.chosen[target.id]) ? state.chosen[target.id]! : target.voice_profile_id ?? target.profiles[0]?.id ?? null;
  const box = h("div", { class: "voice-relay-target", "aria-label": "語音中繼目標" });
  box.append(
    h(
      "div",
      { class: "pref" },
      h(
        "div",
        { class: "provider-text" },
        h("strong", {}, raw(target.id)),
        h("span", { class: "muted small" }, t("語言：{0}；喇叭：{1}；音樂服務：{2}", target.locale, device?.name ?? target.output_device_id, t(RELAY_MUSIC_LABEL[target.music_service]))),
        !device && h("span", { class: "error-text small" }, t("目前讀不到這個喇叭。")),
      ),
      h("span", { class: `chip${target.enabled ? " chip--running" : ""}` }, target.enabled ? t("已啟用") : t("已停用")),
      relayButton(target.enabled ? "停用" : "啟用", () => relay?.setEnabled(target.id, !target.enabled), busy),
    ),
  );

  // 聲線：「試聽用」只是這頁的選擇；「採用這組」才把它設成模型路徑的聲線。
  const profiles = h("ul", { class: "pref-list" });
  for (const p of target.profiles) {
    const chosen = p.id === chosenId;
    const pick = button(chosen ? "試聽用（已選）" : "選為試聽用", () => relay?.chooseProfile(target.id, p.id), chosen ? "btn--primary" : "btn--ghost");
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(chosen));
    const item = h(
      "li",
      { class: "pref voice-relay-profile" },
      h(
        "div",
        { class: "provider-text" },
        h("strong", {}, raw(p.voice_id)),
        h("span", { class: "muted small" }, raw(p.id)),
        p.selected && h("span", { class: "chip chip--running" }, t("模型使用中")),
        !p.editable && h("span", { class: "muted small" }, t("內建聲線，不能編輯")),
        !p.available && h("span", { class: "error-text small" }, t("這台機器沒有這個聲音")),
      ),
      pick,
    );
    if (p.editable) {
      const rate = relayNumber("語速", p.rate, 0.5, 2, 0.05);
      const gain = relayNumber("音量（dB）", p.gain_db, -30, 0, 1);
      const pause = relayNumber("喚醒後停頓（毫秒）", p.pause_ms, 0, 5000, 100);
      const lead = relayNumber("開頭靜音（毫秒）", p.lead_ms, 0, 3000, 100);
      const tail = relayNumber("結尾靜音（毫秒）", p.tail_ms, 0, 3000, 100);
      item.append(
        h(
          "div",
          { class: "voice-relay-edit" },
          h("label", { class: "small" }, t("語速"), rate),
          h("label", { class: "small" }, t("音量（dB）"), gain),
          h("label", { class: "small" }, t("喚醒後停頓（毫秒）"), pause),
          h("label", { class: "small" }, t("開頭靜音（毫秒）"), lead),
          h("label", { class: "small" }, t("結尾靜音（毫秒）"), tail),
          relayButton("儲存聲線", () => relay?.saveProfile({
            target_id: target.id,
            id: p.id,
            voice_id: p.voice_id,
            rate: Number(rate.value),
            gain_db: Number(gain.value),
            pause_ms: Number(pause.value),
            lead_ms: Number(lead.value),
            tail_ms: Number(tail.value),
          }), busy),
        ),
      );
    }
    profiles.append(item);
  }
  const voices = view.output.voices.filter((v) => v.locale === target.locale);
  const newVoice = relaySelect("聲音", voices.map((v) => [v.id, v.id]), voices[0]?.id ?? null);
  box.append(
    h("p", { class: "small" }, t("聲線")),
    profiles,
    h(
      "div",
      { class: "actions" },
      newVoice,
      relayButton("新增候選聲線", () => relay?.saveProfile({ target_id: target.id, voice_id: newVoice.value, rate: 1, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 }), busy || !voices.length),
    ),
  );

  for (const intent of target.intents) {
    if (!intent.templates.length) continue;
    box.append(renderRelayIntent(state, target, intent, chosenId, relay));
  }
  return box;
}

function renderRelayIntent(state: VoiceRelayPanelState, target: VoiceRelayTargetView, intent: VoiceRelayIntentView, chosenId: string | null, relay: VoiceRelayActions | undefined): HTMLElement {
  const busy = state.busy || !relay;
  // 參數輸入（按按鈕時才讀值）。
  const inputs: { read: () => VoiceRelaySlots }[] = [];
  const fields: Child[] = [];
  for (const slot of intent.slots) {
    if (slot === "genre") {
      const s = relaySelect("音樂類型", GENRES.map((g) => [g, t(RELAY_GENRE_LABEL[g])]), GENRES[0]);
      fields.push(h("label", { class: "small" }, t("音樂類型"), s));
      inputs.push({ read: () => ({ genre: s.value }) });
    } else if (slot === "on") {
      const s = relaySelect("開或關", [["on", t("開")], ["off", t("關")]], "on");
      fields.push(h("label", { class: "small" }, t("開或關"), s));
      inputs.push({ read: () => ({ on: s.value === "on" }) });
    } else if (slot === "percent") {
      const n = relayNumber("百分比", 30, 0, 100, 1);
      fields.push(h("label", { class: "small" }, t("百分比"), n));
      inputs.push({ read: () => ({ percent: Number(n.value) }) });
    } else if (slot === "seconds") {
      const n = relayNumber("秒數", 60, 1, 3600, 1);
      fields.push(h("label", { class: "small" }, t("秒數"), n));
      inputs.push({ read: () => ({ seconds: Number(n.value) }) });
    } else if (slot === "device") {
      const s = relaySelect("燈", target.devices.map((d) => [d.id, d.name]), target.devices[0]?.id ?? null);
      fields.push(h("label", { class: "small" }, t("燈"), s));
      if (!target.devices.length) fields.push(h("span", { class: "muted small" }, t("這個目標沒有登記燈。")));
      inputs.push({ read: () => ({ device: s.value }) });
    }
  }
  const slots = (): VoiceRelaySlots | undefined => (inputs.length ? Object.assign({}, ...inputs.map((i) => i.read())) : undefined);
  const base = (template: VoiceRelayTemplateView): VoiceRelayPreviewBody => {
    const s = slots();
    return { target_id: target.id, intent_id: intent.intent_id, template_id: template.template_id, ...(chosenId ? { voice_profile_id: chosenId } : {}), ...(s ? { slots: s } : {}) };
  };

  const list = h("ul", { class: "pref-list" });
  for (const tpl of intent.templates) {
    const chip = tpl.policy_blocked
      ? h("span", { class: "chip chip--failed" }, t("政策封鎖"))
      : tpl.adopted
        ? h("span", { class: "chip chip--running" }, t("已採用"))
        : tpl.status === "rejected"
          ? h("span", { class: "chip chip--cancelled" }, t("已拒絕"))
          : h("span", { class: "chip chip--queued" }, t("候選"));
    const canPlay = !busy && !tpl.policy_blocked && !!chosenId;
    const item = h(
      "li",
      { class: "pref voice-relay-template", "data-template": tpl.template_id },
      h(
        "div",
        { class: "provider-text" },
        h("strong", {}, raw(tpl.text)),
        h("span", { class: "muted small" }, t("喚醒詞：{0}", tpl.wake || "—"), raw(` · ${tpl.template_id} v${tpl.version}`)),
        tpl.selected_default && h("span", { class: "muted small" }, t("這個命令的預設說法")),
        h("span", { class: "muted small" }, t("試驗：{0}", relayTrialSummaryText(target.trials.find((s) => s.templateId === tpl.template_id && s.templateVersion === tpl.version && s.voiceProfileId === chosenId)))),
      ),
      chip,
    );
    const actionsRow = h(
      "div",
      { class: "actions" },
      relayButton("預覽文字", () => relay?.preview(base(tpl)), busy),
      relayButton("測試喚醒", () => relay?.play({ ...base(tpl), part: "wake" }), !canPlay),
      relayButton("測試整句", () => relay?.play({ ...base(tpl), part: "full" }), !canPlay),
      tpl.adopted
        ? relayButton("取消採用", () => relay?.unadopt({ target_id: target.id, template_id: tpl.template_id, template_version: tpl.version }), busy, "btn--ghost")
        : relayButton("採用這組", () => chosenId && relay?.adopt({ target_id: target.id, intent_id: intent.intent_id, template_id: tpl.template_id, template_version: tpl.version, voice_profile_id: chosenId }), busy || !chosenId || tpl.policy_blocked || tpl.status === "rejected"),
    );
    item.append(actionsRow);
    const pv = state.preview;
    if (pv && pv.target_id === target.id && pv.intent_id === intent.intent_id && pv.template_id === tpl.template_id) {
      item.append(
        pv.result.kind === "resolved"
          ? h("p", { class: "small", role: "status" }, t("會說：{0}", pv.result.spoken))
          : h("p", { class: "error-text small", role: "status" }, t("不會播放：{0}", t(RELAY_REFUSAL_TEXT[pv.result.reason] ?? "原因不明"))),
      );
    }
    const pl = state.played;
    if (pl && pl.target_id === target.id && pl.intent_id === intent.intent_id && pl.template_id === tpl.template_id && pl.template_version === tpl.version) {
      item.append(renderRelayPlayed(state, pl, relay));
    }
    list.append(item);
  }
  return h(
    "div",
    { class: "voice-relay-intent" },
    h("p", { class: "small" }, h("strong", {}, t(RELAY_INTENT_LABEL[intent.intent_id] ?? intent.intent_id))),
    fields.length > 0 && h("div", { class: "actions" }, ...fields),
    list,
  );
}

function renderRelayPlayed(state: VoiceRelayPanelState, pl: VoiceRelayPlayed, relay: VoiceRelayActions | undefined): HTMLElement {
  const text = pl.reason
    ? t("沒有播放：{0}", t(RELAY_REFUSAL_TEXT[pl.reason] ?? "原因不明"))
    : pl.part === "wake" && (pl.status === "unconfirmed" || pl.status === "confirmed")
      ? t("已播出喚醒詞，結果未確認")
      : t(RELAY_PLAY_TEXT[pl.status] ?? "結果不明：可能已播出一部分，也可能沒有");
  const box = h("div", { class: "voice-relay-result" }, h("p", { class: pl.status === "unconfirmed" ? "small" : "error-text small", role: "status" }, text));
  // 只有整句真的送出（unconfirmed）才記錄試驗：音箱有沒有照做由使用者自己判斷。
  if (pl.part !== "full" || pl.status !== "unconfirmed" || pl.reason) return box;
  const draft = state.trial;
  const busy = state.busy || !relay;
  const choice = (label: string, active: boolean, onClick: () => void) => {
    const b = relayButton(label, onClick, busy, active ? "btn--primary" : "btn--ghost");
    b.setAttribute("aria-pressed", String(active));
    return b;
  };
  const evidence = relaySelect("證據", [["visual", t("目視")], ["human_confirmed", t("人工確認")]], draft.evidence, (v) => relay?.setTrial({ evidence: v === "human_confirmed" ? "human_confirmed" : "visual" }));
  const command = draft.wake === "NO_WAKE" ? "NO_COMMAND" : draft.command;
  box.append(h(
    "div",
    { class: "voice-relay-trial", "aria-label": "記錄試驗結果" },
    h("p", { class: "muted small" }, t("音箱有沒有照做？請自己看或聽，再記錄。")),
    h(
      "div",
      { class: "actions" },
      choice("有喚醒", draft.wake === "WAKE_OK", () => relay?.setTrial({ wake: "WAKE_OK" })),
      choice("沒喚醒", draft.wake === "NO_WAKE", () => relay?.setTrial({ wake: "NO_WAKE", command: "NO_COMMAND" })),
    ),
    draft.wake === "WAKE_OK" && h(
      "div",
      { class: "actions" },
      choice("命令正確", draft.command === "COMMAND_OK", () => relay?.setTrial({ command: "COMMAND_OK" })),
      choice("命令錯誤", draft.command === "WRONG_COMMAND", () => relay?.setTrial({ command: "WRONG_COMMAND" })),
      choice("沒有執行", draft.command === "NO_COMMAND", () => relay?.setTrial({ command: "NO_COMMAND" })),
    ),
    h(
      "div",
      { class: "actions" },
      h("label", { class: "small" }, t("證據"), evidence),
      relayButton("記錄結果", () => draft.wake && command && relay?.recordTrial({
        target_id: pl.target_id,
        template_id: pl.template_id,
        template_version: pl.template_version,
        voice_profile_id: pl.voice_profile_id,
        kind: "positive",
        wake: draft.wake,
        command,
        evidence: draft.evidence,
      }), busy || !draft.wake || !command),
    ),
  ));
  return box;
}
