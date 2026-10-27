<!-- bilingual: source=en -->

> [繁體中文](design-a.zh-TW.md) | [English](design-a.md)

<a id="candidate-a-renderer-distance-input"></a>
# 候選 A：renderer 距離輸入

此候選沿用上層模型，不宣稱模型多樣性。

<a id="caller-usage"></a>
## 呼叫端用法

既有雙目控制器仍是唯一的距離轉縮放政策來源。同一回呼同時驅動 DOM zoom 與電子腦。沒有手動設定或持久化數值。

```ts
const sense = new SenseController({
  ...hooks,
  setScale(scale) {
    document.documentElement.style.setProperty('--distance-scale', String(scale));
    brain.setDistanceScale(scale);
  },
});
brain.setState(nextVisualState); // Does not overwrite the last measured scale.
// Existing off/error/degraded/absence events already call setScale(1).
```

<a id="data-shape-and-signatures"></a>
## 資料形狀與簽章

```ts
class Brain {
  private distanceScale = 1;
  setDistanceScale(scale: number): void { throw new Error('not implemented'); }
  private target(layout = this.state.layout): { cx: number; cy: number; r: number } {
    throw new Error('not implemented');
  }
}
```

`distanceScale` 是 renderer 輸入，與頻繁替換的 `BrainVisualState` 分開。`SenseController` 負責轉換、0.75–1.5 邊界、在場過濾與重設時機。Setter 接受此有界純量，避免一般視覺狀態更新重設它，並只在縮放改變時更新待機 CSS 半徑。非有限值可回復為 1，不必另定一套距離轉縮放映射。不引入通用設定 store 或新的公開縮放政策。

`target(layout)` 是唯一的私有幾何計算。建構、動畫與 resize 都使用它。Renderer 狀態保存投影、標籤、特效與 hitTest 使用的動畫中心／半徑。公開介面只有一個 setter，呼叫端不需自行協調 resize、target 與命中幾何。

<a id="geometry-and-fit-policy"></a>
## 幾何與適配政策

要求的半徑為 `min(width,height) * LAYOUT[layout].r * distanceScale`。

Center 版面中心維持 `(width/2,height*.47)`。Top 版面中心為 `(width/2,height*.12*distanceScale)`，對應既有縮放面板的實際中心高度項。

以中心周圍保守的 1.7 倍半徑包絡限制半徑，取要求半徑、水平空間／1.7、垂直空間／1.7 的最小值。該包絡大於含呼吸效果的 1.62×1.018 軌道範圍，已自行提供邊緣餘量；額外加 12px 頂部邊距會在 top 模式不必要地截斷要求因子。受限顯示器的有效半徑可能在 scale 1.5 前停止成長。既有距離值與 DOM zoom 不變。記錄此視覺適配上限，不宣稱所有視窗都精確呈現 1.5 倍增長。

只在建構、縮放或視窗改變後，以 `--brain-r` 發布有效 center 版面半徑。`--brain-top-r` 維持未縮放基準。既有 `.surface-root` 父層 zoom 已乘上完整 top 位置；再次乘該變數會疊加面板間距。Top 版面電子腦的中心與半徑各只套用一次因子。

Canvas 維持滿視窗及既有 DPR 處理。不使用 CSS scale、不反向映射點擊，也不改感測量測／過濾。HitTest 在過渡中持續使用與繪製相同的動畫半徑。

<a id="bounded-surrounding-layout"></a>
## 有界的周邊版面

待機 CTA 與指令位置使用有效 `--brain-r`，並以視窗安全上限限制其 top 位置。一個 CSS CTA 錨點即可供按鈕及下方彙整活動文字共用。在短橫向視窗保留既有指令表單至少 120px 的空間，並以實際 bounding box 驗證。

以既有 body view class 配置來源文字。待機來源文字在 CTA 下方，輸入時的來源文字可放頂部狀態列，top／settings 文字可用單行省略但保留完整 DOM 文字。既有對話定位保持獨立。明確的狀態寬度可避免 shrink-to-fit 造成半螢幕換行。不以段落必為單行的假設推定空間充足。

以量測文字寬度及視窗邊距限制活動 Canvas 標籤，字級至少 12px。DOM 保留完整來源描述。如此可處理放大電子腦標籤，不必引入標籤定位引擎。

既有鏡頭驅動父層 zoom 在此功能之前就可能使設定面板超出小螢幕。驗證並標明是否為既有行為；除非妨礙本次控制項使用，否則不進行通用距離 UI 重設計。

<a id="module-map-and-ownership"></a>
## 模組分工與所有權

- `main.ts` 擴充既有 setScale hook，呼叫 renderer。
- `brain.ts` 負責縮放輸入、有效幾何、CSS 待機半徑發布及有界標籤。
- `style.css` 維持待機控制項可操作，保留父層距離 zoom。
- 重點測試斷言原生可見半徑／命中行為、重新 render 後保留縮放，以及重設事件。

不需改 server、鏡頭管線、共用感測契約、套件、儲存或手動控制項。

<a id="alternatives-and-red-flags"></a>
## 替代方案與警訊

把 `distanceScale` 放入 `BrainVisualState` 會要求 main 保存它、在感測事件呼叫 render，並在每次後續 render 傳入。呼叫端若漏傳，就會讓圖形重設，而 DOM zoom 仍保留最後量測。專用 setter 隱藏這個生命週期差異。

每個動畫影格讀 CSS 自訂屬性會讓 renderer 依賴 DOM 字串，並重複計算樣式。Mutation observer 又新增一段生命週期。兩者都沒有比明確回呼更好的所有權。

Renderer 純量是使用的輸入，不是第二套距離政策。唯一幾何計算為私有。CSS 半徑是衍生輸出。不新增持久化、反向座標路徑、額外布林或第二個 renderer。Model the Domain 將量測輸入與視覺狀態更新分開；Laziness Protocol 保留既有投影與感測生命週期。

<a id="verification-contract"></a>
## 驗證契約

瀏覽器 fixture 透過真鏡頭管線邊界及實際 main／controller hook，發出合成近距離 1.5m、參考 2m、遠距離 3m 事件。觀察新的原生 Canvas 影格，不能只看 CSS 變數。驗證未達上限時 default<far、near<default、宣告的適配上限、center／top 對齊、反覆視覺 render、resize／DPR、縮放後點擊範圍、六個活動標籤，以及 UI／狀態邊界。

測試 present+null，以及 off／error／degraded／true-to-false absence 重設為 1。保留目前 60s 無人語意。使用標示 fixture 的截圖及來源／建置雜湊。這些 fixture 不驗證實體雙目準確度，也不驗證真鏡頭權限／裝置行為。
