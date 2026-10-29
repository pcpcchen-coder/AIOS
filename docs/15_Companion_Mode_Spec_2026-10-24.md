<!-- bilingual: source=zh-TW -->

> [繁體中文](15_Companion_Mode_Spec_2026-10-24.md) | [English](15_Companion_Mode_Spec_2026-10-24.en.md)

# Companion Mode（自然陪聊模式）功能規格

> 狀態：**設計提案／待實作** · 版本：0.1 · 日期：2026-10-24 · 適用：`prototype/ambient-shell`（Node HTTP/SSE + TypeScript/Vite + Electron）。本文件**不代表程式已實作或實機驗收通過**。
>
> 關聯：[現況](Current_Implementation_Status.md) · [06 互動規格](06_Ambient_Voice_Gaze_Experience.md) · [07 驗收規則](07_Ambient_Implementation_and_Acceptance.md) · [開發批次](development/companion-mode-implementation-plan.md)

## 1. 產品目標與邊界

Companion Mode 是 AIOS 內的**可選語音互動模式**。使用者看 LG G3 電視、YouTube、玩遊戲或做家事時，可自然發表意見；AIOS 判斷「是不是現場的人說話」「是否值得接話」，在合適時機簡短回應。使用者不需每句話都喊喚醒詞，但也不能讓電視台詞、廣告與 AI 自己播出的聲音形成自動對話迴圈。

- **應完成**：使用者自主開關、設定保存、現場語音候選判斷、低干擾接話、與既有語音模式互斥、清楚的收音／計費狀態、失效即停、實機可量測。
- **第一版不做**：LG 電視內建麥克風的第三方原始音訊存取、DRM 畫面擷取、電視畫面理解、正式聲紋身分認證、Always-on 雲端原始音訊串流、主動控制家電或購買。
- **設備**：LG G3 繼續獨立播放節目；Mac mini 的獨立麥克風（優先驗 XVF3800）收聽客廳，Mac／外接喇叭回答。電視畫面與音訊參考訊號是後續選配；第一版**不得假裝看到了電視畫面**。
- **程式基礎**：既有 `src/voice.ts`、`src/realtime.ts`、`src/live-voice.ts`、`src/main.ts`、`server/voice-settings.ts`、`server/realtime-settings.ts` 與 `server/prefs-file.ts`；實際整合與限制以主線程式為準。

本功能不同於現有「開始語音對話」。既有模式由使用者明確開始前景會話；Companion Mode 另加**本地語音感知與接話判定**，絕不能只改 LLM system prompt 就宣稱完成。

## 2. 使用者體驗

1. macOS App 選單列「鏡頭與語音設定」新增 **陪聊模式** 子項；最上方提供可立即切換的 **啟用陪聊模式** checkbox。瀏覽器版由既有按需開啟的設定畫面操作。不可新增常駐側欄／首頁 Dashboard。
2. 使用者將開關設為開啟，先取得明確收音同意與 OS 麥克風權限，接著以裝置真實事件顯示「正在聆聽」。使用者可隨時關閉。
3. 「現在播放劇情突然反轉，我不相信他」→ 辨識為現場評論 → 依接話方式和冷卻規則，用一兩句話回覆。若沒有節目上下文，回答不得捏造角色、場景或劇情。
4. 電視人物喊「快逃！」、廣告旁白、AI 自己的 TTS → 應判為非使用者或低信心，**不自動接話**；若品質不足，維持靜音並提示可以改用喚醒詞。
5. 使用者將開關設為關閉，立刻停止 Companion 擁有的收音、推論排隊、播放與新回覆；既有背景任務保留，其他由使用者手動啟動的語音會話不受誤殺。

### 2.1 模式與可操作設定

