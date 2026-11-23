<!-- bilingual: source=zh-TW -->

> [繁體中文](day-night-mode-2026-11-08.md) | [English](day-night-mode-2026-11-08.en.md)

# 日夜間模式 DN-1：現況盤點、設計與第一批（2026-11-08）

George 2026-11-08 要求把 VOL-2 的「日間／夜間音量」升級成完整的日夜間模式。本文件包含：
- 現況盤點；
- 整體設計與 George 的決定；
- 第一批（B1）、第二批（B2，第 7 節）與第三批（B3，第 8 節）的實作、測試與回退方式。

## 1. 現況盤點（main @ 1a66fb9）

| 項目 | 現況 |
| --- | --- |
| 判斷規則 | `shared/day-night.ts`（純函式）：在夜間時段（預設 22:00–07:00）內就是夜間。時段外，鏡頭讀值連續 1 分鐘低於 95 也算夜間；高於 115 連續 1 分鐘才回到亮。「亮」不能把夜間時段改回日間。每分鐘重算；亮度每 30 秒量一次，超過 90 秒沒讀值就只看時段 |
| 影響範圍 | 只有兩項：對話音量（日間預設 100、夜間預設 40），以及右上角時鐘下方的太陽「日間模式」或月亮「夜間模式」 |
| Mac 與 Pi | 判斷在**各自的頁面**裡做，設定也存在各自的 `localStorage`，所以 Mac 主視窗與 Pi Chromium 各算各的、設定不互通。Pi 的鏡頭預設關閉，通常只看時段。核心（server）不知道現在是日間還是夜間 |
| 設定 | 設定頁有日間音量、夜間音量、夜間開始／結束時間、用鏡頭判斷。語音 `set_voice_volume` 可以指定 `period`，但只能調音量 |
| 缺少的 | 手動切換與暫時覆寫；Mac 選單列項目；以下都還不看日夜：畫面、處理中音效、回憶模式、喚醒門檻、主動提醒、Pi 螢幕 |
| 已知限制 | 主動提醒的時段（預設 05–11）和夜間時段在 05–07 重疊；亮度門檻只有一台 Pi、一個房間的實測值；Pi 螢幕只靠「關閉 Screen Blanking」維持常亮 |

## 2. 設計與 George 的決定（2026-11-08）

| 問題 | George 的決定 | 批次 |
| --- | --- | --- |
| Pi 實體螢幕 | **深夜整個關螢幕**，喚醒或觸控時亮回來 | B3（Pi 套件） |
| 處理中音效 | **夜間關閉**（電子腦的樣子照常） | B1 |
| Nous 說話語氣 | **夜間輕聲、簡短**（只改語氣，不保證音色真的變輕） | B2（需要核心知道模式） |
| 主動提醒 | 維持現狀（沒有選「夜間不說」） | — |
| 喚醒門檻 | 維持現狀 | — |
| 回憶模式 | **夜間暫停** | B1 |
| 手動切換 | **模式移到核心共用**；設定頁、選單列、語音指令都能切，包含「今晚維持日間／夜間」這類暫時覆寫 | B2 |
| 畫面 | 夜間整體變暗，切換時約 3 秒漸變 | B1 |

## 3. 第一批 B1：頁面端的夜間行為

### 行為對照表

| 行為 | 日間 | 夜間（「一併套用」開） | 夜間（「一併套用」關＝回退） |
| --- | --- | --- | --- |
| 對話音量 | 日間音量 | 夜間音量 | 夜間音量 |
| 畫面 | 原樣 | 整個畫面疊一層 45% 黑，約 3 秒漸變；設定頁打開時 25%；減少動態效果時 0.4 秒 | 原樣 |
| 處理中提示音 | 照「聲音」設定 | 不出聲，電子腦的「處理中」樣子照常 | 照「聲音」設定 |
| 回憶模式 | 照設定 | 不開始；正在播放的收起 | 照設定 |
| 右上角提示 | 太陽「日間模式」 | 月亮「夜間模式」；滑鼠停上去多一行「已調暗畫面、處理中音效靜音、回憶暫停」 | 月亮「夜間模式」 |

### 實作

