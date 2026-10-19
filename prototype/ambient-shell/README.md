# Nous 原型：漂浮電子腦 × 交辦任務 × 按需看進度

> 獨立資料夾的可執行原型。螢幕中央只有一顆電子腦；把事情交辦給它，之後問「進度如何」，它才把進度攤開給你看。
> **這不是 07 的 PR-01／G0 驗收交付**，也不改變 repo README 的 gate 狀態（見文末〈與正式規格的關係〉）。

![待機：只有電子腦](./docs/screenshots/01-ambient.jpg)

| 交辦後（前景） | 問「進度如何」 | 完成後的成果 |
|---|---|---|
| ![](./docs/screenshots/02-working.jpg) | ![](./docs/screenshots/03-progress.jpg) | ![](./docs/screenshots/04-artifact.jpg) |

截圖為模擬模式（畫面左上角與每張卡片都標示「模擬」）。

## 啟動

需要 Node.js 22.12 以上。第一次安裝、Windows 指令與常見問題見 **[INSTALL.md](./INSTALL.md)**。

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
| 說／打「開啟語音模式」，或按輸入框的聲波按鈕 | **語音對話模式**（類似 ChatGPT 語音模式）：直接和 AI 對談，回覆邊產生邊逐句念出；**它說話時你可以直接插話**，它會停下來聽你說。需要較長時間的工作（寫報告、整理資料）由 AI 自行交辦成背景任務，進度照常顯示。「進度如何」「停止任務」「收起」等指令仍由本機直接處理。說「關閉語音模式」、點右上角指示，或 90 秒沒說話就關閉 |

只有「短句且符合固定語彙」才被當成控制指令（`src/intent.ts`），例如「幫我寫一份專案進度報告」仍是交辦任務，不會被誤判成查進度。

## 進度怎麼算（不灌水）

- 每個任務先由 Claude **規劃步驟**；規劃完成前只顯示「規劃中：步驟數尚未確定」，不畫百分比。
- 規劃後：`百分比 = round(完成步數 / 總步數 × 100)`，總步數在 Claude 模式為「規劃步驟 1 + 計畫步驟 n + 彙整成果 1」。計算在 `shared/progress.ts`，案例在 `tests/progress.test.ts`。
- 「已產生 N 字」是串流實際收到的字元數；耗時是真實時鐘差。
- 電子腦的光脈衝只在真實事件發生時出現（交辦、步驟開始／完成、收到串流輸出、成功、失敗）；沒有事件就沒有脈衝。

## AI 引擎（可切換）

說或打「設定」叫出 AI 引擎設定；也可以直接說「改用 ChatGPT」「改用 Claude」「改用模擬模式」。選擇會保存，新交辦的任務用新引擎，已在跑的任務不受影響。

![設定：AI 引擎](./docs/screenshots/06-settings.jpg)

