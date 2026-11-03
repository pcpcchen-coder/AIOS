<!-- bilingual: source=zh-TW -->

> [繁體中文](18_App_Integration_Layer_and_Spotify_2026-11.md) | [English](18_App_Integration_Layer_and_Spotify_2026-11.en.md)

# 18｜Nous App Integration Layer 與 Spotify／Pi 4 設計

日期：2026-11-03（Asia/Taipei）。狀態：**設計提案，尚未實作、未驗證 Spotify 實機，也未取得 Spotify 語音控制授權**。這份文件不是產品能力宣告。開發遵守 [CLAUDE.md](../CLAUDE.md)、[目前實作狀態](Current_Implementation_Status.md)、[智慧家庭 H0–H4](12_SmartHome_Integration_Plan_2026-10.md) 與 [雙語規範](BILINGUAL.md)。週末實驗另見 [Soloist 測試計畫](experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.md)；既有 Pi 終端方案在 `experiment/rpi4-remote-terminal` 分支的 `docs/experiments/RPI4_REMOTE_TERMINAL_TEST_PLAN.md`，未合併 main。

## 1. 目標、決策與非目標

George 已訂閱 Spotify Premium Family，準備用 Raspberry Pi 4 作為有螢幕、麥克風、喇叭、鏡頭的遠端終端，Mac mini 保留 Nous 核心。希望之後由 Nous 操作 Spotify，再擴充其他 App。

本次建議建立 **Nous App Integration Layer（AIL）**：一個位於 Node/TypeScript 核心、與模型供應商及前端裝置解耦的工具註冊／執行邊界。先維持 HomeBridge 原功能，新增 Adapter 契約及 mock 測試，再以 Spotify Soloist 驗證 Pi 上獨立播放。**Spotify 的 Nous 語音控制功能必須維持關閉，直到取得適用的書面授權或官方正式允許的整合路徑。**

不做的事：不把完整 AIOS 移到 Pi、不重寫 HomeBridge、不把多項 App 請求直接交給瀏覽器、不公開 MCP/Spotify WebSocket、不將 Spotify 音訊傳給 LLM、不建立 App launcher／首頁 Dashboard、不因 Family 方案推斷有 API 開發權利。

## 2. 現況對照（main 分支程式）

| 現有位置 | 目前責任 | AIL 改動建議 |
|---|---|---|
| `server/realtime.ts` | 兩條即時語音路徑共用工具定義，`buildRealtimeTools` 依 web/home/mcp/memory 建清單 | 由 Registry 產生已啟用、合法可使用的工具規格，不一次搬走所有既有工具 |
| `server/live-tool-caller.ts` | ChatGPT 方案的 Codex 工具調度；`HOST_TOOLS` 是固定名單，MCP 被移除 | 逐步改用同一 Registry 的 allowlist；保留工具數與時間預算 |
| `src/realtime-tools.ts` | API key 模型及 live 路徑共用 renderer 的 `executeRealtimeTool`，現有 `home_status`／`home_control` 分支 | 外部整合改由核心執行；renderer 只傳請求、呈現狀態／確認卡 |
| `shared/realtime-route.ts` | `HostToolName`、`SIDE_EFFECT_TOOLS`、逾時／結果不明契約 | 增加版本化 `IntegrationToolId`／`EffectClass`，遷移後保留相容映射 |
| `server/app.ts`、`server/nous.ts` | 提供 HomeBridge HTTP API、組裝服務、交付設定 | 在核心注入 IntegrationRegistry；HTTP 僅提供必要的本機狀態／動作，驗證 caller |
| `server/home-bridge.ts` | 已實作智慧家庭橋接、結果及確認邏輯 | 首批只包裝為既有工具的 Adapter Facade，不能降低回讀與確認保證 |
| `server/config.ts` | `.env`、MCP、智慧家庭設定 | 新增服務啟用／授權／診斷設定，不存取前端傳入的任意 URL |

