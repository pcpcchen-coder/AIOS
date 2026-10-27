<!-- bilingual: source=en -->

> [繁體中文](judgment.zh-TW.md) | [English](judgment.md)

<a id="distance-brain-design-cross-judgment"></a>
# 距離電子腦設計交叉評估

選擇 A，專用 renderer 距離輸入。兩個候選都沿用上層模型；這是獨立審查，不是模型多樣性。

每項標準以 0–2 作質性評分。

| 標準 | A | B |
| --- | ---: | ---: |
| 單一既有距離政策與重設路徑 | 2 | 2 |
| 感測輸入生命週期可跨無關狀態更新保留 | 2 | 2 |
| 實際 renderer、命中定位與 DPR 一致 | 2 | 2 |
| 不重複 top CSS zoom 且視窗適配有界 | 1 | 1 |
| 最小範圍且沒有手動偏好 | 2 | 1 |
| 合計 | 9 | 8 |

A 將既有 SenseController hook 接到單一 renderer setter。它保留量測輸入，不需感測事件重繪無關 DOM，也不要求每個視覺快照產生端多帶欄位。B 在所有地方都必填欄位時也一致，但在這個狹窄任務中新增 main 純量與 render 呼叫，沒有新增使用者行為。不要合併兩個 API。

Model the Domain 傾向將量測輸入與經常替換的任務／音訊視覺狀態分開。Laziness Protocol 傾向 A 的既有回呼邊界與較小呼叫端變更。

兩候選對有用的幾何細節已一致，無需拼接。Top 版面中心與半徑縮放一次，在已縮放面板內保留未縮放 top CSS 半徑，並只發布有效待機半徑。保留既有距離轉換、重設語意、感測過濾及隱私邊界。

沒有已證實的設計阻礙實作。視窗適配分數維持 1，直到實際建置 Canvas、原生點擊範圍、活動標籤及周邊控制項被驗證。Prove It Works 要求新的原生影格，不能只看縮放變數。既有遠距手機面板寬度溢出是基準父層 CSS 行為；應另行回報，不要靜默把功能擴成距離 UI 重設計。

只有在回歸證據證明一般 setState 更新保留最後距離，以及 null／off／error／degraded／absence 事件透過真控制器 hook 同時重設 DOM 與電子腦後，才接受 A。螢幕適配上限可能限制有效 Canvas 成長，但不改既有 DOM 距離因子；必須清楚回報此區別。
