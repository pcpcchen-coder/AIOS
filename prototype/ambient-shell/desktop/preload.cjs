// 只開放七個動作給網頁（另有幾個不含內容的通知；WK-01a 加上只有列舉值的電源事件，服務模式加上只有列舉值的進入／離開）：用系統瀏覽器開連結（登入頁）、回報狀態給選單列圖示、家人辨識、記憶、加密任務的請求，
// 與成果紀錄刪除的原生確認、打開鏡頭前的原生說明。
// identity 與 memory 只是傳輸：發送者、op 白名單與形狀在主程序檢查（desktop/identity-ipc.mjs、desktop/memory-ipc.mjs），
// 資料、比對與記憶規則在核心（ADR-0001 §2.1、docs/16 §9）。
const { contextBridge, ipcRenderer } = require("electron");

const validLocale = (value) => value === "zh-TW" || value === "en";
// WK-01a 常駐喚醒聆聽：回報與電源事件只傳列舉值（同 shared/wake.ts 的 WAKE_STATE_REASONS；tests/audio-privacy.test.ts 核對兩邊一致）。
// 不經這裡傳任何音訊或樣本；喚醒回報不帶裝置（「聲音」選單的裝置清單另由 audioReport 整理）。
const WAKE_STATE_REASONS = {
  off: [null, "pref_off"],
  armed: ["starting", "auto_resume"],
  listening_local: [null],
  paused: ["user_pause", "sleep", "lock", "rate_limited", "service"],
  in_call: ["realtime"],
  released: ["web_speech"],
  error: ["permission_denied", "device_missing", "device_ended", "runtime_missing", "runtime_load_failed", "audio_failed", "unsupported"],
};
const POWER_EVENTS = ["suspend", "resume", "lock", "unlock"];
const SERVICE_EVENTS = ["enter", "exit"];
const wakeReport = (wake) => {
  const state = typeof wake?.state === "string" && Object.hasOwn(WAKE_STATE_REASONS, wake.state) ? wake.state : null;
  const reason = wake?.reason ?? null;
  return state && WAKE_STATE_REASONS[state].includes(reason) ? { wake: { state, reason } } : {};
};
// 「聲音」選單（George 2026-11-01）：只傳裝置名稱、瀏覽器的不透明裝置識別碼（可見 ASCII，最多 256 字）與白名單裡的狀態句，
// 每種最多 24 個、名稱最多 128 字（同 shared/audio-devices.ts 的 sanitizeAudioMenuReport；tests/audio-privacy.test.ts 核對）。不傳任何聲音。
const AUDIO_STATUS_TEXTS = ["使用中：{0}", "找不到「{0}」，暫用系統預設", "目前沒有開著的麥克風", "播放時使用：{0}", "尚未回報"];
const AUDIO_ID = /^[\x21-\x7e]{1,256}$/;
const audioLabel = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128) : "");
const audioEntry = (value) => (value && typeof value === "object" && typeof value.id === "string" && AUDIO_ID.test(value.id) ? { id: value.id, label: audioLabel(value.label) } : null);
const audioInUse = (value) => {
  if (!value || typeof value !== "object") return null;
  if (value.id !== null && (typeof value.id !== "string" || !AUDIO_ID.test(value.id))) return null;
  return { id: value.id, label: audioLabel(value.label) };
};
const audioLine = (value) => {
  if (!value || typeof value !== "object" || !AUDIO_STATUS_TEXTS.includes(value.text)) return null;
  return { text: value.text, values: Array.isArray(value.values) ? value.values.slice(0, 1).map(audioLabel) : [] };
};
const audioReport = (audio) => {
  if (!audio || typeof audio !== "object" || Array.isArray(audio)) return {};
  const list = (items) => (Array.isArray(items) ? items.map(audioEntry).filter((d) => d !== null).slice(0, 24) : []);
  const name = (x) => (typeof x === "string" && x ? audioLabel(x) : null);
  const input = audioLine(audio.input_status);
  const output = audioLine(audio.output_status);
  if (!input || !output) return {};
  return {
    audio: {
      inputs: list(audio.inputs),
      outputs: list(audio.outputs),
      default_input: name(audio.default_input),
      default_output: name(audio.default_output),
      input_in_use: audioInUse(audio.input_in_use),
      output_in_use: audioInUse(audio.output_in_use),
      input_fallback: audio.input_fallback === true,
      output_fallback: audio.output_fallback === true,
      labels: audio.labels === true,
      input_status: input,
      output_status: output,
    },
  };
};
const argumentLocale = process.argv.find((argument) => argument.startsWith("--nous-locale="))?.slice("--nous-locale=".length);
const storedLocale = ipcRenderer.sendSync("nous:get-locale");
const serviceAtLoad = ipcRenderer.sendSync("nous:get-service") === true;