| Key | 型別／選項 | 預設 | 使用者意義 |
|---|---|---|---|
| `enabled` | boolean | `false` | **唯一主開關**；關閉時不得收音、辨識、主動接話，重開程式也不得偷偷啟動 |
| `activation` | `wake` / `natural` / `active` | `natural` | 喚醒才回／自然評論或提問時回／適量主動加入討論 |
| `verbosity` | `short` / `normal` / `long` | `short` | 簡短（一至兩句）／一般／詳細（明確問深入問題時可突破長度） |
| `cooldown_seconds` | integer，5–60，step=5 | `15` | 兩次**非緊急 AI 自動發話**間最短間隔；直接明確提問可經規則允許插隊 |

- UI 顯示繁體中文，API 及保存用上表英文列舉。`active` 不等於無限制插話：沒有可靠情境與現場發話證據時不主動評論；建議額外硬限制「每十分鐘最多一次非邀請式主動發言」，不可只靠模型自律。
- `activation=natural` 必須通過本地 VAD/ASR 與聲源防護才能開啟正式互動；基礎元件不具備時顯示不可用原因，不可偷偷把電視聲上傳至雲端或宣稱自然模式已可用。
- `activation=active` 需要更嚴格的情境資料與事件來源保護；第一個開發批次可以先標「實驗性／不可用」，不得無聲退化成另一模式。
- `cooldown_seconds` 應在**上一次回應播報完成**後起算；設定變更立即影響後續判斷，當前回覆仍受關閉開關中止。

### 2.2 「啟用」與「真正收音」是兩回事

必須分開持久化偏好與 runtime 狀態，以符合既有 CLAUDE.md「狀態以裝置事件為準」原則：

- 初次安裝 `enabled=false`，沒有麥克風權限即不能收音。
- 使用者切換 `false → true`：先保存設定，再經收音同意與 OS 權限取得後嘗試開始；失敗時保留已啟用偏好，但顯示「權限不足／尚未收音」，**不得標成正在聆聽**。
- 程式冷啟動後若保存 `enabled=true`：只進入 `armed`（已啟用、待按「開始陪聊」），**不自動開麥克風**。這個保守行為避免無意識背景收音；同一次執行中使用者已明確啟動後，即使 Electron 視窗隱藏仍可繼續，但選單列與系統麥克風狀態須看得見。
- 使用者切換 `true → false`：立即強制停止 Companion session，撤銷衍生的候選事件，阻止過期回呼及 TTS；即使停止中或寫檔失敗也要以安全優先停止收音，並顯示保存失敗讓使用者知道重啟可能不是預期值。可另提供「暫停陪聊」但不取代主開關。
- 應提供「開始／停止陪聊」快捷操作（僅在 `enabled=true` 顯示），避免使用者需為暫停反覆修改偏好。`stop` 不更動 `enabled`，`disable` 會保存為 false。

狀態機：`disabled → armed → requesting_permission → listening → evaluating → responding → listening`，可由任意開啟狀態轉 `paused`／`error` 或 `disabled`。`enabled=false` 強制覆蓋所有狀態；收到頁面 unload、OS 麥克風撤銷、音訊中斷、核心連線失效時採 fail-closed。狀態畫面與測試不得僅根據 checkbox 猜測是否收音。

## 3. 架構與資料流

```text
LG G3  ──(原電視播放；MVP 不讀取畫面)────────┐
                                            │ 客廳聲音
XVF3800／Mac 麥克風 ──► local capture ──────┘
     │
     ▼
本機 VAD → TV/AI 音訊排除與聲源信心 → 本地 ASR
     │                │
     │                └── 低信心／電視台詞 → discard
     ▼
Engagement Policy（啟用？授權？接話模式？冷卻？）
     │
     ├── 不接話 → discard / 不上傳
     └── 允許 → 已核准的文字片段送既有 AIOS 模型路由
                       │
                       ▼
                回答約束 + TTS
                       │
                       ▼
                Mac／外接喇叭
```

