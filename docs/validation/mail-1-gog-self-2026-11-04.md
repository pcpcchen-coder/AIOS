<!-- bilingual: source=zh-TW -->

> [繁體中文](mail-1-gog-self-2026-11-04.md) | [English](mail-1-gog-self-2026-11-04.en.md)

# MAIL-1 用 gog 寄信給自己驗證

日期：2026-11-04（Asia/Taipei）。分支：`claude/mail-1-gog-self`（基於 main `8eb53b2`）。架構沿用 [18 App Integration Layer](../18_App_Integration_Layer_and_Spotify_2026-11.md)。

**George 的決定（2026-11-04）**：用 [gog](https://github.com/steipete/gogcli)（MIT）寄 Gmail；收件人和寄件人都是 George 自己；**寄給自己每次不用確認，直接寄**。產品紅線預設「寄出」要當次確認，這是 George 明確決定的例外，只適用 `app.mail.send_to_self` 這一個工具，寫在 `server/integrations/policy.ts` 的 `CONFIRMATION_EXEMPT_TOOLS`。其他會寄出、發布、付費的工具仍然要確認。

**沒有在 Mac、真實 gog 或 Gmail 上執行過。** 雲端沒有 gog，測試用注入的假 runner，以及一支假的 gog 腳本（真的 `spawn`、不經 shell）。信箱都是虛構的。`gog gmail send --json` 的輸出欄位官方 README 沒寫（2026-11-04 查核），郵件 ID 的欄位名稱是寬鬆比對，要在 Mac 上核對。

## 1. 交付內容

路徑都在 `prototype/ambient-shell/`。

| 檔案 | 內容 |
|---|---|
| `server/integrations/adapters/gmail-gog.ts`（新） | `gmail_gog` Adapter，提供一個模型工具 `app.mail.send_to_self`，參數只有 `subject`、`body`，沒有收件人。執行 `gog gmail send --account=<自己> --to=<自己> --subject=<主旨> --body-file=- --json`：用 `spawn` 參數陣列，不經 shell；旗標一律寫成 `--flag=value`；內文經 stdin，不出現在程序參數；stderr 不讀不記；主旨去掉換行等控制字元，避免標頭注入。結果：結束代碼 0 且讀到郵件 ID 才是 `confirmed`；結束代碼 0 但沒有 ID 是 `unconfirmed`；非 0 是 `unknown`（gog 可能在 Gmail 收下之後才出錯，不能說沒寄出，也避免重寄）；gog 沒能啟動是 `failed`；逾時（30 秒）或中止由 Dispatcher 回 `unknown`，子行程先送 SIGTERM，2 秒後還在就 SIGKILL。因為不出確認卡，另外限制每分鐘最多 5 封。健康檢查跑 `gog --version` |
| `server/integrations/policy.ts`、`dispatcher.ts` | `CONFIRMATION_EXEMPT_TOOLS`：每一項都寫明誰、哪天、為什麼；`decide` 只對清單上的工具 ID 放行 |
| `server/integrations/index.ts` | 已審核的 Adapter 加入 `gmail_gog`。沒有 `NOUS_MAIL_SELF` 或找不到 gog 時不註冊，照實記 log |
| `server/config.ts` | 只有 `NOUS_AIL_SERVICES` 列出 `gmail_gog` 時才讀 `NOUS_MAIL_SELF`（必須是 email）和 `NOUS_GOG_PATH`（必須是絕對路徑，可省略；省略時找 `/opt/homebrew/bin/gog`、`/usr/local/bin/gog`） |
| `src/views.ts`、`src/messages.en.json`、`server/messages.en.json` | 設定頁「App 整合」加上「寄信給自己（Gmail，gog）」，並註明「可用」只代表 gog 能執行，有沒有登入 Gmail 要看寄信結果；中英雙語 |

給模型的工具清單裡沒有你的信箱，結果訊息也不帶信箱或內文。

## 2. 測試（fixture）

新測試檔 `tests/integration-mail-gog.test.ts`，15 項：

- 主旨的換行、C1 控制字元與雙向文字覆寫字元被清掉（`Bcc:` 注入無效）；長度截斷；內文統一換行。
- 參數一律是 `--flag=value`；主旨寫成 `--to=other@…` 也只是主旨文字，收件人永遠是設定的自己。
- 郵件 ID 的幾種 JSON 形狀都讀得到；不是 JSON、ID 含空白時讀不到。
- 有 ID 是 `confirmed`；內文只走 stdin，不在參數裡；結果不含信箱與內文。
- 沒有 ID 是 `unconfirmed`；非 0 是 `unknown`；找不到 gog 或沒有執行權限是 `failed`；中止時交給 Dispatcher（回 `unknown`）；主旨清完是空的就拒絕。
- 每分鐘最多 5 封，第 6 封拒絕且不呼叫 gog，一分鐘後恢復。
- 真的 spawn：非 0 結束是 `unknown`；不理 SIGTERM 的假 gog 在中止後被 SIGKILL，不留殘餘行程。
- 健康檢查：能執行是可用；找不到是不可用；非 0 是狀態不明。
- **真的 spawn 假 gog 腳本**：主旨裡的 `$(touch pwned)`、反引號、`;` 原封不動傳成參數（沒有經過 shell）；內文的 `$HOME` 原樣從 stdin 收到。
- 政策：只有 `app.mail.send_to_self` 免確認，其他 `external_commit` 仍要確認。
- 設定：沒有列出 `gmail_gog` 時不讀信箱；信箱或 gog 路徑不合法就報錯。
- 經整合層：沒有信箱就不註冊；模型只看到 `subject`、`body`；Dispatcher 不出確認卡直接執行；模型多塞 `to` 參數會被 Schema 拒絕，不執行。

指令與結果（2026-11-04，Linux 雲端、Node.js 22）：

- `npm run typecheck`：通過。
- `npx vitest run`：134 個檔案，2,455 項通過、5 項跳過。
- `node scripts/verify-aios.mjs`：PASS；`git diff --check`：通過。

## 3. 在 Mac 上的設定與驗證步驟（尚未執行）

1. **安裝 gog**：`brew install openclaw/tap/gogcli`（官方 README 寫法；不行時試 `brew install steipete/tap/gogcli`）。
2. **建立 Google OAuth client**（只做一次）：在 Google Cloud Console 建專案、啟用 Gmail API、建立「桌面應用程式」類型的 OAuth client，下載 `client_secret_….json`，然後執行 `gog auth credentials set ~/Downloads/client_secret_*.json`。
3. **只授權寄信**（最小權限）：`gog auth add <你的 Gmail> --services gmail --gmail-scope send`。
4. **手動確認一次格式**：先跑 `gog gmail send --help`，確認 `--account`、`--to`、`--subject`、`--body-file`、`--json` 都在。再執行：
   `echo 測試 | gog gmail send --account=<你的 Gmail> --to=<你的 Gmail> --subject=MAIL-1測試 --body-file=- --json`
   記下輸出裡郵件 ID 的欄位名稱（只記欄位名，不要記內容）。如果不是 `id`、`messageId`、`message_id` 其中一個，告訴我，我改比對規則。
5. **設定 Nous**：在 `.env` 加上 `NOUS_AIL=on`、`NOUS_AIL_SERVICES=gmail_gog`（已經有其他服務就用逗號加在後面）、`NOUS_MAIL_SELF=<你的 Gmail>`。gog 不在 Homebrew 的位置時，再加 `NOUS_GOG_PATH=<which gog 的結果>`。然後重新啟動 Nous。
6. **看狀態**：打開設定頁，「App 整合」應該顯示「寄信給自己（Gmail，gog）：可用」。
7. **用語音寄**：兩條即時語音路徑各說一次「寄封信給我，提醒我明天帶傘」，確認收件匣有信，Nous 說「信已寄到你的 Gmail」。
8. **失敗路徑**：拔掉網路再要求寄一次；Nous 不能說已經寄出，應該說失敗或結果不明。
9. **確認沒有外洩**：Nous 的 log 只有「整合層」的狀態代碼，沒有信箱、主旨或內文。
10. **回退**：從 `NOUS_AIL_SERVICES` 拿掉 `gmail_gog`，重新啟動。要撤銷 Google 授權，執行 `gog auth remove <你的 Gmail>`，或在 Google 帳戶的「第三方存取權」移除。

## 4. 獨立審查與修正

同一個模型的獨立審查（不是跨模型審查）：沒有阻擋項，2 項中度、6 項低度。修了：非 0 結束從 `failed` 改成 `unknown`（避免說沒寄出、模型又重寄）；補上雙語現況文件；中止後 SIGKILL 寬限；任何沒能啟動的錯誤都是 `failed`；清掉 C1 控制字元與雙向覆寫字元；每分鐘 5 封的上限；刪掉沒用到的常數；補真 spawn 的非 0 與中止測試、`decide` 對其他 effect 不變的測試。沒有改的：設定錯誤與 log 只有中文，和既有的 Adapter 一致。

## 5. 「自己寄給自己」有沒有更簡單的做法

| 做法 | 設定成本 | Nous 能不能確定寄出 | 評語 |
|---|---|---|---|
| **gog（本批）** | 一次 Google Cloud OAuth client（約 10–15 分鐘）＋`gog auth add` | 能：有郵件 ID 才算寄出 | 可靠、權杖留在鑰匙圈，Nous 不碰 |
| macOS「郵件」App（AppleScript） | 如果「郵件」App 已經登入你的 Gmail，幾乎不用設定；要允許 Nous 控制「郵件」 | 不能：只知道交給了「郵件」App，結果最多 `unconfirmed` | 最省設定，但寄沒寄出要自己看 |
| Gmail SMTP＋應用程式密碼 | 要開兩步驟驗證、產生應用程式密碼並放進 `.env` | 能（伺服器回 250） | 這個專案不加套件，要自己寫 SMTP 用戶端；密碼長期有效，風險比 OAuth 高 |
| 不寄信：存成 Nous 的成果，或寫進「提醒事項」／「備忘錄」 | 成果紀錄已經有；「提醒事項」要另寫 Adapter | 能 | 如果目的只是「記下來給自己看」，這最簡單 |

**建議**：要「真的收到 email」，gog 是最簡單又能確認結果的做法，設定只做一次。如果你常用 Mac 的「郵件」App 而且不想設 Google Cloud，可以另做 AppleScript 版，但 Nous 只能說「已交給郵件 App」。如果只是想記事，用 Nous 的成果或「提醒事項」更直接。

## 6. 限制與未完成

- 沒有在 Mac、真實 gog 或 Gmail 上執行；第 3 節都還沒做。
- 郵件 ID 的欄位名稱是假設的，第 3 節第 4 步要核對。
- 只能寄給自己，沒有附件、HTML、回覆或讀信。
- 健康檢查只確認 gog 能執行，不確認 Gmail 登入。
- 逾時、中止或 gog 回報錯誤時，信可能已經寄出，Nous 只會說「結果不明，請確認」。

## 7. 下一個 gate

George 在 Mac 完成第 3 節並留下去識別的紀錄後，才能宣稱「Nous 能用語音寄信給自己」。
