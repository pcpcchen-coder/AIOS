<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-processing-cue-2026-11-02.md) | [English](brain-processing-cue-2026-11-02.en.md)

# 電子腦「處理中」與處理中音效驗證

日期：2026-11-02，Asia/Taipei。分支：`claude/brain-processing-cue`（基於 main `6412ea0`）。目的：George 要求背景工作處理中時，電子腦顯示「思考中」的處理樣子（節點亮起），同時播放搜尋音效。

**這不是實機驗收。** 以下測試全部在雲端容器以 fixture（假時鐘、假計時器、假 AudioContext、假選單與假 DOM）執行，**不是 Mac、沒有真的出聲、沒有看過真的畫面**。Electron 選單只測了範本函式，沒有執行。第 8 節的 Mac 步驟都還沒執行。

## 1. George 的決定（2026-11-02）

| # | 決定 | 本批的做法 |
|---|---|---|
| P1 | 任何**真的在執行**的背景任務都有聲音；即時語音的上網查詢還沒回來時也算 | 來源是 `processingSource()`：`status === "running"` 的任務（`task:<id>`）加上進行中的即時語音查詢（`search:<編號>`，每次查詢一個遞增編號，`webSearchFromRealtime` 在 `finally` 或 30 秒後釋放）。排隊（`queued`）與取消中（`cancelling`）不算；和核心斷線時不算任務；通話結束後不算查詢 |
| P2 | 輕柔的聲納聲，最大增益 0.05 | 正弦波 1100→820 Hz、180 ms，260 ms 後 35% 的回聲 880→700 Hz；見第 4 節 |
| P3 | 一段處理開始時響 20 秒；每次有新的步驟開始執行時重新響 6 秒（每 15 秒最多一次）；每個任務最多 60 秒，之後只有畫面 | `CUE_TIMING`（`src/processing-cue.ts`）；見第 5 節 |
| P4 | 即時語音通話中只有畫面，不出聲 | `callOn`（`realtime.on || realtimeStarting`）時暫停 |
| P5 | 選單與設定都有「處理中音效」開關，預設開，存在聲音設定裡 | `audio.json` 的 `processing_cue`（預設 `true`）；選單列「聲音」段的勾選項、頁面設定「聲音」段的開／關按鈕 |
| P6 | Nous 說話時（加 1.5 秒尾巴）、麥克風收音時、視窗看不到時暫停 | 見第 6 節 |
| P7 | 沒有執行中的任務或開關關掉時停止；「收起」不停止 | 來源只看任務狀態，不看畫面；「收起」只關視圖 |
| P8 | 聲音走選定的聲音輸出（`audioDevices.sink`／`release`） | `browserProcessingSound` 開始出聲前先 `output.sink(ctx)`，淡出後 `release`；靜態檢查在 `tests/audio-privacy.test.ts` |
| P9 | 喚醒防護多一個來源 `cue`，每一響期間不接受喚醒詞 | `src/audio/guard.ts` 的 `GuardSource` 加 `cue`；每一響 begin、450 ms 後 end |

## 2. 交付內容

路徑都在 `prototype/ambient-shell/`。

| 檔案 | 內容 |
|---|---|
| `src/processing-cue.ts`（新） | `processingSource()`（任務、查詢編號、連線、通話）、`CUE_TIMING`、`ProcessingCue`（排程：時間窗、重新出聲、每個任務的開始時間窗與上限、暫停、停止；時鐘可注入） |
| `src/processing-sound.ts`（新） | `browserProcessingSound()`：一段處理一個 AudioContext、總音量節點、淡入淡出、聲納音與回聲；AudioContext 沒在執行時不排音（`ping()` 回 `false`）；`PING_SPEC`、`gainToDb()` |
| `src/brain.ts` | `BrainVisualState.processing`；`processingHold()`、`processingEnergy()`、`PROCESSING_TINT`；`cuePing()` 的淡淡波紋 |
| `src/main.ts` | 建立 `processingCue`（注入聲音輸出與喚醒防護）；`syncProcessingCue()` 在 `render()`、念話開始／結束、`visibilitychange` 時呼叫；`firePulses` 的步驟開始呼叫 `rearm()`；即時語音查詢計數；對話閒置時狀態列寫「背景處理中」；`canvas.dataset.processing` |
| `src/audio/guard.ts`、`src/audio/controller.ts` | 防護來源與丟棄原因 `cue` |
| `shared/audio-devices.ts`、`server/audio-settings.ts` | `AudioPrefs.processing_cue`（預設 `true`）、`parseAudioPatch` 只接受布林值；`AUDIO_TEXT.processingCue`／`processingCueNote` |
| `desktop/settings-menu.mjs` | 「聲音」段最後的「處理中音效」勾選項（附說明），點了寫入相反值 |
| `src/views.ts` | 頁面設定「聲音」段的「處理中音效」開／關按鈕（`aria-pressed`、`aria-label`） |
| `shared/messages.en.json` | 新文字的英文 |
| 測試 | `tests/processing-cue.test.ts`（新）、`brain-regions`、`region-activity`、`wake-logic`、`audio-settings`、`desktop-menu`、`settings-view`、`audio-privacy`、`wake-flag-off` |

