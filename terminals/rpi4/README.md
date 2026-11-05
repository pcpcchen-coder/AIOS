<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# Raspberry Pi 4 終端套件（RPI-1）

狀態：**有套件，未經 Pi 實機驗證**（2026-11-03）。腳本只在 Linux 容器內以假的 `systemctl`、`ssh`、`apt-get` 等指令跑過 dry-run 測試與 shellcheck；Pi 上的安裝、開機自動啟動、聲音與鏡頭都還沒有實測紀錄。

## 這是什麼

Mac mini 照常開 **Nous App**（Electron），Agent、即時語音後端與資料都留在 Mac 的 App 核心。Raspberry Pi 4 只當終端：螢幕、麥克風、喇叭，之後再加鏡頭。

```text
Pi Chromium ──http://localhost:<AIOS_PORT>──> Pi 127.0.0.1:<AIOS_PORT>
   ──SSH local forward (autossh)──> Mac 127.0.0.1:<AIOS_PORT> ──> Nous App core
```

- 核心只聽 `127.0.0.1`，不對區域網路開放。Pi 經 SSH 轉送連到 Mac 的 loopback。
- Pi 的 Chromium 開的是 `http://localhost`，屬於安全情境，所以 `getUserMedia`（麥克風、鏡頭）可用。
- `server/http-guard.ts` 只接受 `localhost:<核心實際 port>` 與 `127.0.0.1:<核心實際 port>`。因此 **Pi 本機 port 必須等於 Mac 核心的 port**；套件用同一個設定 `AIOS_PORT` 決定兩端。不要為了連線而關掉或放寬這個檢查。

套件內容：

| 檔案 | 用途 |
|---|---|
| `install.sh` | 一鍵安裝：套件、設定檔、SSH key、主機指紋驗證、systemd --user 服務、桌面自動啟動 |
| `uninstall.sh` | 解除安裝與回復；`--purge` 另刪設定、key 與 Chromium profile |
| `terminal.conf.example` | 設定檔範本，不含私人值 |
| `bin/aios-tunnel` | autossh 通道（`aios-tunnel.service` 執行） |
| `bin/aios-kiosk` | 等核心可用後開 Chromium 全螢幕（`aios-kiosk.service` 執行） |
| `bin/aios-session-start` | 桌面登入時把顯示環境交給 systemd，再啟動 `aios-kiosk.service` |
| `bin/aios-doctor` | 診斷，逐項輸出 PASS／WARN／FAIL／SKIP |
| `systemd/`、`autostart/` | 使用者服務與桌面自動啟動檔 |
| `tests/dry-run.sh` | 容器內可跑的 dry-run 測試（假指令），CI 與 `scripts/verify-aios.mjs` 都會跑 |

## Mac 端準備

1. 開 Nous App，確認在 Mac 上可正常使用（登入、文字、即時語音）。
2. 打開「遠端登入」：系統設定 → 一般 → 共享 → 遠端登入，只允許你自己的帳號。
3. 固定核心 port。編輯 `~/Library/Application Support/Nous/.env`，把 `# PORT=8787` 改成 `PORT=8787`，再重開 App。App 啟動時如果 8787 已被占用（例如另外在跑 `npm start`），核心會自動改用別的空閒 port（`server/nous.ts` 的 `fallbackPort`）。
4. 查核心實際 port，兩種方法擇一：

```bash
grep 'Nous 原型已啟動' "$HOME/Library/Application Support/Nous/nous.log" | tail -n 1
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

第一行會印出 `http://localhost:<port>`。`lsof` 也可能列出 ChatGPT 登入用的 1455，以 log 裡的網址為準。若不是 8787，查是誰占用：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

5. 記下 Mac 的 SSH 主機指紋，安裝時要比對：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

6. 測試期間讓 Mac 不睡眠（系統設定 → 能源，或執行 `caffeinate -d`）。

## Pi 端安裝

需求：Raspberry Pi OS **64-bit Desktop**、HDMI 螢幕、USB 麥克風、喇叭；建議有線網路、主動散熱、穩定電源。

把 repo（或只要 `terminals/rpi4` 資料夾）放到 Pi 上，用桌面帳號（不是 root）執行：

