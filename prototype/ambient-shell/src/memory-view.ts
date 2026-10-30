import { t, msg, getLocale, onLocaleChange } from "./i18n.ts";
// 「記憶」Surface（docs/16 MEM-1）：按需出現，visibility_reason 一律是 user_request（觸發它的打字或選單列點擊）。
// 內容：首次設定（四個獨立選項）、澄清卡（保存／改記全家共用／取消）、建立或選擇人物、臉部候選「這次用 X 的偏好？」、
// 全部忘記、「你記得我什麼？」清單（修改／忘記／釘選），以及從選單列「記憶…」打開的記憶管理。
// MEM-2：即時語音的卡（SSE 只送卡片 ID，內容用 IPC card_view 取）：語音記住／更正／忘記的確認卡（也可以說確認詞）、
// 臉部候選、挑選與查看卡，以及帶著記憶時的「要交辦這件事嗎？」（標題是使用者原句）。
// - 記憶只經 macOS App 的 IPC（window.nousDesktop.memory）與核心往來；瀏覽器版明示不可用。
// - 規則、人物、同意、票證與寫檔都在核心；這裡只顯示核心回的固定句型（t(message, ...values)），使用者的話與人物名照原樣。
// - 不建立常駐側欄：收起就回電子腦；「本次人物」標籤只在輸入列與對話 Surface（src/main.ts）。
// - MEM-5a：記憶建議（SuggestionPrompt）是對話回覆下方的一行，跟著那一輪的 request_id（user_request），不是新的 Surface；
//   內容經 card_view 取，只有按「記住」才寫入。全家共用的記憶在查看時顯示「由 X 記下」，並說明這不是身分驗證。
// - MEM-5b：工作決定卡（「記住這次選了方案 B」要連到哪一個最近完成的工作；工作標題只經 IPC，點選才寫入）；清單上的工作決定
//   標「工作決定」與連到的工作（只有在目前範圍內才顯示標題）；記憶管理可以只看工作決定。

import type {
  ClarifyChoice,
  MemoryResponse as MemoryResult,
  MemoryCardView,
  MemoryFactView,
  MemoryPresenceView,
  MemoryReceiptView,
  MemoryRequest,
  MemoryResponse,
  MemorySetupSubject,
  MemoryStatusView,
  MemoryText,
  MemoryTurnView,
} from "../shared/memory.ts";

export interface MemoryBridge {
  memory(request: MemoryRequest): Promise<MemoryResponse>;
}

export interface MemoryViewDeps {
  /** macOS App 的 IPC；瀏覽器版為 null。 */
  bridge: MemoryBridge | null;
  /** 收起（dispatch dismiss）；只關畫面。 */
  dismiss(): void;
  /** 卡片處理完的結果（回條、下一張卡、要送的聊天）交回主程式。requestId 是原本那一輪。 */
  resolved(view: MemoryTurnView, requestId: string): void;
  /** 管理畫面的單筆變更回條。 */
  changed(receipt: MemoryReceiptView, historyReset: boolean, presence: MemoryPresenceView | null): void;
  /** MEM-2：即時語音的卡處理完（回條只顯示，不續送聊天）。 */
  liveResolved?(view: MemoryTurnView): void;
}

export const MEMORY_EXPLANATION =
  "記憶只保存在這台 Mac（加密），內容是家中可使用的普通偏好，不是私密空間。取用時會把相關的幾筆送給你允許的模型服務；" +
  "沒有允許的服務不會收到。隨時可以修改、忘記或關閉；忘記不會刪除已送給模型服務的內容或系統備份。";
export const MEMORY_BROWSER_UNAVAILABLE = "記憶：瀏覽器版不可用（只在 macOS App 提供）。";
/** MEM-2：codex 同意的範圍（16 §4：新增服務要另外確認，不沿用 ChatGPT 的同意）。 */
export const CODEX_CONSENT_NOTE = "「ChatGPT 方案即時語音」的同意同時涵蓋即時語音模型與它交辦用的 Codex（同一個 ChatGPT 帳號）；和上面的 ChatGPT 是分開的同意。";
/** MEM-3：openai_realtime 同意的範圍（OPENAI_API_KEY 的指紋；換 key 要重新允許）。只有 API key 路徑的記憶已放行時才會列出。 */
/** MEM-5a：記憶建議的說明（記憶管理）。 */
export const SUGGESTIONS_NOTE = "開啟後，打字聊天時說到自己穩定的偏好（例如「我不吃香菜」），會在那一則回覆下方問一次要不要記住；只有按「記住」才保存。不會從語音、成果或模型的回覆提出，也不會替全家共用、未成年家人或沒有選定的人物提出。";
/** MEM-5a：全家共用的「由誰記下」不是身分驗證。 */
export const ATTRIBUTION_NOTE = "「由誰記下」只是記下當時選定的本次人物，不是身分驗證。";
export const OPENAI_REALTIME_CONSENT_NOTE = "「OpenAI API key 即時語音」的同意只涵蓋用 .env 的 OPENAI_API_KEY 進行的即時語音；換一把 key 要重新允許，和上面的 ChatGPT 方案即時語音是分開的同意。";