## 3. 什麼算「處理中」（唯一來源）

| 狀態 | 電子腦「處理中」 | 處理中音效 |
|---|---|---|
| 任務 `running`（含規劃中），而且和核心連著 | 是 | 依第 5、6 節 |
| 和核心的事件串流斷線（畫面上的任務狀態可能已過時） | 任務不算 | 任務不算 |
| 任務 `queued`、`cancelling`、`succeeded`、`failed`、`cancelled` | 否 | 否 |
| 即時語音的上網查詢還沒回來，而且通話還開著 | 是（最多 30 秒；請求一直沒回來時 30 秒後不再算） | 否（通話中只有畫面） |
| 通話結束後才回來的查詢 | 否 | 否 |
| 沒有任何上述來源 | 否 | 否 |

電子腦的樣子只看來源，不看聲音：開關關掉、通話中、說話中都還是會顯示「處理中」。腦區（語言、數理、藝術、聽覺、視覺、規劃）的亮起與光脈衝照舊只來自任務步驟的 `domain` 與對話主題；「處理中」不會自己點亮任何腦區，也不代表模型內部的神經活動。

畫面：

- 青色色調保持在 0.35–0.55 之間緩慢呼吸（0.45 ± 0.1、週期 2 秒；減少動態時固定 0.45）。成功（薄荷綠）或失敗（琥珀）的閃色比它亮時先蓋過，褪到這個水準後回到青色。
- 對話閒置或聆聽時，亮度至少 0.65（和「思考中」相同）。Nous 說話或錯誤時以那兩種樣子為準。
- 每次真的排了提示音（AudioContext 在執行），畫一圈由 1.1 R 擴散到 1.5 R 的淡青色波紋（減少動態時不畫；不在處理中時下一幀清掉）。
- 對話閒置時，狀態列照實寫「背景處理中」。

## 4. 聲音規格

| 項目 | 數值 |
|---|---|
| 主音 | 正弦波，頻率 1100 Hz 指數滑到 820 Hz，180 ms；起音 10 ms（線性到最大增益），之後指數衰減到 0.0001 |
| 回聲 | 主音開始後 260 ms；主音增益的 35%；880 → 700 Hz，180 ms |
| 最大增益 | 0.05（回聲 0.0175） |
| 淡入／淡出 | 開始出聲時總音量 1 秒淡入；暫停或結束時 0.4 秒淡出，淡出後才歸還聲音輸出 |
| 間隔 | 每 2.4 秒一響 |
| AudioContext | 一段處理一個；第一次要出聲時才建立，處理結束或開關關掉時關閉。瀏覽器暫停它時（沒有使用者手勢）不排音、試一次 `resume()`：排在暫停時間軸上的音會在恢復時一起響出來，所以乾脆不排。這一響也不畫波紋、不佔喚醒防護、不扣任務額度 |
| 聲音輸出 | 開始出聲前 `audioDevices.sink(ctx)`（等不到 1 秒就照系統預設出聲）；暫停淡出後 `release`，所以「使用中」只在真的出聲時顯示 |

增益換算成 dBFS（`20·log10(增益)`，計算在 `tests/processing-cue.test.ts`）：

| 聲音 | 增益 | dBFS |
|---|---|---|
| 處理中音效主音 | 0.05 | −26.02 |
| 處理中音效回聲 | 0.0175 | −35.14 |
| 喚醒提示音（比較用，`src/audio/earcon.ts`） | 0.18 | −14.89 |

處理中音效比喚醒提示音小約 11 dB。實際聽起來多大聲取決於 Mac 與喇叭的音量，沒有在 Mac 上量過。

## 5. 次數與時間上限

時間窗以實際時間計算；暫停期間時間照走，不會延後補響。每一響（真的出聲的）替當時每個還有額度的來源記 2.4 秒。暫停後恢復時，離上一響不到 2.4 秒就等滿 2.4 秒再響。