- `shared/day-night.ts`：
  - `DayNightPrefs` 加 `night_effects`（預設開；讀不懂時用預設）；
  - 新增純函式 `nightEffects(mode, prefs)`，回傳 `{ dim, muteProcessingCue, pauseMemories }`。日間或設定關閉時全部 false。
- `src/main.ts`：判斷改變時在 `body` 設 `data-day-night` 與 `data-night-dim`，並重算處理中音效與回憶模式：
  - 處理中音效：`enabled` 多一個條件，夜間不出聲；
  - 回憶模式：`enabled` 多一個條件，夜間不播放；
  - 右上角的 title 多一行說明。
- `src/style.css`：`body::after` 疊一層不接收點擊的半透明黑。
- 設定頁「這台裝置的對話音量」多一個開關：「夜間一併調暗畫面、靜音處理中音效、暫停回憶」。
- 新字串的英文放在 `src/messages.en.json`。
- 電子腦腦區連動的事件來源不變，只是整體看起來比較暗；沒有用假事件或假動畫。
- 這批**沒有**另外降低電子腦的動畫強度（例如幀率或光脈衝幅度），只降低亮度。

### 回退

在設定頁把「夜間一併調暗畫面、靜音處理中音效、暫停回憶」關掉，就回到 VOL-2 的行為：夜間只換對話音量。設定只存在該裝置的頁面，Mac 與 Pi 要各自關。

## 4. 測試

- `tests/day-night-volume.test.ts`：
  - `nightEffects` 在夜間開啟時三項都是 true；日間或設定關閉時全部 false；
  - 預設值與讀不懂時的處理；
  - 假時鐘 23 點、14 點加上「暗」的假亮度都會套用，14 點加上「亮」則不套用；
  - 原本的保存與讀回測試加上 `night_effects`。
- `tests/voice-volume.test.ts`：設定頁開關的 `aria-pressed` 狀態正確，按下送出 `{ night_effects: false/true }`；新字串都有英文。
- 無頭 Chromium（mock 核心，夜間時段設成 00:00–23:00 模擬夜間、00:00–00:00 模擬日間），頁面都沒有 JS 錯誤：

  | 畫面 | `data-day-night` | `data-night-dim` | 疊層不透明度 |
  | --- | --- | --- | --- |
  | Mac 1920×1080 日間 | day | off | 0 |
  | Mac 1920×1080 夜間 | night | on | 0.45 |
  | Pi 1024×600 日間 | day | off | 0 |
  | Pi 1024×600 夜間 | night | on | 0.45 |
  | Pi 1024×600 夜間、開關關閉 | night | off | 0 |

- `npm run typecheck`、`npx vitest run`（167 個檔案，3092 項通過、6 項略過）、`npm run build` 都通過。

## 5. 還沒驗證

- 沒有在 Mac 或 Pi 實機看過變暗的程度與漸變；45% 是預估值。
- 沒有實機確認夜間時處理中音效真的不響、回憶模式真的不開始（只有單元測試與程式路徑）。
- B2 的範圍與驗證見第 7 節，B3（Pi 深夜關螢幕）見第 8 節。

## 6. George 在家的實測步驟

1. Mac 與 Pi 各打開設定頁「這台裝置的對話音量」，確認「夜間一併調暗畫面…」是「開」。
2. 暫時把夜間開始設成目前整點、結束設成下一個整點，約 1 分鐘內畫面應約 3 秒漸暗，右上角變成月亮「夜間模式」。
3. 夜間時交辦一件背景任務：電子腦有「處理中」的樣子，但沒有聲納聲。
4. 放著不動超過回憶模式的閒置秒數：回憶模式不播放。
5. 把開關關掉：畫面立即漸亮，回憶與處理中音效恢復，只剩音量照夜間。
6. 把夜間時段改回 22:00–07:00。

## 7. 第二批 B2：核心共用、手動切換與輕聲語氣（2026-11-08）

### 行為

