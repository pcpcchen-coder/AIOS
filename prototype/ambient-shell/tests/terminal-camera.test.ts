import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_PREFS, type CameraPrefs } from "../shared/sense.ts";
import type { SettingsView } from "../shared/types.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import { cameraShouldRun } from "../src/sense/controller.ts";
import { startTerminalHeartbeat } from "../src/terminal-heartbeat.ts";
import { TERMINAL_HEARTBEAT_MS } from "../shared/terminal.ts";
import { TERMINAL_CAMERA_KEY, TERMINAL_CAMERA_SAVE_ERROR, TERMINAL_CAMERA_STOP_ERROR, TerminalCameraPrefs } from "../src/terminal-camera.ts";

function source(prefs: Partial<CameraPrefs> = {}): SettingsView {
  return {
    schema_version: "proto-0.1",
    provider: "mock",
    providers: [],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
    camera: {
      enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 140,
      ...DEFAULT_CAMERA_PREFS, ...prefs, enable_via: "app",
    },
    voice: { ...DEFAULT_VOICE_PREFS },
  };
}

class Storage {
  value: string | null = null;
  failRead = false;
  failWrite = false;
  getItem(key: string): string | null {
    expect(key).toBe(TERMINAL_CAMERA_KEY);
    if (this.failRead) throw new Error("blocked");
    return this.value;
  }
  setItem(key: string, value: string): void {
    expect(key).toBe(TERMINAL_CAMERA_KEY);
    if (this.failWrite) throw new Error("full");
    this.value = value;
  }
}

function terminal(storage = new Storage(), search = "?terminal=rpi4", desktop = false) {
  return { owner: new TerminalCameraPrefs({ search, desktop, storage: () => storage }), storage };
}