```bash
cd AIOS/terminals/rpi4
bash install.sh
```

安裝程式會：

1. 以 `sudo apt-get` 安裝 `chromium`（舊映像是 `chromium-browser`）、`autossh`、`openssh-client`、`v4l-utils`、`alsa-utils`、`curl`。
2. 詢問 Mac 使用者、Mac 主機名或 IP、Mac 核心 port、SSH port，寫入 `~/.config/aios-terminal/terminal.conf`（權限 600）。
3. 產生專用 SSH key `~/.config/aios-terminal/id_ed25519`。沒有密碼，因為 autossh 要在無人值守時連線。
4. 用 `ssh-keyscan` 取得 Mac 主機金鑰並顯示指紋。**只有和 Mac 上第 5 步的指紋完全一樣才輸入 `yes`**。通過後寫入專用的 `~/.config/aios-terminal/known_hosts`；之後一律用 `StrictHostKeyChecking=yes`，不使用 `StrictHostKeyChecking=no`。
5. 用 `ssh-copy-id` 把公鑰加到 Mac（會問一次 Mac 密碼），再以免密碼方式驗證登入。
6. 安裝 `aios-tunnel.service` 與 `aios-kiosk.service` 到 `~/.config/systemd/user/`，桌面自動啟動檔到 `~/.config/autostart/aios-kiosk.desktop`，指令連結到 `~/.local/bin/`。
7. 以 `sudo loginctl enable-linger` 讓使用者服務開機就跑（只在原本沒開時才開，並記下是安裝程式開的，解除安裝時才會關回去）。
8. 啟動並設定開機啟動 `aios-tunnel.service`。

無人值守安裝（例如重灌後）可以用環境變數與 `--non-interactive`；指紋必須事先從 Mac 取得：

```bash
AIOS_MAC_USER=george AIOS_MAC_HOST=mac-mini.local AIOS_PORT=8787 \
AIOS_MAC_HOSTKEY_SHA256='SHA256:...' bash install.sh --non-interactive
```

其他選項：`--skip-apt`（不裝套件）、`--skip-copy-id`（公鑰已在 Mac 上）、`--help`。重跑安裝會收斂到同一狀態，不會重複寫入；改了 port 或主機時，安裝程式會重啟通道（kiosk 若在執行也會重啟），新設定立即生效。

### 開機自動進入終端畫面

1. `sudo raspi-config` → System Options → Boot / Auto Login → **Desktop Autologin**。
2. `sudo raspi-config` → Display Options → Screen Blanking → 關閉，避免螢幕自己變黑。
3. 重開機。桌面登入後，自動啟動檔執行 `aios-session-start`，把 `DISPLAY`／`WAYLAND_DISPLAY` 交給 systemd，再啟動 `aios-kiosk.service`。kiosk 會等 `http://localhost:<AIOS_PORT>/api/settings` 回應後才開 Chromium。

`aios-kiosk.service` 沒有設成開機啟動，因為它需要桌面工作階段；Raspberry Pi OS 的 Wayland 桌面不一定會啟動 `graphical-session.target`，所以改由桌面自動啟動檔觸發。兩個服務都設定 `Restart=always`，崩潰會自動重開。

### Chromium 旗標

kiosk 用 `--kiosk --app=http://localhost:<AIOS_PORT>/?terminal=rpi4`（`terminal=rpi4` 讓頁面每 10 秒向核心送心跳，Mac 選單列據此顯示 Pi 是否連線）、獨立 profile（`~/.local/share/aios-terminal/chromium-profile`），以及 `--autoplay-policy=no-user-gesture-required`，讓提示音與回覆不必先點一下就能播放。套件**不使用** `--use-fake-ui-for-media-stream` 之類自動允許鏡頭／麥克風的旗標。第一次使用麥克風時，Chromium 會問一次，請用滑鼠按「允許」；選擇存在獨立 profile 裡。

## 診斷

```bash
aios-doctor
```

