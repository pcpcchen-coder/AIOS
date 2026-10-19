# Nous 原型：漂浮電子腦 × 交辦任務 × 按需看進度

> 獨立資料夾的可執行原型。螢幕中央只有一顆電子腦；把事情交辦給它，之後問「進度如何」，它才把進度攤開給你看。
> **這不是 07 的 PR-01／G0 驗收交付**，也不改變 repo README 的 gate 狀態（見文末〈與正式規格的關係〉）。

![待機：只有電子腦](./docs/screenshots/01-ambient.jpg)

| 交辦後（前景） | 問「進度如何」 | 完成後的成果 |
|---|---|---|
| ![](./docs/screenshots/02-working.jpg) | ![](./docs/screenshots/03-progress.jpg) | ![](./docs/screenshots/04-artifact.jpg) |

截圖為模擬模式（畫面左上角與每張卡片都標示「模擬」）。

## 啟動

需要 Node.js 22.12 以上。

```bash
cd prototype/ambient-shell
npm install
cp .env.example .env      # 填入 ANTHROPIC_API_KEY；不填就是「模擬模式」
npm start                 # 建置前端並啟動本機核心
```

開啟 <http://localhost:8787>。伺服器只綁 `127.0.0.1`。

開發時可分兩個終端機：`npm run dev:server`（核心，8787）與 `npm run dev:web`（Vite，5173，`/api` 轉給核心）。

## 怎麼用

| 你做的事 | 它的反應 |
|---|---|
| 點電子腦、按空白鍵，或直接打字 | 浮出一行輸入框（聆聽光環亮起） |
| 輸入一件事，按 Enter | 交辦成功；電子腦下方顯示「正在處理…步驟 2 / 4」，外圈是真實進度環 |
| 「收起」或 Esc | 回到只有電子腦的畫面；**任務繼續在背景跑**，完成時也不會自己跳出來 |
| 「進度如何」「做到哪了」 | 叫出所有任務的進度：狀態、`完成步數 / 總步數 · 百分比`、每一步的狀態與耗時、串流中已產生的字數 |
| 「看結果」「剛才那份」 | 叫出最新完成的成果 |
| 「停止任務」 | 只有一個在跑就直接停止；多個時列出讓你選 |
| 麥克風按鈕（Chrome／Edge） | 按下說話。第一次會先說明：瀏覽器會把音訊送到其雲端辨識，同意後才啟用 |

只有「短句且符合固定語彙」才被當成控制指令（`src/intent.ts`），例如「幫我寫一份專案進度報告」仍是交辦任務，不會被誤判成查進度。

## 進度怎麼算（不灌水）

- 每個任務先由 Claude **規劃步驟**；規劃完成前只顯示「規劃中：步驟數尚未確定」，不畫百分比。
- 規劃後：`百分比 = round(完成步數 / 總步數 × 100)`，總步數在 Claude 模式為「規劃步驟 1 + 計畫步驟 n + 彙整成果 1」。計算在 `shared/progress.ts`，案例在 `tests/progress.test.ts`。
- 「已產生 N 字」是串流實際收到的字元數；耗時是真實時鐘差。
- 電子腦的光脈衝只在真實事件發生時出現（交辦、步驟開始／完成、收到串流輸出、成功、失敗）；沒有事件就沒有脈衝。

## 兩種執行模式

| 模式 | 條件 | 行為 |
|---|---|---|
| Claude | `.env` 有 `ANTHROPIC_API_KEY` | 規劃 → 逐步串流執行 → 彙整成 Markdown 成果。沒有任何工具（不上網、不讀寫檔、不寄信），需要這些能力的部分會在成果中列為「能力缺口」 |
| 模擬 | 沒有 API key，或 `NOUS_EXECUTOR=mock` | 用計時器走固定步驟，**未呼叫任何模型**；畫面、卡片與成果都明確標示「模擬」，成果直接寫明未實際完成 |

模型不寫死：有設定 `NOUS_MODEL` 就用它；否則在第一個任務時經 Models API 取最新的 `NOUS_MODEL_FAMILY`（預設 `opus`）系列。預設開啟伺服器端 refusal fallback（beta `server-side-fallback-2026-07-01`），所選模型不支援時設 `NOUS_FALLBACKS=off`。

