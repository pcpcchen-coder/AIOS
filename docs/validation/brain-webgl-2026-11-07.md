<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-webgl-2026-11-07.md) | [English](brain-webgl-2026-11-07.en.md)

# 電子腦 WebGL 繪製（方案 B）驗證

日期：2026-11-07。分支 `claude/brain-webgl`（基於 main `7bce73c`）。狀態：**程式、單元測試、無頭 Chromium（軟體 WebGL）的相對量測與畫面比對完成；Raspberry Pi 4 的硬體 GPU 上未驗證。**

## 目的

[方案 A](brain-canvas-perf-2026-11-06.md) 把 Canvas 2D 每格主執行緒時間減少約六成，但點陣化（把指令畫成像素）仍由瀏覽器做。方案 B 加上第二種繪製方式：用 WebGL 把粒子、連線、光暈與光環交給 GPU 畫。它是設定畫面裡的一個開關，**每台裝置預設關閉**；Canvas 2D 繪製不變，仍是預設。

腦區要求不變：語言、數理、藝術、聽覺、視覺、規劃六區只由真實事件（任務步驟的 `domain`、對話主題分類、真的在播的語音）亮起、發出光脈衝並顯示區名，兩種繪製方式相同。

## 設計

### 狀態與繪製分開

| 檔案 | 內容 |
|---|---|
| `prototype/ambient-shell/src/brain.ts` | `Brain` 保留所有狀態：事件、`step()`、投影、點擊範圍、效能設定、`frameStats()`。`draw()` 只把這一格的資料算進 `BrainFrame`，再交給目前的繪製方式 |
| `prototype/ambient-shell/src/brain-frame.ts` | 每格的繪製輸入 `BrainFrame`（預先配置、每格覆寫）與共用顏色 |
| `prototype/ambient-shell/src/brain-canvas.ts` | Canvas 2D 繪製（原本 `draw()` 的程式搬過來）與兩邊共用的 `drawRegionLabels` |
| `prototype/ambient-shell/src/brain-webgl.ts` | WebGL 1 繪製、context 建立與失敗判斷 |

`BrainFrame` 的內容：投影後的粒子位置（`Float32Array`，x、y、深度）、每個粒子這一格的顏色（整數 RGB）、透明度與大小（`Float64Array`）、連線依深度分四組後的順序與各組顏色透明度、各腦區亮度與螢幕中心、光脈衝的線段與光點位置（`Float64Array`）、中心光暈與軌道參數、各光環的顏色、透明度、線寬與模糊。顏色與腦區亮度只在 `Brain` 算一次，兩種繪製方式讀同一份資料。

Canvas 版和 main 逐像素相同：`scripts/bench-brain.mjs --baseline origin/main` 在完整、平衡、省電各 4 格（第 1、30、120、300 格）共 12 張，差異像素都是 0；對方案 A 之前的固定基準（`d28ce23`）仍在原門檻內（看得到的差異最多 2/255、0.109% 像素）。

### WebGL 繪製