type Mode =
  | { kind: "idle" }
  | { kind: "card"; card: MemoryCardView; requestId: string; chat: MemoryTurnView["chat"]; origin?: "typed" | "live" }
  /** MEM-2：即時語音帶著記憶時的交辦卡。 */
  | { kind: "delegate"; title: string; run: () => void }
  | { kind: "manage"; subject: string | null; facts: MemoryFactView[]; token: string | null; people: { person_id: string; name: string; linked: boolean }[] | null; consents: { provider: string; account: string; allowed: boolean }[] }
  | { kind: "unavailable"; message: string };

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, ["aria-label", "title", "placeholder"].includes(k) ? t(v) : v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function button(label: string, onClick: () => void, variant = "", disabled = false): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${variant}`.trim() }, t(label));
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** MEM-5b：工作決定卡上的「連到這個工作」；無障礙標籤帶工作標題（審查 nit），讀螢幕時分得出是哪一個。 */
function linkButton(title: string, onClick: () => void, disabled: boolean): HTMLButtonElement {
  const b = button("連到這個工作", onClick, "btn--primary", disabled);
  b.setAttribute("aria-label", msg`連到：${title}`);
  return b;
}

function checkbox(checked: boolean, disabled = false): HTMLInputElement {
  const c = h("input", { type: "checkbox" });
  c.checked = checked;
  c.disabled = disabled;
  return c;
}

/** 核心的固定句型 → 目前語言（values 是使用者的話或人物名，不翻譯）。 */
export function memoryText(text: MemoryText | null | undefined): string {
  return text ? t(text.message, ...text.values) : "";
}

export function receiptsText(receipts: readonly MemoryReceiptView[]): string {
  return receipts.map(memoryText).filter(Boolean).join("\n");
}

/** 「本次人物」標籤的文字（輸入列與對話 Surface 用）。 */
export function presenceLabel(presence: MemoryPresenceView | null): string {
  if (!presence) return "";
  if (presence.state === "selected" && presence.name) return msg`本次人物：${presence.name}`;
  if (presence.state === "suspended") return t("本次人物：已暫停（請重新選擇）");
  return t("本次人物：未選定（只用全家共用的記憶）");
}

const CHOICE_LABEL: Record<ClarifyChoice, string> = { save: "保存", household: "改記全家共用", cancel: "取消" };
/** MEM-5b：工作決定卡的說明。 */
export const WORK_SUMMARY_NOTE = "只保存你說的這句話，連到你選的工作；不會保存工作的標題或成果。這個工作被刪除，或它用到的記憶被忘記或更正時，這筆工作決定也會一起忘記；關閉記憶或撤回同意不會刪除它。";
/** MEM-2 語音卡的主要按鈕與對應的確認詞（也可以用說的）。 */
const VOICE_ACTION_LABEL = { remember: "記住", correct: "更正", forget: "忘記" } as const;
const VOICE_PHRASE = { remember: "確認記住", correct: "確認更正", forget: "確認忘記" } as const;

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class MemoryView {
  readonly element: HTMLElement;
  private mode: Mode = { kind: "idle" };
  private status: MemoryStatusView | null = null;
  private notice: string | null = null;
  private error: string | null = null;
  private busy = false;
  private editing: string | null = null;
  /** MEM-5b：記憶管理的篩選（全部／只看工作決定）。 */
  private filter: "all" | "work" = "all";
  /** 每次打開或收起加一；晚到的 IPC 回應若世代不符就丟掉。 */
  private gen = 0;

  constructor(private readonly deps: MemoryViewDeps) {
    this.element = h("section", { class: "surface surface--memory", role: "region", "data-visibility-reason": "user_request" });
    onLocaleChange(() => this.render());
  }

  get current(): Mode["kind"] { return this.mode.kind; }

  /** 核心回的卡片（打字那一輪觸發）。chat 是卡片處理完後要送的聊天（核心保管原句，這裡只帶回來顯示）。 */
  showCard(card: MemoryCardView, requestId: string, chat: MemoryTurnView["chat"], status: MemoryStatusView | null = null): void {
    this.gen++;
    this.mode = { kind: "card", card, requestId, chat };
    this.status = status;
    this.notice = this.error = null;
    this.editing = null;
    if (card.kind === "setup" && !status) void this.loadStatus(this.gen);
    this.render();
  }

  /** 選單列「記憶…」：核心只在使用者 10 秒內點過選單列時給管理權。 */
  openManager(): void {
    const gen = ++this.gen;
    this.notice = this.error = null;
    this.editing = null;
    this.filter = "all";
    if (!this.deps.bridge) {
      this.mode = { kind: "unavailable", message: MEMORY_BROWSER_UNAVAILABLE };
      this.render();
      return;
    }
    this.mode = { kind: "manage", subject: null, facts: [], token: null, people: null, consents: [] };
    this.render();
    void this.call({ op: "list", manage: true, subject: null }, gen).then(res => this.applyList(res));
  }

  /** MEM-2：即時語音建立的卡（SSE 只帶卡片 ID）：經 IPC card_view 取內容再顯示。回傳是否顯示。 */
  async showLiveCard(card: string): Promise<boolean> {
    if (!this.deps.bridge) return false;
    const gen = ++this.gen;
    const res = await this.call({ op: "card_view", card }, gen);
    if (!res || !res.ok || res.op !== "card_view") return false;
    this.mode = { kind: "card", card: res.card, requestId: "live", chat: null, origin: res.origin };
    this.notice = this.error = null;
    this.editing = null;
    this.render();
    return true;
  }

  /** 正在顯示的是這張卡嗎（核心作廢卡片時用）。 */
  showing(card: string): boolean {
    return this.mode.kind === "card" && "card" in this.mode.card && this.mode.card.card === card;
  }

  /** MEM-2：即時語音帶著記憶時，交辦改成問使用者（標題是使用者原句，不是模型改寫的文字）。 */
  showDelegate(title: string, run: () => void): void {
    this.gen++;
    this.mode = { kind: "delegate", title, run };
    this.notice = this.error = null;
    this.render();
  }

  close(): void {
    this.gen++;
    this.mode = { kind: "idle" };
    this.notice = this.error = null;
    this.editing = null;
  }

  private async call(request: MemoryRequest, gen = this.gen): Promise<MemoryResponse | null> {
    let res: MemoryResponse;
    try {
      res = await this.deps.bridge!.memory(request);
    } catch (err) {
      res = { ok: false, code: "unavailable", message: `記憶沒有回應：${err instanceof Error ? err.message : String(err)}` };
    }
    return gen === this.gen ? res : null;
  }

  private async loadStatus(gen: number): Promise<void> {
    const res = await this.call({ op: "status" }, gen);
    if (res?.ok && res.op === "status") this.status = res;
    else if (res && !res.ok) this.error = res.message;
    this.render();
  }

  private applyList(res: MemoryResponse | null): void {
    if (!res) return;
    if (!res.ok) {
      this.mode = { kind: "unavailable", message: res.message };
    } else if (res.op === "list") {
      this.status = res.status;
      if (res.status.state !== "ready") this.mode = { kind: "unavailable", message: memoryText(res.status.reason) };
      else this.mode = { kind: "manage", subject: res.subject, facts: res.facts, token: res.manage, people: res.face_people, consents: res.consents };
    }
    this.render();
  }

  private async refreshList(subject: string | null): Promise<void> {
    const mode = this.mode;
    if (mode.kind !== "manage") return;
    this.applyList(await this.call({ op: "list", subject, ...(mode.token ? { token: mode.token } : {}) }));
  }

  /** 卡片上的選擇（點擊算直接輸入；核心用自己保存的原句重新驗證）。 */
  private async answer(choice: string, extra: { profile?: string; fact?: string; allow?: boolean; task?: string } = {}): Promise<void> {
    const mode = this.mode;
    if (mode.kind !== "card" || !("card" in mode.card) || this.busy) return;
    this.busy = true;
    this.render();
    const res = await this.call({ op: "card_answer", card: mode.card.card, choice, ...extra });
    this.busy = false;
    if (!res) return;
    if (!res.ok) { this.error = res.message; this.render(); return; }
    if (res.op === "card_answer") {
      if (mode.origin === "live") this.deps.liveResolved?.(res);
      else this.deps.resolved(res, mode.requestId);
    }
    this.render();
  }

  private async saveSetup(enabled: boolean, subject: MemorySetupSubject, allow: { provider: string; account: string }[]): Promise<void> {
    const mode = this.mode;
    if (this.busy) return;
    this.busy = true;
    this.render();
    const card = mode.kind === "card" && mode.card.kind === "setup" ? mode.card.card : undefined;
    const token = mode.kind === "manage" ? mode.token : null;
    const res = await this.call({ op: "setup", enabled, subject, allow, ...(card ? { card } : {}), ...(token ? { token } : {}) });
    this.busy = false;
    if (!res) return;
    if (!res.ok) { this.error = res.message; this.render(); return; }
    if (res.op === "setup") {
      this.status = res.status;
      if (mode.kind === "card") this.deps.resolved(res, mode.requestId);
      else { this.notice = receiptsText(res.receipts); this.deps.changed(res.receipts[0]!, res.history_reset, res.presence); void this.refreshList(mode.kind === "manage" ? mode.subject : null); }
    }
    this.render();
  }

  private async mutate(request: MemoryRequest): Promise<void> {
    if (this.busy) return;
    const mode = this.mode;
    const token = mode.kind === "manage" ? mode.token : null;
    this.busy = true;
    this.notice = this.error = null;
    this.render();
    const res = await this.call({ ...request, ...(token ? { token } : {}) } as MemoryRequest);
    this.busy = false;
    this.editing = null;
    if (!res) return;
    if (!res.ok) this.error = res.message;
    else if ("receipt" in res) {
      this.notice = memoryText(res.receipt);
      this.status = res.status;
      this.deps.changed(res.receipt, res.history_reset, res.status.presence);
      if (mode.kind === "card" && mode.card.kind === "inspect") {
        // 「你記得我什麼？」清單：重新讀一次本次人物的記憶。
        const list = await this.call({ op: "list" });
        if (list?.ok && list.op === "list") this.mode = { ...mode, card: { ...mode.card, facts: [...list.facts] } };
      } else await this.refreshList(mode.kind === "manage" ? mode.subject : null);
    }
    this.render();
  }

  // ───────────── 畫面 ─────────────

  private render(): void {
    if (this.mode.kind === "idle") { this.element.replaceChildren(); return; }
    const header = h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, t("記憶")), h("h2", {}, t(this.title())));
    const messages: Child[] = [this.notice ? h("p", { class: "notice", role: "status" }, this.notice) : null, this.error ? h("p", { class: "error-text", role: "alert" }, t(this.error)) : null];
    const footer = h("footer", { class: "surface-footer" },
      button("收起", () => this.deps.dismiss(), "btn--ghost"),
      h("span", { class: "hint" }, t("收起只關畫面，已存的記憶不會被刪除")));
    this.element.dataset.memoryMode = this.mode.kind;
    this.element.lang = getLocale() === "en" ? "en" : "zh-Hant-TW";
    this.element.replaceChildren(header, ...messages.filter((c): c is Node => !!c && typeof c !== "string"), ...this.body(), footer);
  }

  private title(): string {
    const mode = this.mode;
    if (mode.kind === "manage") return "記憶管理";
    if (mode.kind === "unavailable") return "記憶不可用";
    if (mode.kind === "delegate") return "要交辦這件事嗎？";
    if (mode.kind !== "card") return "記憶";
    switch (mode.card.kind) {
      case "setup": return "開始使用記憶";
      case "clarify": return "要記住這一句嗎？";
      case "create_profile": return "建立記憶檔";
      case "choose_profile": return "選擇本次人物";
      case "face_candidate": return "本次人物";
      case "pick": return "要改哪一筆？";
      case "inspect": return "你的記憶";
      case "voice_confirm": return mode.card.action === "remember" ? "要記住這一句嗎？" : mode.card.action === "correct" ? "要更正這筆記憶嗎？" : "要忘記這筆記憶嗎？";
      case "suggestion": return "要記住這一句嗎？";
      case "work_summary": return "要連到哪一個工作？";
    }
  }

  private body(): Node[] {
    const mode = this.mode;
    if (mode.kind === "unavailable") return [h("p", { class: "error-text" }, t(mode.message)), h("p", { class: "muted small" }, t(MEMORY_EXPLANATION))];
    if (mode.kind === "manage") return this.manage(mode);
    if (mode.kind === "delegate") {
      return [h("p", {}, msg`要交辦這件事嗎？「${mode.title}」`),
        h("p", { class: "muted small" }, t("這次通話用到了記憶，所以沒有自動交辦。不對的話請說出完整的要求。")),
        h("div", { class: "actions" }, button("交辦", () => { mode.run(); this.deps.dismiss(); }, "btn--primary"), button("不用", () => this.deps.dismiss(), "btn--ghost"))];
    }
    if (mode.kind !== "card") return [];
    const card = mode.card;
    const held = mode.chat && card.kind !== "inspect" ? h("p", { class: "muted small" }, msg`處理完這張卡片後會接著回答：${mode.chat.text}`) : null;
    const nodes: Child[] = [];
    switch (card.kind) {
      case "setup": nodes.push(...this.setup(card.text)); break;
      case "clarify":
        nodes.push(h("p", {}, memoryText(card.reason)), h("blockquote", { class: "memory-quote" }, card.value),
          h("div", { class: "actions" }, ...card.options.map(o => button(CHOICE_LABEL[o], () => void this.answer(o), o === "cancel" ? "btn--ghost" : o === "save" ? "btn--primary" : "", this.busy))));
        break;
      case "create_profile": {
        const allow = checkbox(false, !card.target);
        nodes.push(h("p", {}, msg`還沒有「${card.name}」的記憶檔。要建立嗎？`),
          card.target ? h("label", { class: "family-check" }, allow, msg` 允許 ${card.target.label} 取得 ${card.name} 的相關記憶片段`) : h("p", { class: "muted small" }, t("目前的服務沒有可用的帳號；記憶只保存在本機。")),
          h("p", { class: "muted small" }, t("這只是家中共用裝置上的人物分類，不是身分驗證。")),
          h("div", { class: "actions" }, button("建立", () => void this.answer("create", { allow: allow.checked }), "btn--primary", this.busy), button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)));
        break;
      }
      case "choose_profile":
        nodes.push(h("p", {}, msg`有多位叫「${card.name}」的人物，這次是哪一位？`),
          h("div", { class: "actions" }, ...card.profiles.map((p, i) => button(msg`${p.name}（第 ${i + 1} 位）`, () => void this.answer("select", { profile: p.id }), "", this.busy)), button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)));
        break;
      case "face_candidate":
        nodes.push(h("p", {}, msg`這次用 ${card.name} 的偏好？`),
          h("p", { class: "muted small" }, t("家人辨識只提出候選（門檻未校準），確認後才選定；不是授權。")),
          h("div", { class: "actions" }, button("是", () => void this.answer("accept"), "btn--primary", this.busy), button("不用", () => void this.answer("decline"), "btn--ghost", this.busy)));
        break;
      case "pick":
        nodes.push(h("p", {}, card.action === "correct" ? msg`有好幾筆可能要更正成「${card.value}」，是哪一筆？` : msg`有好幾筆可能要忘記，是哪一筆？`),
          h("ul", { class: "memory-list" }, ...card.candidates.map(f => h("li", { class: "memory-fact" }, h("span", {}, f.text), button("選這筆", () => void this.answer("select", { fact: f.id }), "", this.busy)))),
          h("div", { class: "actions" }, button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)));
        break;
      case "inspect":
        nodes.push(h("p", { class: "muted small" }, card.subject_name ? msg`${card.subject_name} 與全家共用的記憶` : t("全家共用的記憶（沒有選定本次人物）")),
          this.factList(card.facts, false));
        break;
      case "voice_confirm": {
        const who = card.subject_name ?? t("全家共用");
        nodes.push(h("p", {}, msg`聽到你說：「${card.heard}」`),
          card.action === "remember" ? h("p", {}, msg`要記住的是：「${card.value}」（${who}）`)
            : card.action === "correct" ? h("p", {}, msg`要把「${card.target ?? ""}」更正成：「${card.value}」（${who}）`)
              : h("p", {}, msg`要忘記：「${card.target ?? card.value}」（${who}）`),
          card.replaces ? h("p", { class: "muted small" }, t("會取代原本的說法。")) : null,
          h("p", { class: "muted small" }, msg`請核對聽到的內容。也可以在問句念完後 15 秒內說「${t(VOICE_PHRASE[card.action])}」。`),
          h("div", { class: "actions" }, ...card.options.map(o => o === "confirm" ? button(VOICE_ACTION_LABEL[card.action], () => void this.answer("confirm"), "btn--primary", this.busy)
            : o === "household" ? button("改記全家共用", () => void this.answer("household"), "", this.busy) : button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy))));
        break;
      }
      case "suggestion":
        // 正常只出現在回覆下方的一行（SuggestionPrompt）；這裡只是備用的顯示方式。
        nodes.push(h("p", {}, msg`要記住『${card.text}』嗎？`),
          h("div", { class: "actions" }, button("記住", () => void this.answer("confirm"), "btn--primary", this.busy), button("不用", () => void this.answer("decline"), "btn--ghost", this.busy)));
        break;
      case "work_summary":
        // MEM-5b：工作標題只在這張卡上給你核對（經 IPC），不會存進記憶；點選才保存。
        nodes.push(h("p", {}, card.subject_name ? msg`要把這個決定記在 ${card.subject_name} 名下，連到哪一個工作？` : t("要把這個決定連到哪一個工作？")),
          h("blockquote", { class: "memory-quote" }, card.value),
          h("ul", { class: "memory-list", "aria-label": "最近 24 小時完成的工作" }, ...card.tasks.map(task => h("li", { class: "memory-fact" },
            h("div", { class: "memory-fact-text" }, h("strong", {}, task.title), h("span", { class: "muted small" }, msg`完成於 ${when(task.finished_at)}`)),
            linkButton(task.title, () => void this.answer("task", { task: task.task_id }), this.busy)))),
          h("p", { class: "muted small" }, t(WORK_SUMMARY_NOTE)),
          h("div", { class: "actions" }, button("只記成一般筆記", () => void this.answer("note"), "", this.busy), button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)));
        break;
    }
    nodes.push(held);
    return nodes.filter((n): n is Node => !!n && typeof n !== "string");
  }

  /** 首次設定：四個獨立選項（跨對話記憶預設關閉；人物或全家共用；逐一允許服務＋帳號；自動建議首版停用）。 */
  private setup(text: string): Child[] {
    const st = this.status;
    const enabled = checkbox(false);
    const name = h("input", { type: "text", maxlength: "16", "aria-label": "新的人物名稱", placeholder: "例如：George" });
    const select = h("select", { "aria-label": "本次人物" });
    select.append(h("option", { value: "household" }, t("全家共用（不選人物）")));
    for (const p of st?.profiles ?? []) select.append(h("option", { value: p.id }, p.name));
    select.append(h("option", { value: "new" }, t("新的人物…")));
    const preset = /(?:我是|我叫|I am|I'm)\s*([^\s，,。.]{1,16})/i.exec(text)?.[1];
    if (preset) { select.value = "new"; name.value = preset; }
    const allows = (st?.targets ?? []).map(target => ({ target, box: checkbox(false) }));
    const save = () => {
      const subject = select.value === "household" ? { kind: "household" as const } : select.value === "new" ? { kind: "name" as const, name: name.value.trim() } : { kind: "profile" as const, profile: select.value };
      if (subject.kind === "name" && !subject.name) { this.error = "請輸入人物名稱，或選擇全家共用"; this.render(); return; }
      void this.saveSetup(enabled.checked, subject, allows.filter(a => a.box.checked).map(a => ({ provider: a.target.provider, account: a.target.account })));
    };
    return [
      h("p", {}, t("你剛剛要我記住：")), h("blockquote", { class: "memory-quote" }, text),
      h("p", { class: "muted small" }, t(MEMORY_EXPLANATION)),
      h("label", { class: "family-check" }, enabled, t(" 啟用跨對話記憶（預設關閉）")),
      h("label", { class: "memory-field" }, t("記在誰名下："), select), name,
      allows.length ? h("div", { class: "memory-allow" }, h("p", {}, t("允許哪些模型服務帳號取得相關片段（未允許的只保存在本機）：")),
        ...allows.map(a => h("label", { class: "family-check" }, a.box, ` ${t(a.target.label)}`))) : h("p", { class: "muted small" }, t("目前沒有可用的模型服務帳號；記憶只保存在本機。")),
      allows.some(a => a.target.provider === "codex") ? h("p", { class: "muted small" }, t(CODEX_CONSENT_NOTE)) : null,
      allows.some(a => a.target.provider === "openai_realtime") ? h("p", { class: "muted small" }, t(OPENAI_REALTIME_CONSENT_NOTE)) : null,
      allows.length ? h("p", { class: "muted small" }, t("第一次設定時，勾選的服務帳號也會一併允許取得全家共用的記憶；之後可在「記憶…」分開調整。")) : null,
      h("label", { class: "family-check" }, checkbox(false, true), t(" 自動提出記憶建議（預設關閉；要用時請在選單列「記憶…」開啟）")),
      h("p", { class: "muted small" }, t("沒有啟用或按取消時，你的問題照樣送出，但不會記住任何內容。")),
      // 取消也回核心：核心把被暫緩的問題交回來照樣送出（不寫入記憶）。
      h("div", { class: "actions" }, button("儲存設定", save, "btn--primary", this.busy), button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)),
    ];
  }

  private factList(facts: readonly MemoryFactView[], managed: boolean): HTMLElement {
    if (facts.length === 0) return h("p", { class: "muted" }, t("沒有記憶。Nous 不知道的事會照實說不知道。"));
    const ul = h("ul", { class: "memory-list" });
    for (const f of facts) {
      const source = f.source === "voice_confirmed" ? msg`來源：語音確認 · ${when(f.at)}` : f.source === "suggestion" ? msg`來源：記憶建議（按了記住） · ${when(f.at)}` : msg`來源：本人明示 · ${when(f.at)}`;
      // MEM-5a：全家共用的記憶只在查看時顯示是誰記下的（當時選定的本次人物）。
      const household = f.subject === null && f.by_name ? msg`全家共用・由 ${f.by_name} 記下・${when(f.at)}` : f.subject === null && !managed ? t("全家共用") : "";
      // MEM-5b：工作決定標出連到的工作；標題只有在目前範圍內才顯示（核心經 IPC 給）。
      const work = f.kind === "work_summary" && f.work
        ? (f.work.state === "in_scope" && f.work.title ? msg`工作決定 · 連到：${f.work.title}` : f.work.state === "missing" ? t("工作決定 · 連到的工作已不存在") : t("工作決定 · 連到的工作不在目前範圍內"))
        : f.kind === "work_summary" ? t("工作決定") : "";
      const meta = [work, source, f.expires ? msg`到 ${when(f.expires)} 為止` : "", household].filter(Boolean).join(" · ");
      const row = h("li", { class: "memory-fact", ...(f.kind === "work_summary" ? { "data-kind": "work_summary" } : {}) }, h("div", { class: "memory-fact-text" }, h("strong", {}, f.text), h("span", { class: "muted small" }, meta)));
      if (f.pinned) row.append(h("span", { class: "chip" }, t("釘選")));
      if (this.editing === f.id) {
        const input = h("input", { type: "text", maxlength: "512", "aria-label": "修改記憶內容" });
        input.value = f.text;
        row.append(input, button("保存修改", () => void this.mutate({ op: "edit", id: f.id, revision: f.revision, value: input.value }), "btn--primary", this.busy), button("取消", () => { this.editing = null; this.render(); }, "btn--ghost"));
      } else {
        row.append(
          button("修改", () => { this.editing = f.id; this.render(); }, "btn--ghost", this.busy),
          button("忘記", () => void this.mutate({ op: "forget", id: f.id, revision: f.revision }), "btn--ghost", this.busy),
          button(f.pinned ? "取消釘選" : "釘選", () => void this.mutate({ op: "pin", id: f.id, revision: f.revision, pinned: !f.pinned }), "btn--ghost", this.busy),
        );
      }
      ul.append(row);
    }
    if (facts.some(f => f.subject === null && f.by_name)) return h("div", {}, ul, h("p", { class: "muted small" }, t(ATTRIBUTION_NOTE)));
    return ul;
  }

  /** MEM-5a：記憶管理裡的記憶建議開關（需要管理權杖；NOUS_MEMORY_ROUTES 沒有列出 suggest 時照實說沒有開放）。 */
  private suggestionsControl(token: string | null): HTMLElement {
    const s = this.status?.suggestions;
    if (!s) return h("span", {});
    // 審查 m2：旗標拿掉之後，之前開著的建議仍可以在這裡關掉（降回舊版前要先關，見驗證文件 §2.6）。
    if (!s.available) return h("div", { class: "memory-allow" }, h("p", { class: "muted small" }, t("記憶建議：沒有開放（NOUS_MEMORY_ROUTES 沒有列出 suggest）。")),
      s.enabled ? button("關閉記憶建議", () => void this.mutate({ op: "suggestions", enabled: false, token: token ?? "" }), "btn--ghost", this.busy || !token) : null);
    return h("div", { class: "memory-allow" },
      h("p", {}, s.enabled ? t("記憶建議：已開啟。") : t("記憶建議：已關閉（預設）。"),
        button(s.enabled ? "關閉記憶建議" : "開啟記憶建議", () => void this.mutate({ op: "suggestions", enabled: !s.enabled, token: token ?? "" }), "btn--ghost", this.busy || !token)),
      h("p", { class: "muted small" }, t(SUGGESTIONS_NOTE)));
  }

  private manage(mode: Extract<Mode, { kind: "manage" }>): Node[] {
    const st = this.status;
    if (!st) return [h("p", { class: "muted" }, t("正在開啟…"))];
    const subjectSelect = h("select", { "aria-label": "查看誰的記憶" });
    subjectSelect.append(h("option", { value: "household" }, t("全家共用")));
    for (const p of st.profiles) subjectSelect.append(h("option", { value: p.id }, p.minor ? msg`${p.name}（未成年）` : p.name));
    subjectSelect.value = mode.subject ?? "household";
    subjectSelect.addEventListener("change", () => void this.refreshList(subjectSelect.value === "household" ? null : subjectSelect.value));
    const profile = st.profiles.find(p => p.id === mode.subject) ?? null;
    const add = h("input", { type: "text", maxlength: "512", "aria-label": "新增記憶內容", placeholder: "例如：不吃香菜" });
    const consentRows = st.targets.map(target => ({ target, box: checkbox(mode.consents.some(c => c.provider === target.provider && c.account === target.account && c.allowed)) }));
    const saveConsent = () => void this.saveSetup(st.enabled, mode.subject ? { kind: "profile", profile: mode.subject } : { kind: "household" },
      consentRows.filter(r => r.box.checked).map(r => ({ provider: r.target.provider, account: r.target.account })));
    const people = mode.people;
    // MEM-5b：只看工作決定（只篩選畫面，不改資料；不影響成果紀錄）。
    const filter = h("select", { "aria-label": "篩選記憶" });
    filter.append(h("option", { value: "all" }, t("全部")), h("option", { value: "work" }, t("工作決定")));
    filter.value = this.filter;
    filter.addEventListener("change", () => { this.filter = filter.value === "work" ? "work" : "all"; this.render(); });
    const shown = this.filter === "work" ? mode.facts.filter(f => f.kind === "work_summary") : mode.facts;
    const link = h("select", { "aria-label": "連結到家人辨識" });
    link.append(h("option", { value: "" }, t("不連結")));
    for (const p of people ?? []) if (!p.linked) link.append(h("option", { value: p.person_id }, p.name));
    return [
      h("p", {}, st.enabled ? t("記憶已開啟。") : t("記憶已關閉：不讀也不寫，已存的內容保留。"),
        button(st.enabled ? "關閉記憶" : "開啟記憶", () => void this.saveSetup(!st.enabled, mode.subject ? { kind: "profile", profile: mode.subject } : { kind: "household" }, mode.consents.filter(c => c.allowed).map(c => ({ provider: c.provider, account: c.account }))), "btn--ghost", this.busy)),
      h("p", { class: "muted small" }, msg`有效記憶 ${st.active_facts}／${st.limits.facts} 筆 · 人物 ${st.profiles.length}／${st.limits.profiles} 位`),
      h("label", { class: "memory-field" }, t("查看："), subjectSelect),
      h("label", { class: "memory-field" }, t("類別："), filter),
      profile?.minor ? h("p", { class: "notice" }, t("未成年家人的記憶由家長在這裡整理；聊天時不會直接寫入、更正或忘記。")) : h("span", {}),
      this.filter === "work" && shown.length === 0 ? h("p", { class: "muted" }, t("沒有工作決定。")) : this.factList(shown, true),
      h("div", { class: "actions" }, add, button("新增", () => void this.mutate({ op: "edit", id: null, subject: mode.subject, value: add.value }), "", this.busy)),
      this.suggestionsControl(mode.token),
      h("div", { class: "memory-allow" }, h("p", {}, mode.subject ? msg`允許哪些服務帳號取得 ${profile?.name ?? ""} 的記憶片段：` : t("允許哪些服務帳號取得全家共用的記憶片段：")),
        ...consentRows.map(r => h("label", { class: "family-check" }, r.box, ` ${t(r.target.label)}`)),
        consentRows.some(r => r.target.provider === "codex") ? h("p", { class: "muted small" }, t(CODEX_CONSENT_NOTE)) : h("span", {}),
        consentRows.some(r => r.target.provider === "openai_realtime") ? h("p", { class: "muted small" }, t(OPENAI_REALTIME_CONSENT_NOTE)) : h("span", {}),
        button("保存同意設定", saveConsent, "", this.busy)),
      profile ? h("div", { class: "actions" },
        people === null ? h("span", { class: "muted small" }, t("要連結家人辨識，請先打開一次「家人辨識…」。"))
          : h("span", {}, link, button("連結到既有人物", () => void this.mutate({ op: "link_face", profile: profile.id, person: link.value || null, token: mode.token ?? "" }), "", this.busy)),
        button(profile.minor ? "取消未成年標記" : "標為未成年", () => void this.mutate({ op: "profile_minor", profile: profile.id, minor: !profile.minor, token: mode.token ?? "" }), "btn--ghost", this.busy),
        button("刪除這個記憶檔…", () => void this.mutate({ op: "profile_delete", profile: profile.id, token: mode.token ?? "" }), "btn--ghost", this.busy)) : h("span", {}),
      // 全部忘記只在這裡（管理權杖），按下後還有系統確認。
      h("div", { class: "actions" }, button(mode.subject ? "忘記這位人物的全部記憶…" : "忘記全家共用的全部記憶…", () => void this.mutate({ op: "forget", all: true, subject: mode.subject, token: mode.token ?? "" }), "btn--ghost", this.busy || mode.facts.length === 0)),
      h("p", { class: "muted small" }, t(MEMORY_EXPLANATION)),
    ];
  }
}

/**
 * MEM-5a：對話回覆下方的一行記憶建議「要記住『我不吃香菜』嗎？［記住］［不用］」。
 * - 核心的 turn 只給卡片 ID；回覆串流結束（complete）後才經 card_view 取內容並顯示，不擋聊天。
 * - 跟著同一個 request_id（data-request-id、data-visibility-reason user_request）；不是新的常駐 Surface，收起或換一輪就消失。
 * - 只有按「記住」才寫入（card_answer confirm，核心用卡片上保存的原句重新解析）；「不用」（decline）24 小時內不再提同一件事。
 */
export interface SuggestionPromptDeps {
  bridge: MemoryBridge | null;
  /** 核心回的結果（本次人物、歷史清除）交回主程式；回條由這一行自己顯示。 */
  applied(view: MemoryTurnView): void;
  /** 內容載入或狀態改變：請主程式重畫。 */
  changed(): void;
}

type PromptState =
  | { phase: "pending"; requestId: string; card: string }
  | { phase: "loading"; requestId: string; card: string }
  | { phase: "shown"; requestId: string; card: string; text: string; busy: boolean; error: string | null }
  /** 審查 n4：保存核心的固定句型（不是翻好的字），換語言時重新翻譯。 */
  | { phase: "done"; requestId: string; receipts: MemoryReceiptView[] };

export class SuggestionPrompt {
  private state: PromptState | null = null;
  private gen = 0;
  private element: HTMLElement | null = null;
  private key = "";

  constructor(private readonly deps: SuggestionPromptDeps) {}

  /** 新的一輪帶了建議（卡片 ID）。 */
  set(requestId: string, card: string): void {
    this.gen++;
    this.state = { phase: "pending", requestId, card };
    this.element = null;
  }

  /** 換一輪、換人或世代改變：丟掉（核心那邊也已作廢）。 */
  clear(): void {
    this.gen++;
    this.state = null;
    this.element = null;
  }

  /** 正在等哪一輪（只給測試與主程式判斷）。 */
  get requestId(): string | null { return this.state?.requestId ?? null; }

  /**
   * 這一輪的回覆畫完時呼叫：requestId 相同、回覆已完成才顯示；第一次會經 card_view 取內容（取得後呼叫 changed 再畫一次）。
   * 回傳要接在回覆下方的元素；不顯示時 null。
   */
  render(requestId: string, complete: boolean): HTMLElement | null {
    const st = this.state;
    if (!st || st.requestId !== requestId || !complete || !this.deps.bridge) return null;
    if (st.phase === "pending") { void this.load(st.card, requestId); return null; }
    if (st.phase === "loading") return null;
    const key = `${getLocale()}:${JSON.stringify(st)}`;
    if (this.element && this.key === key) return this.element;
    const box = h("div", { class: "suggestion-prompt", role: "group", "aria-label": "記憶建議", "data-visibility-reason": "user_request", "data-request-id": requestId });
    if (st.phase === "done") box.append(h("p", { class: "muted small", role: "status" }, receiptsText(st.receipts)));
    else {
      box.append(h("span", {}, msg`要記住『${st.text}』嗎？`), " ",
        button("記住", () => void this.answer("confirm"), "btn--primary", st.busy),
        button("不用", () => void this.answer("decline"), "btn--ghost", st.busy));
      box.setAttribute("title", t("只有按「記住」才會保存；不會自動記住。"));
      if (st.error) box.append(h("p", { class: "error-text", role: "alert" }, t(st.error)));
    }
    this.element = box;
    this.key = key;
    return box;
  }

  private async call(request: MemoryRequest): Promise<MemoryResult> {
    try { return await this.deps.bridge!.memory(request); }
    catch (err) { return { ok: false, code: "unavailable", message: `記憶沒有回應：${err instanceof Error ? err.message : String(err)}` }; }
  }

  private async load(card: string, requestId: string): Promise<void> {
    const gen = this.gen;
    this.state = { phase: "loading", requestId, card };
    const res = await this.call({ op: "card_view", card });
    if (gen !== this.gen) return;
    // 失效（換了人物或超過時間）就不顯示：建議本來就可有可無。
    if (!res.ok || res.op !== "card_view" || res.card.kind !== "suggestion") { this.state = null; this.deps.changed(); return; }
    this.state = { phase: "shown", requestId, card, text: res.card.text, busy: false, error: null };
    this.deps.changed();
  }

  private async answer(choice: "confirm" | "decline"): Promise<void> {
    const st = this.state;
    if (!st || st.phase !== "shown" || st.busy) return;
    const gen = this.gen;
    this.state = { ...st, busy: true };
    this.deps.changed();
    const res = await this.call({ op: "card_answer", card: st.card, choice });
    if (gen !== this.gen) return;
    if (!res.ok) { this.state = { ...st, busy: false, error: res.message }; this.deps.changed(); return; }
    if (res.op === "card_answer") {
      this.deps.applied(res);
      // 「不用」：這一行直接消失；「記住」：換成核心的回條（記在 X 名下了…）。
      this.state = choice === "decline" ? null : { phase: "done", requestId: st.requestId, receipts: res.receipts };
    }
    this.deps.changed();
  }
}
