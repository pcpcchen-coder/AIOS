<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-google-2026-11-06.md) | [English](memories-google-2026-11-06.en.md)

# 回憶模式 MEMO-2：Google 相簿來源（2026-11-06）

接續 [MEMO-1](memories-mode-2026-11-06.md)。George 2026-11-06 選擇「兩者都做」：MEMO-1 是 Mac 本機資料夾，本批次加上 Google 相簿。Google 官方限制的查核結果（查核日期 2026-11-06）見 MEMO-1 文件；結論是第三方 App 不能讀既有相簿、不能持續同步，只能用 **Google Photos Picker API** 讓使用者每次挑一批。

## 流程

1. Mac 選單列「回憶模式」→「從 Google 相簿挑選…」：核心建立挑選連結，Mac 用系統瀏覽器打開。Pi（或 Mac）頁面「設定」→「回憶模式」→「從 Google 相簿挑選…」：頁面顯示 QR code 與網址，用手機掃描。
2. 在 Google 的挑選畫面搜尋相簿名稱、選取照片與影片、按完成。每次最多 300 項。
3. 核心每 3–30 秒（依 Google 建議的間隔）查一次，看到挑選完成後列出項目，逐一下載到 Mac 的快取，完成後刪除這次的挑選 session。
4. 回憶模式的輪播同時使用本機資料夾與 Google 快取。

| 狀態 | 意思 |
|---|---|
| `idle` | 沒有進行中的挑選 |
| `starting` | 正在建立挑選連結 |
| `waiting_pick` | 等使用者挑選（顯示 QR code、網址與到期時間） |
| `downloading` | 正在下載（「正在下載 3/10」） |
| `done` | 完成（處理幾項、略過幾項） |
| `failed` | 失敗（固定的說明文字，不含 gog 的輸出） |
| `cancelled` | 使用者取消 |

## 授權與資料

- 使用 repo 既有的 `gog`（github.com/steipete/gogcli，MIT；2026-11-05 main `e8428c3` 的 `photos picker create／get／list／download／delete`）。OAuth 與 refresh token 由 gog 保存在 Mac 鑰匙圈，Nous 不讀、不存任何 Google 權杖。
- 第一次使用前在 Mac 執行一次：`gog auth add 你的帳號 --services photospicker`（最小範圍 `photospicker.mediaitems.readonly`）。沒有授權時畫面顯示「無法建立 Google 相簿挑選連結（可能尚未授權）：在 Mac 執行 gog auth add 帳號 --services photospicker」。
- 帳號來自 `NOUS_GOG_ACCOUNT`（沒有時用 `NOUS_MAIL_SELF`）；gog 路徑來自 `NOUS_GOG_PATH` 或 Homebrew 的預設位置。不需要 `NOUS_AIL`。
- gog 不經 shell 執行；stderr 一律丟掉；stdout（含 baseUrl 與挑選網址）不寫進 log。
- 設定資料只給頁面狀態與數量、挑選網址（等待挑選時）與到期時間；不含帳號、檔案路徑或 baseUrl。Google 項目 id 在磁碟上只存雜湊。
- Pi 只經 Mac 核心取得照片，不直接連 Google。照片不送進任何模型。

## 快取

- 位置：`~/.config/nous/memories/google/`（0700），`index.json` 記錄每一項（雜湊、檔名、種類、拍攝時間、挑選時間、大小），原子寫入。
- 上限 2 GB：超過時先刪最早挑選的（不刪剛加入的）。同一項重新挑選不重複下載。
- 清除：設定頁「清除 Google 快取」（再按一次確認），選單列「清除 Google 快取…」（原生確認對話框）。會先取消進行中的挑選。
- 照片：gog 只下載原檔（`=d`），iPhone 原檔多半是 HEIC，瀏覽器與 Pi 都不能顯示。Mac 上用系統內建的 `sips` 轉成長邊 2048 px、品質 85 的 JPEG（Pi 解碼也比較輕）；沒有 sips（非 macOS）或轉檔失敗時照原檔判斷，瀏覽器不能顯示的格式略過。
- 影片：`=dv`（Google 轉碼的版本）；還沒處理好（不是 READY）的影片略過。
- 格式只依檔案開頭判斷，不信 Google 給的 mimeType。
- Google 下載的照片沒有地點（官方文件：`=d` 不含位置），說明文字只有時間，例如「三年前」；時間取自 Google 的 `createTime`。

