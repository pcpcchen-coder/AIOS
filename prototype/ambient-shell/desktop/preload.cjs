// 只開放三個動作給網頁：用系統瀏覽器開連結（登入頁）、回報狀態給選單列圖示，以及家人辨識的請求。
// identity 只是傳輸：發送者、op 白名單與形狀在主程序檢查（desktop/identity-ipc.mjs），資料與比對在核心（ADR-0001 §2.1）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nousDesktop", {
  openExternal: (url) => ipcRenderer.send("nous:open-external", String(url)),
  reportState: (state) =>
    ipcRenderer.send("nous:state", {
      voice: String(state?.voice ?? "off"),
      activeTasks: Number(state?.activeTasks) || 0,
      settings: String(state?.settings ?? "").slice(0, 64),
    }),
  identity: (request) => ipcRenderer.invoke("nous:identity", request),
});
