<!-- bilingual: source=zh-TW -->

> [繁體中文](VOICE_COMMAND_RELAY_TEST_PLAN.md) | [English](VOICE_COMMAND_RELAY_TEST_PLAN.en.md)

# VCR 語音中繼：跨品牌命令模板 × TTS 音色實測表

日期：規劃於 2026-11-07～08；狀態：**全部 NOT TESTED，尚無任何辨識率數據**。規格見 [19 設計](../19_Voice_Command_Relay_Design_2026-11.md) 與 [開發計畫](../development/voice-command-relay-implementation-plan.md)。初始可用設備：使用者家中的 Google Home Mini；**HomePod/Siri、Echo/Alexa、小愛同學均為未驗證候選**。Spotify 語音中繼是否符合適用平台使用條款尚待確認；不得將它視為已放行的產品功能。

## A. 前置檢查

- 確認使用的智能音箱語言、韌體、Voice Assistant 型別與可用的媒體服務。先由真人親口說相同命令以建立**裝置功能基準**；真人也失敗的指令不可當成 TTS 識別率測試。
- 準備 Mac 或 Raspberry Pi 4 的**明確指定** TTS 喇叭，選擇無障礙的近距離位置；每次測試記錄距離、輸出音量和背景噪音。
- macOS 可先用系統 `say` 測試聲線（選已安裝的 voice）；`say` 的音量／輸出裝置控制需另外核對，**不能**因選了聲線就假設能選硬體聲卡。
- 首輪**不要**使用付費、門鎖、警報、密碼、購物、個人化訊息、Voicematch 模仿或其他無法安全重複的命令。只使用測試者已經取得用途許可的低風險命令。
- 不收集錄音、其他人的語音樣本、家人帳號或個人歌單。寫入 repo 的測試記錄只保留去識別量測。

## B. 品牌與命令交叉檢查（待填）

| Target / Vendor | Assistant locale | Intent | Template ID | Wake phrase tested? | Human baseline | TTS outcome |
|---|---|---|---|---|---|---|
| Google Home Mini / Google | zh-TW | `music.next` | `google.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| Google Home Mini / Google | zh-TW | `music.pause` | `google.pause.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| HomePod / Apple | zh-TW | `music.next` | `apple.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| Echo / Amazon | en-US | `music.next` | `amazon.next.en1` | NOT TESTED | NOT TESTED | NOT TESTED |
| XiaoAI / Xiaomi | zh-CN | `music.next` | `xiaomi.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |

新增候選命令須建立新的 `templateId` 與版本，不覆寫已測結果；同一 intent 測試品牌 A、B 時，slot 定義保持一致。

## C. 音色與參數 A/B 矩陣（待填）

| Trial | Target | TTS engine | Voice ID / model version | Rate | Pitch | Gain | Wake pause | Distance | Trials | Wake OK | Command OK |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Google Mini | `macos_say` | 待選 | baseline | baseline | baseline | 600 ms | 待量 | 0 | 0 | 0 |
| B | Google Mini | `macos_say` | 另一音色 | baseline | baseline | baseline | 600 ms | 同 A | 0 | 0 | 0 |
| C | Google Mini | `macos_say` | A 的音色 | baseline | baseline | baseline | 1000 ms | 同 A | 0 | 0 | 0 |
| D | Alexa（未持有） | 待選 | 待選 | baseline | baseline | baseline | 待測 | 待量 | 0 | 0 | 0 |

每一個組合先執行 **10 次**試驗；要挑選正式預設聲線，建議候選各增加到 **30 次以上**並跨安靜／有背景噪音兩組測試。這是專案建議的實驗設計，不是統計顯著或廠商保證。改變 voiceId 時應固定命令、輸出距離、音量、語速與間隔；比較 pause 時固定 voiceId。

### 量測公式

```text
wakeRate       = wakeDetected / trials
commandRate    = correctCommand / wakeDetected    # when wakeDetected = 0 -> N/A
endToEndRate   = correctCommand / trials
falseWakeRate  = falseWake / negativeTrials        # when negativeTrials = 0 -> N/A
```

`correctCommand` 必須是人類可觀察、非僅由 Nous 聲稱的結果。每次標記 `WAKE_OK`、`COMMAND_OK`、`WRONG_COMMAND`、`NO_WAKE`、`UNKNOWN`；同一筆試驗的 `commandOK` 不能超過 `wakeOK`。把分母、原始次數與來源記清楚，不只有百分比。

## D. 真實執行／失敗案例

- [ ] 由真人命令測試實體音箱；記錄基準成功／失敗。
- [ ] TTS A：測喚醒詞 10 次；聲線、發聲間距、語速固定。
- [ ] TTS B：相同條件測喚醒詞 10 次，與 A 比較。
- [ ] TTS A／B：再測固定命令，例如由不涉及第三方受限用途的低風險燈光／計時控制。
- [ ] 分開改 `wakeToCommandPauseMs`，驗證較長停頓是否改善完整辨識率。
- [ ] 用「設備明確未設定」「voiceId 缺失」「錯誤 locale」「端點離線」測 fail-closed，不得播到其他音箱。
- [ ] 在 Nous 即時語音開著時測回音抑制；不因播放命令而回頭觸發 Nous 自己。
- [ ] 在 Pi 4 開始及結束音訊時，Mac 的 `jobId` 回報對上；中途斷線回 `unknown` 且不自動重試。
- [ ] 改設備 profile 的 selectedTemplateId、selectedVoiceProfileId，驗證**只改資料、不改程式**即可切換命令語法與聲線。
- [ ] 不論 TTS 播出成功幾次，沒有獨立下游狀態讀取時，AIL ToolResult 一律 `unconfirmed` 而非 `confirmed`。

## E. 失敗紀錄與交接

| Issue ID | Target / voice / template | Steps | Expected | Actual | Evidence | Priority |
|---|---|---|---|---|---|---|
| 待填 | | | | | | |

| Gate | Status |
|---|---|
| Catalog 與 Voice Profile 的 fake tests | NOT TESTED |
| Mac 已選音色的實體播音 | NOT TESTED |
| Google Home Mini 的 wake + command | NOT TESTED |
| Pi 4 遠端播音與回執 | NOT TESTED |
| 多品牌 template lookup fixtures | NOT TESTED |
| 選定預設聲線的人工決策 | PENDING |

**驗收建議**：同一個已核准的低風險意圖，至少兩種 TTS 音色各做 10 次測試；能依 target 切換正確命令包，音色與輸出端選擇真實生效；沒有偽成功與自動重試；測試數據可從原始筆數重算。先做可行性，不要把 9/10 當作已經驗證的服務水準。

**Rollback**：停用 VCR／恢復設備原音色設定、停止喇叭音訊，保留 Nous 核心與 HomeBridge 原行為。除明確需要的去識別測試記錄外，勿保存其他語音內容或個資。
