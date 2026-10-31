// 只開放六個動作給網頁（另有幾個不含內容的通知）：用系統瀏覽器開連結（登入頁）、回報狀態給選單列圖示、家人辨識、記憶、加密任務的請求，
// 與成果紀錄刪除的原生確認。
// identity 與 memory 只是傳輸：發送者、op 白名單與形狀在主程序檢查（desktop/identity-ipc.mjs、desktop/memory-ipc.mjs），
// 資料、比對與記憶規則在核心（ADR-0001 §2.1、docs/16 §9）。
const { contextBridge, ipcRenderer } = require("electron");

const validLocale = (value) => value === "zh-TW" || value === "en";
const argumentLocale = process.argv.find((argument) => argument.startsWith("--nous-locale="))?.slice("--nous-locale=".length);
const storedLocale = ipcRenderer.sendSync("nous:get-locale");

contextBridge.exposeInMainWorld("nousDesktop", {
  initialLocale: validLocale(storedLocale) ? storedLocale : validLocale(argumentLocale) ? argumentLocale : "zh-TW",
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
    }),
  identity: (request) => ipcRenderer.invoke("nous:identity", request),
  memory: (request) => ipcRenderer.invoke("nous:memory", request),
  // MEM-4a：加密保存的任務（真實標題、成果、App 內搜尋、重做、刪除明文備份）只經這個通道給主視窗。
  tasks: (request) => ipcRenderer.invoke("nous:tasks", request),
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
