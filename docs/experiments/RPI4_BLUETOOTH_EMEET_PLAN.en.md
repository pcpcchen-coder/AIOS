<!-- bilingual: source=zh-TW -->

> [繁體中文](RPI4_BLUETOOTH_EMEET_PLAN.md) | [English](RPI4_BLUETOOTH_EMEET_PLAN.en.md)

# Connecting the Pi terminal to the eMeet M0 Plus over Bluetooth: plan (RPI-BT, not implemented)

Date: 2026-11-07. Status: **plan only; no code and no testing yet**. On 2026-11-07 George decided to record the plan now and do the work later.

## Background

- Today the Pi 4 terminal uses a USB cable to the eMeet M0 Plus (microphone and speaker), and it works. George wants to switch to Bluetooth later.
- The M0 Plus does not come with a USB Bluetooth receiver, so the Pi 4's built-in Bluetooth will be used.
- The code already handles "the chosen speaker disconnects, fall back to the system default, switch back when it returns" (`src/audio-devices.ts`), but this has not been verified over Bluetooth on the Pi.

## The key limitation

- To use both the microphone and the speaker over Bluetooth, only "call mode" (HFP) works. Both capture and playback drop to telephone quality:
  - wideband (mSBC, 16 kHz): fine for normal conversation;
  - narrowband (CVSD, 8 kHz): noticeably worse.
- **Which one the M0 Plus supports over Bluetooth is not known yet.** It must be measured on the Pi, not assumed.
- Possible effect: lower accuracy for the wake word "Hello Nous" and for voice recognition. A voiceprint has already failed after a microphone change (see the [Pi deployment field record](../validation/rpi-deployment-fixes-2026-11-05.en.md)), so after switching to Bluetooth the voice will probably need to be re-enrolled through the Bluetooth microphone.
- Bluetooth adds about 0.1–0.2 s of latency (estimate, not measured).
- The Pi 4's Bluetooth and Wi-Fi share one chip, so the network stays wired.

## Planned work (Pi terminal kit, `terminals/rpi4/`)

1. **Pairing script `aios-bt-pair`**
   - Pair the M0 Plus with `bluetoothctl` and mark it trusted so it reconnects after boot.
   - Keep it in call mode so the microphone works.
   - How to put the M0 Plus into pairing mode will be written from the product manual when this is implemented, not guessed from memory.
2. **Three new `aios-doctor` checks**, in the existing PASS/WARN/FAIL style:
   - whether the eMeet is connected over Bluetooth;
   - whether it is in a call mode that can capture;
   - whether it uses wideband or narrowband (narrowband is a WARN).
3. **Reconnect after boot**: add a small user service if needed.
4. **Fallback to wired**: if results are poor, plug the USB cable back in and the kit uses it without reinstalling. `uninstall.sh` must be able to remove the Bluetooth settings.
5. **Chinese and English docs**: install, troubleshooting and the field checklist below. The dry-run test gets fake `bluetoothctl`/`wpctl` commands.

## Field checklist (to run when implemented)

- Record: Pi OS version, audio stack (PipeWire/WirePlumber versions), actual codec (mSBC or CVSD).
- 30 minutes of realtime conversation: record dropouts and first-response latency.
- Disconnect and reconnect: switch the eMeet off and on three times; note how long recovery takes and whether the page returns to the device.
- Wake word through the Bluetooth microphone: 20 positive and 20 negative utterances, recording hits and false triggers; compare with wired.
- Voiceprint: back up the encrypted family data first, then re-enroll through the Bluetooth microphone and test recognition.
- Whether voice volume (VOL-1/VOL-2) still works with the Bluetooth speaker.
- Record each item explicitly as PASS / FAIL / NOT SUPPORTED.

## When to switch to Bluetooth for good

When the 30-minute conversation has no persistent dropouts, the wake word hit rate is not clearly lower than wired, and the re-enrolled voiceprint recognizes the person. If any of these fails, stay wired and record the results in this document.
