# Nous 10 — 18 吋遠距 UI 設計（畫面 × 語音）

版本：v0.1 · 日期：2026-10-21 · 狀態：設計提案（待實機 2 m 驗證）
關聯：06（電子腦／語音／視線）、09（Spoken Brief 交辦單，見 Project 文件）
設計稿：claude.ai Design 畫布「Nous 遠距 UI · 18 吋」；原始檔在 [`docs/design/distance-ui-18in/`](./design/distance-ui-18in/)（`.dc.html`，1920 × 1080 實尺寸）

---

## 0. 一頁摘要

- **18 吋在 2 m 看，等同 55 吋電視在 6.1 m 外看**，比電視 UI 假設的 3 m 更嚴苛。整個畫面只佔 11.4° × 6.4° 視角。
- **字級**：Hero 150 / Title 108 / Body 76 / Meta 56 px（1920 × 1080 畫布，2.0 m）。Body 每行 ≤ 22 字，一畫面 ≤ 3 個可選目標。
- **視線在 2 m 只能分左右**：WebGazer 平均誤差 4.17° ≈ 700 px。決定：**語音編號為主，視線只做粗指向**（最多 3 欄、目標寬 ≥ 540 px）。
- **狀態四重編碼**：顏色 × 光環形狀 × 狀態字 × 提示音。遠處靠餘光辨識，走近才讀字。
- **向電視借**：低密度、明顯焦點、安全區、深底高對比、編號標籤（See-it Say-it）。**不借**：首頁內容列、App 圖示列、常駐側欄（違反產品紅線）。
- **分工**：聲音說結論與變更；畫面放證據與選項。不念畫面上已有的清單。

---

## 1. 距離換算（計算見 §7）

| 項目 | 值 |
|---|---|
| 18 吋 16:9 實際尺寸 | 398.5 × 224.1 mm |
| 1080p 像素間距 | 0.2075 mm |
| 1.5 m 視角 / 等效 | 15.1° × 8.5° / 55″ @ 4.6 m |
| **2.0 m 視角 / 等效** | **11.4° × 6.4° / 55″ @ 6.1 m** |
| 2.5 m 視角 / 等效 | 9.1° × 5.1° / 55″ @ 7.6 m |

設計觀看距離取 **2.0 m**。實際距離不同時，所有尺寸 × (D ÷ 2.0 m)。

## 2. 字級 token（中文字高取 0.9 em）

| Token | px @ 2.0 m | 字高視角 | 用途 | 1.5 m | 2.5 m |
|---|---|---|---|---|---|
| Hero | 150 | ≈ 48′ | 一句結論、提問 | 113 | 188 |
| Title | 108 | ≈ 35′ | 狀態字、選項名 | 81 | 135 |
| Body | 76 | ≈ 24′ | 選項、數值、字幕 | 57 | 95 |
| Meta | 56 | ≈ 18′ | 提示、來源、模擬標示 | 42 | 70 |

對照：電視常用最小 24 px（55″、3 m）中文字高約 16′；Meta 已高於電視下限。字重 ≥ 500，不用細體。

## 3. 版面規則

- 安全區：左右 96 px、上下 64 px（tvOS 90 / 60；Android TV 5%）。
- 底部 64–200 px 保留給字幕帶與語音提示，不放內容。
- 一畫面：1 個主要成果 + 最多 1 個輔助（延續 06 §2.2）。比較時 2–3 個大區塊。
- 每個可選目標都有**大編號**（88–96 px 圓標）＝語音說法；不靠顏色或位置描述。
- 電子腦隨狀態縮放：待機 780 px 置中 → 在聽／處理 500–540 px → 呈現時縮為 140–200 px 角落狀態球。

## 4. 狀態四重編碼

| Shell 狀態 | 顏色 | 光環 | 狀態字 | 提示音（提案） | 語音行為 |
|---|---|---|---|---|---|
| ambient | 暗藍 | 淡細環 | — | 無 | 不說話 |
| listening | 青 #4FD1FF | 完整亮環 | 在聽 | 喚醒上行兩音 | 停止播報，等你說完 |
| working | 藍紫 #8B9CFF | 進度弧（完成步數 ÷ 總步數） | 處理中 2/5 | 無；背景完成短鈴 | 開始一句，之後安靜 |
| presenting | 白 #DDE8FF | 外擴雙環 | 說明中 | 無 | 只念結論 ≤ 2 句 |
| clarifying | 琥珀 #FFB547 | 虛線環 | 等你決定 | 下行兩音 | 念問題＋預設值 |
| confirming | 琥珀＋全螢幕外框 | 粗實線環 | 請確認 | 下行兩音 × 2 | 念動作、對象、後果；固定語句 |
| recoverable_error | 珊瑚紅 #FF6B6B | 斷環（靜止） | 沒做完 | 低音一聲 | 原因＋保留了什麼＋下一步 |
| task succeeded | 綠 #4ADE80（一次性） | 閃環後回待機 | 完成 | 上行三音 | 「好了，在畫面上」 |

