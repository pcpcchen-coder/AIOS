<!-- bilingual: source=zh-TW -->

> [繁體中文](19_Voice_Command_Relay_Design_2026-11.md) | [English](19_Voice_Command_Relay_Design_2026-11.en.md)

# 19｜Nous Voice Command Relay（VCR）：跨品牌 TTS 語音命令中繼

日期：2026-11-03（Asia/Taipei）。狀態：**設計提案，尚未實作、尚未實機驗證**。施工見 [VCR 實作與驗收計畫](development/voice-command-relay-implementation-plan.md)；週末量測見 [VCR 實測表](experiments/VOICE_COMMAND_RELAY_TEST_PLAN.md)。本文件是開發規格，不宣稱 Google Home Mini、Siri／HomePod、Amazon Alexa 或小愛同學已能辨識 Nous 的合成語音。

## 1. 決策與範圍

**將可聽見的 TTS 視為一種「輸出到第三方語音設備」的實驗性 transport。** Nous 認出意圖（intent），依目標設備的廠牌／型號／語言查找命令模板，依設備的「TTS 聲音設定檔」選引擎、音色、語速、音量與喚醒詞停頓，在指定實體喇叭播出，讓附近的智慧音箱收音。它是**單向驅動器**：播音成功 ≠ 音箱辨識成功 ≠ 後端服務執行成功。

**兩張表必須彼此獨立：**
1. `Command Catalog`：同一意圖在 Google、Siri、Alexa、小愛同學的**不同命令語法**，含覆寫優先順序及模板版本。
2. `TTS Voice Profiles`：同一設備可配置、切換或 A/B 比較**不同 TTS 引擎、音色與 prosody**；最佳組合只以實機測量決定，不預設哪個聲線較好。

首批只做 read-only 的模板預覽、手動測試與低風險播放／燈光指令；不提供任意字串變成語音命令、不控制付款、門鎖、保全、購物、帳戶操作或永久刪除。可能需要個人聲紋（Voice Match / personal requests）的指令不得透過模仿真人聲線繞過；不使用聲音複製或冒用家人身分。**把 Spotify 語音控制間接交由第三方音箱，不會自動免除 Spotify 平台政策的限制；初版對 Spotify 下游用途設定 blocked，直到釐清適用授權。**

## 2. 與目前 AIOS 實作對接

截至本次查核，`main` 已存在 `prototype/ambient-shell/server/integrations/{registry,dispatcher,policy,contracts,index}.ts`、`shared/integrations.ts` 與 API key／ChatGPT live 兩條即時語音工具接線；`server/home-bridge.ts` 是現有 SmartHomeAI 家電橋接。**VCR 是新的 Adapter，不要新建第二套 Registry/Dispatcher，也不要重寫 HomeBridge。**

```text
User voice/typed -> Nous intent -> AIL Tool Registry / Dispatcher
                                  |
                    VoiceRelayAdapter (app.voice_relay.*)
                                  |
                   Target Registry -> Command Resolver
                                      |          |
                                Brand Catalog  Device Overrides
                                      |
                          TTS Profile Resolver / Engine
                                      |
                       Output Node (Mac or Pi 4) speaker
                                      | acoustic wave
                                      v
               Google Home | Apple HomePod | Amazon Echo | XiaoAI
                                      |
                           3rd-party service/device
```

`app.voice_relay.send_intent` 透過 AIL 既有的 `supportedRoutes` 首批只開 `api_key`／`live`；普通文字聊天、背景任務需另做路徑接入才能對外宣稱支援。初版 `NOUS_VCR=off`，未設定 speaker output 不得呈現為可執行。UI 僅提供按需測試與設定，不建立 App launcher、固定 Dashboard 或獨立聊天頁。

## 3. 設備目錄（Target Registry）

每個**實際設備**有自己的 profile，不只靠品牌推論：

