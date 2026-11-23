<!-- bilingual: source=zh-TW -->

> [繁體中文](voice-command-relay-implementation-plan.md) | [English](voice-command-relay-implementation-plan.en.md)

# VCR-0～VCR-4：Voice Command Relay 開發、查表、音色校準與驗收

日期：2026-11-03。狀態：**交給 Claude Code 的實作規格；本 PR 僅文件，尚無實作／實測**。先讀 [19 完整設計](../19_Voice_Command_Relay_Design_2026-11.md)、[CLAUDE.md](../../CLAUDE.md)、[現況](../Current_Implementation_Status.md)、[雙語規範](../BILINGUAL.md)。延伸 main 已有的 AIL-1，不重建 Integration Registry、Dispatcher、Policy 或既有 HomeBridge。

## 0. 開發邊界與 Repo 修改位置

建議新增（**目前不保證已存在**）：

```text
prototype/ambient-shell/
  shared/voice-relay.ts
  server/integrations/voice-relay/
    target-registry.ts
    intent-catalog.ts
    command-catalog.ts
    command-resolver.ts
    voice-profile-store.ts
    voice-resolver.ts
    policy.ts
    relay-orchestrator.ts
    tts-engine.ts
    output-router.ts
    adapters/
      google.ts
      apple.ts
      amazon.ts
      xiaomi.ts
  server/integrations/adapters/voice-relay.ts
  tests/voice-relay-catalog.test.ts
  tests/voice-relay-voices.test.ts
  tests/voice-relay-audio.test.ts
  tests/voice-relay-routes.test.ts
  tests/voice-relay-policy.test.ts
```

預設建議資料位置：受保護的 Nous `configDir/voice-relay/`（`devices.json`、`voice-profiles.json`、`commands.json`、`trials.json`），**不含憑證或實際私人語音**。可版控的內建品牌模板和測試 fixtures 放在 repo 內；每台實體設備與音色選擇存使用者設定路徑，**不得**提交家庭成員、實體 IP、私人設備暱稱或錄音。先採版本化 JSON + Schema，不需要導入資料庫。若將來多使用者，`owner` 與設定隔離另開批次。

現有檔案的最小更動點：

| 路徑 | 動作 |
|---|---|
| `server/integrations/index.ts` | 在 `KNOWN_ADAPTERS` 增加明確核准的 `voice_relay`；透過既有 AIL 旗標與 `NOUS_AIL_SERVICES` 啟用 |
| `server/integrations/contracts.ts` | 沿用 `IntegrationAdapter` / `ToolDefinition`，不要複製另一個工具介面 |
| `server/integrations/policy.ts` | 對下游 service / action 做允許用途檢查，不可只比 `app.spotify.*` |
| `server/integrations/schema.ts` | 首版平面 JSON Schema 足夠，使用 `target_id`、`intent_id`、受控 slots，避免開放 `raw_text` |
| `server/config.ts`、`server/nous.ts` | 新增 `NOUS_VCR=off`、資料目錄注入、output node 初始化；不讀模型給的路徑 |
| `src/realtime-tools.ts`、`server/live-tool-caller.ts` | 優先使用既有 AIL 分流；確認兩條路徑真正走同一個 Adapter，不另加硬編碼 switch |
| Electron／Pi 音訊前端 | 提供獨立輸出控制與 `jobId` 回執；只有實體輸出成功才回 `unconfirmed` |
| `src/`、`shared/i18n.mjs` 等共用 UI | 新增的設備／音色測試 UI 遵守中英雙語、按需顯示，不做 Dashboard |

## 1. VCR-0：Catalog 與 Voice Profile 純邏輯（先做）

建立**三層正式資料表**：
1. `intent catalog`：`intentId`、slot schema、風險類別與支援來源。
2. `brand command catalog`：vendor／assistant／model／locale／version／intent／候選模板／喚醒詞／測試與政策狀態。
3. `tts voice profile catalog`：engine、voiceId、modelId/version、locale、rate、pitch、gainDb、wakePause、輸出 node/device、實測統計。設備表用 ID 引用兩份 catalog，無重複的命令文字。

API（概念契約）：

