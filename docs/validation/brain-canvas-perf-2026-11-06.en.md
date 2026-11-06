<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-canvas-perf-2026-11-06.md) | [English](brain-canvas-perf-2026-11-06.en.md)

<a id="電子腦-canvas-每格成本優化方案-a驗證"></a>
# Validation: cutting the electronic brain's per-frame Canvas cost (plan A)

Date: 2026-11-06. Branch `claude/brain-canvas-perf` (based on main `d28ce23`). Status: **code, pixel comparison and Linux cloud measurements done; the gain on a Raspberry Pi 4 is not measured.**

<a id="目的"></a>
## Purpose

The electronic brain (`prototype/ambient-shell/src/brain.ts`, Canvas 2D, 775 particles, 1382 connections) does not run smoothly on the Pi 4 terminal. This batch only lowers the main-thread `step()` plus `draw()` time per frame (exactly what the settings readout 「每格主執行緒繪製」 (main-thread drawing per frame) measures), with no visible change to the picture. The performance settings (Full / Balanced / Light), the frame-rate cap, reduced motion and the meaning of `frameStats()` are unchanged; regions still light up from real events and draw pulses and region names.

<a id="先找限制因素"></a>
## Finding the limiter first

Chromium's CPU profiler (50 µs sampling, in runs not used for the reported numbers) over 630 frames of the old code: `drawNodes` self time was about 60% of the brain's sampled JavaScript time, followed by building `rgba()` strings. The cause: every particle built an `rgba(r,g,b,a.toFixed(3))` string every frame and handed it to `fillStyle` to parse, 775 times per frame.

<a id="改了什麼"></a>
## What changed

| # | Technique | Effect on the picture |
|---|---|---|
| A1 | Each particle's base colour (constant over time) is stored in a `Float64Array` when the brain is built; the colour is still computed per particle per frame (RGB truncated to integers, as the old `rgba()` did), opacity moves to `globalAlpha` (a number), and `fillStyle` uses a cached `rgb()` string | `globalAlpha` rounds differently from the three-decimal opacity in the string; at most 2/255 after compositing over a background |
| A2 | Particles are grouped by colour (counting sort, reused arrays) before drawing, so each group sets `fillStyle` once; particle glows are drawn in a second pass | This part draws with `lighter` (additive) compositing, so the order does not change the result: A1 ungrouped and A2 grouped have exactly the same pixel differences |
| A3 | A pulse's stroke colour string is computed once when it spawns, its tinted glow sprite fetched once on first draw; the fade uses `globalAlpha` | The same rounding difference as A1 |
| A4 | The four depth groups of connections use reused typed arrays (counting sort), with no per-frame arrays or closures; order inside each group unchanged | None (identical paths) |

Not changed: the region glow gradients (their position changes every frame, and `tests/brain-performance.test.ts` also checks two gradients per frame), region names and rings, `step()`, and how pulses use random numbers.

<a id="量測方法"></a>
## Method

Script: `prototype/ambient-shell/scripts/bench-brain.mjs`. It takes the pre-optimization `brain.ts` with `git show` (pinned commit `d28ce235f98b75097c97e8efc5870407e1740b46`, not shipped in the product code) and the working-tree `brain.ts`, bundles each with esbuild, and runs both in the same headless Chromium page (1920×1080, device pixel ratio 1, cross-origin isolated so `performance.now()` has 5 µs resolution):

- Fixed scenario: realtime voice live, listening, speaking, processing, progress 0.4, the language region (speech playback) and planning region (topic) lit; `Math.random` uses a fixed seed, `step`, `stream` and `stepDone` pulses are sent every 15 frames, and a processing ripple every 90 frames. Old and new code receive exactly the same events.
- Each frame uses a fixed `dt = 1 / maxFps` (30 / 20 / 12) and calls `step()` plus `draw()` once inside `requestAnimationFrame`, the same span `frameStats()` measures.
- Each setting runs 60 warm-up frames, then 300 measured frames; each run goes through the three settings, and the old/new order alternates every run. 5 runs; reported as the median of the 5 per-run medians and the range across the 5 runs.
- A second set, "with rasterization": after each timed frame, `getImageData(0, 0, 1, 1)` forces the canvas to draw that frame's commands, timed together, so cost is not merely moved to later.
- Correctness: both versions draw the same pulse counts (31 / 21 / 12) and region names (「語言區 · 語音播放」 language · speech playback, 「規劃區 · 主題分類」 planning · topic); no page errors.

```
cd prototype/ambient-shell
node scripts/bench-brain.mjs --runs 5
```

Environment: x86 cloud container, 4 cores, load average about 0.9 at the start; Chromium 153.0.8010.12 headless, canvas rasterized by SwiftShader (software GPU); Node v22.23.4. **This is a relative comparison under x86 software rasterization, not Pi numbers.**

<a id="結果"></a>
## Results

<a id="每格-stepdraw主執行緒毫秒5-次執行的中位數括號內是-5-次的範圍"></a>
### step + draw per frame (main thread, ms; median of 5 runs, range across the 5 runs in parentheses)

| Setting | Before median | After median | Change | Before p95 | After p95 |
|---|---|---|---|---|---|
| Full | 1.600 (1.440–1.685) | 0.620 (0.565–0.650) | −61.2% | 2.420 (2.120–2.540) | 0.900 (0.870–1.040) |
| Balanced | 1.515 (1.415–1.560) | 0.600 (0.545–0.615) | −60.4% | 2.235 (2.075–2.335) | 0.890 (0.840–0.930) |
| Light | 1.425 (1.365–1.490) | 0.570 (0.500–0.590) | −60.0% | 2.195 (2.110–2.270) | 0.860 (0.710–0.900) |

