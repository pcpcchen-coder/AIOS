<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-webgl-2026-11-07.md) | [English](brain-webgl-2026-11-07.en.md)

<a id="電子腦-webgl-繪製方案-b驗證"></a>
# Brain WebGL drawing (plan B) validation

Date: 2026-11-07. Branch `claude/brain-webgl` (based on main `7bce73c`). Status: **code, unit tests, relative measurement and visual comparison in headless Chromium (software WebGL) complete; not verified on the Raspberry Pi 4's hardware GPU.**

<a id="目的"></a>
## Purpose

[Plan A](brain-canvas-perf-2026-11-06.en.md) cut about 60% of the Canvas 2D main-thread time per frame, but rasterization (turning the commands into pixels) is still done by the browser. Plan B adds a second way of drawing: WebGL hands particles, connections, glows and rings to the GPU. It is a switch in the settings screen, **off by default on every device**; Canvas 2D drawing is unchanged and remains the default.

The brain-region requirement is unchanged: the six regions (language, math, art, auditory, visual, planning) light up, send pulses and show their names only from real events (task step `domain`, conversation topic classification, speech that is actually playing), the same in both renderers.

<a id="設計"></a>
## Design

<a id="狀態與繪製分開"></a>
### State separated from drawing

| File | Contents |
|---|---|
| `prototype/ambient-shell/src/brain.ts` | `Brain` keeps all state: events, `step()`, projection, hit testing, performance budget, `frameStats()`. `draw()` only computes this frame's data into a `BrainFrame` and hands it to the current renderer |
| `prototype/ambient-shell/src/brain-frame.ts` | The per-frame draw input `BrainFrame` (preallocated, overwritten every frame) and shared colours |
| `prototype/ambient-shell/src/brain-canvas.ts` | Canvas 2D drawing (the former `draw()` code, moved) and `drawRegionLabels`, shared by both renderers |
| `prototype/ambient-shell/src/brain-webgl.ts` | WebGL 1 drawing, context creation and failure detection |

`BrainFrame` holds: projected particle positions (`Float32Array`: x, y, depth); each particle's colour this frame (integer RGB), alpha and size (`Float64Array`); connections sorted into four depth groups with each group's colour and alpha; each region's activation and screen centre; pulse segment and head positions (`Float64Array`); the central glow and orbit parameters; colour, alpha, width and blur of each ring. Colours and region activation are computed once in `Brain`; both renderers read the same data.

The Canvas renderer is pixel-identical to main: `scripts/bench-brain.mjs --baseline origin/main` compares frames 1, 30, 120 and 300 for Full, Balanced and Light (12 images) with 0 differing pixels; against plan A's pinned baseline (`d28ce23`) it stays within the original threshold (at most 2/255 visible difference on 0.109% of pixels).

<a id="webgl-繪製"></a>
### WebGL drawing

