import { t, msg, onLocaleChange } from "./i18n.ts";
// 成果紀錄（HIST-1）：搜尋過去的任務與成果。App 內的按需 Surface 與獨立網頁 /history 共用這個畫面。
// - 只有使用者打開時才出現（App：說「搜尋成果 香菜」、進度卡的「搜尋全部成果」、選單列「成果紀錄…」；網頁：自己打開 /history）。
// - 搜尋都在本機核心的記憶體內比對；這裡只送查詢、畫結果。
// - 使用者原句、片段、步驟與模型輸出都是資料：用文字節點與 <mark> 元素組出來，不把資料當 HTML；
//   成果內容沿用成果畫面（artifactSections → renderMarkdown 消毒）。
// - 刪除不能復原：先經原生確認（App 與瀏覽器的 confirm 對話框），再帶 confirm: true 送到核心；執行中的任務要先停止。
// - 收起只關畫面，不取消任何任務。

import { artifactSections, button, h, raw, renderStep, type Child } from "./views.ts";
import { TASK_STATUS_LABEL, formatCount } from "./format.ts";
import { PROTECTED_TITLE, WITHDRAWN_TEXT, shellView } from "./protected-tasks.ts";
import { isDeletable, type HistoryDetail, type HistoryItem, type HistoryMatch, type HistoryPage, type HistoryQuery } from "../shared/history.ts";
import type { ExecutorMode, Task, TaskStatus } from "../shared/types.ts";

export interface HistoryApi {
  searchHistory(query: HistoryQuery): Promise<HistoryPage>;
  getHistory(taskId: string): Promise<HistoryDetail>;
  deleteHistory(taskId: string, requestId: string): Promise<unknown>;
}

export interface HistoryViewDeps {
  api: HistoryApi;
  /** 原生確認（window.confirm：App 裡是 macOS 對話框）；回 true 才刪除。 */
  confirm(message: string): boolean | Promise<boolean>;
  /** 每次使用者動作（刪除、重做）的請求 ID。 */
  requestId(): string;
  /** 重做：App 沿用重試（成功後換成進度畫面）；網頁送出後顯示說明。回傳要顯示的說明（null＝不顯示）。 */
  redo(task: Task, requestId: string): Promise<string | null>;
  /** 收起（只關畫面）；獨立網頁沒有收起，為 null。 */
  dismiss: (() => void) | null;
  /** 一般瀏覽器裡的 App 可以另開 /history；macOS App 與獨立網頁本身不顯示。 */
  browserLink?: boolean;
  /** 獨立網頁：在標題列放語言切換。 */
  header?: () => HTMLElement | null;
  /**
   * MEM-4a：這個畫面的資料來自 HTTP（/api/history）。macOS App 加密保存時，HTTP 只有外殼：受保護的項目只顯示
   * 「受保護的任務，請在 App 內查看」（依目前介面語言），不顯示片段。App 內經 IPC 搜尋時為 false。
   */
  shells?: boolean;
}

const STATUS_FILTERS: readonly ("" | TaskStatus)[] = ["", "succeeded", "failed", "cancelled", "running", "queued"];
const MODE_FILTERS: readonly ("" | ExecutorMode)[] = ["", "claude", "chatgpt", "mock"];
const MODE_LABEL: Record<ExecutorMode, string> = { claude: "Claude", chatgpt: "ChatGPT", mock: "模擬" };

/**
 * 把命中的位置標成 <mark>，其餘是文字。offset 超出範圍、重疊或倒置的一律忽略（不信任資料）。
 * 回傳的節點都由 DOM API 建立（document.createElement／字串），不經 innerHTML。
 */
export function highlight(text: string, matches: readonly HistoryMatch[]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let cursor = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < cursor || m.end <= m.start || m.end > text.length) continue;
    if (m.start > cursor) out.push(text.slice(cursor, m.start));
    out.push(h("mark", {}, raw(text.slice(m.start, m.end))));
    cursor = m.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function engineText(mode: ExecutorMode, model: string | null): string {
  if (mode === "mock") return t("模擬（未呼叫模型）");
  return model ? `${MODE_LABEL[mode]} · ${model}` : MODE_LABEL[mode];
}

