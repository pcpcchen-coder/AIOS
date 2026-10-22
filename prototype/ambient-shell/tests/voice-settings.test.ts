import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceSettingsStore } from "../server/voice-settings.ts";

function make(dir: string) {
  const logs: string[] = [];
  let changes = 0;
  const store = new VoiceSettingsStore({ dir, onChange: () => changes++, log: (m) => logs.push(m) });
  return { store, logs, changes: () => changes };
}

describe("VoiceSettingsStore", () => {
  it("defaults without a file; saved values override; survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    const a = make(dir);
    expect(a.store.view()).toEqual({ voice_idle_s: 90, realtime_idle_s: 120 });
    expect(a.store.update({ realtime_idle_s: 300 })).toEqual({ voice_idle_s: 90, realtime_idle_s: 300 });
    expect(a.changes()).toBe(1);
    expect(make(dir).store.view()).toEqual({ voice_idle_s: 90, realtime_idle_s: 300 });
  });

  it("writes only the changed keys with mode 0600 and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    const { store, changes } = make(join(dir, "nested"));
    store.update({ voice_idle_s: 60 });
    const file = join(dir, "nested", "voice.json");
    const first = readFileSync(file, "utf8");
    expect(JSON.parse(first)).toEqual({ schema_version: 1, prefs: { voice_idle_s: 60 } });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    store.update({ voice_idle_s: 60 });
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(changes()).toBe(2);
  });

  it("a saved value within the step tolerance is read back on the grid", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    writeFileSync(join(dir, "voice.json"), JSON.stringify({ schema_version: 1, prefs: { voice_idle_s: 90.000001 } }));
    expect(make(dir).store.view().voice_idle_s).toBe(90);
  });

  it("drops only the invalid saved keys and logs them", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    writeFileSync(join(dir, "voice.json"), JSON.stringify({ schema_version: 1, prefs: { voice_idle_s: 95, realtime_idle_s: 180, made_up: 1 } }));
    const { store, logs } = make(dir);
    expect(store.view()).toEqual({ voice_idle_s: 90, realtime_idle_s: 180 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("2 項設定被忽略");
  });

  it.each([
    ["not JSON", "not json"],
    ["wrong schema_version", JSON.stringify({ schema_version: 2, prefs: { voice_idle_s: 60 } })],
    ["prefs not an object", JSON.stringify({ schema_version: 1, prefs: [60] })],
  ])("an unreadable file (%s) falls back to the defaults and logs why", (_name, content) => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    writeFileSync(join(dir, "voice.json"), content);
    const { store, logs } = make(dir);
    expect(store.view()).toEqual({ voice_idle_s: 90, realtime_idle_s: 120 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("語音閒置秒數用預設值");
  });

  it("a failed write leaves memory and onChange untouched, throws, and leaves no .tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-voice-"));
    const { store, changes } = make(dir);
    store.update({ voice_idle_s: 60 });
    rmSync(join(dir, "voice.json"));
    mkdirSync(join(dir, "voice.json", "x"), { recursive: true });
    expect(() => store.update({ voice_idle_s: 30 })).toThrow();
    expect(store.view().voice_idle_s).toBe(60);
    expect(changes()).toBe(1);
    expect(readdirSync(dir)).toEqual(["voice.json"]);
  });
});
