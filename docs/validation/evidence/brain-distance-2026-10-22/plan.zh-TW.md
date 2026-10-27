<!-- bilingual: source=en -->

> [繁體中文](plan.zh-TW.md) | [English](plan.md)

<a id="feature-plan"></a>
# 功能計畫

Run: run-20261022010402-0fb7c0

- [x] 對受影響子系統執行 how。
- [x] 以 architect 平行探索設計。
- [x] 阻擋性的前置步驟。在寫程式前追蹤既有鏡頭距離、縮放 hook、Canvas 半徑、hitTest 與重設路徑。
- [x] 獨立工作線。唯讀設計、原型實作、瀏覽器證據與文件分別擁有不同檔案。
- [x] 共用可變狀態。既有 SenseController 維持唯一距離縮放來源；單一程式負責人修改原型。
- [x] 最小安全拆分。單一實作者將既有距離縮放接到既有 renderer；沒有手動縮放偏好。
- [x] 以設定的 feature 模型委派子代理寫程式。
- [x] 在對應介面驗證。307 項測試、型別／建置／mock HTTP，以及六組合成距離 Chromium 檢查通過。
- [x] Rebase 成小型有序 commits。略過，這是單一工作樹功能，未要求 commit。
- [x] 設計有爭議時執行 interrogate。略過，兩候選與評審都同意專用 renderer 輸入。
- [x] 開 PR。略過，未要求。