/** 只留元素（false／null 是「這一塊不畫」）。 */
function nodes(children: readonly Child[]): Node[] {
  return children.filter((c): c is Node => !!c && typeof c === "object" && !("raw" in c));
}

type DetailState = { taskId: string; data: HistoryDetail | null; error: string | null; busy: boolean };

export class HistoryView {
  readonly element: HTMLElement;
  private query: Required<Pick<HistoryQuery, "q" | "status" | "mode" | "from" | "to">> = { q: "", status: "", mode: "", from: "", to: "" };
  private items: HistoryItem[] = [];
  private total = 0;
  private nextCursor: string | null = null;
  private loading = false;
  private error: string | null = null;
  private notice: string | null = null;
  /** MEM-4c：內容已因丟棄而隱藏（狀態列不說「還沒有任何任務」）。 */
  private hidden = false;
  private detail: DetailState | null = null;
  /** 搜尋的世代：較晚送出的查詢回來後，較早的回應不再覆蓋畫面。 */
  private generation = 0;
  private form: HTMLFormElement | null = null;

  constructor(private readonly deps: HistoryViewDeps) {
    this.element = h("section", { class: "surface surface--history", role: "region", "aria-label": "成果紀錄" });
    onLocaleChange(() => {
      this.form = null;
      this.render();
    });
    this.render();
  }

  /** 打開（或重新打開）並搜尋；query 為空字串時列出全部（新到舊）。 */
  open(query = ""): void {
    this.hidden = false;
    this.query = { q: query, status: "", mode: "", from: "", to: "" };
    this.detail = null;
    this.notice = null;
    this.form = null;
    void this.search();
  }

