<!-- bilingual: source=zh-TW -->

> [繁體中文](10_Distance_UI_18inch_2026-10.md) | [English](10_Distance_UI_18inch_2026-10.en.md)

<a id="nous-10--18-吋遠距-ui-設計畫面--語音"></a>
# Nous 10: distant UI on an 18-inch display (screen × voice)

Version v0.2 · Date 2026-10-21 · Status: design proposal, awaiting real 2 m validation.

> 2026-10-24 comparison: Distance scaling/proximity zoom code and fixture evidence exist, but 2 m readability and stereo precision remain unverified. See [current implementation](Current_Implementation_Status.en.md) and [13](13_Feature_Expansion_Assessment_2026-10-24.en.md) for Quest spatial results. Screen pixel sizes do not translate directly to Quest text sizes.

Related: 06 (brain/voice/gaze), 09 (Spoken Brief, external Project document).
Design: claude.ai Design canvas “Nous distant UI · 18-inch,” sources in [`docs/design/distance-ui-18in/`](./design/distance-ui-18in/) (`.dc.html`, 1920 × 1080 actual size).

---

<a id="0-一頁摘要"></a>
## 0. One-page summary

- **18 inches at 2 m equals 55 inches at 6.1 m**, harsher than TV UI's 3 m assumption. View angle is 11.4° × 6.4°.
- **Type sizes**: Hero 150 / Title 108 / Body 76 / Meta 56 px (1920 × 1080, 2.0 m). Body ≤22 Chinese characters/line, ≤3 selectable targets/screen.
- **Gaze at 2 m only separates sides**: WebGazer mean error 4.17° ≈700 px. **Spoken numbers primary, gaze coarse only**, max three columns, ≥540 px wide.
- **Four state channels**: Color, halo shape, label, sound. Peripheral recognition at a distance, text up close.
- **Borrow from TV**: Low density, clear focus, safe areas, contrast, numbered See-it Say-it labels. **Exclude** homepage rows, app rows, permanent sidebars under product constraints.
- **v0.2 roles**: **Voice carries full sentences, screen carries anchors, animation directs attention.** Two-second glance budget: ≤one focus term (≤6 Chinese characters) + one graphic/number at a time. See §5.

---

<a id="1-距離換算計算見-7"></a>
## 1. Distance conversion (calculations in §7)

| Item | Value |
|---|---|
| 18-inch 16:9 physical size | 398.5 × 224.1 mm |
| 1080p pixel pitch | 0.2075 mm |
| 1.5 m angle/equivalent | 15.1° × 8.5° / 55″ @4.6 m |
| **2.0 m angle/equivalent** | **11.4° × 6.4° / 55″ @6.1 m** |
| 2.5 m angle/equivalent | 9.1° × 5.1° / 55″ @7.6 m |

Design distance **2.0 m**. At another distance multiply dimensions by D ÷2.0 m.

> **2026-10-23 exception, George's decision**: Standby brain grows when approaching: 1× beyond 2.5 m, configured maximum within 0.6 m, default 2×. Text, panels, top thumbnail still follow D ÷2.0 m. See 11 §3 and [proximity validation](validation/brain-proximity-zoom-2026-10-23.en.md).

<a id="2-字級-token中文字高取-09-em"></a>
## 2. Typography tokens (Chinese height 0.9 em)

| Token | px @2.0 m | Angular character height | Use | 1.5 m | 2.5 m |
|---|---|---|---|---|---|
| Anchor | 200–300 | ≥64′ | Answer itself, ≤3 characters, e.g. supplier B | 150–225 | 250–375 |
| Hero | 150 | ≈48′ | Anchor, ≤6 characters | 113 | 188 |
| Title | 108 | ≈35′ | State, option names | 81 | 135 |
| Body | 76 | ≈24′ | Options, numbers, captions | 57 | 95 |
| Meta | 56 | ≈18′ | Hints, sources, mock label | 42 | 70 |

TV minimum 24 px at 55″/3 m gives about 16′ Chinese height. Meta exceeds that minimum. Weight ≥500, no thin fonts.