光環與弧長只由真實事件驅動（06 §2.1、CLAUDE.md 誠實規則）。規劃完成前不畫弧。

## 5. 畫面 × 語音分工

1. 聲音說結論與**變更**；畫面放證據與選項。
2. 不念畫面上已有的清單；長內容只說「在畫面上」。
3. 字幕帶最多 2 行；呈現成果時縮為狀態球脈衝，不重複字幕。
4. 澄清只問一題，附預設值與倒數（「不回答，10 秒後用 2」）。
5. 外部動作要求固定語句「確認寄出」；「好」不算確認；有倒數自動取消；加全螢幕外框。
6. 視線焦點樣式：放大 1.05 + 8 px 亮框 + 外光暈 +「已指向」字樣；注視只指向，不觸發動作（06 §4.4）。

## 6. 畫面清單（設計稿）

| 檔案 | 狀態 | 重點 |
|---|---|---|
| `Main.dc.html` | 規範 | 距離換算、字級、視線限制、借／不借 |
| `StateCoding.dc.html` | 編碼表 | 8 狀態 × 4 通道 |
| `Brain.dc.html` | 元件 | 電子腦：size / tone / mode / progress / region / dim |
| `S01`–`S03` | ambient → listening → working | 主流程 |
| `S04`–`S06` | clarifying、presenting、比較＋視線焦點 | 需要你時 |
| `S07`–`S09` | confirming、recoverable_error、Spoken Brief | 關鍵時刻 |

畫面中的供應商數值為**示意資料**，已在畫面標示。

## 7. 計算方式

```python
import math
W = 18*16/math.hypot(16,9)*25.4          # 398.5 mm
p = W/1920                                # 0.2075 mm/px
tv_p = 55*16/math.hypot(16,9)*25.4/1920   # 0.6342 mm/px
for D in (1.5, 2.0, 2.5):                 # m
    fov = 2*math.degrees(math.atan(W/2/(D*1000)))
    eq  = D*55/18                         # 等效 55″ 觀看距離
    gaze_px = D*1000*math.tan(math.radians(4.17))/p
px_for = lambda arcmin, D: D*1000*math.tan(math.radians(arcmin/60))/0.9/p
```

- 2.0 m：FOV 11.4°，等效 6.1 m，視線誤差 703 px。
- 字級視角＝`atan(px × 0.9 × p ÷ D)`。

## 8. 待驗證（建議併入 G1）

| # | 項目 | 方法 |
|---|---|---|
| V1 | 字級在 1.5／2.0／2.5 m 是否可讀 | 實機 18″，6 人，讀出狀態字與數值的正確率與時間 |
| V2 | 狀態可否只靠餘光辨識 | 受試者做別的事，記錄狀態變化被察覺的延遲 |
| V3 | 2 m 視線能否穩定分左右 | 實測 webcam gaze 誤差；決定比較畫面最多 2 欄或 3 欄 |
| V4 | 提示音是否干擾 | 與無提示音對照，NASA-TLX |

## 來源（查閱日期 2026-10-21）

- [Fire TV Design and User Experience Guidelines（10-ft UI）](https://developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html)
- [Android TV Style（overscan 5%、避免細字）](https://iut-fbleau.fr/docs/android/design/tv/style.html)
- [tvOS HIG TL;DR（安全區 90 / 60 px）](https://2023.redalemeden.com/blog/2015/tvos-hig-tldr)
- [Alexa Multimodal Design（voice-first、glanceable、每個目標有語音說法）](https://developer.amazon.com/en-US/alexa/alexa-haus/multimodal-introduction)
- [WebQAmGaze（WebGazer 平均誤差 4.17°）](https://arxiv.org/pdf/2303.17876)
- [MRTK See-it, Say-it Label](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk3-uxcore/packages/uxcore/seeitsayit-label)
- [Designing a 10ft UI（最小 24 pt、低密度）](https://pascalpotvin.medium.com/designing-a-10ft-ui-ae2ca0da08b7)