- WebGL 1 (widest Pi support), with context attributes `premultipliedAlpha: true, antialias: false, failIfMajorPerformanceCaveat: true`, no depth or stencil.
- Particles, particle glows and pulse heads: point sprites. Particles are solid squares (below one device pixel their alpha is reduced by area); glows and pulse heads follow the Canvas glow gradient and tinted sprite in the fragment shader.
- Connections, region connections and pulse trails: `GL_LINES` with per-vertex colour and alpha. GL lines are always one device pixel wide, so alpha makes up the brightness of the Canvas line width (CSS pixels × device pixel ratio).
- Orbits: `GL_LINE_LOOP` (96-segment ellipses).
- Central glow, region glows, listening/call ring, connecting dashed ring, processing ripples and progress ring: shaders on quads (radial gradient; rings with dashes, round caps and the diagonal gradient; the listening ring's `shadowBlur` approximated by a Gaussian falloff).
- Compositing: central glow, orbits and rings use normal blending (`ONE, ONE_MINUS_SRC_ALPHA`); region glows, connections, particles and pulses are additive (`ONE, ONE`), matching Canvas `lighter`.
- Each frame's vertices are written into two `Float32Array`s (points and lines; capacity about 29 KB and 141 KB) allocated once after the brain is built, and `bufferSubData` uploads only the part used this frame (`subarray(0, used length)`, two small views per frame that do not copy data); no array or buffer is created per frame. In Full mode at frame 120 of the measurement scenario, the counts work out to uploads of about 23 KB and 86 KB.
- The vertex and fragment shaders share no uniforms: the fragment shaders only receive coordinates relative to the center. Vertex-shader uniforms default to highp, while fragment shaders are mediump on GPUs without fragment highp, and a uniform shared with different precisions makes the program fail to link.
- The connecting ring's dash offset is reduced in JavaScript to within one period (dash + gap) before it reaches the shader: the raw value grows without bound, and once passed as float32 it loses enough precision after days of uptime to make the dashes jump. The Canvas renderer still uses the raw value.
- The performance settings still apply: frame-rate cap, resolution cap (the GL canvas and the label overlay share the resolution), pulse cap, reduced glow (half the particle glows, smaller pulse heads), no blur on the listening ring.
- Region names: the WebGL canvas is inserted under the original `#brain` canvas, and `#brain` becomes a transparent 2D overlay where the same `drawRegionLabels` draws the names; it still receives clicks. When there are no names to draw this frame or last frame, the overlay is not cleared.

<a id="改回-canvas-的情況"></a>
### When it falls back to Canvas

With the switch on:

1. Creating the WebGL context fails (no hardware WebGL, or the browser reports a major performance caveat) → Canvas.
2. The context is software WebGL (renderer name contains SwiftShader, llvmpipe or softpipe) → treated as no hardware WebGL → Canvas.
3. Hardware WebGL exists, but a shader fails to compile, the program fails to link, or a buffer cannot be created → Canvas, and the “Current” line says WebGL failed to start rather than that there is no hardware WebGL.
4. `webglcontextlost` fires while running → Canvas.

After a fallback, Canvas is used for the rest of the page session (also after turning the switch off and on again); reloading the page tries again. This applies to any context loss, including transient GPU resets the browser could otherwise recover from: WebGL is not used again until the page is reopened. After `webglcontextlost` fires, the next frame is drawn with Canvas; before the event arrives, a frame or so may be blank. The reason is logged to the console (`[brain] WebGL 不可用，改用 Canvas：…`).

<a id="設定與狀態"></a>
### Setting and status

Settings → “Display performance on this device”:

- New switch “使用 GPU 繪製（WebGL）” / “Use GPU drawing (WebGL)”, independent of Full/Balanced/Light, off by default on every device, applied immediately without a reload.
- Stored under a separate key `nous.performance.gpu.v1` (value `on`/`off`), so the existing `nous.performance.v1` needs no migration; a missing key, an invalid value or unreadable storage all mean off.
- The “Current” line states honestly which renderer is really drawing:

| State | 繁體中文 | English |
|---|---|---|
| Using WebGL | 目前：WebGL | Current: WebGL |
| Switch off | 目前：一般繪製（Canvas） | Current: standard drawing (Canvas) |
| On, but no hardware WebGL (no context, or only software WebGL) | 此裝置沒有硬體 WebGL，已改用一般繪製 | This device has no hardware WebGL; using standard drawing instead |
| On, WebGL exists, but shader, link or buffer setup fails | WebGL 初始化失敗，已改用一般繪製 | WebGL failed to start; using standard drawing instead |
| WebGL stopped while running | WebGL 中斷，這次開啟期間改用一般繪製 | WebGL stopped working; using standard drawing until the page is reopened |

- Switch note: “Off by default. Works together with the setting above; if this device has no hardware WebGL, or WebGL stops working, drawing switches back to standard drawing automatically.”
- The “Measured” line measures the same span for both renderers: main-thread `step()` plus `draw()` (for WebGL including writing vertices, uploading, issuing GL commands and the label overlay), not the time until the GPU finishes; the line already says it excludes the GPU. Measurement restarts when the renderer changes.

<a id="在-pi-上怎麼開與怎麼確認"></a>
## Turning it on and checking it on the Pi

1. First confirm Chromium has hardware WebGL: on the Pi desktop open a normal Chromium window (not the kiosk), enter `chrome://gpu` in the address bar, and look for **WebGL: Hardware accelerated** under “Graphics Feature Status”. If it says *Software only* or *Unavailable*, turning the switch on will fall back to standard drawing.
2. On the Pi page open Settings → “Display performance on this device” and turn on “Use GPU drawing (WebGL)”.
3. Read the “Current” line: only “Current: WebGL” means the GPU is really being used; if it says “This device has no hardware WebGL; using standard drawing instead”, go back to step 1.
4. Compare: same setting (Balanced recommended), same situation (ideally during a realtime voice call, with regions lit and the most pulses), wait 1 minute each with the switch off and on, write down “Measured: N frames per second, M ms of main-thread drawing per frame”, and also note Chromium's CPU in `top` and `vcgencmd measure_temp`. Frames per second is the most direct signal: the main-thread milliseconds exclude the GPU.
5. If it feels slower or something looks wrong, turn the switch off; standard drawing returns immediately. Please add the result to this document or the [Pi display performance record](pi-performance-2026-11-05.en.md).

<a id="量測方法"></a>
## Measurement method

Script: `prototype/ambient-shell/scripts/bench-brain.mjs --webgl`. It bundles the working tree's `brain.ts` (with both renderers) with esbuild and, in one headless Chromium page (1920×1080, device pixel ratio 1, cross-origin isolated so `performance.now()` resolves to 5 µs), runs the same `Brain` with Canvas and with WebGL through plan A's fixed scenario: realtime voice connected, listening, speaking, processing, progress 0.4, language region (speech playback) and planning region (topic classification) lit; `Math.random` uses a fixed seed, `step`, `stream` and `stepDone` pulses are sent every 15 frames, and a processing ripple every 90 frames.

- “step + draw”: fixed `dt = 1 / maxFps` per frame, one `step()` plus `draw()` inside `requestAnimationFrame`, the same span as `frameStats()`.
- “step + draw + wait for GPU”: after each measured frame, also wait for the frame to be drawn: for WebGL `gl.readPixels` of 1 pixel plus `getImageData(0, 0, 1, 1)` on the 2D canvas (the label overlay in WebGL mode); for Canvas only the latter.
- Each setting runs 60 warm-up frames and then 300 measured frames; each run goes through the three settings, alternating Canvas and WebGL order every run. 5 runs; the report gives the median of the 5 per-run medians and the range of the 5, and the same for p95.
- Checking that the work happened: every run checks that the active renderer is the one being measured; WebGL's per-frame counts are 775 particles, 2764 connection vertices (1382 connections), region connections, the same number of pulses as Canvas, and 3 rings.
- Software WebGL: the container has no GPU, and Chromium's WebGL is SwiftShader (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`). The real page refuses it (`failIfMajorPerformanceCaveat` and the renderer-name check); the script relaxes this with the measurement-only `allowSoftware`.

```
cd prototype/ambient-shell
node scripts/bench-brain.mjs --webgl --runs 5
node scripts/bench-brain.mjs --skip-bench --baseline origin/main
```

The second line is the Canvas pixel check (against main). Requirements are the same as plan A: a loadable Playwright and Chromium (pre-installed in this container; `package.json` does not depend on it); not run in CI or `npm test`. `--shots <folder>` saves the screenshots of the visual comparison below to that folder (not to the repository).

Environment: x86 cloud container, 4 cores, load average 0.02 at the start; Chromium 153.0.8010.12 headless; Node v22.23.4. **Software GL, a relative comparison inside a container, not Pi numbers.**

<a id="結果"></a>
## Results

<a id="每格-stepdraw主執行緒毫秒5-次執行的中位數括號內是-5-次的範圍"></a>
### step + draw per frame (main thread, ms; median of 5 runs, range of the 5 in brackets)

| Setting | Canvas median | WebGL median | Change | Canvas p95 | WebGL p95 |
|---|---|---|---|---|---|
| Full | 0.570 (0.515–0.620) | 0.350 (0.325–0.370) | −38.6% | 0.790 (0.650–0.895) | 0.520 (0.450–0.620) |
| Balanced | 0.540 (0.505–0.570) | 0.340 (0.340–0.345) | −37.0% | 0.780 (0.680–0.855) | 0.510 (0.455–0.535) |
| Light | 0.500 (0.470–0.555) | 0.345 (0.305–0.350) | −31.0% | 0.705 (0.665–0.775) | 0.510 (0.475–0.585) |

The median ranges do not overlap. On the main thread WebGL saves Canvas's path commands and the per-group `fillStyle`/`globalAlpha` settings; `step()` and preparing the `BrainFrame` are the same on both sides, so most of the remaining ~0.34 ms is the shared part plus writing the vertex arrays.

<a id="含等-gpu-畫完stepdraw等-gpu毫秒"></a>
### Including waiting for the GPU (step + draw + wait for GPU, ms)

| Setting | Canvas median | WebGL median | Change | Canvas p95 | WebGL p95 |
|---|---|---|---|---|---|
| Full | 9.665 (9.340–10.120) | 27.280 (26.250–27.865) | +182.3% | 13.740 (12.320–15.175) | 32.810 (31.775–34.705) |
| Balanced | 7.450 (7.405–7.880) | 24.765 (24.225–25.520) | +232.4% | 8.305 (8.105–11.545) | 30.195 (29.825–34.000) |
| Light | 4.980 (4.795–6.905) | 15.435 (15.020–16.555) | +209.9% | 8.095 (6.965–8.335) | 19.615 (18.790–20.860) |

In this container WebGL runs the shaders per pixel on the CPU through SwiftShader and is about 3 times slower than Chromium's Canvas rasterization. Which part costs most was not profiled; the central glow and rings are quad shaders covering hundreds of thousands of pixels and are the most likely source (unverified). Software WebGL being slower than Canvas is exactly why the real page refuses it. **This table cannot be used to predict the Pi's hardware GPU**; the Pi answer can only come from measuring as in “Turning it on and checking it on the Pi”.

<a id="畫面比對第-120-格同一個固定情境"></a>
### Visual comparison (frame 120, same fixed scenario)

Each renderer's output (for WebGL, the GL canvas plus the label overlay) is composited over black, and the whole 1920×1080 image is split into a 16×9 grid of mean luminance:

| Setting | Grid luminance correlation | Grid mean absolute difference | Mean luminance Canvas / WebGL | Lit share Canvas / WebGL | Language region luminance Canvas / WebGL | Planning region luminance Canvas / WebGL |
|---|---|---|---|---|---|---|
| Full | 0.997 | 0.0018 | 0.0252 / 0.0268 | 14.9% / 15.3% | 0.307 / 0.302 | 0.372 / 0.367 |
| Balanced | 1.000 | 0.0002 | 0.0233 / 0.0231 | 13.1% / 13.1% | 0.322 / 0.318 | 0.363 / 0.358 |
| Light | 1.000 | 0.0002 | 0.0239 / 0.0238 | 13.7% / 13.7% | 0.399 / 0.394 | 0.381 / 0.375 |

- Luminance is relative luminance from 0 to 1 (0.2126 R + 0.7152 G + 0.0722 B); lit pixels have luminance above 8/255; region luminance is the mean within 0.3 R of the region's screen centre.
- Both renderers draw the same region names (“語言區 · 語音播放”, “規劃區 · 主題分類”) and the same number of pulses (Full 34, Balanced 20, Light 8), and WebGL draws every one of them.
- Looking at the screenshots: brain shape, connections, particle colours, lit regions, pulses, the progress ring and label positions match. Visible differences: WebGL lines are not antialiased (sharper), and in Full the listening-ring blur is slightly wider (most of the 0.997 correlation and the +6% luminance come from this).
- The script's pass conditions: identical non-empty region names, identical pulse counts with all of them drawn by WebGL, and grid correlation above 0.9.

<a id="自動測試linux-雲端"></a>
## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/brain-webgl.test.ts` (new, 24 tests, a fake WebGL context that records calls) | Asks for WebGL 1, `premultipliedAlpha`, no antialiasing, refusing a major performance caveat; the GL canvas goes under the original canvas; every frame draws 775 particles, every connection, both orbits and the pulses with additive blending; only the used length is uploaded, within the preallocated sizes, only 3 allocations, the same two arrays reused every frame; uniforms shared by both stages of the four GL programs have the same precision (parsed from the shader sources); the dash offset stays within one period after a month of uptime; Full/Balanced/Light frame-rate, resolution and pulse caps; Light has fewer particle glows, Balanced and Light send no ring blur; labels are drawn on the overlay and stop when the region dims; creation failure, an exception and a software renderer fall back to Canvas reporting no hardware WebGL, shader compile, link and buffer failures fall back to Canvas reporting a startup failure, all keep drawing and say why, with no retry during the session; context loss falls back to Canvas without calling `loseContext`; switching off removes the GL canvas and releases the context; WebGL is not touched by default |
| `tests/performance.test.ts` (5 new) | The switch is off by default, stored per device and separate from the three settings; the old `nous.performance.v1` needs no migration; invalid values and broken storage mean off; the five “Current” texts; the imports of `src/brain-webgl.ts` do not reach listening, playback, realtime voice and similar modules |
| `tests/performance-settings-view.test.ts` (14 new) | The switch is drawn in the browser and App versions, in Chinese and English, with `aria-pressed` and `aria-label`; the “Current” text for the five states; clicking asks for the opposite state; `refreshPerformanceReadout` updates the “Current” line; every new string has an English translation |
| Existing brain tests | `brain-performance`, `brain-regions`, `brain-distance` pass unchanged (Canvas path) |
| All | `npm run typecheck` passes; `npx vitest run` 159 files, 2932 passed, 5 skipped; `npm run build` passes |

<a id="限制"></a>
## Limitations

- **Never run on the Pi's hardware GPU.** Whether the Pi 4's VideoCore VI gives Chromium hardware WebGL, whether its fill rate is enough, and the real frame rate are all unknown.
- The measured WebGL is SwiftShader (software GL on the CPU), and the script deliberately relaxes `failIfMajorPerformanceCaveat`; the real page refuses software WebGL. These numbers only compare relative main-thread cost and cannot be used to infer milliseconds or GPU cost on the Pi.
- Not pixel-identical to Canvas: GL lines are not antialiased and are always one device pixel wide (alpha compensates brightness); the listening-ring blur is an approximation; particle squares snap to pixels; region labels are drawn on the 2D overlay on top, so in WebGL mode the labels are drawn above the listening and progress rings (in Canvas the rings are drawn over the labels). The comparison uses only coarse measures (luminance grid, lit share, region luminance) plus looking at screenshots.
- The used vertex data (about 109 KB in the measurement scenario, at most about 170 KB) is uploaded every frame; the effect on GPU memory bandwidth was not measured.
- `webglcontextlost` was not triggered in a real browser; only unit tests fire the event on a fake context.