```ts
type ResolveResult =
  | {
      kind: "resolved";
      targetId: string;
      intentId: string;
      templateId: string;
      catalogVersion: number;
      voiceProfileId: string;
      spokenText: string;
      outputNode: string;
      outputDeviceId: string;
    }
  | {
      kind: "refused";
      reason: "unknown_target" | "unsupported_intent" | "not_reviewed" |
              "policy_blocked" | "invalid_slots" | "tts_unavailable";
    };

interface VoiceProfile {
  id: string;
  engine: "macos_say" | "browser_speech" | "local_tts";
  voiceId: string;
  modelId?: string;
  modelVersion?: string;
  locale: string;
  rate: number;
  pitch: number;
  gainDb: number;
  wakeToCommandPauseMs: number;
  leadSilenceMs: number;
  tailSilenceMs: number;
}
```

Resolution 演算法必須是**確定性的**：先驗證 target ID、意圖與 slots → 依設備 override→型號＋語系→助理＋語系→廠牌＋語系→明確通用 profile 查模板 → policy 與 test status 允許後，解析 TTS profile → 校驗輸出端 → 生成可朗讀字句。沒有符合或遇到同優先級多解，都回拒絕／設定錯誤，不讓 LLM 決定。可以同時保存候選語法和多個聲線，但「正式 selected」一律只有一個。

要實測不同模板，可在**使用者明確按下的 diagnostic 模式**指定 `candidateTemplateId` 或 `candidateVoiceId`；這兩個欄位**絕不出現在對模型公開的 ToolDefinition**。`read-only preview` 不開喇叭。

## 2. VCR-1：Fake TTS、Fake Output 和 Adapter

將 `VoiceRelayAdapter` 註冊在既有 AIL，建議工具 ID：
- `app.voice_relay.send_intent`，`effect: reversible_write`，初版僅 `api_key`／`live`，flat schema：`target_id`、`intent_id`、`genre`、`device`、`percent` 等受控欄位；**不要**暴露 `spoken_text`／`wake_phrase`／`voice_id` 等任意輸入。
- `app.voice_relay.capabilities`（選用、read-only），僅輸出可執行的低風險意圖與已註冊 target，不回傳家庭私人名稱。
- `app.voice_relay.preview`（選用、read-only），只回命令 ID／模板 ID、設定狀態，不執行、也不把私人裝置名稱送給模型。

使用 Fake TTS 與 Fake Output 驗證「每個 target 查對模板及聲線」；正式 `execute()` 禁止將 Fake Audio 回報為真實設備執行。Replay / fixture 永遠標註 mock。結果統一使用既有 `ToolResult`：
- 確定沒播音：`refused` 或 `failed`。
- 正在播音後逾時、中斷、回執遺失：`unknown`；不自動重試。
- 選定喇叭真的完成播音：`unconfirmed`；模型要說「已發出語音命令，但執行結果尚未確認」。
- 不能只因 TTS engine 回 `synthesisComplete` 就宣稱喇叭播音完成。
- `confirmed` 需要獨立的下游設備回讀；本批不做。

## 3. VCR-2：Mac 本地實體喇叭、音色選擇及可見診斷

先用 macOS 本地 `say` 或已存在的語音元件驗證 TTS，**不得**把模型輸入直接拼進 shell command；使用固定 executable + argv 陣列並隔離 shell，或首選可信原生 API。提供 `listVoices(outputNode)` 查可用 voiceId、語系、engine 與版本；若選定 voice 不存在，明確顯示不支援而不是偷偷替換。所有音訊只經**指定 outputDeviceId**；若 `say` 無法精準選輸出設備，必須另做具設備選擇功能的播放路徑，不能假裝已指定。

建議 VCR 測試 UI（只在設定或使用者明確要求的按需 Surface）：選 target、查看已選 command pack 與模板、選 TTS engine/voice、rate/pitch/gain、wakePause、輸出設備、按「預覽文字」「測試喚醒」「測試整句」「記錄結果」「採用這組」。畫面不能因測試按鈕之外的事件自動播音；第一次會播放聲音時給明確說明。所有中英文字進共用翻譯表。

測試模式禁止高風險 intent、非使用者直接操作、個人化身份聲音冒用與未允許下游。測試聲線時，避免同時改命令文字和聲線造成因果混淆。

## 4. VCR-3：Pi 4 遠端 Output Node

Mac mini 核心與 Pi Chromium 終端已另有 `experiment/rpi4-remote-terminal` 測試方案，**尚不能假定 Pi output agent 已存在**。通道可用經驗證的 WebSocket/SSE + 同源回報或現有 SSH local forwarding（不是讓核心 HTTP 開給整個 LAN）。當選中 `pi_living` 時，Pi renderer 必須確認所選音訊設備可用並回報 `audioStarted`、`audioFinished`、`audioFailed`，帶 `jobId`、`outputNode` 與 session-bound nonce；Mac 的 TTS 播放 callback 不能假冒 Pi 的硬體回執。

