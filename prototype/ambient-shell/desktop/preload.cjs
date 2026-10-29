// 只開放四個動作給網頁：用系統瀏覽器開連結（登入頁）、回報狀態給選單列圖示、家人辨識與記憶的請求。
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
  // 本次人物世代改變的通知（不含內容）；頁面收到後用 status 讀新狀態（不開記憶檔）。
  onMemoryChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("nous:memory-changed", listener);
    return () => ipcRenderer.removeListener("nous:memory-changed", listener);
  },
});
