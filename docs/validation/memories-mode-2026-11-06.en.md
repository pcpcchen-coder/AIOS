<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-mode-2026-11-06.md) | [English](memories-mode-2026-11-06.en.md)

# Memories mode MEMO-1 (2026-11-06)

George's request (2026-11-06): a "Memories mode" switch in settings. When the brain has no assigned work, photos and videos emerge from the brain and rotate. Waking, looking-to-talk, assigning a task or starting a call collapses them at once. Photos with a time and place show text such as "3 years ago in Hsinchu". Both the Mac App and the Pi page must be able to switch it and show it.

This batch (MEMO-1) builds the state machine, the animation, the time-and-place text, the settings and **a local folder source on the Mac**. The Google Photos source (Picker) is the next batch, MEMO-2.

## Defaults George chose (2026-11-06)

| Item | Default | Options |
|---|---|---|
| Photo source | Both: MEMO-1 local folder, MEMO-2 Google Picker | — |
| Time per photo | 8 s | 5, 8, 12, 20 s |
| Idle time before starting | 60 s | 30 s, 1, 3, 5 min |
| Video sound | Muted | Can be turned on in settings |
| Local cache cap | 2 GB (`MEMORIES_CACHE_CAP_BYTES`, used from MEMO-2) | — |
| Memories mode master switch | Off (`enabled: false`) | Menu bar, settings page |

## Google Photos official limits (checked 2026-11-06)

| Item | What the official docs say | Source |
|---|---|---|
| Library API | After 2025-03-31, `photoslibrary.readonly`, `photoslibrary.sharing` and `photoslibrary` are removed; apps can only list and read albums and media "created by your app" | https://developers.google.com/photos/support/updates |
| Picker API scope | `photospicker.mediaitems.readonly` | https://developers.google.com/photos/picker/guides/media-items |
| Picking a whole album | Not directly. The picker does not list albums directly, but users can search by album title and pick items. Up to 2000 items per session | https://developers.google.com/photos/picker/guides/picking-experience , https://developers.google.com/photos/picker/reference/rest/v1/sessions |
| Continuous sync | None. After Done the `pickerUri` stops working; adding photos needs a new session and a new pick | https://developers.google.com/photos/picker/guides/sessions |
| baseUrl | Valid 60 minutes, fetch needs an OAuth bearer token; photos use `=wW-hH` or `=d` (with Exif, **location removed**), videos use `=dv` | https://developers.google.com/photos/picker/guides/media-items |
| Picking on another device | Show the URL or a QR code for the user to scan on a phone; `/autoclose` is not for cross-device; no iframes | https://developers.google.com/photos/picker/guides/get-started-picker |
| Local caching | Not explicitly prohibited by the policy (inferred); honor user deletion requests and keep tokens encrypted | https://developers.google.com/photos/support/api-policy |
| Ambient API (photo frames, continuous album display) | Partner program only; not available to general developers | https://developers.google.com/photos/partner-program/overview |
| The repo's `gog` tool | `photos` only reads app-created content; `photos picker` has create/get/wait/list/download/delete (gogcli main, 2026-11-05) | https://github.com/steipete/gogcli |

Conclusion: the official path cannot do "a chosen album, kept in sync". George chose both sources: a local folder (for example a Mac Photos export) and Google Picker (pick a batch, cache it on the Mac, pick again for new photos). Photos downloaded from Google have no location, so the Google source shows only the time.

## Design

### State machine (`shared/memories.ts`)

| Condition (in order) | Result |
|---|---|
| Off, or disconnected from the core | `off` |
| The brain is busy | `busy` (countdown stops) |
| Just became idle | `waiting`, countdown starts now |
| Has photos and idle for `idle_s` | `showing` |
| Otherwise | `waiting` |

"Busy" (`memoriesBusy` in `src/main.ts`): a running or queued task, a realtime voice call in progress or starting, voice conversation on, capturing audio, waiting for a reply, background processing, an open Surface, the input bar open, Nous speaking, or the camera seeing someone face the screen.

"Wake" (`wakeMemories`, collapses at once and restarts the countdown from that moment): the wake word fires, the camera detects facing (look-to-talk), realtime voice starts, any Surface change (assigning a task, opening progress or settings…), submitting text, or tapping the photo. After all work and calls end, memories return only after another `idle_s` of idle time.

### Source (`server/memories.ts`)

- Folder: `NOUS_MEMORIES_DIR`, default `~/.config/nous/memories/library` (the core creates it with 0700 at startup). Only the environment decides the path; pages cannot name arbitrary paths.
- Photos `.jpg .jpeg .png .webp .gif .avif` (up to 30 MB), videos `.mp4 .m4v .webm .mov` (up to 200 MB); reads one level of subfolders; skips hidden files and links pointing outside the folder; rescans at most every 60 s.
- Pages only get an opaque id, the kind, a URL, the time taken and a city name. File paths and coordinates never leave the core. Photos are not sent to any model.
- `GET /api/memories/items`, `GET/HEAD /api/memories/media/<id>` (single Range, needed for video), `POST /api/settings/memories` (`memories.json`).

### Time and place text (`server/memories-meta.ts`, `memoryCaption`)

- Photos: JPEG EXIF DateTimeOriginal (DateTime when missing), reading only the first 256 KB; GPS latitude and longitude.
- Videos: mp4/mov `mvhd` creation time (0 means none); location from `©xyz` when present.
- Place: the core finds the nearest city in a fixed table (the 12 weather cities plus 10 more) and uses it only within 25 km. No network.
- Text: Today, This week, N weeks ago, N months ago, Last year, N years ago; the same month and day gives "N years ago today". Chinese uses Chinese numerals up to ten (「兩年前」, 「三年前」). With a place it adds "in Hsinchu"; place only gives "In Hsinchu"; with neither there is no text. A future time (clock skew) shows no time.

