// 只開放兩個動作給網頁：用系統瀏覽器開連結（登入頁），以及回報狀態給選單列圖示。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nousDesktop", {
  openExternal: (url) => ipcRenderer.send("nous:open-external", String(url)),
  reportState: (state) =>
    ipcRenderer.send("nous:state", {
      voice: String(state?.voice ?? "off"),
      activeTasks: Number(state?.activeTasks) || 0,
      settings: String(state?.settings ?? "").slice(0, 64),
    }),
});