The ranges do not overlap. Verdict: main-thread time drops by about 60%.

<a id="含點陣化stepdraw逼畫布畫出毫秒"></a>
### With rasterization (step + draw + forced canvas draw, ms)

| Setting | Before median | After median | Change |
|---|---|---|---|
| Full | 12.150 (11.775–12.740) | 11.320 (10.925–11.470) | −6.8% |
| Balanced | 9.800 (9.335–9.930) | 8.365 (8.240–8.760) | −14.6% |
| Light | 6.735 (6.565–6.945) | 5.930 (5.525–6.105) | −12.0% |

In this environment rasterization (SwiftShader) costs far more than recording the main-thread commands: 79%–95% of the with-rasterization time (computed by subtracting the medians of the two tables). This batch does not make it slower; it is 7–15% lower. On the Pi rasterization happens on the GPU or another thread, so the share will differ; see Limitations.

<a id="各做法的效果累加每列-5-次執行只量主執行緒"></a>
### Effect of each technique (cumulative, 5 runs per row, main thread only)

| Version | Full | Balanced | Light |
|---|---|---|---|
| Before (median of 20 runs over 4 batches; range) | 1.610 (1.520–2.265) | 1.600 (1.510–2.200) | 1.585 (1.400–2.175) |
| A1 particles: cached base colour + `globalAlpha`, ungrouped | 0.795 (0.770–0.850) | 0.770 (0.725–0.780) | 0.685 (0.650–0.730) |
| + A2 grouped by colour | 0.740 (0.725–0.800) | 0.685 (0.665–0.715) | 0.645 (0.620–0.670) |
| + A3 pulses | 0.695 (0.635–0.720) | 0.665 (0.640–0.745) | 0.630 (0.555–0.665) |
| + A4 connections (= shipped) | 0.650 (0.600–0.940) | 0.625 (0.595–0.805) | 0.590 (0.540–0.805) |

Almost all of the effect comes from A1 (about −50%). A2 and A3 each remove roughly another 0.03–0.06 ms with mostly separate ranges; A4's range overlaps the previous row, which is within noise, so no measurable effect is claimed for it (it is kept because it removes per-frame array allocation and the picture is identical). These numbers are a separate batch of runs, not the same runs as the main table. The intermediate versions were scratch files made by swapping the shipped `drawEdges` and `drawPulses` back to the old source and measured with `--candidate`; they are not in the repo. At that point a pulse's tinted glow sprite was still fetched at spawn; it was moved to the first draw afterwards (so `pulse()` does not touch the canvas), and the main table measures the version after that change.

<a id="像素比對"></a>
### Pixel comparison

The same fixed scenario, frames 1, 30, 120 and 300, the whole canvas read with `getImageData` from each version and compared (4 per setting, 12 in total):

- Visible difference (RGB after compositing the canvas over black and over white): at most **2/255** per channel; at most **0.109%** of pixels differ (Light frame 1, 1270 / 1166400).
- The raw (un-premultiplied) values differ by up to 17/255, only on nearly transparent pixels: `getImageData` returns un-premultiplied colour, so a premultiplied difference of 1 at alpha 17 is magnified to about 15.
- Every snapshot has between 280k and 540k lit pixels, and both versions draw the same region names and pulse counts.
- The threshold is in the script (visible difference ≤ 2/255 per channel, and ≤ 0.5% of pixels differing); the script exits non-zero when it is exceeded.

Also checked during development: (1) with particle glows moved to a second pass but strings and opacity unchanged, all 12 snapshots were identical (0 differing pixels); (2) A1 ungrouped and A2 grouped had exactly the same number of differing pixels; (3) the number of differing pixels was the same before and after A4. So the difference comes only from `globalAlpha` rounding, not from the change of order.

<a id="自動測試linux-雲端"></a>
## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/brain-performance.test.ts`, 3 new tests (Full / Balanced / Light) | No particle missing (`fillRect` count = frames × particles); `fillStyle` set fewer than a quarter as many times as particles (grouping is active); two gradients per frame (centre glow + the lit language region); the region name is drawn; both node glow and tinted pulse sprites go through `drawImage`; `globalAlpha` is back to 1 after drawing |
| All | `npm run typecheck` passes; `npx vitest run` 146 files, 2700 tests passed, 5 skipped; `npm run build` passes |

<a id="限制"></a>
## Limitations

- **Not measured on the Pi.** The container's x86 CPU is much faster than the Pi 4's Cortex-A72, and rasterization is a software GPU; only the relative change holds, and Pi milliseconds cannot be derived from it.
- Main-thread time excludes GPU rasterization; if the Pi is bound by the GPU or compositing, frames per second may not rise.
- Not compared by eye on a real screen; "no visible change" rests only on the 2/255 pixel comparison.
- Only one scenario (a live call with two lit regions); other states go through the same code paths but were not measured separately.

<a id="george-在-pi-上怎麼比較"></a>
## How George can compare on the Pi

1. On the Pi page open Settings → 「這台裝置的畫面效能」 (Display performance on this device), choose Balanced, wait one minute and note "Measured: N frames per second, M ms of main-thread drawing per frame". Ideally note it once during a realtime voice call (regions lit, most pulses).
2. After deploying this batch, note it again with the same setting and situation.
3. "Main-thread drawing per frame" should drop clearly; if frames per second do not rise with it, the bottleneck may be the GPU or compositing, so also note Chromium CPU in `top` and `vcgencmd measure_temp`.
4. Add the results to this document or the [Pi display performance record](pi-performance-2026-11-05.en.md).