- WebGL 1（Pi 支援最廣），context 參數 `premultipliedAlpha: true, antialias: false, failIfMajorPerformanceCaveat: true`，沒有 depth／stencil。
- 粒子、粒子光暈、光脈衝光點：point sprite。粒子是實心方塊（小於 1 個裝置像素時以面積降低透明度）；光暈與光點在片段著色器裡照 Canvas 的光暈漸層與染色光點計算。
- 連線、腦區連線、光脈衝尾巴：`GL_LINES`，每個頂點帶顏色與透明度。GL 線固定 1 個裝置像素寬，以透明度補回 Canvas 線寬（CSS 像素 × 裝置像素比）的亮度。
- 軌道：`GL_LINE_LOOP`（96 段的橢圓）。
- 中心光暈、腦區光暈、聆聽／通話光環、連線中虛線環、處理中波紋、進度環：畫在方形上的著色器（徑向漸層；圓環含虛線、圓頭與對角漸層；聆聽光環的 `shadowBlur` 以高斯衰減近似）。
- 合成：中心光暈、軌道與光環用一般疊加（`ONE, ONE_MINUS_SRC_ALPHA`）；腦區光暈、連線、粒子、光脈衝用相加（`ONE, ONE`），對應 Canvas 的 `lighter`。
- 每格的頂點寫進建腦後配置一次的兩個 `Float32Array`（點與線；容量約 29 KB 與 141 KB），以 `bufferSubData` 只上傳這格用到的那段（`subarray(0, 用到的長度)`，每格兩個不複製資料的小 view）；每格不建立新的陣列或 buffer。量測情境完整模式第 120 格依計數換算約上傳 23 KB 與 86 KB。
- 頂點與片段著色器之間不共用 uniform：片段著色器只拿到相對中心的座標。頂點著色器的 uniform 預設 highp，片段著色器在不支援 highp 的 GPU 上是 mediump，兩邊共用的 uniform 精度不同會讓程式連結失敗。
- 連線中虛線環的虛線偏移在 JavaScript 先取一個週期（虛線＋間隔）內的值才交給著色器：原值隨時間無限增大，以 float32 傳進去，開機幾天後精度不足會讓虛線跳動。Canvas 版仍用原值。
- 效能設定一樣生效：每秒格數上限、解析度上限（GL 畫布與區名疊層同解析度）、光脈衝上限、簡化光暈（粒子光暈減半、光點縮小）、聆聽光環不模糊。
- 區名：WebGL 畫布插在原本的 `#brain` 畫布下方，`#brain` 改當透明的 2D 疊層，用同一個 `drawRegionLabels` 畫區名，仍接收點擊。沒有區名、上一格也沒有時不清這張畫布。

### 改回 Canvas 的情況

開關打開時：

1. 建立 WebGL context 失敗（沒有硬體 WebGL，或瀏覽器回報 major performance caveat）→ 改用 Canvas。
2. 拿到的是軟體 WebGL（renderer 名稱含 SwiftShader、llvmpipe、softpipe）→ 視為沒有硬體 WebGL，改用 Canvas。
3. 有硬體 WebGL，但著色器編譯、程式連結或建立緩衝區失敗 → 改用 Canvas，「目前」一行說「WebGL 初始化失敗」，不說沒有硬體 WebGL。
4. 執行中觸發 `webglcontextlost` → 改用 Canvas。

改回後這次開啟頁面期間都用 Canvas（關掉再打開開關也一樣），重新整理頁面才再試；任何 context lost（包括 GPU 短暫重設後瀏覽器本來可以恢復的情況）都一樣，WebGL 要重新開啟頁面才會再用。`webglcontextlost` 觸發後的下一格就用 Canvas 畫；但事件送到之前，可能有一兩格是空白的。原因寫在 console（`[brain] WebGL 不可用，改用 Canvas：…`）。

### 設定與狀態

「設定」→「這台裝置的畫面效能」：

- 新開關「使用 GPU 繪製（WebGL）」／“Use GPU drawing (WebGL)”，和完整／平衡／省電互不影響，每台裝置預設關閉，立即生效、不重新載入。
- 保存在另一個鍵 `nous.performance.gpu.v1`（值 `on`／`off`），所以既有的 `nous.performance.v1` 不必遷移；沒有這個鍵、值不合法或讀不到時一律是關閉。
- 「目前」一行照實寫真的在用哪一種：

| 狀態 | 繁體中文 | English |
|---|---|---|
| 用 WebGL | 目前：WebGL | Current: WebGL |
| 開關關閉 | 目前：一般繪製（Canvas） | Current: standard drawing (Canvas) |
| 開了但沒有硬體 WebGL（拿不到 context，或只有軟體 WebGL） | 此裝置沒有硬體 WebGL，已改用一般繪製 | This device has no hardware WebGL; using standard drawing instead |
| 開了、有 WebGL，但著色器、連結或緩衝區建立失敗 | WebGL 初始化失敗，已改用一般繪製 | WebGL failed to start; using standard drawing instead |
| 執行中 WebGL 中斷 | WebGL 中斷，這次開啟期間改用一般繪製 | WebGL stopped working; using standard drawing until the page is reopened |

