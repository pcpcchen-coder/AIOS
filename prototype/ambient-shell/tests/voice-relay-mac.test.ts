import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, parseAil } from "../server/config.ts";
import { createVoiceRelayAdapter, VoiceRelayAdapter } from "../server/integrations/adapters/voice-relay.ts";
import type { ExecutionContext } from "../server/integrations/contracts.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { composeRelayDocument } from "../server/integrations/voice-relay/builtin.ts";
import { parseRelayCatalog } from "../server/integrations/voice-relay/catalog.ts";
import { buildSayArgs, MacSayOutput, parseSayDevices, parseSayVoices, sayVolume, SAY_PATH, type SayRunner } from "../server/integrations/voice-relay/mac-say.ts";
import type { RelayJob } from "../server/integrations/voice-relay/output.ts";
import { resolveRelay } from "../server/integrations/voice-relay/resolver.ts";

// VCR-2：Mac say 輸出。全部用假的 runner（這台是 Linux，沒有真的 /usr/bin/say）；
// `say -v ?`／`say -a ?` 的範例輸出是依文件寫的，沒有在真的 Mac 上驗證過。結果最多 unconfirmed，永遠不是 confirmed。

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "nous-vcr-mac-"));
  dirs.push(d);
  return d;
};

const VOICES = ["Meijia              zh_TW    # 你好，我叫美佳。", "Samantha            en_US    # Hello, my name is Samantha.", "Eddy (German (Germany)) de_DE    # Hallo! Ich heiße Eddy.", "garbage line without locale", "Paulina             es_419   # Hola, me llamo Paulina.", ""].join("\n");
const DEVICES = ["   91 MacBook Pro Speakers", "  120 USB Audio Device", "not a device"].join("\n");

interface Call {
  file: string;
  args: string[];
}
/** 假的 runner：清單查詢回固定輸出；播放依 behavior。 */
function fakeRunner(behavior: "ok" | "exit1" | "enoent" | "hang" = "ok") {
  const calls: Call[] = [];
  let killed = false;
  const run: SayRunner = async (file, args, { signal, onSpawn }) => {
    calls.push({ file, args: [...args] });
    if (args[1] === "?") return { code: 0, stdout: args[0] === "-v" ? VOICES : DEVICES };
    if (behavior === "enoent") throw Object.assign(new Error("spawn /usr/bin/say ENOENT"), { code: "ENOENT" });
    onSpawn();
    if (behavior === "exit1") return { code: 1, stdout: "" };
    if (behavior === "hang") {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      killed = true;
      throw new Error("aborted");
    }
    return { code: 0, stdout: "" };
  };
  return { run, calls, plays: () => calls.filter((c) => c.args[1] !== "?"), killed: () => killed };
}

const job = (patch: Partial<RelayJob> = {}): RelayJob => ({
  jobId: "j1", targetId: "t", outputNode: "mac_local", outputDeviceId: "91", engine: "macos_say", voiceId: "Meijia", rate: 1, pitch: 0, gainDb: 0,
  segments: [{ kind: "silence", ms: 300 }, { kind: "speech", part: "wake", text: "Ok Google" }, { kind: "silence", ms: 800 }, { kind: "speech", part: "command", text: "下一首歌" }, { kind: "silence", ms: 300 }],
  ...patch,
});

describe("say output parsing", () => {
  it("parses `say -v ?` voices and skips malformed lines", () => {
    expect(parseSayVoices(VOICES)).toEqual([
      { id: "Meijia", locale: "zh-TW" },
      { id: "Samantha", locale: "en-US" },
      { id: "Eddy (German (Germany))", locale: "de-DE" },
      { id: "Paulina", locale: "es-419" },
    ]);
    expect(parseSayVoices("")).toEqual([]);
  });

  it("parses `say -a ?` devices", () => {
    expect(parseSayDevices(DEVICES)).toEqual([
      { id: "91", name: "MacBook Pro Speakers" },
      { id: "120", name: "USB Audio Device" },
    ]);
  });

  it("builds argv exactly (no shell, text starts with [[ so it is never an option)", () => {
    const args = buildSayArgs(job({ rate: 0.9, gainDb: -6 }), "91");
    expect(args).toEqual(["-v", "Meijia", "-r", "158", "-a", "91", "[[volm 0.5]] [[slnc 300]] Ok Google [[slnc 800]] 下一首歌 [[slnc 300]]"]);
    expect(sayVolume(0)).toBe(1);
    // 正的增益沒辦法放大：截到 1。
    expect(sayVolume(6)).toBe(1);
    expect(sayVolume(-30)).toBe(0.03);
  });
});