逐項輸出 `PASS`、`WARN`、`FAIL` 或 `SKIP`，任何 `FAIL` 時結束碼為 1。檢查項目：設定檔、SSH key 與 known_hosts、`aios-tunnel.service`、Pi 本機 `127.0.0.1:<port>` 是否在聽、核心 `GET /api/settings`（核心沒有 `/api/health`，不印出回應內容）、頁面 `GET /`、Mac SSH port 可否連線、`aios-kiosk.service`、Chromium、麥克風（`arecord -l`）、喇叭（`aplay -l`）、鏡頭（`v4l2-ctl --list-devices`，不計 Pi 內建的 bcm2835／rpivid 編解碼節點，沒有只算 WARN）、溫度（70 °C 起 WARN、80 °C 起 FAIL）、`vcgencmd get_throttled`（目前低電壓或降頻為 FAIL，開機後曾發生為 WARN）、可用記憶體（低於 15% 為 WARN）、預設網路路由。輸出語言跟著 `LANG`，也可設 `AIOS_LANG=en` 或 `AIOS_LANG=zh-TW`。

<a id="service-mode"></a>
## Mac 服務模式

用 Pi 時，在 Mac 選單列選「進入服務模式（給 Pi 使用）」：Mac 電子腦隱藏，Mac 的麥克風、常駐喚醒與鏡頭停止（設定不變），核心、登入與背景任務繼續給 Pi 使用。App 重開後仍維持服務模式。選單列最上面顯示「服務模式：Pi 已連線」或「服務模式：Pi 已斷線」；這只看 Pi 頁面的心跳（25 秒內有心跳才算連線），不看服務模式開關。選「返回 Mac 使用」切回本機，喚醒與鏡頭照原本設定恢復。細節與 Mac 驗收步驟見[服務模式驗證](../../docs/validation/service-mode-2026-11-03.md)（**未經 Mac 與 Pi 實機驗證**）。

## 日常操作

```bash
systemctl --user status aios-tunnel.service aios-kiosk.service
systemctl --user restart aios-tunnel.service aios-kiosk.service
journalctl --user -u aios-tunnel.service -u aios-kiosk.service -n 100
```

Mac 核心 port 改了：編輯 `~/.config/aios-terminal/terminal.conf` 的 `AIOS_PORT`，再重啟兩個服務。

## 解除安裝與回復

```bash
bash uninstall.sh
bash uninstall.sh --purge
```

`uninstall.sh` 停用並移除兩個服務、自動啟動檔、指令連結與安裝的腳本；若 linger 是安裝程式開的就關回去。設定、key 與 Chromium profile 預設保留，`--purge` 才刪除。它不移除 apt 套件，也不碰 Mac：畫面會印出移除套件的指令，以及從 Mac 的 `~/.ssh/authorized_keys` 刪掉含這台 Pi 公鑰那一行的指令（以公鑰內容比對，不用註解，因為每台 Pi 預設主機名都是 `raspberrypi`）。Mac 端要回復，另外在「共享」關掉遠端登入，並把 `.env` 的 `PORT` 改回註解。

<a id="known-limitations"></a>
## 已知限制（RPI-1 不修）

