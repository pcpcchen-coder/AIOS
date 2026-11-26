import type { DuckLink, LinkSnapshot } from "../../duck/link.ts";
import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import type { AdapterCatalog, ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";
import type { AckMessage, PresenceState } from "../../../shared/duck-link.ts";
import { compactState, DUCK_TIMING, isMock, lookReadback, missionReadback, runDuckCommand, sendDuckPresence, stateReadback, type CommandSpec, type DuckTiming } from "../../duck/exec.ts";
import { DUCK_TEXT } from "../../duck/text.ts";

// DUCK-1：DuckAdapter，service = "duck"。把 app.duck.* 工具轉成 duck-link 指令，交給一隻會動的機器鴨（Nous Duck repo（pcpcchen-coder/Open_Duck_Mini））。
// - Nous 只下意圖；安全判斷（夾限、跌倒、緊急停止、租約）都在鴨子本機，這裡不做也不能繞過。
// - 結果語意見 duck-exec.ts 開頭。所有動作類工具的 confirmed 都只代表「鴨子已接受並開始」，不是做完、走到或找到。
// - 這個 Adapter 不知道也不保存鴨子在哪個位址：連線由 duck-link hub 持有（鴨子主動連進來），這裡只拿到 DuckLink 介面。
// - 模型不能做的事（刻意不提供工具）：關扭力、重開機、寫舵機設定、解除緊急停止、串流關節角度、
//   建圖與改禁區、取得影像或錄音、放寬隱私設定。duck-link v0 的 schema 裡也沒有這些操作。
//
// 不給模型的 duck-link 指令：
//   presence：由語音工作階段的真實事件驅動（server/duck/session-bridge.ts），不是模型的決定；讓模型呼叫等於讓它演「正在聽」。
//   sound：本機提示音屬於終端的回饋，不是模型的工具。
//   resume：解除暫停會讓之後的 walk 生效，屬於「有人在場」的操作；預設不給模型（要不要給由使用者決定）。
// track 給模型：使用者會說「看著我」「不要一直看我」，而且 Nous 只是開關，跟隨本身在鴨子本機計算。

export const DUCK_TOOL = {
  status: "app.duck.status",
  walk: "app.duck.walk",
  stop: "app.duck.stop",
  look: "app.duck.look",
  gesture: "app.duck.gesture",
  antennas: "app.duck.antennas",
  express: "app.duck.express",
  track: "app.duck.track",
  where: "app.duck.where",
  places: "app.duck.places",
  missionStatus: "app.duck.mission_status",
  goTo: "app.duck.go_to",
  findPerson: "app.duck.find_person",
  returnHome: "app.duck.return_home",
  cancelMission: "app.duck.cancel_mission",
  followMe: "app.duck.follow_me",
  waitHere: "app.duck.wait_here",
} as const satisfies Record<string, IntegrationToolId>;

/**
 * 第一階段交給模型的工具（使用者 2026-11-26 的決定：先開鴨子現在有硬體、或到貨就能用的）。
 * 其餘工具的定義都在，但 enabled 為 false：AIOS 的 Registry 把它們當成 disabled，不會出現在模型的工具表。
 * 硬體到了要開哪一個，就把它的 ID 加進這裡（並重新產生 AIOS 的模型工具基準檔）。
 */
export const DUCK_STAGE1_TOOLS: ReadonlySet<string> = new Set(["app.duck.status", "app.duck.stop", "app.duck.look", "app.duck.gesture", "app.duck.express", "app.duck.track"]);

const ROUTES = ["api_key", "live"] as const;
const NAME = /^[a-z0-9_]{1,48}$/;
const STARTED = "回傳 confirmed 只代表鴨子已接受並開始，不代表已經做完";
const STARTED_EN = "A confirmed result only means the duck accepted and started, not that it finished";
const NEEDS = "鴨子要開機並連上 Nous。";

const ALL_TOOLS: readonly ToolDefinition[] = [
  {
    id: DUCK_TOOL.status,
    description: "查詢鴨子（會走路的機器人）的連線、模式、頭部角度、任務、位置與各項能力是否可用。能力標示 unsupported 的功能目前不能用；標示 mock 的是模擬。",
    descriptionEn: "Read the duck robot's link, mode, head angles, mission, location and which capabilities are available. Capabilities marked unsupported cannot be used right now; mock means simulated.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 3_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "查詢鴨子的狀態與目前能用的能力。", examples: ["鴨子現在怎麼樣？", "鴨子有連線嗎？"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.walk,
    description: `讓鴨子以指定速度走一小段時間，時間到自己停。速度與時間超出鴨子的限制會被鴨子夾限（實際值在 applied）。${STARTED}；鴨子不會回報走了多遠。要走到某個地點請用 app.duck.go_to。`,
    descriptionEn: `Make the duck walk at a given velocity for a short time; it stops by itself. Values beyond the duck's limits are clamped by the duck (see applied). ${STARTED_EN}; the duck does not report distance travelled. To reach a place use app.duck.go_to.`,
    inputSchema: {
      type: "object",
      properties: {
        vx: { type: "number", description: "前進速度 m/s（正＝往前）", minimum: -0.15, maximum: 0.15 },
        vy: { type: "number", description: "側移速度 m/s（正＝往左）", minimum: -0.2, maximum: 0.2 },
        yaw_rate: { type: "number", description: "轉向速度 rad/s（正＝逆時針）", minimum: -1, maximum: 1 },
        duration_s: { type: "number", description: "走幾秒（鴨子端另有上限）", minimum: 0.1, maximum: 10 },
      },
      required: ["duration_s"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 5_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "讓鴨子往前、往旁邊走或原地轉一小段時間。", examples: ["鴨子往前走兩秒", "鴨子向左轉一下"], needs: "鴨子要能走路（足底開關與 IMU 就緒），而且周圍沒有會摔下去的地方。", domain: null },
  },
  {
    id: DUCK_TOOL.stop,
    description: "讓鴨子立刻停下：停止走路、停止跟隨、取消進行中的任務，站好。任何時候都可以呼叫。confirmed 代表已讀到鴨子停下。",
    descriptionEn: "Stop the duck now: stop walking, stop tracking, cancel any mission and stand still. Can be called at any time. Confirmed means the duck was read back as stopped.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "讓鴨子立刻停下。", examples: ["鴨子停", "鴨子不要動"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.look,
    description: `讓鴨子的頭轉到指定姿態（絕對角度，弧度）。沒給的軸維持原樣；超出範圍會被鴨子夾限。${STARTED}：data.reached 為 true 才是已到位。`,
    descriptionEn: `Turn the duck's head to an absolute pose in radians. Omitted joints keep their target; out-of-range values are clamped by the duck. ${STARTED_EN}: the head has arrived only when data.reached is true.`,
    inputSchema: {
      type: "object",
      properties: {
        neck_pitch: { type: "number", description: "頸部俯仰 rad", minimum: -1.6, maximum: 1.6 },
        head_pitch: { type: "number", description: "頭部俯仰 rad（正＝抬頭，依鴨子端 duckd 的慣例；尚未在實機確認方向）", minimum: -1.6, maximum: 1.6 },
        head_yaw: { type: "number", description: "頭部左右轉 rad（正＝往左）", minimum: -1.6, maximum: 1.6 },
        head_roll: { type: "number", description: "頭部歪頭 rad", minimum: -1.6, maximum: 1.6 },
        duration_s: { type: "number", description: "幾秒內轉到（鴨子可能因限速而更慢）", minimum: 0.1, maximum: 10 },
      },
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 8_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "讓鴨子的頭轉向某個方向。", examples: ["鴨子看左邊", "鴨子抬頭"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.gesture,
    description: `讓鴨子做一個預錄的動作（例如點頭、搖頭、歪頭）。name 只能用鴨子回報的清單（app.duck.status 的 gestures）。${STARTED}。`,
    descriptionEn: `Play one of the duck's pre-recorded gestures (for example nod, shake, tilt). name must come from the list the duck reports (gestures in app.duck.status). ${STARTED_EN}.`,
    inputSchema: { type: "object", properties: { name: { type: "string", description: "動作名稱（小寫英數與底線）", minLength: 1, maxLength: 48 } }, required: ["name"], additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 6_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "讓鴨子點頭、搖頭或做其他預錄動作。", examples: ["鴨子點點頭", "鴨子搖頭"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.antennas,
    description: "設定鴨子兩支天線的位置（−1 到 1）或播放一個擺動樣式。沒有裝天線舵機時鴨子會回報沒有這項能力。目前的協定沒有天線位置的回讀，所以最多只會是 unconfirmed。",
    descriptionEn: "Set the duck's two antenna positions (−1 to 1) or play a wiggle pattern. Without antenna servos the duck reports the capability as missing. The current protocol has no antenna read-back, so the result is at best unconfirmed.",
    inputSchema: {
      type: "object",
      properties: {
        left: { type: "number", description: "左天線 −1～1", minimum: -1, maximum: 1 },
        right: { type: "number", description: "右天線 −1～1", minimum: -1, maximum: 1 },
        pattern: { type: "string", description: "擺動樣式名稱（小寫英數與底線）", minLength: 1, maxLength: 48 },
      },
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "擺動鴨子的天線。", examples: ["鴨子動動天線"], needs: "要裝天線舵機。", domain: null },
  },
  {
    id: DUCK_TOOL.express,
    description: "讓鴨子的眼睛（兩個圓螢幕）顯示一個表情。expression 只能用鴨子回報的清單（app.duck.status 的 expressions）。沒有裝眼睛螢幕時鴨子會回報沒有這項能力。confirmed 代表讀回的表情已經是這個。",
    descriptionEn: "Show an expression on the duck's eyes (two round displays). expression must come from the list the duck reports (expressions in app.duck.status). Without eye displays the duck reports the capability as missing. Confirmed means the expression read back matches.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "表情名稱（小寫英數與底線）", minLength: 1, maxLength: 48 },
        duration_s: { type: "number", description: "維持幾秒後回到平常的表情（不給＝一直維持）", minimum: 0.1, maximum: 60 },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "換鴨子眼睛的表情。", examples: ["鴨子笑一個", "鴨子做個好奇的表情"], needs: "要裝眼睛螢幕。", domain: null },
  },
  {
    id: DUCK_TOOL.track,
    description: "開關鴨子的跟隨注視：face＝頭跟著人臉、sound＝頭轉向聲音、none＝停止。跟隨在鴨子本機計算，需要鏡頭或麥克風陣列；沒有時鴨子會回報沒有這項能力。confirmed 代表設定已生效，不代表已經看到人。",
    descriptionEn: "Turn the duck's gaze tracking on or off: face follows a face, sound turns toward a voice, none stops. Tracking is computed on the duck and needs a camera or microphone array; without them the duck reports the capability as missing. Confirmed means the setting is in effect, not that a person was found.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "跟隨對象", enum: ["none", "face", "sound"] },
        body: { type: "boolean", description: "頭轉到底時是否允許原地轉身（預設不允許）" },
        timeout_s: { type: "number", description: "幾秒後自動停止跟隨", minimum: 1, maximum: 600 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "讓鴨子的頭跟著人臉或聲音，或停止跟隨。", examples: ["鴨子看著我", "鴨子不要一直看我"], needs: "要裝鏡頭（人臉）或麥克風陣列（聲音）。", domain: null },
  },
  {
    id: DUCK_TOOL.where,
    description: "查詢鴨子現在在哪個地點、定位是否可靠、是否在充電座上。地點是地圖上的 ID。",
    descriptionEn: "Read which place the duck is in, whether localization is reliable and whether it is on its dock. Places are map IDs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 3_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "查詢鴨子在家裡的哪裡。", examples: ["鴨子在哪裡？"], needs: "鴨子要有地圖並完成定位。", domain: null },
  },
  {
    id: DUCK_TOOL.places,
    description: "列出鴨子地圖上可以去的地點 ID（給 app.duck.go_to 用）。",
    descriptionEn: "List the place IDs on the duck's map (for app.duck.go_to).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 3_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "列出鴨子知道的地點。", examples: ["鴨子可以去哪些地方？"], needs: "鴨子要有地圖。", domain: null },
  },
  {
    id: DUCK_TOOL.missionStatus,
    description: "查詢鴨子目前任務（去某地、找人、回充電座、跟隨）的狀態與進度。",
    descriptionEn: "Read the state and progress of the duck's current mission (go to a place, find a person, return to dock, follow).",
    inputSchema: { type: "object", properties: { mission_id: { type: "string", description: "任務編號（可省略＝目前的任務）", minLength: 1, maxLength: 64 } }, additionalProperties: false },
    effect: "read",
    enabled: true,
    timeoutMs: 3_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "查詢鴨子的任務進度。", examples: ["鴨子到了嗎？"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.goTo,
    description: `讓鴨子自己導航到地圖上的一個地點（place 用 app.duck.places 的 ID）。這是非同步任務：${STARTED}——confirmed 是「已出發」，不是「已到達」。到達或失敗會之後以事件回報，也可以用 app.duck.mission_status 查。`,
    descriptionEn: `Have the duck navigate by itself to a place on its map (place is an ID from app.duck.places). This is an asynchronous mission: ${STARTED_EN} — confirmed means "set off", not "arrived". Arrival or failure is reported later as an event, or query app.duck.mission_status.`,
    inputSchema: { type: "object", properties: { place: { type: "string", description: "地點 ID（小寫英數與底線）", minLength: 1, maxLength: 48 } }, required: ["place"], additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 6_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "叫鴨子走到家裡的某個地點。", examples: ["鴨子去客廳"], needs: "鴨子要能走路、有地圖並完成定位。", domain: null },
  },
  {
    id: DUCK_TOOL.findPerson,
    description: `讓鴨子在附近找人，找到後面向對方。person 是家人 ID（可省略＝找任何人）。非同步任務：${STARTED}——confirmed 是「開始找」，不是「找到了」。`,
    descriptionEn: `Have the duck look for a person nearby and face them. person is a family member ID (omit to find anyone). Asynchronous mission: ${STARTED_EN} — confirmed means "started looking", not "found".`,
    inputSchema: { type: "object", properties: { person: { type: "string", description: "家人 ID（小寫英數與底線；可省略）", minLength: 1, maxLength: 48 } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 6_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "叫鴨子去找人。", examples: ["鴨子去找人"], needs: "鴨子要能走路並裝有鏡頭。", domain: null },
  },
  {
    id: DUCK_TOOL.returnHome,
    description: `讓鴨子回充電座。非同步任務：${STARTED}——confirmed 是「開始回去」，不是「已到充電座」或「已在充電」；是否充電以鴨子之後回報的事件為準。`,
    descriptionEn: `Send the duck back to its dock. Asynchronous mission: ${STARTED_EN} — confirmed means "heading back", not "docked" or "charging"; charging is established only by the duck's later events.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 6_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "叫鴨子回充電座。", examples: ["鴨子回家", "鴨子去充電"], needs: "要有充電座，鴨子要能走路並完成定位。", domain: null },
  },
  {
    id: DUCK_TOOL.cancelMission,
    description: "取消鴨子目前的任務並停下。confirmed 代表讀回已經沒有進行中的任務。",
    descriptionEn: "Cancel the duck's current mission and stop. Confirmed means no mission reads back as active.",
    inputSchema: { type: "object", properties: { mission_id: { type: "string", description: "任務編號（可省略＝目前的任務）", minLength: 1, maxLength: 64 } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "取消鴨子正在做的任務。", examples: ["鴨子不用去了"], needs: NEEDS, domain: null },
  },
  {
    id: DUCK_TOOL.followMe,
    description: `讓鴨子跟著剛才叫它的人走。非同步任務：${STARTED}——confirmed 是「開始找你」，不是「已跟上」。`,
    descriptionEn: `Have the duck follow the person who just called it. Asynchronous mission: ${STARTED_EN} — confirmed means "started looking for you", not "caught up".`,
    inputSchema: { type: "object", properties: { distance_m: { type: "number", description: "保持的距離（公尺）", minimum: 0.5, maximum: 3 } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 6_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "叫鴨子跟著你走。", examples: ["鴨子跟我來"], needs: "鴨子要能走路並裝有鏡頭。", domain: null },
  },
  {
    id: DUCK_TOOL.waitHere,
    description: "讓鴨子停止目前的任務，原地站好等待。任何時候都可以呼叫。confirmed 代表讀回鴨子已進入等待。",
    descriptionEn: "Have the duck stop its current mission and wait in place. Can be called at any time. Confirmed means the duck reads back as waiting.",
    inputSchema: { type: "object", properties: { timeout_min: { type: "number", description: "最多等幾分鐘", minimum: 0.1, maximum: 240 } }, additionalProperties: false },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 4_000,
    supportedRoutes: ROUTES,
    catalog: { summary: "叫鴨子在原地等。", examples: ["鴨子在這裡等我"], needs: NEEDS, domain: null },
  },
];

/** 全部 17 個工具的定義；enabled 依 DUCK_STAGE1_TOOLS。還沒啟用的工具在給人看的總表上隱藏（hidden），不讓人以為現在能用。 */
export const DUCK_TOOLS: readonly ToolDefinition[] = ALL_TOOLS.map((tool) => (DUCK_STAGE1_TOOLS.has(tool.id) ? { ...tool, enabled: true } : { ...tool, enabled: false, catalog: { ...tool.catalog, hidden: true } }));

/** 對面是真的鴨子還是模擬，要看連進來的那一端（hello.mock），所以是 "config"。 */
export const DUCK_CATALOG: AdapterCatalog = { id: "duck", service: "duck", label: "鴨子", mock: "config", tools: DUCK_TOOLS };

export interface DuckAdapterOptions {
  timing?: Partial<DuckTiming>;
  /** 只給測試用：17 個工具全部啟用，不看 DUCK_STAGE1_TOOLS。核心不要設。 */
  enableAllTools?: boolean;
}

const given = (args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

export class DuckAdapter implements IntegrationAdapter {
  readonly id = "duck";
  readonly service = "duck";
  readonly version = 1;
  private readonly timing: DuckTiming;

  private readonly definitions: readonly ToolDefinition[];

  constructor(
    private readonly link: DuckLink,
    options: DuckAdapterOptions = {},
  ) {
    this.timing = { ...DUCK_TIMING, ...options.timing };
    this.definitions = options.enableAllTools ? DUCK_TOOLS.map((tool) => ({ ...tool, enabled: true })) : DUCK_TOOLS;
  }

  /** 連進來的鴨子自稱是模擬（hello.mock 或 state.mock）時為 true；結果與狀態一律標示。 */
  get mock(): boolean {
    return isMock(this.link.snapshot());
  }

  tools(): readonly ToolDefinition[] {
    return this.definitions;
  }

  async health(): Promise<HealthReport> {
    const snapshot = this.link.snapshot();
    if (!snapshot.connected) return { health: "unavailable", reason: snapshot.hello ? "connection_closed" : "unreachable" };
    if (snapshot.stateAt === null || Date.now() - snapshot.stateAt > this.timing.staleStateMs) return { health: "unknown", reason: "not_ready" };
    return { health: "available", reason: "ok" };
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const base = { signal: ctx.signal, requestId: ctx.requestId };
    const run = (spec: Omit<CommandSpec, "signal" | "requestId">) => runDuckCommand(this.link, { ...spec, ...base }, this.timing);
    const refuse = (message: string) => toolResult("refused", this.mock ? `${DUCK_TEXT.mockPrefix}${message}` : message, { reason: "invalid_arguments", data: { sent: false, ...(this.mock ? { mock: true } : {}) } });

    switch (toolId) {
      case DUCK_TOOL.status:
        return this.status(base);
      case DUCK_TOOL.walk: {
        const duration = Number(args.duration_s);
        return run({
          action: "walk",
          params: given(args, ["vx", "vy", "yaw_rate", "duration_s"]),
          // 走路指令的 ttl 到期且沒有續送就會停（duck-link 的規定），所以 ttl 要蓋過整段時間。
          ttlMs: Math.min(60_000, Math.round(duration * 1000) + 500),
          readback: async (c) => {
            const seen = await c.link.waitFor((o) => (o.kind === "state" ? o.state.mode === "walking" || (o.state.velocity_cmd?.remaining_s ?? 0) > 0 : o.event.event === "walk_done" && o.event.request_id === c.requestId), {
              sinceSeq: c.sentSeq,
              timeoutMs: c.timing.readbackMs,
              ...(c.signal ? { signal: c.signal } : {}),
            });
            if (seen === "link_lost" || seen === "aborted") return seen;
            return seen === "timeout" ? { status: "unconfirmed", message: DUCK_TEXT.walkUnconfirmed } : { status: "confirmed", message: DUCK_TEXT.walkConfirmed };
          },
        });
      }
      case DUCK_TOOL.stop:
        return run({
          action: "stop",
          ttlMs: 1_000,
          skipCapabilityCheck: true,
          readback: stateReadback((s) => s.mode !== "walking" && !s.mission && !(s.velocity_cmd?.vx || s.velocity_cmd?.vy || s.velocity_cmd?.yaw_rate), { confirmed: DUCK_TEXT.stopConfirmed, unconfirmed: DUCK_TEXT.stopUnconfirmed }),
        });
      case DUCK_TOOL.look: {
        const params = given(args, ["neck_pitch", "head_pitch", "head_yaw", "head_roll", "duration_s"]);
        if (!["neck_pitch", "head_pitch", "head_yaw", "head_roll"].some((k) => params[k] !== undefined)) return refuse(DUCK_TEXT.lookNeedsJoint);
        const duration = typeof params.duration_s === "number" ? params.duration_s : 1;
        return run({ action: "look", params, ttlMs: Math.min(60_000, Math.round(duration * 1000) + 1_000), readback: (c) => lookReadback(c, params) });
      }
      case DUCK_TOOL.gesture: {
        const name = String(args.name);
        if (!NAME.test(name)) return refuse(DUCK_TEXT.badName);
        const known = this.link.snapshot().hello?.gestures;
        if (known && !known.includes(name)) return toolResult("refused", this.mock ? `${DUCK_TEXT.mockPrefix}${DUCK_TEXT.gestureUnknown}` : DUCK_TEXT.gestureUnknown, { reason: "invalid_arguments", data: { sent: false, gestures: known, ...(this.mock ? { mock: true } : {}) } });
        return run({
          action: "gesture",
          params: { name },
          ttlMs: 3_000,
          // v0 的 state 沒有「正在做哪個動作」；能回讀的只有 gesture_done 事件，或 state 顯示鴨子正由 duck-link 控制。
          readback: async (c) => {
            const seen = await c.link.waitFor((o) => (o.kind === "event" ? o.event.event === "gesture_done" && o.event.request_id === c.requestId : o.seq > c.ackSeq && o.state.control_source === "duck_link"), {
              sinceSeq: c.sentSeq,
              timeoutMs: c.timing.gestureReadbackMs,
              ...(c.signal ? { signal: c.signal } : {}),
            });
            if (seen === "link_lost" || seen === "aborted") return seen;
            if (seen === "timeout") return { status: "unconfirmed", message: DUCK_TEXT.gestureUnconfirmed };
            return { status: "confirmed", message: DUCK_TEXT.gestureConfirmed, data: { evidence: seen.kind === "event" ? "gesture_done" : "state_control_source" } };
          },
        });
      }
      case DUCK_TOOL.antennas: {
        const params = given(args, ["left", "right", "pattern"]);
        if (!Object.keys(params).length) return refuse(DUCK_TEXT.antennasNeedsValue);
        if (params.pattern !== undefined && !NAME.test(String(params.pattern))) return refuse(DUCK_TEXT.badName);
        // v0 的 state 沒有天線位置，沒辦法回讀。
        return run({ action: "antennas", params, ttlMs: 3_000 });
      }
      case DUCK_TOOL.express: {
        const expression = String(args.expression);
        if (!NAME.test(expression)) return refuse(DUCK_TEXT.badName);
        const known = this.link.snapshot().hello?.expressions;
        if (known && known.length && !known.includes(expression)) return toolResult("refused", this.mock ? `${DUCK_TEXT.mockPrefix}${DUCK_TEXT.expressUnknown}` : DUCK_TEXT.expressUnknown, { reason: "invalid_arguments", data: { sent: false, expressions: known, ...(this.mock ? { mock: true } : {}) } });
        return run({
          action: "express",
          params: given(args, ["expression", "duration_s"]),
          ttlMs: 3_000,
          readback: stateReadback((s) => s.expression === expression, { confirmed: DUCK_TEXT.expressConfirmed, unconfirmed: DUCK_TEXT.expressUnconfirmed }),
        });
      }
      case DUCK_TOOL.track: {
        const target = String(args.target);
        return run({
          action: "track",
          params: given(args, ["target", "body", "timeout_s"]),
          ttlMs: 3_000,
          readback: stateReadback((s) => s.tracking === target, { confirmed: DUCK_TEXT.trackConfirmed, unconfirmed: DUCK_TEXT.trackUnconfirmed }),
        });
      }
      case DUCK_TOOL.where:
        return run({ action: "where", ttlMs: 2_000, onRead: (ack, snap) => ({ message: DUCK_TEXT.where, data: { where: ack.data ?? null, location: snap.state?.location ?? null } }) });
      case DUCK_TOOL.places:
        return run({ action: "places", ttlMs: 2_000, onRead: (ack) => ({ message: DUCK_TEXT.places, data: { places: ack.data ?? null } }) });
      case DUCK_TOOL.missionStatus:
        return run({
          action: "mission_status",
          params: given(args, ["mission_id"]),
          ttlMs: 2_000,
          skipCapabilityCheck: true,
          onRead: (ack, snap) => ({ message: DUCK_TEXT.missionStatus, data: { mission_status: ack.data ?? null, mission: snap.state?.mission ?? null } }),
          // 沒有任務時，有的鴨子端實作回 accepted＋空資料，有的回 rejected: no_mission（協定沒有規定，見
          // 已在 Nous Duck repo 提出）。兩種都是「讀到了：沒有任務」，不是失敗。
          onRejected: (ack: AckMessage, snap: LinkSnapshot) => (ack.reason === "no_mission" && args.mission_id === undefined && snap.state && !snap.state.mission ? this.wrap("confirmed", DUCK_TEXT.cancelNothing, snap, { mission: null }) : null),
        });
      case DUCK_TOOL.goTo: {
        const place = String(args.place);
        if (!NAME.test(place)) return refuse(DUCK_TEXT.badName);
        return run({ action: "go_to", params: { place }, ttlMs: 5_000, readback: (c) => missionReadback(c, { confirmed: DUCK_TEXT.missionStarted }) });
      }
      case DUCK_TOOL.findPerson: {
        if (args.person !== undefined && !NAME.test(String(args.person))) return refuse(DUCK_TEXT.badName);
        return run({ action: "find_person", params: given(args, ["person"]), ttlMs: 5_000, readback: (c) => missionReadback(c, { confirmed: DUCK_TEXT.findStarted }) });
      }
      case DUCK_TOOL.returnHome:
        return run({ action: "return_home", ttlMs: 5_000, readback: (c) => missionReadback(c, { confirmed: DUCK_TEXT.homeStarted }) });
      case DUCK_TOOL.followMe:
        return run({ action: "follow_me", params: { target: "speaker", ...given(args, ["distance_m"]) }, ttlMs: 5_000, readback: (c) => missionReadback(c, { confirmed: DUCK_TEXT.followStarted }) });
      case DUCK_TOOL.cancelMission:
        return run({
          action: "cancel_mission",
          params: given(args, ["mission_id"]),
          ttlMs: 2_000,
          skipCapabilityCheck: true,
          readback: stateReadback((s) => !s.mission, { confirmed: DUCK_TEXT.cancelConfirmed, unconfirmed: DUCK_TEXT.cancelUnconfirmed }),
          // 鴨子說沒有任務，而且最新的 state 也讀到沒有任務：想要的結果（沒有進行中的任務）已經成立。
          onRejected: (ack: AckMessage, snap: LinkSnapshot) => (ack.reason === "no_mission" && args.mission_id === undefined && snap.state && !snap.state.mission ? this.wrap("confirmed", DUCK_TEXT.cancelNothing, snap, { duck_reason: "no_mission" }) : null),
        });
      case DUCK_TOOL.waitHere:
        return run({
          action: "wait_here",
          params: given(args, ["timeout_min"]),
          ttlMs: 2_000,
          skipCapabilityCheck: true,
          readback: stateReadback((s) => s.mode === "waiting", { confirmed: DUCK_TEXT.waitConfirmed, unconfirmed: DUCK_TEXT.waitUnconfirmed }),
        });
      default:
        return toolResult("refused", DUCK_TEXT.notRegistered, { reason: "not_registered" });
    }
  }

  private wrap(status: ToolResult["status"], message: string, snapshot: LinkSnapshot, extra: Record<string, unknown> = {}): ToolResult {
    const mock = isMock(snapshot);
    const state = compactState(snapshot, this.timing);
    return toolResult(status, mock ? `${DUCK_TEXT.mockPrefix}${message}` : message, { data: { ...(mock ? { mock: true } : {}), ...extra, connected: snapshot.connected, ...(state ? { state } : {}) } });
  }

  private async status(base: { signal: AbortSignal; requestId: string }): Promise<ToolResult> {
    const snapshot = this.link.snapshot();
    if (!snapshot.connected) {
      // 讀取類：沒有連線時回最後一次的狀態並標示過時，不假裝是現況。
      return toolResult("failed", snapshot.state ? DUCK_TEXT.statusStale : DUCK_TEXT.statusNever, { reason: "unavailable", data: { connected: false, ...(isMock(snapshot) ? { mock: true } : {}), ...(snapshot.state ? { state: compactState(snapshot, this.timing) } : {}) } });
    }
    return runDuckCommand(
      this.link,
      {
        action: "status",
        ttlMs: 2_000,
        skipCapabilityCheck: true,
        ...base,
        onRead: (_ack, snap) => ({
          message: DUCK_TEXT.status,
          data: {
            duck: { software: snap.hello?.software ?? null, duck_id: snap.hello?.duck_id ?? null },
            capabilities: Object.fromEntries(Object.entries(snap.state?.capabilities ?? snap.hello?.capabilities ?? {}).map(([k, v]) => [k, v?.status])),
            gestures: snap.hello?.gestures ?? [],
            expressions: snap.hello?.expressions ?? [],
            link_rtt_ms: snap.rttMs,
            // ack.data 不放進來：duckd 的 status 會回整份 state（和下面的 state 摘要重複），
            // 加上去會讓 data 逼近 AIOS 的 4096 bytes 上限（對 duckd 實測 2750 bytes），超過就整個被丟掉。
          },
        }),
      },
      this.timing,
    );
  }

  // ---- 不給模型的操作 ----

  /** presence：語音工作階段的真實狀態。不是模型工具（核心走 sendDuckPresence，不經過這裡）。 */
  presence(state: PresenceState, speechLevel?: number, signal?: AbortSignal): Promise<ToolResult> {
    return sendDuckPresence(this.link, state, speechLevel, signal, this.timing);
  }

  /** resume：解除暫停。只給在場的人用；不是模型工具，核心目前沒有呼叫它。 */
  resume(signal?: AbortSignal): Promise<ToolResult> {
    return runDuckCommand(
      this.link,
      { action: "resume", ttlMs: 2_000, skipCapabilityCheck: true, ...(signal ? { signal } : {}), readback: stateReadback((s) => s.mode !== "paused", { confirmed: DUCK_TEXT.resumeConfirmed, unconfirmed: DUCK_TEXT.resumeUnconfirmed }) },
      this.timing,
    );
  }
}
