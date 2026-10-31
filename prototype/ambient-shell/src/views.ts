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
import { isLiveVoice, ROUTE_PREFERENCE_LABEL, ROUTE_PREFERENCES, unavailableText, type RealtimePrefsPatch } from "../shared/realtime-route.ts";
import type { RealtimeInfo } from "../shared/types.ts";
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
  /** 即時語音的路徑偏好與 ChatGPT 方案路徑的聲音（下一次開始才生效）。 */
  updateRealtime(patch: RealtimePrefsPatch): void;
  /** 即時語音用的 Codex 登入（和上面的 Continue with ChatGPT 分開）。 */
  codexLogin(method: "browser" | "device"): void;
  codexCancel(): void;
  codexLogout(): void;
  /** 進度卡的「搜尋全部成果」（HIST-1）：打開成果紀錄。 */
  openHistory(): void;
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
  /**
   * 在 macOS App 裡（頁面有 window.nousDesktop）：設定以選單列為主體，這頁只留帳號與登入和狀態，
   * 不畫和選單列重複的引擎選擇、即時語音路徑與聲音、語音秒數、鏡頭與手勢。瀏覽器版（false）畫完整的設定畫面。
   */
  desktop?: boolean;
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
  if (options.desktop) return renderDesktopAccounts(settings, message, actions);
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
    settings.camera && renderCameraSettings(settings.camera, !!settings.realtime?.available, actions),
    // 家人辨識只在 macOS App（加密保存需要 safeStorage）；瀏覽器版照實說不可用，不提供任何操作。
    settings.identity && !settings.identity.available && h("p", { class: "muted small" }, msg`家人辨識：${uiText(settings.identity.disabled_reason ?? "不可用")}`),
    footer(actions),
  );
}

/**
 * macOS App 內的設定頁：只有帳號與登入（ChatGPT 引擎帳號、即時語音用的 Codex 帳號）和狀態。
 * 引擎選擇、即時語音路徑與聲音、秒數、鏡頭與手勢都在選單列，這裡不重複畫。
 */
function renderDesktopAccounts(settings: SettingsView, message: string | null, actions: ViewActions): HTMLElement {
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
    h("p", { class: "muted small" }, t(DESKTOP_SETTINGS_NOTE)),
    footer(actions),
  );
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
  const status = active
    ? msg`進行中：${t(active.billing_line)}${rt.billing_line && rt.billing_line !== active.billing_line ? msg`（下次開始時改用：${t(rt.billing_line)}）` : ""}`
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
    const hint = key === "realtime_idle_s" && !realtimeAvailable ? msg`${t(spec.hint)}；即時語音目前不可用` : t(spec.hint);
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

/** 鏡頭與手勢：逐項走 CAMERA_PREFS（順序、標籤、提示、範圍都從那裡來）。 */
function renderCameraSettings(camera: CameraSettings, realtimeAvailable: boolean, actions: ViewActions): HTMLElement {
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
