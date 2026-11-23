// 武陵居中控橋接（server/home/）共用的型別、錯誤類別與逾時常數；由 server/home-bridge.ts 重新匯出。

import type { AcFan, AcFeature, AcMode, AcSwing, HomeCommand, RefusedReason, UnconfirmedWhy } from "../../shared/home.ts";

export const TIMEOUT_MS = 8_000;

/**
 * H1b 的逾時（毫秒）。最壞時間的算法寫在 tests/home-bridge.test.ts 的 budget 測試與
 * docs/validation/smarthome-h1b-2026-10-22.md，測試把這些常數加起來，不另外寫死總和。
 */
export const H1B_TIMEOUTS_MS = {
  /** GET /home 與 GET /integrations/aifa 同時讀，各 8 秒。 */
  snapshot: TIMEOUT_MS,
  /** POST …/status：連線 5 + 授權 3 + 讀 3.6 秒，可能先換 AIFA 權杖（10 秒）。 */
  aifaStatus: 22_000,
  /** POST /integrations/aifa/discover：廠商清單 10 秒，可能先換權杖 10 秒，加上排隊。 */
  aifaDiscover: 25_000,
  /** AIFA 送出：中控沒有整體逾時（約 12.6 秒，換權杖約 22.6 秒）；同 key 重送等中控的鎖後拿已記下的結果。 */
  aifaSend: 16_000,
  aifaRetry: 12_000,
  /** 紅外線：Tuya 每次呼叫 8 秒，可能先取權杖 8 秒。 */
  irSend: 16_000,
  irRetry: 10_000,
} as const;
/** 中控冷卻（AIFA 全域 2 秒、紅外線每個控制器 1 秒）回 429 後，等這麼久再用同一把 key 重送一次。 */
export const COOLDOWN_WAIT_MS = { aifa: 2_200, infrared: 1_200 } as const;
/** 一句話（一次 control 或 confirm）在 AIFA／紅外線路徑最多花的時間；每一步的逾時都被它截短。 */
export const UTTERANCE_MS = 60_000;
/** 剩下的時間少於這個就不再開始 POST（第一次之前：沒有送出；之後：不確定有沒有執行）。 */
export const MIN_SEND_WINDOW_MS = 5_000;

export interface HomeBridgeOptions {
  /** SMARTHOME_URL，例如 http://127.0.0.1:8788；分機部署時改成中控的區網位址。 */
  url: string | null;
  /** SMARTHOME_TOKEN，中控「系統接入」核發的權杖。 */
  token: string | null;
  fetch?: typeof fetch;
  /** 念給使用者聽的時間用哪個時區；未指定時用這台電腦的時區。 */
  timeZone?: string;
  /**
   * 只給測試用：讓確認卡流程可以被觸發。不從 .env 或任何檔案讀，nous.ts 也不傳，所以出貨時每台設備都是 allow
   * （George 的決定）。H2 改讀中控每台設備的 voice 設定後刪掉。
   */
  policyFor?: (device: HubDevice) => VoicePolicy;
  /**
   * LGTV-1（George 2026-11-07）：電視改由 lg_tv（app.tv.*）直接控制時為 true。home_control 不再控制中控裡的電視
   * （說「電視」「客廳電視」「LG 電視」，或客廳裡名稱以電視結尾的設備），回 refused；其他房間的電視（例如臥室電視）與查詢（home_status）不受影響。
   */
  tvHandledElsewhere?: boolean;
  /** 毫秒；速率限制與確認卡期限用，測試可替換。 */
  now?: () => number;
  /** 指令 ID（Idempotency-Key）與確認卡 ID 的來源，測試可替換。 */
  newId?: () => string;
  /** 測試用：縮短控制與重新讀取的逾時。 */
  commandTimeoutMs?: number;
  refreshTimeoutMs?: number;
  /** 測試用：縮短 AIFA／紅外線各步驟的逾時。 */
  timeoutsMs?: Partial<Record<Exclude<keyof typeof H1B_TIMEOUTS_MS, "snapshot">, number>>;
  /** 中控冷卻後的等待；測試換成推進假時鐘。 */
  sleep?: (ms: number) => Promise<void>;
}

export type VoicePolicy = "allow" | "confirm" | "off";

/** home_control 的原始參數（模型送來的字串）；只在 parseCommand 解析一次。 */
export interface ControlRequest {
  target: string;
  command: string;
  value?: string | number | boolean | null;
}

/** 中控 GET /api/v1/home 裡 AIOS 會用到的部分（在邊界解析，其他欄位忽略）。 */
export interface HubMetric {
  key: string;
  label: string;
  unit: string;
  precision: number;
  value: number | string | boolean | null;
}

export type HubDataStatus = "live" | "snapshot" | "stale" | "missing";

/** 紅外線家電同步到的一個按鍵，照中控 /home 的 infrared.keys[]。 */
export interface IrKey {
  key: string;
  key_id: number;
  label: string;
}

/** AIFA 冷氣（設定碼 173）的可用範圍，來自中控 GET /integrations/aifa 的 capabilities。 */
export interface AifaClimateCaps {
  minC: number;
  maxC: number;
  modes: AcMode[];
  fans: AcFan[];
  swings: AcSwing[];
  features: AcFeature[];
}

