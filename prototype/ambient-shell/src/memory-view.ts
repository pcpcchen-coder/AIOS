import { t, msg, getLocale, onLocaleChange } from "./i18n.ts";
// 「記憶」Surface（docs/16 MEM-1）：按需出現，visibility_reason 一律是 user_request（觸發它的打字或選單列點擊）。
// 內容：首次設定（四個獨立選項）、澄清卡（保存／改記全家共用／取消）、建立或選擇人物、臉部候選「這次用 X 的偏好？」、
// 全部忘記、「你記得我什麼？」清單（修改／忘記／釘選），以及從選單列「記憶…」打開的記憶管理。
// - 記憶只經 macOS App 的 IPC（window.nousDesktop.memory）與核心往來；瀏覽器版明示不可用。
// - 規則、人物、同意、票證與寫檔都在核心；這裡只顯示核心回的固定句型（t(message, ...values)），使用者的話與人物名照原樣。
// - 不建立常駐側欄：收起就回電子腦；「本次人物」標籤只在輸入列與對話 Surface（src/main.ts）。

import type {
  ClarifyChoice,
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
}

export const MEMORY_EXPLANATION =
  "記憶只保存在這台 Mac（加密），內容是家中可使用的普通偏好，不是私密空間。取用時會把相關的幾筆送給你允許的模型服務；" +
  "沒有允許的服務不會收到。隨時可以修改、忘記或關閉；忘記不會刪除已送給模型服務的內容或系統備份。";
export const MEMORY_BROWSER_UNAVAILABLE = "記憶：瀏覽器版不可用（只在 macOS App 提供）。";

type Mode =
  | { kind: "idle" }
  | { kind: "card"; card: MemoryCardView; requestId: string; chat: MemoryTurnView["chat"] }
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
    if (!this.deps.bridge) {
      this.mode = { kind: "unavailable", message: MEMORY_BROWSER_UNAVAILABLE };
      this.render();
      return;
    }
    this.mode = { kind: "manage", subject: null, facts: [], token: null, people: null, consents: [] };
    this.render();
    void this.call({ op: "list", manage: true, subject: null }, gen).then(res => this.applyList(res));
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
  private async answer(choice: string, extra: { profile?: string; fact?: string; allow?: boolean } = {}): Promise<void> {
    const mode = this.mode;
    if (mode.kind !== "card" || !("card" in mode.card) || this.busy) return;
    this.busy = true;
    this.render();
    const res = await this.call({ op: "card_answer", card: mode.card.card, choice, ...extra });
    this.busy = false;
    if (!res) return;
    if (!res.ok) { this.error = res.message; this.render(); return; }
    if (res.op === "card_answer") this.deps.resolved(res, mode.requestId);
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
    if (mode.kind !== "card") return "記憶";
    switch (mode.card.kind) {
      case "setup": return "開始使用記憶";
      case "clarify": return "要記住這一句嗎？";
      case "create_profile": return "建立記憶檔";
      case "choose_profile": return "選擇本次人物";
      case "face_candidate": return "本次人物";
      case "pick": return "要改哪一筆？";
      case "inspect": return "你的記憶";
    }
  }

  private body(): Node[] {
    const mode = this.mode;
    if (mode.kind === "unavailable") return [h("p", { class: "error-text" }, t(mode.message)), h("p", { class: "muted small" }, t(MEMORY_EXPLANATION))];
    if (mode.kind === "manage") return this.manage(mode);
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
        ...allows.map(a => h("label", { class: "family-check" }, a.box, ` ${a.target.label}`))) : h("p", { class: "muted small" }, t("目前沒有可用的模型服務帳號；記憶只保存在本機。")),
      allows.length ? h("p", { class: "muted small" }, t("第一次設定時，勾選的服務帳號也會一併允許取得全家共用的記憶；之後可在「記憶…」分開調整。")) : null,
      h("label", { class: "family-check" }, checkbox(false, true), t(" 自動提出記憶建議（首版未提供）")),
      h("p", { class: "muted small" }, t("沒有啟用或按取消時，你的問題照樣送出，但不會記住任何內容。")),
      // 取消也回核心：核心把被暫緩的問題交回來照樣送出（不寫入記憶）。
      h("div", { class: "actions" }, button("儲存設定", save, "btn--primary", this.busy), button("取消", () => void this.answer("cancel"), "btn--ghost", this.busy)),
    ];
  }

  private factList(facts: readonly MemoryFactView[], managed: boolean): HTMLElement {
    if (facts.length === 0) return h("p", { class: "muted" }, t("沒有記憶。Nous 不知道的事會照實說不知道。"));
    const ul = h("ul", { class: "memory-list" });
    for (const f of facts) {
      const meta = [msg`來源：本人明示 · ${when(f.at)}`, f.expires ? msg`到 ${when(f.expires)} 為止` : "", f.subject === null && !managed ? t("全家共用") : ""].filter(Boolean).join(" · ");
      const row = h("li", { class: "memory-fact" }, h("div", { class: "memory-fact-text" }, h("strong", {}, f.text), h("span", { class: "muted small" }, meta)));
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
    return ul;
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
    const link = h("select", { "aria-label": "連結到家人辨識" });
    link.append(h("option", { value: "" }, t("不連結")));
    for (const p of people ?? []) if (!p.linked) link.append(h("option", { value: p.person_id }, p.name));
    return [
      h("p", {}, st.enabled ? t("記憶已開啟。") : t("記憶已關閉：不讀也不寫，已存的內容保留。"),
        button(st.enabled ? "關閉記憶" : "開啟記憶", () => void this.saveSetup(!st.enabled, mode.subject ? { kind: "profile", profile: mode.subject } : { kind: "household" }, mode.consents.filter(c => c.allowed).map(c => ({ provider: c.provider, account: c.account }))), "btn--ghost", this.busy)),
      h("p", { class: "muted small" }, msg`有效記憶 ${st.active_facts}／${st.limits.facts} 筆 · 人物 ${st.profiles.length}／${st.limits.profiles} 位`),
      h("label", { class: "memory-field" }, t("查看："), subjectSelect),
      profile?.minor ? h("p", { class: "notice" }, t("未成年家人的記憶由家長在這裡整理；聊天時不會直接寫入、更正或忘記。")) : h("span", {}),
      this.factList(mode.facts, true),
      h("div", { class: "actions" }, add, button("新增", () => void this.mutate({ op: "edit", id: null, subject: mode.subject, value: add.value }), "", this.busy)),
      h("div", { class: "memory-allow" }, h("p", {}, mode.subject ? msg`允許哪些服務帳號取得 ${profile?.name ?? ""} 的記憶片段：` : t("允許哪些服務帳號取得全家共用的記憶片段：")),
        ...consentRows.map(r => h("label", { class: "family-check" }, r.box, ` ${r.target.label}`)),
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
