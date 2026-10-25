# 驗證紀錄索引

更新日期：2026-10-24。本目錄保留每次驗證的原始日期、方法與限制。舊紀錄不因新文件更新而升格為實機通過；後續結果以新增紀錄或明確補記呈現。

| 紀錄 | 證據範圍與限制 |
|---|---|
| [家人辨識 ID-00 spike](./family-id-00-spike-2026-10-24.md) | YuNet／MediaPipe／SFace 在雲端 headless Chromium 的 CPU／WASM 量測、OpenCV 交叉核對；公有領域肖像，cosine 只是 sanity check；Mac＋AR0144 待測 |
| [本次實作盤點](./implementation-review-2026-10-24.md) | 主線程式檢視、790 項測試、型別、建置與隔離 mock HTTP；未做真模型／硬體驗收 |
| [live 語音](./live-voice-2026-10-23.md) | fixture 為主；§4 有 Mac log、溫度查詢口頭結果；其他及計費待驗 |
| [看著說話問候](./look-to-talk-greet-2026-10-23.md) | fake 計時器與兩路狀態；600 ms 為估計，真鏡頭與語音待驗 |
| [選單設定集中](./menu-settings-consolidate-2026-10-23.md) | 型別、測試與語法；Electron 實際選單操作待驗 |
| [選單秒數與指令表](./menu-seconds-commands-2026-10-22.md) | 資料、指令與假頁面驗證；原生視窗及選單待驗 |
| [電子腦靠近放大](./brain-proximity-zoom-2026-10-23.md) | 假 Canvas／合成距離與截圖；非 AR0144 實測 |
| [距離 UI](./brain-distance-2026-10-22.md) | fixture 與建置畫面驗證；真實距離／可讀性待驗 |
| [鏡頭預覽](./camera-preview-2026-10-21.md) | 合成雙目影像、真 MediaPipe／Chromium；非實體雙目校正 |
| [六區動畫](./brain-regions-2026-10-20.md) | 應用事件與 fixture 視覺驗證；不是模型內部活動 |
| [一般對話](./chatgpt-conversation-2026-10-20.md) | 假帳號／語音與瀏覽器流程；不能替代真帳號及音訊驗收 |
| [智慧家庭 H0](./smarthome-h0-2026-10-21.md) | 查詢與假中控；後續口頭查溫度結果見 live 語音 §4 |
| [智慧家庭 H1](./smarthome-h1-2026-10-22.md) | 控制、冪等與示例中控；家中開關燈口頭結果見 docs/12 狀態 |
| [智慧家庭 H1b](./smarthome-h1b-2026-10-22.md) | AIFA／IR fixture 與未設定認證的真中控失敗路徑；真設備待驗 |

「真實中控程式」不必然有真實設備與帳號；「真瀏覽器」也可能在帳號、相機或音訊邊界使用 fixture。判讀時要讀每份紀錄的完整限制。

目前總覽見 [實作狀態](../Current_Implementation_Status.md)，擴充提案見 [功能評估](../13_Feature_Expansion_Assessment_2026-10-24.md)。
