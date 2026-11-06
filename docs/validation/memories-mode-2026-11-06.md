<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-mode-2026-11-06.md) | [English](memories-mode-2026-11-06.en.md)

# 回憶模式 MEMO-1（2026-11-06）

George 2026-11-06 要求：設定可開關「回憶模式」；電子腦沒有被交辦工作時，照片與影片從電子腦浮現輪播；喚醒、看著說話、交辦或通話時立即收起；照片有時間與地點時顯示「三年前在新竹」這類文字。Mac App 與 Pi 頁面都要能開關、能顯示。

本批次（MEMO-1）做狀態機、動畫、時間地點文字、設定與 **Mac 本機資料夾來源**。Google 相簿來源（Picker）是下一批 MEMO-2。

## George 決定的預設值（2026-11-06）

| 項目 | 預設 | 可選 |
|---|---|---|
| 照片來源 | 兩者都做：MEMO-1 本機資料夾、MEMO-2 Google Picker | — |
| 每張停留 | 8 秒 | 5、8、12、20 秒 |
| 閒置多久開始 | 60 秒 | 30 秒、1、3、5 分鐘 |
| 影片聲音 | 靜音 | 設定可打開 |
| 本機快取上限 | 2 GB（`MEMORIES_CACHE_CAP_BYTES`，MEMO-2 才會用到） | — |
| 回憶模式總開關 | 關（`enabled: false`） | 選單列、設定頁 |

## Google 相簿官方限制（查核日期 2026-11-06）

| 項目 | 官方文件內容 | 來源 |
|---|---|---|
| Library API | 2025-03-31 後移除 `photoslibrary.readonly`、`photoslibrary.sharing`、`photoslibrary`；只能列出與讀取「你的 App 建立的」相簿與媒體 | https://developers.google.com/photos/support/updates |
| Picker API 範圍 | `photospicker.mediaitems.readonly` | https://developers.google.com/photos/picker/guides/media-items |
| 能不能挑整本相簿 | 不能直接挑；選擇畫面不直接列出相簿，但可用相簿名稱搜尋後逐張挑選。每個 session 最多 2000 項 | https://developers.google.com/photos/picker/guides/picking-experience 、 https://developers.google.com/photos/picker/reference/rest/v1/sessions |
| 持續同步 | 沒有。按完成後 `pickerUri` 失效；要加照片須建立新的 session 重新挑 | https://developers.google.com/photos/picker/guides/sessions |
| baseUrl | 60 分鐘有效，下載須帶 OAuth bearer token；照片用 `=wW-hH` 或 `=d`（含 Exif、**去掉位置**），影片用 `=dv` | https://developers.google.com/photos/picker/guides/media-items |
| 換裝置挑 | 可顯示網址或 QR code 讓使用者用手機掃；`/autoclose` 不適用跨裝置；不能放進 iframe | https://developers.google.com/photos/picker/guides/get-started-picker |
| 本機快取 | 政策沒有明文禁止（推論）；須尊重使用者刪除資料的要求、token 須加密保存 | https://developers.google.com/photos/support/api-policy |
| Ambient API（相框用、可持續顯示相簿） | 只開放合作夥伴計畫，一般開發者不能用 | https://developers.google.com/photos/partner-program/overview |
| repo 的 `gog` 工具 | `photos` 只能讀 App 自己建立的內容；`photos picker` 有 create／get／wait／list／download／delete（2026-11-05 gogcli main） | https://github.com/steipete/gogcli |

結論：官方路徑做不到「指定相簿、持續同步」。George 選擇兩者都做：本機資料夾（可放 Mac「照片」App 匯出）與 Google Picker（挑一批、快取在 Mac、要新照片重新挑）。Google 下載的照片沒有位置，所以 Google 來源只會顯示時間。

## 設計

### 狀態機（`shared/memories.ts`）

| 條件（依序） | 結果 |
|---|---|
| 沒開，或和核心斷線 | `off` |
| 電子腦有事 | `busy`（停止倒數） |
| 剛閒下來 | `waiting`，從這一刻開始倒數 |
| 有照片，且閒置達 `idle_s` | `showing` |
| 其他 | `waiting` |