任務與成果存在 `data/`（已排除於 git），重啟後可喚回；重啟時尚未完成的任務會標為「中斷」失敗，不假裝仍在執行。

## 與產品紅線的對照

| CLAUDE.md 紅線 | 本原型 |
|---|---|
| 無 App launcher、側欄、Dashboard、預設聊天主頁 | 待機只有電子腦；輸入框按需浮出，Esc 即收 |
| Surface 必須有可驗證的 `visibility_reason` | `src/presentation-policy.ts` 在渲染前檢查；`request_id` 必須是本次真實的使用者輸入 |
| 收起只關視圖，停止任務才取消 | reducer 的 `dismiss` 不產生取消；取消只由「停止任務」發出（有測試） |
| mock 必須標示 | 模擬模式全程標示，成果寫明未完成 |
| 失敗、timeout 回報真實狀態 | SDK 錯誤轉成可讀原因（401／429／連線／逾時／拒絕）；截圖 `05-error.jpg` 為真實 API 回應的 401 |
| 動畫只由真實事件驅動 | 光脈衝、進度環只來自任務事件；步驟數未知時不畫進度 |
| 生成 UI 不得取得 shell／檔案／網路 | 成果 Markdown 經 DOMPurify 消毒，禁用圖片／iframe／表單等；頁面 CSP `default-src 'self'` |

另外：API 只接受本機 Host 與同源 Origin，寫入必須是 JSON（擋跨站代為交辦與 DNS rebinding）。

## 結構

```
prototype/ambient-shell/
├── index.html
├── src/                    # 前端（Vite + TypeScript，無框架）
│   ├── brain.ts            # 電子腦：Canvas 2D 粒子／神經連線，30 FPS 上限，支援減少動態
│   ├── shell-state.ts      # Shell 狀態 reducer（ambient / working / presenting / recoverable_error + 聆聽疊層）
│   ├── presentation-policy.ts
│   ├── intent.ts           # 確定性指令判斷
│   ├── views.ts            # 進度、成果、失敗畫面
│   ├── voice.ts            # 按下說話（Web Speech API，需同意）
│   └── main.ts
├── server/                 # 本機核心（Node http + SSE）
│   ├── runner.ts           # 任務排程、取消、重試、步驟回報
│   ├── claude-executor.ts  # Claude 規劃與串流執行
│   ├── mock-executor.ts
│   ├── store.ts            # JSON 持久化
│   └── app.ts / http-guard.ts / config.ts / index.ts
├── shared/                 # 前後端共用型別與進度計算
└── tests/                  # vitest
```

## 測試

```bash
npm test          # vitest：65 項
npm run typecheck
```

涵蓋：進度計算、指令判斷、Shell 狀態轉移（收起不取消、背景完成不搶前景）、呈現政策、任務成功／失敗／取消／排隊／重試、重啟後的中斷標記、HTTP 驗證與 SSE、Claude 請求形狀（以假 fetch 驗證，不代表真實模型能力）。

## 已知限制

- 未用真實 API key 跑過完整成功流程（開發環境沒有 key）；只驗證了真實 API 的 401 失敗路徑。
- 語音只有「按下說話」，沒有本地喚醒詞、VAD、TTS；麥克風路徑未在實機驗證。
- 沒有 webcam 視線、沒有 Tauri 桌面殼（瀏覽器頁面）、沒有記憶與知識層。
- Agent 沒有工具：不能上網、讀寫檔案或對外動作；外部副作用與 Action Gate 尚未實作。
- 單一使用者、單一螢幕；資料以明文 JSON 存在本機。

## 與正式規格的關係

本原型依使用者要求建立於獨立資料夾，借用 06／07 的 Shell 狀態、`visibility_reason` 與 Task 狀態概念，但**沒有**照 07 §2 的 monorepo 結構，也沒有 `packages/shared/schemas` 的版本化 JSON Schema（型別標為 `proto-0.1`）。正式實作仍從 08 的 PR-00 開始；本原型可作為 PR-01／PR-02 的視覺與互動參考。
