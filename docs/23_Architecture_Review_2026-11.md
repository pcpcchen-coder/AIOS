<!-- bilingual: source=zh-TW -->

> [繁體中文](23_Architecture_Review_2026-11.md) | [English](23_Architecture_Review_2026-11.en.md)

# Nous 23 — 架構盤點與重整計畫（2026-11）

版本：v0.1 · 日期：2026-11-09 · 狀態：**提案，等 George 同意後才動程式**。本文只盤點與規劃，沒有改任何產品程式。數字由 [`scripts/architecture-metrics.mjs`](../scripts/architecture-metrics.mjs) 算出，計算方式與輸出見 [驗證紀錄](validation/architecture-review-2026-11-09.md)。基準：main `416a1ab`（PR #138 之後）。

本文的行號都是基準 commit 的行號，之後會漂移；請以檔名與函式名為準。

## 0. 一頁摘要

- 原型 `prototype/ambient-shell` 現在有 241 個原始檔、66,887 行（server 30,844、src 25,626、shared 7,721、desktop 2,696），不是 2026-10 規劃時的小原型。全部驗證在基準上都是綠的：型別檢查、172 個測試檔 3,194 項中 3,188 項通過、6 項跳過（跳過數依環境而異：本機檔案鎖可用時是 3,189／5），Vite 建置、`verify-aios`、雙語檢查。
- 分層本身是乾淨的：`server`、`src`、`desktop` 只 import `shared`，**沒有任何跨層 import**。問題在層內：16 個檔案超過 800 行、4 組 import 環、同一件事寫在兩三個地方。
- 最大的五個問題，依「不改的代價」排序：
  1. `src/main.ts` 4,211 行、import 67 個模組，混了 12 種責任；每個功能批次都要改它。
  2. 兩條即時語音路徑在頁面層（`src/realtime.ts`／`src/live-voice.ts`）有 13 個同名 private 方法，在核心層（`server/apikey-call.ts`／`server/live-tool-caller.ts`）各自實作 `recall_memory`／`delegate_task`；每個語音修正要做兩次。
  3. 設定與資料檔的寫入方式分散：11 個 store 走 `prefs-file.ts`，`prefs-file.ts` 之外另有 15 個模組自己寫 tmp＋rename（其中幾個是任務、記憶、身分等資料檔，不是設定），再加頁面 localStorage 與 `desktop.json`；同一個預設值寫在兩處的有 4 組。
  4. `server/home-bridge.ts` 1,655 行把中控 `/commands`、AIFA 冷氣、紅外線三條路線與解析器放在一起；但只有 4 個 importer，拆起來便宜。
  5. 文件落後程式：根 README、原型 README、`docs/11`、`docs/12` 仍說記憶、加密保存、家人辨識、喚醒詞「尚未實作」或「待 PoC」；`docs/validation/README.md` 少索引 9 份紀錄。依 CLAUDE.md 的閱讀順序，後續 Agent 會先被這些句子誤導。
- 重整計畫是 S0（本文）加 14 步（§3，共 15 列），每一步是一個行為不變、測試全綠、可以單獨合併的小 PR；風險低的文件同步、改名、抽共用 helper 在前，`app.ts`、`main.ts` 拆分在最後。

## 1. 現況架構

### 1.1 規模

| 層 | 檔案 | 行數 | 最大檔 |
|---|---|---|---|
| `server/`（本機核心，Node http＋SSE） | 102 | 30,844 | `memory/service.ts` 2,613 |
| `src/`（頁面，Vite 無框架 TypeScript） | 92 | 25,626 | `main.ts` 4,211 |
| `shared/`（前後端與桌面共用契約） | 38 | 7,721 | `identity.ts` 629 |
| `desktop/`（Electron macOS 殼） | 9 | 2,696 | `main.mjs` 1,523 |
| `tests/` | 172 個測試檔 | — | — |

超過 800 行的 16 個檔案：`src/main.ts` 4,211、`server/memory/service.ts` 2,613、`src/views.ts` 2,028、`server/identity-service.ts` 1,684、`server/home-bridge.ts` 1,655、`desktop/main.mjs` 1,523、`server/app.ts` 1,369、`server/memory/live.ts` 1,361、`server/realtime-routes.ts` 1,275、`src/family-view.ts` 1,259、`src/realtime.ts` 1,080、`server/store.ts` 1,029、`src/live-voice.ts` 884、`src/brain.ts` 873、`src/memory-view.ts` 836、`server/live-route.ts` 811。

### 1.2 模組地圖

圖中的文字沿用程式識別字與英文，中英文版的圖完全相同。

```
desktop/main.mjs ──(dynamic import of the bundled server.mjs)──▶ server/nous.ts startNous ──▶ server/app.ts createApp (the only HTTP server)
      │  HTTP fetch to 127.0.0.1 (settings, tasks; polled every 15 s)                  │
      │  IPC: identity / memory / tasks / camera-enable / confirm-delete               │ SSE /api/events
      ▼                                                                                ▼
BrowserWindow ── loads index.html ──▶ src/main.ts (page composition root) ◀── EventSource ── the page calls /api/* only through src/api.ts
                                          │
                                          └── shared/* (types, preference specs, route contract, i18n, command table)
```

**server/ 子系統**（責任 → 主要檔案）