| 欄位 | 例子 | 規則 |
|---|---|---|
| `targetId` | `living_google_mini` | 本地唯一且不可由模型注入新 ID |
| `vendor` | `google` / `apple` / `amazon` / `xiaomi` | 受控枚舉；可新增經審核的廠牌 |
| `model` | `home_mini` / `homepod_mini` / `echo_dot` / `xiaoai_speaker` | 找模板優先序使用 |
| `assistant` | `google_assistant` / `siri` / `alexa` / `xiaoai` | 同品牌有不同助理／版本時可分開 |
| `locale` | `zh-TW` / `en-US` / `zh-CN` | **以裝置實際設定語言**為準，和 Nous UI 語言獨立 |
| `outputNode` | `mac_local` / `pi_living` | 哪一台機器**實際放出 TTS 聲音** |
| `outputDeviceId` | OS audio device identifier | 綁定實體輸出，不能拿「預設音效卡」冒充已確認設備 |
| `commandPack` | `google.home_mini.zh-TW.v1` | 已審核的命令模板包 ID／版本 |
| `ttsProfileId` | `google_zh_voice_a` | 目前選擇的音色與 TTS 參數 |
| `enabled` / `policy` | `false` / `experimental` | 裝置開關、下游用途限制與安全設定 |

啟用前必須有：音箱設備設定、可用的播音端、至少一組已測模板與 TTS profile。缺少任何一項，回 `unavailable` 或 `refused`，而非播放到任意預設喇叭。未來新增設備只需註冊 target + pack + TTS profile，不應修改模型 prompt。

## 4. **品牌差異化建表／查表（必做）**

### 4.1 共通語意 Intent Registry

| Intent ID | 已驗證的參數類型 | 第一版範圍 |
|---|---|---|
| `music.next`、`music.pause`、`music.resume` | 無 | 基本媒體控制 |
| `music.play_genre` | `genre`（受控分類） | 指定類型的曲風 |
| `music.play_artist` | `artist`（本地明確核准名稱） | 下游服務政策允許時才開 |
| `light.power` | `device`（已登記實體設備）、`on`（布林） | 已配對的低風險燈具 |
| `light.brightness` | `device`、`percent`（0–100） | 設備支援時才開 |
| `assistant.timer` | `seconds`（預設 1–3600，整數） | 先驗證是否支援；不宣稱跨品牌一致 |

**禁止**一個 `raw_command` 自由輸入欄位直接由模型 TTS 輸出；不允許由使用者句子直接抽取未受控服務名稱／家電名稱。需要新命令時，先進測試模式加入 Command Catalog，再放行。

### 4.2 命令模板表與欄位

`catalogId`, `vendor`, `assistant`, `modelMatch`, `locale`, `intent`, `templateId`, `version`, `wakePhrase`, `utteranceTemplate`, `ttsProfileHint`, `slotSchema`, `supported`, `riskClass`, `downstreamService`, `policy`, `source`, `testedOn`, `testResult`。

- 同一個 `(vendor, assistant, model, locale, intent)` **可有多個候選模板**，但只能有一個 `selectedTemplateId`；候選不得隨機被模型選取。
- 正式執行的 Resolution 優先序：**目標裝置顯式覆寫 → 型號＋語系 → 助理＋語系 → 廠牌＋語系 → 明確宣告相容的 generic**。沒有經審核的命中就 `unsupported`，**不可**硬猜近似品牌或改英文。
- 每次查表回傳 `{targetId, intent, templateId, catalogVersion, voiceProfileId, source, testStatus}` 供追蹤；必要時對應建立發聲工作，但不把私人參數存入 trace。
- 模板與變數要嚴格限制：變數僅使用 allowlist 的設備／藝人／曲風顯示名；禁止 SSML 任意插入、控制字元、喚醒詞、換行及新命令連接。音量、百分比、秒數須做範圍驗證；模板不能由 LLM 直接修改。
- 文字儲存與語音合成可做實測中英不同用字，但不要假設系統 locale 決定助手實際支援語言。
- 對未取得權利的下游服務採 Policy Gate **依用途**判斷，不能只看工具名稱 `app.voice_relay.*` 就繞開 `app.spotify.*` 限制。

### 4.3 概念命令表（**待各平台實測**，不是官方相容保證）

| Intent | Google Home `zh-TW` | Siri/HomePod `zh-TW` | Alexa `en-US` | 小愛 `zh-CN` |
|---|---|---|---|---|
| `music.next` | `下一首歌` | `下一首` | `next track` | `下一首` |
| `music.pause` | `暫停音樂` | `暫停播放` | `pause music` | `暂停播放` |
| `music.resume` | `繼續播放` | `繼續播放` | `resume music` | `继续播放` |
| `light.power:on` | `打開{device}` | `打開{device}` | `turn on {device}` | `打开{device}` |
| `music.play_genre` | `播放{genre}音樂` | `播放{genre}音樂` | `play {genre} music` | `播放{genre}音乐` |
| 喚醒詞候選 | `Ok Google` / `Hey Google` | `嘿 Siri` / `Siri`（依系統設定） | `Alexa`（可能自訂） | `小愛同學` |