重要差異：API key 即時語音支援遠端 MCP；ChatGPT 方案 live 路徑不支援遠端 MCP，但可使用本地函式工具。因此 **核心本地 Adapter + 共用 Registry** 比直接把 Spotify 寫成遠端 MCP 更適合這兩條路徑。普通文字聊天／背景任務未有相同的函式工具循環，本次不宣稱其自動具備 AIL；須另立批次接入。

## 3. 建議架構

```text
Pi 4 (Chromium/UI/mic/camera/speaker) --- SSH local forwarding ---> Mac mini Nous Core
                                                                    |
OpenAI API key Realtime / ChatGPT live -> common tool registry ------+
                                                                    |
                           Integration Dispatcher + Policy/Status/Audit
                             |             |              |
                        Home Adapter    Spotify Adapter  Future Adapters
                             |             |              |
                         HomeBridge   Local Soloist     Calendar / Mail
                                         |
                         SSH reverse tunnel (loopback only)
                                         |
                               Pi 4 Soloist + audio output
```

音樂由 **Soloist 在 Pi 上獨立串流與輸出**；Nous 語音 WebRTC 音訊也由 Pi Chromium 收放，但兩者是獨立程序，須分別選音訊設備，測試避免同時播報混音。AIOS Core 維持 Mac `127.0.0.1`；Pi 終端的 SSH `-L` 與 Soloist 管理介面的 SSH `-R` 是兩個不同方向的通道。Soloist WebSocket 只綁 Pi `127.0.0.1`，Mac 也只在 loopback 收到轉送；不提供 LAN 對外 port。

## 4. Adapter 契約（建議，不是已存在的檔案）

建議新增目錄：

```text
prototype/ambient-shell/
  server/integrations/
    registry.ts
    dispatcher.ts
    contracts.ts
    policy.ts
    status.ts
    adapters/
      home.ts
      spotify-soloist.ts
      mock.ts
  shared/
    integrations.ts
  tests/
    integration-registry.test.ts
    integration-dispatcher.test.ts
    integration-spotify-mock.test.ts
```

概念型別：工具名稱使用 `app.<service>.<action>`，切勿把模型產出的字串直接組成網址、shell 指令或檔案路徑。

```ts
type EffectClass = "read" | "reversible_write" | "external_commit";
type ToolResult = {
  ok: boolean;
  status: "confirmed" | "unconfirmed" | "unknown" | "needs_confirmation" | "refused" | "failed";
  message: string;
  data?: unknown;
};
interface IntegrationAdapter {
  id: string;
  version: number;
  tools(): readonly ToolDefinition[];
  health(): Promise<{ available: boolean; reason?: string }>;
  execute(toolId: string, args: unknown, ctx: ExecutionContext): Promise<ToolResult>;
}
interface ToolDefinition {
  id: string;
  description: string;
  inputSchema: unknown;
  effect: EffectClass;
  enabled: boolean;
  timeoutMs: number;
}
interface ExecutionContext {
  actor: "user" | "agent";
  sessionId: string;
  requestId: string;
  signal: AbortSignal;
}
```

以上為契約草稿，實作應使用實際 Schema 驗證器及嚴格 discriminated union；`data` 只存可安全回傳的最小資料。加入 `supportedRoutes`（api_key/live/text/background）與 `capabilityStatus`（available/disabled/unsupported/authorization_required）後，工具清單必須依真實設定動態生成，拒絕未註冊／停用／超出來源權限的呼叫。**模型不能自行把 `enabled` 設為 true。**

### 執行流程

1. Registry 註冊 Adapter，檢查唯一 ID、Schema、版本、啟用狀態、來源支援及限額。
2. Dispatcher 驗證工具與參數，決定權限與本次是否需要確認；執行前留下無敏感資料的 request-id。
3. 本機核心執行 Adapter：只連受信任的已配置本機服務，設定逾時、中止、速率限制；有副作用操作使用 request-id 或 idempotency key。
4. 確認卡沿用既有 ApprovalQueue，明確動作必須由使用者確認；`home_control` 原有 H1/H1b 行為保留，不改為全部確認。
5. 返回統一結果；只有 `confirmed` 可宣稱完成，`unconfirmed`、`unknown` 需口語說明，不能因 timeout 推定未執行。記錄 duration、result、adapter，不記 token、歌單隱私內容或原始逐字稿。
6. 前端僅顯示使用者此次請求相關的按需狀態，不做固定 App 列表或 Dashboard。