<a id="3-版面規則"></a>
## 3. Layout rules

- Safe area: 96 px horizontal, 64 px vertical (tvOS 90/60, Android TV 5%).
- Reserve bottom 64–200 px for captions/voice hints rather than content.
- One main result + at most one secondary (06 §2.2), 2–3 regions for comparison.
- Every target has a **large number**, an 88–96 px circular label, matching speech rather than relying on colors/position.
- Brain: 780 px centered in standby, 500–540 px listening/working, 140–200 px corner status during presentation.

<a id="4-狀態四重編碼"></a>
## 4. Four-channel state encoding

| State | Color | Halo | Label | Proposed sound | Voice |
|---|---|---|---|---|---|
| ambient | Dark blue | Faint thin ring | — | None | Silent |
| listening | Cyan #4FD1FF | Full bright ring | Listening | Two rising notes | Stop output, wait |
| working | Blue-violet #8B9CFF | Completed/total-step arc | Working 2/5 | None, short background-complete bell | Opening sentence then quiet |
| presenting | White #DDE8FF | Expanding double ring | Explaining | None | Conclusion ≤2 sentences |
| clarifying | Amber #FFB547 | Dashed ring | Your decision | Two falling notes | Question/default |
| confirming | Amber + screen border | Thick solid ring | Confirm | Two falling notes twice | Fixed action/target/consequence |
| recoverable_error | Coral #FF6B6B | Static broken ring | Incomplete | One low note | Reason, retained work, next step |
| task succeeded | Green #4ADE80 once | Flash then standby | Done | Three rising notes | “Ready on screen” |

Halos/arcs follow real events only (06 §2.1, CLAUDE.md). No progress arc before planning completes.

<a id="5-畫面--語音分工v02語音主講畫面放錨點"></a>
## 5. Screen × voice roles (v0.2)

v0.1's readable cards could not be understood at a glance from far away. Users had to wait for speech. v0.2 uses three layers:

| Layer | Carrier | Rule |
|---|---|---|
| **Anchor** | Remains onscreen | Key term/answer (“Supplier B,” “Third supplier?”, “Send → Manager Wang”). Remains after speech for late arrivals or missed audio. |
| **Follow-along** | Animation | Current spoken item lights/grows, others fade to 35%. Content animation guides attention, timed by real TTS playback. |
| **Details** | Email to user | Numbers, reasons, sources go into an emailed report, not the 18-inch display (George, 2026-10-21). Show “full report emailed” only after a **success event**. |

Email is an external side effect. Proposal: one-time setup authorization recorded in Action Gate when the recipient is **the user themself**. Other recipients need current confirmation (screen 07). Show failure truthfully.

Rules:

1. **Two-second glance**: ≤one term (≤6 characters) + one graphic/number. Borrow NHTSA's two-second glance ceiling, pending §8 V1 measurement.
2. Full sentences go to voice. **No complete sentences/subtitles onscreen**. Voice does not merely read displayed words.
3. Compare with length bars (longer is better), without numeric tables.
4. “Say …” appears when an answer is needed, clarifying/confirming. Otherwise fades in after 8 seconds idle.
5. Defaults use countdown rings rather than “use 2 after 10 seconds.”
6. **Safety exception**: Confirmation displays action, target, consequences as three anchors (06 §2.2), not audio alone. Fixed phrase “Confirm send,” auto-cancel at zero.
   - **Confirmation icon**: Amber speech bubble + check, consistently meaning spoken confirmation. Only where “Confirm execution” is required, including confirmation cards/state table. Design `ConfirmIcon.dc.html`, code `prototype/ambient-shell/src/icons.ts`.
7. Focus: 1.04×, 8 px bright border, glow, “Pointed.” Selection only, no action (06 §4.4).

<a id="51-語音稿--畫面錨點示意"></a>
### 5.1 Spoken scripts and anchors (illustrative)

