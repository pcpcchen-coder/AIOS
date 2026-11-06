<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-google-2026-11-06.md) | [English](memories-google-2026-11-06.en.md)

# Memories mode MEMO-2: Google Photos source (2026-11-06)

This follows [MEMO-1](memories-mode-2026-11-06.en.md). On 2026-11-06 George chose "both": MEMO-1 is a local folder on the Mac, and this batch adds Google Photos. The MEMO-1 document has the official Google limits (checked 2026-11-06). In short, third-party apps cannot read existing albums or keep them in sync. The only path is the **Google Photos Picker API**, where the user picks a batch each time.

## Flow

1. Mac menu bar "Memories" → "Pick from Google Photos…": the core creates a picking link and the Mac opens it in the system browser. On the Pi (or Mac) page, "Settings" → "Memories" → "Pick from Google Photos…": the page shows a QR code and the URL to scan with a phone.
2. In Google's picker, search for the album title, select photos and videos, and press Done. Up to 300 items per pick.
3. The core checks every 3–30 s (Google's suggested interval). Once picking is done it lists the items, downloads each into the Mac cache, and then deletes that picking session.
4. The memories slideshow uses both the local folder and the Google cache.

| Phase | Meaning |
|---|---|
| `idle` | No pick in progress |
| `starting` | Creating the picking link |
| `waiting_pick` | Waiting for the user to pick (shows the QR code, URL and expiry time) |
| `downloading` | Downloading ("Downloading 3/10") |
| `done` | Finished (items handled and skipped) |
| `failed` | Failed (fixed explanation text, never gog's output) |
| `cancelled` | Cancelled by the user |

## Authorization and data

- Uses the repo's existing `gog` (github.com/steipete/gogcli, MIT; `photos picker create/get/list/download/delete` in main `e8428c3`, 2026-11-05). gog keeps OAuth and the refresh token in the Mac keychain. Nous never reads or stores any Google token.
- Before first use, run once on the Mac: `gog auth add your-account --services photospicker` (minimal scope `photospicker.mediaitems.readonly`). Without it the screen shows 「無法建立 Google 相簿挑選連結（可能尚未授權）：在 Mac 執行 gog auth add 帳號 --services photospicker」 ("Could not create a Google Photos picking link (perhaps not authorized yet): run gog auth add account --services photospicker on the Mac").
- The account comes from `NOUS_GOG_ACCOUNT` (or `NOUS_MAIL_SELF` when missing); the gog path from `NOUS_GOG_PATH` or the Homebrew defaults. `NOUS_AIL` is not required.
- gog runs without a shell; stderr is always discarded; stdout (which contains baseUrls and the picking link) is never logged.
- Settings data gives pages only state and counts, the picking link (while waiting) and its expiry. It never includes the account, file paths or baseUrls. Google item ids are stored on disk only as hashes.
- The Pi fetches photos only through the Mac core and never connects to Google directly. Photos are never sent to any model.

## Cache

- Location: `~/.config/nous/memories/google/` (0700). `index.json` records each item (hash, file name, kind, time taken, time picked, size) and is written atomically.
- 2 GB cap: when exceeded, the earliest-picked items are deleted first (never the one just added). Re-picking the same item does not download it again.
- Clearing: the settings page "Clear Google cache" (press again to confirm), or the menu bar "Clear Google cache…" (native confirm dialog). It cancels any pick in progress first.
- Photos: gog only downloads originals (`=d`), and iPhone originals are usually HEIC, which neither browsers nor the Pi can show. On the Mac, the built-in `sips` converts them to JPEG at quality 85 with a 2048 px long side, which is also lighter for the Pi to decode. Without sips (non-macOS) or when conversion fails, the original is checked as is, and formats browsers cannot show are skipped.
- Videos: `=dv` (Google's transcoded version); videos not yet processed (not READY) are skipped.
- The format is decided only from the file's first bytes, never from Google's mimeType.
- Photos downloaded from Google have no location (official docs: `=d` excludes location), so the caption has only the time, for example 「三年前」 ("3 years ago"). The time comes from Google's `createTime`.

## Tests

| Test file | Coverage | Result |
|---|---|---|
| `tests/memories-google.test.ts` | Fake gog and fake clock (mock): the full flow, polling clamped to 3–30 s, timeout, the authorization hint on create failure, video not ready / download failure / HEIC skipped, HEIC converted to JPEG and kept when a converter exists, sips arguments, cancel while waiting and while downloading (the abort reaches gog, the session is deleted), a second pick rejected while busy, gog arguments (no shell, `--account=`, `--json`, `--max-items=300`), re-picks not downloaded again; cache cap, clear, a corrupt index, ids not colliding with folder ids, no raw ids or URLs in the index; HTTP routes | 22 passed |
| `tests/memories-menu.test.ts` | The Google section in the menu bar and settings page, no Chinese left in English, the Pi page without `nousDesktop` has the QR code and buttons, cache size reads the same in the menu and page | 19 passed |

Overall: `npm run typecheck` passed; `npx vitest run` 153 files, 2836 passed, 5 skipped; `npm run build` passed.

### Cloud browser check (mock gog)

The core used a shell script that imitates gog's output (mock, no Google connection). Headless Chromium opened `?terminal=rpi4` (the same as the Pi page) → "Settings" → "Pick from Google Photos…":

- A QR code (200×200) and the URL appeared. After simulating "picking done", the status read "2 photos, 0 videos" and "2 handled, 0 skipped".
- `/api/memories/items` gained 2 photos with a time and no place; the cache folder held 2 `.jpg` files and `index.json`.
- Found and fixed: a cache of a few hundred KB showed as "0 MB"; under 10 MB it now keeps one decimal.

This is not a check against a real Google account or Mac. Real gog output, Google's picker screen, HEIC conversion through sips and download speed have not been tried.

## Mac test steps

1. Check that `gog --version` runs and that `.env` has `NOUS_GOG_ACCOUNT`.
2. In a Mac terminal run `gog auth add your-account --services photospicker` and finish authorization in the browser.
3. Restart the App. The menu bar "Memories" section should show "Google Photos: 0 photos…" and "Pick from Google Photos…".
4. Choose "Pick from Google Photos…": the browser opens Google's picker. Search for an album title, pick 10 items (including iPhone photos and one video), and press Done.
5. The menu bar should show "Downloading N/10" and then finish. `~/.config/nous/memories/google/` should contain `.jpg` files (iPhone HEIC converted) and the video.
6. Repeat from the Pi page "Settings" → "Memories", scanning the QR code with a phone.
7. Turn memories mode on and stay idle for 60 s: Google photos appear in the slideshow with only the time below.
8. "Clear Google cache": the folder empties and the slideshow keeps only the local folder.

## Rollback

- Turning memories mode off returns to the normal brain.
- Clear the Google cache with the settings page or menu bar button, or delete `~/.config/nous/memories/google/`.
- Revoke Google access: remove gog under "Third-party apps & services" in the Google account, or run `gog auth remove your-account` on the Mac (deletes the refresh token gog stored).

## Not done

- Tests with a real Google account, gog and Mac; Pi hardware.
- When the cache is cleared, the item currently playing may get a 404 until the list is read again (the next item plays normally).
- Picks add to the existing collection; there is no "replace with this pick only" option.
