// 「家人辨識」Surface（docs/14 ID-01、ADR-0001）：只由選單列「鏡頭與語音設定 → 家人辨識…」打開（visibility_reason
// user_request）。內容：家人列表、新增家人（名稱 → 本人同意 → 自動取樣）、刪除、試認、資料說明。
// - 辨識只在這個畫面內運作（登記與試認）；收起只丟記憶體中的樣本與管理 session，不刪已存的資料。
// - 身分資料只經 macOS App 的 IPC（window.nousDesktop.identity）與核心往來；瀏覽器版明示不可用。
// - 比對、證據、名稱驗證與寫檔都在核心；這裡不算分數，也看不到分數。門檻未校準，試認畫面照實標示。

import {
  FAMILY_MAX,
  parseFamilyName,
  speakableName,
  type FaceModelVersion,
  type FamilyMember,
  type IdentityObservation,
  type IdentityRequest,
  type IdentityManageStatus,
  type IdentityResponse,
} from "../shared/identity.ts";
import { greetingSentence } from "../shared/sense.ts";
import { EnrollmentCollector, ENROLL_TARGET } from "./family-enroll.ts";
import { QUALITY_LABEL } from "./sense/face/quality.ts";
import { IdentityClient, type ClientFrame, type ClientState, type FrameSource, type WorkerLike } from "./sense/identity-client.ts";

export interface FamilyBridge {
  identity(request: IdentityRequest): Promise<IdentityResponse>;
}

export interface FamilyViewDeps {
  /** macOS App 的 IPC；瀏覽器版為 null。 */
  bridge: FamilyBridge | null;
  source: FrameSource;
  createWorker: () => WorkerLike;
  model: FaceModelVersion;
  /** 收起（dispatch dismiss）；只關畫面。 */
  dismiss: () => void;
}

export const FAMILY_EXPLANATION =
  "家人辨識只在這台 Mac 上運作：只保存加密的臉部特徵（不存照片、不上傳），只用來稱呼你，不作為解鎖、付款或任何授權的依據。" +
  "每位家人都要本人在場並同意；未成年家人由家長確認。隨時可以刪除。";
/**
 * 雲端稱名的揭露（ID-02）：登記同意與一次性說明都用這段。看過（登記同意或按「我知道了」）之前，核心不稱名。
 */
export const CLOUD_NAMING_NOTICE =
  "開啟「打招呼時稱呼認出的家人」時，看著說話認出家人後，名字會以一句短句（例如「George，我在」）送到雲端語音供應商" +
  "（ChatGPT 方案或 OpenAI API key，看你用哪一條即時語音路徑）；對話中說出的話也會照常送到那裡。臉部影像與特徵不會送出。" +
  "可以在選單列「鏡頭與語音設定」關掉，關掉後只說「我在」。";
export const FAMILY_BACKUP_NOTE =
  "刪除後新的資料無法還原；但在此之前已存在的 Time Machine 備份或 APFS 本機快照，可能仍保有舊的加密檔（這台 Mac 的應用程式金鑰不會輪換，舊檔理論上仍可解開）。";
export const UNCALIBRATED_LABEL = "門檻未校準：結果只供參考，可能認錯或認不出來";

