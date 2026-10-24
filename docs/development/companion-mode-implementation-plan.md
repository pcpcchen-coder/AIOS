# 實作 Companion Mode（AIOS 原型開發交辦與驗收）

> 文件性質：**How-to／開發批次規劃，尚未執行** · 2026-10-24 · 依據：[Companion Mode 功能規格](../14_Companion_Mode_Spec_2026-10-24.md)。
>
> 工作前先讀 [現況](../Current_Implementation_Status.md)、[AGENTS.md](../../AGENTS.md)、[CLAUDE.md](../../CLAUDE.md)、[pstack 使用指南](./pstack.md)。目前現存原型為 `prototype/ambient-shell`；不要以舊 Python kernel、Tauri 或已存在的本地 ASR 為前提。

## 交付原則

拆成四個獨立 PR。每批都有可操作路徑、契約／錯誤測試、負例、證據與可回退機制。**不能因為設定畫面已做就宣稱會自然陪聊**；在聲源排除與本地 ASR 驗收前，`natural` 和 `active` 必須標示不可用。

現有工程流程遵守 pstack；實際 recorder start/step/finish 必須由執行代理在本地呼叫。此文件只提供交辦步驟，沒有聲稱 Recorder 已記錄本次文件任務。

## 批次 CM-P1：偏好、主開關與強制停止

**目標：** 使用者能明確啟用／關閉 Companion Mode，儲存四項設定；關閉後沒有背景收音、過期回覆與延後播報。

預計新增／修改位置（依實際原型決定最終檔名）：

| 路徑 | 預期變動 |
|---|---|
| `shared/companion-prefs.ts` | `CompanionPrefs`、預設值、enum、嚴格 parse/validation |
| `server/companion-settings.ts` | `PrefsFile` 寫入 `companion.json`；讀取錯誤時主開關 fail-closed |
| `server/nous.ts`、`server/app.ts` | 接入設定儲存，暴露 `GET /api/settings` 與 `POST /api/settings/companion`，廣播 `settings.updated` |
| `src/api.ts`、`src/main.ts` | 讀／改偏好、顯示真實 runtime、改動失敗時還原 UI |
| `desktop/settings-menu.mjs` | macOS 選單列主 checkbox、三組設定、可用性／狀態、開始／停止 |
| `src/views.ts` | 瀏覽器版按需設定；不新增常駐欄位 |
| `tests/companion-settings.test.ts` | 邊界值、持久化、損毀設定、讀寫失敗與 settings.updated |

**執行順序：**

1. 先在 `shared` 定義四項設定與 parsing，支援未知鍵拒絕、單項 patch 與 enum 驗證。
2. 接入 `PrefsFile`，讀不到 `enabled` 或檔案版本不符時預設 false；單一寫入者、保存成功才更新 UI。
3. 建立最小的純函式狀態機 `disabled / armed / requesting_permission / listening / evaluating / responding / paused / error`，分開偏好與 capture 事件。
4. 在 macOS 選單及瀏覽器按需設定加 UI；顯示**是否真的收音**，不以 checkbox 假造 listening。
5. 先實作 idempotent 的 `start / stop / disable` 與硬停止 callback。現階段 start 可清楚回覆「尚無本地感知管線」，不可虛構聲音收聽已開始。
6. 覆蓋切換中關閉、保存失敗、冷啟動 `armed`、重複操作及舊 session epoch 失效的測試。

**P1 驗收：** UI 四項設定可保存／回讀；開關為真正可用的安全總開關；所有設定失敗都可見；不存在擅自開始收音。這批**不提供自然陪聊**。

## 批次 CM-P2：本機收音、聲源判斷與語音候選

**目標：** 不上傳背景音訊；在 TV 聲音存在時，只把可歸屬於現場觀眾的候選片段交給策略層。

1. 建立 capture adapter（現有 `src/voice.ts`、`src/realtime.ts` 作為介面參考，**不可兩個同時持有麥克風**）。
2. 接入本機 VAD 與本地 ASR（候選實作需測 macOS M6 延遲／記憶體；不預設系統聽寫是離線）。
3. 提供 `source=human / tv / self_tts / unknown`，以及每筆候選的信心、裝置狀態和 epoch；unknown 保守不通過。
4. 若 XVF3800 的 USB mic、DOA/AEC 數據可取得，以 adapter 封裝。不能取得 TV 音訊參考時，明確降低聲源可信度，不誤稱 AEC 已驗證。
5. 僅保留去識別化的 decision metrics；未被准許的音訊和逐字稿在本地丟棄。

