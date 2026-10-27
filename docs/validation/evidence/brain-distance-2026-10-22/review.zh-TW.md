<!-- bilingual: source=en -->

> [繁體中文](review.zh-TW.md) | [English](review.md)

<a id="independent-distance-scaling-review"></a>
# 距離縮放獨立審查

結果是在相對 `16dc63c` 審查的變更中，未發現已證實的正確性缺陷。本次為唯讀審查，未修改 repo 檔案。

<a id="reviewed-behavior"></a>
## 已審查行為

- 既有 SenseController 距離因子及 null／absence／off／error／degraded 重設路徑，現透過真 main.ts hook 驅動 Brain setter。Starting 如原本一樣保留先前因子。
- 距離與視覺快照分開保存，跨一般 setState 更新保留。
- Top 版面中心與半徑只套用一次因子；既有父層 CSS zoom 保留原輸入變數。
- 幾何以 1.7 軌道適配範圍限制要求半徑。現有 1.62 軌道包絡含 1.018 呼吸，仍位於範圍內。
- 投影與公開 hitTest 都使用實際動畫半徑。Resize 保留距離因子，DPR 影響 backing resolution 而非 CSS 幾何。
- 新增 Canvas 標籤限制與 DOM 活動定位保留來源文字，並避開已檢查的視窗／控制項邊界。
- 已知基準遠距手機設定面板因既有父層 CSS zoom 而寬度溢出，超出本次範圍，不回報為新缺陷。

<a id="independent-validation"></a>
## 獨立驗證

從 prototype/ambient-shell 執行：

`npx vitest run tests/brain-distance.test.ts tests/sense-controller.test.ts tests/brain-regions.test.ts`

結果為 3 個檔案、35 項測試通過（945 ms）。測試涵蓋實際繪製幾何、公開 hitTest、重設路徑、快照保留、top 版面、視窗適配、resize 與 DPR。Prove It Works 促成執行這些測試；Test Behavior, Not Implementation 促成檢查可見幾何與公開命中結果。

已檢視瀏覽器 harness 原始碼，包含原生 Canvas 觀察、外部管線 fixture 邊界、資產雜湊、重設／resize／DPR／命中範圍案例，以及 DOM／來源標籤檢查。我沒有獨立執行該 harness，也沒有檢查其截圖。此審查不建立實體雙目準確度、真帳號／AI 行為或麥克風／喇叭行為證據。瀏覽器 harness 使用減少動態效果，以取得確定性幾何；非減少動態的內插則以原始碼檢視。

<a id="scoped-comment-audit"></a>
## 限定範圍的註解稽核

只檢查新增註解。已審查的產品／測試新增及瀏覽器 harness 中沒有新註解。沒有刪除、恢復或重寫註解；不建議任何刪除或 MUST KILL 標記。既有註解未動。未發現新增抑制註解或限制編碼。稽核重跑次數為 0。

<a id="reviewed-sha-256"></a>
## 已審查 SHA-256

- prototype/ambient-shell/src/brain.ts: `8d8768e2eaa5db9fe9497bb1eda2b52835105c9a2502c917a8b6b4a6ec805f61`
- prototype/ambient-shell/src/main.ts: `08d6db650879bbc7b7ab99b17966e94f1c55de1b23e11dcc18304202b9b2e8f7`
- prototype/ambient-shell/src/style.css: `d73dadb8efafb2547b316590ed4c9a0b3e5e1b92c423a0b448bada2707edb753`
- prototype/ambient-shell/tests/brain-distance.test.ts: `f906e8a5de66bb2f279397c98d73ba39524d15d7053345c7edbd1a88f885b4c7`
- prototype/ambient-shell/tests/brain-regions.test.ts: `d6b22a66cb2d4e50332c1373f0371c648338ab3d5ddd2fdaa770cb1ba78ebd95`
- scripts/verify-distance-brain-browser.mjs: `6f50537e4c5efb347e26f59b2a729a81cdf76a1035d54da0016daae471b2e40e`

產品及重點測試雜湊與負責人最終來源一致。瀏覽器腳本在原審查期間有改動；已重新閱讀上列雜湊對應的內容。瀏覽器驗證發現近距離 top 狀態重疊 1.42px 後，另審查最終純 CSS 後續修正。共用 --surface-top 錨點保留三個既有面板定位／高度公式，top 狀態使用該錨點乘距離因子再減 24px。明確的 18px line-height 在所有測試因子下都於面板前保留 6px 間隙。未發現其他已證實問題。其他審查雜湊不變。上述重點測試結果早於此純 CSS 後續修正；本審查者沒有追加測試或瀏覽器執行。

<a id="final-browser-harness-timestamp-follow-up"></a>
## 最終瀏覽器 harness 時戳後續審查

已審查最終完整 harness，SHA-256 為 `963d1367239fbc4520d22a606de72732df08f703d52bb1827ccb67db433786d1`，取代上列早期雜湊。原生 ellipse 觀察在呼叫真 Canvas 方法之後記錄 performance.now()。每次幾何請求記錄起始影格，以及同一瀏覽器效能時鐘的時戳。輪詢排除不晚於任一請求標記的觀察及重複影格，然後要求第二個新且不同的影格，其半徑與中心穩定。回傳證據包含兩個穩定影格時戳及請求標記。因此時戳檢查強化新鮮度，不取代實際繪製，也不改 app 狀態。未發現已證實問題或新增註解。本審查者未修改產品／測試，也未追加測試執行。根代理回報最終六組瀏覽器測試皆通過；本後續只獨立審查 harness 原始碼。
