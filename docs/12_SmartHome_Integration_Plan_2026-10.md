# Nous 12 — 武陵居智慧家電整合規劃（AIOS 端）

版本：v0.1 · 日期：2026-10-21 · 狀態：規劃，尚未實作
對應：SmartHomeAI repo [`docs/AIOS接入規劃.md`](https://github.com/pcpcchen-coder/SmartHomeAI/blob/main/docs/AIOS接入規劃.md)（中控端要補的介面）
關聯：10（遠距 UI）、11（雙目鏡頭）、即時語音的工具與語音確認（`prototype/ambient-shell/src/realtime.ts`、`src/approval.ts`）

---

## 0. 一頁摘要

- **目標**：George 在 18 吋螢幕前 1.5–3 m 處，用語音控制與查詢武陵居的家電：「客廳燈關掉」「冷氣調 26 度」「現在濕度多少」。全程免手。
- **分工**：
  - **中控（SmartHomeAI）**：設備、狀態、控制、回讀確認、權杖、風險等級。
  - **AIOS**：語音、名稱對應的對話、確認卡、畫面、與鏡頭的在場資訊整合。**整合工作放在 AIOS**。
- **連線（已決定）**：AIOS 本機核心經區網呼叫中控 REST v1 與 SSE，使用範圍權杖。
  - **不走 OpenAI Realtime 的遠端 MCP**：那會由 OpenAI 伺服器連進家裡，等於把家庭控制開到公網。
- **語音工具**：新增 `home_status`、`home_control` 兩個函式工具，由 AIOS 本機核心代為呼叫中控。
- **風險分級**：
  - low：直接執行。
  - medium／high：顯示確認卡，說「確認執行」才送出，沿用現有的語音確認。
- **回報結果**：只說中控回報的真實結果。
  - `confirmed` 才說「已經關了」。
  - `unconfirmed` 說「已送出，請確認」，例如紅外線。
  - `failed` 照實說。

---

## 1. 架構

```
George（遠處）
  │ 語音（OpenAI Realtime，WebRTC）
  ▼
AIOS 前端（電子腦、確認卡）
  │ function call：home_status / home_control
  ▼
AIOS 本機核心 HomeBridge（新）── REST v1 + SSE，Bearer 範圍權杖 ──► 武陵居中控 :8788
  │                                                          （設備轉接器、回讀、稽核）
  └─ 權杖只在本機核心；不進瀏覽器、不進 OpenAI
```

**HomeBridge**（`server/home-bridge.ts`）是 AIOS 本機核心的新模組，職責如下：

1. **設定**：`.env` 的 `SMARTHOME_URL`（例如 `http://127.0.0.1:8788`）與 `SMARTHOME_TOKEN`（中控「系統接入」建立的 AIOS 專用權杖）。
2. **快取**：保存設備清單與房間（`GET /home`、`/devices`，之後改用 `/rooms`）。
3. **名稱解析**：
   - 中控提供 `GET /resolve` 後直接使用（中控 P0-3）。
   - 在那之前，用本機的確定性比對過渡：名稱、別名、房間；完全相同優先，其次是包含關係。
4. **送出指令**：`POST /devices/{id}/commands`，帶 `Idempotency-Key`（AIOS 產生的指令 ID）。逾時重試時沿用同一把 key。
5. **接收結果**：訂閱 `GET /events`（SSE，Last-Event-ID 重播）。
   - 收到 `command.result`（中控 P0-4）就轉成語音通知。
   - 在中控補上之前，改用 `GET /commands/{id}` 輪詢。
6. **風險等級**：
   - 讀取中控提供的 `risk`、`confirmable`（中控 P0-2）。
   - **在中控補上之前，所有寫入一律視為 medium，需要語音確認**。AIOS 不自行猜風險，只採保守預設。

## 2. 即時語音的工具

```jsonc
// 查狀態與感測值（不改變任何東西）
{ "name": "home_status",
  "parameters": { "target": "客廳 / 客廳主燈 / 全家", "metric": "temperature | humidity | co2 | power | …（可省略）" } }

// 控制一台或一個房間的設備
{ "name": "home_control",
  "parameters": { "target": "客廳主燈", "command": "power | brightness | temperature | color | volume | mute | play | pause | stop",
                  "value": "true / 60 / 26 / #FFAA00 …" } }
```

回傳給模型的內容（模型依此說話，不自己補資料）：

| 情況 | 回傳 | 模型怎麼說 |
|---|---|---|
| 名稱有多個候選 | `{ status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] }` | 「是客廳主燈還是立燈？」；畫面顯示兩張編號卡，說「第一個」也可以 |
| 找不到 | `{ status: "not_found" }` | 「家裡找不到叫這個名字的設備」 |
| 需要確認 | `{ status: "needs_confirmation", confirm_id }` | 用一句話說要做什麼，請使用者說「確認執行」 |
| 已確認 | `{ status: "confirmed", message }` | 「客廳主燈已經關了」 |
| 未確認 | `{ status: "unconfirmed", message }` | 「已送出，請看一下有沒有反應」 |
| 失敗 | `{ status: "failed", message }` | 照實說原因 |
| 讀值缺失 | `value: null` | 「沒有讀值」，不說 0 |

**確認流程**沿用 PR #9 的語音確認：
- **確認卡**：琥珀色，顯示動作、設備、房間與數值。
- **固定語句**：`src/approval.ts` 判斷。「確認執行」才送出；只說「好」不算；說「取消」、60 秒逾時或收起確認卡都不送。
- **要調整的地方**：目前確認佇列只服務 MCP 的 `mcp_approval_request`，要擴充成也能處理 HomeBridge 的 `needs_confirmation`。HomeBridge 的確認由本機核心執行指令，不經 OpenAI。

## 3. 畫面（延續 10 的遠距規則）

- **查狀態**：照 05 的錨點樣式，一個大數字加房間名，例如「客廳 26.5° · 濕度 62%」，並標示資料時間。資料過舊時標「快照」，不當成即時值。
- **控制結果**：設備名加大圖示（✓ 已確認／⏳ 已送出／✕ 失敗），3 秒後收起，不需要按任何東西。
- **房間指令**：例如「客廳的燈全部關掉」，逐台列出結果，不顯示「全部成功」。
- **完整細節**：每台的回讀值、來源、時間寄到信箱，不放在 18 吋畫面上（10 §5）。

## 4. 與雙目鏡頭（11）的整合

- **沒有人在場時**：不主動播報家電事件，例如「洗衣完成」。事件排隊，等有人回來才說。
- **距離自動字級**：同樣套用在家電狀態畫面。
- **手臂指向**：只用來選螢幕上的候選卡片，例如「客廳主燈」或「客廳立燈」。不用來指實體家電，因為鏡頭看不到家電位置與中控的平面圖座標對應，這項另立規劃。
- **手勢不能觸發控制**：停止手勢只停播報，不送任何家電指令。

## 5. 安全與隱私

- **權杖**：AIOS 只使用中控核發的範圍權杖（中控 P0-1：`devices:read`、`telemetry:read`、`commands:write`、`events:read`）。不取得廠商憑證，不能改配置或管理權杖。
  - 範圍權杖完成前，若先用完整權限權杖做開發驗證，只能連示例設備，並在 README 標示。
- **保存**：權杖放在 `.env`，只在本機核心使用，不送瀏覽器、不寫進 trace、不出現在 OpenAI 的工作階段設定。
- **不公開到網際網路**：不提供公網路徑，不把中控掛成 OpenAI 遠端 MCP。
- **速率限制**：HomeBridge 本身限制每分鐘最多 6 個控制指令，避免語音誤觸連發。中控 P1-3 完成後以中控為準。
- **CLAUDE.md 紅線**：家電控制屬於外部副作用。medium／high 必須當次語音確認；low 的直接執行範圍，由中控的風險表加上 George 的覆寫決定。

## 6. 工作批次（AIOS 端）

| 批次 | 內容 | 依賴 | 完成條件 |
|---|---|---|---|
| H0 | HomeBridge 骨架、設定、`home_status`（唯讀）、本機名稱比對過渡、假中控測試伺服器 | 中控現有 REST | 語音問「客廳溫度」，回答中控的真實讀值與時間；缺值說「沒有讀值」 |
| H1 | `home_control`，所有寫入都要語音確認；`Idempotency-Key`；輪詢 `/commands/{id}` 回報結果 | H0 | 示例設備：說「確認執行」才送出；`unconfirmed` 不說成成功 |
| H2 | 改用中控的範圍權杖、`risk`、`resolve`、`command.result` SSE | 中控 P0-1～P0-4 | low 直接執行；同名候選以編號卡選擇；結果即時以語音回報 |
| H3 | 房間群組指令、逐台結果畫面、無人在場時事件排隊 | 中控 P1-2、11 的在場偵測 | 實機：從遠處用語音關掉一個房間的燈 |
| H4（選用） | 背景 Agent 透過中控本機 MCP 執行多步驟工作，例如晚上的例行檢查 | 中控 P3 | 與語音共用同一權杖範圍與風險表 |

每個批次依 CLAUDE.md 交付變更清單、測試結果、實機證據與未完成項目。

## 7. 測試

- **假中控**：
  - 用 Node 的假 HTTP 伺服器模擬 `/devices`、`/commands`、`/events`。
  - 涵蓋 `confirmed`、`unconfirmed`、`failed`、逾時、同鍵重送 409、SSE 重播。
- **語音工具**：
  - 用 RealtimeVoice 的假資料通道測工具呼叫、確認卡、固定語句、取消、逾時。
  - 確認「好」不會送出指令。
- **隱私**：權杖不出現在前端回應、OpenAI 工作階段 body、log。
- **實機**（George）：
  - 至少一台 LIFX 或 Tuya 燈（雙向回讀）。
  - 一台紅外線冷氣（單向，`unconfirmed`）。
  - 一個溫濕度感測器（讀值與時間）。

## 8. 待 George 決定

1. **部署位置**：AIOS 與中控在同一台 Mac，還是分開？
   - 同機：`SMARTHOME_URL` 用 127.0.0.1，中控不必開放區網。
   - 分開：中控要綁區網介面。
2. **low 風險直接執行的範圍**：燈、音量、暫停播放可以直接做嗎？還是先全部都要語音確認，用一陣子再放寬？
3. **high 風險設備**（洗乾衣啟動，未來的門鎖、瓦斯）：是否完全不開放語音？
4. **無人在場時的家電事件**：要排隊等人回來，還是同時寄信或推播到手機？