以上只作為**fixture 與測試候選**；每個裝置、語言、韌體、助理模式、播放服務與個人化設定都需各自測試。「播放 Spotify」不得因存在模板就解鎖政策；`supported=false`、`policy=blocked` 優先於命令字串。

### 4.4 範例（概念 JSON，正式型別由 Claude 驗證）

```json
{
  "version": 1,
  "targets": [
    {
      "id": "living_google_mini",
      "vendor": "google",
      "assistant": "google_assistant",
      "model": "home_mini",
      "locale": "zh-TW",
      "outputNode": "pi_living",
      "outputDeviceId": "usb_speaker_1",
      "ttsProfileId": "google_zh_a",
      "enabled": false
    }
  ],
  "commandPacks": [
    {
      "id": "google.home_mini.zh-TW.v1",
      "vendor": "google",
      "assistant": "google_assistant",
      "modelMatch": "home_mini",
      "locale": "zh-TW",
      "entries": [
        {
          "intent": "music.next",
          "templateId": "music.next.zh.tw.1",
          "wakePhrase": "Ok Google",
          "utteranceTemplate": "下一首歌",
          "supported": "candidate",
          "policy": "review_required",
          "downstreamService": "configured_music_service"
        }
      ]
    }
  ],
  "deviceOverrides": {
    "living_google_mini": {
      "music.next": "music.next.zh.tw.1"
    }
  }
}
```

**範例不代表已放行**：`candidate` 和 `review_required` 無法在產品路徑執行。實作時由核心驗證文件版本、欄位、唯一性、模板參數、來源及 policy；將合法測試候選與已放行命令分開，管理版不得讓 LLM 自行切換狀態。

## 5. **TTS 模型／音色查表、切換與比較（必做）**

TTS 不能是全域單一 voice。每台設備選自己的**音色設定檔**，同廠牌不同型號可以不同，設備可擁有多個候選及選定檔。TTS Engine 不是指令解析模型；兩者解耦。

| TTS Voice Profile 欄位 | 意義 |
|---|---|
| `id` | 例如 `google_zh_a`、`alexa_en_b` |
| `engine` | `macos_say`、`browser_speech`、`local_tts`、未來允許的 API provider |
| `voiceId`、`modelId`、`modelVersion` | 具體 TTS 聲音、模型與版本，不用模糊的「女聲」代稱 |
| `locale` | 必須與命令輸出語言相容；缺 voice 不自動改成別的語言 |
| `rate`、`pitch`、`gainDb` | 語速／音高／音量；供逐檔調校並限制範圍 |
| `wakeToCommandPauseMs` | 喚醒詞與命令間的停頓，例如先試 600–1000 ms；不是保證值 |
| `leadSilenceMs`、`tailSilenceMs` | 前後靜音時間；避免裁切喚醒詞 |
| `outputSampleRateHz`、`format` | 播放端相容的格式／採樣率；不能讓音訊速度意外改變 |
| `outputNode`、`outputDeviceId` | 最終播放節點／實體聲卡，記錄實際使用的裝置 |
| `testedAt`、`recognitionStatsId` | 最近一次音色實測結果；**未測試即標未測試** |

查表順序：**設備指定 profile → 已審核的 `(vendor, assistant, model, locale)` 預設 profile → 須明確允許的相容 fallback**。若聲音不見、端點離線、輸出被其他 App 佔用，fail closed，回報無法輸出；不得悄悄改用 Mac 預設喇叭而誤喚醒其他音箱。

**音色評分不可主觀猜測**。建立 A/B Test Matrix（不同 TTS engine × voice × rate × pause × distance/volume/noise）。分別計算：
- `wakeRate = wakeDetected / trials`（實際觀察喚醒，不以 TTS 完成代替）。
- `commandRate = correctCommand / wakeDetected`（無喚醒時分母為 0，記 `N/A`）。
- `endToEndRate = correctCommand / trials`，才是最終可用性。
- `falseTriggerRate` 使用明確定義的無意圖／負樣本測試，不根據播放成功率推算。
- 記錄型號、韌體、音箱語系、TTS 引擎／版本、音色 ID、輸出路徑、距離、音量、雜音、日期與證據型別（目視／人工確認／設備狀態 API）。**不可把 LLM 自己聽到的回覆當作設備成功證據**。

