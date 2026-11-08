<!-- bilingual: source=zh-TW -->

> [繁體中文](wake-direction-2026-11-08.md) | [English](wake-direction-2026-11-08.en.md)

# Wake-word directionality: eMeet M0 Plus diagnostic tool and test procedure (2026-11-08)

George reported on 2026-11-08 that with the **eMeet M0 Plus** (a USB conference speakerphone with 4 microphones) as the input, the wake word works more often from one direction around the device. He asked for the cause, a test he can run at home, and a way to make every direction wake Nous.

As George asked, the work comes in two batches:

- **Batch 1 (this document)**: a direction diagnostic tool, a direction test procedure with forms, and a cause analysis. **No product code changed**: the wake microphone settings, mixing and thresholds are the same as before.
- **Batch 2**: after George's real measurements, a fix chosen from the results (the candidates in §8, each a setting that keeps today's behaviour by default).

The cloud has no such device. Every number here comes from synthetic test audio (fixtures) and headless Chromium's fake microphone. **None of it shows a real-device improvement**; the real numbers are George's to measure.

## 1. Summary

1. **The official specifications mention no beamforming, source localisation or mode switch.** eMeet's official page lists 4 omnidirectional MEMS microphones, 360° pickup and VoiceIA 4.2 noise and echo reduction. The user manual shows only five buttons (power, volume, call, mute, Bluetooth) and no setting such as a conference or personal mode (§2). eMeet does not state how many channels or what sample rate it sends to the computer; the diagnostic tool reads both on the Mac.
2. **Nous always feeds the wake engine one channel.** The microphone opens with Chromium's echo cancellation, noise suppression and automatic gain control on (`src/audio-devices.ts:24`) and no channel count. The capture AudioWorkletNode mixes to one channel by the "speakers" rule (`src/audio/capture.ts:58`). That rule averages 2 or 4 channels but **keeps only channel 1 for 3, 5, 7 or 8 channels** (§3).
3. **The code alone cannot settle the most likely cause.** The candidates are an asymmetric device pickup or DSP, Chromium processing stacked on the device's DSP, channel handling, too little threshold margin, and speaking direction plus room reflections (§4). Resampling is the same for every direction and is ruled out.
4. **The diagnostic tool** (`npm run wake:direction`, 127.0.0.1 only) uses the product's own engine and keywords. It shows the real channel count, sample rate, the actual values of the three processing options and per-channel levels, and it runs several detectors at once: the product mix at 4 thresholds plus one per channel. One trial therefore compares thresholds and channels together (§5).
5. **The direction test** covers 8 directions × 2 distances (1 m, 3 m) × 2 wake phrases × 5 tries per cell, 160 tries in all, plus TV and conversation negatives. §6 gives the formulas and how to read them; `tests/wake-direction.test.ts` checks the formulas.

## 2. eMeet M0 Plus specification check (2026-11-08)