| 子系統 | 檔案 | 責任 |
|---|---|---|
| HTTP 核心 | `app.ts`、`nous.ts`、`index.ts`、`http-guard.ts`、`page-headers.ts`、`localization.ts`、`config.ts` | 所有路由寫在 `app.ts` `handleApi`（`app.ts:404-1053`）的 `if (method && path)` 鏈；`nous.ts` 是組合根，建所有 store 與 service，把 `onChange → notify()` 接到 `server.notifySettings`（`nous.ts:570`） |
| 交辦與執行 | `runner.ts`、`store.ts`、`providers.ts`、`claude-executor.ts`、`chatgpt-executor.ts`、`mock-executor.ts`、`prompts.ts`、`chat.ts`、`history.ts`、`sealed-vault.ts`、`protected-index.ts`、`task-migration.ts`、`task-ipc.ts` | HTTP 提交 → `TaskRunner` → `ProviderManager`／executor → Artifact → SSE `task.updated`；macOS App 的任務與成果加密在 `data/sealed/` |
| 即時語音 API key 路徑 | `realtime.ts`（`RealtimeBridge`＋**兩條路徑共用的工具表與規則**）、`apikey-call.ts`（核心旁路：只在核心跑 `recall_memory`／`delegate_task`）、`realtime-routes.ts`（`RealtimeSessions`、`RealtimeRoute` 介面、`planStart`、`ApiKeyRoute`）、`realtime-settings.ts`、`sideband.ts`、`web-search.ts`、`voice-cost-log.ts` | 頁面用 WebRTC 直連 OpenAI，工具在頁面執行（`src/realtime-tools.ts`），再 POST 回核心 |
| 即時語音 ChatGPT 方案路徑 | `live-route.ts`（`LiveRoute`／`LiveCall`）、`live-tool-caller.ts`（Codex Responses 工具迴圈）、`codex-responses.ts`、`codex-auth.ts`、`chatgpt-auth.ts` | 工具在核心執行：`app__*` 直接進整合層 Dispatcher，其他 HOST_TOOLS 經 SSE `realtime.host` 丟給頁面再由 `/api/realtime/host-result` 回來 |
| HomeBridge（武陵居中控） | `home-bridge.ts`、`home-overview.ts`、`home-corner-settings.ts`、`integrations/adapters/home.ts`（AIL-2 Facade） | 名稱比對、讀值整理、`/commands`、AIFA 冷氣、紅外線、確認卡佇列、每分鐘 6 個指令 |
| 整合層（AIL） | `integrations/{index,registry,dispatcher,policy,schema,status,contracts}.ts`、`adapters/{timer,alarm,weather,home,lg-tv,gmail-gog,google-calendar,spotify-soloist,voice-relay,mock}.ts`、`voice-relay/*`、`lgtv/*`、`gog/runner.ts` | 工具註冊、政策、按需狀態；`config.ts` 直接 import 三個 adapter |
| 記憶（家庭記憶） | `memory/{service,live,store,parse,boundary,suggest,retrieve}.ts` | 只在 macOS App 經 IPC；`memory/live.ts` 同時提供口語確認、`delegatePolicy` 給兩條語音路徑 |
| 回憶模式（照片） | `memories.ts`、`memories-google.ts`、`memories-meta.ts` | 與「記憶」同音不同事 |
| 身分、臉、聲音、喚醒 | `identity-service.ts`、`identity-store.ts`、`greeting-picker.ts`、`face-runtime.ts`、`speaker-runtime.ts`、`wake-runtime.ts`、`terminal-routes.ts` | 三個 `*-runtime.ts` 幾乎相同（雜湊核對、`/…-runtime/` 提供） |
| 設定檔 | `prefs-file.ts` 與 11 個 PrefsFile store（9 個 `*-settings.ts` 加 `memories.ts`、`proactive.ts`）；另 15 個模組自己寫檔 | 見 §1.4 |
| 主動提醒、鬧鐘、天氣 | `proactive.ts`、`proactive-calendar.ts`、`alarms.ts`、`weather.ts`、`local-date.ts` | `alarms.json` 由核心排程 |
| 終端（Pi） | `terminal-presence.ts`、`terminal-display.ts`、`terminal-routes.ts`；`shared/terminal.ts` | 核心只聽 loopback，Pi 經 SSH 通道 |

**src/ 子系統**

| 子系統 | 檔案 | 備註 |
|---|---|---|
| 組合根 | `main.ts`（4,211 行）、`shell-state.ts`、`presentation-policy.ts`、`api.ts`、`intent.ts`、`desktop-command.ts` | `main.ts` 的 12 種責任見 §2 問題 1 |
| 畫面 | `views.ts`（2,028 行：Surface、13 個 `render*Settings`、面板狀態型別、文字表）、`settings-entry.ts`、`performance.ts`、`voice-volume.ts` | |
| 電子腦 | `brain.ts`（狀態與編排）、`brain-canvas.ts`、`brain-webgl.ts`、`brain-frame.ts`、`region-activity.ts`、`processing-cue.ts`、`processing-sound.ts` | 六區動畫只由 `domain` 事件驅動（CLAUDE.md 要求） |
| 即時語音頁面層 | `realtime.ts`（`RealtimeVoice`，API key）、`live-voice.ts`（`LiveVoice`，Codex）、`realtime-session.ts`（接縫 `RealtimeSession`、`openRealtime`）、`realtime-tools.ts`（兩路共用工具執行器與確認佇列）、`call-guard.ts`、`call-lifecycle.ts`、`early-speech.ts`、`voice-command.ts`、`echo.ts`、`voice.ts`、`conversation.ts` | |
| 感測（鏡頭） | `sense/{controller,pipeline,processor,trackers,geometry,identity-ambient,identity-client,identity-worker,light-worker}.ts`、`sense/face/*`、`light-meter.ts`、`face-calibration*.ts` | 只有 worker 能讀像素 |
| 聲音前端、喚醒、聲紋 | `audio/*`（`AudioFrontEnd`、`WakeController`、sherpa wasm）、`audio-devices.ts`、`speaker/*` | |
| 記憶、成果、家人畫面 | `family-view.ts`（1,259）、`memory-view.ts`（836）、`history-view.ts`、`protected-tasks.ts`、`memories.ts`（照片）、`identity-bridge.ts` | |
| 角落與鬧鐘 | `home-corner.ts`、`clock-corner.ts`、`alarm-ring.ts`（471 行，沒有直接測試）、`alarm-sound.ts` | |
| 終端（Pi） | `terminal-camera.ts`、`terminal-heartbeat.ts`、`screen-reporter.ts` | |