第一版由使用者在測試頁選擇「測試候選音色」、點選實際執行並填 PASS／FAIL／NOT TESTED；累積證據後**由使用者手動選定**。後續若要自動選勝者，需先定義最少樣本數、置信區間與不利副作用限制；不能用少量成功案例自動替換。

## 6. TTS 播音所有權、回音與多節點

- Pi 4 是「實體音訊前端」，Mac mini 是 Nous Core。雲端合成／本地合成可以在不同節點執行，但**實際播音端必須有明確的 session/ack**。不要假設 Mac `say` 能直接播到 Pi 的喇叭。
- 最小版可先用 **Mac 本機輸出做人工觸發測試**。Pi 版使用既有 SSH 安全通路或已授權的音訊前端訊息，讓 Pi renderer / worker 把指定 TTS 音訊播放到所選裝置。新協定需定義 `jobId`、`targetId`、`outputNode`、`audioStarted`、`audioFinished`、`audioFailed`、逾時與取消；僅 `audioFinished` 代表**聲音播完**。
- 外部音箱可能聽見 Nous 原本的語音回答而誤觸。當 VCR 發聲，**暫停／抑制 Nous 自己的喚醒偵測與 ASR 接收中繼音訊**，保留原有使用者中斷／停止語音的既有行為，避免把下游助理的語音回答再次交給 Nous。
- 同一空間的 relay 一次只播一條指令。喚醒詞與命令可拆兩段 TTS 以取得確定的停頓；避免背景重試把相同命令重送兩次。**有副作用的未知結果一律禁止自動重試**。
- 回答不應與播放命令同時經同一個音箱輸出。首次測試應由**人手選定**實體 TTS 喇叭與 Google Home 間距，並記錄因共鳴、回授、語音打斷造成的問題。

## 7. 執行狀態與政策門檻

**不可把 `audioFinished` 映射成 AIL `confirmed`**。VCR 應在 AIL `ToolResult` 中使用：
- `refused`：命令不在表內、廠牌不支援、無可用聲音／設備、policy blocked、未得到必要確認（尚未播音）。
- `failed`：確定未能播放，且沒有輸出完整命令（例如音檔合成失敗、播放在開始前失敗）。
- `unknown`：中途斷線／逾時，無法確知是否已播完或下游是否執行。
- `unconfirmed`：已觀察到指定端點**完整播完語音**，但沒有下游執行回執；對使用者說「已發出語音命令，是否執行尚未確認」。
- 只有在**獨立、可信的設備狀態讀回**證明目標動作完成時才可 `confirmed`；VCR v1 不提供這種確認。
- AIL effect 為 `reversible_write` 的控制仍有真實副作用，需保留 `requestId` 去重；高風險意圖不得通過 VCR 第一版。

Spotify Developer Policy 的第三方語音控制禁令由**下游服務用途**套用，不因 VCR 工具名稱不是 `app.spotify.*` 就忽略。Apple、Amazon、小米、Google 也各有音箱、個人化與使用條款；本設計只描述技術實驗，不保證公開部署合規。

## 8. 官方參考與更新要求

實作前逐廠商確認語音命令、支援地區、助理世代與條款；文件候選命令不得直接當成已測成功：
- [Google Home 官方語音裝置控制](https://support.google.com/googlehome/answer/7207759?hl=zh-Hant) 與 [音樂](https://support.google.com/googlehome/answer/7030379?hl=zh-Hant)。
- [Apple HomePod Siri 音訊控制（台灣）](https://support.apple.com/zh-tw/guide/homepod/apd414437fc9/homepod)。
- [Amazon Alexa Help](https://www.amazon.com/gp/help/customer/display.html?nodeId=202199210)（型號、語區逐項核對）。
- [小愛開放平台](https://developers.xiaoai.mi.com/)（硬體、語言、地區逐項核對）。
- [Spotify Developer Policy](https://developer.spotify.com/policy)，尤其 III.3 voice-enabled control。

VCR 定位是 AIL 的**可選 transport**；只要將命令表／TTS 聲音設定分開建模，未來新增品牌或提高特定音色辨識率，皆不須改 Nous 的意圖模型或工具名稱。