**關鍵隔離**：Companion 的背景偵測階段只能在本機處理音訊；未被准許的原始音訊與逐字稿不得傳給雲端。現有 WebRTC Realtime 是整段 session 傳輸音訊的路徑，**不能未經架構改造就直接當成自然陪聊的常開辨識器**。MVP 建議「本機偵測＋本地 ASR＋政策通過後才送文字到已授權的既有模型路由」；文字回覆與 TTS 重用現有可用能力。若要改用雲端 ASR／Realtime，必須獨立取得明確同意，並重新評估隱私政策與成本提示。

AEC（回聲消除）和聲源方向估計只是輔助特徵。沒有獨立電視參考音訊時，不可保證將近場觀眾和電視聲分離。MVP 以**負例測試**決定何時允許 `natural`；高誤觸發時回退到明示的 `wake` 模式，由使用者主動選擇。不得只用 prompt 提醒模型「忽略電視聲」。

### 3.1 事件與所有權

- 同一時間只能有一個元件持有麥克風／播報權：`companion`、`voice_conversation`、`realtime`、`push_to_talk` 不得同時啟用兩個 capture。使用者手動開啟其他語音模式時，先暫停 Companion（保留 `enabled`）並顯示原因；結束後不自動恢復收音，需再次明確開始。
  - 交互引用（2026-10-29）：[17 本機喚醒詞規劃 §5.3](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md#53-避免自我觸發與搶麥克風) 的常駐喚醒聆聽刻意採不同規則：同一次執行中通話結束後，若偏好仍開且裝置事件確認來源 track 仍為 `live`，回到本機喚醒偵測；George 2026-10-29 另決定偏好開著時，App 重開與睡眠或鎖定回來後也自動恢復（先 `armed`，收到 track `live` 才顯示收音，並有一次性恢復提示；見 17 §5.8）。這只適用喚醒偵測，不改變 Companion 的「不自動恢復」與「冷啟動只進 `armed`」（本文件 §2.2）。
- 每次 `start` 建立 `session_id` + `epoch`；聲源判定、LLM 回覆及 TTS 必須比對當前 epoch。關閉或暫停即遞增 epoch，舊非同步結果不能復活、發話或送出工具。
- 使用者控制語句「關閉陪聊」「不要再聽」在可辨識時優先交給**本機確定性意圖**，避免依賴 LLM。UI、選單、快捷鍵一定要能硬停止，即使網路斷線亦然。
- 不讓自動聊天經由 Agent 工具控制家電、寄訊息或寫入外部系統；明確要求外部工作時交回既有 Action Gate 和人工確認。沒有工作授權的評論只可回話。

## 4. 持久設定、API 與 UI 契約（提議，非既有端點）

沿用 `PrefsFile` 的原子寫入、逐欄驗證與單一寫入者；新增 `configDir/companion.json`（`schema_version=1`、權限建議 0600），並在 `GET /api/settings` 返回使用者偏好和**獨立**的 runtime 狀態。

```json
{
  "schema_version": 1,
  "prefs": {
    "enabled": false,
    "activation": "natural",
    "verbosity": "short",
    "cooldown_seconds": 15
  }
}
```

新端點／事件建議：

| 介面 | 用途 | 驗證與回覆 |
|---|---|---|
| `GET /api/settings` | 附加 `companion.prefs`、`companion.runtime` | 不含音訊與逐字稿；只報真實 capture 狀態 |
| `POST /api/settings/companion` | 局部更新四個偏好鍵 | 型別、enum、5–60 step 5 驗證；未知鍵／越界回 400；成功再廣播 `settings.updated` |
| `POST /api/companion/start` | 已啟用且取得麥克風同意後請求啟動 | session owner、互斥、權限與能力檢查；start 不得略過平台授權 |
| `POST /api/companion/stop` | 停止當前 Companion session | 重複停止安全、只處理擁有的 session；即刻中止本地流程 |
| SSE `companion.state` | `armed/listening/evaluating/responding/paused/error` | 真實 device/session 事件；不可用 toggle 推導假事件 |

API 範例：

```http
POST /api/settings/companion
Content-Type: application/json

{"enabled":true,"activation":"natural","verbosity":"short","cooldown_seconds":15}
```

**注意**：這是未實作的 API 草案。實作前須依既有 `server/app.ts` 的 localhost / Host / Origin 防護，決定 start/stop 需要的 session owner 檢查與權限機制。切換 `enabled=false` 的停止動作必須在 UI 端先同步阻斷新音訊處理，伺服器寫入失敗仍要明確回報。

### 4.1 UI 位置

- macOS Electron：沿用 `desktop/settings-menu.mjs` 與現有「選單列為主要設定入口」規則。主 checkbox 直接可見；其他三項用 radio 子選單，並提供**開始／停止**和「正在聆聽／待開始／不可用」真實狀態。現有 `seconds-menu.ts` 支援 bool/seconds/factor，尚不支援 enum，應另加受測 enum row 或獨立 Companion menu builder，**不可拿秒數欄位偽裝 enum**。
- Browser：在既有**按需**設定視圖中顯示相同四欄與狀態，不建立新的常駐設定面板。
- 回覆顯示：首版可用既有字幕與音訊播報；若要持續浮現文字 Surface，必須有已驗證的 `visibility_reason`。不可繞過 `src/presentation-policy.ts` 或把「背景主動顯示」說成現在已有的能力。
- 可及性：開關支援鍵盤操作及標籤；硬停止置於可快速到達的位置；設定更新後以 server 確認值重畫，失敗不得留下假勾選。

## 5. Engagement Policy 與 Prompt

模型只負責語意與表達；以下門檻由確定性的本地程式決定：

1. `enabled===true`，且 runtime 真在 `listening`、收音有明確同意、音訊屬當前 session。
2. 經 VAD / 語音來源檢查，不是電視台詞、AI TTS、環境噪音；低信心即不送雲端。
3. 以本地 ASR 得到候選話語。`wake` 只接受明確喚醒；`natural` 僅考慮現場評論／提問；`active` 另外要求可靠、非虛構的當前情境。
4. 已超過 `cooldown_seconds` 且沒有播報衝突。使用者**直接明確提問**可繞過一般冷卻，但仍須過前 1–3 與安全規則。
5. 只把准許的文字及**實際擁有**的上下文交給模型。未知電視片名與畫面一律標為未知；可能劇透時優先保持沉默或只回應已知情節。

模型輸出的建議契約（仍由 local gate 最終決策）：

```json
{
  "should_respond": true,
  "reply_text": "這個轉折真的很突然，我也有點意外。",
  "context_source": "user_speech_only",
  "spoiler_risk": "low",
  "confidence": 0.87
}
```

建議 system prompt：

> 你是使用者身旁自然陪聊的朋友。只有獲准的使用者話語才是接話依據。回答優先一至兩句，避免搶話與沒必要的長篇講解。若未取得影片畫面、字幕或劇情資料，絕不聲稱自己看到或聽到特定場景；不得劇透尚未出現的劇情。當候選內容不明確、沒有值得回應的資訊，輸出不回應。不要自行啟用麥克風、改動模式或呼叫有副作用工具。

## 6. 安全、隱私與成本

- **預設關閉，使用者可停**：關閉開關即切斷 Companion 擁有的 MediaStream tracks、取消計時器、ASR／LLM pending work、播報；本機端不可再接受新 Companion 回應。可允許正在本機中止的 UI 短暫顯示「正在停止」，不得顯示仍在聆聽。
- **不得隱藏收音**：收音狀態以實際 capture 事件為準；macOS 系統指示器及 App 選單列都要能辨認。設定檔壞掉、遺失或版本不符時，`enabled` fail-closed 為 false。
- **本地優先**：原始背景音訊、未觸發語音與電視台詞不落盤、不寫 log、不輸出 trace、不送雲端。只保留去識別化的統計計數（例如觸發數、假陽性）；任何逐字稿紀錄都要另行明確選擇。
- **雲端和費用**：通過 gate 的文字若送雲端模型，UI 須沿用 AIOS 已有的路徑與計費說明；不宣稱 ChatGPT OAuth 等同免費 Realtime，也不默默開啟付費音訊串流。沒有有效供應商或本地推論服務時，顯示不可用，不假造回答。
- **權限範圍**：僅處理自有 Companion session。關閉本功能不能取消其他背景任務；完整退出程式、喇叭被拔掉、帳號過期、網路中斷、OS sleep/wake 後都應是 fail-closed，需明確回復。
- **家庭場景**：提示現場可能有其他人聲，預設不建立家庭成員聲紋，不記錄他人對話；若之後接 FamilyRecorder，必須另有獨立同意與資料隔離設計。

## 7. 工程驗收（未執行）

| ID | 驗收情境 | 必須觀察到的結果 |
|---|---|---|
| CM-01 | 首裝／讀不到設定／無效 schema | `enabled=false`；不曾要求麥克風，不建立 session |
| CM-02 | 使用者開啟但拒絕麥克風權限 | 保持不收音；顯示原因；不得顯示 listening |
| CM-03 | 開啟、關閉、重啟、再進頁面 | 偏好保存；冷啟動只 armed、不自動收音；再次開始才捕捉 |
| CM-04 | 任意階段關閉主開關 | 立即阻止新輸入與舊回覆；目標 1 秒內停止自有收音／播報 |
| CM-05 | 音訊觸發後、模型回覆前關閉 | 透過 epoch 拋棄舊結果；不得復活或晚到播音 |
| CM-06 | Companion 開著時手動啟動 Realtime | 只有一份 mic owner；Companion 暫停，不能兩個同時辨識／TTS |
| CM-07 | 改四項設定（合法、越界、非法枚舉） | 合法保存且 UI 正確；非法 400，其他偏好不變 |
| CM-08 | 無節目資訊時談論正在播放的片 | 不假稱看過畫面、不編造台詞、不劇透 |
| CM-09 | 電視說話、廣告、AI 自己說話 | 不自行接話、不產生 TTS 迴圈；保留可檢視的**非音訊**決策統計 |
| CM-10 | 兩次相近評論、冷卻調整、明確提問 | 按冷卻政策回覆；明確提問也須通過聲源及授權 gate |
| CM-11 | 離線、重整、視窗隱藏、睡眠喚醒 | 非預期恢復不自動收音；UI 真實反映 session 狀態 |
| CM-12 | 口頭「關閉陪聊」或選單硬關閉 | 本機停止無須依賴 LLM／雲端；其他背景任務正常 |

建議實機門檻（**測試目標，不是已達成數值**）：

- 安靜室內正常距離，20 次現場評論至少 18 次被正確辨識並按政策處理，且使用者關閉後誤回覆為 0。
- 電視音量涵蓋低、中、高，連續至少 2 小時只有電視台詞與廣告時：**錯誤主動接話少於 1 次／2 小時**；需分別紀錄純麥克風與具 TV reference 的兩組測試。
- 允許回應的短評論到 AI 開始發話的 p50 目標 ≤ 2.5 秒；需在報告附裝置、路徑與樣本量。
- 在權限拒絕、連線失敗、播放中關閉等負例中：未觸發音訊外傳數 0、失控重啟數 0。

所有測試要分清：unit／fixture、browser UI、Electron 選單、XVF3800 真硬體、電視播放實測。`node scripts/verify-aios.mjs` 只驗證它實際涵蓋的程式路徑，不可據此宣布自然陪聊已通過實機 gate。

## 8. 不在本批次完成的擴充

- LG webOS 控制、頻道／節目資訊與電視短訊息。
- 對 TV 光纖／HDMI 音訊做 AEC、回聲參考時序對齊。
- 電視畫面、節目字幕與真正具場景脈絡的主動評論。
- 家庭成員個人化、聲紋、長期觀影記憶與跨裝置連續陪聊。

開發實作步驟、測試範圍與交付標準見 [Companion Mode 開發批次](development/companion-mode-implementation-plan.md)。
