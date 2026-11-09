<!-- bilingual: source=zh-TW -->

> [繁體中文](22_LG_G3_webOS_Port_Assessment_2026-11.md) | [English](22_LG_G3_webOS_Port_Assessment_2026-11.en.md)

# 22 Running Nous on the LG G3 TV (webOS): feasibility assessment (under assessment, not implemented)

Date: 2026-11-09 (Asia/Taipei). Status: **assessment only; no product code changed**. This change adds only this document and a read-only capability check page, [`terminals/webos/capability-check.html`](../terminals/webos/capability-check.html).

On 2026-11-09 George asked whether Nous can run on the living-room LG OLED G3 (actual set: OLED65G3PSA). The TV's most natural role matches the [Raspberry Pi terminal](../terminals/rpi4/README.en.md): "another terminal". The agent, realtime voice back end, and data stay in the Mac core. The TV handles picture and sound, and ideally microphone and camera too.

This document grades information in three levels: **official** (LG documentation or LG product pages), **community** (forums and third-party sites, including LG staff replies on the forum), and **inference** (derived from the other two, without a direct document). Anything not found, or anything that needs the real set to confirm, is written as "unknown / to be tested" and is never treated as feasible. All external sources were checked on 2026-11-09.

<a id="summary"></a>
## 1. Summary

1. **The TV is feasible as a "display + speaker". No feasible route is visible for using it as a "microphone + camera" terminal.** The official webOS Luna APIs include no audio capture API. The camera API only reports device information, and it has been marked deprecated since webOS TV 4.0. An LG staff member replied on the developer forum that "WebRTC is only available on contracted partner apps" (community source, LG reply). Nous realtime voice, wake word, look-to-talk, and family recognition all need a microphone or camera, so on the TV they are all listed as **not feasible (to be confirmed by testing)**.
2. **The cheapest route is the hybrid: a Pi (or the Mac) sends the picture to the TV over HDMI, and microphone and camera stay on the eMeet / Pi.** This route needs no new code. Every capability of the current Pi terminal is kept; the TV is just a big screen and speaker. LGTV-1 can already switch the TV input from the Mac.
3. **Installing on the TV itself (.ipk) is only worth doing as a "display-only terminal"**, and first the question "how does the TV reach a Mac core that listens only on `127.0.0.1`" must be solved. The Pi uses an SSH tunnel so the connection becomes `http://localhost`. The TV cannot run an SSH client (no root). Either we build an authenticated LAN entry point (George must decide, see section 13), or we try forwarding on the TV itself with a webOS JS service (unknown / to be tested).
4. **Do G-0 first: open the capability check page in the TV browser.** It confirms the real Chromium version (the G3 may already have moved to webOS 24 or 25 through LG Re:New) and the actual state of each API before deciding whether to go further.

<a id="current-architecture"></a>
## 2. Current architecture and the capabilities to move

| Layer | Today (`prototype/ambient-shell`) | What the TV must take on |
|---|---|---|
| Core | Node HTTP + SSE on the Mac, listening only on `127.0.0.1`; `server/http-guard.ts` accepts only `localhost:<port>` / `127.0.0.1:<port>` | Not moved; the TV is a terminal |
| Page | Framework-free TypeScript / Vite; events over `EventSource`; Canvas (optionally WebGL) brain | Must run on the TV's Chromium |
| Mac App | Electron shell, native menus, IPC for encrypted artifacts and memory | The TV will not have these; features match the Pi terminal (no encrypted artifacts or memory management) |
| Pi terminal | Chromium kiosk opens `http://localhost:<port>`, forwarded to the Mac by autossh; `localhost` is a secure context, so microphone and camera work | The TV has no ready equivalent |

Browser capabilities the Nous page depends on (confirmed from the code):

