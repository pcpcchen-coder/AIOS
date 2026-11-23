<!-- bilingual: source=zh-TW -->

> [繁體中文](voice-volume-2026-11-07.md) | [English](voice-volume-2026-11-07.en.md)

# Voice volume VOL-1 (2026-11-07)

George asked on 2026-11-07 for voice control of the conversation volume, either on the eMeet or through the system volume.

## What was done

- **It changes how loud Nous speaks.** The page element that plays the AI voice (shared by both realtime routes) gets its `volume` from the "voice volume": 100 equals the system volume and 10 is the minimum.
  - It does not change the system volume or the eMeet's own volume. A web page cannot change the Pi's system volume; that would need a local service in the Pi kit, which this batch does not add.
  - It does not touch capture, wake listening, earcons or the sonar cue.
- **By voice.** A new realtime tool, `set_voice_volume`, is available on both routes:
  - API key route: the model calls it directly.
  - ChatGPT-plan route: the voice layer delegates, the tool caller calls it, and the page executes it.
  - Arguments: `change` (`up`/`down` by 20, `reset` back to 100) or `level` (10–100). When `level` is given, it wins.
  - The result is `confirmed` with the real `volume`, and a caption 「對話音量：N」 ("Voice volume: N") is shown.
  - A `note` is added when the value is clamped. At the maximum it says to raise the system or speaker volume for louder; at the minimum it says the voice is never fully muted.
- **Kept apart from appliances.** "Louder", "quieter" or "volume 60" without a device name mean Nous's voice. Naming a device (for example 「電視大聲一點」, "TV louder") goes to `home_control`.
  - The appliance rule's example 「大聲一點」 became 「電視大聲一點」.
  - Without a home controller, the rule does not mention the appliance tools.
- **Each device remembers its own value.** It is stored in the page's `localStorage` (`nous.voice-volume.v1`), one for the Mac main window and one for the Pi terminal, and is not sent to the core.
  - An unreadable value or blocked storage means 100.
  - A failed save only affects the next launch; this session still plays at the chosen volume.
- **Settings page.** A new "Voice volume on this device" section shows "Now N" plus three buttons, "Quieter", "Louder" and "Reset to default". It is the same setting as the voice command.
  - At a limit, the matching button is disabled.
  - It appears in both the browser and the App versions, in Chinese and English.
- The voice command table (README, Chinese and English) has a new row.

## Known limits

- **The maximum is the system volume.** To go louder than today, set the Pi's system volume (the eMeet) to maximum once, then adjust by voice within that range.
- **On the ChatGPT-plan route a volume change is also a delegation.** It uses Codex quota and is a little slower than on the API key route.
- **Voice control works only during realtime voice.** System speech in "voice mode" is not affected by this setting.

## Tests

- `tests/voice-volume.test.ts` (14 tests):
  - Rules: steps of 20, clamping to 10–100, limit flags, `level` taking priority, refusal without arguments.
  - Argument parsing and the output given to the model.
  - Page state: default 100, load and save, immediate apply to attached players, no changes after a player stops, playback still works when storage throws.
  - Tool lists and timeout on both routes.
  - Speaking rule: no `home_` without a controller.
  - Shared tool executor, settings buttons and their disabled states, English catalog.
- **Existing tests updated on purpose:**
  - `tests/realtime-bridge.test.ts`: the tool list now includes `set_voice_volume`.
  - `tests/apikey-route.test.ts`: the 658b97a baseline snapshot file is **not edited**. The comparison inserts this deliberate tool and rule, and everything else must still match byte for byte.
- `npm run typecheck`, `npx vitest run` (161 files, 2993 passed, 5 skipped), `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Not yet verified

- Changing the volume by voice has not been tried on a real Mac or Pi.
- To check:
  1. On the Pi, say 「你講話小聲一點」 ("speak more quietly"); the next reply is quieter and the caption shows "Voice volume: 80".
  2. Say 「音量 40」 then 「大聲一點」; the volume becomes 60.
  3. After reloading the page it is still 60.
  4. 「電視大聲一點」 presses the TV's remote key instead of changing Nous.
  5. The Mac's volume is not affected by the Pi.