- 開關說明：「預設關閉。和上面的設定可以一起用；這台裝置沒有硬體 WebGL 或 WebGL 中斷時，自動改回一般繪製。」
- 「實測」一行兩種繪製方式量的是同一段：主執行緒的 `step()` 加 `draw()`（WebGL 版含寫頂點、上傳與送出 GL 指令、區名疊層），不含 GPU 真正畫完的時間；這行原本就註明不含 GPU。換繪製方式時重新量。

## 在 Pi 上怎麼開與怎麼確認

1. 先確認 Chromium 有硬體 WebGL：在 Pi 的桌面開一個一般的 Chromium 視窗（不是 kiosk），網址列輸入 `chrome://gpu`，看「Graphics Feature Status」裡的 **WebGL: Hardware accelerated**。若是 *Software only* 或 *Unavailable*，開關打開也會改回一般繪製。
2. 在 Pi 頁面開「設定」→「這台裝置的畫面效能」，打開「使用 GPU 繪製（WebGL）」。
3. 看「目前」一行：「目前：WebGL」才是真的在用 GPU；若顯示「此裝置沒有硬體 WebGL，已改用一般繪製」，回到第 1 步。
4. 比較：同一檔（建議「平衡」）、同樣情境（最好是即時語音通話中，腦區亮起、光脈衝最多），開關關閉與打開各等 1 分鐘，記下「實測：每秒 N 格，每格主執行緒繪製 M 毫秒」，並一併記 `top` 裡 Chromium 的 CPU 與 `vcgencmd measure_temp`。每秒格數是最直接的判斷：主執行緒毫秒數不含 GPU。
5. 覺得變慢或畫面有問題，關掉開關即可，立即回到一般繪製。結果請補記在本文件或 [Pi 畫面效能紀錄](pi-performance-2026-11-05.md)。

## 量測方法

腳本：`prototype/ambient-shell/scripts/bench-brain.mjs --webgl`。它把工作目錄的 `brain.ts`（含兩種繪製方式）以 esbuild 打包，在同一個無頭 Chromium 頁面（1920×1080、裝置像素比 1、跨來源隔離，`performance.now()` 解析度 5 µs）裡，同一個 `Brain` 分別用 Canvas 與 WebGL 跑方案 A 的固定情境：即時語音接通、聆聽、正在說話、處理中、進度 0.4、語言區（語音播放）與規劃區（主題分類）亮起；`Math.random` 固定種子，每 15 格送 `step`、`stream`、`stepDone` 光脈衝，每 90 格一次處理中波紋。

- 「step＋draw」：每格固定 `dt = 1 / maxFps`，在 `requestAnimationFrame` 裡呼叫一次 `step()` 加 `draw()`，範圍和 `frameStats()` 相同。
- 「step＋draw＋等 GPU」：每格量完後再等這一格真的畫完：WebGL 用 `gl.readPixels` 讀 1 個像素，加上 2D 畫布（WebGL 時是區名疊層）的 `getImageData(0, 0, 1, 1)`；Canvas 只用後者。
- 每一檔先 60 格暖機、再量 300 格；每次執行依序跑三檔，Canvas 與 WebGL 的先後每次交替。共 5 次，報告 5 次中位數的中位數與 5 次的範圍，p95 同樣處理。
- 確認真的有畫：每次都檢查實際在用的繪製方式是要量的那一種；WebGL 每格的計數是 775 個粒子、2764 個連線頂點（1382 條）、腦區連線、和 Canvas 相同數量的光脈衝與 3 個光環。
- 軟體 WebGL：容器裡沒有 GPU，Chromium 的 WebGL 是 SwiftShader（`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`）。正式頁面會拒絕它（`failIfMajorPerformanceCaveat` 與 renderer 名稱檢查），量測腳本用只給量測用的 `allowSoftware` 放寬。

```
cd prototype/ambient-shell
node scripts/bench-brain.mjs --webgl --runs 5
node scripts/bench-brain.mjs --skip-bench --baseline origin/main
```

第二行是 Canvas 版的逐像素檢查（對 main）。執行條件和方案 A 相同：需要可載入的 Playwright 與 Chromium（本次容器預先安裝，`package.json` 沒有這個依賴）；不在 CI 或 `npm test` 裡執行。`--shots <資料夾>` 會把下面畫面比對的截圖存到指定資料夾（不放進 repo）。

