<!-- bilingual: source=zh-TW -->

> [繁體中文](audio-devices-2026-11-01.md) | [English](audio-devices-2026-11-01.en.md)

# 聲音輸入／輸出裝置選擇驗證

日期：2026-11-01，Asia/Taipei。分支：`claude/audio-devices`（基於 main `58af745`）。目的：讓 George 從選單列與頁面設定選 Nous 用哪支麥克風、從哪個喇叭出聲，例如接藍牙喇叭。

**這不是實機驗收。** 以下測試全部在雲端容器以 fixture（假 MediaDevices、有 `setSinkId` 的假播放元素、假時鐘）執行，**不是 Mac、不是真的麥克風、不是藍牙喇叭**。Electron 選單只以純函式測試範本，沒有執行。Mac 步驟見第 7 節，尚未執行。

## 1. George 的決定（2026-11-01）

| # | 決定 | 本批的做法 |
|---|---|---|
| 1 | 系統朗讀（語音模式的 `speakText`、SP-03a 校準的陌生聲音）留在 macOS 系統輸出；按下說話與語音模式的 Web Speech 辨識留在系統輸入；兩個介面都要提示 | 瀏覽器不讓 `speechSynthesis` 與 Web Speech 選裝置，所以不改。選單列兩個子選單底部與頁面設定的「聲音」段都寫「按下說話與系統朗讀（語音模式、校準陌生聲音）一律用 Mac 的系統輸入／輸出」 |
| 2 | 選定的麥克風不在（喚醒開始或自動恢復、通話、家人聲音登記）時改用系統預設麥克風，字幕與狀態照實說；它回來時換回去（喚醒在閒置時重開） | `openMic`：exact deviceId → 同名裝置 → 系統預設（`fallback`）。字幕與狀態「找不到「X」，暫用系統預設」（同一個選擇只說一次）。`devicechange` 看到它回來時發 `input_returned`，常駐聆聽在閒置時重開。這刻意改掉 `src/audio/front-end.ts` 原本「不改用其他麥克風」的規則；註解、[WK-01a 驗證](wk-01a-2026-10-31.md) 第 3 節第 5 點與 [ADR-0003](../adr/ADR-0003-local-wake-and-voice-recognition.md) 的「失敗」列已同步修訂 |
| 3 | 通話中換麥克風從下一通起生效（字幕「下一通起使用」）；換喇叭立即生效 | 通話中改「聲音輸入」：頁面字幕「下一通起使用「X」」，常駐聆聽等最後一份租用歸還才換來源。改「聲音輸出」：`audioDevices` 立刻對正在播的 `<audio>` 元素與提示音的 `AudioContext` 呼叫 `setSinkId` |

## 2. 交付內容

路徑都在 `prototype/ambient-shell/`。

