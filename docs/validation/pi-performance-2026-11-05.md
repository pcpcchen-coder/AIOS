<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-performance-2026-11-05.md) | [English](pi-performance-2026-11-05.en.md)

# 這台裝置的畫面效能設定（Pi 終端）驗證

日期：2026-11-05。分支 `claude/pi-performance`（基於 main `190aa83`）。狀態：**程式與 Linux 雲端自動測試完成；Pi 實機上的 FPS 與 CPU 改善未量測。**

## 需求（George，2026-11-05）

RPI 目前正常，但有效能問題。補一個設定介面，在 RPI 設備上設定並調整效能。效能調整不能影響對話的流暢度。

## 做法

依程式碼判斷，頁面的主要負擔是畫面：Canvas 2D 電子腦（`src/brain.ts`）與介面的 CSS 背景模糊（`backdrop-filter`）。設定只調這兩者；收音、播放、即時語音、語音辨識、提示音、處理中音效、SSE 與心跳都不碰。

設定畫面新增「這台裝置的畫面效能」，三個選項：

| 選項 | 每秒格數上限 | 解析度上限（devicePixelRatio） | 光脈衝上限 | 光暈 | 背景模糊 |
|---|---|---|---|---|---|
| 完整 | 30 | 2 | 70 | 完整 | 開 |
| 平衡 | 20 | 1 | 40 | 完整 | 關 |
| 省電 | 12 | 0.75 | 20 | 簡化（不用 `shadowBlur`、節點光暈減半、脈衝光點縮小） | 關 |

- 「完整」等於原本的繪製方式。系統「減少動態」設定仍維持原本的每秒約 10 格。
- 每一檔都保留腦區亮起、光脈衝與區名（CLAUDE.md 的電子腦要求）。
- 背景模糊關閉時，文字後方的底色改得更不透明，避免看不清楚。
- 選擇存在該裝置瀏覽器的 `localStorage`（`nous.performance.v1`），每台裝置各自記住，不送到核心。沒有設定時，帶合法 `?terminal=` 的 Pi kiosk 頁面預設「平衡」，其他（含 Mac App）預設「完整」，Mac 行為不變。
- 選擇立即生效，不需重新載入。
- 同一段顯示電子腦的實測數字：最近約 2 秒每秒幾格、每格繪製幾毫秒（以 `performance.now()` 量 `step` 加 `draw`），標示「實測」。設定畫面開著時每秒更新一次。
- 每秒格數是上限。60 Hz 螢幕上畫面只能在螢幕更新時換格，「省電」實際約每秒 10 格；實際值看實測數字。

所有新介面文字都經 `src/messages.en.json` 提供英文。

## 自動測試（Linux 雲端）

| 檢查 | 結果 |
|---|---|
| `tests/performance.test.ts`（15 項） | 選項表、各種網址與 App 內的預設、保存與讀回、不合法的保存值、`localStorage` 丟錯、套用；匯入關係檢查：`src/performance.ts` 與 `src/brain.ts` 的執行期匯入不會碰到聲音、即時語音、語音、喚醒、處理中音效、心跳、API 或 `main` 模組 |
| `tests/brain-performance.test.ts`（8 項） | 假 rAF：完整、平衡、省電每秒格數不超過 30／20／12 且在上限 5% 內；減少動態仍是 10；畫布尺寸隨解析度上限即時改變；光脈衝上限與切換時裁掉多餘的；省電時作用中腦區仍畫出區名、光脈衝與腦區光暈，且不用 `shadowBlur` |
| `tests/performance-settings-view.test.ts`（9 項） | 瀏覽器與 App 兩種設定畫面、中英文都顯示這一段；點選項會呼叫套用；實測數字更新；新字串都有英文 |
| 全部 | `npm run typecheck` 通過；`npx vitest run` 137 個檔案、2487 項通過、5 項略過；`npm run build` 通過；`node scripts/verify-aios.mjs` PASS |

## 未驗證

- Pi 4 上實際的每秒格數、CPU 與溫度改善沒有量測。
- 沒有在真的瀏覽器看過：關閉模糊後的文字可讀性、簡化光暈的樣子。
- Pi kiosk 專用 profile 裡 `localStorage` 的保存沒有實測。
- 「不影響對話流暢度」目前只靠程式結構（只改繪製、匯入關係檢查）支持，沒有量測。

## Pi 實測步驟（待 George 執行）

1. 在 Pi 頁面說或點「設定」，找到「這台裝置的畫面效能」，記下目前選項（第一次應為「平衡」）與實測數字。
2. 依序選「完整」「平衡」「省電」，每個停 1 分鐘，記下實測每秒格數與每格毫秒；同時在 Pi 執行 `top`、`vcgencmd measure_temp`，記 Chromium 的 CPU 與溫度。
3. 選最順的那一檔，開一通 10 分鐘即時語音，記錄斷續、延遲與回應速度，和之前比較。
4. 重開 Pi，確認選擇還在。
5. 結果填入 [Pi 測試報告](../experiments/RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md) 的量測表備註欄。