環境：雲端容器 x86、4 核，開始時 load average 0.02；Chromium 153.0.8010.12 無頭模式；Node v22.23.4。**軟體 GL、容器內的相對比較，不是 Pi 的數字。**

## 結果

### 每格 step＋draw（主執行緒，毫秒；5 次執行的中位數，括號內是 5 次的範圍）

| 設定 | Canvas 中位數 | WebGL 中位數 | 變化 | Canvas p95 | WebGL p95 |
|---|---|---|---|---|---|
| 完整 | 0.570（0.515–0.620） | 0.350（0.325–0.370） | −38.6% | 0.790（0.650–0.895） | 0.520（0.450–0.620） |
| 平衡 | 0.540（0.505–0.570） | 0.340（0.340–0.345） | −37.0% | 0.780（0.680–0.855） | 0.510（0.455–0.535） |
| 省電 | 0.500（0.470–0.555） | 0.345（0.305–0.350） | −31.0% | 0.705（0.665–0.775） | 0.510（0.475–0.585） |

中位數的範圍沒有重疊。主執行緒上 WebGL 少的是 Canvas 的路徑指令與每組 `fillStyle`／`globalAlpha` 設定；`step()` 與準備 `BrainFrame` 兩邊相同，所以剩下的約 0.34 ms 大多是共用部分加上寫頂點陣列。

### 含等 GPU 畫完（step＋draw＋等 GPU，毫秒）

| 設定 | Canvas 中位數 | WebGL 中位數 | 變化 | Canvas p95 | WebGL p95 |
|---|---|---|---|---|---|
| 完整 | 9.665（9.340–10.120） | 27.280（26.250–27.865） | +182.3% | 13.740（12.320–15.175） | 32.810（31.775–34.705） |
| 平衡 | 7.450（7.405–7.880） | 24.765（24.225–25.520） | +232.4% | 8.305（8.105–11.545） | 30.195（29.825–34.000） |
| 省電 | 4.980（4.795–6.905） | 15.435（15.020–16.555） | +209.9% | 8.095（6.965–8.335） | 19.615（18.790–20.860） |

在這個容器，WebGL 由 SwiftShader 在 CPU 上逐像素執行著色器，比 Chromium 的 Canvas 點陣化慢約 3 倍。沒有 profile 是哪一段最貴；中心光暈與光環是覆蓋數十萬像素的方形著色器，是最可能的來源（未驗證）。軟體 WebGL 比 Canvas 慢，正是正式頁面拒絕它的原因。**這一表不能用來推測 Pi 的硬體 GPU**；Pi 上的答案只能照「在 Pi 上怎麼開與怎麼確認」實測。

### 畫面比對（第 120 格，同一個固定情境）

兩種繪製方式各自把畫面（WebGL 時是 GL 畫布加上區名疊層）疊到黑底，整張 1920×1080 分成 16×9 格算平均亮度：

| 設定 | 格子亮度相關係數 | 格子平均絕對差 | 平均亮度 Canvas／WebGL | 亮點比例 Canvas／WebGL | 語言區亮度 Canvas／WebGL | 規劃區亮度 Canvas／WebGL |
|---|---|---|---|---|---|---|
| 完整 | 0.997 | 0.0018 | 0.0252／0.0268 | 14.9%／15.3% | 0.307／0.302 | 0.372／0.367 |
| 平衡 | 1.000 | 0.0002 | 0.0233／0.0231 | 13.1%／13.1% | 0.322／0.318 | 0.363／0.358 |
| 省電 | 1.000 | 0.0002 | 0.0239／0.0238 | 13.7%／13.7% | 0.399／0.394 | 0.381／0.375 |

