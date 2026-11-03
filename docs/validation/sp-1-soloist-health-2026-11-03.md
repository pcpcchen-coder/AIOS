<!-- bilingual: source=zh-TW -->

> [繁體中文](sp-1-soloist-health-2026-11-03.md) | [English](sp-1-soloist-health-2026-11-03.en.md)

# SP-1 Spotify Soloist 本機健康狀態驗證

日期：2026-11-03（Asia/Taipei）。分支：`claude/sp-1-soloist-health`（基於 main `d1d50be`，AIL-1 #86 合併後）。範圍是 [18 §6](../18_App_Integration_Layer_and_Spotify_2026-11.md) 的 SP-1。週末實測前置見 [SP-0 測試計畫](../experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.md)。

**本批沒有任何 Spotify 語音控制，也沒有模型工具。** Spotify Developer Policy III.3 禁止未經授權的語音控制整合，SP-2 維持 BLOCKED：Registry 仍然拒絕所有 `app.spotify.*` 工具，Soloist Adapter 的工具清單是空的。Nous 只在你打開設定頁時，檢查「Pi 上的 Spotify 播放器」能不能用。

**沒有在 Pi、Mac 或真實 Soloist 上執行過。** 下面的測試都在 Linux 雲端容器跑：一部分用注入的假 WebSocket，一部分用 Node 本機實作的假 Soloist WebSocket 伺服器（RFC 6455 握手）。訊息格式照官方 WebSocket API 文件。裝置名與歌名都是虛構的。

## 1. 交付內容

路徑都在 `prototype/ambient-shell/`。

| 檔案 | 內容 |
|---|---|
| `server/integrations/adapters/spotify-soloist.ts`（新） | `SpotifySoloistAdapter`：只連 `ws://127.0.0.1:<port>`，主機寫死，port 只來自核心設定。連上後送 `get_auth_state`，只讀 `auth_state` 的 `logged_in` 和 `is_active` 兩個布林值。`playback_state` 等事件不解析、不保存；`device_name` 不讀；不送任何播放控制指令。工具清單是空的；被呼叫執行時一律回 refused |
| `server/integrations/index.ts` | 已審核的 Adapter 加入 `spotify_soloist`；建立方式只拿核心設定 |
| `server/config.ts` | `NOUS_SPOTIFY_SOLOIST_PORT`（1024–65535，預設 19090）。只接受數字，網址或其他值一律拒絕 |
| `src/views.ts`、`src/main.ts`、`src/messages.en.json` | 設定頁（瀏覽器版與 macOS App 版）的「App 整合」段：打開設定頁時查一次（30 秒內不重查），有「重新檢查」按鈕；中英雙語。不在背景輪詢，也不是常駐 Dashboard |
| `server/messages.en.json` | 拒絕訊息的英文版 |

### 判斷規則（官方 WebSocket API，2026-11-03 查核）

| 情況 | 顯示 |
|---|---|
| 連不上（Pi 離線、SSH 通道斷、Soloist 沒有執行，或 build 過期以 exit code 10 結束） | 不可用：連不上 |
| 連上後在回報前斷線 | 狀態不明：連線在回報前中斷 |
| 時限內沒有 `auth_state`（2.5 秒；狀態頁另有 3 秒上限） | 狀態不明：沒有在時限內回覆 |
| `auth_state` 的欄位型別不對 | 狀態不明：回覆的格式看不懂 |
| `logged_in` 為 false | 不可用：Soloist 沒有登入 Spotify |
| 已登入但 `is_active` 為 false（官方定義：Soloist 不是目前使用中的 Connect 裝置） | 不可用：已登入，但不是目前使用中的 Spotify 播放裝置 |
| 執行環境沒有 WebSocket（Nous 這邊的問題） | 狀態不明：檢查時出錯（不說成 Pi 離線） |
| 兩者都是 true | 可用：已連線 |

Soloist 過期時會直接結束，這裡只看得到「連不上」，分不出是過期還是根本沒啟動，所以兩種情況都照實歸在「連不上」。

## 2. 測試（fixture）

新測試檔 `tests/integration-spotify-mock.test.ts`，9 項：

- 只讀 `auth_state` 的兩個布林值；`playback_state`、太長的訊息、二進位訊息一律略過。
- 只連 `ws://127.0.0.1:19090`，只送一則 `get_auth_state`，結束後關閉連線；結果裡沒有虛構的歌名和裝置名。
- 連線前出錯是不可用；連上後斷線、沒有回覆、中止都是狀態不明；建構 WebSocket 時出錯是不可用；執行環境沒有 WebSocket 時是狀態不明（不說成 Pi 離線）。
- port 範圍檢查：`ws://10.0.0.5:9090`、`22` 都拒絕。
- 用本機假 Soloist 伺服器，透過 Node 全域 WebSocket 測試：已登入且是播放裝置時可用；未登入時不可用（中間夾的 `playback_state` 被略過）；沒有東西在聽時不可用。
- 經整合層：兩條路徑的模型工具都是 0 個；工具表 JSON 裡沒有 spotify；`app__spotify__play` 回 `not_registered`；狀態頁顯示實際檢查結果，`model_tools: 0`。
- 設定頁的中文與英文文字、「重新檢查」按鈕；狀態不明時不顯示「可用」；查詢失敗時照實說查不到。

