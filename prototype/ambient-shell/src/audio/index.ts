// 常駐喚醒聆聽的進入點（WK-01a）。只有核心給了 settings.wake（NOUS_WAKE=on）時，src/main.ts 才以動態 import 載入這個檔案；
// 旗標關閉時 src/audio/ 的程式完全不會載入，getMicrophone 維持原本的函式（tests/audio-privacy.test.ts 檢查）。
// 麥克風與提示音的輸出裝置由 main.ts 注入（src/audio-devices.ts），這個資料夾不直接開麥克風。

import { browserCapture } from "./capture.ts";
import { WakeController, type WakeHost } from "./controller.ts";
import { browserEarcon, type EarconOutput } from "./earcon.ts";
import type { MicOpener } from "./front-end.ts";

export { WAKE_COMMANDS, WakeController, type PowerEvent, type WakeHost, type WakeTriggerHandler } from "./controller.ts";
export { NoVoiceWatchdog, NO_VOICE_TIMEOUT_MS } from "./no-voice.ts";
export type { WakeCallWatch } from "./wake-call.ts";

/**
 * keywordPort：SP-02a 把喚醒詞片段直接送到 speaker worker 的 port（見 capture.ts）；沒有時不複製。
 * devices：麥克風與聲音輸出（main.ts 從 src/audio-devices.ts 注入；這個資料夾不 import 它）。mic 為 null＝不支援的環境。
 */
export function createWakeController(
  host: WakeHost,
  keywordPort: (() => MessagePort | null) | null,
  devices: { mic: MicOpener | null; output: EarconOutput },
): WakeController {
  return new WakeController(host, {
    mic: devices.mic,
    capture: browserCapture(keywordPort),
    earcon: browserEarcon(devices.output),
  });
}
