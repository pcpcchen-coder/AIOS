// HomeBridge：查詢（status）、控制（control／confirm）、確認卡與速率限制、三條送出路徑、AIFA 狀態與清單、權杖與快照讀取。

import { randomUUID } from "node:crypto";
import type { HomeControlResult, HomeStatusResult, HomeTarget, RefusedReason, SendFacts } from "../../shared/home.ts";
import { acOffTimerNote, AIFA_STALE, aifaReply, buildClimate, NO_CLIMATE_TEXT, parseReport, reportedText } from "./aifa.ts";
import { ambiguous, commandsReply, isTvDevice, isTvName, parseCommand, planFor, resolveTarget, toWire, TV_MOVED, type AifaRef, type H1Command, type Plan } from "./commands.ts";
import { irReply } from "./infrared.ts";
import { aifaId, isRecord, parseAifa, parseHome, UNSUPPORTED_TEXT } from "./parse.ts";
import { metricKey, METRICS, report } from "./readings.ts";
import {
  COOLDOWN_WAIT_MS,
  H1B_TIMEOUTS_MS,
  HomeBridgeError,
  MIN_SEND_WINDOW_MS,
  TIMEOUT_MS,
  UTTERANCE_MS,
  type ControllerReport,
  type ControlRequest,
  type HomeBridgeOptions,
  type HubDevice,
  type HubReply,
  type HubSnapshot,
  type ReplyMapper,
} from "./types.ts";

const MAX_DEVICES = 12;
/** 中控的控制是同步的：送出後等 0.4 秒再回讀設備（最多 14 秒），所以逾時要比它長。 */
const COMMAND_TIMEOUT_MS = 16_000;
/** POST /devices/{id}/refresh 也是同步回讀（最多 14 秒）。 */
const REFRESH_TIMEOUT_MS = 15_000;
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
/** 伺服器端確認 ID 的期限；needs_confirmation 帶剩下的秒數，瀏覽器的確認卡取 60 秒與它的較小值。 */
const CONFIRM_TTL_MS = 90_000;
const MAX_PENDING = 8;

/** control() 時就綁定計畫、動作說法與 key；瀏覽器只拿到不透明的 confirm_id，改不了要執行的內容。 */
interface PendingCommand {
  plan: Plan;
  target: HomeTarget;
  action: string;
  key: string;
  expiresAt: number;
  /** 第一次同意後的執行；重複同意（或之後的拒絕）都拿到同一個結果，不會送第二次。 */
  run: Promise<HomeControlResult> | null;
}

type Entry = Omit<PendingCommand, "expiresAt" | "run">;

export class HomeBridge {
  private readonly fetch: typeof fetch;
  private readonly base: string | null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeouts: Record<Exclude<keyof typeof H1B_TIMEOUTS_MS, "snapshot">, number>;
  private readonly pending = new Map<string, PendingCommand>();
  /**
   * 最近一分鐘送出的控制指令時間，三條路徑共用。每個意圖在第一次控制 POST 之前才記一次（takeRate）：
   * 沒有 POST 就拒絕的（AIFA 清單重新讀取失敗、冷氣設定組不出來、已經最低、時間不夠）不算；
   * 同 key 重送、冷卻後重送、重新讀取清單後重送、重新讀取設備、/discover、/status 也都不算。
   */
  private sent: number[] = [];
  /** 每台冷氣進行中的 POST …/status；同一台不會同時有兩個。 */
  private readonly statusReads = new Map<string, Promise<ControllerReport | null | "stale">>();
  /** HOME-1：每次控制結束加一；左上角的快取看到變化就重讀。 */
  private controlCount = 0;

  constructor(private readonly options: HomeBridgeOptions) {
    this.fetch = options.fetch ?? fetch;
    this.base = options.url ? options.url.replace(/\/+$/, "") : null;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const t = H1B_TIMEOUTS_MS;
    this.timeouts = { aifaStatus: t.aifaStatus, aifaDiscover: t.aifaDiscover, aifaSend: t.aifaSend, aifaRetry: t.aifaRetry, irSend: t.irSend, irRetry: t.irRetry, ...options.timeoutsMs };
  }