指令與結果（2026-11-03，Linux 雲端、Node.js 22）：

- `npm run typecheck`：通過。
- `npx vitest run`：124 個檔案，2,324 項通過、5 項跳過。
- `node scripts/verify-aios.mjs`：PASS；`git diff --check`：通過。

## 3. 獨立審查與修正

同一個模型的獨立審查（不是跨模型審查）提出 7 項，修了 5 項：

- **重要**：設定頁的重畫條件沒有包含整合狀態，查詢回來後畫面不會更新，一直停在「正在檢查…」。已把整合狀態加進重畫條件。這段在 `src/main.ts`，沒有自動測試涵蓋，週末第 4 步要親眼確認。
- 雙語文件與現況表已補齊。
- `is_active` 為 false 的文字改成官方的定義（不是目前使用中的播放裝置），不再猜是切到別台。
- 執行環境沒有 WebSocket 時，改回「狀態不明」，不說成 Pi 離線。
- 重新檢查時清掉舊的錯誤文字。

沒有修的兩項：`get_auth_state` 的指令格式是照官方文件的指令形狀（`type: "command"`）推得的；就算格式不對也不影響結果，因為官方文件說連上時就會送 `auth_state`。測試缺口（真伺服器上的中止、結束後才到的訊息）由注入假 WebSocket 的測試涵蓋。

## 4. 週末在 Pi／Mac 上的驗證步驟（尚未執行）

前提：先完成 SP-0.2（Pi 上的 Soloist 用 `--ws 127.0.0.1:9090` 啟動，Spotify App 手動選到這台 Pi）。

1. **把 Soloist 埠轉到 Mac（不修改 RPI-1 套件）**。Pi 終端套件的 `aios-tunnel.service` 只做 `-L`。週末測試時在 Pi 另開一條只做 `-R` 的連線，沿用套件的金鑰和已驗證的主機金鑰：

   ```bash
   source ~/.config/aios-terminal/terminal.conf
   ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
     -o UserKnownHostsFile="$HOME/.config/aios-terminal/known_hosts" -o IdentitiesOnly=yes \
     -i "$HOME/.config/aios-terminal/id_ed25519" -p "$AIOS_SSH_PORT" \
     -R 127.0.0.1:19090:127.0.0.1:9090 "$AIOS_MAC_USER@$AIOS_MAC_HOST"
   ```

   金鑰檔名若與上面不同，以 `install.sh` 實際寫入的為準。想要開機自動轉送時，請 RPI-1 那邊在 `bin/aios-tunnel` 的 `autossh` 參數加上 `-R 127.0.0.1:19090:127.0.0.1:9090`（同一條連線同時做 `-L` 和 `-R`），本批不改那個套件。Mac 的 sshd 預設 `GatewayPorts no`，`-R` 只會綁 Mac 的 loopback，不要改成對外。
2. **Mac 確認埠只在 loopback**：`lsof -nP -iTCP:19090 -sTCP:LISTEN` 應該只看到 `127.0.0.1:19090`。
3. **啟用 SP-1**：在 Nous 的 `.env` 加上 `NOUS_AIL=on`、`NOUS_AIL_SERVICES=spotify_soloist`（埠不是 19090 時再加 `NOUS_SPOTIFY_SOLOIST_PORT`），重新啟動 Nous。
4. **看狀態**：說或打「設定」打開設定頁，看「App 整合」段。記錄每一種情況下的顯示和 PASS／FAIL：
   - a. Spotify App 正在播放到 Pi：應該是「可用：已連線」。
   - b. Spotify App 把播放切到手機：應該是「不可用：已登入，但不是目前使用中的 Spotify 播放裝置」。
   - c. 在 Pi 停掉 Soloist（Ctrl+C）後按「重新檢查」：應該是「不可用：連不上」。
   - d. 停掉第 1 步的 SSH 連線後按「重新檢查」：應該是「不可用：連不上」。
   - e. 拔掉 Pi 的網路：應該是「不可用」或「狀態不明」，不能是「可用」。
5. **確認沒有外洩**：Nous 的 log 只能有「整合層」的狀態代碼，不能有 API Key、歌名、歌單或裝置名；即時語音的工具清單裡沒有任何 Spotify 工具（用語音問「幫我放音樂」，Nous 應該照實說不能控制 Spotify）。
6. **回退**：把 `.env` 的 `NOUS_AIL` 移除或改成 `off`，重新啟動 Nous；停掉第 1 步的 SSH 連線。

## 5. 限制與未完成

- 沒有在 Pi、Mac 或真實 Soloist 上執行；第 4 節的步驟都還沒做。
- 分不出「Soloist 過期」和「沒有啟動」，兩者都顯示「連不上」。
- `is_active` 為 false 一律顯示「不可用」：Pi 在待命、尚未被選為播放裝置時也會這樣顯示。這是保守的做法，因為這時候 Pi 確實不是播放裝置。
- 設定頁之外沒有其他地方顯示這個狀態（沒有語音查詢、沒有常駐列）。
- SP-2（Spotify 語音控制）維持 BLOCKED，要先取得書面授權或官方允許的途徑。

## 6. 下一個 gate

週末實測第 4 節，留下去識別的紀錄。實測通過後才能宣稱「Mac 能看到 Pi 上的 Soloist 狀態」。AIL-2（HomeBridge Facade）可以並行開始。