contextBridge.exposeInMainWorld("nousDesktop", {
  initialLocale: validLocale(storedLocale) ? storedLocale : validLocale(argumentLocale) ? argumentLocale : "zh-TW",
  // 服務模式：載入時是否已在服務模式（之後的改變經 onService）。
  initialService: serviceAtLoad,
  onLocaleChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, locale) => { if (validLocale(locale)) callback(locale); };
    ipcRenderer.on("nous:locale-changed", listener);
    return () => ipcRenderer.removeListener("nous:locale-changed", listener);
  },
  openExternal: (url) => ipcRenderer.send("nous:open-external", String(url)),
  reportState: (state) =>
    ipcRenderer.send("nous:state", {
      voice: String(state?.voice ?? "off"),
      activeTasks: Number(state?.activeTasks) || 0,
      settings: String(state?.settings ?? "").slice(0, 64),
      ...(validLocale(state?.locale) ? { locale: state.locale } : {}),
      ...wakeReport(state?.wake),
      ...audioReport(state?.audio),
    }),
  // WK-01a：系統睡眠、醒來、鎖定、解鎖（只有列舉值）。
  onPower: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, kind) => { if (POWER_EVENTS.includes(kind)) callback(kind); };
    ipcRenderer.on("nous:power", listener);
    return () => ipcRenderer.removeListener("nous:power", listener);
  },
  // 服務模式（Mac 交給 Pi 使用）的進入與離開（只有列舉值）：頁面停止或恢復麥克風、喚醒與鏡頭。
  onService: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, kind) => { if (SERVICE_EVENTS.includes(kind)) callback(kind); };
    ipcRenderer.on("nous:service", listener);
    return () => ipcRenderer.removeListener("nous:service", listener);
  },
  identity: (request) => ipcRenderer.invoke("nous:identity", request),
  memory: (request) => ipcRenderer.invoke("nous:memory", request),
  // MEM-4a：加密保存的任務（真實標題、成果、App 內搜尋、重做、刪除明文備份）只經這個通道給主視窗。
  tasks: (request) => ipcRenderer.invoke("nous:tasks", request),
  // 打開鏡頭：主程序先顯示原生說明，使用者按「開啟」才保存。不帶任何參數（頁面不能傳東西過去），只回 { ok, reason?, message? }。
  cameraEnable: () => ipcRenderer.invoke("nous:camera-enable"),
  // HIST-1 Mac 驗收 F4：成果紀錄刪除的原生確認（主程序用 dialog.showMessageBox，按鈕依目前語言）。只回 { confirmed }。
  confirmDelete: (request) => ipcRenderer.invoke("nous:confirm-delete", { kind: "task", title: String(request?.title ?? "") }),
  // MEM-4c 審查 M1：核心丟棄已結束受保護任務的解密內容（鎖定、睡眠、閒置、關閉記憶、結束）。只傳白名單裡的原因，不含內容；
  // 頁面收到後清掉自己的快取與成果紀錄畫面。
  onTasksPlaintextDropped: (callback) => {
    if (typeof callback !== "function") return () => {};
    const reasons = ["os_lock", "suspend", "idle", "memory_off", "memory_closed", "quit"];
    const listener = (_event, payload) => { if (reasons.includes(payload?.reason)) callback(payload.reason); };
    ipcRenderer.on("tasks:plaintext-dropped", listener);
    return () => ipcRenderer.removeListener("tasks:plaintext-dropped", listener);
  },
  // 本次人物世代改變的通知（不含內容）；頁面收到後用 status 讀新狀態（不開記憶檔）。
  onMemoryChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("nous:memory-changed", listener);
    return () => ipcRenderer.removeListener("nous:memory-changed", listener);
  },
});