| 檔案 | 內容 |
|---|---|
| `shared/audio-devices.ts`（新） | `AudioPrefs`、`parseAudioPatch`（四個鍵；deviceId 為可見 ASCII 最多 256 字，名稱最多 128 字、不收控制字元）、`DEVICE_ID`（由 `shared/wake.ts` 移來）、頁面回報的整理規則 `sanitizeAudioMenuReport`（每種最多 24 個裝置、狀態句白名單）、兩個介面共用的狀態句 `inputStatus`／`outputStatus` 與文字 |
| `server/audio-settings.ts`（新） | `AudioSettingsStore`：`configDir/audio.json`（`PrefsFile`，0600，原子寫入）。`null`＝系統預設；讀不懂時全部 `null`。不綁任何旗標。`wake.json` 舊的 `device_id` **不搬過來**：WK-01a 打開時一律開系統預設，那個值只是當時的預設麥克風，搬過來會把所有路徑釘在那一支 |
| `server/app.ts`、`server/nous.ts`、`shared/types.ts` | `GET /api/settings` 加 `audio: { prefs, write_path: "/api/settings/audio" }`；`POST /api/settings/audio` 驗證後保存，經 `onChange` 廣播 `settings.updated` |
| `src/audio-devices.ts`（新） | renderer 內唯一呼叫 `getUserMedia({ audio })` 的地方（`openMic`），也是唯一呼叫 `setSinkId` 的地方（`applySink`）。`AudioDevices`：偏好、`enumerateDevices`＋`devicechange` 清單、開著的 track 與播放元素；「使用中」只來自 `track.getSettings().deviceId` 與元素的 `sinkId`。偏好是系統預設時約束和以前完全相同，也不呼叫 `setSinkId` |
| `src/audio/front-end.ts`、`controller.ts`、`earcon.ts`、`index.ts` | 常駐聆聽不再直接開麥克風，改用 `main.ts` 注入的 `MicOpener`（`src/audio/` 只有 `NOUS_WAKE=on` 才載入，仍不 import 新檔案）。`reopen()`：閒置時重開、通話中等最後一份租用歸還。選了特定麥克風而 track 結束時重開一次（找不到就用系統預設）；系統預設的麥克風結束時照舊 `error device_ended`。提示音經注入的 `output.sink(ctx)`：導好（最多等 1 秒）才排音，排音之後才開始計時，兩個音播完才關掉 `AudioContext`，藍牙喇叭較慢也不會被截掉；取消隨時有效。不再保存 `device_id`（`saveDeviceId` 移除） |
| `src/realtime.ts`、`src/main.ts`、`src/speaker/recorder.ts` | 即時語音兩條路徑、家人聲音登記的麥克風都經 `audioDevices.openInput()`；遠端聲音的 `<audio>` 經 `audioDevices.sink()`；登記的「現在開始」提示音另開一個短暫的 `AudioContext` 導到輸出、播完就歸還（擷取用的 `AudioContext` 不登記成輸出）。字幕：找不到麥克風、喇叭「「X」已中斷，改由系統預設播放」、「已改回「X」播放」、「下一通起使用」。授權前選的裝置沒有名稱時，清單有名稱後補上（patch 同時帶 deviceId；成功才算完成，失敗 30 秒後再試）。麥克風 track 停止時「使用中」立即更新 |
| `src/views.ts` | 設定畫面（瀏覽器版與 App 內的帳號頁都有）的「聲音」段：兩個下拉選單（第一項「系統預設（目前：X）」）、使用中的裝置、兩句提示；授權前「授權麥克風後才會列出裝置名稱」 |
| `desktop/settings-menu.mjs`、`desktop/main.mjs`、`desktop/preload.cjs` | 選單列「鏡頭與語音設定」加「聲音」段：「聲音輸入：…」「聲音輸出：…」兩個 radio 子選單（系統預設在最前，再列裝置，最後兩句提示），各接一列停用的狀態（「使用中：X」或「找不到「X」，暫用系統預設」）。preload 只轉整理過的清單（每種 ≤24、id 可見 ASCII ≤256、名稱 ≤128、狀態句白名單），`main.mjs` 再整理一次；點選 POST 到 `write_path` |
| `src/messages.en.json`、`shared/messages.en.json`、`desktop/messages.en.json` | 新增的介面文字與錯誤訊息英文；裝置名稱不翻譯 |

## 3. 設計

### 3.1 麥克風

- 開啟順序：`deviceId: { exact }` → 清單裡同名的裝置（deviceId 換掉時）→ 不帶 deviceId 的系統預設（`fallback: true`）。權限被拒等其他錯誤照樣丟出，不試別的裝置。
- 用的地方：即時語音兩條路徑（旗標關閉時直接開；開啟時向常駐聆聽租用）、常駐聆聽、家人聲音登記。
- 狀態句：麥克風開著時「使用中：X」（X 來自 track 的實際 deviceId），選定的裝置找不到時「找不到「X」，暫用系統預設」，沒有開著的麥克風時「目前沒有開著的麥克風」。勾選只代表保存的選擇。頁面還沒回報裝置清單時，選定的裝置寫「X（尚未回報）」，不說找不到。

### 3.2 聲音輸出

- `applySink`：系統預設時不呼叫 `setSinkId`（新元素本來就是 `""`）；之前導到別的裝置的元素才改回 `""`。選定的裝置不在清單裡就不試，改用同名裝置，再不行回系統預設。
- 對象：即時語音的遠端聲音（兩條路徑的 `<audio>`）、喚醒提示音的 `AudioContext`、家人聲音登記的提示音。擷取圖接到 `destination` 的是音量 0 的節點，不出聲，不在範圍內。
- 「之前找不到的麥克風回來了」只在它由不在變成在時通知一次，並去彈跳 500 ms（接上裝置時 `devicechange` 常常連發）；一直在清單裡卻還沒換回去時不重複通知。重讀清單有世代編號，晚到的舊結果丟掉。`output_fallback` 由所有正在播的元素算（任何一個改用系統預設就是）。
- 藍牙喇叭中斷：`devicechange` 重讀清單、重新套用，正在播的元素回到系統預設，字幕「「X」已中斷，改由系統預設播放」；接回來時改回去並說「已改回「X」播放」。瀏覽器無法得知裝置是不是藍牙，所以字幕不說「藍牙」。App 剛開時喇叭本來就沒開不算中斷（不跳字幕，狀態寫「找不到」）。

