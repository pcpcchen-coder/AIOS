import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps each valid saved key and drops only the bad ones (a bad key never turns the camera back on)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    const prefs = { active: false, look_to_talk_s: 99, stop_gesture: false, made_up: 1, look_to_talk_cooldown_s: 3 };
    writeFileSync(join(dir, "camera.json"), JSON.stringify({ schema_version: 1, prefs }));
    const { store, logs } = make(dir);
    expect(store.view()).toMatchObject({ active: false, look_to_talk_s: 1.5, stop_gesture: false, look_to_talk_cooldown_s: 3 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("2 項設定被忽略");
    expect(logs[0]).toContain("made_up");
    expect(logs[0]).toContain("look_to_talk_s");
  });

  it("an invalid saved active value keeps the camera off", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    writeFileSync(join(dir, "camera.json"), JSON.stringify({ schema_version: 1, prefs: { active: "no", look_to_talk: false } }));
    const { store, logs } = make(dir);
    expect(store.view()).toMatchObject({ active: false, look_to_talk: false });
    expect(logs).toHaveLength(1);
  });

  it.each([
    ["not JSON", "not json"],
    ["JSON null", "null"],
    ["wrong schema_version", JSON.stringify({ schema_version: 2, prefs: { active: true } })],
    ["missing schema_version", JSON.stringify({ prefs: { active: true } })],
    ["prefs not an object", JSON.stringify({ schema_version: 1, prefs: [true] })],
  ])("a file that exists but cannot be understood (%s) keeps the camera off and logs why", (_name, content) => {
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    writeFileSync(join(dir, "camera.json"), content);
    const { store, logs } = make(dir);
    expect(store.view()).toMatchObject({ active: false, look_to_talk_s: 1.5, stop_gesture: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("鏡頭保持關閉");
  });

  it("a failed write leaves memory and onChange untouched and throws", () => {
    // 父路徑是一般檔案：mkdir 失敗（root 也一樣，不靠權限）。
    const parent = mkdtempSync(join(tmpdir(), "nous-camera-"));
    const blocker = join(parent, "not-a-dir");
    writeFileSync(blocker, "");
    const a = make(join(blocker, "nous"));
    expect(() => a.store.update({ active: false })).toThrow();
    expect(a.store.view().active).toBe(true);
    expect(a.changes()).toBe(0);

    // camera.json 被一個目錄佔住：rename 失敗，不留下 .tmp。
    const dir = mkdtempSync(join(tmpdir(), "nous-camera-"));
    const b = make(dir);
    b.store.update({ look_to_talk_s: 2 });
    rmSync(join(dir, "camera.json"));
    mkdirSync(join(dir, "camera.json", "x"), { recursive: true });
    expect(() => b.store.update({ active: false })).toThrow();
    expect(b.store.view()).toMatchObject({ active: true, look_to_talk_s: 2 });
    expect(b.changes()).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["camera.json"]);
  });
});