| 引擎 | 怎麼啟用 | 行為 |
|---|---|---|
| Claude | `.env` 設 `ANTHROPIC_API_KEY` | 依 API 用量計費。規劃 → 逐步串流執行 → 彙整 |
| ChatGPT | 設定畫面按 **Continue with ChatGPT**，在瀏覽器登入並同意 | 使用你的 **ChatGPT 方案額度**（不需要 API key）。走 OpenAI 官方的 [Sign in with ChatGPT](https://developers.openai.com/siwc) 開源／本機 app 流程，推論呼叫 `POST /v1/responses`（`store:false`、`stream:true`）。輸入列下方會顯示「使用 ChatGPT 方案 · 管理用量」 |
| 模擬 | 預設（兩者都沒設定時）或手動選擇 | 用計時器走固定步驟，**未呼叫任何模型**；全程標示「模擬」 |

Claude 與 ChatGPT 用同一套提示詞（`server/prompts.ts`）。兩者都沒有工具（不上網、不讀寫檔、不寄信），需要這些能力的部分會在成果中列為「能力缺口」。

**ChatGPT 登入細節**（依官方文件實作）：第一次以 `client_id=dynamic_agent_client` 動態註冊，之後沿用核發的 `client_id`；每台電腦一個 `ext_agent_host_id`（`urn:uuid:…`）；PKCE＋state＋nonce，回呼在 `http://127.0.0.1:1455/auth/callback`；驗證 ID token 簽章（JWKS）、issuer、audience、nonce，並確認取得 `chatgpt.tokens.use.direct` 才允許推論。access token 一小時到期，接近到期自動 refresh；登出時撤銷 refresh token。憑證存在 `~/.config/nous/chatgpt-credentials.json`（權限 0600），不放在 repo、不進瀏覽器儲存。用量上限、登入失效等錯誤會顯示「管理用量」或「開啟設定」。

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
│   ├── voice.ts            # 按下說話與連續語音對話模式（Web Speech API + speechSynthesis，需同意）
│   ├── speech-text.ts      # 語音模式要念的短句（由任務狀態計算）
│   ├── echo.ts             # 插話／回音判斷、逐句切分
│   └── main.ts
├── server/                 # 本機核心（Node http + SSE）
│   ├── runner.ts           # 任務排程、取消、重試、步驟回報
│   ├── providers.ts        # 可切換的 AI 引擎（Claude／ChatGPT／模擬）
│   ├── prompts.ts          # 兩個引擎共用的提示詞與計畫格式
│   ├── chat.ts             # 語音對話：系統提示、交辦標記解析
│   ├── claude-executor.ts  # Claude 規劃與串流執行
│   ├── chatgpt-auth.ts     # Sign in with ChatGPT（OAuth、ID token 驗證、refresh、登出）
│   ├── chatgpt-executor.ts # ChatGPT 方案用量：/v1/responses 串流
│   ├── mock-executor.ts
│   ├── store.ts            # JSON 持久化
│   └── app.ts / http-guard.ts / config.ts / index.ts
├── shared/                 # 前後端共用型別與進度計算
└── tests/                  # vitest
```

## 測試

```bash
npm test          # vitest：114 項
npm run typecheck
```

涵蓋：進度計算、指令判斷、Shell 狀態轉移（收起不取消、背景完成不搶前景）、呈現政策、任務成功／失敗／取消／排隊／重試、重啟後的中斷標記、HTTP 驗證與 SSE、Claude 請求形狀（以假 fetch 驗證，不代表真實模型能力）。

## 已知限制

- 未用真實 API key 或真實 ChatGPT 帳號跑過完整成功流程（開發環境沒有帳號）。已驗證：Claude 與 OpenAI 真實 API 的 401 失敗路徑；ChatGPT 登入流程以本機簽發的 ID token 和假端點做自動化測試；`auth.openai.com` 授權頁在開發環境被 Cloudflare 機器人驗證擋住，未能實際走完登入。
- ChatGPT 方案用量目前是 OpenAI 的預覽功能，Plus 方案的五小時用量上限與其他 app 共用。
- 語音用瀏覽器內建的 Web Speech API（雲端辨識）與 speechSynthesis（電腦語音），沒有本地喚醒詞；路線是「語音轉文字 → AI 對話 → 文字轉語音」三段串接，延遲比 ChatGPT 的語音對語音模型長。
- 插話靠「比對聽到的字和正在念的字」分辨回音與使用者：大多數字都在念的內容裡就當回音，出現新的字或「停／等一下」就打斷。用喇叭時同音異字的回音可能誤觸插話，戴耳機最準。念完 2.5 秒內與剛念內容相同的長句會被忽略。語音模式只用模擬的語音 API（含模擬喇叭回音）做過自動化測試，麥克風與喇叭未在實機驗證。
- 沒有 webcam 視線、沒有 Tauri 桌面殼（瀏覽器頁面）、沒有記憶與知識層。
- Agent 沒有工具：不能上網、讀寫檔案或對外動作；外部副作用與 Action Gate 尚未實作。
- 單一使用者、單一螢幕；資料以明文 JSON 存在本機。

## 與正式規格的關係

本原型依使用者要求建立於獨立資料夾，借用 06／07 的 Shell 狀態、`visibility_reason` 與 Task 狀態概念，但**沒有**照 07 §2 的 monorepo 結構，也沒有 `packages/shared/schemas` 的版本化 JSON Schema（型別標為 `proto-0.1`）。正式實作仍從 08 的 PR-00 開始；本原型可作為 PR-01／PR-02 的視覺與互動參考。
