<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-family-recognition-2026-11-05.md) | [English](pi-family-recognition-2026-11-05.en.md)

# Pi 終端的家人辨識（臉與聲音）與記憶選人畫面驗證

日期：2026-11-05。分支 `claude/pi-family-recognition`（基於 main `6072f6c`）。狀態：**程式與 Linux 雲端自動測試完成；Pi、立體鏡頭、真模型與已登記家人都未實測。**

## 需求與決定（George，2026-11-05）

家人辨識要能在 RPI 上用，鏡頭與聲音都要。George 的決定：

1. Pi 接和 Mac 同款的立體鏡頭。
2. 一律允許 Pi 使用，不加開關，也不做配對。
3. 「正在用 X 的記憶」與「不是我」的畫面這批一起做。

## 做法

| 部分 | 行為 |
|---|---|
| 計算位置 | 臉部（YuNet＋SFace）與聲音（CAM++）的特徵本來就在頁面算，模型由 Mac 核心以網址提供。Pi 頁面算好特徵後送到 Mac 核心比對；**只傳特徵數字，不傳影像或聲音**。比對與加密保存都在 Mac 核心，頁面拿不到分數 |
| 辨識通道 | `POST /api/terminal/identity`，內容 `{terminal, request}`。只接受 `ambient_status`、`ambient_probe`、`greeting`、`voice_probe`、`call_voice`；其他（開管理畫面、列名單、登記、刪除、校正、試認等）一律 403。驗證和 Mac IPC 用同一份程式（`shared/identity-validate.mjs`），錯誤訊息相同。核心以 `userInitiated: false` 處理 |
| 記憶通道 | `POST /api/terminal/memory`。只接受 `status`、`suspend`、`select`（不能帶管理用 token）、`card_view` 與 `card_answer`（只限臉部候選卡，回答只能是「不要」）。回應去掉卡片、對話與建議內容，不傳記憶文字。打字聊天帶記憶、記憶建議、管理都仍只在 Mac |
| 終端名稱 | 請求帶 kiosk 網址的 `terminal`（例如 `rpi4`），只用來把 Mac 與 Pi 的辨識狀態分開記，不是安全驗證。Mac 本機任何帶 `?terminal=` 的瀏覽器頁面理論上也能呼叫（George 選「一律允許」） |
| 分開記的狀態 | 核心每個頁面各自保存取樣證據、最近一次臉部比對、喚醒聲音、通話中聲音、多張臉時間與各自的速率限制；最多記 8 個頁面。問候的速率限制與「每次互動只問候一次」仍是全核心共用。Mac 開著家人辨識管理畫面時，所有頁面的辨識都暫停（沿用原規則） |
| 記憶選人 | 核心只有一個「本次人物」。新的 SSE 事件 `memory.presence_changed`（不含內容）通知所有頁面，Pi 收到後重讀狀態，顯示「正在用 X 的記憶」，可以說或點「不是我」，也可以選人 |
| Pi 頁面 | 看著說話時的臉部辨識、叫名字問候、喚醒時認聲音、通話中認聲音、記憶選人畫面都改經新通道。家人辨識畫面與記憶管理在 Pi 上顯示「請在 Mac 的 Nous App 進行」 |
| 鏡頭 | 沒有新的打開方式：Mac 選單打開鏡頭後，Pi 頁面自己開 Pi 的鏡頭（依 `NOUS_CAMERA_LABEL` 找同款鏡頭）。Pi 的 Chromium 第一次會詢問，George 要按一次「允許」；套件仍不用自動允許的旗標 |
| Pi 效能 | 終端頁面的鏡頭分析間隔 160 毫秒（Mac 80 毫秒），臉部取樣每秒 2 次（Mac 4 次），先顧對話流暢度 |
| 打包 | Mac App 執行的是 `.mjs`，所以驗證程式放在 `shared/*.mjs`，`desktop/identity-ipc.mjs`、`memory-ipc.mjs` 轉出；App 打包改用 esbuild 把這兩個檔案打包進去 |

新增的介面文字都有英文（`src/messages.en.json`、`server/messages.en.json`）。

## 自動測試（Linux 雲端）

| 檢查 | 結果 |
|---|---|
| `tests/terminal-identity.test.ts`（22 項） | 允許的請求以 `userInitiated: false` 與終端名稱送到核心；其他請求 403；不合法終端名稱 400；格式錯誤的 400 訊息和 IPC 相同；沒有家人辨識的核心回 404；兩個頁面的證據不會互相滿足或覆蓋；記憶通道只接受列出的操作、不回記憶內容；SSE 事件讓頁面重讀狀態；頁面選擇通道（App 用 IPC、Pi 用 HTTP、一般瀏覽器沒有）；終端頁面的鏡頭與取樣間隔 |
| 更新的測試 | `camera-privacy`（唯一的辨識網址與允許清單固定）、`family-view`、`memory-view`（終端頁面的中英文說明）、`sense-pipeline`（160 毫秒） |
| 全部 | `npm run typecheck` 通過；`npx vitest run` 141 個檔案、2592 項通過、5 項略過；`npm run build` 通過；`node scripts/verify-aios.mjs` PASS |

## 未驗證

- Pi 上實際認人、叫名字、喚醒時認聲音、通話中認聲音。
- Pi 的鏡頭名稱是否和 Mac 的 `NOUS_CAMERA_LABEL` 相符；Chromium 鏡頭權限詢問。
- Pi 4 跑 160 毫秒鏡頭分析與每秒 2 次臉部取樣時，對話是否仍流暢。
- 聲音特徵是用 Mac 麥克風登記的，Pi 麥克風認不認得出來。
- 打包後的 App（esbuild 打包的兩個檔案）。

## Pi 實測步驟（待 George 執行）

1. Mac 開服務模式，從 Mac 選單打開鏡頭與常駐喚醒聆聽。
2. Pi 的 kiosk 第一次會詢問鏡頭，按「允許」。
3. 在 Pi 前看著畫面說話 10 次：記錄叫對名字、叫錯、沒叫的次數，以及「正在用 X 的記憶」是否出現。
4. 不看畫面說「Hello Nous」10 次：記錄以聲音叫名字的次數（只憑聲音叫名字仍受原本的校準規則限制）。
5. 通話中換另一位家人說話：記錄是否提出聲音候選。
6. 說「不是我」：確認改回全家共用。
7. 通話 10 分鐘，記錄斷續與延遲，和沒開鏡頭時比較；同時記 `top` 與溫度。
8. 結果填入 [Pi 測試報告](../experiments/RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md)。