## 測試

| 測試檔 | 內容 | 結果 |
|---|---|---|
| `tests/memories-google.test.ts` | 假 gog 與假時鐘（mock）：完整流程、查詢間隔限制在 3–30 秒、逾時、建立失敗的授權提示、影片未就緒／下載失敗／HEIC 略過、有轉檔器時 HEIC 轉成 JPEG 留下、sips 參數、等待中與下載中取消（中止信號送到 gog、session 刪除）、忙碌時再挑被拒、gog 參數（不經 shell、`--account=`、`--json`、`--max-items=300`）、重新挑選不重複下載；快取上限、清除、壞掉的 index、id 不和資料夾衝突、index 沒有原始 id 或網址；HTTP 路由 | 22 通過 |
| `tests/memories-menu.test.ts` | 選單列與設定頁的 Google 段落、英文沒有中文、沒有 `nousDesktop` 的 Pi 頁面有 QR code 與按鈕、快取大小在選單與頁面一致 | 19 通過 |

全部：`npm run typecheck` 通過；`npx vitest run` 153 個檔案、2836 通過、5 略過；`npm run build` 通過。

### 雲端瀏覽器實測（mock gog）

核心用一個模擬 gog 輸出的 shell 腳本（mock，不連 Google）。無頭 Chromium 開 `?terminal=rpi4`（等同 Pi 頁面）→「設定」→「從 Google 相簿挑選…」：

- 畫面出現 QR code（200×200）與網址；模擬「挑選完成」後，狀態變成「照片 2 張、影片 0 段」、「處理 2 項，略過 0 項」。
- `/api/memories/items` 多了 2 張照片，帶時間、沒有地點；快取資料夾有 2 個 `.jpg` 與 `index.json`。
- 發現並修正：幾百 KB 的快取顯示成「0 MB」，改成 10 MB 以下留一位小數。

這不是真實 Google 帳號或 Mac 的驗證：真的 gog 輸出、Google 的挑選畫面、HEIC 經 sips 轉檔、下載速度都還沒試過。

## Mac 實測步驟

1. 確認 `gog --version` 可以執行，`.env` 有 `NOUS_GOG_ACCOUNT`。
2. 在 Mac 終端機執行 `gog auth add 你的帳號 --services photospicker`，在瀏覽器完成授權。
3. 重新啟動 App；選單列「回憶模式」應顯示「Google 相簿：照片 0 張…」與「從 Google 相簿挑選…」。
4. 選「從 Google 相簿挑選…」：瀏覽器打開 Google 的挑選畫面。搜尋相簿名稱，挑 10 張（含 iPhone 照片與一段影片），按完成。
5. 選單列應依序顯示「正在下載 N/10」與完成；`~/.config/nous/memories/google/` 應有 `.jpg`（iPhone HEIC 已轉檔）與影片。
6. 在 Pi 頁面「設定」→「回憶模式」重做一次，用手機掃描 QR code。
7. 打開回憶模式、閒置 60 秒：Google 照片出現在輪播，下方只有時間。
8. 「清除 Google 快取」：資料夾清空，輪播只剩本機資料夾。

## 回退

- 關閉回憶模式即回到原本的電子腦。
- 清除 Google 快取：設定頁或選單列的按鈕，或刪除 `~/.config/nous/memories/google/`。
- 撤銷 Google 授權：Google 帳戶的「第三方應用程式與服務」移除 gog 的存取權，或在 Mac 執行 `gog auth remove 你的帳號`（刪除 gog 保存的 refresh token）。

## 未完成

- 真實 Google 帳號、gog 與 Mac 的實測；Pi 實機。
- 清除快取時，正在輪播的那一張可能在下一次重新讀清單前取得 404（下一張會正常）。
- 挑選會加入既有收藏；沒有「只換成這次挑的」選項。
