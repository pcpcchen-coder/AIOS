<!-- bilingual: source=en -->

> [繁體中文](RPI4_REMOTE_TERMINAL_TEST_PLAN.zh-TW.md) | [English](RPI4_REMOTE_TERMINAL_TEST_PLAN.md)

# Raspberry Pi 4 遠端終端 — 週末測試計畫

狀態：**實驗／尚未經實機驗證**。2026-11-03 更新為使用 RPI-1 Pi 終端套件。  
套件：[`terminals/rpi4/`](../../terminals/rpi4/README.md)（安裝、服務、`aios-doctor`、解除安裝）。  
架構（George，2026-11-03）：**Mac mini 開 Nous App＋Raspberry Pi 4 Chromium 終端**。  
目標：把螢幕、麥克風、喇叭，之後再加鏡頭，移到 Pi；Agent、即時語音後端與資料留在 Mac mini 的 Nous App 核心。

## 範圍與非目標

- 不把 AIOS 後端搬到 ARM64。
- 不改核心行為、`server/http-guard.ts`、秘密資料，也不改核心只聽 loopback 的設定。
- 記憶、加密成果內容與家人辨識只經 IPC 給 App 主視窗；Pi 頁面只看到外殼。鏡頭（嚴格的 `main_process` 模式）與喚醒聆聽只能在 Mac 的 App 選單打開。這些是已記錄的限制，不算測試失敗；見套件的[已知限制](../../terminals/rpi4/README.md#known-limitations)。
- 不把核心開放到區域網路，也不關閉 `server/http-guard.ts`。

## 硬體與前置條件

- Mac mini：已安裝並可正常使用 Nous App（登入、文字、即時語音），「遠端登入」只對你自己的帳號開啟。
- RPi 4：Raspberry Pi OS **64-bit Desktop**，建議有線網路、主動散熱、穩定電源。
- RPi：HDMI 螢幕、USB 麥克風、喇叭或耳機；USB 鏡頭只在第 3 階段需要；一支滑鼠，用來按一次麥克風權限。
- 兩台機器在可信任的區域網路。記錄 Pi 記憶體（2／4／8 GB）、OS、瀏覽器版本、麥克風與鏡頭型號。
- **不要**提交 `.env`、OAuth 憑證、`terminal.conf`、SSH key、個人聲音或影像、私人 IP 位址。

## 第 0 階段 — Mac mini 開 Nous App

1. 在 Mac 上開 Nous App，先確認登入、一則文字需求與一通短的即時語音在 Mac 本身都正常，再來檢討 Pi。
2. 固定核心 port：在 `~/Library/Application Support/Nous/.env` 設 `PORT=8787`，重開 App。不要同時從 checkout 跑 `npm start`；它會占走 8787，App 就會改用別的 port。
3. 確認核心實際 port：

```bash
grep 'Nous 原型已啟動' "$HOME/Library/Application Support/Nous/nous.log" | tail -n 1
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

4. 記下 SSH 主機指紋，Pi 安裝時要比對：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

5. 整個測試期間讓 Mac 保持清醒。核心依設計只聽 `127.0.0.1`。

**通過：** App 在 Mac 上可用；log 裡的網址顯示你要填進 Pi 設定的 port。

## 第 1 階段 — Pi 套件安裝、通道與 kiosk（P0）

在 Pi 上用桌面帳號執行：

```bash
cd AIOS/terminals/rpi4
bash install.sh
aios-doctor
```

1. 回答提問（Mac 使用者、Mac 主機名或 IP、第 0 階段查到的 Mac 核心 port、SSH port）。指紋提問時，只有和第 0 階段第 4 步一致才輸入 `yes`。
2. `aios-doctor` 的設定、SSH key、通道服務、本機 port、核心 `/api/settings`、頁面 `/` 應為 PASS。記下完整輸出。
3. 在 `sudo raspi-config` 設定 Desktop Autologin、關閉 Screen Blanking，然後重開機。登入後 kiosk 會全螢幕開 `http://localhost:<port>`。
4. 刻意中斷通道一次（`systemctl --user kill aios-tunnel.service`），並拔 Pi 網路線 30 秒一次；記錄頁面多久恢復可用。

**通過：** 重開機後不用打字，kiosk 就載入頁面，UI 有反應，設定與文字 Agent 可用，沒有 403 Host／Origin 錯誤，通道會自己恢復。**失敗：** 空白頁、瀏覽器 JS 例外、跨來源或 403 錯誤、kiosk 一直沒開、重連迴圈。截圖時先移除秘密資訊。

為什麼可行：瀏覽器看到的是 localhost（getUserMedia 需要的安全情境）；SSH 把 Pi `127.0.0.1:<port>` 轉到 Mac `127.0.0.1:<port>`；HTTP guard 只在 `<port>` 是核心實際 port 時接受 `localhost:<port>`，所以兩端共用 `AIOS_PORT`。通道不保證功能與 Mac 相同。

## 第 2 階段 — Pi 聲音與雲端即時語音（P0）

1. 在 Raspberry Pi OS 把 Pi 接的 USB 麥克風與喇叭選為系統輸入／輸出。`aios-doctor` 應列出兩者。
2. 在 kiosk 用滑鼠為 `http://localhost:<port>` 允許一次麥克風權限。套件不使用自動允許的旗標。
3. 在 Pi 頁面測試喇叭輸出、麥克風音量與 AIOS 的聲音裝置選擇。
4. 在 Mac 選單列選「進入服務模式（給 Pi 使用）」，Mac 就不會收音或占走通話。30 秒內選單列應顯示「服務模式：Pi 已連線」。照[服務模式驗證](../validation/service-mode-2026-11-03.md)跑 Mac gate。
5. 在 Pi 開始即時語音。連續說話 10 分鐘，再 30 分鐘。
6. 確認 AI 回覆在 **Pi** 播放，不在 Mac；中斷並重新連線三次。
7. 同時連線檢查：Pi 通話中時，試著在 Mac 視窗開始通話；記錄發生什麼事。依程式碼閱讀的預期：ChatGPT 方案路徑，或帶記憶規則的 API key 路徑，第二通會被當成忙線（`session_busy`）拒絕；不帶記憶的 API key 路徑，第二通會直接結束第一通。再反過來做一次。
8. 同時在 Mac 跑一般桌面工作，記下明顯干擾。

**通過：** 收到 Pi 麥克風、Pi 喇叭出聲、提示音不用先點就會播、30 分鐘對話沒有持續中斷；沒有誤用 Mac 麥克風或喇叭。**觀察：** 首次回應延遲、雜音次數、CPU、溫度、記憶體。

注意：雲端模型運算仍在遠端；本機收音、編碼與瀏覽器 UI 會用到 Pi CPU。語音驗證與工作階段建立仍在 Mac 核心。

## 第 3 階段 — 鏡頭、喚醒詞、身分（P1，選做）

1. 把 USB 鏡頭接到 Pi；`aios-doctor` 會列出（或執行 `v4l2-ctl --list-devices`）。
2. 試著從 Pi 頁面打開鏡頭（診斷會略過 Pi 內建的編解碼節點，只列真的鏡頭）。依程式預期：被拒絕（HTTP 403），因為 App 核心是嚴格鏡頭模式。記錄 PASS／FAIL／NOT SUPPORTED，不要繞過。
3. 檢查 Pi 頁面是否有喚醒控制。預期：喚醒只能從 App 選單打開，而且聽的是 Mac 的麥克風。記錄結果。
4. 檢查 Pi 頁面的記憶與家人辨識。預期：瀏覽器頁面沒有。記錄結果。
5. 只有上面某項意外可用時才正式測：20 次喚醒＋20 句負例；鏡頭＋語音 10 分鐘。

**通過：** 每一項都明確記成 PASS／FAIL／NOT SUPPORTED。不降低隱私保護，不退回明文。這些缺口屬於 RPI-2（受信任終端配對）。

## 觀測

Pi：
```bash
aios-doctor
uname -m
free -h
uptime
vcgencmd measure_temp
vcgencmd get_throttled
top
journalctl --user -u aios-tunnel.service -u aios-kiosk.service -n 100
```

Mac：
```bash
top -l 1 -o cpu | head -n 20
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

使用[報告範本](RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md)。在閒置、即時語音、鏡頭＋即時語音時各記一次。記錄通道中斷與重連情形。不要把下列目標當成量測結果。

### 建議驗收目標

| 指標 | 目標 |
|---|---|
| 頁面 | 重開機後 kiosk 自動開啟並接受文字需求 |
| 聲音 | 30 分鐘對話，沒有持續雜音 |
| Mac 周邊隔離 | Pi 工作階段沒有用到 Mac 的麥克風、鏡頭或喇叭 |
| Pi 溫度 | 沒有持續的過熱降頻 |
| Pi 記憶體 | 沒有 OOM；峰值最好低於 85% |
| 穩定性 | 2 小時使用加 8 小時閒置（方便時）；通道會自己恢復 |
| 安全 | 核心維持只聽 loopback；SSH 主機驗證沒有關掉 |

## 疑難排解

- **`aios-doctor` 的核心 `/api/settings` FAIL：** Nous App 有開嗎？Mac 醒著嗎？`~/.config/aios-terminal/terminal.conf` 的 `AIOS_PORT` 是否等於 Mac log 裡的 port？改完執行 `systemctl --user restart aios-tunnel.service aios-kiosk.service`。
- **403 host／origin：** Pi 本機 port 和核心實際 port 不同。修正 `AIOS_PORT`；不要關掉 guard。
- **通道服務一直重啟：** 看 `journalctl --user -u aios-tunnel.service`。「Host key verification failed」表示 Mac 主機金鑰變了，重跑 `install.sh` 並再比對一次指紋。「Permission denied」表示 key 不在 Mac 的 `authorized_keys`，不加 `--skip-copy-id` 重跑。
- **登入後 kiosk 沒開：** 檢查 Desktop Autologin、`~/.config/autostart/aios-kiosk.desktop` 與 `systemctl --user status aios-kiosk.service`。可在桌面終端機執行 `aios-session-start` 測試。
- **沒有麥克風或鏡頭：** 檢查 Raspberry Pi OS 的裝置選擇與 Chromium 網站權限（專用 profile 在 `~/.local/share/aios-terminal/chromium-profile`）。
- **即時語音失敗但文字正常：** 把驗證、工作階段、網路錯誤，和麥克風權限失敗、「忙線」（Mac 那邊有另一通）分開；查 Mac log。
- **鏡頭負載下聲音斷續：** 停止影像推論，重測聲音，比較 Pi CPU 與溫度。
- **Mac 睡眠：** 遠端 UI 會失去核心；把 Mac 常開當成前置條件，不是 Pi 的問題。

## 回復

在 Pi 執行 `bash uninstall.sh`（加 `--purge` 會刪除設定、key 與 Chromium profile）。它會印出移除 apt 套件的指令，以及從 Mac 的 `~/.ssh/authorized_keys` 刪掉含這台 Pi 公鑰那一行的指令。若要回到先前狀態，在 Mac 關掉「遠端登入」，並把 `.env` 的 `PORT` 改回註解。核心程式、安全政策與 main 分支行為都不變。

## 下一個工程決定

第 1–2 階段通過：開始 RPI-2 受信任終端配對（見[草案](../../terminals/rpi4/README.md#rpi-2-draft)），處理目前只給 App 主視窗的功能。通道或 kiosk 行為失敗：修套件。預設不啟動完整的 ARM64 後端移植。

結果紀錄見 [`RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md`](RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md)。
