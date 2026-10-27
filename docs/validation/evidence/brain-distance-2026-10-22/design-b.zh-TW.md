<!-- bilingual: source=en -->

> [繁體中文](design-b.zh-TW.md) | [English](design-b.md)

<a id="candidate-b-distance-in-the-complete-visual-snapshot"></a>
# 候選 B：完整視覺快照中的距離

與另一候選沿用相同上層模型，不宣稱模型多樣性。

<a id="caller-first-usage"></a>
## 先看呼叫端用法

量測的在場事件設定一個由 main 擁有的距離因子。下一個完整視覺快照將因子連同版面、對話及任務活動一起傳入。一般任務／音訊更新也包含相同的目前因子。既有控制器重設事件將它設回 1。

```ts
let sensedScale = 1;
const sense = new SenseController({
  ...existingHooks,
  setScale(scale) {
    sensedScale = scale;
    document.documentElement.style.setProperty("--distance-scale", String(scale));
    render();
  },
});
function render() {
  brain.setState({ ...existingVisualFields, distanceScale: sensedScale });
}
```

<a id="types-and-ownership"></a>
## 型別與所有權

```ts
export interface BrainVisualState {
  // Existing fields remain required as today.
  distanceScale: number;
}
interface BrainTarget { cx: number; cy: number; r: number }
function brainTarget(width: number, height: number, state: BrainVisualState): BrainTarget {
  throw new Error("not implemented");
}
```

`SenseController` 保留 D/2m、0.75–1.5 政策及重設語意。Main 擁有最新感測因子。`Brain` 只擁有完整視覺快照與內插幾何。此欄位必填，包含初始狀態，避免一般 setState 靜默把距離設回 1。沒有 localStorage 或 UI 偏好。

當所有繪製輸入都應位於同一快照時，Model the Domain 傾向此形狀。Renderer 不匯入感測控制器，也不逐影格讀 CSS。輸入已由內部控制器限制，renderer 不應新增距離映射政策。

<a id="geometry-applied-once"></a>
## 幾何只套用一次

Center 版面維持 `cy=.47H`，要求 `r=.2*min(W,H)*distanceScale`。必要時只適配實際 Canvas 半徑，以保守 1.7R 軌道包絡涵蓋現有 1.62R 軌道與 1.8% 呼吸。保留要求的感測因子供 DOM 縮放。投影、環、脈衝及 hitTest 繼續使用相同動畫半徑。

Top 版面要求 `cy=.12H*distanceScale` 與 `r=.07*min(W,H)*distanceScale`。既有父層 CSS zoom 已縮放面板 top。在已縮放的面板內，`--brain-top-r` 維持基準；再乘一次會產生 ground.md 已證實的雙重定位。只有實際軌道將超出視窗時才套用螢幕適配上限。不新增獨立指標轉換。

Renderer 可在距離／狀態／視窗改變時，以 `--brain-r` 發布有效待機半徑，並從同一 target 函式衍生。Top CSS 半徑不縮放，因為它在 CSS zoom 內被使用。此明確區分比通用版面／偏好子系統更小。

<a id="bounded-layout-policy"></a>
## 有界版面政策

待機 CTA 與指令位置跟隨有效待機半徑，並維持視窗安全上限。共用 CTA 錨點可讓活動狀態位於其下，明定 90vw／760px 寬度。輸入時狀態可放頂部，top／settings 狀態用單行但保留完整 DOM 文字。保留對話既有專屬定位。

Canvas 標籤保留既有最低字級，依量測文字把位置限制在視窗內。不為了隱藏溢出而縮字。以手機直向、橫向檢查遠距縮放及六區同時活動。

既有 CSS zoom 本身就可能在 1.5 時讓面板寬／最大高度超過手機視窗。這是量測 gate，不是改變距離政策的理由。若實際邊界證實控制項不可操作，就在既有 CSS 規則中一次補償面板可用視窗寬／高，不重複乘 renderer 半徑或重建呈現狀態。

<a id="comparison-with-a-dedicated-setter"></a>
## 與專用 setter 比較

| 形狀 | 優點 | 代價 |
| --- | --- | --- |
| 完整快照 | 單一 renderer 更新路徑；必填欄位避免隱藏預設；狀態 fixture 描述完整畫面。 | 感測事件新增 main 純量與 render 呼叫；每個快照產生端／測試都必須包含 scale。 |
| 專用 setDistanceScale | 既有感測 hook 直接更新 renderer，不重繪無關 DOM。 | Renderer 有第二個狀態輸入，未來 setState 實作須刻意保留它。 |

兩者皆可。如果專案希望所有視覺輸入都建模於 BrainVisualState，候選 B 較合適。對這個狹窄功能，Laziness Protocol 可能偏好專用 setter，因為既有感測 hook 已是邊界，距離不必重建無關視圖。不要拼接兩個 API。

<a id="verification-and-red-flags"></a>
## 驗證與警訊

瀏覽器證據必須在鏡頭管線邊界注入，並執行實際 main／controller 接線。觀察兩個新的原生 Canvas 影格，再比較近 1.5m／參考 2m／遠 3m 幾何、點擊定位、top／center 版面、resize 及反覆無關 render。Null、absence、off、error、degraded 都須回復 1。Starting 保留既有控制器政策。發布的 CSS 幾何與已縮放面板實際邊界分別測試。

Prove It Works 要求實際建置頁面截圖，以及原生指標／Canvas 觀察。Fixture 不證明 AR0144 準確度或真鏡頭行為。未見額度百分比或低額度警告。

警訊檢查結果是，一個 main 純量與必填完整快照可避免兩個獨立寫入端；一個 target 計算避免重複半徑政策。Setter 加快照欄位會產生兩條互相競爭的更新方式。通用偏好 store、第二套距離轉換或 CSS-scale 指標映射會擴大介面，卻沒有相稱效益。