| 項目 | 行為 |
| --- | --- |
| 共用設定 | 夜間時段、用鏡頭判斷、「一併套用」與手動切換存在核心 `configDir/day-night.json`，經 `settings.day_night` 給所有頁面；Mac 主視窗與 Pi 一起變。**鏡頭亮度仍由各頁面自己量**，只影響那台裝置 |
| 搬移舊設定 | 核心還沒保存過、頁面有 VOL-2 存的設定時，頁面自動送到核心一次；之後以核心為準。兩台裝置設定不同時，以先打開的那台為準 |
| 對話音量 | 日間、夜間兩個音量仍是每台裝置各自保存（不變） |
| 手動切換 | 「現在是白天」「切到夜間」維持到下一次時段交界（例如 15:00 切夜間維持到 22:00，之後照時段仍是夜間）；「今晚維持日間」維持到今晚夜間時段結束（預設隔天 07:00）；「自動」立即取消。手動切換優先於時段與鏡頭，時間到自動恢復 |
| 入口 | 設定頁「這台裝置的對話音量」上方四個按鈕；Mac 選單列「日夜間模式」一行狀態加四個單選；即時語音工具 `set_day_night`（「切到夜間模式」「現在是白天」「今晚維持日間」「恢復自動」） |
| 右上角提示 | 手動時顯示「手動切換：維持夜間模式到 22:00」 |
| 輕聲語氣 | 核心判斷是夜間（時段或手動切換）時，即時語音每通開始時的說明多一句「說話放輕、放慢，句子更簡短」。只改語氣，音色與音量不變；通話中切換模式不會改這一通；**不看各裝置的鏡頭** |
| 沒有改的 | 主動提醒與喚醒門檻（George 決定維持） |

### 實作

- `shared/day-night.ts`：
  - `nextScheduledChange`、`overrideUntil`、`activeOverride`（本機時區，純函式）；
  - `decideDayNight` 多了手動切換參數與 `manual` 原因；
  - 新增 `parseDayNightPatch`、`DayNightSettingsView`，以及語音工具的參數與結果函式。
- `server/day-night-settings.ts`：`day-night.json` 的唯一寫入者，壞掉的鍵會丟掉並記 log。
- `server/app.ts`：新增 `settings.day_night` 與 `POST /api/settings/day-night`（400 驗證）。
- `server/realtime.ts`：
  - 新增工具 `set_day_night`（兩條路徑），規則 `DAY_NIGHT_RULE`；
  - 新增 `NIGHT_TONE_RULE`（`caps.night` 時才加，否則說明與之前逐位元組相同）。
- `src/main.ts`：
  - 頁面以核心設定為準；
  - 收到新設定時重算；
  - 語音工具由頁面送核心，核心沒有這個功能時照實回錯。
- `desktop/settings-menu.mjs`、`desktop/main.mjs`：選單列分段。
- 中英文字串：`src/messages.en.json`、`desktop/messages.en.json`、`shared/messages.en.json`；`README.md`／`README.en.md` 指令表多一行。

### 回退

- 說「恢復自動」或按「自動」：取消手動切換。
- 關掉「夜間一併調暗畫面、靜音處理中音效、暫停回憶」：回到只切換音量。B2 起這個開關存在核心，關一次 Mac 與 Pi 都生效。
- 要完全回到 B1 之前：刪除 `configDir/day-night.json` 並還原這批程式。頁面會回到各自保存的設定。

### 測試

- `tests/day-night-mode.test.ts`（17 項）：
  - 假時鐘下的時段交界與結束時間（15:30、23:10、21:00 說今晚、沒有夜間時段）；
  - 手動切換優先與到期；
  - patch 驗證；
  - `day-night.json` 的保存、到期、重開與壞鍵；
  - `startNous` HTTP（共用、400、自動）；
  - 工具的提供、參數、結果與頁面執行器；
  - 輕聲語氣只在夜間出現，拿掉後和原本逐位元組相同；
  - 選單列文字與頁面一致、單選送出的 patch、過期顯示自動、英文沒有中文。
- `tests/voice-volume.test.ts`：設定頁四個按鈕、目前那一個 `aria-pressed`、核心沒有時不顯示。
- 既有快照的刻意例外：
  - `apikey-route` 的工具表多 `set_day_night`、說明多 `DAY_NIGHT_RULE`；
  - `realtime-bridge` 的工具清單；
  - `wake-flag-off` 的 `settings.day_night`（第七個例外）。
