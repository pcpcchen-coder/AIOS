// 常駐喚醒聆聽的進入點（WK-01a）。只有核心給了 settings.wake（NOUS_WAKE=on）時，src/main.ts 才以動態 import 載入這個檔案；
// 旗標關閉時 src/audio/ 的程式完全不會載入，getMicrophone 維持原本的函式（tests/audio-privacy.test.ts 檢查）。

import { browserCapture } from "./capture.ts";
import { WakeController, type WakeHost } from "./controller.ts";
import { browserEarcon } from "./earcon.ts";

export { WAKE_COMMANDS, WakeController, type PowerEvent, type WakeHost, type WakeTriggerHandler } from "./controller.ts";
export { NoVoiceWatchdog, NO_VOICE_TIMEOUT_MS } from "./no-voice.ts";

export function createWakeController(host: WakeHost): WakeController {
  return new WakeController(host, {
    mediaDevices: typeof navigator.mediaDevices?.getUserMedia === "function" ? navigator.mediaDevices : null,
    capture: browserCapture(),
    earcon: browserEarcon(),
  });
}
