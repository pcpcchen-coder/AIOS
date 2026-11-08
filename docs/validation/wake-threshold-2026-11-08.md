<!-- bilingual: source=zh-TW -->

> [繁體中文](wake-threshold-2026-11-08.md) | [English](wake-threshold-2026-11-08.en.md)

# 喚醒詞門檻調整（設定頁，2026-11-08）

George 2026-11-08 問：喚醒詞的門檻能不能讓使用者調整；可以的話，在設定頁做一個門檻調整值。

## 1. 之前的狀況

門檻**不能**調整。它寫在 `shared/wake-runtime.json` 的 `keywords`：Hello Nous 三行用全域門檻 0.15（提升分數 1.5）；Hey Nous 三行各自 0.25（提升分數 1.0）。喚醒 worker（`src/audio/wake-worker.ts`）直接讀這份清單產生 sherpa-onnx 的關鍵詞設定，沒有任何偏好或設定可以改它。數字的來源見 [WK-00 Mac 試跑](wk-00-mac-2026-10-31.md)。

## 2. 這次做了什麼

設定頁新增「喚醒詞門檻」一段，可以選一個**門檻調整值**。這個值會加到每一行關鍵詞門檻上（含全域門檻），提升分數不變：

| 選項 | 調整值 | Hello Nous | Hey Nous |
|---|---|---|---|
| 更容易喚醒 | −0.10 | 0.05 | 0.15 |
| 稍微容易 | −0.05 | 0.10 | 0.20 |
| **預設** | **0** | **0.15** | **0.25** |
| 稍微嚴格 | +0.05 | 0.20 | 0.30 |
| 更不容易誤觸 | +0.10 | 0.25 | 0.35 |

（計算：門檻 + 調整值，夾在 0.01–0.99，取到小數兩位；`tests/wake-threshold.test.ts` 驗證。）

sherpa-onnx 的門檻越大越不容易觸發，所以數字越小越容易喚醒、也越容易誤觸。上下限定在 ±0.10，依據 WK-00 Mac 實測：Hello Nous 升到 0.25（+0.10）時離線只剩 6/10；Hey Nous 在 1.0／0.30（+0.05）時已降到 6/10；Hey Nous 在提升分數 1.5、門檻 0.15 時「Hey nurse」會觸發。−0.10 這一格（Hey Nous 提升分數 1.0、門檻 0.15；Hello Nous 0.05，低於量過的最低 0.10）**沒有量過**，誤觸可能明顯增加。再往外沒有提供。

| 項目 | 做法 |
|---|---|
| 保存 | 核心的 `wake.json` 新欄位 `wake_threshold_offset`（`shared/wake.ts`），只接受五個選項之一；檔案裡的值讀不懂時用 0（產品原本的門檻） |
| 顯示 | `/api/settings` 的 `settings.wake` 多了 `thresholds`，是核心依清單算出的每個喚醒詞實際門檻；設定頁照這個顯示「目前門檻：Hello Nous 0.15、Hey Nous 0.25」 |
| 套用 | 擷取（`src/audio/capture.ts`）建立 worker 時在 init 帶上調整值；worker 只接受五個選項之一，其他值或沒給時用產品原本的門檻（`offsetKeywords`） |
| 何時生效 | 聆聽中改了就以新門檻重建擷取：閒置時立即，通話中等這通結束（同「聲音輸入」改了，`AudioFrontEnd.reopen`）。聆聽關著時改，下次打開就用新門檻 |
| 在哪裡 | 瀏覽器版與 Pi 頁面的設定畫面、macOS App 的設定頁，只要核心開了喚醒（`NOUS_WAKE=on`，`settings.wake` 存在）就會顯示。macOS App 的選單列「喚醒詞」段也有「喚醒詞門檻：…」子選單（George 同日追加），五個選項相同、寫入同一個設定。所有連到同一個核心的裝置共用一個值 |
| 雙語 | 選項、說明、錯誤訊息都在 `src/messages.en.json` |
| 回退 | 選「預設（0）」就回到原本的門檻；舊的 `wake.json` 沒有這個欄位時也是 0 |

方向性診斷頁（`spike/wake/direction/`）的門檻位移改用同一個 `offsetKeywords`（從 `shared/wake.ts` 匯入），兩邊算法一致。

## 3. 怎麼選

- 常常叫不醒：先試「稍微容易（−0.05）」。
- 電視或聊天常誤觸：試「稍微嚴格（+0.05）」。
- 想知道哪個值最適合：用[方向性診斷頁](wake-direction-2026-11-08.md)。它同時跑 +0.10、+0.05、0、−0.05 四個門檻，可以看出叫不醒的那幾次在哪個值會中、誤觸在哪個值會消失。

## 4. 驗證

| 項目 | 結果 |
|---|---|
| `tests/wake-threshold.test.ts`（8 項） | 只接受五個選項；保存與讀不懂時用 0；五個值的實際門檻（上表）；`kwsConfig` 的全域門檻與提升分數；worker 只接受清單上的值、擷取在 init 帶上設定；聆聽中改了會重建擷取，值相同或聆聽關著時不重建；設定頁五個選項、選中的值、目前門檻、改了才送出、沒有動作時停用、英文翻譯齊全、兩種設定頁都有這一段 |
| 選單列（`tests/desktop-menu.test.ts`） | 「喚醒詞門檻：…」排在「喚醒後等你開口」之後；五個選項和 `shared/wake.ts`、設定頁同一組，目前的值打勾；點選經 `setMenuPref` 寫入 `wake_threshold_offset`；英文選單完全翻譯；不在選項裡的值顯示成預設 |
| 既有測試 | `wake-settings`（`settings.wake` 多了 `thresholds`）、`audio-privacy`（擷取 init 那一行逐字更新）等跟著更新；`node scripts/verify-aios.mjs` 結果見 PR |
| 無頭 Chromium | 以 `NOUS_WAKE=on`、mock 引擎啟動核心，開 Pi 頁面（`?terminal=rpi4`）按齒輪：設定頁出現「喚醒詞門檻」、預設 0、顯示 Hello Nous 0.15、Hey Nous 0.25；改成「稍微容易（−0.05）」後 `wake.json` 存成 `-0.05`，畫面改成 Hello Nous 0.10、Hey Nous 0.20 |

## 5. 未驗證

- 沒有在 Mac、Pi 或 eMeet 上試過；不同調整值實際的喚醒率與誤觸率，要用診斷頁或日常使用量。
- 雲端無頭 Chromium 的這個環境沒有引擎檔案（`runtime: not_configured`），所以沒有看到 worker 真的用新門檻偵測；worker 的套用由靜態測試與 `kwsConfig` 測試涵蓋。方向診斷頁用同一個 `offsetKeywords`，之前已在無頭 Chromium 用真引擎跑過 ±0.05、+0.10。