在 VCR 播音期間避免 Nous 的麥克風把「Ok Google」當作使用者命令。保持 Nous 既有的手掌停止與使用者插話策略；與背景播報競爭時先排程，不蓋掉一通尚未完成的 Realtime 回覆。不將另一個助理的回話重新餵給 Nous 模型當作可靠結果。

此階段只驗證實體喇叭和路由，不宣稱 Apple/Amazon/Xiaomi 的可用性。與 Spotify 相關的真實下游用途仍按 Policy Gate 檢查。

## 5. VCR-4：多品牌 Pack 與 A/B 實測結果

每個 vendor 使用同一標準 Catalog 介面，只改**資料**與明確差異的輔助 renderer，不以 `if (google) ... else if (alexa)` 在模型入口硬編碼語法。建議第一批設備是自家 Google Home Mini；Siri/HomePod、Alexa、小愛同學先提供 `candidate`（停用的模板），未實測不能設 `approved`。完整測試流程見 [VCR 實測表](../experiments/VOICE_COMMAND_RELAY_TEST_PLAN.md)。

下列變更需能**只改設定／資料表而不用改程式**：
- 同一意圖改成不同品牌命令句型及喚醒詞。
- 一個品牌兩台型號分別指定模板。
- 同一型號 `en-US` 與 `zh-TW` 用不同命令。
- 每台目標設備自由選 TTS 引擎、voiceId、rate、pitch、gain、停頓。
- 切換選定的候選音色後恢復原本設定；找不到 voice 直接拒絕，且不發聲。
- 人工輸入辨識率的測試結果、辨識率比較與可追溯的選用決定。

## 6. Gate、測試與回退

| Gate | 要完成的東西 | 測試／客觀證據 |
|---|---|---|
| VCR-0 | Intent／Brand Catalog／Voice Profile 三層、覆寫、查表 | 語意與版本驗證、明確優先序、找不到與衝突拒絕、各廠牌候選與音色獨立 |
| VCR-1 | Fake TTS/Output 與 Adapter | `api_key`／`live` 一致 tool schema；禁用時不出現在模型工具；mock 絕不宣稱實機成功 |
| VCR-2 | Mac 本地實播與診斷 UI | 使用者可選已安裝音色與輸出設備；首次動作確認；TTS 完成但設備未知→`unconfirmed` |
| VCR-3 | Pi 真實輸出與回報 | Pi 喇叭實播、Mac/Pi 不串錯、離線/逾時回 `unknown`、Echo／重送防護 |
| VCR-4 | 多品牌 Pack 與 A/B 實測 | 同一 intent 至少兩個不同品牌模板 fixture；至少兩組 TTS voice profile 的測試報告 |

建議每批執行：

```bash
node scripts/check-pstack.mjs
node scripts/check-bilingual-docs.mjs
node scripts/verify-aios.mjs
git diff --check
```

本批只新增文件；**沒有執行這些產品驗證**。每次實作由 Claude 在隔離分支依 pstack 流程 start/step/finish 並提交證據，避免改動 `main` 上其他 Agent 的進度。回退：預設 `NOUS_VCR=off`、停止輸出端播音、保留 HomeBridge 與既有 AIL；設備 profile 可停用，不能因 VCR 失敗阻斷 Nous 語音對話。

## 7. 可直接交給 Claude Code 的任務

> 請先閱讀 `CLAUDE.md`、`AGENTS.md`、`docs/19_Voice_Command_Relay_Design_2026-11.md` 與本計畫，對照最新 `main` 的 AIL-1 與 HomeBridge。從 VCR-0 開始，不重寫 Registry/Dispatcher/HomeBridge。實作 vendor/model/locale/intent 專屬 Command Catalog 的多候選／覆寫／查表，以及每台設備的 TTS Voice Profiles（engine、voiceId、modelVersion、語速、音高、音量、停頓、output node/device、實測分數）。優先完成確定性 resolver、JSON schema 驗證、fixture 與中英雙語文件，再作 Fake Output；後續批次才接 Mac/Pi 實體音訊。對 Spotify 下游用途保留 policy gate，不提供可繞過的 raw_command；TTS 播完只報 unconfirmed。每批附測試、差異檔案、實機未驗證事項與下一個 gate，不合併主線直到審閱。