type Phase =
  | { kind: "opening" }
  | { kind: "unavailable"; message: string }
  | { kind: "list" }
  | { kind: "name"; draft: string; minor: boolean; error: string | null }
  | { kind: "consent"; name: string; minor: boolean; consent: boolean; guardian: boolean }
  | { kind: "capture"; name: string; minor: boolean; guardian: boolean; hint: string }
  | { kind: "submitting"; name: string };

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function button(label: string, onClick: () => void, variant = "", disabled = false): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${variant}`.trim() }, label);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * 登記時預覽問候會怎麼念（只在這個畫面顯示使用者自己打的名稱，不送出）。核心組句時用同一組規則再驗一次（權威在核心）。
 */
export function namePreview(draft: string): string {
  if (!parseFamilyName(draft).ok) return "";
  const name = speakableName(draft);
  return name ? `看著說話認出時會念成：「${greetingSentence(name)}」` : "這個名稱不會被念出來：認出時只說「我在」（像句子、指令或含不能念的符號）。";
}

/** 核心給的觀測 → 畫面上的一句話（不含分數）。 */
export function observationText(obs: IdentityObservation | null, people: readonly FamilyMember[]): string {
  if (!obs) return "辨識中…";
  switch (obs.state) {
    case "matched": {
      const who = people.find((p) => p.person_id === obs.person_id);
      return who ? `認得：${who.name}` : "辨識中…";
    }
    case "unknown":
      return "不認得";
    case "ambiguous":
      return obs.reason === "multi_face" ? "畫面裡有多張臉（不會任選一位）" : "分不清是哪一位";
    case "unavailable":
      switch (obs.reason) {
        case "quality":
          return "品質不足";
        case "no_face":
          return "沒有看到臉";
        case "no_gallery":
          return "還沒有可以比對的家人";
        default:
          return "辨識中…";
      }
  }
}

export class FamilyView {
  readonly element: HTMLElement;
  private phase: Phase = { kind: "opening" };
  private session: string | null = null;
  private people: FamilyMember[] = [];
  private status: IdentityManageStatus | null = null;
  /** 取樣世代：整個畫面期間單調遞增，每個新的取樣器都接著用（不從 0 重來）。 */
  private sampleGen = 0;
  private notice: string | null = null;
  private error: string | null = null;
  private trying = false;
  private observation: IdentityObservation | null = null;
  private clientState: ClientState | null = null;
  private quality: string | null = null;
  private probing = false;
  private busy = false;
  private client: IdentityClient | null = null;
  private readonly collector = new EnrollmentCollector(ENROLL_TARGET);
  /** 每次打開或收起加一；晚到的 IPC 回應若世代不符就丟掉。 */
  private openGen = 0;
  private renderedKey: string | null = null;

  constructor(private readonly deps: FamilyViewDeps) {
    this.element = h("section", { class: "surface surface--family", role: "region", "data-visibility-reason": "user_request" });
    this.render();
  }

  /** 打開畫面：向核心開管理 session（主程序只在使用者 10 秒內點過選單列時允許）。 */
  open(): void {
    const gen = ++this.openGen;
    this.phase = { kind: "opening" };
    this.render();
    if (!this.deps.bridge) {
      this.phase = { kind: "unavailable", message: "家人辨識：瀏覽器版不可用（只在 macOS App 提供）。" };
      this.render();
      return;
    }
    void this.call({ op: "open_session" }, gen);
  }

  /** 收起：停止取樣、丟掉記憶體中的樣本與 session；已存的家人資料不動。 */
  close(): void {
    this.openGen++;
    this.stopClient();
    this.collector.discard();
    const session = this.session;
    this.session = null;
    this.trying = false;
    this.observation = null;
    this.notice = this.error = null;
    if (session && this.deps.bridge) void this.deps.bridge.identity({ op: "close_session", session }).catch(() => undefined);
    this.phase = { kind: "opening" };
    this.renderedKey = null;
  }

  private async call(request: IdentityRequest, gen = this.openGen): Promise<IdentityResponse | null> {
    let res: IdentityResponse;
    try {
      res = await this.deps.bridge!.identity(request);
    } catch (err) {
      res = { ok: false, code: "unavailable", message: `家人辨識沒有回應：${err instanceof Error ? err.message : String(err)}` };
    }
    if (gen !== this.openGen) return null;
    if (res.ok && "people" in res) {
      this.session = res.session;
      this.people = res.people;
      this.status = res.status;
      if (this.phase.kind === "opening") this.phase = { kind: "list" };
    } else if (!res.ok && (res.code === "no_session" || res.code === "not_user_initiated" || (res.code === "unavailable" && request.op === "open_session"))) {
      this.stopClient();
      this.session = null;
      this.phase = { kind: "unavailable", message: res.message };
    }
    this.render();
    return res;
  }

  // ───────────── 試認 ─────────────

  private toggleTry(): void {
    if (this.trying) {
      this.trying = false;
      this.stopClient();
    } else {
      this.trying = true;
      this.observation = null;
      this.startClient((frame) => this.onTryFrame(frame));
    }
    this.render();
  }

  private onTryFrame(frame: ClientFrame): void {
    this.quality = frame.quality === "ok" ? null : QUALITY_LABEL[frame.quality];
    if (this.probing || !this.session) {
      frame.feature?.fill(0);
      return;
    }
    this.probing = true;
    const request: IdentityRequest = {
      op: "probe",
      session: this.session,
      gen: frame.gen,
      face_count: frame.face_count,
      quality: frame.quality,
      model: this.deps.model,
      ...(frame.feature ? { feature: Array.from(frame.feature) } : {}),
    };
    frame.feature?.fill(0);
    void this.call(request).then((res) => {
      this.probing = false;
      if (res?.ok && res.op === "probe" && this.trying) this.observation = res.observation;
      else if (res && !res.ok && res.code !== "rate_limited") this.error = res.message;
      this.render();
    });
  }

  // ───────────── 新增家人 ─────────────

  private startEnroll(): void {
    this.stopTry();
    this.notice = this.error = null;
    this.phase = { kind: "name", draft: "", minor: false, error: null };
    this.render();
  }

  private submitName(draft: string, minor: boolean): void {
    const parsed = parseFamilyName(draft);
    if (!parsed.ok) {
      this.phase = { kind: "name", draft, minor, error: parsed.error };
      this.render();
      return;
    }
    this.phase = { kind: "consent", name: parsed.name, minor, consent: false, guardian: false };
    this.render();
  }

  private startCapture(name: string, minor: boolean, guardian: boolean): void {
    this.collector.discard();
    this.phase = { kind: "capture", name, minor, guardian, hint: "載入辨識模型…" };
    this.startClient((frame) => this.onCaptureFrame(frame));
    this.render();
  }

  private onCaptureFrame(frame: ClientFrame): void {
    const phase = this.phase;
    if (phase.kind !== "capture") return;
    const event = this.collector.push(frame);
    frame.feature?.fill(0);
    if (event.kind === "reset") {
      phase.hint = event.reason === "multi_face" ? "畫面裡有多張臉：已取的樣本全部丟棄，請只留一個人" : "追蹤中斷：已取的樣本全部丟棄，重新開始";
    } else if (event.kind === "slow") {
      phase.hint = `相鄰畫格隔了 ${(event.gap_ms / 1000).toFixed(1)} 秒（超過 0.5 秒，電腦可能太忙），暫時取不到樣本`;
    } else if (event.kind === "waiting") {
      phase.hint = event.quality === "ok" ? this.collector.prompt : QUALITY_LABEL[event.quality];
    } else if (event.kind === "sampled") {
      phase.hint = this.collector.prompt;
    } else if (event.kind === "done") {
      this.stopClient();
      void this.submitEnroll(phase.name, phase.minor, phase.guardian);
      return;
    }
    this.render();
  }

  private async submitEnroll(name: string, minor: boolean, guardian: boolean): Promise<void> {
    if (!this.session) return;
    const samples = this.collector.takeSamples();
    this.collector.discard();
    this.phase = { kind: "submitting", name };
    this.render();
    const res = await this.call({ op: "enroll", session: this.session, name, minor, guardian_confirmed: guardian, consent: true, model: this.deps.model, samples });
    for (const s of samples) s.fill(0);
    // 等待期間 session 可能失效（call 已把畫面改成不可用）。
    if (!res || (this.phase as Phase).kind === "unavailable") return;
    this.phase = { kind: "list" };
    if (res.ok) this.notice = `已登記「${name}」。`;
    else this.error = res.message;
    this.render();
  }

  // ───────────── 刪除與清除 ─────────────

  private async remove(person: FamilyMember): Promise<void> {
    if (!this.session || this.busy) return;
    this.stopTry();
    this.busy = true;
    this.notice = this.error = null;
    this.render();
    // 永久刪除：核心會先跳出原生確認（Action Gate），被拒就不寫檔。
    const res = await this.call({ op: "delete", session: this.session, person_id: person.person_id });
    this.busy = false;
    if (res?.ok) this.notice = `已永久刪除「${person.name}」的家人資料。`;
    else if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  private async clearAll(): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    this.render();
    const res = await this.call({ op: "clear_all", session: this.session });
    this.busy = false;
    if (res?.ok) this.notice = "已清除全部家人資料。";
    else if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  // ───────────── 取樣器 ─────────────

  private startClient(onFrame: (frame: ClientFrame) => void): void {
    this.stopClient();
    this.clientState = null;
    this.quality = null;
    this.client = new IdentityClient({
      generation: () => ++this.sampleGen,
      source: this.deps.source,
      createWorker: this.deps.createWorker,
      onFrame,
      onState: (state) => {
        this.clientState = state;
        const phase = this.phase;
        if (phase.kind === "capture" && state.kind === "ready") phase.hint = this.collector.prompt;
        this.render();
      },
    });
    this.client.start();
  }

  private stopClient(): void {
    this.client?.stop();
    this.client = null;
    this.probing = false;
  }

  private stopTry(): void {
    if (!this.trying) return;
    this.trying = false;
    this.observation = null;
    this.stopClient();
  }

  private backToList(): void {
    this.stopClient();
    this.collector.discard();
    this.phase = { kind: "list" };
    this.render();
  }

  // ───────────── 畫面 ─────────────

  /**
   * 內容沒變就不重畫：取樣時每秒最多 4 次回應，每次都換掉整個 DOM 會讓按鈕在按下與放開之間被替換，點不到「停止試認」或「取消」。
   */
  private render(): void {
    const key = JSON.stringify([
      this.phase,
      this.people,
      this.status,
      this.notice,
      this.error,
      this.busy,
      this.trying ? observationText(this.observation, this.people) : null,
      this.clientLine(),
      this.quality,
      this.collector.count,
    ]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const header = h("header", { class: "surface-header" }, h("p", { class: "eyebrow" }, "鏡頭與語音設定"), h("h2", {}, "家人辨識"));
    const body = this.body();
    const footer = h(
      "footer",
      { class: "surface-footer" },
      button("收起", () => this.deps.dismiss(), "btn--ghost"),
      h("span", { class: "hint" }, "收起只關畫面，已登記的家人不會被刪除"),
    );
    this.element.replaceChildren(header, ...body.filter((c): c is Node => !!c && typeof c !== "string"), footer);
  }

  private body(): Child[] {
    const phase = this.phase;
    const messages: Child[] = [this.notice ? h("p", { class: "notice" }, this.notice) : null, this.error ? h("p", { class: "error-text" }, this.error) : null];
    if (phase.kind === "opening") return [h("p", { class: "muted" }, "正在開啟…")];
    if (phase.kind === "unavailable") return [h("p", { class: "error-text" }, phase.message), this.explanation()];
    if (phase.kind === "name") return [...messages, this.nameStep(phase)];
    if (phase.kind === "consent") return [...messages, this.consentStep(phase)];
    if (phase.kind === "capture") return [...messages, this.captureStep(phase)];
    if (phase.kind === "submitting") return [h("p", { class: "muted" }, `正在保存「${phase.name}」…（請在系統對話框確認）`)];
    return [...messages, this.statusLines(), this.namingNotice(), this.list(), this.actions(), this.trying ? this.tryPanel() : null, this.explanation()];
  }

  private statusLines(): HTMLElement | null {
    const st = this.status;
    if (!st) return null;
    const lines: Child[] = [];
    if (st.limited_reason) lines.push(h("p", { class: "notice" }, st.limited_reason));
    if (st.backup_exclusion === "failed") lines.push(h("p", { class: "notice" }, "無法把家人資料夾排除在 Time Machine 之外：備份可能含有加密檔。"));
    if (st.needs_reenroll > 0) lines.push(h("p", { class: "notice" }, `${st.needs_reenroll} 位家人登記時的模型版本與目前不同，不會被辨識；請刪除後重新登記。`));
    if (st.damaged > 0) lines.push(h("p", { class: "notice" }, `${st.damaged} 位家人的特徵資料不完整（壞資料），不會被辨識；請刪除後重新登記。`));
    return lines.length > 0 ? h("div", { class: "family-status" }, ...lines) : null;
  }

  /** 雲端稱名的一次性說明：沒看過時顯示「我知道了」；看過之後只在資料說明裡保留同一段文字。 */
  private namingNotice(): HTMLElement | null {
    const st = this.status;
    if (!st || st.naming_notice_seen) return null;
    return h(
      "div",
      { class: "family-status" },
      h("p", { class: "notice" }, CLOUD_NAMING_NOTICE),
      h("p", { class: "muted small" }, "按「我知道了」之前，即使認出家人也只說「我在」。"),
      h("div", { class: "actions" }, button("我知道了", () => void this.ackNaming(), "btn--primary", this.busy)),
    );
  }

  private async ackNaming(): Promise<void> {
    if (!this.session || this.busy) return;
    const res = await this.call({ op: "ack_naming", session: this.session });
    if (res && !res.ok && this.phase.kind !== "unavailable") this.error = res.message;
    this.render();
  }

  private list(): HTMLElement {
    if (this.people.length === 0) return h("p", { class: "muted" }, "還沒有登記家人。");
    const ul = h("ul", { class: "family-list" });
    for (const p of this.people) {
      const date = new Date(p.created_at);
      const when = Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} 登記`;
      ul.append(
        h(
          "li",
          { class: "family-person" },
          h("div", { class: "family-person-text" }, h("strong", {}, p.name), h("span", { class: "muted small" }, when)),
          p.minor ? h("span", { class: "chip" }, "未成年") : null,
          p.needs_reenroll ? h("span", { class: "chip chip--failed" }, "需重新登記") : null,
          p.damaged ? h("span", { class: "chip chip--failed" }, "壞資料") : null,
          button("刪除", () => void this.remove(p), "btn--ghost", this.busy),
        ),
      );
    }
    return ul;
  }

  private actions(): HTMLElement {
    const st = this.status;
    const ready = !!st && st.state === "ready" && !st.limited_reason;
    const full = this.people.length >= (st?.max ?? FAMILY_MAX);
    const row = h(
      "div",
      { class: "actions" },
      button(full ? `新增家人（已滿 ${st?.max ?? FAMILY_MAX} 位）` : "新增家人", () => this.startEnroll(), "btn--primary", !ready || full || this.busy),
      button(this.trying ? "停止試認" : "試認", () => this.toggleTry(), "", !ready || this.busy),
    );
    // 只有檔案損壞才提供清除；解不開金鑰（可能只是沒允許鑰匙圈）是可以重試的，不誘導清除。
    if (st?.state === "corrupt") row.append(button("清除全部家人資料…", () => void this.clearAll(), "btn--ghost", this.busy));
    return row;
  }

  private clientLine(): string | null {
    const s = this.clientState;
    if (!s || s.kind === "loading") return "載入辨識模型…";
    if (s.kind === "no_camera") return "鏡頭沒有在運作（選單列「鏡頭與語音設定」的「鏡頭」要打開）";
    if (s.kind === "error") return s.message;
    return null;
  }

  private tryPanel(): HTMLElement {
    const line = this.clientLine();
    return h(
      "div",
      { class: "family-try", "aria-live": "polite" },
      h("p", { class: "family-result" }, line && this.clientState?.kind !== "ready" ? line : observationText(this.observation, this.people)),
      this.quality && this.observation?.reason === "quality" ? h("p", { class: "muted small" }, this.quality) : null,
      h("p", { class: "muted small" }, UNCALIBRATED_LABEL),
    );
  }

  private nameStep(phase: Extract<Phase, { kind: "name" }>): HTMLElement {
    const input = h("input", { type: "text", maxlength: "16", value: phase.draft, "aria-label": "家人的名稱", placeholder: "例如：George" });
    input.value = phase.draft;
    const minor = h("input", { type: "checkbox" });
    minor.checked = phase.minor;
    const preview = h("p", { class: "muted small", "aria-live": "polite" }, namePreview(phase.draft));
    input.addEventListener("input", () => (preview.textContent = namePreview(input.value)));
    return h(
      "div",
      { class: "family-step" },
      h("h3", {}, "新增家人：名稱"),
      h("p", { class: "muted small" }, "Nous 會用這個名稱稱呼他（1–16 個字，不能有換行或 < > { } [ ] ` \" \\）。"),
      input,
      preview,
      h("label", { class: "family-check" }, minor, " 這位家人未成年（需要家長確認同意）"),
      phase.error ? h("p", { class: "error-text" }, phase.error) : null,
      h("div", { class: "actions" }, button("下一步", () => this.submitName(input.value, minor.checked), "btn--primary"), button("取消", () => this.backToList(), "btn--ghost")),
    );
  }

  private consentStep(phase: Extract<Phase, { kind: "consent" }>): HTMLElement {
    const consent = h("input", { type: "checkbox" });
    consent.checked = phase.consent;
    const guardian = h("input", { type: "checkbox" });
    guardian.checked = phase.guardian;
    const next = button("開始取樣", () => this.startCapture(phase.name, phase.minor, guardian.checked), "btn--primary", !phase.consent || (phase.minor && !phase.guardian));
    const sync = () => {
      phase.consent = consent.checked;
      phase.guardian = guardian.checked;
      next.disabled = !phase.consent || (phase.minor && !phase.guardian);
    };
    consent.addEventListener("change", sync);
    guardian.addEventListener("change", sync);
    return h(
      "div",
      { class: "family-step" },
      h("h3", {}, `新增家人：${phase.name}`),
      h("p", {}, FAMILY_EXPLANATION),
      h("p", {}, CLOUD_NAMING_NOTICE),
      h("p", { class: "muted small" }, namePreview(phase.name)),
      h("p", { class: "muted small" }, FAMILY_BACKUP_NOTE),
      h("label", { class: "family-check" }, consent, ` ${phase.name} 本人在場，已聽過說明並同意`),
      phase.minor ? h("label", { class: "family-check" }, guardian, " 我是家長，確認同意登記這位未成年家人") : null,
      h("p", { class: "muted small" }, `接著請 ${phase.name} 一個人面對鏡頭，依提示轉動頭部；品質合格時會自動取 ${ENROLL_TARGET} 張。保存前還會跳出系統確認。`),
      h("div", { class: "actions" }, next, button("取消", () => this.backToList(), "btn--ghost")),
    );
  }

  private captureStep(phase: Extract<Phase, { kind: "capture" }>): HTMLElement {
    const line = this.clientLine();
    return h(
      "div",
      { class: "family-step", "aria-live": "polite" },
      h("h3", {}, `取樣中：${phase.name}`),
      h("p", { class: "family-result" }, line ?? phase.hint),
      h("p", { class: "muted small" }, `已取 ${this.collector.count}／${ENROLL_TARGET} 張（只在記憶體，不存照片）。中途出現多張臉或追蹤中斷會整批重來。`),
      h("div", { class: "actions" }, button("取消", () => this.backToList(), "btn--ghost")),
    );
  }

  private explanation(): HTMLElement {
    return h(
      "div",
      { class: "family-explain" },
      h("p", { class: "muted small" }, FAMILY_EXPLANATION),
      h("p", { class: "muted small" }, CLOUD_NAMING_NOTICE),
      h("p", { class: "muted small" }, FAMILY_BACKUP_NOTE),
    );
  }
}