- 無頭 Chromium（mock 核心）：
  - Pi 頁面帶舊的頁面設定（21–06）打開後，核心保存 21–06；
  - 核心切夜間後，Pi 與 Mac 頁面都變成 `night`、變暗，右上角是「手動切換：維持夜間模式到 21:00」；
  - 在 Pi 設定頁按「自動」後，Mac 頁面回到 `day`；
  - 沒有 JS 錯誤。
- `npm run typecheck`、`npx vitest run`（168 個檔案，3111 項通過、5 項略過）、`npm run build` 都通過。

### 還沒驗證（B2）

- 沒有在 Mac 與 Pi 實機上試過同時切換、選單列與語音指令。
- 模型是否真的照 `set_day_night` 的說明呼叫、輕聲語氣聽起來是否不同，都沒有用真實即時語音試過。

### George 在家的實測步驟（B2）

1. Mac 與 Pi 都打開 Nous，在 Mac 選單列「日夜間模式」選「切到夜間」：兩邊畫面約 3 秒內變暗，右上角顯示維持到幾點。
2. 在 Pi 設定頁按「自動」：兩邊回到依時段判斷。
3. 即時語音說「切到夜間模式」，再說「恢復自動」：Nous 說出模式與維持到幾點，畫面跟著變。
4. 晚上 9 點左右說「今晚維持日間」：到隔天 07:00 前都是日間，選單列顯示「今晚維持日間」被選。
5. 夜間時段開一通即時語音：聽聽語氣是否比較輕、比較短。

## 8. 第三批 B3：Pi 深夜關螢幕（2026-11-08）

### 行為

| 項目 | 行為 |
| --- | --- |
| 什麼時候關 | 夜間模式（時段、手動切換或那台裝置的鏡頭判斷）＋設定「Pi 夜間閒置 5 分鐘關螢幕」開著＋頁面不忙（任務、通話、對話、收音、念話、處理中、打開的畫面、看著說話都算忙）＋5 分鐘沒人碰螢幕或按鍵 |
| 怎麼亮回來 | 碰螢幕、按鍵或開始對話（含喚醒詞），約 2 秒內亮回來。叫醒螢幕的那一下不算點擊（頁面吞掉那次點擊，不會開始對話或打開畫面） |
| 誰決定 | Pi 頁面算出開或關，經 `POST /api/terminal/display` 回報核心：狀態改變立即送，沒變也每 10 秒送一次 |
| 誰執行 | Pi 套件新的 `aios-display`（`aios-display.service`，由 `aios-session-start` 跟 kiosk 一起啟動）每 2 秒經 SSH 通道讀 `GET /api/terminal/display?terminal=rpi4` |
| 讀不到就亮著 | 核心讀不到、頁面 30 秒沒回報、回應看不懂、服務停止時，一律打開螢幕 |
| Mac | Mac 主視窗不回報，也不關 Mac 螢幕 |
| 設定 | 設定頁「Pi 夜間閒置 5 分鐘關螢幕」（核心 `day-night.json` 的 `screen_off`，預設開，所有畫面共用） |

### 關螢幕的方法與權限

| 方法 | 適用 | 權限 |
| --- | --- | --- |
| `backlight` | 官方 DSI 觸控螢幕：寫 `/sys/class/backlight/*/bl_power`（1 關、0 開） | `install.sh` 用 sudo 安裝 `/etc/udev/rules.d/90-aios-backlight.rules`，讓 `video` 群組可寫 `bl_power`、`brightness`，並對現有背光觸發一次 |
| `wlr-randr` | Wayland（labwc）：`wlr-randr --output <每個輸出> --off/--on` | 不需要 |
| `xset` | X11：`xset dpms force off/on` | 不需要 |
| `none` | 都找不到 | 螢幕不動；`aios-doctor` 顯示 WARN |

- 方法依上表順序自動選，也可以用 `AIOS_DISPLAY_METHOD` 指定；不合法的值結束碼 2。
- `uninstall.sh` 會用 sudo 刪除 udev 規則。

### 實作