| 規則 | 數值 | 計算出的響數（假時鐘測試） |
|---|---|---|
| 一段處理開始（沒有→有來源） | 20 秒 | 0、2.4、…、19.2 秒：⌊20 ÷ 2.4⌋ + 1 = 9 響 |
| 新的步驟開始執行（`firePulses` 的真實步驟事件） | 6 秒 | 3 響（0、2.4、4.8 秒） |
| 處理中途有另一個任務開始執行 | 這個任務自己的 20 秒開始時間窗（不受 15 秒限制，也不用掉重新出聲的次數） | 9 響；即使原本的任務已用完 60 秒、上一次重新出聲才過 5 秒也一樣 |
| 重新出聲的間隔 | 至少 15 秒 | 15 秒內第二次不延長；落在既有時間窗內、沒有延長的不算一次 |
| 每個任務上限 | 60 秒 | ⌈60 ÷ 2.4⌉ = 25 響，之後只有畫面；新的任務有自己的額度 |
| 即時語音查詢 | 不給時間窗 | 只會在通話中出現，通話中不出聲 |

## 6. 暫停與停止

| 情況 | 處理中音效 | 電子腦「處理中」 |
|---|---|---|
| Nous 說話（`speakText`、語音模式回覆播放、對話「說話中」） | 暫停；說完後再等 1.5 秒（同喚醒防護 `SPEECH_TAIL_MS`） | 說話的樣子優先 |
| 麥克風收音（按下說話、語音模式、即時語音） | 暫停 | 照舊 |
| 即時語音通話中（含連線中） | 不出聲 | 照舊 |
| 主視窗看不到（`visibilityState === "hidden"`） | 暫停 | 照舊 |
| 時間窗用完或任務額度用完 | 停在只有畫面 | 照舊 |
| 「處理中音效」關掉 | 停止（AudioContext 關閉） | 照舊 |
| 沒有執行中的來源 | 停止（AudioContext 關閉、喚醒防護立即結束） | 結束 |
| 和核心斷線 | 任務不算；只剩任務時停止 | 只剩任務時結束 |
| AudioContext 被瀏覽器暫停 | 不排音（不會累積到恢復時一起響） | 照舊 |
| 「收起」 | 不影響 | 不影響（收起不取消任務） |

暫停原因消失時，如果還在時間窗內，重新淡入；離上一響已滿 2.4 秒就馬上響，否則等到滿 2.4 秒。常駐喚醒聆聽在背景一直開著，不算「收音」；改由喚醒防護 `cue` 保護：每一響開始時 `begin("cue")`，450 ms 後（主音加回聲 440 ms）`end("cue")`，期間偵測到的喚醒詞丟掉。

## 7. 測試結果（雲端容器，fixture）

| 指令 | 結果 |
|---|---|
| `npm run typecheck` | 通過 |
| `npx vitest run` | 120 個測試檔通過；2257 個測試通過、5 個略過（共 2262；審查修正後重跑） |
| `npm run build` | 通過（只有既有的 chunk 大小警告） |
| `node scripts/check-bilingual-docs.mjs`、`node scripts/verify-aios.mjs`、`git diff --check` | 見交付報告 |

新增或改動的測試：

- `tests/processing-cue.test.ts`：來源只算 `running` 與進行中查詢、查詢用遞增編號、斷線不算任務、通話結束不算查詢、查詢 30 秒上限；20 秒 9 響；6 秒 3 響與 15 秒限制；新任務有自己的 20 秒（含另一個任務已達上限、在 15 秒間隔內開始）；每個任務 25 響上限；暫停後恢復不連響；AudioContext 暫停時不畫波紋、不佔防護、不扣額度；沒有來源時停止並重新開始；開關關掉；通話、收音、視窗隱藏暫停；說話加 1.5 秒尾巴；喚醒防護 450 ms；假 AudioContext 驗證先 sink 再排音、頻率與增益、淡入淡出、release 與 close、sink 不回應時 1 秒後照出聲、暫停（suspended）時不排音並只試一次 resume、沒有 WebAudio 時不出錯；增益換算 dBFS。
- `tests/brain-regions.test.ts`：呼吸範圍與減少動態、說話／錯誤優先、成功閃色褪回青色、沒有處理時青色照常褪掉、波紋只在處理中保留（第一響發生在 `setState({ processing: true })` 之前也保留）、減少動態時不畫。
- `tests/region-activity.test.ts`：處理中與腦區焦點用同一個真實來源，處理中不自己點亮腦區。
- `tests/wake-logic.test.ts`：防護來源 `cue`。
- `tests/audio-settings.test.ts`：`processing_cue` 只接受布林值、預設開、保存與重新啟動、HTTP 路由；`audio.json` 裡壞掉的 `processing_cue` 只讓這一個鍵回到預設（開），其他裝置選擇照用（`PrefsFile` 每個鍵分開驗證）。
- `tests/desktop-menu.test.ts`、`tests/settings-view.test.ts`：選單勾選項與頁面按鈕、寫入相反值、英文（含按鈕的無障礙標籤 `Processing sound: On`）。
- `tests/audio-privacy.test.ts`：會出聲的地方多了 `processing-sound.ts` 一行，而且先 sink 再排音、注入的是 `audioDevices`。
- `tests/wake-flag-off.test.ts`：`settings.audio` 多了 `processing_cue: true`（旗標關閉時其餘仍逐位元組相同）。

