<!-- bilingual: source=zh-TW -->

> [繁體中文](SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.md) | [English](SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.en.md)

# SP-0｜Spotify Soloist × Raspberry Pi 4 週末測試計畫

日期：預計 2026-11-07～08（Asia/Taipei）；狀態：**待實測，所有方框預設未完成**。本計畫只驗證 Pi 上官方 Spotify Connect 播放設備和本機診斷通道，**不讓 Nous 語音控制 Spotify**。架構設計：[AIL／Spotify](../18_App_Integration_Layer_and_Spotify_2026-11.md)。前置的 Pi Chromium + Mac Nous 方案位於獨立分支 `experiment/rpi4-remote-terminal`（`docs/experiments/RPI4_REMOTE_TERMINAL_TEST_PLAN.md`），不是 main 現有檔案。

## A. 先備條件與注意事項

- Raspberry Pi 4 + Raspberry Pi OS 64-bit Desktop（建議）、穩定供電／散熱、喇叭（USB／HDMI／3.5mm 依實際設備）、Ethernet 或可信任 Wi-Fi；Mac mini 照既有 AIOS 模式運作。
- Spotify Premium Family 的本人帳號、登入 [Spotify for Developers](https://developer.spotify.com/) 所需的權限、官方 Soloist API Key、手機或電腦上的 Spotify App。家庭每個成員有獨立帳號；本輪只使用本人。
- 只從 [官方 Downloads and updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates) 取得對應 `arm64`（Pi 64-bit）或 `arm32`（32-bit OS）binary。官方版本從**建置日**起 90 天失效；不要提交或重新散布 binary。
- Spotify Developer Policy 禁止未經授權的語音控制 Spotify 整合。本輪只在 Spotify App 裡手動選裝置、播放音樂；本機 CLI/WS 只讀狀態及觀察連線。**不要把 Soloist 綁到 Nous 的模型工具或將歌名送到 LLM**。
- Soloist 的 WebSocket **沒有驗證及 TLS**；只能在 Pi loopback 監聽。SSH 轉送也要只綁 Mac loopback，不開放家用 LAN。
- 不提交 Spotify API Key、session、IP、帳號、播放清單、帶個資的截圖。Soloist 的 `--api-key` 會出現在程式啟動參數，避免分享 `ps`、service 檔與診斷畫面；正式服務化另議安全儲存。

## B. Phase SP-0.1：Pi 基礎環境

```bash
uname -m
cat /etc/os-release
free -h
vcgencmd measure_temp
vcgencmd get_throttled
pactl info || true
```

記錄：Pi 4 RAM ____ GB；OS ____；架構 ____；音訊設備 ____；起始溫度 ____°C；throttled ____。

- [ ] Pi OS、播放設備和網路正常。
- [ ] Mac 上的 Nous 仍能照原流程使用，沒有更動 `main` 產品程式。

## C. Phase SP-0.2：Soloist 啟動、手機配對、Pi 播放

1. 使用 Spotify 官方開發者入口產生自己的 Soloist API Key。選對 ARM 平台下載並解壓到 Pi 自己的測試目錄；確保執行檔名稱為 `soloist`。下列指令在**包含執行檔的目錄**執行；不可直接複製範例的秘密。
2. 在 Pi Terminal 安全地輸入 key（輸入不回顯；本輪測試使用互動式 shell，不做 systemd 開機服務）。
3. 開 Soloist，固定 loopback WebSocket 供本機狀態觀察，並在 Pi 的喇叭輸出。

```bash
chmod +x ./soloist
./soloist --version
read -rsp "Soloist API Key: " SOLOIST_API_KEY; echo
./soloist --device-name "Nous Pi Test" --api-key "$SOLOIST_API_KEY" --ws 127.0.0.1:9090
```

4. 用手機／桌面 Spotify App 在同個可信 LAN 找到 **Nous Pi Test**，手動切換到此裝置並播放。若失敗，先查官方 [Getting started](https://developer.spotify.com/documentation/soloist) 與 [Authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication)。
5. 在 Pi **另一個** Terminal，從相同 Soloist 執行檔位置進行唯讀診斷：

```bash
./soloist ctl status
./soloist ctl now
./soloist ctl now --json
ss -ltn | grep 9090
```

- [ ] 手機／電腦的 Spotify App 看得到 Pi 裝置。
- [ ] Spotify App 手動開始播放，音樂由 **Pi** 的喇叭出聲（不是 Mac）。
- [ ] `soloist ctl status` 可查狀態；`now --json` 可見播放狀態；不在 repo 留含歌單／帳號的輸出。
- [ ] 重新啟動 Soloist 後依官方配對流程恢復；斷網時沒有假成功。
- [ ] 結束測試時關閉 Soloist，並清除 shell 的 key 變數（在 Soloist 已停止且不再需要測試時）。

```bash
unset SOLOIST_API_KEY
```

## D. Phase SP-0.3：Mac／Pi 雙向 SSH tunnel（選用）

若 Pi Chromium 接 Mac Nous，原本用 SSH **local `-L`**。若之後 Mac 核心需要觀察 Pi 上 Soloist 狀態，改用同條連線的 **remote `-R`** 轉送 Soloist loopback。先在 Pi 確保 9090 有 Soloist 服務，再由 Pi 執行：

```bash
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8787:127.0.0.1:8787 \
  -R 127.0.0.1:19090:127.0.0.1:9090 \
  <mac-username>@<mac-lan-ip>
```

Pi Chromium 開 `http://localhost:8787`（參考原 Pi 測試分支）。Mac 終端確認本機 19090 有透過 SSH 轉送的埠，**不要**讓瀏覽器／模型直連這個埠；此階段不把它接進 Nous 工具。

```bash
nc -z 127.0.0.1 19090
```

- [ ] Pi 的 Chromium 仍可透過 `localhost:8787` 看到 Nous（原本 Pi 方案的檢查）。
- [ ] Mac `127.0.0.1:19090` 透過 SSH 對應 Pi 的 `127.0.0.1:9090`；沒有把 9090/19090 對外開放。
- [ ] SSH 斷線時，Mac 本機觀察埠不再可用；Pi Soloist 若仍連網則可以獨立播放。
- [ ] 確認 Mac SSH server 允許已驗證使用者的 remote forwarding；不關閉 host-key 驗證、不修改 AIOS HTTP guard。

## E. 量測、故障與驗收

| 場景 | Pi CPU | Pi RAM | Pi 溫度 | throttle | 音訊異常 | 註解 |
|---|---|---|---|---|---|---|
| Soloist 閒置 5 分鐘 | | | | | | |
| Spotify App 手動播放 15 分鐘 | | | | | | |
| Pi Chromium 顯示 Nous + Soloist 15 分鐘 | | | | | | |
| 拔網／恢復，重啟 Soloist | | | | | | |

必要的失敗紀錄：API Key 不可用、Spotify App 找不到設備、音訊輸出錯誤、WS 埠占用、轉送中斷、低電壓或過熱、Soloist build 過期。每個都要區分「沒有執行」「狀態不明」「已確認」，不得臆測。

**SP-0 PASS**：官方 ARM 版可在 Pi 4 啟動；Spotify App 能找到它並人工播放到 Pi 喇叭 15 分鐘；本機狀態可查；Mac/Nous 未受影響；WS 保持 loopback；無秘密洩漏。**SP-0 不代表 Spotify 語音控制合法或已實作**。

**回退**：在 Pi 結束 Spotify Soloist（Ctrl+C），關閉 SSH tunnel（Ctrl+C），關閉 Pi 測試 Chromium。保留原始 Mac 核心與 Pi terminal 設定，不刪使用者的 Spotify 帳號；若希望完全重設 Soloist，需依官方儲存路徑檢查資料及快取再由本人手動移除。

## F. 週末結果模板（實測後填寫）

| 項目 | 結果 |
|---|---|
| SP-0.1 環境檢查 | NOT TESTED |
| SP-0.2 配對、播放與 CLI | NOT TESTED |
| SP-0.3 SSH 雙向轉送 | NOT TESTED |
| CPU／RAM／溫度測量 | NOT TESTED |
| 驗收決策 | PENDING |
| 失敗／後續修復 issue | 未填 |

下個 gate：若 SP-0 PASS，啟動 **AIL-1（共用 Registry + fake Adapter）**；並行評估 **SP-1（唯讀本機健康與 mock）**。**SP-2 Spotify 語音控制維持 BLOCKED，等待書面授權或官方允許的途徑**。將去識別的測試證據另外存入雙語 `docs/validation/`，才可宣稱硬體測試完成。