首批不做動態安裝第三方外掛：使用程式碼明確註冊已審核 Adapter，避免任意載入程式碼；日後再評估 MCP 作為「Adapter 的一種 Transport」，而不是所有 App 都強制使用 MCP。

## 5. Spotify Adapter：嚴格區分控制能力與使用權利

| 功能 | 技術候選 | 本次決策 |
|---|---|---|
| Pi 當作 Spotify Connect 播放器 | 官方 Soloist ARM64/ARM32、Spotify App 手動配對 | **可以先手動測試** |
| Soloist 本機 `status`／`now` | `soloist ctl` 或 loopback WebSocket | **可以先做本機隔離觀察測試**；不自動把內容送進雲端模型 |
| 手動介面上的播放／暫停／音量 | 官方 Soloist 本機控制介面 | 先核對官方允許的 local integration 用例；測試不要接 Nous 語音 |
| Nous 語音控制 Spotify | Web API 或 Soloist 指令 | **授權待確認，預設 disabled** |
| 搜尋歌手／歌單／控制遠端裝置 | Spotify Web API + OAuth 授權 | 技術可研究，但語音控制整合仍受政策限制；Development Mode owner 需 Premium、最多 5 位使用者 |
| 接收／重串 Spotify 原始音訊 | 不使用 | 不支援；Soloist 自行播放，不讓 Nous 取得原始串流 |

Spotify Developer Policy（2025-05-15 生效）III.3 明文禁止未獲允許的語音控制 Spotify 整合；Spotify 官方 Compliance Tips 也列出 Voice-Control 為違規用例。**Spotify Premium Family 是訂閱資格，不等同開發者政策豁免**。不得以 Soloist 本機 WebSocket、Mac 鍵盤模擬或其他媒介繞過相同產品用途限制；直到 Spotify 提供書面允許／官方可用方案，任何 `app.spotify.play`、`pause`、`search_and_play` 等對 Nous 語音路徑都不得註冊為可用工具。若政策或官方授權變更，留存核對日期、官方條款連結及授權文件再開 gate。

家庭方案每位成員各有 Spotify 帳號。首個試驗僅使用一個本人帳號與單一 Soloist 裝置，不建立家人的自動切換或跨帳號曲庫索引。授權資料和 Soloist session 留在本機，任何 OAuth 都採最小 scope、PKCE／安全儲存與明確登出。

Spotify Soloist 官方支援 Linux ARM64／ARM32、Spotify Connect、選用的本機 WebSocket 及 `soloist ctl`，Linux 主要使用 PipeWire 並可回退 PulseAudio；build **自建置日期起 90 天失效**，需更新二進位版本；不得把官方 binary 重新散布或提交至 repo。Soloist WebSocket 無內建身分驗證、TLS、Origin 或 CSRF 防護，因此僅能綁 loopback，不得暴露於 LAN。

### 裝置與聲音所有權

- 「播放在 Pi」與「播放在 Mac」是不同 Output Target；不能僅因同一 Spotify 帳號就聲稱可同時播放多台。
- Pi 的 Chromium 麥克風／TTS 與 Soloist 音樂是兩條音訊路徑；分別測輸出、避免 Nous 回音誤觸。與 Spotify 內容混音的授權限制需確認，預設不要在播放 Spotify 內容時向同一音訊輸出疊加語音。
- 若 Pi 離線、SSH tunnel 中斷、Soloist session 失效或裝置被其他客戶端接管，狀態須回報 unavailable／unknown，禁止假成功。

## 6. 後續 App 與能力路線

