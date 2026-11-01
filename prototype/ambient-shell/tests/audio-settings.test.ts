import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioSettingsStore } from "../server/audio-settings.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { AudioPatchError, DEFAULT_AUDIO_PREFS, parseAudioPatch } from "../shared/audio-devices.ts";
import { parseWakePatch } from "../shared/wake.ts";
import type { SettingsView } from "../shared/types.ts";

// 聲音輸入／輸出裝置的偏好（configDir/audio.json，George 2026-11-01）：驗證、0600、讀不懂一律系統預設、
// wake.json 的舊 device_id 不搬（常駐聆聽跟著聲音輸入，預設＝系統預設）、HTTP 路由與 settings.updated。

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-audio-settings-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
  rmSync(root, { recursive: true, force: true });
});

describe("parseAudioPatch", () => {
  it("accepts the four keys with device ids (visible ASCII ≤ 256) and labels (≤ 128, no control characters), or null", () => {
    expect(parseAudioPatch({ input_device_id: "abc123", input_label: "MacBook Pro 麥克風" })).toEqual({ input_device_id: "abc123", input_label: "MacBook Pro 麥克風" });
    expect(parseAudioPatch({ output_device_id: null, output_label: null })).toEqual({ output_device_id: null, output_label: null });
    for (const bad of [
      null, [], {}, { speaker: "x" }, { input_device_id: "" }, { input_device_id: "has space" }, { input_device_id: "x".repeat(257) },
      { output_device_id: 5 }, { input_label: "" }, { input_label: "x".repeat(129) }, { output_label: "bell\u0007" },
    ]) {
      expect(() => parseAudioPatch(bad), JSON.stringify(bad)).toThrow(AudioPatchError);
    }
  });

  it("the wake patch still validates device_id with the same rule (moved to shared/audio-devices.ts)", () => {
    expect(parseWakePatch({ device_id: "abc123" })).toEqual({ device_id: "abc123" });
    expect(() => parseWakePatch({ device_id: "has space" })).toThrow();
  });
});

describe("AudioSettingsStore: audio.json", () => {
  const store = (options: { log?: string[]; changes?: number[] } = {}) =>
    new AudioSettingsStore({ dir: root, onChange: () => options.changes?.push(1), log: (m) => options.log?.push(m) });

  it("defaults to the system default for both, writes 0600 only what changed, and survives a restart", () => {
    const changes: number[] = [];
    const a = store({ changes });
    expect(a.view()).toEqual(DEFAULT_AUDIO_PREFS);
    a.update({ output_device_id: "spk-bt", output_label: "JBL Flip" });
    expect(changes).toHaveLength(1);
    expect(store().view()).toEqual({ ...DEFAULT_AUDIO_PREFS, output_device_id: "spk-bt", output_label: "JBL Flip" });
    expect(statSync(join(root, "audio.json")).mode & 0o777).toBe(0o600);
    // 選回系統預設：名稱一起清掉
    a.update({ output_device_id: null });
    expect(store().view()).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it("an unreadable file or a bad key means the system default (null), the rest is kept", () => {
    writeFileSync(join(root, "audio.json"), "not json");
    const log: string[] = [];
    expect(store({ log }).view()).toEqual(DEFAULT_AUDIO_PREFS);
    expect(log.join("")).toMatch(/聲音輸入與輸出都用系統預設/);
    writeFileSync(join(root, "audio.json"), JSON.stringify({ schema_version: 1, prefs: { input_device_id: 5, output_device_id: "spk-bt", output_label: "JBL" } }));
    expect(store().view()).toEqual({ ...DEFAULT_AUDIO_PREFS, output_device_id: "spk-bt", output_label: "JBL" });
    writeFileSync(join(root, "audio.json"), JSON.stringify({ schema_version: 2, prefs: { output_device_id: "spk-bt" } }));
    expect(store().view()).toEqual(DEFAULT_AUDIO_PREFS);
  });

});

describe("/api/settings/audio", () => {
  async function boot(wake = false): Promise<NousHandle> {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_CAMERA: "off", OPENAI_API_KEY: "", ...(wake ? { NOUS_WAKE: "on" } : {}) },
      log: () => {},
    });
    return core;
  }

  it("is always present (no flag), validates, saves and broadcasts settings.updated", async () => {
    const handle = await boot();
    let view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.audio).toEqual({ prefs: DEFAULT_AUDIO_PREFS, write_path: "/api/settings/audio" });
    const post = (body: unknown) => fetch(`${handle.url}/api/settings/audio`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ output_device_id: "has space" })).status).toBe(400);
    expect((await post({ volume: 3 })).status).toBe(400);

    const controller = new AbortController();
    const events = await fetch(`${handle.url}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame!.replace(/^data: /, ""));
    };
    expect(await next()).toMatchObject({ type: "hello" });
    const saved = await post({ output_device_id: "spk-bt", output_label: "JBL Flip" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SettingsView).audio?.prefs).toMatchObject({ output_device_id: "spk-bt", output_label: "JBL Flip" });
    expect(await next()).toMatchObject({ type: "settings.updated", settings: { audio: { prefs: { output_device_id: "spk-bt" } } } });
    controller.abort();
    view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.audio?.prefs.output_label).toBe("JBL Flip");
    expect(JSON.parse(readFileSync(join(root, "config", "audio.json"), "utf8")).prefs).toEqual({ output_device_id: "spk-bt", output_label: "JBL Flip" });
  });

  it("with NOUS_WAKE=on, the old wake.json device_id is NOT migrated: the input stays the system default and audio.json is not created", async () => {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "wake.json"), JSON.stringify({ schema_version: 1, prefs: { wake_listen: true, device_id: "mic-old" } }));
    const handle = await boot(true);
    const view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.audio?.prefs).toEqual(DEFAULT_AUDIO_PREFS);
    expect(existsSync(join(root, "config", "audio.json"))).toBe(false);
  });
});