  get available(): boolean {
    return !!(this.base && this.options.token);
  }

  /** 啟動訊息與設定畫面用的說明；不含權杖。 */
  get detail(): string {
    if (!this.base) return "未設定 SMARTHOME_URL";
    if (!this.options.token) return "未設定 SMARTHOME_TOKEN";
    return `${this.base}（查詢與控制）`;
  }

  /**
   * AIL-2：整合層的健康檢查。讀一次中控快照（和 status() 同一個請求）；連不上、權杖被拒、格式不符時丟 HomeBridgeError。
   * 不送任何控制指令。
   */
  async probe(): Promise<void> {
    await this.snapshot();
  }

  /** HOME-1：左上角家中狀態讀的中控快照（GET /home 與 GET /integrations/aifa，和 status() 同一份）。 */
  readSnapshot(): Promise<HubSnapshot> {
    return this.snapshot();
  }

  get changes(): number {
    return this.controlCount;
  }

  async status(target: string, metric?: string | null): Promise<HomeStatusResult> {
    const home = await this.snapshot();
    const resolved = resolveTarget(home, target);
    if (resolved.kind === "not_found") return { ok: true, status: "not_found", target };
    if (resolved.kind === "ambiguous") return ambiguous(home, resolved.candidates);
    if (metric && !metricKey(metric)) return { ok: true, status: "no_such_reading", scope: resolved.scope, metric };
    const key = (metric ? metricKey(metric) : null) ?? resolved.metric;
    const devices = key ? resolved.devices.filter((d) => d.telemetry?.metrics.some((m) => m.key === key)) : resolved.devices;
    if (key && !devices.length) return { ok: true, status: "no_such_reading", scope: resolved.scope, metric: METRICS[key][0] };
    return {
      ok: true,
      status: "ok",
      scope: resolved.scope,
      devices: devices.slice(0, MAX_DEVICES).map((d) => report(home, d, key, this.options.timeZone)),
      truncated: devices.length > MAX_DEVICES,
    };
  }

  /**
   * home_control：解析指令 → 讀中控設備清單（加上 AIFA 冷氣）比對名稱 → 只控制一台 → 依路徑訂計畫 →
   * 依政策直接執行或等確認卡。只在完全無法和中控溝通時丟 HomeBridgeError（未設定、連不上、權杖被拒、格式不符），和 status() 相同。
   */
  async control(req: ControlRequest): Promise<HomeControlResult> {
    const startedAt = this.now();
    const command = parseCommand(req.command, req.value ?? null);
    if ("error" in command) return { ok: true, status: "refused", reason: "invalid_value", message: command.error };
    if (this.options.tvHandledElsewhere && isTvName(req.target)) return { ok: true, status: "refused", reason: "unsupported", message: TV_MOVED };
    const home = await this.snapshot();
    let resolved = resolveTarget(home, req.target);
    if (this.options.tvHandledElsewhere) {
      if (resolved.kind === "match" && resolved.devices.length === 1 && isTvDevice(home, resolved.devices[0])) return { ok: true, status: "refused", reason: "unsupported", message: TV_MOVED };
      // 候選裡的電視拿掉（不會問「是電視還是音響」）；只剩一台時就是那一台。
      if (resolved.kind === "ambiguous") {
        const rest = resolved.candidates.filter((d) => !isTvDevice(home, d));
        if (rest.length !== resolved.candidates.length) resolved = rest.length === 1 ? { kind: "match", scope: rest[0].name, devices: rest, metric: null } : rest.length ? { kind: "ambiguous", candidates: rest } : { kind: "not_found" };
      }
    }
    if (resolved.kind === "not_found") {
      return home.aifa === "unavailable" ? { ok: true, status: "not_found", target: req.target, note: "AIFA 冷氣清單讀不到" } : { ok: true, status: "not_found", target: req.target };
    }
    if (resolved.kind === "ambiguous") return ambiguous(home, resolved.candidates);
    if (!resolved.devices.length) return { ok: true, status: "not_found", target: req.target };
    // 說的是房間或全家（即使裡面只有一台）就是房間指令，那是 H3：先問是哪一台，不一次控制多台。
    if (resolved.devices.length > 1 || resolved.scope !== resolved.devices[0].name) {
      return ambiguous(home, resolved.devices);
    }

    const device = resolved.devices[0];
    const target: HomeTarget = { device: device.name, room: home.rooms.find((r) => r.id === device.roomId)?.name ?? null };
    const refuse = (reason: RefusedReason, message: string): HomeControlResult => ({ ok: true, status: "refused", reason, message, ...target });
    const planned = planFor(device, command, { now: this.now(), serverTime: home.serverTime });
    if ("refuse" in planned) return refuse(planned.refuse, planned.message);

    const policy = this.options.policyFor?.(device) ?? "allow";
    if (policy === "off") return refuse("voice_disabled", `${device.name}沒有開放語音控制。`);
    const entry: Entry = { plan: planned.plan, target, action: planned.action, key: `nous_${this.newId()}` };
    if (policy === "allow") return this.submit(entry, startedAt + UTTERANCE_MS);

    this.prune();
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const confirmId = `home_${this.newId()}`;
    this.pending.set(confirmId, { ...entry, expiresAt: this.now() + CONFIRM_TTL_MS, run: null });
    return { ok: true, status: "needs_confirmation", confirm_id: confirmId, action: planned.action, expires_in_s: CONFIRM_TTL_MS / 1000, ...target };
  }