「有事」（`src/main.ts` 的 `memoriesBusy`）：有執行中或排隊的任務、即時語音通話中或開始中、語音對話開著、收音中、等待回覆、背景處理中、有畫面（Surface）開著、輸入列開著、Nous 正在念話、鏡頭看到有人面向螢幕。

「喚醒」（`wakeMemories`，立即收起並從這一刻重新倒數）：喚醒詞觸發、鏡頭偵測到面向（看著說話）、開始即時語音、任何畫面變化（交辦、打開進度或設定…）、送出文字、點一下照片。工作全部結束、通話結束後再閒置 `idle_s` 才回到回憶模式。

### 來源（`server/memories.ts`）

- 資料夾：`NOUS_MEMORIES_DIR`，預設 `~/.config/nous/memories/library`（核心啟動時以 0700 建立）。路徑只能由環境變數決定，頁面不能指定任意路徑。
- 照片 `.jpg .jpeg .png .webp .gif .avif`（30 MB 以下）、影片 `.mp4 .m4v .webm .mov`（200 MB 以下）；往下讀一層子資料夾；略過隱藏檔與指向資料夾外的連結；最多每 60 秒重新掃描。
- 頁面拿到的只有不透明 id、種類、網址、拍攝時間與城市名稱；檔案路徑與座標都不離開核心。照片不送進任何模型。
- `GET /api/memories/items`、`GET/HEAD /api/memories/media/<id>`（支援單一 Range，影片需要）、`POST /api/settings/memories`（`memories.json`）。

### 時間與地點文字（`server/memories-meta.ts`、`memoryCaption`）

- 照片：JPEG EXIF 的 DateTimeOriginal（沒有時用 DateTime），只讀前 256 KB；GPS 取緯度經度。
- 影片：mp4／mov 的 `mvhd` 建立時間（0 視為沒有）；有 `©xyz` 時讀位置。
- 地點：在核心以固定城市表（天氣的 12 個城市再加 10 個）找最近的城市，25 公里內才用，不連網。
- 文字：今天、這個星期、N 個星期前、N 個月前、去年、N 年前；同月同日是「N 年前的今天」。十以內用中文數字（「兩年前」「三年前」）。有地點時接「在新竹」；只有地點時「在新竹」；都沒有就不顯示。未來的時間（時鐘不準）不顯示時間。英文如「3 years ago in Hsinchu」。

### 動畫規格（`src/memories.ts`、`src/style.css`）

| 階段 | 時間 | 畫面 |
|---|---|---|
| 電子腦退到左下 | 1.2 s | 電子腦縮小、移到左下角並變淡；第一張等它到位才浮現 |
| 浮現 | 1.4 s | 照片從電子腦的位置放大到畫面中央（起點縮放 0.06、模糊漸清） |
| 停留 | `dwell_s`（預設 8 s） | 極慢放大 1 → 1.03；浮現結束 0.6 s 後文字淡入 |
| 退回 | 1.0 s | 文字先淡出，照片縮回電子腦 |
| 收起（喚醒） | 0.25 s | 立即淡出，影片停止並移除來源；電子腦回到原位與原本的狀態 |

- 照片最大 86vw × 78vh、圓角、柔和陰影與淡青色光暈。影片播完或 30 秒（先到者）換下一張。
- `prefers-reduced-motion: reduce`：不縮放、不移動、不模糊；電子腦原地變淡，照片只淡入淡出（0.4 s），文字直接顯示。
- 照片不點亮任何腦區、不產生光脈衝：照片不是視覺處理，電子腦動畫仍只由真實任務與對話事件驅動。
- 顯示時 `#memories` 帶 `data-visibility-reason="memories_idle"`（開啟且閒置達設定時間）；沒有這個理由就不顯示。

### Pi 4 效能

- 任何時候最多一個 `<video>`（Pi 4 只有一個硬體解碼器的餘裕），照片最多兩張（目前一張、預先解碼下一張，`img.decode()`）。
- 播放時電子腦改用「省電」繪製（每秒 12 格、0.75 倍解析度），收起後回到這台裝置原本的效能設定。
- 本機資料夾的檔案原樣送出，不縮圖：建議 Mac「照片」App 匯出時選「大」（長邊約 2048 px），Pi 解碼較輕。iPhone 的 HEVC `.mov` 在 Pi 的 Chromium 不一定能播（推論，未在 Pi 驗證），建議匯出 H.264。
- Pi 頁面經 SSH 通道向 Mac 核心取照片（同源 `localhost`），不直接連 Google。

