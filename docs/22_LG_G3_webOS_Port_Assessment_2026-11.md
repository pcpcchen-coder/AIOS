<!-- bilingual: source=zh-TW -->

> [繁體中文](22_LG_G3_webOS_Port_Assessment_2026-11.md) | [English](22_LG_G3_webOS_Port_Assessment_2026-11.en.md)

# 22 把 Nous 搬到 LG G3 電視（webOS）：可行性評估（評估中，未實作）

日期：2026-11-09（Asia/Taipei）。狀態：**只是評估，產品程式沒有任何改動**。這次只新增本文件和一個唯讀的能力檢測頁 [`terminals/webos/capability-check.html`](../terminals/webos/capability-check.html)。

George 2026-11-09 要求評估：Nous 能不能在客廳的 LG OLED G3（實機 OLED65G3PSA）上執行。電視最自然的角色和 [Raspberry Pi 終端](../terminals/rpi4/README.md)一樣，是「另一個終端」：Agent、即時語音後端與資料都留在 Mac 核心，電視只負責畫面、聲音，最好也能收音和看鏡頭。

本文件把資料分成三級：**官方**（LG 文件或 LG 產品頁）、**社群**（論壇、第三方網站，包括 LG 員工在論壇的回覆）、**推論**（由上面兩者推出，沒有直接文件）。查不到或要實機才知道的一律寫「未知／待實測」，不當作可行。所有外部來源都在 2026-11-09 查核。

<a id="summary"></a>
## 1. 結論摘要

1. **電視當「顯示＋喇叭」可行，當「收音＋鏡頭」終端目前看不到可行路線。** webOS 的官方 Luna API 沒有任何收音 API；鏡頭 API 只回報裝置資訊、而且從 webOS TV 4.0 起就標為 deprecated。LG 員工在開發者論壇回覆「WebRTC 只開放給簽約合作夥伴的 App」（社群來源，LG 回覆）。Nous 的即時語音、喚醒詞、看著說話和家人辨識都要麥克風或鏡頭，在電視上都要列為**不可行（待實測確認）**。
2. **最省事的路線是混合方案：Pi（或 Mac）把畫面用 HDMI 送到電視，收音和鏡頭留在 eMeet／Pi。** 這條路線不用寫新程式，現有 Pi 終端的所有能力都保留，電視只是一個大螢幕和喇叭。LGTV-1 已經能從 Mac 切電視輸入。
3. **真正裝在電視上（.ipk）只值得做「顯示專用終端」**，而且要先解決「電視怎麼連到只聽 `127.0.0.1` 的 Mac 核心」。Pi 是靠 SSH 通道把連線變成 `http://localhost`；電視不能跑 SSH 用戶端（沒有 root），所以要嘛做一個有認證的區網入口（需要 George 決定，見第 13 節），要嘛試試用 webOS JS service 在電視本機做轉送（未知／待實測）。
4. **先做 G-0：用電視瀏覽器開能力檢測頁**，確認實機的 Chromium 版本（G3 可能已經經 LG Re:New 升到 webOS 24 或 25）和各 API 的實際狀態，再決定要不要往下做。

<a id="current-architecture"></a>
## 2. 現在的架構與要搬的能力

| 層 | 現況（`prototype/ambient-shell`） | 電視要承擔的部分 |
|---|---|---|
| 核心 | Mac 上的 Node HTTP＋SSE，只聽 `127.0.0.1`；`server/http-guard.ts` 只接受 `localhost:<port>`／`127.0.0.1:<port>` | 不搬；電視當終端 |
| 頁面 | 無框架 TypeScript／Vite；`EventSource` 收事件；Canvas（可選 WebGL）電子腦 | 要在電視的 Chromium 上跑 |
| Mac App | Electron 殼、原生選單、加密成果與記憶的 IPC | 電視不會有；功能等同 Pi 終端（沒有加密成果與記憶管理） |
| Pi 終端 | Chromium kiosk 開 `http://localhost:<port>`，經 autossh 轉到 Mac；`localhost` 是安全情境，所以麥克風和鏡頭可用 | 電視沒有現成的對應做法 |

Nous 頁面依賴的瀏覽器能力（由程式碼確認）：