describe("terminal camera ownership", () => {
  it.each(["", "?terminal=other", "?terminal=RPI4", "?terminal=rpi4&terminal=other", "?terminal=rpi4&terminal=rpi4"])("leaves shared-page settings untouched for %s", (search) => {
    const { owner, storage } = terminal(undefined, search);
    storage.failRead = true;
    const remote = source({ active: true });
    expect(owner.local).toBe(false);
    expect(owner.receive(remote)).toBe(remote);
    expect(storage.value).toBeNull();
  });

  it("never selects terminal ownership in the desktop main window", () => {
    const { owner } = terminal(undefined, "?terminal=rpi4", true);
    const remote = source({ active: true });
    expect(owner.local).toBe(false);
    expect(owner.receive(remote)).toBe(remote);
  });

  it("starts off and ignores later global activation and preferences", () => {
    const { owner } = terminal();
    expect(owner.receive(source({ active: true, look_to_talk: false })).camera).toMatchObject({ active: false, look_to_talk: false, enable_via: "page" });
    const updated = owner.receive(source({ active: true, look_to_talk: true, stop_gesture: false }));
    expect(cameraShouldRun(updated.camera, false, false)).toBe(false);
    expect(updated.camera?.look_to_talk).toBe(false);
    expect(updated.camera?.stop_gesture).toBe(DEFAULT_CAMERA_PREFS.stop_gesture);
  });

  it("keeps local activation through GET/SSE refreshes without changing their source", () => {
    const { owner, storage } = terminal();
    const remote = source({ active: false });
    Object.freeze(remote.camera);
    Object.freeze(remote);
    owner.receive(remote);
    const result = owner.update({ active: true, look_to_talk_s: 3, stop_gesture: false });
    expect(result.error).toBeNull();
    expect(cameraShouldRun(result.settings.camera, false, false)).toBe(true);
    expect(remote.camera?.active).toBe(false);
    expect(result.settings.camera).toMatchObject({ look_to_talk_s: 3, stop_gesture: false });
    expect(owner.receive(source({ active: false, look_to_talk_s: 1.5, stop_gesture: true })).camera).toMatchObject({ active: true, look_to_talk_s: 3, stop_gesture: false });
    const reopened = terminal(storage).owner;
    expect(reopened.receive(source({ active: false })).camera).toMatchObject({ active: true, look_to_talk_s: 3, stop_gesture: false });
  });

  it("persists off so a page reload cannot inherit Mac activation", () => {
    const { owner, storage } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    owner.update({ active: false });
    expect(terminal(storage).owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it("keeps installation fields and the core camera gate read-only", () => {
    const { owner } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    const remote = source({ active: true });
    remote.camera = { ...remote.camera!, enabled: false, label: "New CCB Camera", screen_width_mm: 500 };
    expect(owner.receive(remote).camera).toMatchObject({ enabled: false, active: false, label: "New CCB Camera", screen_width_mm: 500 });
    expect(() => owner.update({ enabled: true } as never)).toThrow();
  });

  it("recomputes menu values and preview availability from the Pi settings", () => {
    const { owner } = terminal();
    const remote = source({ active: true, look_to_talk_s: 1.5 });
    remote.camera_preview_disabled_reason = null;
    expect(owner.receive(remote).camera_preview_disabled_reason).toBeTruthy();
    const { settings } = owner.update({ active: true, look_to_talk_s: 3 });
    expect(settings.camera_preview_disabled_reason).toBeNull();
    expect(settings.seconds?.find((row) => row.key === "look_to_talk_s")?.value).toBe(3);
    expect(settings.seconds?.find((row) => row.key === "active")?.value).toBe(true);
  });

  it("updates against the latest raw source rather than a stale projected copy", () => {
    const { owner } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    const next = source();
    next.provider = "chatgpt";
    next.camera!.label = "Replacement Camera";
    owner.receive(next);
    const result = owner.update({ look_to_talk: false });
    expect(result.settings.provider).toBe("chatgpt");
    expect(result.settings.camera).toMatchObject({ label: "Replacement Camera", active: true, look_to_talk: false });
    expect(next.camera?.active).toBe(DEFAULT_CAMERA_PREFS.active);
  });
});

describe("terminal camera persistence errors", () => {
  it.each([{ active: "true" }, { look_to_talk_s: 100 }, { unknown: true }])("rejects a malformed full saved record without granting capture: %s", (invalid) => {
    const { owner, storage } = terminal();
    storage.value = JSON.stringify({ version: 1, prefs: { ...DEFAULT_CAMERA_PREFS, active: true, ...invalid } });
    expect(owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it.each(["broken", "null", '{"version":2,"prefs":{"active":true}}', '{"version":1,"prefs":{"active":true}}'])("cannot activate from an invalid saved record: %s", (value) => {
    const { owner, storage } = terminal();
    storage.value = value;
    expect(owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it("starts off when reading storage is unavailable", () => {
    const { owner, storage } = terminal();
    storage.failRead = true;
    expect(owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it("does not activate when the local opt-in cannot be saved", () => {
    const { owner, storage } = terminal();
    owner.receive(source());
    storage.failWrite = true;
    const result = owner.update({ active: true });
    expect(result.error).toBe(TERMINAL_CAMERA_SAVE_ERROR);
    expect(result.settings.camera?.active).toBe(false);
    expect(owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it("keeps a failed disable stopped across broadcasts and changes until explicit enable", () => {
    const { owner, storage } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    storage.failWrite = true;
    const stopped = owner.update({ active: false });
    expect(stopped.error).toBe(TERMINAL_CAMERA_STOP_ERROR);
    expect(cameraShouldRun(stopped.settings.camera, false, false)).toBe(false);
    expect(owner.receive(source({ active: true })).camera?.active).toBe(false);
    expect(owner.update({ stop_gesture: false }).settings.camera?.active).toBe(false);
    expect(owner.update({ active: true }).settings.camera?.active).toBe(false);
    storage.failWrite = false;
    expect(owner.update({ active: true }).settings.camera?.active).toBe(true);
  });

  it("can save a previously failed stop on the next preference change", () => {
    const { owner, storage } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    storage.failWrite = true;
    owner.update({ active: false });
    storage.failWrite = false;
    const result = owner.update({ look_to_talk: false });
    expect(result.error).toBeNull();
    expect(terminal(storage).owner.receive(source({ active: true })).camera?.active).toBe(false);
  });

  it("never exposes stale camera settings while the core has no camera configuration", () => {
    const { owner } = terminal();
    owner.receive(source());
    owner.update({ active: true });
    const remote = source();
    delete remote.camera;
    expect(owner.receive(remote)).toBe(remote);
    expect(() => owner.update({ active: true })).toThrow();
  });
});


describe("terminal camera and service heartbeat compatibility", () => {
  it("keeps reporting the Pi while its independent camera changes", () => {
    const search = "?terminal=rpi4";
    const { owner } = terminal(undefined, search);
    const remote = source({ active: false });
    const sent: string[] = [];
    let beat = () => {};
    let cancelled = false;
    const stop = startTerminalHeartbeat({
      desktop: false,
      search,
      send: async (id) => { sent.push(id); },
      every: (run, ms) => {
        expect(ms).toBe(TERMINAL_HEARTBEAT_MS);
        beat = run;
        return () => { cancelled = true; };
      },
    });
    owner.receive(remote);
    expect(owner.update({ active: true }).settings.camera?.active).toBe(true);
    beat();
    expect(owner.receive(source({ active: false })).camera?.active).toBe(true);
    expect(owner.update({ active: false }).settings.camera?.active).toBe(false);
    beat();
    expect(sent).toEqual(["rpi4", "rpi4", "rpi4"]);
    expect(remote.camera?.active).toBe(false);
    expect(cancelled).toBe(false);
    stop!();
    expect(cancelled).toBe(true);
  });

  it("never makes the Mac window a terminal camera owner or heartbeat sender", () => {
    const { owner } = terminal(undefined, "?terminal=rpi4", true);
    const remote = source({ active: true });
    const sent: string[] = [];
    expect(startTerminalHeartbeat({ desktop: true, search: "?terminal=rpi4", send: async (id) => { sent.push(id); } })).toBeNull();
    expect(owner.receive(remote)).toBe(remote);
    expect(owner.local).toBe(false);
    expect(sent).toEqual([]);
  });
});
