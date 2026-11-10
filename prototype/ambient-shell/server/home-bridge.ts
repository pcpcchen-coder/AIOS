// 武陵居中控（SmartHomeAI）的本機橋接（docs/12 H0 查詢、H1 控制、H1b AIFA 冷氣與紅外線家電）。
// 本機核心經區網呼叫中控 REST v1，權杖只留在這裡，不進瀏覽器、不進 OpenAI 的工作階段。
// 讀值照中控回報：缺值是 null，不補 0；快照、過期資料要標出來，不當成即時值。
// 控制照中控的結果回報：只有 confirmed 是成功；unconfirmed、沒有回覆都不說成成功。AIFA 冷氣與紅外線家電沒有回讀，永遠不是 confirmed。
// 三條控制路徑都在 server/home/：control → planFor → sendCommands／sendAifa／sendIr → commandsReply／aifaReply／irReply。
// 這個檔案只重新匯出（docs/23 S9，2026-11-10）：對外的名稱與拆檔前相同，資料夾內部互用的不從這裡匯出。

export { AC_OFF_TIMER_NOTE, AC_OFF_TIMER_NOTE_UNSURE, aifaReply, buildClimate, CLIMATE_DEFAULTS } from "./home/aifa.ts";
export { HomeBridge } from "./home/bridge.ts";
export { isTvName, parseCommand, planFor, resolveTarget, TV_MOVED, type Plan, type Resolution } from "./home/commands.ts";
export { IR_SYNONYMS, irReply, keyNorm, matchKey } from "./home/infrared.ts";
export { parseAifa, parseHome } from "./home/parse.ts";
export { metricKey, report } from "./home/readings.ts";
export {
  COOLDOWN_WAIT_MS,
  H1B_TIMEOUTS_MS,
  HomeBridgeError,
  MIN_SEND_WINDOW_MS,
  UTTERANCE_MS,
  type AifaClimateCaps,
  type AifaListState,
  type ClimateChange,
  type ClimatePacket,
  type ControllerReport,
  type ControlRequest,
  type DeviceRoute,
  type HomeBridgeErrorCode,
  type HomeBridgeOptions,
  type HubDataStatus,
  type HubDevice,
  type HubMetric,
  type HubSnapshot,
  type IrKey,
  type UnsupportedWhy,
  type VoicePolicy,
} from "./home/types.ts";