- `shared/day-night.ts`：`screen_off` 設定、`screenWanted`（純函式）與常數（閒置 5 分鐘、每 10 秒回報、30 秒算太舊）。
- `server/terminal-display.ts`：只在記憶體記每台終端機最後的狀態；不寫檔、不記 log。
- `server/app.ts`：`POST`／`GET /api/terminal/display`（驗證識別碼與狀態，400）。
- `src/screen-reporter.ts`：頁面端的閒置計算與回報。
- `src/main.ts`：只在終端機頁面啟用；觸控、按鍵、滾輪都算活動；螢幕關著時吞掉叫醒的那次點擊。
- 設定頁加一個開關。
- Pi 套件：
  - `bin/aios-display`、`systemd/aios-display.service`；
  - `lib/common.sh` 的 `detect_display_method`、`set_screen`；
  - `install.sh` 的 udev 規則；
  - `aios-session-start` 啟動新服務；
  - `aios-doctor` 加「夜間關螢幕」一行；
  - `uninstall.sh` 移除規則；
  - `terminals/rpi4/README` 加說明（中英）。

### 回退

- 設定頁把「Pi 夜間閒置 5 分鐘關螢幕」關掉，頁面一律回報「開」，螢幕不再被關。
- 只想停掉 Pi 這邊：`systemctl --user stop aios-display.service`，停止時會把螢幕打開。
- 完全移除：執行 `uninstall.sh`，或還原這批程式並重新安裝 Pi 套件。

### 測試

- `tests/day-night-mode.test.ts`：
  - `screenWanted` 的五種情況；
  - 頁面回報器在假時鐘下的行為：立即回報改變、每 10 秒重送、活動與忙碌都會叫醒；
  - 核心太舊或沒有回報時當成開；
  - HTTP：預設開、回報後是關、不合法 400，`screen_off` 可以改。
- `tests/voice-volume.test.ts`：設定頁開關只在核心共用時出現，按下送 `{ screen_off: false }`。
- `terminals/rpi4/tests/dry-run.sh`（130 項，假指令）：
  - 安裝新指令、新服務與 udev 規則，並觸發 udevadm；
  - 重新安裝會 try-restart 新服務；
  - `aios-display` 依核心回應用 wlr-randr 關掉 HDMI-A-1 與 DSI-1；
  - 核心讀不到時只會打開；
  - 有可寫的背光時優先寫 `bl_power`；
  - X11 用 xset；
  - 沒有方法時說明螢幕維持開著；
  - 不合法的方法結束碼 2；
  - doctor 顯示 WARN 或 PASS 與方法；
  - 解除安裝移除服務與規則；
  - shellcheck 乾淨。
- 無頭 Chromium（mock 核心，Playwright 假時鐘，核心手動切夜間）：
  - Pi 頁面載入後核心是 `on`；
  - 前進 5 分鐘後是 `off`；
  - 點電子腦一下後回到 `on`，對話狀態仍是 `idle`、沒有打開畫面；
  - 沒有 JS 錯誤。
- `npm run typecheck`、`npx vitest run`（168 個檔案，3115 項通過、5 項略過）、`npm run build` 都通過。

### 還沒驗證（B3）

- 沒有在 Pi 實機確認任何一種方法真的能關螢幕，也沒有確認 DSI 背光的 udev 規則權限。
- wlr-randr 關掉輸出後，觸控能不能叫醒螢幕不確定，可能只能靠喚醒詞或鍵盤。
- 用喚醒詞叫醒的延遲（約 2 秒輪詢）也沒有實測。

### George 在家的實測步驟（B3）

1. 在 Pi 重新執行 `install.sh`（會用 sudo 裝 udev 規則），再執行 `aios-doctor`，看「夜間關螢幕」那一行用哪一種方法。
2. Mac 選單列選「切到夜間」，Pi 放著不碰 5 分鐘：螢幕應該關掉。
3. 碰一下螢幕（DSI）或說喚醒詞：約 2 秒內亮回來，而且這一下不會開始對話。
4. 設定頁把「Pi 夜間閒置 5 分鐘關螢幕」關掉，再等 5 分鐘：螢幕不再關。
5. 測完在選單列選「自動」。