### Animation spec (`src/memories.ts`, `src/style.css`)

| Stage | Time | Screen |
|---|---|---|
| Brain moves to the lower left | 1.2 s | The brain shrinks, moves to the lower-left corner and dims; the first photo waits until it arrives |
| Emerge | 1.4 s | The photo grows from the brain's position to the center (starting at scale 0.06, blur clearing) |
| Hold | `dwell_s` (default 8 s) | Very slow zoom 1 → 1.03; the text fades in 0.6 s after the emerge ends |
| Recede | 1.0 s | The text fades out first, then the photo shrinks back into the brain |
| Collapse (wake) | 0.25 s | Fades out immediately, video stops and its source is removed; the brain returns to its place and its real state |

- Photos are at most 86vw × 78vh, with rounded corners, a soft shadow and a faint cyan glow. Videos move on when they end or after 30 s, whichever comes first.
- `prefers-reduced-motion: reduce`: no scaling, movement or blur. The brain dims in place, photos only crossfade (0.4 s), and the text shows directly.
- Photos light no brain region and create no pulses: a photo is not vision processing, and brain animation stays driven only by real task and conversation events.
- While showing, `#memories` carries `data-visibility-reason="memories_idle"` (switched on and idle for the set time); without that reason it is not shown.

### Pi 4 performance

- At most one `<video>` at any time (the Pi 4 has headroom for one hardware decoder) and at most two photos (the current one and the next, pre-decoded with `img.decode()`).
- While showing, the brain uses the "light" render budget (12 fps, 0.75× resolution) and returns to the device's own performance setting on collapse.
- Local folder files are sent as they are, not resized. Exporting from Mac Photos as "Large" (about 2048 px on the long side) keeps Pi decoding lighter. iPhone HEVC `.mov` files may not play in Chromium on the Pi (inferred, not verified on a Pi); export H.264.
- The Pi page fetches photos from the Mac core over the SSH tunnel (same-origin `localhost`) and never connects to Google directly.

## Tests

| Test file | Coverage | Result |
|---|---|---|
| `tests/memories-state.test.ts` | State machine (fake clock): idle → memories, busy collapses, wake restarts, no photos never shows, off; every time-and-place branch in Chinese and English | 24 passed |
| `tests/memories-http.test.ts` | Settings read/write and 400, list, media, Range 206/416, bad id 404, no escaping the folder, no paths or coordinates in responses, 404 when not provided; synthetic EXIF/GPS JPEG and mvhd/©xyz mp4, the 25 km cutoff (mock fixture) | 13 passed |
| `tests/memories-presenter.test.ts` | Emerge → hold → recede → next (fake timers), video muted by default, never more than one `<video>`, collapse stops video at once, reduced motion | 9 passed |
| `tests/memories-menu.test.ts` | Menu bar items and patches, menu text equals shared text, no Chinese left in English, the settings page without `nousDesktop` has the section | 9 passed |

Overall: `npm run typecheck` passed; `npx vitest run` 152 files, 2801 passed, 5 skipped; `npm run build` passed; `node scripts/check-pstack.mjs`, `node scripts/verify-aios.mjs` and `git diff --check` passed.

### Cloud browser check (mock fixture)

Headless Chromium (1280×720) opened `?terminal=rpi4` (no `nousDesktop`, the same as the Pi page). The core ran the mock engine with a synthetic fixture folder (3 JPEGs and 1 video, each frame marked `MOCK FIXTURE`):

- After 30 s idle the page entered `showing`; the brain moved to the lower left; a photo emerged with the text 「三年前在新竹」 (EXIF 2023-08-12, GPS Hsinchu), and the next one read 「一年前的今天在台北」.
- `data-visibility-reason` was `memories_idle`.
- Tapping the photo: within 0.4 s the state was back to `waiting` and `#memories` was hidden.
- A VP9 `.webm` video: only one `<video>`, muted, playing.

This is not a Mac or Pi hardware check. Animation smoothness, Pi decoding load and real wake collapse were not measured on hardware.

## Mac / Pi test steps

1. Put photos and videos in `~/.config/nous/memories/library` on the Mac (or set `NOUS_MEMORIES_DIR` and restart the core).
2. Mac: menu bar "Memories mode" → turn on "Play memories when idle". Pi: page "Settings" → "Memories mode" → On. The status line should show the photo and video counts.
3. Do nothing for 60 s: the brain moves to the lower left, a photo emerges, holds 8 s, recedes, and the next one follows; photos with a time and place have text below.
4. Say "Hello Nous": the photo collapses at once and the brain returns to its place and starts the call. After the call, wait another 60 s and memories return.
5. With the camera on, face the screen: the photo collapses at once. Assign a task: it collapses at once and returns 60 s after the task finishes.
6. Pi: compare the frames per second shown in "This device's display performance" before and during memories; while a video plays, check temperature and throttling with `aios-doctor`.

## Rollback and clearing

- Turning off "Play memories when idle" (menu bar or settings page) returns to the normal brain. Nothing is deleted.
- MEMO-1 has no cache: photos stay in your own folder; delete files there to remove them. Settings live in `~/.config/nous/memories.json`; deleting it returns to the defaults (off).
- MEMO-2 adds the cache cap and a clear button together with the Google source.

## Not done

- MEMO-2: the Google Photos Picker source (minimal OAuth scope, token kept only in the Mac core, QR-code picking, downloaded cache with a 2 GB cap and clearing).
- A menu bar shortcut "Open memories folder".
- Local folder photos are not resized (large files decode slower on the Pi).
- Mac and Pi hardware checks.