### 3.3 不能選裝置的部分

`speechSynthesis`（語音模式朗讀、SP-03a 校準的陌生聲音）與 Web Speech 辨識（按下說話、語音模式）由 Chromium 使用 macOS 系統預設，網頁 API 不能指定裝置；兩個介面照實提示。要讓它們也走藍牙喇叭，只能在 macOS「系統設定 → 聲音」改系統輸出。

### 3.4 藍牙耳機當麥克風

藍牙耳機的麥克風一開，macOS 會把它切到 HFP 通話模式，聲音品質明顯變差，也會影響同一副耳機的播放。提示建議麥克風留在 Mac、輸出選藍牙喇叭；沒有擋這個選擇。

### 3.5 旗標關閉

`settings.audio` 不綁任何旗標，一定存在；這是 `tests/wake-flag-off.test.ts` 快照的第二個刻意例外（第一個是 F6 費用紀錄）。測試在比對快照前拿掉 `audio` 欄位，其餘仍逐位元組相同，快照沒有更新。

## 4. 與規劃不同之處

1. 常駐聆聽跟著「聲音輸入」設定，預設＝系統預設：Web Speech 結束或醒來後重新取得用系統預設，不再以上一次的 deviceId exact 指定。`wake.json` 舊的 `device_id` 不搬過來（獨立審查 m2：WK-01a 打開時一律開系統預設，那個值只是當時的預設麥克風；搬過來會把所有路徑釘在那一支）。要固定某一支麥克風，在「聲音輸入」選它。
2. 喚醒聆聽中，選定的麥克風被拔除時會重開一次並改用系統預設（決定 2 延伸到聆聽中拔除）；系統預設的麥克風結束時維持原本的 `device_ended`。
3. 頁面設定的「聲音」段也畫在 App 內的帳號頁（原本 App 只在選單列放設定），因為這次要求兩個介面都能選。
4. 選單列的兩句狀態由頁面算好、經 `reportState` 傳過去（只能是白名單的句子），選單列不重算，避免兩份規則不一致。
5. 中斷字幕一律用「「X」已中斷，改由系統預設播放」，因為無法可靠判斷裝置是不是藍牙。

## 5. 測試

在 `prototype/ambient-shell/` 執行。

| 檔案（案例數） | 內容 |
|---|---|
| `tests/audio-devices.test.ts`（27，新） | `openMic`：系統預設的約束與以前相同（即時語音、登記的 `video: false`）、exact、同名找回、找不到改用系統預設、權限錯誤不改用；`applySink`：系統預設不呼叫、選定與改回、不在清單時回系統預設、不支援時照實回報；`AudioDevices`：清單去掉別名、使用中只來自 track 與 sinkId、改輸出立即套用、藍牙中斷與接回、找不到麥克風只說一次與回來、授權前沒有名稱、每種最多 24 個、App 剛開時不說中斷、「回來了」去彈跳與連發只通知一次、晚到的舊清單丟掉、`output_fallback` 看所有元素、停掉 track 立即更新使用中；提示音：導好才排音、播完才關、等不到 1 秒後照系統預設出聲、取消；登記提示音只登記自己的短暫 context；`labelBackfill`；`sanitizeAudioReport` 與狀態句 |
| `tests/audio-settings.test.ts`（6，新） | `parseAudioPatch`；`audio.json` 預設、0600、選回預設清名稱、讀不懂一律 `null`；`/api/settings/audio` 驗證、保存、`settings.updated`；`NOUS_WAKE=on` 時 `wake.json` 舊的 `device_id` 不搬、不建立 `audio.json` |
| `tests/audio-front-end.test.ts`（41，原 37） | 改成經真的 `AudioDevices`（假 MediaDevices）開麥克風；新增：找不到時改用系統預設、回來時閒置重開、通話中換麥克風等歸還、聆聽中拔除時重開；控制器跟著「聲音輸入」、不再保存 `device_id` |
| `tests/audio-privacy.test.ts`（13） | 只有 `src/audio-devices.ts` 呼叫 `getUserMedia({ audio })`（逐行釘住）；所有出聲的 `new Audio()`／`destination` 都經 `audioDevices.sink` 或注入的提示音輸出；`setSinkId` 只在 `src/audio-devices.ts`；preload 的「聲音」回報與 `shared` 及 `settings-menu.mjs` 的整理結果相同 |
| `tests/desktop-menu.test.ts`（29，原 24） | 「聲音」段：文字和 `shared` 相同、只有核心給 `audio` 才畫、radio 順序與點選送出的 patch、找不到的選擇仍列出並停用、還沒回報與沒有名稱、英文翻譯介面字但不改裝置名稱 |
| `tests/settings-view.test.ts`（18，原 13） | 瀏覽器版與 App 內：兩個下拉選單、找不到的選擇仍列出、使用中與提示；選擇送出 id 與名稱、系統預設送 `null`；授權前提示；清單還沒讀到時寫「尚未回報」；英文 |
| `tests/wake-flag-off.test.ts`（5） | 拿掉 `settings.audio` 後與 base `9778b41` 的快照逐位元組相同，另外確認 `audio` 是預設值 |