## 測試

| 測試檔 | 內容 | 結果 |
|---|---|---|
| `tests/memories-state.test.ts` | 狀態機（假時鐘）：閒置→回憶、有事收起、喚醒重算、沒有照片不播、關閉；時間地點文字中英各分支 | 24 通過 |
| `tests/memories-http.test.ts` | 設定讀寫與 400、清單、媒體、Range 206／416、壞 id 404、不能跳出資料夾、回應沒有路徑與座標、沒提供時 404；合成的 EXIF／GPS JPEG 與 mvhd／©xyz mp4、25 公里界線（mock fixture） | 13 通過 |
| `tests/memories-presenter.test.ts` | 浮現→停留→退回→下一張（假計時器）、影片預設靜音、只會有一個 `<video>`、收起立即停止影片、減少動態 | 9 通過 |
| `tests/memories-menu.test.ts` | 選單列項目與 patch、選單文字與共用文字一致、英文沒有中文、沒有 `nousDesktop` 的設定頁也有這段 | 9 通過 |

全部：`npm run typecheck` 通過；`npx vitest run` 152 個檔案、2801 通過、5 略過；`npm run build` 通過；`node scripts/check-pstack.mjs`、`node scripts/verify-aios.mjs`、`git diff --check` 通過。

### 雲端瀏覽器實測（mock fixture）

無頭 Chromium（1280×720）開 `?terminal=rpi4`（沒有 `nousDesktop`，等同 Pi 頁面），核心用 mock 引擎與合成的 fixture 資料夾（3 張 JPEG、1 段影片，畫面印有 `MOCK FIXTURE`）：

- 閒置 30 秒後進入 `showing`；電子腦退到左下；照片浮現，文字「三年前在新竹」（EXIF 2023-08-12、GPS 新竹），下一張「一年前的今天在台北」。
- `data-visibility-reason` 是 `memories_idle`。
- 點一下照片：0.4 秒內狀態變回 `waiting`、`#memories` 隱藏。
- VP9 `.webm` 影片：只有一個 `<video>`、靜音、正在播放。

這不是 Mac 或 Pi 實機驗證；動畫順暢度、Pi 的解碼負載與實際喚醒收起都未在實機量測。

## Mac／Pi 實測步驟

1. 把照片與影片放進 Mac 的 `~/.config/nous/memories/library`（或設定 `NOUS_MEMORIES_DIR` 後重新啟動核心）。
2. Mac：選單列「回憶模式」→ 打開「閒置時播放回憶」；Pi：頁面「設定」→「回憶模式」→ 開。狀態列應顯示照片與影片的數量。
3. 不做任何事等 60 秒：電子腦退到左下、照片浮現、停留 8 秒、退回，換下一張；有時間地點的照片下方有文字。
4. 說「Hello Nous」：照片立即收起，電子腦回到原位並進入通話。通話結束後再等 60 秒，回憶模式恢復。
5. 鏡頭開著時面向螢幕：照片立即收起。交辦一個任務：立即收起，任務完成後 60 秒才恢復。
6. Pi：在 Pi 頁面設定「這台裝置的畫面效能」顯示的每秒格數，比較播放回憶前後；播影片時看 `aios-doctor` 的溫度與降頻。

## 回退與清除

- 關閉「閒置時播放回憶」（選單列或設定頁）即回到原本的電子腦，什麼都不刪。
- MEMO-1 沒有快取：照片只在你自己的資料夾；刪除資料夾的檔案即可。設定在 `~/.config/nous/memories.json`，刪除後回到預設（關閉）。
- MEMO-2 加入 Google 來源時會另外提供快取上限與清除按鈕。

## 未完成

- MEMO-2：Google Photos Picker 來源（OAuth 最小範圍、token 只留在 Mac 核心、QR code 挑選、下載快取 2 GB 上限與清除）。
- 選單列「打開回憶資料夾」捷徑。
- 本機資料夾的照片不縮圖（大檔案在 Pi 上解碼較慢）。
- Mac 與 Pi 實機驗證。