  /** 任務在別處被刪除（SSE task.deleted）：從清單與詳細頁移除。 */
  taskDeleted(taskId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.task_id !== taskId);
    if (this.items.length !== before) this.total = Math.max(0, this.total - (before - this.items.length));
    if (this.detail?.taskId === taskId) this.detail = null;
    this.render();
  }

  /**
   * 任務有變化（SSE task.updated，例如停止中 → 已停止）：更新清單裡那一筆的狀態；詳細頁開著時重讀，
   * 狀態、成果與「重做／刪除」按鈕才跟得上。
   */
  taskUpdated(task: Task): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.task_id !== task.task_id) return item;
      changed = true;
      return { ...item, status: task.status, finished_at: task.finished_at, model: item.model ?? task.model };
    });
    const detail = this.detail;
    if (detail?.data && detail.taskId === task.task_id) {
      if (detail.data.task.artifact_id === task.artifact_id) detail.data = { ...detail.data, task };
      else void this.reloadDetail(task.task_id);
      changed = true;
    }
    if (changed) this.render();
  }

  /**
   * MEM-4c 審查 M1：核心丟棄解密內容後（鎖定、睡眠、閒置、關閉記憶）清掉結果、片段與詳細頁（包括還在路上的查詢），
   * 只留一句提示；畫面本身不收起，任務照常。查詢文字也清掉（可能含內容的關鍵字）。
   */
  hideContent(reason: "os_lock" | "suspend" | "idle" | "memory_off" | "memory_closed" | "quit"): void {
    this.generation += 1;
    this.items = [];
    this.total = 0;
    this.nextCursor = null;
    this.loading = false;
    this.error = null;
    this.detail = null;
    this.query = { q: "", status: "", mode: "", from: "", to: "" };
    this.form = null;
    this.hidden = true;
    this.notice = reason === "os_lock" || reason === "suspend" ? t("內容已因鎖定隱藏，請重新搜尋") : t("內容已因閒置或記憶設定改變而隱藏，請重新搜尋");
    this.render();
  }

  private async reloadDetail(taskId: string): Promise<void> {
    try {
      const data = await this.deps.api.getHistory(taskId);
      if (this.detail?.taskId !== taskId) return;
      this.detail.data = data;
      this.render();
    } catch {
      // 重讀失敗時保留目前的內容；使用者可以回到清單再打開。
    }
  }

  async search(append = false): Promise<void> {
    const generation = ++this.generation;
    if (this.hidden) this.notice = null;
    this.hidden = false;
    this.loading = true;
    this.error = null;
    if (!append) this.detail = null;
    this.render();
    try {
      const page = await this.deps.api.searchHistory({ ...this.query, cursor: append ? this.nextCursor : null });
      if (generation !== this.generation) return;
      this.items = append ? [...this.items, ...page.items] : page.items;
      this.total = page.total;
      this.nextCursor = page.next_cursor;
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = msg`無法搜尋成果紀錄：${t((err as Error).message)}`;
      if (!append) {
        this.items = [];
        this.total = 0;
        this.nextCursor = null;
      }
    }
    this.loading = false;
    this.render();
  }

  async openDetail(taskId: string): Promise<void> {
    this.detail = { taskId, data: null, error: null, busy: false };
    this.notice = null;
    this.render();
    try {
      const data = await this.deps.api.getHistory(taskId);
      if (this.detail?.taskId !== taskId) return;
      this.detail.data = data;
    } catch (err) {
      if (this.detail?.taskId !== taskId) return;
      this.detail.error = msg`無法載入這筆紀錄：${t((err as Error).message)}`;
    }
    this.render();
  }

  private backToList(): void {
    this.detail = null;
    this.render();
  }

  private async remove(task: Task): Promise<void> {
    if (!isDeletable(task)) return;
    const ok = await this.deps.confirm(t("要永久刪除「{0}」這筆任務與它的成果嗎？刪除後無法復原。", task.title));
    if (!ok || !this.detail) return;
    this.detail.busy = true;
    this.render();
    try {
      await this.deps.api.deleteHistory(task.task_id, this.deps.requestId());
      this.detail = null;
      this.items = this.items.filter((i) => i.task_id !== task.task_id);
      this.total = Math.max(0, this.total - 1);
      this.notice = t("已刪除這筆任務與它的成果。");
    } catch (err) {
      if (this.detail) {
        this.detail.busy = false;
        this.detail.error = msg`沒有刪除：${t((err as Error).message)}`;
      }
    }
    this.render();
  }

  private async redo(task: Task): Promise<void> {
    if (!this.detail) return;
    this.detail.busy = true;
    this.render();
    try {
      const note = await this.deps.redo(task, this.deps.requestId());
      if (this.detail) this.detail.busy = false;
      this.notice = note;
    } catch (err) {
      if (this.detail) {
        this.detail.busy = false;
        this.detail.error = msg`無法重做：${t((err as Error).message)}`;
      }
    }
    this.render();
  }

  private render(): void {
    // 換語言時無障礙標籤也要跟著換。
    this.element.setAttribute("aria-label", t("成果紀錄"));
    if (this.detail) {
      this.element.replaceChildren(...this.renderDetail(this.detail));
      return;
    }
    const children: Child[] = [
      h(
        "header",
        { class: "surface-header" },
        h("p", { class: "eyebrow" }, t("成果紀錄")),
        h("h2", {}, t("搜尋過去的任務與成果")),
        this.deps.header?.() ?? null,
      ),
      this.notice && h("p", { class: "notice", role: "status" }, this.notice),
      this.formElement(),
      this.statusLine(),
      this.items.length > 0 && this.resultList(),
      this.nextCursor && !this.loading && h("div", { class: "actions" }, button(t("載入更多"), () => void this.search(true))),
      this.footer(),
    ];
    this.element.replaceChildren(...nodes(children));
  }

  private footer(): HTMLElement | null {
    const parts: Child[] = [];
    if (this.deps.browserLink) {
      parts.push(h("a", { class: "btn btn--ghost", href: "/history", target: "_blank", rel: "noopener" }, t("在新分頁打開成果紀錄")));
    }
    if (this.deps.dismiss) {
      parts.push(button(t("收起"), this.deps.dismiss, "btn--ghost"));
      parts.push(h("span", { class: "hint" }, t("收起只關畫面，任務照常")));
    }
    if (parts.length === 0) return null;
    return h("footer", { class: "surface-footer" }, ...parts);
  }

  /** 有查詢詞或任何篩選：沒有結果時說「沒有符合」，不說「還沒有任何任務」。 */
  private filtered(): boolean {
    const { q, status, mode, from, to } = this.query;
    return !!(q.trim() || status || mode || from || to);
  }

  private statusLine(): HTMLElement {
    let text: string;
    if (this.loading) text = t("搜尋中…");
    else if (this.error) return h("p", { class: "error-text", role: "alert" }, this.error);
    else if (this.hidden) text = t("按「搜尋」重新載入。");
    else if (this.total === 0) text = this.filtered() ? t("沒有符合的任務或成果。") : t("還沒有任何任務或成果。");
    else text = this.query.q.trim() ? msg`找到 ${formatCount(this.total)} 筆` : msg`共 ${formatCount(this.total)} 筆（新到舊）`;
    return h("p", { class: "muted history-status", role: "status", "aria-live": "polite" }, text);
  }

  /** 搜尋表單只在需要時重建（換語言、重新打開）；打字時不重建，不會失去焦點。 */
  private formElement(): HTMLFormElement {
    if (this.form) return this.form;
    const q = h("input", { type: "search", class: "history-input", name: "q", maxlength: "200", "aria-label": "搜尋成果的關鍵字", placeholder: "輸入關鍵字，例如：晚餐、香菜", enterkeyhint: "search", autocomplete: "off" });
    q.value = this.query.q;
    const status = h("select", { name: "status", "aria-label": "任務狀態" });
    for (const value of STATUS_FILTERS) {
      const option = h("option", { value }, value ? t(TASK_STATUS_LABEL[value]) : t("全部狀態"));
      option.selected = this.query.status === value;
      status.append(option);
    }
    const mode = h("select", { name: "mode", "aria-label": "AI 引擎" });
    for (const value of MODE_FILTERS) {
      const option = h("option", { value }, value ? t(MODE_LABEL[value]) : t("全部引擎"));
      option.selected = this.query.mode === value;
      mode.append(option);
    }
    const from = h("input", { type: "date", name: "from", "aria-label": "開始日期" });
    from.value = this.query.from;
    const to = h("input", { type: "date", name: "to", "aria-label": "結束日期" });
    to.value = this.query.to;
    const submit = h("button", { type: "submit", class: "btn btn--primary" }, t("搜尋"));
    const form = h(
      "form",
      { class: "history-form", role: "search", "aria-label": "搜尋成果紀錄" },
      h("div", { class: "history-row" }, q, submit),
      h(
        "div",
        { class: "history-row history-filters" },
        h("label", {}, t("狀態"), status),
        h("label", {}, t("引擎"), mode),
        h("label", {}, t("從"), from),
        h("label", {}, t("到"), to),
      ),
    );
    // 開始日期不能晚於結束日期（核心也會擋，回 400）。
    const bound = () => {
      to.min = from.value;
      from.max = to.value;
    };
    bound();
    const read = () => {
      bound();
      this.query = {
        q: q.value,
        status: status.value as "" | TaskStatus,
        mode: mode.value as "" | ExecutorMode,
        from: from.value,
        to: to.value,
      };
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      read();
      void this.search();
    });
    for (const select of [status, mode, from, to]) {
      select.addEventListener("change", () => {
        read();
        void this.search();
      });
    }
    this.form = form;
    return form;
  }

  private resultList(): HTMLElement {
    const list = h("ol", { class: "history-list" });
    for (const item of this.items) list.append(this.resultItem(item));
    return list;
  }

  private resultItem(item: HistoryItem): HTMLElement {
    const shell = !!this.deps.shells && item.protected;
    const open = h("button", { type: "button", class: "history-open" }, h("span", { class: "history-title" }, ...(shell ? [t(PROTECTED_TITLE)] : highlight(item.title, item.title_matches))));
    open.addEventListener("click", () => void this.openDetail(item.task_id));
    const meta = h(
      "p",
      { class: "history-meta muted small" },
      h("span", { class: `chip chip--${item.status}` }, t(TASK_STATUS_LABEL[item.status])),
      " ",
      engineText(item.mode, item.model),
      " · ",
      msg`交辦於 ${formatDate(item.created_at)}`,
    );
    const snippet = item.snippet && !shell
      ? h(
          "p",
          { class: "history-snippet" },
          item.snippet.truncated_start ? "…" : "",
          ...highlight(item.snippet.text, item.snippet.matches),
          item.snippet.truncated_end ? "…" : "",
        )
      : null;
    return h("li", { class: "history-item", "data-task": item.task_id }, open, meta, snippet);
  }

  private renderDetail(detail: DetailState): Node[] {
    const back = button(t("回到搜尋結果"), () => this.backToList(), "btn--ghost");
    if (!detail.data) {
      return [
        h("div", { class: "actions" }, back),
        h("p", { class: detail.error ? "error-text" : "muted", role: detail.error ? "alert" : "status" }, detail.error ?? t("載入中…")),
      ];
    }
    const { artifact } = detail.data;
    const task = shellView(detail.data.task);
    // MEM-4a：撤銷後只留外殼與重做；HTTP 看到的受保護任務只有外殼（內容請在 App 內查看）。
    const missing = task.withdrawn ? WITHDRAWN_TEXT : task.protected && this.deps.shells ? PROTECTED_TITLE : task.status === "succeeded" ? "找不到這個任務的成果" : null;
    const { header, body, notes } = artifactSections(task, artifact, artifact ? null : missing);
    const showBody = !!artifact || task.status === "succeeded";
    const facts = h(
      "dl",
      { class: "history-facts" },
      h("dt", {}, t("原始要求")), h("dd", {}, raw(task.title)),
      h("dt", {}, t("狀態")), h("dd", {}, t(TASK_STATUS_LABEL[task.status])),
      h("dt", {}, t("引擎")), h("dd", {}, engineText(artifact?.mode ?? task.mode, artifact?.model ?? task.model)),
      h("dt", {}, t("交辦時間")), h("dd", {}, formatDate(task.created_at)),
      h("dt", {}, t("結束時間")), h("dd", {}, formatDate(task.finished_at)),
    );
    const steps = h("ol", { class: "steps" });
    task.steps.forEach((step, i) => steps.append(renderStep(task.task_id, i, step)));
    const buttons: HTMLElement[] = [back];
    const deletable = isDeletable(task);
    if (deletable) {
      const redo = button(t("重做"), () => void this.redo(task));
      const del = button(t("刪除"), () => void this.remove(task), "btn--danger");
      redo.disabled = detail.busy;
      del.disabled = detail.busy;
      buttons.push(redo, del);
    }
    const children: Child[] = [
      h("div", { class: "actions history-back" }, button(t("回到搜尋結果"), () => this.backToList(), "btn--ghost")),
      header,
      detail.error && h("p", { class: "error-text", role: "alert" }, detail.error),
      this.notice && h("p", { class: "notice", role: "status" }, this.notice),
      showBody && body,
      ...(showBody ? notes : []),
      task.error && h("p", { class: "error-text" }, t(task.error)),
      h("section", { class: "history-source" }, h("h3", {}, t("來源")), facts),
      task.steps.length > 0 && h("section", { class: "history-steps" }, h("h3", {}, t("步驟")), steps),
      !deletable && h("p", { class: "muted small" }, t("執行中的任務要先停止，才能重做或刪除。")),
      h("div", { class: "actions" }, ...buttons),
      this.footer(),
    ];
    return nodes(children);
  }
}