| Feature | Depends on | Code location |
|---|---|---|
| Realtime voice | `RTCPeerConnection`, `getUserMedia` (microphone) | `src/realtime.ts`, `src/live-voice.ts` |
| Wake word | `AudioWorklet`, worker, sherpa-onnx v2.0.1 wasm (CSP needs `wasm-unsafe-eval`) | `src/audio/` |
| Camera, look-to-talk, family recognition | `getUserMedia` (video), `@mediapipe/tasks-vision` 1.1.1, `onnxruntime-web` 1.30.0 (wasm, `numThreads = 1`) | `src/sense/`, `src/speaker/` |
| Speaker choice | `HTMLMediaElement.setSinkId`; `AudioContext.setSinkId` (Chromium 110+), falling back to the system default when missing | `src/audio-devices.ts`, `src/audio/earcon.ts` |
| Memories mode | `<video>` plays photos and videos (the Mac converts HEIC to JPEG; video formats follow the source file) | `server/memories-*.ts` |
| Clock corner, home status | Plain DOM + read-only APIs | `GET /api/weather/now`, `GET /api/home/overview` |
| Processing sound | Web Audio synthesis, subject to autoplay policy | `src/audio/earcon.ts` |
| Terminal connection and pairing | SSH tunnel (RPI-1); RPI-2 trusted pairing is still a [draft](../terminals/rpi4/README.en.md#rpi-2-draft) | `terminals/rpi4/` |

<a id="official-facts"></a>
## 3. Facts found (2026-11-09)

| Topic | Content | Level and source |
|---|---|---|
| webOS 23 web engine | Web apps run **Chromium 94** (UA contains `Chrome/94.0.4606.128 … WebAppManager`); webOS 24 is Chromium 108, 25 is 120, 26 is 132 | Official: [Web API and Web Engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine) |
| Built-in browser engine | Official page lists only webOS 1.x / 2.x; **the webOS 23 browser app version was not found** | Official (same page); unknown |
| Whether the G3 has been upgraded | LG Re:New lets OLEDs from 2023 onward move to webOS 25; press reports say the G3 received webOS 24 (firmware 23.20.50) and webOS 25 | Official: [LG Italia webOS 25](https://www.lg.com/it/magazine/aggiornamento-a-webOS-25/); community: press reports. **Check the real set's UA** |
| Whether the engine changes after upgrade | Not found | Unknown |
| Web API support table | Official note: support tables are "not provided" from webOS TV 4.0; refer to MDN, but the platform may differ | Official (same page). WebRTC, getUserMedia, AudioWorklet, wasm SIMD / threads, SharedArrayBuffer, setSinkId, Service Worker, Web Speech, WebGL2, and Fullscreen have **no official per-item statement** |
| WebRTC | LG staff reply: "WebRTC is only available on contracted partner apps"; another LG reply on 2023-03-16: "The WebRTC specification is currently not open"; users report getUserMedia in the browser works only on google.com and webrtc.github.io (webOS 6.x) | Community (LG forum replies): [#27587](https://forum.webostv.developer.lge.com/t/webrtc-getusermedia-webos-24/27587), [#2306](https://forum.webostv.developer.lge.com/t/webrtc-support-in-webos-tv/2306) |
| Camera API | `luna://com.webos.service.camera` has only getList / getInfo / isCovered, no capture method; deprecated since webOS TV 4.0 | Official: [Camera](https://webostv.developer.lge.com/develop/references/camera) |
| LG Smart Cam VC23GA | Supports webOS 23 / 22, the compatibility list includes OLED G3, built-in dual microphones; **which apps can use it is not listed** | Official: [LG AU VC23GA](https://www.lg.com/au/tv-accessories/ebx64338002) |
| Luna API list | Activity Manager, App Manager, Audio (volume only), BLE GATT, Camera (deprecated), Connection Manager, DB, Device Unique ID, DRM, Keymanager3, Media DB, Magic Remote, Settings, System, TV Device Info; **no audio capture or voice API** | Official: [Luna Service Introduction](https://webostv.developer.lge.com/develop/references/luna-service-introduction) |
| App lifecycle | A hidden app is suspended; whether JS keeps running is not stated; apps may not have their own close button; `handlesRelaunch` lets the app handle relaunch in the background | Official: [App Lifecycle](https://webostv.developer.lge.com/develop/guides/app-lifecycle-management), [appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json) |
| JS service | Runs even when the app is not open; webOS 23 uses **Node v12.22.2**; pure-JS modules only; `webos-service` exits after **5 seconds** idle by default, adjustable through `idleTimeout`, and staying resident requires holding an ActivityManager activity; maximum lifetime not stated | Official: [JS Service Basics](https://webostv.developer.lge.com/develop/guides/js-service-basics), [JS Service FAQ](https://webostv.developer.lge.com/develop/guides/js-service-faq) |
| Developer Mode | Time-limited (official page gives no hours); EXTEND works while online, and an expired session cannot be extended; needs an LG developer account and a PC on the same network; community says the current limit is 1000 hours (older posts say 50), and apps installed through Developer Mode are removed on expiry | Official: [Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app); community: [webOS Brew devmode](https://www.webosbrew.org/devmode/) |
| CLI | `npm install -g @webos-tools/cli`; the official page recommends Node 14.15.1–16.20.2, but the latest npm release 3.2.6 (2026-09-08) requires Node ≥ 20; they conflict, so go by the actual install; `ares-setup-device`, `ares-package`, `ares-install`, `ares-launch`, `ares-inspect` | Official: [CLI Installation](https://webostv.developer.lge.com/develop/tools/cli-installation), [CLI Dev Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide); [npm registry](https://registry.npmjs.org/@webos-tools/cli) |
| LG Content Store listing | Individual or corporate sellers; every app goes through LG QA (pretest, function, content); submit an IPK, UX scenario, and self-checklist; updates need re-approval; fees, timelines, and personal-use policy not found | Official: [App Ecosystem](https://webostv.developer.lge.com/distribute/app-ecosystem), [App Approval Process](https://webostv.developer.lge.com/distribute/app-approval-process) |
| Opening the browser with a URL | SSAP `system.launcher/open` with `{target: "https://..."}`; or `launch` `com.webos.app.browser` with `target` | Community: [Home Assistant webostv.command](https://www.home-assistant.io/actions/webostv.command/), [LG forum #8739](https://forum.webostv.developer.lge.com/t/how-to-open-a-web-link-in-lg-webos-browser-without-relaunching-the-existing-app/8739); LGTVG3's `lgtv url` does the same |
| Launching an app at power-on | No official API; community says only homebrew can | Community: [LG forum #3759](https://forum.webostv.developer.lge.com/t/how-to-make-an-app-run-automatically-on-first-boot/3759), [Homebrew Channel #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124) |
| G3 hardware | α9 AI Processor 4K Gen6, Bluetooth 5.0, USB 2.0 × 3, HDMI × 4 (4K120 / eARC), Wi‑Fi 6, hands-free voice "Yes", "USB Camera Compatible: Yes", AirPlay 2 "Yes"; **RAM and storage not listed officially** (community listings say 3 GB / 8 GB, unverified) | Official: [LG MY OLED65G3PSA](https://www.lg.com/my/tvs/lg-oled65g3psa) |
| Built-in microphone | "Hey, LG" uses a microphone built into the TV itself, off by default, 7 sensitivity levels, the list includes 2023 OLED G3; **whether third-party apps can use it: not found, and the Luna list has nothing for it** | Official: [LG Italia Hey LG](https://www.lg.com/it/supporto/supporto-prodotto/risoluzione-anomalie/help-library/cs-CT20154005-20152636672944/) |
| Google Cast | Not listed on the G3 spec page; LG says it arrives with the Re:New webOS 25 upgrade; press says from webOS 24 | Official (webOS 25 article); community (press) |
| TLS root certificates | Fixed per version and not modifiable; an untrusted root gives `ERR_INSECURE_RESPONSE` | Official: [TLS](https://webostv.developer.lge.com/develop/specifications/tls). Inference: a self-signed LAN certificate will not be trusted by the TV |
| Hosted web app | A small local package redirects to a remote server by meta refresh or JS; examples use `http://`; no HTTPS or secure-context rule stated | Official: [Web App Types](https://webostv.developer.lge.com/develop/getting-started/web-app-types) |
| Root / Homebrew | faultmanager (webOS 4.0 and up), DejaVuln (3.5 and up, patches rolling out); crashd patched 2024-04; faultmanager-autoroot says as of 2025-08-24 the latest firmware for nearly all webOS 5, 6, 7, and 9 models is patched, and webOS 23 may need several tries; both say not to update firmware; warranty effect not stated | Community: [webOS Brew rooting](https://www.webosbrew.org/rooting/), [faultmanager-autoroot](https://github.com/throwaway96/faultmanager-autoroot), [cani.rootmy.tv](https://cani.rootmy.tv/) |

<a id="options"></a>
## 4. The options

<a id="option-a"></a>
### Option A: webOS web app (.ipk installed on the TV)

Package the Nous page as a packaged or hosted web app and install it through Developer Mode. It runs on webOS 23's Chromium 94 (possibly 108 or 120 after an upgrade).

- **Picture**: the brain Canvas, clock, home status, and artifact screens use features Chromium 94 already has (inference); WebGL rendering needs testing.
- **Reaching the core**: a packaged app's origin is `file://`, and a hosted app redirects to a remote URL. Either way the Mac core listens only on `127.0.0.1`, and `http-guard.ts` accepts only `localhost`, so the TV cannot get in. Either add an authenticated LAN entry point (decision D2 in section 13) or forward on the TV itself with option C's JS service.
- **Microphone, camera, WebRTC**: based on the LG reply and the Luna list, not feasible (to be confirmed by testing).
- **Residency**: the app is suspended when switched away and does not open by itself at power-on. The Mac can launch it over SSAP when the TV turns on (LGTV-1 already has `launch_app`; inferred feasible, to be tested).
- **Deployment**: Developer Mode is time-limited and needs periodic EXTEND; on expiry the app is removed and must be reinstalled. Listing on the Content Store requires LG QA, and whether a personal home app can be listed was not found; this route is not recommended.

<a id="option-b"></a>
### Option B: open the Nous page in the TV's built-in browser

Open a URL like the Pi does, but the TV cannot run the SSH tunnel.

- **Secure context**: `http://<Mac LAN IP>` is not a secure context, so `getUserMedia` can never work (browser specification). `https://` needs a public certificate the TV trusts: the TV's root store cannot be changed, so self-signed certificates fail. A possible approach is an own domain + a public CA (for example DNS validation) pointing to the LAN IP (inference, untested). Even over HTTPS, community reports say the browser's getUserMedia is open only to Google sites (reported on webOS 6.x; webOS 23 unknown).
- **Entry point**: same as option A; the core does not accept LAN connections today.
- **Fullscreen**: not stated officially, unknown; the browser has an address bar and its own key handling.
- **Opening at power-on**: no official way; the Mac can open the URL over SSAP `system.launcher/open` (community approach; LGTVG3 has `lgtv url`), to be tested.
- **Advantage**: no installation at all, which suits the G-0 capability check best.

<a id="option-c"></a>
### Option C: native / JS service (webOS service, Luna API)

- **Residency**: it can run in the background, but `webos-service` exits after 5 seconds idle by default; staying resident requires holding an ActivityManager activity, and the maximum lifetime is not stated officially (to be tested).
- **Microphone**: the Luna list has no audio capture API; neither the remote's microphone nor the built-in "Hey, LG" microphone has documentation opening it to third parties. External USB microphone: not on the spec page, unknown.
- **Camera**: the Luna camera API only queries information and is deprecated; VC23GA lists no usable apps; "USB Camera Compatible: Yes" does not say which apps can use it. External USB camera for third-party apps: unknown, inferred not feasible.
- **Native (C/C++)**: ordinary developers' JS services cannot use native modules; native apps go through the LG partner channel (inference; no public document found).
- **Where it might help**: a Node 12 JS service might open a `127.0.0.1` forwarder on the TV, so the web app opens `http://localhost:<port>` and, like the Pi's SSH tunnel, the core does not need loosening (for example, a pure-JS SSH client connecting to the Mac's Remote Login). Whether it can stay resident, whether it can open a local port, and how it performs are all **unknown / to be tested**.

<a id="option-d"></a>
### Option D: hybrid, the TV as display + speaker only

- **D1: Pi to the TV over HDMI.** The Pi 4 runs the current kit, with HDMI moved from the small screen to the TV; the eMeet (or the Pi's USB microphone / camera) keeps listening and watching. Sound can go to the TV speakers (HDMI) or the eMeet speaker, chosen in the "audio output" setting. LGTV-1's `app.tv.input` can switch the TV to the Pi's HDMI on wake (whether to do this automatically is a pending decision). **Existing code can do this; it only needs testing.**
- **D2: the Mac sends the Nous window to the TV over HDMI or AirPlay 2.** The G3 spec page lists AirPlay 2 support (official). The Mac's Nous window is mirrored or extended to the TV, and the eMeet on the Mac still listens. AirPlay latency and frame rate are unknown; the picture drops as soon as the Mac leaves or sleeps.
- **D3: Google Cast.** Only possible after the TV moves to webOS 24 / 25, and Nous has no Cast receiver; not recommended.
- **Echo**: the TV speakers are farther from the eMeet; whether the eMeet's and Chromium's echo cancellation can remove the TV's sound needs testing.

<a id="option-e"></a>
### Option E: community root / Homebrew Channel (reference only)

After rooting you can install the Homebrew Channel, autostart at power-on, avoid the Developer Mode time limit, and perhaps reach ALSA or USB devices (unknown). However:

- **Risks**: you must stay on unpatched firmware and cannot update (no security fixes either); a mistake can brick the TV; LG updates usually patch the exploits, so root may stop working.
- **Warranty**: the webOS Brew page does not mention warranty; in general modification may affect warranty, so confirm with LG yourself (inference).
- **Privacy red line**: rooted software has broad privileges, which makes it even more important that raw images and un-woken audio are never written to disk or sent out.
- **Recommendation**: not a primary route; this document gives no procedure.

<a id="capability-matrix"></a>
## 5. Capability matrix

Legend: ✅ feasible, 🟡 partial, ❌ not feasible, ❔ unknown / to be tested. Brackets give the basis; "inference" means no direct document.

| Feature | A: .ipk web app | B: TV browser | C: JS service / Luna | D: hybrid (Pi HDMI / Mac AirPlay) | E: root |
|---|---|---|---|---|---|
| Brain screen + SSE | 🟡 (Chromium 94 has Canvas and EventSource, inference; reaching the core must be solved first) | 🟡 (same as A; address bar and key handling unknown) | ❌ (no screen) | ✅ (D1 existing Pi code; D2 mirroring, latency unknown) | ❔ |
| Reaching the Mac core | ❌ today (core accepts only localhost; needs the new entry point decided in D2 or C's forwarder) | ❌ today (same as A, and http is not a secure context) | ❔ (local forwarder to be tested) | ✅ (Pi SSH tunnel) | ❔ |
| Realtime voice (WebRTC + microphone) | ❌ (LG reply: WebRTC is partner-only; to be confirmed by testing) | ❌ (community: getUserMedia only on Google sites; webOS 23 unknown) | ❌ (no audio capture API) | ✅ (capture on Pi / Mac) | ❔ |
| Microphone source | ❌ (same as above) | ❌ | ❌ (remote and built-in microphones not opened) | ✅ (eMeet, Pi USB microphone) | ❔ |
| Wake word (AudioWorklet + wasm) | ❌ (no microphone; AudioWorklet and wasm themselves exist in Chromium 94, inference) | ❌ | ❌ | ✅ | ❔ |
| Camera, MediaPipe, family recognition | ❌ (camera API deprecated, no capture) | ❌ | ❌ | ✅ (Pi or Mac camera) | ❔ |
| Speaker choice `setSinkId` | ❔ (`HTMLMediaElement.setSinkId` should exist in Chromium 94; whether the TV lists output devices is unknown; `AudioContext.setSinkId` needs Chromium 110, and the code falls back to the default) | ❔ | — | ✅ (Pi can choose HDMI = TV speakers, or the eMeet) | ❔ |
| Memories-mode video | 🟡 (H.264 should play, HEVC / MOV to be tested; needs to reach the core) | 🟡 (same as A) | — | ✅ | ❔ |
| Clock corner | 🟡 (DOM only; needs to reach the core) | 🟡 | — | ✅ | ❔ |
| Processing sound | ❔ (Web Audio exists; TV autoplay policy unknown) | ❔ | — | ✅ | ❔ |
| Terminal pairing (RPI-2 draft) | ❔ (RPI-2 not implemented; credential could live in the app's local storage, inference) | ❔ | — | 🟡 (D1 uses the RPI-1 SSH key; RPI-2 not implemented) | ❔ |
| Fullscreen | ✅ (web apps are fullscreen by nature, official app type) | ❔ | — | ✅ | ✅ |
| Open at power-on | 🟡 (no official API; the Mac can launch it over SSAP, to be tested) | 🟡 (same as A, using `system.launcher/open`) | ❔ (whether a service runs at boot is unknown) | ✅ (Pi already autostarts; TV input switching is a pending decision) | ✅ (community; risks in option E) |
| Background residency | ❌ (suspended when hidden) | ❌ | 🟡 (must hold an activity; lifetime unknown) | ✅ (Pi) | ✅ (community) |
| Developer Mode expiry impact | Removed; needs periodic extension | None | Removed | None | None (but firmware cannot be updated) |

<a id="performance"></a>
## 6. Performance and hardware limits

- **SoC**: α9 AI Processor 4K Gen6 (official). CPU core count, clock, and GPU model are not stated officially; the capability page reports `hardwareConcurrency` and the WebGL renderer.
- **Memory**: not listed officially; community listings say 3 GB RAM / 8 GB storage (unverified). Most TV memory goes to video and the system; the ceiling available to a web app is unknown.
- **Web engine**: Chromium 94 is much older than the Pi's Chromium (the version shipped with Raspberry Pi OS). The Vite build target must be confirmed to run on 94 (for example top-level await and newer CSS). If the TV was upgraded, it may be 108 or 120.
- **wasm and MediaPipe**: wasm and SIMD are on by default from Chromium 91 (inference; the capability page verifies it); SharedArrayBuffer needs cross-origin isolation, and Nous uses no multithreading today either (`numThreads = 1`). But without camera and microphone, MediaPipe and the wake word have no use on the TV, so their performance need not be assessed for now.
- **Brain rendering**: the Pi 4 needs "balanced" mode; the Canvas load on the TV's CPU / GPU is unknown, so measure frame rate in G-1.
- **JS service**: Node 12.22.2, pure JS only; the Nous core needs Node 22.12 or later, so the core cannot move onto the TV.

<a id="input-sources"></a>
## 7. Microphone and camera source options

| Source | Status | Notes |
|---|---|---|
| TV built-in microphone (Hey, LG) | ❌ for third parties: not found | Seen only in LG's own voice feature |
| Magic Remote microphone | ❌ for third parties: not found | The Luna list has no matching API |
| LG Smart Cam VC23GA (dual microphones) | ❔ | Compatible with the G3, but no usable apps listed; whether third-party web apps can use it is unknown, inferred no |
| Generic USB microphone / camera on the TV | ❔ | The spec page's "USB Camera Compatible" does not say for whom; inferred no for third parties |
| eMeet M0 Plus on the Pi (today) | ✅ | Pi terminal capture verified on hardware (2026-11-05) |
| eMeet or reSpeaker on the Mac | ✅ | Mac App today |
| Pi camera / Mac camera | ✅ | Images are analyzed only locally; red line unchanged |

Conclusion: keep microphone and camera on the Pi or the Mac.

<a id="deployment"></a>
## 8. Development and deployment flow (if option A is done)

```bash
npm install -g @webos-tools/cli
ares-setup-device --add myTV -i host=<TV_IP> -i port=9922 -i username=prisoner
ares-novacom --device myTV --getkey
ares-package <app-dir>
ares-install --device myTV <package>.ipk
ares-launch --device myTV <app-id>
ares-inspect --device myTV <app-id>
```

1. Install the Developer Mode App on the TV, sign in with an LG developer account, and turn on Dev Mode and Key Server.
2. Install the CLI on the Mac (Node version per the npm package's `engines`), register the TV, and fetch the key with the 6-character passphrase.
3. Package, install, launch, and debug (`ares-inspect` opens remote DevTools).
4. Press EXTEND on the TV periodically; reinstall after expiry.
5. With a JS service: package it in the same .ipk, Node 12, pure-JS modules only.

<a id="maintenance"></a>
## 9. Maintenance cost

| Item | A | B | D1 | E |
|---|---|---|---|---|
| New code | Medium: TV build target (Chromium 94), remote focus and keys, entry point or JS service forwarder | Low: entry point only | Almost none | High |
| Routine work | Periodic Developer Mode extension; reinstall after expiry | None | Same as today's Pi | Cannot update firmware |
| Firmware updates | May change engine version and behavior (the G3 already has an upgrade path) | Same as A | Unaffected (the TV is just a screen) | May break root |
| Test burden | One more Chromium version to test | Same as A | No increase | High |

<a id="risks"></a>
## 10. Risks

- **Developer Mode expiry**: the time limit is not stated officially (community says 1000 hours), and the app is removed on expiry; forgetting to extend makes it vanish one day.
- **Firmware updates change behavior**: the G3 already has a webOS 24 / 25 upgrade path, so the engine may jump from Chromium 94 to 108 or 120; SSAP has changed ports before (3000→3001, see LGTVG3).
- **Unclear official capabilities**: LG no longer publishes a Web API support table, so testing is the only source; forum replies are not formal specifications and may change.
- **Connection entry point**: for the TV to reach the core, a LAN entry point or an on-TV forwarder must be added. The current principle is "do not directly loosen existing protections" ([current implementation](Current_Implementation_Status.en.md)); under the 2026-10-31 "convenience first" priority, whether and how to do it is George's decision (D2).
- **Privacy red line**: raw webcam images and un-woken audio must not be written to disk, enter traces, or leave the device. Options A / B / C cannot get microphone or camera anyway, so they add no such data; option D keeps the existing Pi / Mac handling (images analyzed only locally, un-woken audio only in a 2-second in-memory ring buffer). Option E's rooted software has excessive privileges and the highest risk. The capability page does not open the microphone or camera and does not use the network.
- **Product red lines**: a TV app must not become an app launcher, icon wall, or home Dashboard; the screen idles as the electronic brain like the Pi, and every Surface still needs a `visibility_reason`.
- **Echo and false wakes**: when the TV speakers play Nous or a programme, the eMeet may pick it up; a false wake opens a paid call (see plan 17).

<a id="recommendation"></a>
## 11. Recommended route and staged gates

**Recommendation**: take option D1 (Pi to TV HDMI) first, and run the G-0 capability check alongside it. Only if G-0 shows the TV's engine is recent enough, and George wants a "TV display terminal without the Pi", go on to G-2 and later.

| Gate | Content | Pass condition | If it fails |
|---|---|---|---|
| **G-0** capability check | Open `capability-check.html` in the TV browser (once over HTTPS, once over LAN http) and record the UA, secure context, and each API | Two JSON results or photos, written into `docs/validation/` | Record as is; microphone and camera being unavailable does not affect D1 |
| **G-1** hybrid trial (D1) | Move the Pi to the TV's HDMI and use it daily for a week: brain, clock, memories video, processing sound, one try each of HDMI speakers and eMeet speaker, echo and false wakes | George finds text, animation, and sound usable; echo and false-wake counts recorded as is | Adjust the output device or go back to the small screen |
| **G-2** display-only .ipk prototype | Install a hosted / packaged app through Developer Mode that shows only the brain and clock; connection method per decision D2 (LAN entry point or JS service forwarder) | The TV shows brain-region animation driven by real SSE events, and a lost connection is shown truthfully | Stay on D1 |
| **G-3** daily use | The Mac launches the app over SSAP when the TV powers on; Developer Mode extension routine; rerun G-0 after firmware updates | Usable for two consecutive weeks, with extension count and failures recorded | Stay on D1 |

Microphone, wake word, and camera are not part of the TV-side gates unless G-0 or LG documentation brings new evidence.

<a id="home-test"></a>
## 12. Minimal home test George can do (G-0)

The check page [`terminals/webos/capability-check.html`](../terminals/webos/capability-check.html) only reads capabilities: it never calls `getUserMedia` and records no audio or video; the page CSP is set to `connect-src 'none'`, so it sends nothing; `enumerateDevices` only counts devices (names are empty without permission). The interface has a 繁體中文 / English switch.

**Step 1: open it over HTTPS (tests capabilities in a secure context).** After this merges to main, enter the URL below in the TV browser (a third-party GitHub relay used only to get the correct web page type; the page itself sends nothing back). If the URL is too long to type, open it from the Mac with LGTVG3's `lgtv url`:

```text
https://raw.githack.com/pcpcchen-coder/AIOS/main/terminals/webos/capability-check.html
```

**Step 2: open it over LAN http (tests the case a non-Pi terminal is most likely to hit).** Run this in the repo directory on the Mac, then open `http://<Mac LAN IP>:8765/capability-check.html` on the TV. Press Ctrl+C when done:

```bash
cd terminals/webos && python3 -m http.server 8765
```

**Step 3: record the results.** Both times, photograph the whole page or press "Copy JSON", and hand it to the developer for `docs/validation/`. Look at:

1. "User-Agent and Chromium version": 94 means webOS 23; 108 / 120 means it was upgraded.
2. "Secure context": HTTPS should show "Yes", LAN http should show "No".
3. "getUserMedia interface present", "Microphone / camera permission state", "device count": an interface being present does not mean it works; record `denied` permissions or a device count of 0.
4. "AudioWorklet", "WebAssembly SIMD", "setSinkId", "WebGL 2", "Video formats".

**Step 4 (optional):** move the Pi's HDMI to the TV and try G-1 from section 11.

<a id="decisions"></a>
## 13. Decisions for George

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Which route next? | a. G-0 + G-1 first (Pi to TV, zero code); b. go straight to an .ipk display terminal (G-2); c. pause | **a** |
| D2 | If an .ipk or TV-browser terminal is built, how does the TV reach the core? | a. try an on-TV JS service forwarder first (no core change; residency unknown); b. add an authenticated LAN HTTPS entry point to the core (needs a public CA certificate and RPI-2-style pairing); c. don't | **a**, and discuss b only if it fails |
| D3 | With the TV showing the Pi picture, should a wake automatically switch the TV to the Pi's HDMI? | a. never automatically; b. only when the TV is already on; c. also power the TV on and switch | **b** (avoids turning the TV on at night; George to confirm) |
| D4 | Where does Nous's voice come out? | a. eMeet speaker (today); b. TV speakers (HDMI) | **a** first, compare in G-1 |

<a id="sources"></a>
## 14. Sources (all checked on 2026-11-09)

Official:
- [webOS TV Web API and Web Engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [webOS TV Camera API](https://webostv.developer.lge.com/develop/references/camera)
- [Luna Service Introduction](https://webostv.developer.lge.com/develop/references/luna-service-introduction)
- [App Lifecycle Management](https://webostv.developer.lge.com/develop/guides/app-lifecycle-management)
- [appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json)
- [JS Service Basics](https://webostv.developer.lge.com/develop/guides/js-service-basics), [JS Service FAQ](https://webostv.developer.lge.com/develop/guides/js-service-faq)
- [Developer Mode App](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- [CLI Installation](https://webostv.developer.lge.com/develop/tools/cli-installation), [CLI Developer Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide), [@webos-tools/cli (npm)](https://registry.npmjs.org/@webos-tools/cli)
- [App Ecosystem](https://webostv.developer.lge.com/distribute/app-ecosystem), [App Approval Process](https://webostv.developer.lge.com/distribute/app-approval-process)
- [Application Manager](https://webostv.developer.lge.com/develop/references/application-manager)
- [Web App Types](https://webostv.developer.lge.com/develop/getting-started/web-app-types)
- [TLS](https://webostv.developer.lge.com/develop/specifications/tls)
- [LG MY OLED65G3PSA specifications](https://www.lg.com/my/tvs/lg-oled65g3psa)
- [LG AU Smart Cam VC23GA](https://www.lg.com/au/tv-accessories/ebx64338002)
- [LG Italia "Hey, LG" help](https://www.lg.com/it/supporto/supporto-prodotto/risoluzione-anomalie/help-library/cs-CT20154005-20152636672944/)
- [LG Italia webOS 25 upgrade](https://www.lg.com/it/magazine/aggiornamento-a-webOS-25/)

Community (including LG staff replies on the forum):
- [LG developer forum: WebRTC getUserMedia webOS 24 (#27587)](https://forum.webostv.developer.lge.com/t/webrtc-getusermedia-webos-24/27587)
- [LG developer forum: WebRTC support in webOS TV (#2306)](https://forum.webostv.developer.lge.com/t/webrtc-support-in-webos-tv/2306)
- [LG developer forum: opening a URL in the browser (#8739)](https://forum.webostv.developer.lge.com/t/how-to-open-a-web-link-in-lg-webos-browser-without-relaunching-the-existing-app/8739)
- [LG developer forum: launching an app at first boot (#3759)](https://forum.webostv.developer.lge.com/t/how-to-make-an-app-run-automatically-on-first-boot/3759)
- [Home Assistant webostv.command](https://www.home-assistant.io/actions/webostv.command/)
- [webOS Brew: Developer Mode](https://www.webosbrew.org/devmode/), [Rooting](https://www.webosbrew.org/rooting/)
- [faultmanager-autoroot](https://github.com/throwaway96/faultmanager-autoroot), [Homebrew Channel #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124), [cani.rootmy.tv](https://cani.rootmy.tv/)

In this project:
- [LGTVG3](https://github.com/pcpcchen-coder/LGTVG3) (main read on 2026-11-09: SSAP, WOL, screenshots, `lgtv url`; real OLED65G3PSA record)
- [LGTV-1 validation](validation/lgtv-1-2026-11-07.en.md), [LGTV-2 validation](validation/lgtv-2-2026-11-08.en.md), [20 Netflix plan](20_TV_Netflix_Playback_Plan_2026-11.en.md)
- [Raspberry Pi terminal kit](../terminals/rpi4/README.en.md)
