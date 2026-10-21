import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CameraSettingsStore } from "../server/camera-settings.ts";
import { loadConfig } from "../server/config.ts";

function make(dir: string, env: NodeJS.ProcessEnv = { NOUS_CAMERA: "on" }) {
  const logs: string[] = [];
  let changes = 0;
  const store = new CameraSettingsStore({
    base: loadConfig(env).camera,
    dir,
    onChange: () => changes++,
    log: (m) => logs.push(m),
  });
  return { store, logs, changes: () => changes };
}

describe("CameraSettingsStore", () => {
  it("precedence: saved > .env > table default; install fields always from .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    const a = make(dir, { NOUS_CAMERA: "on", NOUS_LOOK_TO_TALK: "off" });
    expect(a.store.view()).toMatchObject({ enabled: true, active: true, look_to_talk: false, look_to_talk_s: 1.5, look_to_talk_cooldown_s: 10 });
    a.store.update({ look_to_talk: true });
    expect(a.store.view().look_to_talk).toBe(true);
    expect(a.changes()).toBe(1);

    const b = make(dir, { NOUS_CAMERA: "off", NOUS_LOOK_TO_TALK: "off", NOUS_CAMERA_LABEL: "Other" });
    expect(b.store.view()).toMatchObject({ enabled: false, label: "Other", look_to_talk: true });
  });

  it("writes only the changed keys and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    const { store, changes } = make(join(dir, "nested"));
    store.update({ stop_gesture: false });
    const file = join(dir, "nested", "camera.json");
    const first = readFileSync(file, "utf8");
    expect(JSON.parse(first)).toEqual({ schema_version: 1, prefs: { stop_gesture: false } });
    store.update({ stop_gesture: false });
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(changes()).toBe(2);
  });

  it("ignores a malformed, out-of-range or wrong-version file with a log line", () => {
    for (const content of ["not json", JSON.stringify({ schema_version: 2, prefs: {} }), JSON.stringify({ schema_version: 1, prefs: { look_to_talk_s: 99 } })]) {
      const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
      writeFileSync(join(dir, "camera.json"), content);
      const { store, logs } = make(dir);
      expect(store.view()).toMatchObject({ active: true, look_to_talk_s: 1.5 });
      expect(logs).toHaveLength(1);
    }
  });
});