  /**
   * 確認卡結束。approve=false 只丟掉這張卡（不呼叫中控）；approve=true 用 control() 時綁定的計畫與 key 送出，
   * 重複呼叫拿到同一個結果。找不到或過期的 ID 回 expired。不重新比對名稱：使用者確認的是卡上寫的那台。
   */
  async confirm(confirmId: string, approve: boolean): Promise<HomeControlResult> {
    this.prune();
    const p = this.pending.get(confirmId);
    if (!p) return { ok: true, status: "refused", reason: "expired", message: "這張確認卡已經失效，沒有執行。" };
    if (p.run) return p.run;
    if (!approve) {
      this.pending.delete(confirmId);
      return { ok: true, status: "refused", reason: "declined", message: `沒有確認，${p.target.device}${p.action}沒有執行。`, ...p.target };
    }
    p.run = this.submit(p, this.now() + UTTERANCE_MS);
    return p.run;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  /** 速率限制：一分鐘內第 7 個指令不送出，回傳要等幾秒；沒超過時記下這一次。 */
  private takeRate(): number | null {
    const now = this.now();
    this.sent = this.sent.filter((t) => t > now - RATE_WINDOW_MS);
    if (this.sent.length >= RATE_LIMIT) return Math.max(1, Math.ceil((this.sent[0] + RATE_WINDOW_MS - now) / 1000));
    this.sent.push(now);
    return null;
  }

  /** 送出一個使用者意圖：依計畫的路徑送出。速率限制在各路徑第一次控制 POST 之前（見 sent）。deadline 只用在 AIFA／紅外線。 */
  private async submit(p: Entry, deadline: number): Promise<HomeControlResult> {
    try {
      return await this.route(p, deadline);
    } finally {
      this.controlCount++;
    }
  }

  private async route(p: Entry, deadline: number): Promise<HomeControlResult> {
    const plan = p.plan;
    switch (plan.route) {
      case "commands": {
        const wait = this.takeRate();
        if (wait !== null) return this.oneWayResult({ kind: "rate_limited", retryAfterS: wait }, p, {});
        return this.commandsResult(p, await this.sendCommands({ deviceId: plan.deviceId, command: plan.command, key: p.key }));
      }
      case "aifa_power":
      case "aifa_climate":
        return this.sendAifa(plan, p, deadline);
      case "ir_key":
        return this.sendIr(plan, p, deadline);
    }
  }

  /**
   * H1 的結果對應（不變）。state_stale 時 send() 已重新讀取設備一次，再用同一把 key 重送：中控在記下 key 之前就回 409，
   * 所以不會執行兩次。重新讀取後仍不能控制就照實說沒有送出。最壞的時間見 sendCommands()。
   */
  private commandsResult(p: Entry, reply: HubReply): HomeControlResult {
    const base = { ok: true as const, action: p.action, ...p.target };
    switch (reply.kind) {
      case "result":
        if (reply.status === "confirmed") return { ...base, status: "confirmed", message: reply.message || "設備回讀已確認" };
        if (reply.status === "failed") return { ...base, status: "failed", reason: "device", message: reply.message || "中控回報失敗" };
        return { ...base, status: "unconfirmed", why: "hub_unverified", message: reply.message || "已送出，尚未從設備確認" };
      case "stale":
        return { ok: true, status: "refused", reason: "not_ready", message: `${p.target.device}的狀態還沒更新，指令沒有送出；請稍後再試，或先在中控重新讀取設備。`, ...p.target };
      case "refused":
        return { ok: true, status: "refused", reason: reply.reason, message: reply.reason === "invalid_value" ? reply.message : `${p.target.device}${reply.message}`, ...p.target };
      case "key_conflict":
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：指令編號重複，沒有執行" };
      case "gone":
        return { ok: true, status: "not_found", target: p.target.device };
      case "retry":
        return reply.maybeReceived
          ? { ...base, status: "unconfirmed", why: "no_reply", message: "中控沒有回覆，不確定有沒有執行，請看一下設備" }
          : { ...base, status: "failed", reason: "hub_unreachable", message: "無法連線到武陵居中控，指令沒有送出" };
      case "cooldown":
      case "too_late":
      case "rate_limited":
        // commandsReply 不會產生這三種（H1 的 429 是 HomeBridgeError，也沒有 deadline；速率限制在 submit）。
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：無法解讀中控的回覆，沒有執行" };
    }
  }

  /**
   * H1：一個意圖最多 POST 兩次，都用同一把 key 與內容（中控會回傳已記下的結果，不會再執行）。
   * 唯一的一次重送給第一次的逾時、5xx 或連線問題，或給 state_stale（先重新讀取設備）；重送之後不論結果都不再送。
   * 最壞：POST 16 秒 + 重新讀取 15 秒 + POST 16 秒 = 47 秒（算法見 docs/validation/smarthome-h1-2026-10-22.md）。
   */
  private async sendCommands(p: { deviceId: string; command: H1Command; key: string }): Promise<HubReply> {
    const path = `/api/v1/devices/${encodeURIComponent(p.deviceId)}/commands`;
    const body = JSON.stringify(toWire(p.command));
    const first = await this.post(path, body, p.key);
    if (first.kind === "retry") {
      const second = await this.post(path, body, p.key);
      return second.kind === "retry" ? { kind: "retry", maybeReceived: first.maybeReceived || second.maybeReceived } : second;
    }
    if (first.kind === "stale" && (await this.refresh(p.deviceId))) return this.post(path, body, p.key);
    return first;
  }

  /**
   * AIFA 冷氣的開關或設定。清單快過期（或中控回 409 清單過期）時先 POST /integrations/aifa/discover 一次；
   * 設定先讀 POST …/status，缺的項目用預設值並說出來；送出最多兩次 POST，同一把 key 與內容（見 postTwice）。
   * 每一步都在 deadline 之內（UTTERANCE_MS）。
   */
  private async sendAifa(plan: Extract<Plan, { route: "aifa_power" | "aifa_climate" }>, p: Entry, deadline: number): Promise<HomeControlResult> {
    const left = () => deadline - this.now();
    const ref = plan.aifa;
    const device = p.target.device;
    /** 這次有沒有重新讀取過清單（每個意圖最多一次）；cooldown＝中控說一分鐘內有人讀過。 */
    const state: { discovered: "no" | "ok" | "cooldown" } = { discovered: "no" };
    /** 重新讀取 AIFA 清單一次；不能繼續時回傳沒有送出的原因。 */
    const discover = async (): Promise<HubReply | null> => {
      const d = await this.discoverAifa(Math.min(this.timeouts.aifaDiscover, left()));
      if (d.kind === "failed") {
        return { kind: "refused", reason: "not_ready", message: `AIFA 冷氣清單超過 24 小時，重新讀取沒有成功（${d.message}），指令沒有送出；請到中控的 AIFA 頁重新讀取。` };
      }
      state.discovered = d.kind;
      if (d.kind === "ok") {
        const fresh = d.devices.find((x) => x.id === aifaId(ref.hubId, ref.childId));
        if (!fresh) return { kind: "refused", reason: "not_ready", message: `重新讀取 AIFA 清單後找不到${device}，指令沒有送出。` };
        if (fresh.route.kind !== "aifa") return { kind: "refused", reason: "unsupported", message: `${device}${UNSUPPORTED_TEXT.aifa_other}` };
        if (plan.route === "aifa_climate" && !fresh.route.climate) return { kind: "refused", reason: "unsupported", message: `${device}${NO_CLIMATE_TEXT}` };
      }
      return null;
    };

    if (this.now() >= ref.freshUntil) {
      const stop = await discover();
      if (stop) return this.oneWayResult(stop, p, {});
    }

    let body: string;
    const facts: SendFacts = {};
    if (plan.route === "aifa_power") {
      body = JSON.stringify({ power: plan.power });
    } else {
      let read = await this.readAifaStatus(ref, left());
      if (read === "stale" && state.discovered === "no") {
        const stop = await discover();
        if (stop) return this.oneWayResult(stop, p, {});
        read = await this.readAifaStatus(ref, left());
      }
      const report = read === "stale" ? null : read;
      const built = buildClimate(plan.change, report, plan.caps);
      if ("error" in built) return { ok: true, status: "refused", reason: "invalid_value", message: built.error, ...p.target };
      body = JSON.stringify(built.packet);
      facts.sent_settings = built.text;
      if (built.defaultsUsed.length) facts.defaults_used = built.defaultsUsed;
      if (report?.power !== true) {
        facts.note =
          report?.power === false
            ? "控制器回報冷氣是關的：這個設定不代表會開機，要開冷氣請說「開冷氣」。"
            : "讀不到控制器的開關狀態：這個設定不代表會開機，要開冷氣請說「開冷氣」。";
      }
    }

    const path = `/api/v1/integrations/aifa/devices/${encodeURIComponent(ref.hubId)}/children/${encodeURIComponent(ref.childId)}/${plan.route === "aifa_power" ? "power" : "climate"}`;
    let reply = await this.postTwice({
      path,
      body,
      key: p.key,
      map: aifaReply,
      deadline,
      firstMs: this.timeouts.aifaSend,
      retryMs: this.timeouts.aifaRetry,
      cooldownMs: COOLDOWN_WAIT_MS.aifa,
      onStale: () => (state.discovered === "no" ? discover() : Promise.resolve({ kind: "stale" } as HubReply)),
    });
    if (reply.kind === "stale") {
      // 清單已重新讀取（或剛剛有人讀過、還在 60 秒冷卻）中控仍說過期：照中控的話說，沒有送出。
      reply = {
        kind: "refused",
        reason: "not_ready",
        message: `中控回覆「${AIFA_STALE}」，指令沒有送出${state.discovered === "cooldown" ? "；剛剛有人重新讀取過，一分鐘內不能再讀，請一分鐘後再說一次" : ""}。`,
        ...(state.discovered === "cooldown" ? { retryAfterS: 60 } : {}),
      };
    }
    const reported = reply.kind === "result" ? reportedText(reply.controller) : undefined;
    if (reported) facts.controller_reported = reported;
    if (plan.route === "aifa_power" && !plan.power) {
      const timer = acOffTimerNote(reply);
      if (timer) facts.note = timer;
    }
    return this.oneWayResult(reply, p, facts);
  }

  /** 紅外線家電按一個鍵：POST /devices/{id}/infrared-commands {key, key_id}，最多兩次（見 postTwice）。不呼叫紅外線同步。 */
  private async sendIr(plan: Extract<Plan, { route: "ir_key" }>, p: Entry, deadline: number): Promise<HomeControlResult> {
    const reply = await this.postTwice({
      path: `/api/v1/devices/${encodeURIComponent(plan.deviceId)}/infrared-commands`,
      body: JSON.stringify({ key: plan.key.key, key_id: plan.key.key_id }),
      key: p.key,
      map: irReply,
      deadline,
      firstMs: this.timeouts.irSend,
      retryMs: this.timeouts.irRetry,
      cooldownMs: COOLDOWN_WAIT_MS.infrared,
    });
    return this.oneWayResult(reply, p, { key: plan.key.label, ...(plan.toggle ? { toggle: true as const } : {}) });
  }

  /**
   * AIFA／紅外線：一個意圖最多 POST 兩次，同一把 key 與內容。唯一的一次重送給：
   * 逾時、5xx 或連線問題（中控回傳已記下的結果）；冷卻 429（中控在記下 key 之前就拒絕，等一下再送）；
   * 清單過期 409（onStale 重新讀取清單後再送）。剩下的時間少於 MIN_SEND_WINDOW_MS 就不再開始 POST。
   * 第一次 POST 之前才算速率限制（每個意圖一次）。
   * 第一次可能已經送到時，第二次若說「沒有送出」（409 等）不採信：中控在比對已記下的 key 之前就會先檢查清單與授權。
   */
  private async postTwice(o: {
    path: string;
    body: string;
    key: string;
    map: ReplyMapper;
    deadline: number;
    firstMs: number;
    retryMs: number;
    cooldownMs: number;
    onStale?: () => Promise<HubReply | null>;
  }): Promise<HubReply> {
    const left = () => o.deadline - this.now();
    if (left() < MIN_SEND_WINDOW_MS) return { kind: "too_late" };
    // 這個意圖的第一次控制 POST：這時才算一次速率限制；下面的重送都不再算。
    const wait = this.takeRate();
    if (wait !== null) return { kind: "rate_limited", retryAfterS: wait };
    const first = await this.post(o.path, o.body, o.key, o.map, Math.min(o.firstMs, left()));
    let nextMs: number;
    if (first.kind === "retry") nextMs = o.retryMs;
    else if (first.kind === "cooldown") {
      await this.sleep(o.cooldownMs);
      nextMs = o.firstMs;
    } else if (first.kind === "stale" && o.onStale) {
      const stop = await o.onStale();
      if (stop) return stop;
      nextMs = o.firstMs;
    } else return first;
    if (left() < MIN_SEND_WINDOW_MS) return first.kind === "stale" ? { kind: "too_late" } : first;
    const second = await this.post(o.path, o.body, o.key, o.map, Math.min(nextMs, left()));
    if (first.kind === "retry" && second.kind === "retry") return { kind: "retry", maybeReceived: first.maybeReceived || second.maybeReceived };
    if (first.kind === "retry" && first.maybeReceived && second.kind !== "result") return { kind: "retry", maybeReceived: true };
    return second;
  }

  /** AIFA／紅外線的結果：永遠不是 confirmed。 */
  private oneWayResult(reply: HubReply, p: Entry, facts: SendFacts): HomeControlResult {
    const base = { ok: true as const, action: p.action, ...p.target };
    const what = p.plan.route === "ir_key" ? "家電" : "冷氣";
    switch (reply.kind) {
      case "result":
        // 失敗時不帶「送出的設定」與預設值（中控可能根本沒送出）；紅外線只留按的是哪個鍵。
        if (reply.status === "failed") return { ...base, status: "failed", reason: "device", message: reply.message || "中控回報失敗", ...(facts.key ? { key: facts.key } : {}) };
        return {
          ...base,
          status: "unconfirmed",
          why: reply.why ?? "no_reply",
          message: reply.message || (reply.why === "one_way" ? "已送出，請看一下有沒有反應" : `不確定有沒有送出，請看一下${what}`),
          ...facts,
        };
      case "stale":
        return { ok: true, status: "refused", reason: "not_ready", message: `中控回覆「${AIFA_STALE}」，指令沒有送出。`, ...p.target };
      case "cooldown":
        return {
          ok: true,
          status: "refused",
          reason: "rate_limited",
          retry_after_s: reply.retryAfterS,
          message: `中控要求兩次控制之間稍等，「${p.action}」沒有送出，請等 ${reply.retryAfterS} 秒再說。`,
          ...p.target,
        };
      case "refused":
        return { ok: true, status: "refused", reason: reply.reason, message: reply.message, ...(reply.retryAfterS ? { retry_after_s: reply.retryAfterS } : {}), ...p.target };
      case "key_conflict":
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：指令編號重複，沒有執行" };
      case "gone":
        return { ok: true, status: "not_found", target: p.target.device };
      case "retry":
        return reply.maybeReceived
          ? { ...base, status: "unconfirmed", why: "no_reply", message: `中控沒有回覆，不確定有沒有送出，請看一下${what}`, ...facts }
          : { ...base, status: "failed", reason: "hub_unreachable", message: "無法連線到武陵居中控，指令沒有送出" };
      case "too_late":
        return { ok: true, status: "refused", reason: "not_ready", message: `中控回應太慢，「${p.action}」沒有送出，請再說一次。`, ...p.target };
      case "rate_limited":
        return {
          ok: true,
          status: "refused",
          reason: "rate_limited",
          retry_after_s: reply.retryAfterS,
          message: `一分鐘內控制指令太多，這個沒有送出，請等 ${reply.retryAfterS} 秒再說。`,
          ...p.target,
        };
    }
  }

  /** 一次 POST；回覆交給該路徑的 mapper。fetch 失敗都是 retry（連線被拒例外：中控一定沒收到）。 */
  private async post(path: string, body: string, key: string, map: ReplyMapper = commandsReply, timeoutMs = this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS): Promise<HubReply> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": key },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (err) {
      return { kind: "retry", maybeReceived: !refusedConnection(err) };
    }
    this.checkAuth(res, "控制設備");
    const data: unknown = await res.json().catch(() => null);
    return map(res.status, data);
  }

  /** POST /devices/{id}/refresh（同步回讀）；成功回 true，任何錯誤都回 false。 */
  private async refresh(deviceId: string): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.base}/api/v1/devices/${encodeURIComponent(deviceId)}/refresh`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS),
      });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * POST …/children/{c}/status（沒有 body、沒有冷卻、不算速率限制）：控制器記得的設定。
   * 逾時或其他錯誤回 null（呼叫端用預設值並說出來）；清單過期回 "stale"。
   */
  private async readAifaStatus(ref: AifaRef, budgetMs: number): Promise<ControllerReport | null | "stale"> {
    // 留下送出需要的時間；不夠就不讀，改用預設值（會說出來）。
    const timeout = Math.min(this.timeouts.aifaStatus, budgetMs - MIN_SEND_WINDOW_MS);
    if (timeout <= 0) return null;
    const id = aifaId(ref.hubId, ref.childId);
    const running = this.statusReads.get(id);
    if (running) {
      // 同一台正在讀：等那一次的結果，最多等自己的時間，不另外送第二個請求。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeout)));
      return Promise.race([running, late]).finally(() => clearTimeout(timer));
    }
    const read = this.fetchAifaStatus(ref, timeout).finally(() => {
      if (this.statusReads.get(id) === read) this.statusReads.delete(id);
    });
    this.statusReads.set(id, read);
    return read;
  }

  private async fetchAifaStatus(ref: AifaRef, timeout: number): Promise<ControllerReport | null | "stale"> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/integrations/aifa/devices/${encodeURIComponent(ref.hubId)}/children/${encodeURIComponent(ref.childId)}/status`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeout)),
      });
    } catch {
      return null;
    }
    this.checkAuth(res, "讀取冷氣狀態");
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 409 && isRecord(data) && data.detail === AIFA_STALE) return "stale";
    if (!res.ok || !isRecord(data)) return null;
    return parseReport(data.status);
  }

  /** POST /integrations/aifa/discover 一次。429（一分鐘內有人讀過）不算失敗：照樣送出，由中控決定。 */
  private async discoverAifa(timeoutMs: number): Promise<{ kind: "ok"; devices: HubDevice[] } | { kind: "cooldown" } | { kind: "failed"; message: string }> {
    if (timeoutMs <= 0) return { kind: "failed", message: "時間不夠" };
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/integrations/aifa/discover`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "failed", message: "中控沒有回應" };
    }
    this.checkAuth(res, "重新讀取 AIFA 清單");
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 429) return { kind: "cooldown" };
    if (res.ok) {
      const parsed = parseAifa(data, []);
      return parsed.aifa === "unavailable" ? { kind: "failed", message: "中控回傳的清單格式不符" } : { kind: "ok", devices: parsed.devices };
    }
    const detail = isRecord(data) ? data.detail : undefined;
    return { kind: "failed", message: typeof detail === "string" && detail ? detail : `HTTP ${res.status}` };
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" };
  }

  private checkAuth(res: Response, what: string): void {
    if (res.status === 401) throw new HomeBridgeError("武陵居中控拒絕了權杖（401），請到中控「系統接入」重新核發後更新 SMARTHOME_TOKEN。", 502, { code: "auth" });
    if (res.status === 403) throw new HomeBridgeError(`這把中控權杖沒有${what}的權限（403）。`, 502, { code: "auth" });
  }

  /** GET /home 與 GET /integrations/aifa 同時讀；AIFA 讀不到不影響 /home 的設備（燈照樣能控制）。 */
  private async snapshot(): Promise<HubSnapshot> {
    const [home, aifa] = await Promise.all([this.home(), this.aifaList()]);
    const merged = aifa === null ? { aifa: "unavailable" as const, devices: [] } : parseAifa(aifa, home.devices);
    return { ...home, devices: [...home.devices, ...merged.devices], aifa: merged.aifa };
  }

  /** GET /api/v1/integrations/aifa；任何錯誤都回 null，不丟例外。 */
  private async aifaList(): Promise<unknown> {
    if (!this.base || !this.options.token) return null;
    try {
      const res = await this.fetch(`${this.base}/api/v1/integrations/aifa`, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
  }

  private async home(): Promise<HubSnapshot> {
    if (!this.base || !this.options.token) throw new HomeBridgeError("尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）。", 409, { code: "not_configured" });
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/home`, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      throw new HomeBridgeError(
        timedOut ? "武陵居中控沒有回應（逾時）。" : "無法連線到武陵居中控，請確認中控有在執行、位址正確。",
        502,
        { cause: err, code: timedOut ? "timeout" : "unreachable" },
      );
    }
    this.checkAuth(res, "讀取設備");
    if (!res.ok) throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${res.status}）。`, 502, { code: "bad_response" });
    try {
      return parseHome(await res.json());
    } catch (err) {
      throw new HomeBridgeError("武陵居中控回傳的資料格式不符，無法讀取。", 502, { cause: err, code: "bad_response" });
    }
  }
}

/** 連線被拒（ECONNREFUSED）：中控一定沒收到；其他錯誤（逾時、連上後中斷）都可能已經收到。 */
function refusedConnection(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === "ECONNREFUSED";
}