- **記憶、加密成果、家人辨識只給 App 主視窗。** 這些內容只經 Electron 主視窗的 IPC 傳送；SSE 與 `/api/*` 只給外殼。Pi 的瀏覽器頁面可以交辦任務、看到進度外殼與即時語音，但看不到受保護成果的內容，也沒有記憶與家人辨識功能。
- **鏡頭是嚴格模式。** App 核心以 `cameraEnable: "main_process"` 啟動：頁面經 HTTP 送 `active: true` 一律 403，鏡頭只能在 Mac 的 App 選單打開，而且打開的是 Mac 主視窗的鏡頭流程。Pi 頁面不能經 HTTP 打開鏡頭。
- **喚醒聆聽的開關只在 Mac 的 App 選單**，但每個頁面各自用自己的麥克風聽（2026-11-05 更正）：開關存在核心，經設定事件推給所有頁面，Pi 頁面收到後就用 Pi 的麥克風在 Pi 本機偵測「Hello Nous」／「Hey Nous」，喚醒後在 Pi 開始通話。Pi 頁面喚醒時不認聲音（喚醒認聲音要 Mac App 的家人辨識），所以不會以聲音叫名字。
- **Mac 主視窗與 Pi 頁面同時連同一個核心**（依程式碼閱讀，未經實機確認）：
  - SSE：核心以 client 對照表廣播，兩個頁面都收到同樣的任務與設定事件，各自更新畫面。
  - 即時語音，依路徑不同：
    - ChatGPT 方案的通話進行中：另一邊開始任何通話都會被拒絕，開始的回應是 HTTP 200 加上 `ok: false` 與「忙線」（`session_busy`）。
    - 帶記憶規則的 API key 通話進行中：同樣拒絕。
    - 不帶記憶的 API key 通話進行中：另一邊再開始 API key 通話時，核心會**直接結束原本那通**，不顯示忙線；另一邊若開始 ChatGPT 方案通話，兩通可能同時進行。
    - 每通由開始它的頁面擁有，回覆聲音只在那個頁面播放。
  - Mac 沒進服務模式時，Mac 與 Pi 會同時聽喚醒詞，說一次可能兩邊都被叫醒、搶同一通語音；Mac 上的「看著說話」也可能從 Mac 開始一通。
  - 記憶撤銷時的強制靜音只作用在 Mac 主視窗。
  - 建議：用 Pi 時在 Mac 進入[服務模式](#service-mode)，Mac 就不會收音、喚醒或開始語音。
- Pi 端不跑 Agent、不存任務資料。Mac 睡眠或 App 結束時，Pi 畫面就沒有核心可連。kiosk 只在開 Chromium 之前等核心；Chromium 已經開著時不會自己結束，恢復要靠頁面本身的重新連線，必要時執行 `systemctl --user restart aios-kiosk.service`。
- `aios-doctor` 的喇叭檢查只看有沒有播放裝置；接著 HDMI 的 Pi 一定有 HDMI 聲音裝置，所以 PASS 不代表 USB 喇叭已接上或已選為輸出，請看輸出裡列出的裝置名稱。

<a id="rpi-2-draft"></a>
## RPI-2 規劃草案：受信任的 Pi 終端配對（未實作）

目標：讓 Pi 頁面在 George 明確配對後，取得目前只給 App 主視窗的功能，而不放寬 `http-guard.ts` 或讓核心聽區域網路。

1. **配對碼。** George 在 Mac App 選單選「配對終端…」，核心產生一次性 6 位數配對碼（例如 2 分鐘有效、錯 5 次作廢），Mac 視窗顯示碼與終端名稱欄位。Pi 頁面輸入配對碼後，核心以原生對話框請 George 在 Mac 上再確認一次。
2. **可撤銷的終端憑證。** 配對成功後核心發一個隨機終端憑證（只存雜湊，綁定終端名稱與建立時間），Pi 存在 kiosk 專用 profile。每個請求或 SSE 連線帶憑證。App 選單列出已配對終端，可個別撤銷；撤銷後立即斷開該終端的 SSE 與通話。
3. **經核心的權限。** 依 George 選擇逐項授權，預設全部關閉：
   - 記憶：讓已配對終端經核心 HTTP（而非 IPC）讀寫記憶，沿用同意、本次人物、撤銷與停播規則；停播靜音需改成通知該終端頁面。
   - 加密成果：核心在已配對終端請求時解密並只回該終端，沿用 MEM-4c 的明文生命週期。
   - 鏡頭：讓終端在 Mac 確認後打開「自己的」鏡頭，影像只在 Pi 瀏覽器內分析；原始影像不寫檔、不外傳的紅線不變。
   - 喚醒：讓終端在 Mac 確認後開啟 Pi 麥克風的常駐喚醒聆聽。
4. **主視窗與終端的協調。** 決定同一時間由哪個裝置收音與播報（例如最後一個有人在場的裝置優先），避免兩邊同時開始語音。
5. **George 要決定的事：**
   - 終端能不能用記憶與加密成果，或只開鏡頭與喚醒。
   - 配對碼有效時間、憑證是否要定期過期。
   - Mac 主視窗與 Pi 同時在場時誰優先。
   - 家人辨識（臉、聲音）要不要在 Pi 上做，模型與 runtime 是否要搬到 Pi。
   - 是否接受 Pi 上的 kiosk profile 存放終端憑證（Pi 遺失時要從 Mac 撤銷）。
