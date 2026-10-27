<!-- bilingual: source=en -->

> [繁體中文](ground.zh-TW.md) | [English](ground.md)

<a id="stereo-distance-and-brain-sizing"></a>
# 雙目距離與電子腦大小

<a id="overview"></a>
## 概觀

目前雙目管線已產生一個有界距離縮放，感測不可用時也會重設。`main.ts` 只將此縮放套用到 DOM 內容。電子腦使用滿視窗 Canvas 與獨立動畫半徑，因此目前忽略距離。

<a id="how-it-works"></a>
## 運作方式

`src/sense/processor.ts:46–61` 從左右眼三角定位鼻子與肩膀，取深度中位數，再傳入 `PresenceTracker`。`src/sense/trackers.ts:7–60` 的 tracker 要求 500ms 才進入在場狀態，偵測消失後保留 60s 在場，保存 9 筆距離樣本，並只回報至少 10cm 的變化。沒有新深度時可保留先前中位數，不會每影格立即重設。

`src/sense/controller.ts:42–45` 將距離對應為 `clamp(distanceM/2,0.75,1.5)`，null 對應為 1。`SenseController.handle` 在第 68 行對 present 事件呼叫既有 `setScale` hook。在第 64 行在場轉為 false 時，或第 82–88 行感測狀態既非 `ok` 也非 `starting` 時，呼叫 `setScale(1)`。因此 `off`、`error`、`degraded` 已會重設，`starting` 則刻意不重設。

`src/main.ts:479` 目前實作該 hook 時只寫入 `--distance-scale`。第 517–527 行 `syncCamera` 啟停管線，其回呼把每個事件傳給 `sense.handle`。第 118–125 行 `SensePipeline.stop` 發出 `sensor:off` 後發出無人在場；第 111–114 行啟動失敗發出 `sensor:error`。所以真鏡頭 off／error／degraded 事件與距離變化會走到同一個重設 hook。

`src/brain.ts:194–196` 只依視窗與 `LAYOUT` 計算中心與半徑。第 418–422 行動畫將 `cx`、`cy`、`radius` 移向該目標。第 434–480 行的節點投影、特效、標籤及環都使用動畫半徑。第 190–191 行 `hitTest` 也用相同半徑，所以更新目標半徑即可讓點擊幾何保持一致，不需 CSS transform 或反向指標映射。

<a id="dom-placement-and-native-css-evidence"></a>
## DOM 定位與原生 CSS 證據

`src/style.css:13–14` 分別定義待機與 top 基準半徑。第 80、125、853、867 行待機字幕、指令、開始按鈕與狀態使用 `--brain-r`。第 248–276 行設定／進度 surface 的 top 與 max-height 計算使用 `--brain-top-r`。第 982–985 行 `.surface-root` 與 `.subtitle` 接受 `zoom:var(--distance-scale,1)`。

1280×900 的隔離原生 Chromium 探針使用完全相同的 surface 規則，沒有修改應用程式或 repo。

| 設定 | 面板實際 top | 實際寬度 |
| --- | ---: | ---: |
| scale 1，原始基準半徑 |217.34px|780px|
| scale 1.5，原始基準半徑 |326.02px|1170px|
| scale 1.5，top CSS 半徑再乘 1.5 |394.53px|1170px|

原始 top 計算為 `.12×900 + .07×900×1.45 +18 =217.35`。Scale 1.5 的實際 top 是整個式子再乘 1.5。盲目再次乘上 `--brain-top-r` 會疊加半徑項。

狹窄而一致的整合方式，可保留 top CSS 半徑基準，把既有縮放同時套用到 top 版面電子腦中心高度及半徑，center 版面高度維持 47vh。如此 top 電子腦與縮放面板可維持既有間距。`--brain-r` 只供待機使用，因此可獨立追蹤縮放後待機半徑，不會讓 top 面板二次縮放。

<a id="where-things-live"></a>
## 檔案分工

- `src/sense/processor.ts`、`trackers.ts`、`controller.ts` 負責量測、穩定及既有縮放／重設政策。
- `src/main.ts` 負責連接感測、DOM 與電子腦的縮放 hook。
- `src/brain.ts` 負責動畫幾何與點擊定位。
- `src/style.css` 負責待機控制項及已縮放內容面板。

<a id="gotchas-and-bounded-next-change"></a>
## 注意事項與有界下一步

將既有 hook 接到 renderer 距離縮放輸入，並讓其值跨一般 `setState` render 保留。沿用 0.75–1.5 範圍與重設事件。不重新引入 localStorage 或手動縮放控制。

Center scale 1.5 時，未受限半徑為視窗較小邊的 30%。`brain.ts:564` 軌道達 1.62R，第 438 行再加 1.8% 呼吸。中心高度保持 47%，所以保守包絡可能超出視窗上方。驗證實際可見幾何或明確限制適配，不能只從百分比推定。

第 349–380 行活動標籤位於腦外，沒有視窗限制。放大半徑可能在窄螢幕裁切標籤。待機控制項仍用舊固定偏移，若尺寸不跟隨有效幾何，就可能與放大電子腦重疊或超出短視窗。Top 控制項已有父層 zoom，因此改定位前先量測實際邊界。

驗證一般與 top 版面、近／基準／遠距離、null／off／error／degraded 重設、一般狀態更新、resize、實際 Canvas 半徑及點擊範圍。瀏覽器 fixture 可在外部感測邊界模擬事件，但不能證明 AR0144 準確度或實體鏡頭行為。

本次唯讀盤點未觀察到低額度警告或百分比。