describe("MacSayOutput", () => {
  async function ready(behavior: Parameters<typeof fakeRunner>[0] = "ok") {
    const r = fakeRunner(behavior);
    const out = new MacSayOutput({ run: r.run, now: () => 1234 });
    expect(out.voiceAvailable("mac_local", "macos_say", "Meijia")).toBe(false);
    await out.refresh();
    return { out, ...r };
  }

  it("refresh lists voices and devices with absolute say path", async () => {
    const { out, calls } = await ready();
    expect(calls.map((c) => c.file)).toEqual([SAY_PATH, SAY_PATH]);
    expect(out.inventory()).toMatchObject({ checkedAt: 1234, error: null, devices: [{ id: "91", name: "MacBook Pro Speakers" }, { id: "120", name: "USB Audio Device" }] });
    expect(out.voiceAvailable("mac_local", "macos_say", "Meijia")).toBe(true);
    expect(out.voiceAvailable("pi_node", "macos_say", "Meijia")).toBe(false);
    expect(out.voiceAvailable("mac_local", "local_tts", "Meijia")).toBe(false);
  });

  it("refresh failure → empty lists and an error code", async () => {
    const out = new MacSayOutput({ run: async () => ({ code: 1, stdout: "" }) });
    await out.refresh();
    expect(out.inventory()).toMatchObject({ voices: [], devices: [], error: "voices_failed" });
  });

  it("exit 0 → finished receipt; device can be matched by name and the numeric id is passed", async () => {
    const { out, plays } = await ready();
    const receipt = await out.play(job({ outputDeviceId: "USB Audio Device" }), new AbortController().signal);
    expect(receipt).toEqual({ jobId: "j1", outputNode: "mac_local", outputDeviceId: "USB Audio Device", mock: false, synthesisComplete: true, audioStarted: true, audioFinished: true });
    expect(plays()[0]!.args.slice(0, 6)).toEqual(["-v", "Meijia", "-r", "175", "-a", "120"]);
  });

  it("preconditions fail without running say", async () => {
    const { out, plays } = await ready();
    const s = new AbortController().signal;
    expect(await out.play(job({ outputDeviceId: "999" }), s)).toMatchObject({ audioStarted: false, failure: "device_unavailable" });
    expect(await out.play(job({ voiceId: "Nobody" }), s)).toMatchObject({ audioStarted: false, failure: "synthesis_failed" });
    expect(await out.play(job({ pitch: 2 }), s)).toMatchObject({ audioStarted: false, failure: "synthesis_failed" });
    expect(await out.play(job({ outputNode: "pi" }), s)).toMatchObject({ audioStarted: false, failure: "device_unavailable" });
    expect(await out.play(job({ segments: [{ kind: "speech", part: "command", text: "[[rate 1]]" }] }), s)).toMatchObject({ audioStarted: false, failure: "synthesis_failed" });
    expect(plays()).toHaveLength(0);
  });

  it("non-zero exit after spawn → interrupted; ENOENT → start_failed; abort kills and throws", async () => {
    const s = new AbortController().signal;
    expect(await (await ready("exit1")).out.play(job(), s)).toMatchObject({ audioStarted: true, audioFinished: false, failure: "interrupted" });
    expect(await (await ready("enoent")).out.play(job(), s)).toMatchObject({ audioStarted: false, audioFinished: false, failure: "start_failed" });
    const hang = await ready("hang");
    const c = new AbortController();
    const p = hang.out.play(job(), c.signal);
    c.abort();
    await expect(p).rejects.toThrow();
    expect(hang.killed()).toBe(true);
  });
});