## 8. Mac 步驟（尚未執行）

1. 打開 App，交辦一個會跑超過 30 秒的任務，收起畫面。確認電子腦呈現青色呼吸、對話閒置時狀態列寫「背景處理中」；前 20 秒約每 2.4 秒一聲輕柔的聲納聲，之後只剩畫面。
2. 任務進入下一個步驟時，確認再響約 6 秒（3 聲）；15 秒內再換步驟不再響。
3. 讓 Nous 念出一段話，確認念話期間與之後 1.5 秒沒有聲納聲。按下說話時也沒有。
4. 開即時語音並交辦任務或讓它上網查詢：確認只有畫面、沒有聲納聲。
5. 把視窗藏起來（例如切到別的 App 全螢幕），確認不響；回來後若還在時間窗內恢復。
6. 在選單列「鏡頭與語音設定 → 聲音」取消勾選「處理中音效」：確認馬上不響、畫面照舊；頁面設定的按鈕同步顯示「關」。重新勾選。
7. 把「聲音輸出」選成藍牙喇叭，確認聲納聲從藍牙喇叭出來，響的期間狀態列「使用中」顯示那支喇叭，停下約 0.5 秒後恢復成「播放時使用」。
8. 開著常駐喚醒聆聽時讓聲納聲響：確認不會自我觸發。
9. 確認背景視窗或沒有使用者手勢時 Electron 的 AudioContext 能出聲（可能被瀏覽器暫停）。
10. 主觀確認 0.05（約 −26 dBFS）在家裡的音量下是否夠輕、聽得到。

## 9. 與規劃的差異

| 規劃 | 本批 | 原因 |
|---|---|---|
| 聲音放在 `src/audio/processing-cue.ts` | 放在 `src/processing-sound.ts`（排程在 `src/processing-cue.ts`） | `src/audio/` 只有 `NOUS_WAKE=on` 時才動態載入（`tests/audio-privacy.test.ts` 檢查）；處理中音效不綁旗標 |
| 青色「≥ 0.35，呼吸 ± 0.1」 | 0.45 ± 0.1（0.35–0.55），減少動態固定 0.45 | 讓最低點剛好是 0.35 |
| 一段處理一個 AudioContext 並 sink | 一段處理一個 AudioContext，但只在真的出聲時 sink，暫停淡出後 release | 「使用中」只在真的出聲時顯示（裝置狀態以事件為準） |
| 新步驟重新出聲 | 處理中途有另一個任務開始執行時，給它自己的 20 秒開始時間窗（不受 15 秒限制） | 規劃沒有說明中途加入的任務；審查認為不同的任務應該有自己的開始時間窗。每個任務 60 秒上限照算 |
| 查詢在進行中就算 | 只在通話還開著時算，最多 30 秒；斷線時不算任務 | 審查：通話結束後才回來的查詢、或斷線時過時的任務狀態不能驅動動畫或聲音 |

## 10. 未完成與限制

- 沒有在 Mac 上聽過、看過；音量、AudioContext 自動播放限制、藍牙延遲都待第 8 節。
- 時間窗以實際時間計算：如果一段處理開始時 Nous 正在說話，那 20 秒可能都不響。
- 瀏覽器暫停 AudioContext（沒有使用者手勢）時不會出聲，只有畫面；第一次使用者操作之後才可能出聲，要在 Mac 上確認。
- 「Nous 說話」只包含本機語音合成、語音模式的回覆播放與對話「說話中」；其他 App 的聲音不算。
- 常駐喚醒聆聽開著時不暫停（它一直在聽），只靠喚醒防護丟掉期間的偵測。