**shared/**：`types.ts`（fan-in 37）、`i18n.mjs`（40）、`identity.ts`（26）、`realtime-route.ts`（24）、`sense.ts`（23）是被最多模組依賴的契約。`prefs.ts` 定義偏好規格引擎；`sense.ts` 的 `CAMERA_PREFS`、`voice-prefs.ts` 的 `VOICE_PREFS`、`day-night.ts`、`wake.ts`、`alarm.ts`、`clock.ts`、`home-corner.ts`、`memories.ts`、`proactive.ts`、`audio-devices.ts` 各自放預設值與寫入路徑常數。

**desktop/**：`main.mjs` 在同一個 Node 行程內啟動核心（`startCore`，`main.mjs:141`），用 HTTP 讀寫設定，用 IPC 服務頁面，用 `executeJavaScript` 派 `nous:command` 給頁面（`main.mjs:602` → `src/main.ts:3607`）。`settings-menu.mjs`（785 行）是純選單範本，因為不能載入 `.ts`，複製了 shared 的常數與五張文字表（`settings-menu.mjs:15,184,311,379,408,455,499,544,753` 的註解自己這麼說）。

### 1.3 資料流

**A. 即時語音，API key 路徑**

```
page POST /api/realtime/start → RealtimeSessions.planStart picks the route → StartDecision{route:"api_key"}
page RealtimeVoice (src/realtime.ts) WebRTC ⇄ OpenAI Realtime (oai-events data channel)
    tool calls run in the page: src/realtime-tools.ts executeRealtimeTool → POST /api/home/*, /api/integrations/call, /api/realtime/web-search
core ApiKeyCall (server/apikey-call.ts) opens the sideband WebSocket (server/sideband.ts)
    only recall_memory / delegate_task run in the core; memory/live.ts decides memory and delegation policy
    events return to the page over SSE realtime.live{kind: briefing|hold|closed|memory_*|delegate_*}
```

**B. 即時語音，ChatGPT 方案（Codex live）路徑**

```
page POST /api/realtime/start → StartDecision{route:"live"} → LiveRoute.start (server/live-route.ts, chatgpt.com /backend-api/codex/realtime/calls)
page LiveVoice (src/live-voice.ts): the WebRTC data channel only receives frameless events; text goes out via POST /api/realtime/input
core LiveToolCaller (server/live-tool-caller.ts) runs the Codex Responses tool loop:
    recall_memory / delegate_task in the core; app__* straight to IntegrationDispatcher;
    the other HOST_TOOLS (home_*, web_search, end_conversation, …) via SSE realtime.host → page executes → POST /api/realtime/host-result
```

兩條路徑共用：`server/realtime.ts` 的工具 schema 與規則文字（`buildRealtimeTools`、`realtimeToolRules`）、`shared/realtime-route.ts` 的事件契約、`src/realtime-tools.ts` 的頁面工具執行器、`src/voice-command.ts` 的本機指令、`src/call-guard.ts` 的時限。

**C. 交辦與工具執行**

```
POST /api/tasks (or voice delegate_task) → TaskStore (tasks.json; encrypted in data/sealed/ inside the App) → TaskRunner (concurrency cap 4)
   → ProviderManager picks claude / chatgpt / mock → executor plans, generates step by step, summarises → Artifact (artifacts.json)
   → store.subscribe → SSE task.updated / task.deleted → page renderProgress / renderArtifact (shown only on user_request)
```

**D. 中控 HomeBridge**

```
voice home_status / home_control (or a typed command)
  → API-key path: page → POST /api/home/{status,control,confirm}; live path: core → SSE realtime.host → page → the same /api/home/*
  → app.ts homeCall (app.ts:1080): through the adapters/home.ts Facade when NOUS_AIL lists home, otherwise HomeBridge directly
  → HomeBridge.control → planFor picks the route: commands (POST /api/v1/devices/{id}/commands)
                                                 aifa_power / aifa_climate (/integrations/aifa/…)
                                                 ir_key (/infrared-commands)
  → commands that need confirmation go to pending (90 s, at most 8) → page confirmation card → POST /api/home/confirm
Top-left home status: GET /api/home/overview → HomeOverview (30 s cache) → read-only, not a Surface
```

**E. 雙目鏡頭感測**

```
getUserMedia (gated by the main process inside the App) → SensePipeline (MediaPipe, /vision/*) → trackers / geometry (head pose, nominal distance, open palm, arm)
  → SenseController events → main.ts: Shell state, brain zoom, look-to-talk
  → identity-worker (the only reader of pixels) → IdentityClient → core identity-service (IPC only; the Pi via /api/terminal/identity)
  → light-worker: one brightness number every 30 s → day-night (night volume, night mode)
Raw frames are never written to disk, traced or sent out (CLAUDE.md red line).
```

**F. 設定與偏好**

```
write: page src/api.ts POST /api/settings/{provider,camera,camera-tuning,voice,audio,wake,clock,alarms,day-night,home-corner,proactive,memories,realtime}
       desktop main.mjs uses the same HTTP; the Pi's camera settings stay in page localStorage (terminal-camera.ts)
store: 11 PrefsFile stores (camera/voice/audio/wake/face-tuning/clock/home-corner/day-night/realtime/proactive/memories .json)
       + 15 modules that write their own files (alarms, providers settings.json, two credentials files, identity, memory, sealed vault, voice relay, lgtv, voice-cost.jsonl, proactive-log, …)
       + page localStorage (a second copy of day-night / luma / volume, performance, locale, Web Speech consent)
       + desktop.json (locale, realtimeModel / realtimeVoice fed to the core as environment variables, maxConcurrent, window bounds)
broadcast: each store's onChange → nous.ts notify() → app.ts notifyAll → SSE settings.updated (rendered per Mac / terminal source)
read: GET /api/settings → app.ts settings.view() aggregates → localizeSettings (repeated 18 times in app.ts)
```

### 1.4 對外介面

**HTTP 路由：85 條**（80 條 `/api/*`＋5 條非 API 分派），全部在 `server/app.ts`，只有語音中繼 10 條在 `server/integrations/voice-relay/routes.ts:57-126`。點算方式見驗證紀錄。

| 群組 | 路由 | 位置 |
|---|---|---|
| 設定 | `GET /api/settings`；`POST /api/settings/{provider,camera,camera-tuning,voice,audio,wake,clock,alarms,day-night,home-corner,proactive,memories,realtime}` | `app.ts:406-679` |
| 鬧鐘 | `POST /api/alarms/{stop,ack,notice/clear,timers/cancel,clear,snooze,alarms/add,alarms/enable,alarms/delete}` | `app.ts:527-569` |
| 天氣與家中 | `GET /api/weather/now`、`GET /api/home/overview`、`POST /api/home/{status,control,confirm}` | `app.ts:509,586,937-957` |
| 回憶照片 | `POST /api/memories/google/{pick,cancel,clear}`、`GET …/qr.svg`、`GET /api/memories/items`、`GET /api/memories/media/:id` | `app.ts:637-662` |
| 對話 | `POST /api/chat`（串流） | `app.ts:683`，`streamChat` 1110 |
| 即時語音 | `POST /api/realtime/{start,call,input,approval,host-result,stopped,playback,stop-reply,alive,end,web-search}`、`GET /api/realtime/cost-records` | `app.ts:684-894` |
| 終端 | `POST /api/terminal/{heartbeat,identity,memory}`、`GET/POST /api/terminal/display` | `app.ts:816-842` |
| 整合層 | `GET /api/integrations/status`、`POST /api/integrations/call`；語音中繼 `GET /api/voice-relay`＋9 個 POST | `app.ts:852-891`、`voice-relay/routes.ts` |
| 登入 | `POST /api/auth/codex/{login,cancel,logout}`、`POST /api/auth/chatgpt/{login,cancel,logout,welcome-ack}` | `app.ts:916-981` |
| 任務與紀錄 | `GET/POST /api/tasks`、`POST /api/tasks/:id/{cancel,retry}`、`GET /api/artifacts/:id`、`GET /api/history`、`GET /api/history/:id`、`POST /api/history/:id/delete`、`GET /api/events`（SSE） | `app.ts:986-1038` |
| 非 API | `GET /help/commands`、`/face-runtime/*`、`/speaker-runtime/*`、`/wake-runtime/*`、靜態頁（`/history` → `history.html`） | `app.ts:375-393` |

**SSE 事件（`/api/events`，型別 `shared/types.ts:208-217`）**：`hello`（`app.ts:1221`）、`task.updated`（350）、`task.deleted`（354）、`settings.updated`（`notifyAll` 1205）、`memory.presence_changed`（1243）、`realtime.host`（`realtime-routes.ts:1201`）、`realtime.live`（`realtime-routes.ts:752,1114,1156,1193`；`kind` 清單在 `shared/realtime-route.ts:250-283`，由 `live-route.ts`、`apikey-call.ts`、`memory/live.ts` 發出）。頁面只用匿名 `onmessage`，在 `src/main.ts:2728` `onServerEvent` 依 `type` 分派。SSE 幀 `data: …\n\n` 在 `app.ts` 五處各自組字串（296 即時語音旁路、346 `broadcast`、1125 `streamChat`、1209 `notifyAll`、1222 `hello`），keep-alive 在 366。`/api/chat` 另有一套每次請求的串流事件（delta、delegate、delegate_blocked、delegated、memory_notice、memory_revoked、done、error）。

**設定檔（configDir）**

| 走 `prefs-file.ts`（逐鍵驗證、tmp＋rename、0600、改了就廣播） | 自己寫檔 |
|---|---|
| `camera.json`、`voice.json`、`audio.json`、`wake.json`、`face-tuning.json`、`clock.json`、`home-corner.json`、`day-night.json`、`realtime.json`、`proactive.json`、`memories.json` | `alarms.json`（`alarms.ts:615`）、`settings.json` 供應商（`providers.ts:172`）、`chatgpt-credentials.json`、`codex-credentials.json`、`proactive-log.json`、`memory-enabled.json`（`nous.ts:687`）、`voice-cost.jsonl`、`memories/google/index.json`、語音中繼 `config.json`／`trials.json`、`lgtv.json`、身分 `gallery.v1.json` 等三檔、記憶 `store.v1.enc`、`data/sealed/*.enc`、`tasks.json`／`artifacts.json` |

`desktop.json` 由 `desktop/main.mjs:25` 自己管，核心不知道它。

### 1.5 測試覆蓋

| 類別（依序取第一個符合） | 檔數 | 說明 |
|---|---|---|
| 桌面（import `../desktop/`） | 25 | Electron 模組邏輯；沒有真的 Electron 視窗 |
| 伺服器 HTTP（`server/app.ts` 或 `node:http`） | 23 | 真的起 `createApp`＋`MockExecutor`，假中控、假電視、假 OpenAI 旁路都在這裡 |
| 頁面 DOM | 29 | **沒有安裝 jsdom／happy-dom**；用 `vi.stubGlobal("document", …)` 手寫假元素，或直接讀 `src/*.ts`、`index.html`、`style.css` 文字比對 |
| fixture／replay | 30 | `tests/fixtures/*`：fake-sideband、fake-chatgpt、apikey 等 |
| 純函式 | 65 | shared 與純邏輯 |

- 26 個來源模組沒有任何測試直接 import（清單在驗證紀錄）；其中有邏輯的是 `src/alarm-ring.ts`（471 行）、`src/clock-corner.ts`、`server/prefs-file.ts`（只經 11 個 store 間接測）、`server/sideband.ts`（被 fixture 取代）。`src/main.ts` 與 `desktop/main.mjs` 本來就只能經瀏覽器腳本測。
- 外部服務全部是假的，而且都有標示（Anthropic 假 fetch、OpenAI 旁路 fixture、Codex／ChatGPT 假伺服器、假中控、假 webOS 電視、假 Soloist、假 gog、假 Open-Meteo）；只有 `day-night-volume.test.ts` 與 `wake-wasm-build.test.ts` 用了 fake 卻沒在開頭標 mock／fixture。
- 瀏覽器腳本 `scripts/verify-*.mjs` 六支都跑 mock provider，不在 vitest 內。
- 實機證據只在部分紀錄且都是局部：Mac（HIST-1、ID-02、WK-00、SP-00／02a／02b、live-voice §4、MEM-0 鑰匙圈探針）、Pi 4（`rpi-deployment-fixes`、`memories-idle-after-call`、`day-night-badge` 的亮度讀數）、家中開關燈口頭確認（H1）。其餘 60 多份都是 fixture、mock 或無頭 Chromium。沒有任何紀錄能把 G0–G3 改成通過。

## 2. 架構問題與優先順序

每項都附證據與「不改的代價」。P1 是現在就在付代價的；P2 是下一批功能前該處理的；P3 是順手或可選。

### P1-1　`src/main.ts` 是 4,211 行的組合根兼萬能檔

- 證據：import 67 個模組（fan-out 全 repo 最高）；段落見驗證紀錄：DOM 參照（`main.ts:166-376`）、即時語音編排（432-1009）、設定套用與音訊裝置（1010-1265）、鏡頭生命週期（1545-1901）、工具處理 `*FromRealtime`（2477-2593）、SSE reducer `onServerEvent`（2728）、打字指令 `handleCommand`（2865）、`actions: ViewActions` 35 個成員（3071-3330）、`render`（3419）、Electron `nous:command`（3607）。用 `document.body.dataset` 當共享狀態（1616-1617、1760、3563）。
- 不改的代價：每個功能批次都改這個檔，兩個分支並行就衝突；`main.ts` 沒有任何測試能直接 import（§1.5），回歸只能靠無頭 Chromium 腳本；新 Agent 讀完 4,000 行才能動手。

### P1-2　兩條即時語音路徑各寫一遍

- 頁面層：`src/realtime.ts` 與 `src/live-voice.ts` 有 13 個同名 private 方法（`skipGreeting`／`cancelGreetTimer`／`scheduleGreeting`／`greetIfPending` 558-591 對 392-424；`watchEarlySpeech`／`stopEarlySpeech` 961-985 對 707-731 只差兩行；`onCore` 857 對 542 處理同一組 `LiveCoreEvent`；`onHostCall` 896 對 636；`CallGuard` 與 `ApprovalQueue` 建構 262-275 對 156-174）。`quietLocalCommand` 兩種做法（`response.cancel` 對靜音計時器）。
- 核心層：`recall_memory`／`delegate_task` 在 `apikey-call.ts:308-345` 與 `live-tool-caller.ts:220-266` 各做一次，都呼叫 `delegatePolicy` 與 `MAX_RECALLS`；行事曆追問在 `apikey-call.ts:188-195` 與 `live-route.ts:503-507` 各一份。
- 工具名單宣告四次：`shared/realtime-route.ts:171 HostToolName`、`shared/voice-commands.ts:75 RealtimeToolName`、`live-tool-caller.ts:84 HOST_TOOLS`、`realtime-routes.ts:186-195 HOST_TIMEOUT_MS` 的鍵；家電參數長度限制三處（`realtime.ts:97-140`、`adapters/home.ts` schema、`app.ts:941-951`）。
- 不改的代價：每個語音修正要做兩次，而且只有一條路徑能在家裡實測（Mac 紀錄裡 API key 與 ChatGPT 方案多次結果不同步）；新工具要改四個清單，漏一個就在某條路徑上「未知工具」。

### P1-3　設定與偏好散在四種地方

- 證據：11 個 store 走 `prefs-file.ts`（共用 helper 的寫入在 `prefs-file.ts:100`），另外 15 個模組各自 tmp＋rename（`alarms.ts:615`、`providers.ts:172`、`chatgpt-auth.ts:511`、`codex-auth.ts:588`、`proactive.ts:106`、`nous.ts:687`、`voice-cost-log.ts:54`、`identity-store.ts:388`、`memories-google.ts:219`、`task-migration.ts:158`、`sealed-vault.ts:123`、`memory/store.ts:347`、`store.ts:1013`、`voice-relay/store.ts:84`、`lgtv/store.ts:39`）；`sealed-vault.ts:11` 的註解自己說「和 memory/store.ts 相同」。`clock-settings.ts` 與 `home-corner-settings.ts` 去掉領域字後只差註解、`unreadable` 訊息字串與 import 順序。
- 頁面另存一份：`src/voice-volume.ts` 的 `DAY_NIGHT_KEY`／`LUMA_THRESHOLDS_KEY`（:10-12）在 localStorage，`main.ts:1588 dayNightPrefs()` 先讀核心、沒有才讀 localStorage，`:1649` 還有搬遷碼。
- 預設值寫兩處：通話上限 `src/call-guard.ts:12 DEFAULT_MAX_CALL_MS` 對 `shared/voice-prefs.ts`；`gpt-realtime`／`marin` 在 `desktop/main.mjs:61-62` 與 `server/config.ts:136-137`；`maxConcurrent 4` 在 `desktop/main.mjs` 與 `server/runner.ts:57`；`REALTIME_ROUTES` 標籤在 `desktop/main.mjs:53` 與 `shared/realtime-route.ts:15`。
- 桌面複製 shared：`settings-menu.mjs` 的 `WAKE_STATE_REASONS`（:19）、`WAKE_THRESHOLD_OFFSETS`（:88）、`DEFAULT_WAKE_SILENCE_S`（:99）、音訊清理（:229）、`formatCallClock`（:761）、五張文字表；`preload.cjs:10,26-62` 再複製一次。
- 不改的代價：改一個預設值要找四個地方，測試只能靠「複本保持同步」的比對測試撐著（`settings-menu.mjs` 註解明說）；夜間模式這類跨裝置設定已經出現「核心一份、頁面一份」的過渡碼。

### P1-4　`server/home-bridge.ts` 1,655 行三條路線同檔

- 證據：常數 37-86、型別 87-212、讀值正規化 214-283、指令解析 285-392、目標比對 393-477、`planFor` 626、AIFA 667-767、紅外線 768-843、三種回覆 844-927、`class HomeBridge` 928-1511（`sendCommands` 1142、`sendAifa` 1159、`sendIr` 1242、`discoverAifa` 1425、`home` 1484）、解析器 1512-1654。Importer 只有 `app.ts:18`、`nous.ts:29`、`home-overview.ts:9`、`adapters/home.ts:3` 與 4 個測試。
- 不改的代價：H2–H4（`docs/12` §6）要再加設備政策與房間指令時全部疊進同一個檔；AIFA／紅外線的調整會碰到 H1 已口頭驗過的 `/commands` 路線。好消息是 importer 少、純函式多、`home-bridge.test.ts` 用假中控覆蓋三條路線，拆分風險低。

### P1-5　文件與程式不一致

| 文件 | 說法 | 程式 |
|---|---|---|
| 根 `README.md:79,124,155` | 缺長期記憶；doc 16「產品尚未啟用」 | `server/memory/*`、`desktop/memory-ipc.mjs`，MEM-0～5b 已合併 |
| 根 `README.md:125,160` | 聲音辨認仍是規劃；sherpa-onnx 待 PoC | `src/speaker/*`、`server/speaker-runtime.ts`；`package.json` sherpa-onnx 2.0.1、`src/audio/wake-worker.ts` |
| 根 `README.md:82` | 48 個測試檔、790 項 | 172 個檔、3,188 項 |
| `prototype/ambient-shell/README.md:217` | 視覺區「沒有攝影機或影像分析流程」 | `src/sense/*`、`light-worker.ts` |
| 原型 `README.md:377,471,480` | 加密保存「尚未實作（MEM-4a、4c）」、「沒有記憶層」、「資料以明文 JSON」 | `server/sealed-vault.ts`、`protected-index.ts`、`task-migration.ts` |
| 原型 `README.md:395-451` 結構樹 | 沒有 `server/memory/`、`server/integrations/`、`server/lgtv/`、`src/audio/`、`src/speaker/`、鬧鐘、回憶 | 都存在 |
| 原型 `README.md:401-402` | `brain.ts` 是 Canvas 2D 繪製；Shell 狀態少 `confirming` | 繪製在 `brain-canvas.ts`／`brain-webgl.ts`；`shell-state.ts:6` 有 `confirming` |
| `docs/Current_Implementation_Status.md:102` | 鏡頭開關分支「尚未合併」 | `server/app.ts:159,430` 在 main |
| `docs/Current_Implementation_Status.md:114` | 96 個測試檔 | 172 |
| `docs/11:54,97` | 身分辨識「尚未實作」；`app.ts` 的 `Permissions-Policy: camera=()` 要放寬 | `identity-*`、`identity-service.ts`；`page-headers.ts:14` 已依鏡頭設定給 `camera=(self)` |
| `docs/12:109,182` | 確認佇列只服務 MCP；讀值不快取 | `src/realtime-tools.ts:192` 已接 HomeBridge；`home-overview.ts:18` 30 秒快取；也沒寫 AIL-2 Facade 與 `lg_tv` 啟用時電視改路（`home-bridge.ts:525 TV_MOVED`） |
| `docs/06:9`、`docs/07:11` | 本機喚醒仍屬目標設計 | `NOUS_WAKE` 旗標下已實作 |
| `docs/README.md:21,27,28` | 17、18、19 規劃／未實作 | SP-0x、AIL-1、VCR-0／2 有程式 |
| `docs/validation/README.md` | 69 列 | 81 份紀錄，少 `day-night-badge`、`day-night-volume`、`pi-settings-entry`、`pinned-settings`、`sp-00`、`sp-02a`、`sp-02b`、`sp-03a`、`voice-volume` |
| `shared/seconds-menu.ts` | 名稱說「秒數」 | 內容是 seconds／factor／bool 三種選單列（檔頭 :2 自己承認） |
| `shared/realtime-route.ts` | 名稱像放 `RealtimeRoute` | `RealtimeRoute` 介面在 `server/realtime-routes.ts:85`；此檔只有線上契約 |

- 不改的代價：CLAUDE.md 規定 Agent 先讀 README 與狀態文件；讀到「沒有記憶層」「明文 JSON」會做出錯的設計決定或重建已存在的東西。
- **2026-11-10 補記（S1 文件同步）**：S1（分支 `claude/arch-s1-doc-sync`）已處理上表除最後兩列以外的每一列，做法是在原句旁加上有日期的補記，不改寫歷史文字，也不改任何程式：根 `README.md`、原型 `README.md`（含結構樹重寫）、`docs/Current_Implementation_Status.md`、`docs/11`、`docs/12`、`docs/06`、`docs/07`、`docs/README.md` 與 `docs/validation/README.md`（補上 9 列），中英文同步。最後兩列（`shared/seconds-menu.ts`、`shared/realtime-route.ts` 的命名）屬於其他批次，沒有動。上表保留盤點當時（main `416a1ab`）的行號與說法，S1 之後行號會位移。兩點說明：表中「3,188 項」是通過數，總數是 3,194 項（6 項跳過），S1 寫進文件的是[量測紀錄](validation/architecture-review-2026-11-09.md)的完整數字；`docs/12` 的 `home_status` 查詢確實仍不快取，30 秒快取只在 HOME-1 的 `GET /api/home/overview`，補記照這個區別寫。S1 沒有把任何 gate（G0–G3）或「待實作」硬體項目改成完成，沒有實機證據的項目仍標 fixture 或未驗證。

### P2-6　`server/app.ts` 1,369 行手寫路由鏈

- 證據：85 條路由在一條 `if` 鏈；`localizeSettings(settings.view(pageSource(…)))` 重複 18 次；同一句「沒有保存（無法寫入設定檔…）」的 try/catch 重複 12 次（436-679）；驗證做兩次（`app.ts` 解析 patch，`PrefsFile.parse` 讀回再驗一次）；SSE 幀五處手組；`app.ts:285` 自己 `new ApiKeyRoute`（組合根應在 `nous.ts`）；`app.ts:1083-1086` 讀 Home adapter 的私有結果欄位 `data.legacy`／`data.http_error`／`data.rethrow`。
- 不改的代價：每新增一個設定檔要在 `app.ts` 加 25 行幾乎相同的程式；路由順序決定行為（`startsWith` 在前會吃掉後面的），沒有測試保證。

### P2-7　4 組 import 環

- 執行期環：`realtime-routes.ts:36` import `connectApiKey`（`apikey-call.ts`），`apikey-call.ts:7` 反過來 import 值 `RouteStartError`；整個強連通分量含 8 個檔（`apikey-call`、`codex-auth`、`codex-responses`、`live-tool-caller`、`memory/live`、`proactive-calendar`、`realtime-routes`、`web-search`）。
- 型別環：`shared/types.ts:5,7` ↔ `seconds-menu.ts:7` ↔ `realtime-route.ts:4-5` ↔ `voice-cost.ts:5`；`src/api.ts:22` ↔ `realtime-session.ts:6` ↔ `realtime.ts:7,9-10` ↔ `realtime-tools.ts:4`；`memories.ts:22` ↔ `memories-google.ts:18`。
- 不改的代價：型別環在執行期無害，但表示 `shared/types.ts` 既是底層又依賴上層；執行期環讓 esbuild 打包順序與 vitest 的模組初始化順序有機會踩到 `undefined`，目前沒踩到只是運氣。

### P2-8　模組伸手拿別人內部的東西

- `codex-responses.ts:1` 從任務 executor `chatgpt-executor.ts:274` 拿 `readSse`；`proactive-calendar.ts:5` 從 `memory/live.ts` 拿 `exactYesNo`／`normalizeSpoken`／`readsQuestion` 與兩個常數；`search-terms.ts:4` 用 `memory/parse.ts` 的簡繁轉換；`config.ts` import 三個 adapter；`integrations/index.ts:1,9` import `../config` 與 `../lgtv/youtube`。
- 不改的代價：改記憶模組會動到行事曆追問；關掉記憶（`NOUS_MEMORY_ROUTES`）仍載入整個 `memory/live.ts`。

### P2-9　小 helper 重複

- `normalizeSpoken` 三份不同語意（`live-route.ts:118`、`memory/live.ts:241`、`voice-relay/catalog.ts:47`）；`hostOf`（`codex-responses.ts:339`、`web-search.ts:185`）；OAuth 回呼頁與常數（`chatgpt-auth.ts:27-35,545`、`codex-auth.ts:30-34,645`）；`face-`／`speaker-`／`wake-runtime.ts` 三胞胎；`app.ts:1328-1368` 已有共用的 `serveVerifiedRuntime`，但只有講者路由用它，`serveFaceRuntime` 與 `serveWakeRuntime` 仍各自複製同一段；頁面 `intent.ts` 與 `voice-command.ts` 兩套指令文法。
- 不改的代價：口語比對規則改一處漏兩處；三個 runtime 的雜湊核對若要加一種檔案得改三次。

### P3-10　測試基礎設施

- 沒有 DOM 環境，29 個頁面測試各自手寫假 `document`；`alarm-ring.ts`（471 行）沒有直接測試；兩個測試用 fake 沒標示。Vite 產出 `zh-tw-opencc` 1,070 kB 單一 chunk（建置警告）。
- 不改的代價：拆 `main.ts` 時最缺的就是能 import 頁面模組的測試；先補基礎設施才拆得安全。

### P3-11　命名

- `shared/seconds-menu.ts`（§P1-5）、`shared/realtime-route.ts`、「memories＝照片回憶」對「memory＝家庭記憶」、`settings.json` 其實只放供應商。
- 不改的代價：低；但改名最好趁現在 importer 還少（`seconds-menu` 5 個來源檔＋7 個測試）。

## 3. 重整計畫

原則：每一步一個 PR，**行為不變**（HTTP 回應、SSE、設定檔格式、頁面畫面逐位元組相同），測試全綠，附驗證紀錄；不夾帶功能；不改 CLAUDE.md 紅線與 gate；風險低的在前。每步都走 pstack（how → architect → checkpoint → 實作 → 驗證 → 獨立審查 → 修正 → PR），驗證固定跑 `npx tsc --noEmit`、`npx vitest run`、`npx vite build`、`node --check desktop/main.mjs`、`node scripts/verify-aios.mjs`、`node scripts/check-bilingual-docs.mjs`、`git diff --check`，加上該步自己的「前後相同」比對。

| 步 | PR 內容 | 動到的檔 | 風險 | 前後相同的證據 |
|---|---|---|---|---|
| S0 | **本文與量測腳本**（這個 PR）：`docs/23`、`scripts/architecture-metrics.mjs`、驗證紀錄、索引 | 只有文件與一支唯讀腳本 | 無 | 全套驗證綠 |
| S1 | **文件同步**：修 §P1-5 表列的每一句；補索引 9 份驗證紀錄；原型 README 結構樹補齊 | `README.md`、`prototype/ambient-shell/README.md`、`docs/Current_Implementation_Status.md`、`docs/11`、`docs/12`、`docs/README.md`、`docs/validation/README.md`（都含 .en） | 無 | 雙語檢查＋人工核對每句對應程式 |
| S2 | **架構守門測試**：`tests/architecture.test.ts` 用 `scripts/architecture-metrics.mjs` 的邏輯鎖住：跨層 import 為 0、import 環不多於現在 4 組（允許清單）、超過 800 行的檔不多於現在 16 個（允許清單，只能減不能加） | 新增 1 個測試；腳本抽成可 import 的模組 | 低 | 測試在基準上通過；故意加一個跨層 import 會失敗 |
| S3 | **改名 `shared/seconds-menu.ts` → `shared/menu-prefs.ts`**，順手把 `MenuPrefSetting` 型別搬到 `shared/prefs.ts` 解掉 shared 的型別環 | 5 個來源檔（含 `desktop/settings-menu.d.mts`）、7 個測試改 import 路徑 | 低 | `tsc` 綠；`describeMenuPrefs` 輸出 snapshot 相同 |
| S4 | **共用原子寫檔 helper**：`server/fs-atomic.ts` 提供 `writeAtomic(path, data, mode)`，先讓 5 個最簡單的呼叫者改用（`providers.ts`、`proactive.ts` 的 log、`voice-cost-log.ts`、`lgtv/store.ts`、`nous.ts` 的 memory-enabled）；`sealed-vault.ts`／`memory/store.ts` 的 durable 寫法保留、第二個 PR 再評估 | 1 新檔＋5 檔各 -10 行 | 低 | 既有 store 測試；寫出的檔逐位元組相同 |
| S5 | **PrefsFile store 工廠**：`server/prefs-store.ts` 的 `createPrefsStore(spec, file, defaults)` 取代 11 個 PrefsFile store（9 個 `*-settings.ts` 加 `memories.ts`、`proactive.ts`）的相同樣板；各檔留一行 export 維持 import 路徑 | 11 檔瘦身 | 低 | 既有測試不改即綠：`audio-`／`camera-`／`clock-`／`voice-`／`wake-settings`、`camera-prefs`、`prefs`、`day-night-mode`、`home-corner`、`memories-http`、`memories-google`、`proactive`、`proactive-calendar`、`apikey-integration`、`live-integration`（`face-tuning.json` 只經 `http.test.ts` 的 `/api/settings/camera-tuning` 間接測）；`settings.view()` JSON 相同 |
| S6 | **`app.ts` 設定路由表**：13 條 `/api/settings/*` 改成一張表（path → store → parsePatch），消掉 18 次 localize 與 12 次錯誤樣板；`PrefsFile.parse` 讀回時的第二次驗證先保留，等測試證明兩處驗證等價再另開 PR 移除 | `app.ts` -200 行左右；新增 `server/routes/settings.ts` | 中低 | `http.test.ts` 與 `backend-i18n.test.ts` 不改；錯誤訊息、狀態碼、回應 JSON 逐位元組比對 |
| S7 | **解執行期環＋搬 `ApiKeyRoute`**：`RouteStartError`／`RouteCall`／`SessionContext`／`HostGone` 等契約移到 `server/realtime-contracts.ts`；`ApiKeyRoute` 從 `realtime-routes.ts:1232` 搬到 `server/apikey-route.ts`（對稱 `live-route.ts`）；`app.ts:285` 不再自己 `new ApiKeyRoute`，由 `nous.ts` 注入（風險：`createApp` 沒帶 `realtimeRoutes` 時目前預設建 `ApiKeyRoute`，改成注入前要先確認沒有測試依賴這個預設，否則保留預設只搬位置） | `realtime-routes.ts` -60、`apikey-call.ts`、`app.ts`、`nous.ts` | 中低 | `realtime-routes.test.ts`、`apikey-route.test.ts`、`live-integration.test.ts` 不改即綠；量測腳本顯示環數 4 → 3 |
| S8 | **工具名單單一來源**：`HOST_TOOLS`、`HOST_TIMEOUT_MS` 的鍵、`RealtimeToolName` 都從 `shared/realtime-route.ts` 的 `HostToolName` 推導；家電參數上限只留 `adapters/home.ts` schema 一份，`realtime.ts` 與 `app.ts` 引用它 | 4 檔 | 低 | 工具 schema JSON 與 `realtimeToolRules` 文字逐位元組相同（加一個 snapshot 測試） |
| S9 | **`home-bridge.ts` 拆成資料夾**：`server/home/{hub-client,parse,commands,aifa,infrared,bridge}.ts`，`home-bridge.ts` 變成 re-export barrel，4 個 importer 與測試路徑不變 | 1 檔 → 7 檔，純搬移 | 中低 | `home-bridge.test.ts`、`integration-home-facade.test.ts`、`home-corner.test.ts` 不改；假中控收到的請求序列逐位元組相同 |
| S10 | **頁面兩路共用基底**：抽 `src/voice-path-shared.ts`（問候時序、先開口偵測、`CallGuard`／`ApprovalQueue` 建構、`LiveCoreEvent` 記憶事件處理）給 `RealtimeVoice` 與 `LiveVoice` 用；兩類各自保留連線與音訊差異 | `realtime.ts`、`live-voice.ts` 各 -150 行左右 | 中 | `realtime-voice.test.ts`、`live-voice.test.ts`、`realtime-local-commands.test.ts`、`id02-mac-fixes.test.ts` 不改；兩路事件序列 fixture 相同 |
| S11 | **核心兩路共用工具**：`recall_memory`／`delegate_task` 的核心處理合併成 `server/core-tools.ts`，`apikey-call.ts` 與 `live-tool-caller.ts` 都呼叫它；行事曆追問同理 | 3 檔 | 中 | `memory-apikey`、`memory-live`、`live-tool-caller`、`proactive-calendar` 測試不改 |
| S12 | **桌面不再複製 shared**：把 `settings-menu.mjs`／`preload.cjs` 複製的常數與文字表移到 `shared/*.mjs`＋`.d.mts`（沿用 `shared/i18n.mjs`、`identity-validate.mjs` 既有做法），`.ts` 端 re-export；刪掉「複本保持同步」測試 | `shared/` +3 檔、`desktop/` 3 檔、`shared/wake.ts` 等 | 中低 | `desktop-menu`、`desktop-i18n`、`wake-*` 測試；選單範本 JSON 相同 |
| S13 | **`app.ts` 其餘路由分組**：`server/routes/{realtime,alarms,home,auth,tasks,terminal,memories}.ts`＋`server/sse-hub.ts`（一處組 SSE 幀）；`app.ts` 只剩分派與靜態檔 | 分多個 PR，一組一個 | 中 | 每組對應的 HTTP 測試不改；路由順序用表固定並加測試 |
| S14 | **`src/main.ts` 分批抽出**（依耦合最低到最高，各一個 PR）：(a) `onServerEvent` → `src/server-events.ts`；(b) `handleCommand` → `src/command-router.ts`；(c) 即時語音編排與 `*FromRealtime` → `src/realtime-orchestrator.ts`；(d) 鏡頭生命週期 → `src/camera-lifecycle.ts`；(e) 喚醒生命週期 → `src/wake-lifecycle.ts`；(f) 設定套用 → `src/apply-settings.ts`。先做 S2 與 P3-10 的 DOM 測試基礎（評估 happy-dom 加入 devDependencies，鎖版本） | `main.ts` 4,211 → 目標 1,500 以下 | 中高 | 每步跑六支 `scripts/verify-*.mjs` 瀏覽器腳本＋新增的模組測試；畫面截圖在無頭 Chromium 比對 |

不在計畫內：Python 核心、Tauri、monorepo（`docs/07` §2）仍是規劃；任何權限或安全強化（CLAUDE.md 2026-10-31 優先順序）；功能行為更動；`server/memory/service.ts`（2,613 行）與 `identity-service.ts`（1,684 行）這兩個檔雖大但 importer 集中、有完整 fixture 測試，先不動，等 MEM／ID 的 Mac gate 過了再評估。

## 4. 待 George 決定

1. 是否同意 §3 的順序？建議至少先放行 S1–S5（文件、守門測試、改名、兩個 helper），這五步都不碰行為。
2. S3 的新名字：`shared/menu-prefs.ts`，或你偏好別的？
3. S14 要不要為頁面測試加 `happy-dom`（devDependency，鎖版本）？不加也能拆，但每步只能靠瀏覽器腳本回歸。
4. 兩個大檔 `memory/service.ts`、`identity-service.ts` 要不要排進來？目前建議先不要。

## 5. 與正式規格的關係

本文不改 `docs/06`、`docs/07` 的產品規則與 G0–G3 gate，也不把任何「待實作」改成完成。`docs/08` 仍是歷史快照。S1 只讓文件說出程式現在真的有什麼、驗過什麼；沒有實機證據的項目維持「fixture」或「未驗證」。
