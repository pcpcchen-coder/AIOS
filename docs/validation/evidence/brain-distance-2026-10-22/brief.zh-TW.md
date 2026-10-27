<!-- bilingual: source=en -->

> [繁體中文](brief.zh-TW.md) | [English](brief.md)

<a id="stereo-distance-brain-rendering"></a>
# 雙目距離驅動電子腦繪製

使用者授權把電子腦圖形的實際大小接到既有雙目鏡頭距離縮放，並明確要求 pstack。工作樹從乾淨的 16dc63c 開始。先前的手動縮放功能已明確放棄。不新增滑桿、手動偏好、使用者控制項或持久化縮放。既有 distanceScale 將 D/2 公尺對應到 0.75–1.5，預設 1，並在無距離、鏡頭不可用或無人在場時重設。保留其行為及所有感測隱私 gate。

目標是以同一批真實距離事件驅動實際 Canvas 電子腦的半徑、環／脈衝及一致的點擊範圍。保留六區視覺、語音／確認流程與鏡頭預覽。支援 center／top 版面、既有 resize／DPR 與減少動態效果。代表性的桌機、筆電及行動裝置視窗都要可用。距離因子只套用一次；.surface-root 與 .subtitle 既有 CSS zoom 不得透過定位變數再次相乘。除非候選方案有充分理由，否則不以 CSS scale 縮放整個視窗 Canvas，也不另改指標座標。

由一位負責人處理原型程式／測試。瀏覽器驗證者只擁有新增的可重用 scripts/verify-distance-brain-browser.mjs 與暫存證據。根代理負責文件與 pstack recorder。幾何檢查必須觀察新影格中的原生 Canvas 繪製與原生指標輸入，不能只看 dataset 或舊影格樣本。感測 fixture 只放在鏡頭管線邊界，並標示合成距離。不證明真鏡頭／AI／帳號，src 中不得有原始影像像素讀回。瀏覽器 fixture 必須走實際 main SenseController hook；不得直接設定 Brain 內部狀態或 CSS scale 來聲稱事件接線成功。實體雙目量測準確度仍是獨立 gate。

簡化限制是新增狹窄的 renderer 距離縮放輸入，以及經證據確認必要的最少版面調整。不重建手動縮放架構，也不新增通用偏好／活動 store。先命名資料形狀。測試近距離 1.5m=.75、參考 2m=1、遠距離 3m=1.5，以及重設條件、反覆非感測 render、版面與 resize。Renderer 可讓幾何符合螢幕，但不得改變 distanceScale 既有 DOM 語意；必須回報有效視覺上限。設計中須明確決定裁切／適配方式，不能只盲目相乘半徑。

額度規則是任何可見額度低於 5% 就停止。未提供額度 API，也未觀察到低額度警告。減少不必要的分工及重跑全套測試。根代理負責公開經清理的任務中繼資料（run run-20261022010402-0fb7c0），委派代理不得發布。