| Screen | Full spoken sentence | Anchor |
|---|---|---|
| 03 Working | “Started, around five steps,” then quiet | Working 2/5, quantitative region |
| 04 Decision | “Which third supplier: Delta, my nomination, or only two? Without an answer I'll nominate.” | Third? 1 Delta / 2 Nous countdown / 3 Two |
| 05 Conclusion | “Supplier B: lowest price, best efficiency, shortest lead time.” | B ✓, price/efficiency/lead time highlight in sequence |
| 06 Comparison | “B leads all three; A has longest lead time.” | Three bar columns, B highlighted |
| 07 Confirmation | “Send the PCS comparison to purchasing Manager Wang. It cannot be recalled. Say ‘Confirm send.’” | Send → Wang, comparison, irreversible |
| 08 Incomplete | “C lead time timed out three times. A/B are complete and saved. Compare two, provide data, or retry?” | A ✓ B ✓ C ✕, 1 Two / 2 Data / 3 Retry |
| 09 Brief | Changes only: “Budget is 3.5 million. One question: third supplier?” | Decided/pending chips, changed item bright, dispatch locked until answered |

See `Glance.dc.html` for estimated timing, to be adjusted through real TTS measurements.

<a id="6-畫面清單設計稿"></a>
## 6. Design screens

| File | State | Focus |
|---|---|---|
| `Main.dc.html` | Specification | Distance/type/gaze/TV choices |
| `StateCoding.dc.html` | Encoding | Eight states ×four channels |
| `Glance.dc.html` | Roles | Three layers, screen 05 speech timeline |
| `Brain.dc.html` | Component | size/tone/mode/progress/region/dim |
| `ConfirmIcon.dc.html` | Component | size/variant (amber, ink)/glow |
| `S01`–`S03` | ambient → listening → working | Main flow |
| `S04`–`S06` | clarifying/presenting/comparison focus | When needed |
| `S07`–`S09` | confirming/error/Spoken Brief | Critical moments |

Supplier numbers are **illustrative**, labeled in the designs.

<a id="7-計算方式"></a>
## 7. Calculations

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

- At 2.0 m: FOV 11.4°, equivalent 6.1 m, gaze error 703 px.
- Angular type height: `atan(px × 0.9 × p ÷ D)`.

<a id="8-待驗證建議併入-g1"></a>
## 8. Pending validation (suggested during G1)

| # | Question | Method |
|---|---|---|
| V1 | Readability at 1.5/2.0/2.5 m | Real 18″, six people, accuracy/time reading states/numbers |
| V2 | Peripheral state recognition | While doing another task, recognition delay |
| V3 | Left/right gaze at 2 m | Real error determines two/three columns |
| V4 | Disruptive sounds | Compare silence, NASA-TLX |
| V5 | Anchors/follow-along vs v0.1 cards | Same content, recall after two-second glance, understanding time, waiting for speech |

<a id="來源查閱日期-2026-10-21"></a>
## Sources (accessed 2026-10-21)

- [Fire TV Design and User Experience Guidelines (10-ft UI)](https://developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html)
- [Android TV Style (5% overscan, no thin fonts)](https://iut-fbleau.fr/docs/android/design/tv/style.html)
- [tvOS HIG TL;DR (90/60 px safe area)](https://2023.redalemeden.com/blog/2015/tvos-hig-tldr)
- [Alexa Multimodal Design (voice first, glanceable, spoken labels)](https://developer.amazon.com/en-US/alexa/alexa-haus/multimodal-introduction)
- [WebQAmGaze (4.17° WebGazer mean error)](https://arxiv.org/pdf/2303.17876)
- [MRTK See-it, Say-it Label](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk3-uxcore/packages/uxcore/seeitsayit-label)
- [Designing a 10ft UI (24 pt minimum, low density)](https://pascalpotvin.medium.com/designing-a-10ft-ui-ae2ca0da08b7)
- [NHTSA distraction guidelines (2 seconds/glance, 12 seconds/task)](https://www.autoblog.com/2013/04/25/nhtsa-voluntary-guidelines-distracted-driving/)
