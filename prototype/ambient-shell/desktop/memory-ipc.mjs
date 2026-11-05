// 記憶層的 IPC 過濾（純函式，不載入 Electron；tests/memory-ipc.test.ts 直接測）。
// 架構（docs/16 §9）：核心（server/memory/service.ts）持有資料與規則，IPC 只做傳輸。這裡只做三件事：
//   1. 發送者必須是主視窗的主框架、頁面來自本機核心（desktop/trusted-sender.mjs，與家人辨識共用；main.mjs 檢查）；
//   2. op 白名單與每個 op 允許的欄位與型別：和終端機的 HTTP 共用 shared/memory-validate.mjs（打包時 esbuild 併進來）；
//   3. 選單列「記憶…」的點擊時間窗：只有點擊後 10 秒內，list 的 manage 才算使用者打開記憶管理（一次有效；main.mjs）。
// 刪除人物記憶、全部忘記與連結家人辨識的原生確認由核心呼叫主程序的 confirm（頁面無法偽造）。

export { MEMORY_OPS, validateMemoryRequest } from "../shared/memory-validate.mjs";
