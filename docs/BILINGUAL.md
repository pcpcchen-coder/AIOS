<!-- bilingual-inline -->
# 中英文文件與介面規範 / Bilingual documentation and interface policy

## 繁體中文

此規範是使用者於 2026-10-26 的明確要求，適用所有在此 repo 工作的 Agent 與開發者。

1. 新增或修改專案說明文件時，在同一批變更提供完整繁體中文與英文；章節、表格、限制、風險、驗證證據與操作步驟都要對應。摘要不能替代完整翻譯。
2. 現有中文文件維持原路徑，英文檔使用 `name.en.md`；英文原稿搭配 `name.zh-TW.md`。短篇規範可在同一檔完整列出兩種語言，並加入 `<!-- bilingual-inline -->`。兩份文件頂端須有互相對應的語言連結。
3. 修改任何一版時同步修改另一版。命令、程式碼、檔名、API 識別字、數字、日期與原始證據保持原意及可執行性。產品原文引述可以保留；不可把「提案」「fixture」「未校準」「待實機驗證」翻成已完成。
4. 英文文件連到英文對應頁；沒有對應翻譯的程式或證據檔仍連原檔。翻譯標題時保留原章節的錨點，讓既有連結有效。文件入口為 [繁體中文索引](README.md) 與 [English index](README.en.md)。
5. 新增或修改 App、網頁文字時，使用共用翻譯表，同時處理按鈕、狀態、設定、錯誤、選單、對話框與無障礙標籤。保留使用者自行輸入、模型回覆、任務內容、姓名、設備名稱與識別字，不以翻譯介面為由改寫這些資料。
6. 預設繁體中文，提供可見的 English／繁體中文切換入口，保存選擇。兩版沿用同一套行為與權限檢查。介面語言與歷史成果語言不同，切換時不改寫已保存成果。
7. 執行 `node scripts/check-bilingual-docs.mjs`，檢查覆蓋、相互連結與內容指紋。完整審閱並同步後才執行 `node scripts/check-bilingual-docs.mjs --record` 更新 `docs/bilingual-manifest.json`，再重跑檢查。指紋只提醒文件已變動，不能證明翻譯語意正確。
8. `vendor/` 的固定第三方文件與其註冊符號連結保留原樣；不翻改原始日誌、JSON 證據、依賴清單、程式註解或 HTML 設計樣稿。它們的解說與驗證紀錄仍要提供雙語。工作目錄外的私人規劃也不屬於 repo 文件。

## English

This policy records the owner's explicit request of 2026-10-26. It applies to every agent and developer working in this repository.

1. Deliver complete Traditional Chinese and English versions whenever you add or update project documentation. Match all sections, tables, limitations, risks, evidence, and procedures in the same change. A summary does not replace a full translation.
2. Preserve existing Chinese paths and use `name.en.md` for English companions. Pair English originals with `name.zh-TW.md`. Short policies may contain both complete languages in one file marked `<!-- bilingual-inline -->`. Put reciprocal language links at the top of each pair.
3. Update both versions together. Preserve commands, code, filenames, API identifiers, quantities, dates, and the meaning and usability of evidence. Product quotations may stay in their original language. Never translate a proposal, fixture, uncalibrated threshold, or pending hardware check into a completed capability.
4. Link English documents to their English companions where available. Keep links to untranslated code and raw evidence. Retain original section anchors when translating headings so existing references remain valid. Start at the [Traditional Chinese index](README.md) or [English index](README.en.md).
5. Use the shared localization catalog for new or changed App and web copy, including buttons, status, settings, errors, menus, dialogs, and accessible labels. Preserve user input, model responses, task content, names, device names, and identifiers. Interface localization must not rewrite those data.
6. Default to Traditional Chinese, expose an English / 繁體中文 language control, and remember the selection. Both languages use the same behavior and permission checks. Changing the interface language does not rewrite saved artifacts.
7. Run `node scripts/check-bilingual-docs.mjs` to check coverage, reciprocal links, and content fingerprints. Only after reviewing and synchronizing both versions, run `node scripts/check-bilingual-docs.mjs --record` to refresh `docs/bilingual-manifest.json`, then rerun the check. Fingerprints detect changes, not translation quality.
8. Preserve pinned third-party documents in `vendor/` and their registered symlinks. Raw logs, JSON evidence, dependency manifests, code comments, and HTML design mockups are not translated. Their project explanations and validation records still need both languages. Private planning outside the repository is outside this policy's scope.