| Adapter | 首版能力 | 授權與風險 |
|---|---|---|
| `home` | 重用現有 HomeBridge 狀態／控制 | 保留單向設備 `unconfirmed`、設備政策與固定確認語句 |
| `spotify-soloist` | 本機裝置健康狀態及人工測試；語音操作關閉 | Developer Policy voice-control gate；本機 WS loopback |
| `calendar`（待選供應商） | 查詢行程、可用時段 | OAuth read scope；建立／修改／取消需依副作用政策 |
| `mail`（待選供應商） | 查詢郵件、草稿 | 發送需 Action Gate 當次明確確認；最小授權 |
| `video`（待選供應商） | 開啟合法影片／播放清單 | 區分裝置播放器控制與供應商 API 權限 |
| `mcp`（選用） | 經核准的外部工具 transport | 不把未知遠端 MCP 自動當可信本機 Adapter |

### 分批施工與 Gate

| 批次 | 交付 | Gate |
|---|---|---|
| AIL-0（本 PR） | 雙語架構規格、Spotify 授權邊界、週末實驗清單 | 文件互連、主線程式無改動、無宣稱實測 |
| AIL-1 | Registry、Dispatcher、Fake Adapter、共用結果；旗標預設 off | 同工具在 api_key/live 產生一致 schema；非法／停用／timeout／中止測試通過 |
| AIL-2 | HomeBridge Facade + route 逐步移轉 | H0/H1/H1b 回歸無差異；原確認與不明狀態維持 |
| SP-0（週末） | Pi Soloist 官方 binary、Spotify App 人工 Connect、Pi 出聲、loopback WS/CLI 觀察 | 真 Pi 量測報告，不需要 Nous 語音工具 |
| SP-1 | Spotify Adapter 本機健康與 mock，聲控功能 disabled | 沒有授權不出現在模型 tools；無 token 外洩 |
| SP-2（blocked） | 若取得授權，增加受允許的 Spotify 語音動作 | 先附書面授權／條款核准證據，再實機語音與失敗路徑測試 |
| AIL-3 | 非 Spotify 的第二個 Adapter（如 Calendar），驗證擴充性 | 新增 Adapter 不修改模型核心 switch／renderer 分支 |

## 7. 驗證清單、回退與尚待確認

週末先執行 [SP-0 測試計畫](experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.md)，將每一步標成 PASS／FAIL／NOT TESTED，留下 Pi OS、CPU／RAM／溫度、裝置顯示與音訊路由證據（去識別）。不把 CLI demo 當成「Nous 已能語音控制 Spotify」。

未來 AIL-1 最少測：重複 tool id、非法 schema、禁用 App 仍被模型請求、不同路徑相同語意、權杖不下發 renderer、斷線、timeout 後副作用 unknown、取消、確認卡一次性、token 不出現在 log、HomeBridge 不退化。

回退：AIL 預設 off、保留既有 HomeBridge；Pi Soloist 停止程序即可恢復，無需停 Nous 核心。週末不修改任何正式權杖，不暴露本機 API。**本設計本身沒有開啟任何 Spotify、Calendar 或其他 App 連線。**

## 8. 官方資料（2026-11-03 查核）

- [Spotify Developer Policy](https://developer.spotify.com/policy) — III.3 語音控制禁止條款。
- [Spotify Compliance Tips](https://developer.spotify.com/compliance-tips) — Voice-Control 限制。
- [Spotify Soloist 官方文件](https://developer.spotify.com/documentation/soloist) — 功能、啟動與 API Key。
- [Soloist Overview](https://developer.spotify.com/documentation/soloist/concepts/overview) — 本機 WS、PipeWire、90 天有效期。
- [Soloist Basic Integration](https://developer.spotify.com/documentation/soloist/howtos/basic-integration) — loopback 與 CLI。
- [Soloist Downloads and Updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates) — ARM 二進位與更新。
- [Spotify Development Mode](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) — Premium owner、5 位授權使用者。
