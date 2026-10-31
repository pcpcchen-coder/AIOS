// 可信發送者檢查（家人辨識與記憶共用；純函式，不載入 Electron）。
// event 為 ipcMain.handle 的 IpcMainInvokeEvent；win 為主視窗；coreUrl 為本機核心網址（http://localhost:埠）。
// 只有主視窗的主框架、而且頁面來自本機核心時回 true（不是其他視窗、iframe 或導覽後的外部頁面）。
export function checkTrustedSender(event, win, coreUrl) {
  if (!event || !win || typeof coreUrl !== "string" || !coreUrl) return false;
  if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
  const sender = event.sender;
  if (!sender || sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== sender.mainFrame) return false;
  const url = typeof frame.url === "string" ? frame.url : "";
  // 以 core.url 加上 "/" 比對，避免 http://localhost:8787 被 http://localhost:87870 冒充。
  return url === coreUrl || url.startsWith(`${coreUrl}/`);
}

// 網址是否和本機核心同一個 origin（協定、主機、埠完全相同）。用 URL 解析後比較 origin，不用字首比對：
// 字首比對會讓 http://localhost:5173 也接受 http://localhost:51730。解析失敗一律 false。
export function sameOrigin(url, coreUrl) {
  if (typeof url !== "string" || typeof coreUrl !== "string" || !url || !coreUrl) return false;
  try {
    return new URL(url).origin === new URL(coreUrl).origin;
  } catch {
    return false;
  }
}