/**
 * 這台設備怎麼控制。只在 parseHome（routeOf）與 parseAifa 決定一次，之後都依它分流。
 * - commands：H1 的 POST /devices/{id}/commands；configured 只有這條路徑用得到。
 * - aifa：AIFA 冷氣（GET /integrations/aifa 的子設備，不是中控的設備）；listQueriedAt 是中控的時鐘（秒）。
 * - infrared：Tuya 紅外線家電；中控的 configured 對它永遠是 false，只看 infrared.ready。
 * - unsupported：冷氣但不是 AIFA（Tuya kt／ktkzq、Home Assistant climate.*）、AIFA 控制器本身、
 *   紅外線控制器本身（wnykq）、其他遙控器／按鈕、AIFA 的非冷氣家電。
 */
export type DeviceRoute =
  | { kind: "commands"; configured: boolean }
  | { kind: "aifa"; hubId: string; childId: string; climate: AifaClimateCaps | null; listQueriedAt: number | null }
  | { kind: "infrared"; keys: IrKey[]; ready: boolean; controllerName: string | null; error: string | null }
  | { kind: "unsupported"; why: UnsupportedWhy };

export type UnsupportedWhy = "air_con" | "aifa_controller" | "ir_blaster" | "remote" | "aifa_other";

export interface HubDevice {
  id: string;
  name: string;
  aliases: string[];
  kind: string;
  roomId: string | null;
  /** AIFA 冷氣：清單裡的 online，最多可能是 24 小時前的；所以 fresh 一律 false，查詢時不說成在線。 */
  available: boolean | null;
  fresh: boolean;
  /** 只有 AIFA 子設備有：available 是哪一次讀 AIFA 清單得到的（queried_at，中控時鐘的秒；沒有時 null）。離線要連時間一起說，不說成現在。 */
  listedAt?: number | null;
  /** HOME-1：中控 /home 的 state.values.power（SmartHomeAI 的 observation 把開關放在 values）；中控沒給時 null，不從其他欄位猜。 */
  power?: boolean | null;
  /** 中控算好的 state.age_seconds（中控時鐘）；沒有時 null。 */
  observedAgeS?: number | null;
  route: DeviceRoute;
  telemetry: { metrics: HubMetric[]; status: HubDataStatus; receivedAt: number | null; source: string } | null;
}

/** GET /integrations/aifa 讀到了沒有；讀不到時不影響 /home 的設備，但「找不到冷氣」要說是清單讀不到。 */
export type AifaListState = "ok" | "not_connected" | "unavailable";

export interface HubSnapshot {
  rooms: { id: string; name: string }[];
  /** /home 的設備加上 AIFA 冷氣。 */
  devices: HubDevice[];
  serverTime: number;
  /** 只有 snapshot() 會填；parseHome 單獨用時沒有。 */
  aifa?: AifaListState;
}

/** HOME-1：讀中控失敗的類別（右上角以外的呼叫端只看 message 與 status）。 */
export type HomeBridgeErrorCode = "not_configured" | "timeout" | "unreachable" | "auth" | "bad_response";

export class HomeBridgeError extends Error {
  readonly code: HomeBridgeErrorCode | null;
  constructor(message: string, readonly status: number, options?: ErrorOptions & { code?: HomeBridgeErrorCode }) {
    super(message, options);
    this.code = options?.code ?? null;
  }
}

/** 一次 POST 的結果（不出 HomeBridge）。 */
export type HubReply =
  | { kind: "result"; status: "confirmed" | "unconfirmed" | "failed"; message: string; why?: UnconfirmedWhy; controller?: ControllerReport | null }
  /** commands：409 state_stale；AIFA：409「請先重新讀取 AIFA 家電清單」。中控在記下 key 之前就拒絕。 */
  | { kind: "stale" }
  /** AIFA／紅外線的冷卻 429：中控在記下 key 之前就拒絕，同一把 key 重送是安全的。 */
  | { kind: "cooldown"; retryAfterS: number }
  | { kind: "refused"; reason: Extract<RefusedReason, "not_configured" | "not_ready" | "unsupported" | "invalid_value">; message: string; retryAfterS?: number }
  /** 同一把 key 用在不同指令：只可能是 AIOS 的錯（每個意圖都產生新 key），不重試。 */
  | { kind: "key_conflict" }
  | { kind: "gone" }
  /** maybeReceived：逾時、連上後中斷或 5xx，中控可能已經執行；連線被拒則一定沒收到。 */
  | { kind: "retry"; maybeReceived: boolean }
  /** 這句話的時間（UTTERANCE_MS）不夠，沒有開始 POST：中控沒有收到。 */
  | { kind: "too_late" }
  /** AIOS 自己的每分鐘上限（RATE_LIMIT），在第一次 POST 之前：中控沒有收到。 */
  | { kind: "rate_limited"; retryAfterS: number };

export type ReplyMapper = (status: number, data: unknown) => HubReply;

/** 控制器（不是冷氣本身）記得的設定；冷氣關著時 mode 與 temperature 是 null。 */
export interface ControllerReport {
  power: boolean | null;
  mode: AcMode | null;
  temperature: number | null;
  fan: AcFan | null;
  swing: AcSwing | null;
  feature: AcFeature | null;
}

export type ClimateChange = Extract<HomeCommand, { command: "ac_temperature" | "ac_mode" | "ac_fan" | "ac_swing" }>;

/** AIFA 冷氣設定的完整內容（中控要求每個欄位都有；feature 明確送出，避免把睡眠／強力清掉）。 */
export interface ClimatePacket {
  mode: AcMode;
  temperature: number;
  fan: AcFan;
  swing: AcSwing;
  feature: AcFeature;
}

export type Refusal = { refuse: RefusedReason; message: string };