describe("catalog rejects say markup", () => {
  const doc = (): any => structuredClone(composeRelayDocument(null));
  it("[[ or ]] in any spoken field fails validation", () => {
    const zh = (d: any) => d.packs.find((p: any) => p.id === "google.home_mini.zh-TW.v1");
    const cases: ((d: any) => void)[] = [
      (d) => (zh(d).entries[0].utteranceTemplate = "下一首[[slnc 9000]]"),
      (d) => (zh(d).entries.find((e: any) => e.templateId === "google.genre.zh1").slotText.genre.pop = "流行]]"),
      (d) => (zh(d).wakePhrases[0].text = "[[volm 1]]Ok Google"),
      (d) => (d.targets[0].devices[0].name = "燈[[x"),
    ];
    for (const mutate of cases) {
      const d = doc();
      mutate(d);
      const r = parseRelayCatalog(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toMatch(/\[\[ \]\]/);
    }
  });

  it("the resolver refuses rendered text that forms [[ from a template and a slot", () => {
    const d = doc();
    const genre = d.packs.find((p: any) => p.id === "google.home_mini.zh-TW.v1").entries.find((e: any) => e.templateId === "google.genre.zh1");
    genre.utteranceTemplate = "播放[{genre}";
    genre.slotText.genre.pop = "[流行";
    const r = parseRelayCatalog(d);
    expect(r.ok, r.ok ? "" : r.errors.join("\n")).toBe(true);
    if (!r.ok) return;
    expect(resolveRelay(r.catalog, { targetId: "fixture_google_mini_zh", intentId: "music.play_genre", slots: { genre: "pop" } })).toEqual({ kind: "refused", reason: "invalid_slots", detail: "rendered_text" });
  });
});

describe("NOUS_VCR=mac adapter", () => {
  const cfg = (dir: string) => ({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "mac" as const, dir } });
  const ctx = (signal = new AbortController().signal): ExecutionContext => ({ actor: "agent", route: "api_key", sessionId: "s", requestId: "req-1", signal });

  it("config: mac is accepted only with AIL on", () => {
    expect(parseAil("on", "voice_relay", undefined, "mac", "/cfg").vcr).toEqual({ mode: "mac", dir: join("/cfg", "voice-relay") });
    expect(loadConfig({ NOUS_VCR: "mac" }).ail.vcr).toBeUndefined();
  });

  it("not darwin → factory returns null with a log line", () => {
    const lines: string[] = [];
    expect(createVoiceRelayAdapter(cfg(tempDir()), (l) => lines.push(l), { platform: "linux", run: fakeRunner().run })).toBeNull();
    expect(lines).toEqual(["voice_relay：NOUS_VCR=mac 只能在 macOS 使用，未啟用"]);
  });

  it("no config file → zero targets (no fixtures), registered without model tools, not mock", async () => {
    const r = fakeRunner();
    const ail = createIntegrations(cfg(tempDir()), () => undefined, { voice_relay: (c, l) => createVoiceRelayAdapter(c, l, { platform: "darwin", run: r.run }) })!;
    expect(ail.voiceRelay).toBeInstanceOf(VoiceRelayAdapter);
    expect(ail.registry.listTools("api_key")).toEqual([]);
    const a = ail.voiceRelay!;
    await a.ready;
    expect(a.mock).toBe(false);
    expect(a.view()).toMatchObject({ mode: "mac", mock: false, restart_required: false, targets: [] });
  });

  async function withTarget(behavior: Parameters<typeof fakeRunner>[0] = "ok", patch: Record<string, unknown> = {}) {
    const dir = tempDir();
    const target = {
      id: "living", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", enabled: true, outputNode: "mac_local", outputDeviceId: "91",
      voiceProfileId: "mac_meijia", candidateVoiceProfileIds: [], templateOverrides: {}, reviewedTemplates: [{ templateId: "google.next.zh1", version: 1, status: "approved", reviewedAt: "2026-11-03T00:00:00.000Z" }],
      musicService: "youtube_music", devices: [], ...patch,
    };
    const profile = { id: "mac_meijia", engine: "macos_say", voiceId: "Meijia", locale: "zh-TW", rate: 1, pitch: 0, gainDb: 0, wakeToCommandPauseMs: 800, leadSilenceMs: 300, tailSilenceMs: 300, testedAt: null, recognitionStatsId: null };
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, targets: [target], voiceProfiles: [profile] }));
    const r = fakeRunner(behavior);
    const adapter = createVoiceRelayAdapter(cfg(dir), () => undefined, { platform: "darwin", run: r.run })!;
    await adapter.ready;
    return { adapter, ...r };
  }

  it("model path: exit 0 → unconfirmed (real message, never confirmed); description has no mock prefix", async () => {
    const { adapter, plays } = await withTarget();
    expect(adapter.tools()[0]!.description).not.toMatch(/模擬/);
    const result = await adapter.execute("app.voice_relay.send_intent", { target_id: "living", intent_id: "music.next" }, ctx());
    expect(result).toMatchObject({ ok: false, status: "unconfirmed", message: "已發出語音命令，但執行結果尚未確認。", data: { mock: false, template_id: "google.next.zh1" } });
    expect(plays()[0]!.args).toEqual(["-v", "Meijia", "-r", "175", "-a", "91", "[[volm 1]] [[slnc 300]] Ok Google [[slnc 800]] 下一首歌 [[slnc 300]]"]);
  });

  it("non-zero exit → unknown; ENOENT → failed; missing device → failed without playing; abort → unknown", async () => {
    const args = { target_id: "living", intent_id: "music.next" };
    expect(await (await withTarget("exit1")).adapter.execute("app.voice_relay.send_intent", args, ctx())).toMatchObject({ status: "unknown" });
    expect(await (await withTarget("enoent")).adapter.execute("app.voice_relay.send_intent", args, ctx())).toMatchObject({ status: "failed", data: { vcr_reason: "start_failed" } });
    const missing = await withTarget("ok", { outputDeviceId: "555" });
    expect(await missing.adapter.execute("app.voice_relay.send_intent", args, ctx())).toMatchObject({ status: "failed", data: { vcr_reason: "device_unavailable" } });
    expect(missing.plays()).toHaveLength(0);
    const hang = await withTarget("hang");
    const c = new AbortController();
    const p = hang.adapter.execute("app.voice_relay.send_intent", args, ctx(c.signal));
    c.abort();
    expect(await p).toMatchObject({ status: "unknown", reason: "aborted" });
    expect(hang.killed()).toBe(true);
  });

  it("voice missing on this Mac → tts_unavailable refusal (no other voice)", async () => {
    const { adapter, plays } = await withTarget();
    // 拿掉聲音清單：重新讀到沒有 Meijia 的輸出。
    const out = new MacSayOutput({ run: async (_f, a) => ({ code: 0, stdout: a[0] === "-v" ? "Samantha            en_US    # Hi" : DEVICES }) });
    await out.refresh();
    const bare = new VoiceRelayAdapter({ catalog: adapter.currentCatalog(), output: out });
    expect(await bare.execute("app.voice_relay.send_intent", { target_id: "living", intent_id: "music.next" }, ctx())).toMatchObject({ status: "refused", data: { vcr_reason: "tts_unavailable" } });
    expect(plays()).toHaveLength(0);
  });

  it("wake-only diagnostic play has no command segment", async () => {
    const { adapter, plays } = await withTarget();
    const result = await adapter.playDiagnostic({ targetId: "living", intentId: "music.next", slots: {} }, {}, "wake", new AbortController().signal);
    expect(result).toMatchObject({ status: "unconfirmed", data: { part: "wake" } });
    expect(plays()[0]!.args.at(-1)).toBe("[[volm 1]] [[slnc 300]] Ok Google [[slnc 300]]");
  });

  it("pitch ≠ 0 → failed (say has no pitch flag in this batch)", async () => {
    const d = composeRelayDocument(null, { fixtures: false }) as any;
    d.profiles = [...d.profiles, { id: "p", engine: "macos_say", voiceId: "Meijia", locale: "zh-TW", rate: 1, pitch: 3, gainDb: 0, wakeToCommandPauseMs: 0, leadSilenceMs: 0, tailSilenceMs: 0, testedAt: null, recognitionStatsId: null }];
    d.targets = [{ id: "t", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", enabled: true, outputNode: "mac_local", outputDeviceId: "91", voiceProfileId: "p", candidateVoiceProfileIds: [], templateOverrides: {}, reviewedTemplates: [{ templateId: "google.next.zh1", version: 1, status: "approved", reviewedAt: "x" }], musicService: "youtube_music", devices: [] }];
    const parsed = parseRelayCatalog(d);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = fakeRunner();
    const out = new MacSayOutput({ run: r.run });
    await out.refresh();
    const adapter = new VoiceRelayAdapter({ catalog: parsed.catalog, output: out });
    expect(await adapter.execute("app.voice_relay.send_intent", { target_id: "t", intent_id: "music.next" }, ctx())).toMatchObject({ status: "failed", data: { vcr_reason: "synthesis_failed" } });
    expect(r.plays()).toHaveLength(0);
  });
});