整套結果見第 9 節。

## 6. 現在不能驗證的

- Electron 44 在 macOS 上 `HTMLMediaElement.setSinkId` 與 `AudioContext.setSinkId` 是否需要額外權限（目前的權限檢查處理器允許 `media`；`Permissions-Policy` 沒有限制 `speaker-selection`）。
- 藍牙喇叭中斷時 Chromium 送 `devicechange` 的時機，與正在播的元素在重新套用之前是否短暫無聲。
- `enumerateDevices` 在 App 內是否在授權麥克風前就給名稱。
- 回音：即時語音的回音消除對藍牙喇叭（延遲較大）是否仍有效。

## 7. Mac 步驟（尚未執行）

1. 打開藍牙喇叭並在「系統設定 → 藍牙」配對，確認 macOS 能從它播放聲音；macOS 系統輸出保持 Mac 喇叭。
2. 啟動 App，打開選單列「鏡頭與語音設定」，確認最後有「聲音」段，「聲音輸入」「聲音輸出」子選單列出 Mac 麥克風、Mac 喇叭與藍牙喇叭（名稱可讀），第一項是「系統預設（目前：…）」。
3. 「聲音輸出」選藍牙喇叭。開始即時語音，Nous 的回答應從藍牙喇叭出來；狀態列寫「使用中：<喇叭名稱>」。通話中改回系統預設，回答應立刻改從 Mac 喇叭出來。
4. 回音檢查：輸出在藍牙喇叭、麥克風在 Mac，喇叭放在平常位置，說一段話等 Nous 回答完，確認 Nous 不會把自己的回答當成使用者說話（不會自己回應自己、不會被打斷）。記下喇叭與 Mac 的距離。
5. 播放中關掉藍牙喇叭：字幕「「<名稱>」已中斷，改由系統預設播放」，聲音改從 Mac 喇叭出來，狀態寫「找不到「<名稱>」，暫用系統預設」。重新打開喇叭：字幕「已改回「<名稱>」播放」。
6. 打開頁面設定（App 內的「帳號與登入」頁或瀏覽器版設定），確認「聲音」段的兩個下拉選單、使用中的裝置與兩句提示，改選後選單列跟著更新。
7. 有 USB 麥克風時：「聲音輸入」選它，通話中改選另一支，應出現「下一通起使用「…」」，這通不換；下一通用新的。拔掉選定的麥克風再開始通話：字幕「找不到「…」，暫用系統預設」，通話照常；插回去後下一通改回它。`NOUS_WAKE=on` 時，喚醒聆聽在閒置時換回去。
8. 語音模式（Web Speech）與 SP-03a 校準的陌生聲音照舊從 macOS 系統輸出念出，與提示一致。
9. 喚醒提示音（`NOUS_WAKE=on`）從選定的輸出出聲。

## 8. 風險與限制

- 選擇以 deviceId 保存；Chromium 的 deviceId 對同一個 origin 通常穩定，換掉時用保存的名稱找回。兩個同名裝置時取清單中的第一個。
- 藍牙喇叭的延遲可能讓回音消除變差；第 7 節第 4 步要在 Mac 上確認。
- 系統朗讀與 Web Speech 不跟著選擇（George 決定 1）。

## 9. 結果與下一個 gate

雲端容器：`npm run typecheck` 通過；`npx vitest run` 119 個檔案、2222 個案例通過、5 個略過（略過的是依環境條件執行的既有案例：只在 macOS、已安裝模型或可用檔案鎖時才跑）；`npm run build` 通過。下一個 gate：第 7 節 Mac 步驟，特別是藍牙喇叭出聲、中斷與接回、回音檢查。