| Item | Official information | Source |
|---|---|---|
| Microphones | "4 Omni-Directional Mic Array", Digital MEMS, frequency response 100 Hz–10 kHz | [eMeet official product page](https://emeet.com/products/speakerphone-m0-plus) (read 2026-11-08) |
| Pickup | "360° voice pickup", range "Up to 9.8ft" (about 3.0 m), marked "Tested in lab environment"; two daisy-chained units reach 24 ft | Same |
| Processing | "VoiceIA® 4.2 audio algorithm filters out background noise and eliminates echo"; the specs list "360° Voice Pickup, Full Duplex, Noise Cancellation, Voice Enhancement" | Same |
| Speaker | 3 W, 94 dB@0.01 m, 20 Hz–20 kHz | Same |
| Connection | USB-C, Bluetooth 5.0 (A2DP, AVRCP, HFP) | Same |
| Buttons and LEDs | Power, volume +/−, call, mute, Bluetooth; a status LED and a volume LED. The side view marks one "MIC hole" | [User manual PDF](https://cdn.shopify.com/s/files/1/0594/9472/7851/files/M0_Plus_User_Manual.pdf) (image-only PDF, pages 2–7 read 2026-11-08) |
| Software | eMeet Link (EMEETLINK): Bluetooth name, standby time, firmware updates; the manual says the device works normally without it | Official product page, user manual |

**What the official material does not mention**: beamforming, direction of arrival (DOA), talker tracking, automatic gain control (AGC), the microphone layout on the body, the USB audio channel count and sample rate, any switchable pickup mode (conference/personal, omni/directional) or a noise-reduction switch. Retailer pages contradict each other (pickup 10 m or 4.5 m; speaker 5 W); this document does not use them.

Therefore:

- A device mode cannot fix "one direction wakes more easily", because eMeet offers no modes.
- The computer receives what VoiceIA has already processed. Whether that is mono or multichannel, 48 kHz or 16 kHz, must be read on the Mac: section 3 of the diagnostic tool, or the eMeet input format in macOS Audio MIDI Setup.
- 3 m is exactly the stated pickup limit (9.8 ft ≈ 2.99 m), so the 3 m rate may be lower to begin with.

## 3. Code check: what reaches the wake engine

Checked against main `91c6f7f`:

| Step | Code | Behaviour |
|---|---|---|
| Open the microphone | `src/audio-devices.ts:24`, `openMic` | `MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }`; no `channelCount` or `sampleRate`. Realtime voice, always-on wake and voice enrolment share these constraints |
| Mix to one channel | `src/audio/capture.ts:58` | `AudioWorkletNode` with `channelCount: 1`, `channelCountMode: "explicit"`, `channelInterpretation: "speakers"`. Voice enrolment in `src/speaker/recorder.ts:54` is the same |
| Chunking | `src/audio/capture-worklet.ts` | Reads only `inputs[0][0]` (the mixed mono) and transfers about 100 ms per chunk to the worker |
| Sample rate | `src/audio/resample.ts` | AudioContext rate (usually 48 kHz on a Mac) → 16 kHz with a 31-tap windowed-sinc low-pass (cut-off 7.2 kHz) |
| Detection | `src/audio/detector.ts`, `shared/wake-runtime.json` | sherpa-onnx v2.0.1 KWS wasm, zh-en-3M; the three Hello Nous lines use the global boost 1.5 and threshold 0.15; the three Hey Nous lines use their own 1.0/0.25; `maxActivePaths` 4, `numTrailingBlanks` 1 |

**How the "speakers" rule mixes to one channel** (Web Audio API up-mixing and down-mixing):

| Actual channels | Product mix | Note |
|---|---|---|
| 1 | Used as is | — |
| 2, 4 | Average of all channels | A sound on only one channel ends up 6.02 dB (2 channels) or 12.04 dB (4 channels) quieter |
| 6 | 0.7071 × (L + R) + C + 0.5 × (SL + SR) | The 5.1 formula; LFE is dropped |
| 3, 5, 7, 8… | **Channel 1 only** | The specification defines only 1/2/4/6; others fall back to discrete, which drops channels 2 and up when mixing to mono |

If the eMeet delivered 3 or more channels other than 4 or 6, the product would hear only channel 1, which would directly cause a direction difference. `tests/wake-direction.test.ts` checks this with synthetic tones: a sound only on channel 3 of 4 is 12.04 dB quieter after the product mix, and with 3 channels the product hears nothing on channels 2 and 3.

**Chromium's processing changes the channel count.** With headless Chromium's fake microphone (Linux, a stereo device): with all three options on, the track's `channelCount` was 1 and Web Audio received 2 identical channels (mono copied twice, so averaging changes nothing); with all three off, `channelCount` was 2 and the two channels differed. With all three on and the voice only on the right channel, the processed mono still contained the right-channel voice (§9). CoreAudio on a Mac with the eMeet may differ; the diagnostic tool confirms it on the Mac.

## 4. Possible causes of the direction difference

| # | Candidate | Basis | How the diagnostic tool tells it apart | Fixable in code? |
|---|---|---|---|---|
| A | **The device itself is asymmetric**: microphone port placement, VoiceIA noise reduction or an internal beam, speaker position and echo cancellation | eMeet publishes neither layout nor algorithm; the manual's side view marks one MIC hole | Under the product condition, every detector (each channel, each threshold) is worse in the same direction, and the weak direction moves when the device is turned 90° → the device | Only indirectly (threshold, gain) |
| B | **Chromium processing on top of VoiceIA**: double noise suppression weakens distant, reverberant speech; two AGC stages may fight | The code always turns all three on (§3) | Compare the same direction under "product" and "all three off" | Yes (batch 2, F1) |
| C | **Channel handling**: only channel 1 is kept for 3/5/7/8 channels; or one microphone gets its own channel | The mixing rule in §3 | Section 3 shows the channels reaching Web Audio; with several channels, compare per-channel levels and per-channel detectors by direction | Yes (batch 2, F2, F3) |
| D | **Too little threshold margin**: weaker directions score just under the threshold | Hey Nous (0.25) is stricter than Hello Nous (0.15); the engine exposes no score | Thresholds +0.10, +0.05, 0 and −0.05 run in the same trial: if a weak direction hits at −0.05 but not 0 → a threshold issue; if −0.05 also misses → the sound itself is not good enough | Yes (batch 2, F4), at the cost of more false wakes |
| E | **Speaking direction, distance and room**: high frequencies of the voice are directional; 3 m is the stated pickup limit; reflections from a nearby wall | Physics; the 9.8 ft in §2 | Always face the device; the 90° turn check: the weak direction stays put when the device turns → the room or placement | Only by moving the device |
| F | Resampling | Every direction takes the same path | — | Not a direction cause; ruled out |

## 5. Diagnostic tool

A developer tool, not a product screen, on `127.0.0.1:5184` only. The code is in `prototype/ambient-shell/spike/wake/direction/`.

### 5.1 Starting it on the Mac

```bash
cd prototype/ambient-shell
npm ci
npm run wake:setup -- --product   # 已裝過可略過 / skip if already installed
npm run wake:direction
```

Open `http://127.0.0.1:5184/` in **Chrome**. The Nous App is Chromium, so Chrome's processing is the closest match. Before testing, pause always-on wake listening in the Nous menu bar so that a test does not start a real call.

### 5.2 Screen

| Section | Contents |
|---|---|
| 1. Condition | Microphone (choose the eMeet), three checkboxes `echoCancellation`/`noiseSuppression`/`autoGainControl`, channel request (none = product; or ask for max channels). All three on plus none is the product's current setting. Stop and start again after a change |
| 2. Detectors | Threshold offsets (+0.10, +0.05, 0 = product, −0.05; larger is harder to trigger); "one per channel with several channels" |
| 3. What actually arrives | Values the browser reports: the three options, the track's channel count and sample rate, capability ranges, the AudioContext rate, **the channels reaching Web Audio**, how the product would mix them to mono; per-channel RMS (dBFS) and peak; each detector's state and detection count |
| 4. Direction test | Choose a direction, distance and phrase, press "Say it once" (or Space): after a beep, say it once within 5 seconds; at the end each detector records a hit or a miss. After 5 tries the next cell is selected. "Negative" times a run and counts false wakes. Detections outside a window count as unprompted |
| 5. Results | Choose a condition and detector to see the table of 8 directions × 2 distances × 2 phrases, per-direction totals with the Wilson 95% interval, the direction spread, the worst direction and false wakes per hour. "Export" produces JSON and CSV with counts only; the JSON can be pasted back and imported |

**Detector plan**: based on the real channel count, one `product±threshold` for each selected offset; with several channels, `ch1`, `ch2`… at the product threshold; when the count is not 1/2/4/6, also `average` (all channels averaged). At most 10.

**No score from the engine**: sherpa-onnx KWS results carry the keyword, tokens and timestamps, not a score. The tool runs several thresholds at once instead; the strictest threshold that hit is that try's margin.

### 5.3 Privacy and limits

- Audio stays in memory: the AudioWorklet transfers samples straight to the detector workers, and the main thread receives only level numbers and detection events. Nothing is recorded, no blobs, no files, no browser storage. The only network use is same-origin reads of the listed files under `/wake-runtime/`, and the network closes once the engine loads (the product's `runtime-net.ts`). The static scan in `tests/wake-privacy.test.ts` covers this folder; `tests/wake-direction.test.ts` also checks the CSP and the file allowlist.
- Results are not saved automatically. **Reloading the page loses them.** Press "Export" after each part and paste the JSON into a note.
- CPU: each detector runs its own KWS. WK-00 measured about 6.7% of one core per KWS worker on the Mac, so 6 detectors are estimated at about 6 × 6.7% ≈ 40% of one core (an estimate, not measured on the Mac).
- This is a Chrome tab, not the Nous App. Both are Chromium, but the versions may differ.

## 6. Direction test procedure (at home)

### 6.1 Setup

1. Put the eMeet where it normally sits. **0° is the Type-C port side**; seen from above, go clockwise to 45°, 90°… 315°.
2. Mark 1 m and 3 m on each of the 8 directions with tape (measured from the device's centre).
3. Quiet room: TV off, Nous not speaking, Nous always-on wake paused.
4. Always **face the device** and speak at your normal volume; pick standing or sitting and keep it.

### 6.2 Conditions to run

| Code | Condition | Purpose |
|---|---|---|
| **P (required)** | All three on, channels not specified (`ec1-ns1-agc1-ch:default`) | The product today; find the weak direction first |
| **R (recommended)** | All three off, max channels (`ec0-ns0-agc0-ch:max`) | Whether Chromium processing causes the difference (cause B), and whether the eMeet delivers several channels (cause C) |
| N (if R is clearly better) | Only echoCancellation (`ec1-ns0-agc0-ch:default`) | Separates noise suppression/AGC from echo cancellation |

A full round per condition is 8 × 2 × 2 × 5 = **160 tries**, about 25–30 minutes. With less time, use the **short version**: 3 m and Hello Nous only, 8 × 5 = 40 tries.

### 6.3 Extras

- **90° turn check**: after condition P, turn the device 90° clockwise and redo only the best and the worst direction (3 m, Hello Nous, 5 each, 10 tries). The weak direction moves with the device → cause A; it stays → cause E.
- **Negatives**: for condition P, at least 30 minutes of TV (an English news channel is best) and 10 minutes of conversation; if condition R is a candidate, run the same negatives for R.

### 6.4 Forms

The tool calculates everything; for a paper record use this form (write "hits/5" in each cell):

| Direction | 1 m Hello | 1 m Hey | 3 m Hello | 3 m Hey | Direction total |
|---|---|---|---|---|---|
| 0° | /5 | /5 | /5 | /5 | /20 |
| 45° | /5 | /5 | /5 | /5 | /20 |
| 90° | /5 | /5 | /5 | /5 | /20 |
| 135° | /5 | /5 | /5 | /5 | /20 |
| 180° | /5 | /5 | /5 | /5 | /20 |
| 225° | /5 | /5 | /5 | /5 | /20 |
| 270° | /5 | /5 | /5 | /5 | /20 |
| 315° | /5 | /5 | /5 | /5 | /20 |

| Negative | Seconds | Product false wakes | False wakes per hour |
|---|---|---|---|
| TV | | | |
| Conversation | | | |

### 6.5 Formulas

- Cell rate = hits ÷ tries.
- Direction total = all distances and phrases for that direction added up, then divided (not the average of cell rates).
- Direction spread = highest minus lowest rate among directions with data (in percentage points).
- Wilson 95% interval: p = hits ÷ n, z = 1.96, centre = (p + z²/2n) ÷ (1 + z²/n), half-width = z·√(p(1−p)/n + z²/4n²) ÷ (1 + z²/n). Examples: 5/5 → 56.6–100%; 0/5 → 0–43.4%; 3/5 → 23.1–88.2%.
- False wakes per hour = false wakes ÷ (seconds ÷ 3600). Example: 2 in 30 minutes → 4 per hour.

`tests/wake-direction.test.ts` checks these formulas with the examples above.

### 6.6 How to read the results

- A cell has only 5 tries, so **a 1-try difference in one cell is noise** (the intervals overlap heavily). Look at direction totals (20 tries per direction) and the worst direction.
- A condition counts as better than P only if the worst direction's total gains at least 4 hits (out of 20, i.e. +20 points) and TV false wakes per hour do not rise.
- Thresholds: if the weak direction hits at `product-0.05` but not at `product+0.00` → consider a looser threshold (F4); if `product-0.05` also misses → the sound itself is poor; try F1/F5 first.
- Several channels: if one `chN` is clearly better in the weak direction → consider F3 (detect on each channel).

## 7. How other products handle wake words from every direction (reference)

A common design for multi-microphone wake words is to beamform first and run wake detection on every beam, or to pick the beams most likely to contain the wake word and detect only on those; detecting on every beam costs more compute. Patents include [US 11335331 Multibeam keyword detection](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11335331) (one detector per beam, then a combined decision), [US 11337173 Method and device for selecting from a plurality of beams](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11337173) and [US 9734822 Feedback based beamformed signal selection](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9734822) (wake-word confidence fed back into beam choice). (Searched 2026-11-08, for reference only; not read in full.) A conference speakerphone like the eMeet processes inside the device and gives the computer the result. If it delivers only mono, Nous can avoid double processing and adjust threshold or gain, but cannot beamform on its own.

## 8. Batch 2 candidate fixes and their costs

Each becomes a setting that keeps today's behaviour by default; turning it off restores the current behaviour. The choice follows George's numbers:

| Code | Change | When | Cost |
|---|---|---|---|
| F1 | Turn off the Chromium processing that duplicates the device's for always-on wake (all, or only noise suppression/AGC) | Condition R or N is clearly better | Realtime voice leases a clone of the same source, so calls also lose Chromium's echo cancellation and Nous's voice may come back into the call (relying on the eMeet's own echo cancellation). Opening wake and calls separately instead means one device with different constraints, which interact (docs/17 §10.3); needs real testing |
| F2 | Average all channels when there are several | The real count is 3, 5, 7, 8… | Almost no extra CPU; differs from today only for those counts |
| F3 | Run KWS on each channel; any hit wakes | One channel is clearly better in the weak direction | CPU roughly × channel count (about 6.7% of one core per KWS, WK-00); false wakes can approach × channel count, so negatives must be redone |
| F4 | An eMeet-specific threshold (for example Hey Nous 0.25 → 0.20) | The weak direction hits at a looser threshold | More false wakes; in WK-00 on the Mac, "Hey nurse" triggered Hey Nous at 0.15 |
| F5 | Wake-only gain or level normalisation before KWS | The weak direction is clearly quieter but R does not help | Noise is amplified too; little CPU |

## 9. Cloud verification (fixtures)

| Item | Result |
|---|---|
| `tests/wake-direction.test.ts` (17 tests) | Mixing rules with synthetic tones (only channel 3 of 4 → −12.04 dB; 3 channels → the product hears nothing on channels 2–3), threshold offsets, detector plan, chunking, statistics (Wilson, spread, false wakes per hour, 160 tries), export/import validation, the worklet sends only numbers to the page and each detector its own source, the page server serves only listed engine files, the CSP is same-origin only |
| `tests/wake-privacy.test.ts` | The static scan covers the new folder: no recording, no file writes, no network, no browser storage |
| Headless Chromium end to end | The real engine files installed by `npm run wake:setup -- --product`; the fake microphone played "Hello, nose." synthesized in memory by MeloTTS (the spike's `vits-melo-tts-zh_en`) and saved to a scratch folder outside the repo (a 3.0-second loop; of 20 synthesized clips only this one triggers offline with the product settings). About 30 seconds of listening per condition |

Detections per detector end to end (comparable within a condition; the listening time differs slightly between conditions, so these are not rates):

| Fake microphone content | Condition | Track channels → Web Audio channels | product +0.10/+0.05/0/−0.05 | ch1 | ch2 |
|---|---|---|---|---|---|
| Mono | All three on, none | 1 → 2 | 8/9/8/8 | 8 | 8 |
| Mono | All three off, none | 2 → 2 | 10/10/10/10 | 10 | 10 |
| Right channel only | All three off, max | 2 → 2 | 8/8/8/8 | **0** | 9 |
| Right channel only | All three on, none | 1 → 2 | 7/7/7/7 | 7 | 7 |

Reading: with the voice only on the right channel, the "channel 1 only" detector hit 0 times and channel 2 hit 9 times, so the per-channel detectors are truly separate. With the three options on, Chromium first processes the audio to mono and the right-channel voice survives. These are synthetic speech on a Linux fake device and say nothing about the eMeet.

## 10. Not verified

- **Neither the Mac nor the eMeet has been tested**: the eMeet's real channel count, sample rate, the effect of the processing options and the rate per direction all wait for George's measurements.
- The Chrome tab and the Nous App (Electron) may run different Chromium versions; batch 2 must confirm in the App before adopting anything.
- The Pi 4 also uses the EMEET for input ([Pi deployment](rpi-deployment-fixes-2026-11-05.en.md)); this tool has not been tried on the Pi.
- The CPU for 6 detectors at once is an estimate.
- Five tries per cell is coarse statistics; the rules in §6.6 exist so that noise is not mistaken for improvement.

## 11. Rollback

This batch only adds a developer page (`spike/wake/direction/`, `npm run wake:direction`), tests and documents; product code is unchanged, so there is nothing to roll back. To drop the tool, delete the folder and that one script line. Each batch 2 fix will be a setting that keeps today's behaviour by default; turning the setting off restores the current behaviour.