| 功能 | 依賴 | 程式位置 |
|---|---|---|
| 即時語音 | `RTCPeerConnection`、`getUserMedia`（麥克風） | `src/realtime.ts`、`src/live-voice.ts` |
| 喚醒詞 | `AudioWorklet`、worker、sherpa-onnx v2.0.1 wasm（CSP 需 `wasm-unsafe-eval`） | `src/audio/` |
| 鏡頭、看著說話、家人辨識 | `getUserMedia`（影像）、`@mediapipe/tasks-vision` 1.1.1、`onnxruntime-web` 1.30.0（wasm，`numThreads = 1`） | `src/sense/`、`src/speaker/` |
| 選喇叭 | `HTMLMediaElement.setSinkId`；`AudioContext.setSinkId`（Chromium 110 起），沒有時改用系統預設 | `src/audio-devices.ts`、`src/audio/earcon.ts` |
| 回憶模式 | `<video>` 播照片與影片（Mac 端把 HEIC 轉 JPEG；影片格式依原檔） | `server/memories-*.ts` |
| 時鐘角落、家中狀態 | 一般 DOM＋唯讀 API | `GET /api/weather/now`、`GET /api/home/overview` |
| 處理中音效 | Web Audio 合成，受自動播放政策影響 | `src/audio/earcon.ts` |
| 終端連線與配對 | SSH 通道（RPI-1）；RPI-2 受信任配對仍是[草案](../terminals/rpi4/README.md#rpi-2-draft) | `terminals/rpi4/` |

<a id="official-facts"></a>
## 3. 查到的事實（2026-11-09）

| 主題 | 內容 | 等級與來源 |
|---|---|---|
| webOS 23 的網頁引擎 | Web App 跑 **Chromium 94**（UA 含 `Chrome/94.0.4606.128 … WebAppManager`）；webOS 24 是 Chromium 108、25 是 120、26 是 132 | 官方：[Web API and Web Engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine) |
| 內建瀏覽器的引擎 | 官方只列 webOS 1.x／2.x；**webOS 23 瀏覽器 App 的版本查不到** | 官方（同上）；未知 |
| G3 是否已升級 | LG Re:New 計畫讓 2023 年起的 OLED 可升到 webOS 25；媒體報導 G3 已收到 webOS 24（韌體 23.20.50）與 webOS 25 | 官方：[LG Italia webOS 25](https://www.lg.com/it/magazine/aggiornamento-a-webOS-25/)；社群：媒體報導。**要看實機 UA** |
| 升級後引擎是否跟著換 | 查不到 | 未知 |
| Web API 支援表 | 官方說明 webOS TV 4.0 起「不再提供」支援表，請參考 MDN 但平台可能不同 | 官方（同上）。WebRTC、getUserMedia、AudioWorklet、wasm SIMD／執行緒、SharedArrayBuffer、setSinkId、Service Worker、Web Speech、WebGL2、全螢幕都**沒有官方逐項說明** |
| WebRTC | LG 員工回覆：「WebRTC is only available on contracted partner apps」；2023-03-16 另一則 LG 回覆：「The WebRTC specification is currently not open」；使用者回報瀏覽器裡的 getUserMedia 只在 google.com、webrtc.github.io 能用（webOS 6.x） | 社群（LG 論壇回覆）：[#27587](https://forum.webostv.developer.lge.com/t/webrtc-getusermedia-webos-24/27587)、[#2306](https://forum.webostv.developer.lge.com/t/webrtc-support-in-webos-tv/2306) |
| 鏡頭 API | `luna://com.webos.service.camera` 只有 getList／getInfo／isCovered，沒有擷取方法；webOS TV 4.0 起 deprecated | 官方：[Camera](https://webostv.developer.lge.com/develop/references/camera) |
| LG Smart Cam VC23GA | 支援 webOS 23／22，相容清單有 OLED G3，內建雙麥克風；**沒有列出哪些 App 能用** | 官方：[LG AU VC23GA](https://www.lg.com/au/tv-accessories/ebx64338002) |
| Luna API 清單 | Activity Manager、App Manager、Audio（只有音量）、BLE GATT、Camera（deprecated）、Connection Manager、DB、Device Unique ID、DRM、Keymanager3、Media DB、Magic Remote、Settings、System、TV Device Info；**沒有收音或語音 API** | 官方：[Luna Service Introduction](https://webostv.developer.lge.com/develop/references/luna-service-introduction) |
| App 生命週期 | 隱藏的 App 進入 suspended；JS 是否繼續跑沒寫；不得有自己的關閉鈕；`handlesRelaunch` 讓 App 在背景處理重新啟動 | 官方：[App Lifecycle](https://webostv.developer.lge.com/develop/guides/app-lifecycle-management)、[appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json) |
| JS service | App 沒開時也能跑；webOS 23 是 **Node v12.22.2**；只能用純 JS 模組；`webos-service` 預設閒置 **5 秒**就結束，可調 `idleTimeout`，要常駐就保持一個 ActivityManager activity；最長壽命沒寫 | 官方：[JS Service Basics](https://webostv.developer.lge.com/develop/guides/js-service-basics)、[JS Service FAQ](https://webostv.developer.lge.com/develop/guides/js-service-faq) |
| 開發者模式 | 有時間限制（官方沒寫幾小時），上線時可按 EXTEND，過期後不能再延長；要 LG 開發者帳號、電腦在同一個網路；社群說目前上限 1000 小時（舊文 50 小時），過期時用開發者模式裝的 App 會被移除 | 官方：[Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)；社群：[webOS Brew devmode](https://www.webosbrew.org/devmode/) |
| CLI | `npm install -g @webos-tools/cli`；官方頁建議 Node 14.15.1–16.20.2，但 npm 上最新 3.2.6（2026-09-08）要求 Node ≥ 20，兩者衝突，以實裝為準；`ares-setup-device`、`ares-package`、`ares-install`、`ares-launch`、`ares-inspect` | 官方：[CLI Installation](https://webostv.developer.lge.com/develop/tools/cli-installation)、[CLI Dev Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)；[npm registry](https://registry.npmjs.org/@webos-tools/cli) |
| 上架 LG Content Store | 個人或公司賣家；每個 App 都要過 LG QA（預測試、功能、內容）；上傳 IPK、UX 情境與自我檢核表；更新要重新審核；費用、時程、私人用途政策查不到 | 官方：[App Ecosystem](https://webostv.developer.lge.com/distribute/app-ecosystem)、[App Approval Process](https://webostv.developer.lge.com/distribute/app-approval-process) |
| 用網址開瀏覽器 | SSAP `system.launcher/open` 帶 `{target: "https://..."}`；或 `launch` `com.webos.app.browser` 帶 `target` | 社群：[Home Assistant webostv.command](https://www.home-assistant.io/actions/webostv.command/)、[LG 論壇 #8739](https://forum.webostv.developer.lge.com/t/how-to-open-a-web-link-in-lg-webos-browser-without-relaunching-the-existing-app/8739)；LGTVG3 的 `lgtv url` 也是這樣做 |
| 開機自動開 App | 沒有官方 API；社群說只有 homebrew 能做 | 社群：[LG 論壇 #3759](https://forum.webostv.developer.lge.com/t/how-to-make-an-app-run-automatically-on-first-boot/3759)、[Homebrew Channel #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124) |
| G3 硬體 | α9 AI Processor 4K Gen6、Bluetooth 5.0、USB 2.0 × 3、HDMI × 4（4K120／eARC）、Wi‑Fi 6、免持語音「有」、「USB Camera Compatible: Yes」、AirPlay 2「有」；**記憶體與儲存空間官方沒列**（社群商品頁寫 3 GB／8 GB，未證實） | 官方：[LG MY OLED65G3PSA](https://www.lg.com/my/tvs/lg-oled65g3psa) |
| 內建麥克風 | 「Hey, LG」用電視本身內建的麥克風，預設關閉，7 段靈敏度，清單含 2023 OLED G3；**第三方 App 能不能用：查不到，Luna 清單也沒有** | 官方：[LG Italia Hey LG](https://www.lg.com/it/supporto/supporto-prodotto/risoluzione-anomalie/help-library/cs-CT20154005-20152636672944/) |
| Google Cast | G3 規格頁沒列；LG 說 Re:New 升到 webOS 25 時加入；媒體說 webOS 24 起有 | 官方（webOS 25 文章）；社群（媒體） |
| TLS 根憑證 | 依版本固定、不能修改；不受信任的根憑證會出 `ERR_INSECURE_RESPONSE` | 官方：[TLS](https://webostv.developer.lge.com/develop/specifications/tls)。推論：區網自簽憑證在電視上不會被信任 |
| Hosted Web App | 本機一個小包裝，用 meta refresh 或 JS 轉到遠端伺服器；範例用 `http://`；HTTPS 或安全情境規定沒寫 | 官方：[Web App Types](https://webostv.developer.lge.com/develop/getting-started/web-app-types) |
| Root／Homebrew | faultmanager（webOS 4.0 起）、DejaVuln（3.5 起，修補陸續推出）；crashd 2024-04 修補；faultmanager-autoroot 說 2025-08-24 起 webOS 5、6、7、9 最新韌體幾乎都已修補，webOS 23 要試多次；兩者都要求不要更新韌體；保固影響沒寫 | 社群：[webOS Brew rooting](https://www.webosbrew.org/rooting/)、[faultmanager-autoroot](https://github.com/throwaway96/faultmanager-autoroot)、[cani.rootmy.tv](https://cani.rootmy.tv/) |

<a id="options"></a>
## 4. 各方案說明

<a id="option-a"></a>
### 方案 A：webOS Web App（.ipk 裝在電視）

把 Nous 頁面打包成 packaged 或 hosted Web App，用開發者模式安裝。執行環境是 webOS 23 的 Chromium 94（升級後可能是 108 或 120）。

- **畫面**：電子腦 Canvas、時鐘、家中狀態、成果畫面用到的都是 Chromium 94 已有的功能（推論）；WebGL 繪製要實測。
- **連到核心**：packaged App 的來源是 `file://`，hosted App 會轉到遠端網址。不論哪一種，Mac 核心都只聽 `127.0.0.1`，`http-guard.ts` 也只收 `localhost`，所以電視連不進去。要嘛新增有認證的區網入口（第 13 節的決定 D2），要嘛用方案 C 的 JS service 在電視本機轉送。
- **收音、鏡頭、WebRTC**：依 LG 回覆與 Luna 清單，列為不可行（待實測確認）。
- **常駐**：App 被切走時 suspended；開機不會自己開。可以由 Mac 用 SSAP 在電視開機時啟動它（LGTV-1 已有 `launch_app`；推論可行，待實測）。
- **部署**：開發者模式有時限、要定期 EXTEND；過期後 App 被移除，要重裝。上架 Content Store 要過 LG QA，個人家用 App 是否能上架查不到，不建議走這條。

<a id="option-b"></a>
### 方案 B：電視內建瀏覽器開 Nous 頁面

和 Pi 一樣開一個網址，但電視沒辦法跑 SSH 通道。

- **安全情境**：`http://<Mac 區網 IP>` 不是安全情境，`getUserMedia` 一定不能用（瀏覽器規範）。`https://` 要用電視信任的公開憑證：電視的根憑證不能改，自簽不行；可能的做法是自己的網域＋公開 CA（例如 DNS 驗證）指向區網 IP（推論，未測）。就算是 HTTPS，依社群回報瀏覽器的 getUserMedia 也只對 Google 網站開放（webOS 6.x 的回報，webOS 23 未知）。
- **入口**：同方案 A，核心目前不收區網連線。
- **全螢幕**：官方沒寫，未知；瀏覽器有網址列和自己的按鍵行為。
- **開機自動開**：沒有官方做法；Mac 可以用 SSAP `system.launcher/open` 開網址（社群做法，LGTVG3 有 `lgtv url`），待實測。
- **優點**：完全不用安裝，最適合做 G-0 的能力檢測。

<a id="option-c"></a>
### 方案 C：Native／JS service（webOS service、Luna API）

- **能否常駐**：可以在背景跑，但 `webos-service` 預設閒置 5 秒就結束；要保持 ActivityManager activity 才能常駐，最長壽命官方沒寫（待實測）。
- **收音**：Luna 清單沒有收音 API；遙控器麥克風和「Hey, LG」內建麥克風都沒有開給第三方的文件。外接 USB 麥克風：規格頁沒寫，未知。
- **鏡頭**：Luna 鏡頭 API 只能查資訊、已 deprecated；VC23GA 沒列可用 App；「USB Camera Compatible: Yes」沒說哪些 App 能用。外接 USB 鏡頭給第三方 App：未知，推論不可行。
- **Native（C/C++）**：一般開發者的 JS service 不能用原生模組；原生 App 要走 LG 合作夥伴管道（推論，未查到公開文件）。
- **能幫上的地方**：Node 12 的 JS service 也許能在電視本機開一個 `127.0.0.1` 的轉送，讓 Web App 開 `http://localhost:<port>`，像 Pi 的 SSH 通道一樣不必放寬核心（例如純 JS 的 SSH 用戶端連到 Mac 的「遠端登入」）。能不能常駐、能不能開本機 port、效能如何都**未知／待實測**。

<a id="option-d"></a>
### 方案 D：混合，電視只當顯示＋喇叭

- **D1：Pi 用 HDMI 接電視。** Pi 4 照現在的套件跑，把 HDMI 從小螢幕改接電視；eMeet（或 Pi 的 USB 麥克風／鏡頭）照常收音和看人。聲音可以走電視喇叭（HDMI）或 eMeet 喇叭，用「聲音輸出」設定選。LGTV-1 的 `app.tv.input` 可以在喚醒時把電視切到 Pi 的 HDMI（待決定是否自動切）。**現有程式就能做，只要實測。**
- **D2：Mac 用 HDMI 或 AirPlay 2 把 Nous 視窗送到電視。** G3 規格頁寫支援 AirPlay 2（官方）。Mac 的 Nous 視窗鏡像或延伸到電視，收音仍用 Mac 上的 eMeet。AirPlay 的延遲與畫面張數未知；Mac 一離開或睡眠就斷。
- **D3：Google Cast。** 要看電視升到 webOS 24／25 之後才可能有，Nous 也沒有 Cast 接收端，不建議。
- **回音**：電視喇叭離 eMeet 比較遠，eMeet 和 Chromium 的回音消除能不能吃掉電視的聲音，要實測。

<a id="option-e"></a>
### 方案 E：社群 Root／Homebrew Channel（只作參考）

Root 後可以裝 Homebrew Channel、開機自動啟動、不受開發者模式時限限制，也許能碰到 ALSA 或 USB 裝置（未知）。但：

- **風險**：要停在沒修補的韌體、不能更新（安全修補也拿不到）；操作不當可能讓電視變磚；LG 更新後通常會修補漏洞，root 可能失效。
- **保固**：webOS Brew 頁面沒提保固；一般來說改機可能影響保固，要自行向 LG 確認（推論）。
- **隱私紅線**：root 後的程式權限很大，更需要確保原始影像與未喚醒音訊不寫檔、不外傳。
- **建議**：不作為主要路線，本文件不提供操作步驟。

<a id="capability-matrix"></a>
## 5. 能力對照表

圖例：✅ 可行、🟡 部分、❌ 不可行、❔ 未知／待實測。括號是依據；「推論」表示沒有直接文件。

| 功能 | A：.ipk Web App | B：電視瀏覽器 | C：JS service／Luna | D：混合（Pi HDMI／Mac AirPlay） | E：Root |
|---|---|---|---|---|---|
| 電子腦畫面＋SSE | 🟡（Chromium 94 有 Canvas 與 EventSource，推論；要先解決連到核心） | 🟡（同 A；網址列與按鍵行為未知） | ❌（沒有畫面） | ✅（D1 現有 Pi 程式；D2 鏡像，延遲未知） | ❔ |
| 連到 Mac 核心 | ❌ 現況（核心只收 localhost；需 D2 決定的新入口或 C 的轉送） | ❌ 現況（同 A，且 http 非安全情境） | ❔（本機轉送待實測） | ✅（Pi SSH 通道） | ❔ |
| 即時語音（WebRTC＋麥克風） | ❌（LG 回覆 WebRTC 只給合作夥伴；待實測確認） | ❌（社群：getUserMedia 只對 Google 網站；webOS 23 未知） | ❌（沒有收音 API） | ✅（收音在 Pi／Mac） | ❔ |
| 麥克風來源 | ❌（同上） | ❌ | ❌（遙控器麥克風、內建麥克風都沒開放） | ✅（eMeet、Pi USB 麥克風） | ❔ |
| 喚醒詞（AudioWorklet＋wasm） | ❌（沒有麥克風；AudioWorklet、wasm 本身 Chromium 94 有，推論） | ❌ | ❌ | ✅ | ❔ |
| 鏡頭、MediaPipe、家人辨識 | ❌（鏡頭 API 已 deprecated、沒有擷取） | ❌ | ❌ | ✅（Pi 或 Mac 鏡頭） | ❔ |
| 選喇叭 `setSinkId` | ❔（`HTMLMediaElement.setSinkId` 在 Chromium 94 應存在，電視能不能列出輸出裝置未知；`AudioContext.setSinkId` 要 Chromium 110，程式會改用預設） | ❔ | — | ✅（Pi 可選 HDMI＝電視喇叭或 eMeet） | ❔ |
| 回憶模式影片 | 🟡（H.264 應可播，HEVC／MOV 待測；要連得到核心） | 🟡（同 A） | — | ✅ | ❔ |
| 時鐘角落 | 🟡（只需 DOM；要連得到核心） | 🟡 | — | ✅ | ❔ |
| 處理中音效 | ❔（Web Audio 有；電視自動播放政策未知） | ❔ | — | ✅ | ❔ |
| 終端配對（RPI-2 草案） | ❔（RPI-2 未實作；憑證可存在 App 本機儲存，推論） | ❔ | — | 🟡（D1 用 RPI-1 的 SSH 金鑰；RPI-2 未實作） | ❔ |
| 全螢幕 | ✅（Web App 本來就是全螢幕，官方 App 型態） | ❔ | — | ✅ | ✅ |
| 開機自動開 | 🟡（沒有官方 API；可由 Mac 經 SSAP 啟動，待實測） | 🟡（同 A，用 `system.launcher/open`） | ❔（service 是否開機就跑未知） | ✅（Pi 已有自動啟動；電視切輸入待決定） | ✅（社群，風險見方案 E） |
| 背景常駐 | ❌（隱藏即 suspended） | ❌ | 🟡（要保持 activity，壽命未知） | ✅（Pi） | ✅（社群） |
| 開發者模式到期影響 | 會被移除，要定期延長 | 無 | 會被移除 | 無 | 無（但不能更新韌體） |

<a id="performance"></a>
## 6. 效能與硬體限制

- **SoC**：α9 AI Processor 4K Gen6（官方）。CPU 核心數、時脈、GPU 型號官方沒寫，能力檢測頁會回報 `hardwareConcurrency` 與 WebGL renderer。
- **記憶體**：官方沒列；社群商品頁寫 3 GB RAM／8 GB 儲存（未證實）。電視的記憶體大多給影像與系統，Web App 能用的上限未知。
- **網頁引擎**：Chromium 94 比 Pi 上的 Chromium 舊很多（Pi 是 Raspberry Pi OS 隨附的版本）。Vite 的建置目標要確認能在 94 跑（例如 top-level await、較新的 CSS）。若電視已升級，可能是 108 或 120。
- **wasm 與 MediaPipe**：wasm 和 SIMD 在 Chromium 91 起預設開啟（推論，能力檢測頁會驗）；SharedArrayBuffer 需要跨來源隔離，Nous 目前也沒用多執行緒（`numThreads = 1`）。但沒有鏡頭和麥克風，MediaPipe 和喚醒詞在電視上就沒有用途，效能問題暫時不必評估。
- **電子腦繪製**：Pi 4 需要「平衡」模式；電視的 CPU／GPU 對 Canvas 的負擔未知，要在 G-1 量畫面張數。
- **JS service**：Node 12.22.2、只能純 JS；Nous 核心要 Node 22.12 以上，核心不可能搬上電視。

<a id="input-sources"></a>
## 7. 麥克風與鏡頭來源選項

| 來源 | 狀態 | 說明 |
|---|---|---|
| 電視內建麥克風（Hey, LG） | ❌ 給第三方：查不到 | 只見於 LG 自家語音功能 |
| 魔術遙控器麥克風 | ❌ 給第三方：查不到 | Luna 清單沒有對應 API |
| LG Smart Cam VC23GA（雙麥克風） | ❔ | 相容 G3，但沒列可用 App；第三方 Web App 能不能用未知，推論不行 |
| 一般 USB 麥克風／鏡頭接電視 | ❔ | 規格頁「USB Camera Compatible」沒說明給誰用；推論第三方不行 |
| eMeet M0 Plus 接 Pi（現況） | ✅ | Pi 終端已實機驗證收音（2026-11-05） |
| eMeet 或 reSpeaker 接 Mac | ✅ | Mac App 現況 |
| Pi 鏡頭／Mac 鏡頭 | ✅ | 影像只在本機分析，紅線不變 |

結論：收音和鏡頭留在 Pi 或 Mac。

<a id="deployment"></a>
## 8. 開發與部署流程（若做方案 A）

```bash
npm install -g @webos-tools/cli
ares-setup-device --add myTV -i host=<TV_IP> -i port=9922 -i username=prisoner
ares-novacom --device myTV --getkey
ares-package <app-dir>
ares-install --device myTV <package>.ipk
ares-launch --device myTV <app-id>
ares-inspect --device myTV <app-id>
```

1. 在電視裝 Developer Mode App，用 LG 開發者帳號登入，打開 Dev Mode 與 Key Server。
2. Mac 安裝 CLI（Node 版本以 npm 套件的 `engines` 為準），登記電視、用 6 碼通關碼取金鑰。
3. 打包、安裝、啟動、除錯（`ares-inspect` 開遠端 DevTools）。
4. 定期在電視上按 EXTEND；過期就要重裝。
5. 若有 JS service：一起打包在 .ipk，Node 12，只用純 JS 模組。

<a id="maintenance"></a>
## 9. 維護成本

| 項目 | A | B | D1 | E |
|---|---|---|---|---|
| 新程式 | 中：電視專用建置目標（Chromium 94）、遙控器焦點與按鍵、連線入口或 JS service 轉送 | 低：只要入口 | 幾乎沒有 | 高 |
| 例行工作 | 開發者模式定期延長；過期重裝 | 無 | 和現在的 Pi 一樣 | 不能更新韌體 |
| 韌體更新 | 可能改變引擎版本與行為（G3 已有升級路線） | 同 A | 不受影響（電視只是螢幕） | 可能讓 root 失效 |
| 測試負擔 | 多一個 Chromium 版本要測 | 同 A | 不增加 | 高 |

<a id="risks"></a>
## 10. 風險

- **開發者模式到期**：時限官方沒寫（社群說 1000 小時），過期時 App 被移除；忘了延長就會在某天突然不見。
- **韌體更新改行為**：G3 已有 webOS 24／25 的升級路線，引擎可能從 Chromium 94 跳到 108 或 120；SSAP 過去也改過埠（3000→3001，見 LGTVG3）。
- **官方能力不明**：LG 不再提供 Web API 支援表，只能靠實測；論壇回覆不是正式規格，以後可能改變。
- **連線入口**：要讓電視連核心，必須新增區網入口或電視本機轉送。現在的原則是「不直接放寬既有防護」（[目前實作](Current_Implementation_Status.md)）；依 2026-10-31「便利優先」，是否、怎麼做由 George 決定（D2）。
- **隱私紅線**：原始 webcam 影像與未喚醒音訊不得寫檔、進 trace 或外傳。方案 A／B／C 本來就拿不到麥克風和鏡頭，所以不會新增這類資料；方案 D 沿用現有 Pi／Mac 的處理（影像只在本機分析、未喚醒音訊只在記憶體 2 秒環形緩衝）。方案 E 的 root 程式權限過大，風險最高。能力檢測頁不開麥克風、不開鏡頭、不連網。
- **產品紅線**：電視 App 不能做成 App launcher、圖示牆或首頁 Dashboard；畫面和 Pi 一樣是電子腦待機，Surface 照樣要有 `visibility_reason`。
- **回音與誤喚醒**：電視喇叭播 Nous 或節目時，eMeet 可能收到；誤喚醒會開一次付費通話（見 17 規劃）。

<a id="recommendation"></a>
## 11. 建議路線與分階段 gate

**建議**：先走方案 D1（Pi 接電視 HDMI），同時做 G-0 的能力檢測；只有 G-0 證明電視的引擎夠新、George 也想要「不靠 Pi 的電視顯示終端」時，才做 G-2 以後。

| Gate | 內容 | 通過條件 | 不通過時 |
|---|---|---|---|
| **G-0** 能力檢測 | 電視瀏覽器開 `capability-check.html`（HTTPS 與 http 區網各一次），記下 UA、安全情境、各 API | 拿到兩份 JSON 或照片，寫進 `docs/validation/` | 照實記錄；收音與鏡頭不可用不影響 D1 |
| **G-1** 混合實測（D1） | Pi 改接電視 HDMI，跑一週日常使用：電子腦、時鐘、回憶影片、處理中音效、HDMI 喇叭與 eMeet 喇叭各試一次、回音與誤喚醒 | George 覺得字、動畫、聲音可用；回音與誤喚醒次數照實記錄 | 調整輸出裝置或回到小螢幕 |
| **G-2** 顯示專用 .ipk 原型 | 開發者模式安裝一個 hosted／packaged App，只顯示電子腦與時鐘；連線方式依 D2 決定（區網入口或 JS service 轉送） | 電視上看到真實 SSE 事件驅動的腦區動畫，連線中斷時照實顯示 | 停在 D1 |
| **G-3** 日常化 | Mac 在電視開機時經 SSAP 開 App；開發者模式延長流程；韌體更新後重跑 G-0 | 連續兩週可用，記錄延長次數與故障 | 停在 D1 |

收音、喚醒、鏡頭不列入電視端 gate，除非 G-0 或 LG 文件出現新證據。

<a id="home-test"></a>
## 12. George 在家可以做的最小實測（G-0）

檢測頁 [`terminals/webos/capability-check.html`](../terminals/webos/capability-check.html) 只讀取能力：不呼叫 `getUserMedia`、不錄音錄影；頁面的 CSP 設成 `connect-src 'none'`，不送任何資料；`enumerateDevices` 只計算裝置數量（沒授權時名稱是空的）。介面有繁體中文／English 切換。

**步驟 1：用 HTTPS 開（測安全情境下的能力）。** 合併到 main 後，在電視瀏覽器輸入下面網址（第三方的 GitHub 轉送服務，只用來取得正確的網頁格式；頁面本身不會回傳資料）。網址太長可以在 Mac 用 LGTVG3 的 `lgtv url` 開：

```text
https://raw.githack.com/pcpcchen-coder/AIOS/main/terminals/webos/capability-check.html
```

**步驟 2：用區網 http 開（測 Pi 以外的終端最可能遇到的情況）。** 在 Mac 的 repo 目錄執行，再在電視開 `http://<Mac 的區網 IP>:8765/capability-check.html`。測完按 Ctrl+C 關掉：

```bash
cd terminals/webos && python3 -m http.server 8765
```

**步驟 3：記錄結果。** 兩次都拍下整頁或按「複製 JSON」，交給開發者寫進 `docs/validation/`。重點看：

1. 「User-Agent 與 Chromium 版本」：94 表示 webOS 23；108／120 表示已升級。
2. 「安全情境」：HTTPS 應為「支援」，http 區網應為「不支援」。
3. 「getUserMedia 介面存在」「麥克風／鏡頭權限狀態」「裝置數量」：介面存在不代表能用；權限是 `denied` 或裝置數量是 0 都要記下來。
4. 「AudioWorklet」「WebAssembly SIMD」「setSinkId」「WebGL 2」「影片格式」。

**步驟 4（選做）：** 把 Pi 的 HDMI 改接電視，照第 11 節 G-1 試用。

<a id="decisions"></a>
## 13. 需要 George 決定的事

| # | 問題 | 選項 | 建議 |
|---|---|---|---|
| D1 | 下一步走哪條路？ | a. 先做 G-0＋G-1（Pi 接電視，零程式）；b. 直接做 .ipk 顯示終端（G-2）；c. 暫停 | **a** |
| D2 | 若要做 .ipk 或電視瀏覽器終端，電視怎麼連到核心？ | a. 先試電視本機 JS service 轉送（不改核心，未知能否常駐）；b. 核心新增有認證的區網 HTTPS 入口（要公開 CA 憑證與 RPI-2 式配對）；c. 不做 | **a**，失敗再談 b |
| D3 | 電視開著 Pi 畫面時，喚醒是否自動把電視切到 Pi 的 HDMI？ | a. 不自動；b. 只在電視已開機時切；c. 連電視一起開機並切 | **b**（避免半夜開電視；但要 George 確認） |
| D4 | Nous 的聲音從哪裡出？ | a. eMeet 喇叭（現況）；b. 電視喇叭（HDMI） | 先 **a**，G-1 再比較 |

<a id="sources"></a>
## 14. 參考來源（全部於 2026-11-09 查核）

官方：
- [webOS TV Web API and Web Engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [webOS TV Camera API](https://webostv.developer.lge.com/develop/references/camera)
- [Luna Service Introduction](https://webostv.developer.lge.com/develop/references/luna-service-introduction)
- [App Lifecycle Management](https://webostv.developer.lge.com/develop/guides/app-lifecycle-management)
- [appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json)
- [JS Service Basics](https://webostv.developer.lge.com/develop/guides/js-service-basics)、[JS Service FAQ](https://webostv.developer.lge.com/develop/guides/js-service-faq)
- [Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- [CLI Installation](https://webostv.developer.lge.com/develop/tools/cli-installation)、[CLI Developer Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)、[@webos-tools/cli（npm）](https://registry.npmjs.org/@webos-tools/cli)
- [App Ecosystem](https://webostv.developer.lge.com/distribute/app-ecosystem)、[App Approval Process](https://webostv.developer.lge.com/distribute/app-approval-process)
- [Application Manager](https://webostv.developer.lge.com/develop/references/application-manager)
- [Web App Types](https://webostv.developer.lge.com/develop/getting-started/web-app-types)
- [TLS](https://webostv.developer.lge.com/develop/specifications/tls)
- [LG MY OLED65G3PSA 規格](https://www.lg.com/my/tvs/lg-oled65g3psa)
- [LG AU Smart Cam VC23GA](https://www.lg.com/au/tv-accessories/ebx64338002)
- [LG Italia「Hey, LG」說明](https://www.lg.com/it/supporto/supporto-prodotto/risoluzione-anomalie/help-library/cs-CT20154005-20152636672944/)
- [LG Italia webOS 25 升級](https://www.lg.com/it/magazine/aggiornamento-a-webOS-25/)

社群（含 LG 員工在論壇的回覆）：
- [LG 開發者論壇：WebRTC getUserMedia webOS 24（#27587）](https://forum.webostv.developer.lge.com/t/webrtc-getusermedia-webos-24/27587)
- [LG 開發者論壇：WebRTC support in webOS TV（#2306）](https://forum.webostv.developer.lge.com/t/webrtc-support-in-webos-tv/2306)
- [LG 開發者論壇：用瀏覽器開網址（#8739）](https://forum.webostv.developer.lge.com/t/how-to-open-a-web-link-in-lg-webos-browser-without-relaunching-the-existing-app/8739)
- [LG 開發者論壇：開機自動開 App（#3759）](https://forum.webostv.developer.lge.com/t/how-to-make-an-app-run-automatically-on-first-boot/3759)
- [Home Assistant webostv.command](https://www.home-assistant.io/actions/webostv.command/)
- [webOS Brew：Developer Mode](https://www.webosbrew.org/devmode/)、[Rooting](https://www.webosbrew.org/rooting/)
- [faultmanager-autoroot](https://github.com/throwaway96/faultmanager-autoroot)、[Homebrew Channel #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124)、[cani.rootmy.tv](https://cani.rootmy.tv/)

專案內：
- [LGTVG3](https://github.com/pcpcchen-coder/LGTVG3)（2026-11-09 讀取 main：SSAP、WOL、截圖、`lgtv url`；實機 OLED65G3PSA 紀錄）
- [LGTV-1 驗證](validation/lgtv-1-2026-11-07.md)、[LGTV-2 驗證](validation/lgtv-2-2026-11-08.md)、[20 Netflix 規劃](20_TV_Netflix_Playback_Plan_2026-11.md)
- [Raspberry Pi 終端套件](../terminals/rpi4/README.md)