**P2 驗收：** 在實際 LG G3 播放聲音時以固定場景集合測試 TV/人聲負例；沒有 TV 自動觸發；一般評論偵測率及假陽性數列出；音訊未上傳或保存的可驗證證據。品質不達標則禁用 `natural`。

## 批次 CM-P3：策略層、現有 LLM 路由與語音回答

**目標：** 符合條件才接話，短答、不劇透、不亂認畫面。

1. 建立確定性 `engagement-policy`：enabled、session owner、來源、activation、cooldown、是否有播報衝突。
2. 将核准的文字交給既有 `streamChat` 或受控推論路由；不能把常開 WebRTC 原始音訊繞過本地 gate 送雲端。
3. 加入受限的 Companion system prompt 與 JSON 決策回覆；模型 `should_respond` 永遠不能越過本地關閉開關或啟用工具權限。
4. 使用既有 TTS／字幕能力；AI 自己播報時抑制聲源候選，避免「AI 聊 AI」。
5. 改動 epoch 後取消進行中的推論與 TTS，防止因延遲產生的幽靈回答。
6. 語音／模型供應商權限與費用由現有 UI 說明；無登入或離線時明確報錯。

**P3 驗收：** `wake` 與 `natural` 有不同可測行為；`short/normal/long` 的回答長度符合政策；5、15、60 秒冷卻可測；停止後沒有新 TTS；角色／影像未知時不假裝觀看。

## 批次 CM-P4：LG G3 客廳整合與長時間實測

**目標：** 在真電視播放與 Mac mini 隱藏視窗的情境下可靠使用。

1. 以 LG G3 日常片源測試低、中、高音量及安靜／吵雜客廳；不得假設 LG G3 第三方 App 可取得內建 mic。
2. 驗證 XVF3800 遠場收音、電視誤觸發、AI TTS 再觸發、冷卻和使用者打斷。
3. 驗證 Electron 視窗隱藏、macOS 睡眠／喚醒、拔除 USB mic、網路中斷與權限被撤銷。
4. 記錄 p50/p95 延遲、答話比率、電視假陽性、原始音訊是否對外傳送；僅公開**去識別化**測試結果。
5. 若 TV 光纖參考音訊可用，再另開 AEC 子批次，不要讓光纖裝置成為 MVP 硬依賴。

**P4 驗收：** 達成規格 CM-01～CM-12 並提供實機證據；誤觸發低於提議門檻才可正式宣布自然陪聊可用。各供應商與輸出裝置分別記錄測試結果，禁止將 mock 通過視為硬體通過。

## 自動化驗證命令

在 Repo 根目錄執行：

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

新增設定、狀態機、API、UI 與 session race 測試，測試時覆蓋「開關關閉但仍有 late callback」、「permission denied」、「擁有權衝突」、「存檔失敗」、「無效值」。如本地環境未安裝 Node 22.12+ 或 `npm ci`，應明確標示未執行原因。Web UI 及真正電視／麥克風結果要用人工實測，不能只靠上述腳本。

## 開發 Agent 可直接使用的任務 Prompt

```text
請依 AIOS repo 的 AGENTS.md、CLAUDE.md、pstack 規範工作。
先讀 docs/Current_Implementation_Status.md、
docs/14_Companion_Mode_Spec_2026-10-24.md 與本開發批次。

本次只執行「CM-P1：偏好、主開關與強制停止」：
- 在 prototype/ambient-shell 現有 Node/TypeScript/Electron 上增量實作。
- enabled 預設 false，損毀設定 fail-closed。
- activation = wake|natural|active，default natural；
  verbosity = short|normal|long，default short；
  cooldown_seconds = 5..60 step 5，default 15。
- macOS 選單列與瀏覽器按需設定都可切換。
- 開關關閉必須立即停止 Companion 擁有的 session、取消晚到播報；
  不得取消既有背景任務或獨立語音會話。
- 有偏好、正在聆聽、已暫停等狀態須分開。
- 本批沒有真正音訊來源判別和本地 ASR，請明示不可用，
  不要用 mock 偽裝 Companion 可以自然陪聊。
- 補自動化測試和清楚的錯誤／拒絕權限路徑。
- 不新增常駐 Dashboard、啟動器或新的應用殼。
- 回報變更檔案、指令、實際測試結果、未完成、下一個 gate。
```

## 狀態回報格式

每個批次完成後請填寫並上傳 `docs/validation/` 紀錄，至少包含：commit SHA、程式變更範圍、測試指令及實際輸出、是否使用 mock、真實 microphone／TV 硬體型號及條件、CM-xx 驗收表、失敗與未做事項、是否影響現有 Realtime/ChatGPT 方案路由。只有具備對應證據才更新 README 的完成狀態。