- 亮度是 0–1 的相對亮度（0.2126 R + 0.7152 G + 0.0722 B）；亮點是亮度大於 8/255 的像素；腦區亮度是該區螢幕中心半徑 0.3 R 內的平均。
- 兩種方式畫出的區名相同（「語言區 · 語音播放」「規劃區 · 主題分類」），光脈衝數相同（完整 34、平衡 20、省電 8），WebGL 每一個都有畫。
- 人工看截圖：腦形、連線、粒子顏色、腦區亮起、光脈衝、進度環與區名位置一致。看得出的差別是 WebGL 的線沒有反鋸齒（較銳利）、完整模式聆聽光環的模糊略寬（相關係數 0.997 與亮度 +6% 主要來自這裡）。
- 腳本的通過條件：區名相同且不為空、光脈衝數相同且 WebGL 全部畫出、格子相關係數大於 0.9。

## 自動測試（Linux 雲端）

| 檢查 | 結果 |
|---|---|
| `tests/brain-webgl.test.ts`（新，24 項，假的 WebGL context 記錄呼叫） | 要求 WebGL 1、`premultipliedAlpha`、不反鋸齒、拒絕 major performance caveat；GL 畫布插在原畫布下方；每格畫 775 個粒子、所有連線、兩條軌道與光脈衝，並用相加合成；只上傳用到的長度、不超過預先配置的大小、配置只有 3 次、每格重複使用同兩個陣列；四個 GL 程式的兩階段共用 uniform 精度一致（解析著色器原始碼）；開機一個月後虛線偏移仍在一個週期內；完整／平衡／省電的每秒格數、解析度與光脈衝上限；省電的粒子光暈較少、平衡與省電的光環不模糊；區名畫在疊層、腦區暗下後不畫；建立失敗、丟例外、軟體 renderer 改回 Canvas 並回報沒有硬體 WebGL，著色器編譯、連結、建立緩衝區失敗改回 Canvas 並回報初始化失敗，都照畫並說原因，這次開啟期間不再試；context lost 改回 Canvas、不再呼叫 `loseContext`；關掉開關移除 GL 畫布並釋放 context；預設不碰 WebGL |
| `tests/performance.test.ts`（新增 5 項） | 開關預設關閉、每台裝置保存、和三檔分開；舊的 `nous.performance.v1` 不必遷移；不合法的值與壞掉的儲存都視為關閉；「目前」一行的五種文字；`src/brain-webgl.ts` 的 import 不碰收音、播放、即時語音等模組 |
| `tests/performance-settings-view.test.ts`（新增 14 項） | 瀏覽器版與 App 版都畫開關，中英文、`aria-pressed`、`aria-label`；五種狀態的「目前」文字；點擊要求相反狀態；`refreshPerformanceReadout` 更新「目前」一行；新字串都有英文翻譯 |
| 既有電子腦測試 | `brain-performance`、`brain-regions`、`brain-distance` 不改即通過（Canvas 路徑） |
| 全部 | `npm run typecheck` 通過；`npx vitest run` 159 個檔案、2932 項通過、5 項略過；`npm run build` 通過 |

## 限制

- **沒有在 Pi 的硬體 GPU 上跑過。** Pi 4 的 VideoCore VI 在 Chromium 下是否有硬體 WebGL、填充率是否夠，以及實際每秒格數，都未知。
- 量測的 WebGL 是 SwiftShader（CPU 上的軟體 GL），而且量測腳本特地放寬了 `failIfMajorPerformanceCaveat`；正式頁面會拒絕軟體 WebGL。這些數字只能比較主執行緒的相對成本，不能推算 Pi 上的毫秒數或 GPU 成本。
- 和 Canvas 不是逐像素相同：GL 線沒有反鋸齒、固定 1 個裝置像素寬（以透明度補亮度）；聆聽光環的模糊是近似；粒子方塊對齊像素；區名畫在上層的 2D 疊層，所以 WebGL 模式下區名蓋在聆聽光環與進度環上面（Canvas 版是光環蓋在區名上面）。比對只用粗略指標（亮度格子、亮點比例、腦區亮度），加上人工看截圖。
- 每格上傳用到的頂點資料（量測情境約 109 KB，最多約 170 KB），GPU 記憶體頻寬的影響沒有量。
- 沒有測 `webglcontextlost` 在真實瀏覽器裡的觸發，只有單元測試以假的 context 觸發事件。
