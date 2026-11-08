<!-- bilingual: source=zh-TW -->

> [繁體中文](20_TV_Netflix_Playback_Plan_2026-11.md) | [English](20_TV_Netflix_Playback_Plan_2026-11.en.md)

# 20 電視 Netflix 播指定節目：規劃（未實作）

日期：2026-11-08（Asia/Taipei）。狀態：**只是規劃，還沒有實作**。George 2026-11-08 問 Netflix 能不能像 YouTube 一樣播指定節目，決定先寫成文件記錄，之後再做。

前置批次：[LGTV-1](validation/lgtv-1-2026-11-07.md)（電視連線與基本控制）、[LGTV-2](validation/lgtv-2-2026-11-08.md)（YouTube 播指定影片）。目前說「用 Netflix 播《某影集》」時，Nous 只會開 Netflix App，並照實說無法直接播。

## 1. 問題拆解

播指定節目分兩步，Netflix 兩步的狀況不同：

| 步驟 | YouTube（LGTV-2） | Netflix |
|---|---|---|
| 送片：把一部片送到電視播放 | `contentTarget`，LGTVG3 已實機驗證 | 有社群流傳的啟動參數，**官方沒有公開，也還沒在 G3 實測** |
| 找片：從片名找到片子的編號 | 官方 YouTube Data API | **沒有官方 API**；抓網站資料違反使用條款 |

## 2. 已知資訊與來源（2026-11-07 查核）

- **送片參數（社群做法）**：`system.launcher/launch`，帶 `{id: "netflix", contentId: "m=https://www.netflix.com/watch/<titleId>&source_type=4"}`。`titleId` 是 Netflix 網址裡的數字（`netflix.com/title/81234567` 或 `netflix.com/watch/81234567`）。
  - 這個參數只出現在社群討論，例如 lgtv2 的 issue #25 與 Home Assistant 社群論壇，Netflix 與 LG 都沒有公開文件；`source_type=4` 也只見於社群範例。
  - LGTVG3 的 `play_netflix` 用的就是這個參數，但它的 README 寫明 Netflix 深層連結「尚未在實機測試」。
  - 韌體或 Netflix App 更新後可能失效。
- **官方 API**：Netflix 的公開 API 已經停止服務，目前沒有給個人使用的片庫查詢或播放 API。
- **條款**：Netflix 使用條款禁止用機器人、爬蟲或其他自動方式存取 Netflix 服務。在官方 App 裡打開一部片不算爬蟲，但 Netflix 沒有背書這種做法；從網站抓片名對應編號則屬於條款禁止的做法。
- **LG 深層連結規格**：LG 開發者論壇的說法是要走合作夥伴管道（Seller Lounge），文件受保密協議約束，個人開發者拿不到。

## 3. 可行做法

| 做法 | 說明 | 優點 | 風險與限制 |
|---|---|---|---|
| A. 給網址或編號 | 使用者說「用 Netflix 播這個」並給 Netflix 網址；Nous 解析出 `titleId` 後送片 | 簡單；不用找片 | 參數是社群做法、要實測；語音很難念網址，比較適合從手機或文字貼上 |
| B. 自己的片單 | Mac 本機放一份「片名 → Netflix 網址」的清單（例如 `<configDir>/netflix-titles.json`）；使用者說片名，Nous 從清單比對後送片 | 能用片名播；不違反條款（清單是使用者自己建的） | 新片要先加進清單；送片參數同樣要實測 |
| C. 開到搜尋頁 | 開 Netflix → 用遙控鍵移到搜尋框 → 用 `com.webos.service.ime/insertText` 打字 → 停在搜尋結果，由使用者用遙控器選 | 不需要編號；任何片都能試 | 依賴 Netflix 的畫面配置，改版就會壞；只能開到結果頁，不能確認播放 |

**建議**：做法 A 與 B 合成一批（暫稱 LGTV-3）；做法 C 等 A 實測後再決定要不要做。

## 4. 開工前要先在家實測

在 Mac 上對電視送一次社群參數，確認是否真的能開到指定的片：

1. 在 Netflix 網站找一部片，記下網址裡的數字（`titleId`）。
2. 用 LGTVG3 的指令試：`lgtv netflix <titleId>`。或者等 LGTV-3 做出測試指令再試。
3. 記錄結果：
   - 是直接開始播放，還是停在該片的介紹頁？
   - 會不會先出現「誰在觀看」的設定檔選擇畫面？選完後片子還在嗎？
   - 用 `netflix.com/title/` 和 `netflix.com/watch/` 的數字，結果有沒有不同？

實測結果決定做法：
- **成功開到該片**（播放或介紹頁都算）：做 A＋B。
- **只能開 Netflix、沒有開到該片**：A、B 都不做，改評估 C。

## 5. LGTV-3 的設計草案（A＋B）

- 新工具 `app.tv.play_netflix`：
  - 參數 `url`（Netflix 網址）與 `title`（片名）二選一。
  - 給 `title` 時，只從本機片單比對；片單沒有就回「片單裡沒有這部」，不去網路上找。
- 新工具 `app.tv.netflix_list_add`（可選）：把目前說的片名和網址加進片單。片單只存在 Mac 本機，不進 repo。
- 回讀：
  - 只能確認前景是 Netflix，無法確認播的是哪一部，所以最多回 `unconfirmed`（「已送出，請看一下電視」）。
  - 如果 `com.webos.media/getForegroundAppInfo` 在 Netflix 上也回 `playing` 與媒體 ID，再比照 YouTube 的回讀規則。這要實測才知道。
- 電視沒開時先開機；不出確認卡，沿用 George 2026-11-08 的決定。
- 說話規則：Netflix 播放要說清楚是「社群做法」。結果是 `unconfirmed` 時，請使用者看一下電視。

## 6. 要 George 決定的事（開工前）

1. 片單怎麼維護：手動編輯本機檔案，還是用語音加片（「把這部加進 Netflix 片單」）？
2. 送片停在介紹頁、沒有直接播時，要不要再按一次遙控器的確認鍵？按錯畫面可能做別的事，建議先不要。
3. 做法 C（開到搜尋頁）要不要做？

## 7. 其他串流平台

Disney+、Prime Video、Apple TV 等同樣沒有公開的深層連結，社群資料也比 Netflix 少。目前維持只開到 App；之後如果要做，同樣先在家實測，再比照本文件規劃。

## 8. 參考

- LGTVG3：<https://github.com/pcpcchen-coder/LGTVG3>（`play_netflix`，尚未實機驗證）
- 社群做法：<https://github.com/hobbyquaker/lgtv2/issues/25>、<https://community.home-assistant.io/t/has-anyone-figured-out-how-to-automate-playing-something-on-netflix-e-g-on-a-samsung-smart-tv/498399>
- Netflix 使用條款：<https://help.netflix.com/legal/termsofuse>
- LG 開發者論壇（深層連結走合作夥伴管道）：<https://forum.webostv.developer.lge.com/t/how-to-implement-deep-linking-and-add-content-to-lg-webos-tv/24869>
