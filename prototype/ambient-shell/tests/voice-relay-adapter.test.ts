import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, parseAil } from "../server/config.ts";
import { createVoiceRelayAdapter, receiptOutcome, VoiceRelayAdapter } from "../server/integrations/adapters/voice-relay.ts";
import type { ExecutionContext } from "../server/integrations/contracts.ts";
import { IntegrationDispatcher } from "../server/integrations/dispatcher.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { IntegrationRegistry } from "../server/integrations/registry.ts";
import { composeRelayDocument, FIXTURE_TARGETS } from "../server/integrations/voice-relay/builtin.ts";
import { parseRelayCatalog } from "../server/integrations/voice-relay/catalog.ts";
import { FakeRelayOutput, type FakeScenario, type RelayJob } from "../server/integrations/voice-relay/output.ts";

// VCR-0／VCR-1（fake）：Voice Command Relay Adapter。輸出全部是假輸出（mock），沒有實體喇叭發聲；
// 結果最多 unconfirmed，永遠不是 confirmed。

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "nous-vcr-"));
  dirs.push(d);
  return d;
};

const catalog = () => {
  const r = parseRelayCatalog(composeRelayDocument(null));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.catalog;
};
const allVoices = [
  { node: "fake_node", engine: "macos_say" as const, voiceId: "Meijia" },
  { node: "fake_node", engine: "macos_say" as const, voiceId: "Samantha" },
];
function setup(scenario: FakeScenario = "finished") {
  const output = new FakeRelayOutput({ voices: allVoices, scenario: () => scenario });
  const adapter = new VoiceRelayAdapter({ catalog: catalog(), output });
  return { adapter, output };
}
const ctx = (signal = new AbortController().signal): ExecutionContext => ({ actor: "agent", route: "api_key", sessionId: "s", requestId: "req-1", signal });
const NEXT = { target_id: "fixture_google_mini_zh", intent_id: "music.next" };
const SECRETS = ["Ok Google", "下一首歌", "測試燈", "test lamp", "Meijia", "fake_speaker_1", "spoken", "wake_phrase"];

describe("VoiceRelayAdapter tool definition", () => {
  it("exposes only target/intent/slots to the model, never text, wake phrase, voice or diagnostic options", () => {
    const { adapter } = setup();
    const tools = adapter.tools();
    expect(tools.map((t) => t.id)).toEqual(["app.voice_relay.send_intent"]);
    const json = JSON.stringify(tools);
    for (const banned of ["raw_text", "spoken_text", "wake_phrase", "voice_id", "candidate", "測試燈", "test lamp", "Ok Google", "Meijia"]) expect(json, banned).not.toContain(banned);
    const t = tools[0]!;
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(["device", "genre", "intent_id", "on", "percent", "seconds", "target_id"]);
    expect(t.inputSchema.required).toEqual(["target_id", "intent_id"]);
    expect(t.effect).toBe("reversible_write");
    expect(t.description).toMatch(/^（模擬）/);
    expect(t.descriptionEn).toMatch(/^\(Mock\)/);
    expect(adapter.mock).toBe(true);
  });

  it("has no tools and reports not_configured when no target is enabled", async () => {
    const c = composeRelayDocument({ targets: [] });
    const r = parseRelayCatalog(c);
    if (!r.ok) throw new Error(r.errors.join());
    const adapter = new VoiceRelayAdapter({ catalog: r.catalog, output: new FakeRelayOutput({ voices: [] }) });
    expect(adapter.tools()).toEqual([]);
    expect(await adapter.health()).toEqual({ health: "unavailable", reason: "not_configured" });
    expect(await setup().adapter.health()).toEqual({ health: "available", reason: "ok" });
  });

  it("registers with identical function specs on api_key and live", () => {
    const r = new IntegrationRegistry({ enabled: new Set(["voice_relay"]) });
    r.register(setup().adapter);
    const apiKey = r.functionSpecs("api_key");
    expect(apiKey.map((s) => s.name)).toEqual(["app__voice_relay__send_intent"]);
    expect(r.functionSpecs("live")).toEqual(apiKey);
    expect(r.functionSpecs("api_key", "en")[0]!.description).toMatch(/^\(Mock\)/);
  });
});

describe("VoiceRelayAdapter execute (fake output)", () => {
  it("finished playback → unconfirmed, never confirmed; data has ids but no spoken text or device names", async () => {
    const { adapter, output } = setup("finished");
    const result = await adapter.execute("app.voice_relay.send_intent", { target_id: "fixture_google_mini_zh", intent_id: "light.power", device: "fixture_light", on: true }, ctx());
    expect(result.status).toBe("unconfirmed");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("已發出語音命令");
    expect(result.message).toMatch(/^（模擬）/);
    expect(result.data).toEqual({ mock: true, target_id: "fixture_google_mini_zh", intent_id: "light.power", template_id: "google.light.zh1", template_version: 1, catalog_version: 1, voice_profile_id: "google_zh_a", test_status: "NOT_TESTED", job_id: "req-1" });
    const json = JSON.stringify(result);
    for (const secret of SECRETS) expect(json, secret).not.toContain(secret);
    // 假輸出收到的工作：前置靜音、喚醒詞、停頓、命令、尾端靜音。
    expect(output.jobs).toHaveLength(1);
    expect(output.jobs[0]!.segments).toEqual([
      { kind: "silence", ms: 300 },
      { kind: "speech", part: "wake", text: "Ok Google" },
      { kind: "silence", ms: 600 },
      { kind: "speech", part: "command", text: "打開測試燈" },
      { kind: "silence", ms: 300 },
    ]);
  });

  it("maps every fake scenario without ever returning confirmed", async () => {
    const expected: [FakeScenario, string][] = [
      ["finished", "unconfirmed"],
      ["synthesis_failed", "failed"],
      ["device_unavailable", "failed"],
      ["synthesis_only", "unknown"],
      ["interrupted", "unknown"],
      ["receipt_lost", "unknown"],
      ["wrong_job", "unknown"],
      ["wrong_device", "unknown"],
    ];
    for (const [scenario, status] of expected) {
      const { adapter, output } = setup(scenario);
      const result = await adapter.execute("app.voice_relay.send_intent", NEXT, ctx());
      expect(result.status, scenario).toBe(status);
      expect(result.ok).toBe(false);
      expect((result.data as { mock: boolean }).mock).toBe(true);
      expect(output.jobs, scenario).toHaveLength(1);
      for (const secret of SECRETS) expect(JSON.stringify(result), `${scenario} ${secret}`).not.toContain(secret);
    }
  });

  it("receiptOutcome treats synthesis-complete-but-not-started as unknown, and never yields confirmed", () => {
    const job = { jobId: "j", outputNode: "n", outputDeviceId: "d" } as RelayJob;
    const r = (patch: object) => ({ jobId: "j", outputNode: "n", outputDeviceId: "d", synthesisComplete: true, audioStarted: true, audioFinished: true, mock: false, ...patch });
    expect(receiptOutcome(r({}), job, false).status).toBe("unconfirmed");
    expect(receiptOutcome(r({}), job, false).message).toBe("已發出語音命令，但執行結果尚未確認。");
    expect(receiptOutcome(r({ audioStarted: false, audioFinished: false }), job, false).status).toBe("unknown");
    expect(receiptOutcome(r({ failure: "interrupted" }), job, false).status).toBe("unknown");
    expect(receiptOutcome(r({ outputNode: "other" }), job, false).status).toBe("unknown");
    expect(receiptOutcome("ok", job, false).status).toBe("unknown");
    expect(receiptOutcome(null, job, false).status).toBe("unknown");
  });

  it("refused paths never call play", async () => {
    const { adapter, output } = setup();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ target_id: "nope", intent_id: "music.next" }, "invalid_arguments", "unknown_target"],
      [{ ...NEXT, intent_id: "assistant.timer", seconds: 30 }, "invalid_arguments", "unsupported_intent"],
      [{ ...NEXT, percent: 10 }, "invalid_arguments", "invalid_slots"],
      [{ ...NEXT, intent_id: "light.power", device: "fixture_light" }, "invalid_arguments", "invalid_slots"],
    ];
    for (const [args, reason, vcr] of cases) {
      const result = await adapter.execute("app.voice_relay.send_intent", args, ctx());
      expect(result).toMatchObject({ status: "refused", reason, data: { mock: true, vcr_reason: vcr } });
    }
    // 聲音不在輸出端：不換聲線，也不播。
    const noVoice = new VoiceRelayAdapter({ catalog: catalog(), output: new FakeRelayOutput({ voices: [] }) });
    expect(await noVoice.execute("app.voice_relay.send_intent", NEXT, ctx())).toMatchObject({ status: "refused", reason: "unavailable", data: { vcr_reason: "tts_unavailable" } });
    expect(output.jobs).toHaveLength(0);
  });

  it("refuses while the same output node is busy", async () => {
    const { adapter, output } = setup("timeout_mid");
    const abort = new AbortController();
    const first = adapter.execute("app.voice_relay.send_intent", NEXT, ctx(abort.signal));
    const second = await adapter.execute("app.voice_relay.send_intent", { ...NEXT, target_id: "fixture_google_mini_en" }, ctx());
    expect(second).toMatchObject({ status: "refused", reason: "unavailable", data: { vcr_reason: "output_busy" } });
    abort.abort();
    expect((await first).status).toBe("unknown");
    expect(output.jobs).toHaveLength(1);
  });

  it("timeout mid-playback through the dispatcher → unknown, play called exactly once (no retry)", async () => {
    const output = new FakeRelayOutput({ voices: allVoices, scenario: () => "timeout_mid" });
    const adapter = new VoiceRelayAdapter({ catalog: catalog(), output });
    const shortTools = adapter.tools().map((t) => ({ ...t, timeoutMs: 150 }));
    const wrapped = Object.assign(Object.create(adapter) as VoiceRelayAdapter, { tools: () => shortTools });
    const registry = new IntegrationRegistry({ enabled: new Set(["voice_relay"]) });
    registry.register(wrapped);
    const result = await new IntegrationDispatcher(registry).execute({ tool: "app__voice_relay__send_intent", args: NEXT, route: "live", actor: "agent", sessionId: "s" });
    expect(result).toMatchObject({ status: "unknown", reason: "timeout", ok: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(output.jobs).toHaveLength(1);
    // 中止後鎖已釋放，下一次可以再播（仍然只在使用者再要求時）。
    const next = await new IntegrationDispatcher(registry).execute({ tool: "app__voice_relay__send_intent", args: NEXT, route: "live", actor: "agent", sessionId: "s" });
    expect(next.status).toBe("unknown");
    expect(output.jobs).toHaveLength(2);
  });

  it("diagnose previews without playing and is not reachable from the tool schema", () => {
    const { adapter, output } = setup();
    const r = adapter.diagnose({ targetId: "fixture_google_mini_zh", intentId: "music.next", slots: {} }, { candidateVoiceId: "google_zh_b" });
    expect(r).toMatchObject({ kind: "resolved", voiceProfileId: "google_zh_b", diagnostic: true });
    expect(output.jobs).toHaveLength(0);
  });
});

describe("NOUS_VCR config and createIntegrations", () => {
  it("parseAil: NOUS_VCR defaults off, fake adds vcr only when AIL is on, anything else throws", () => {
    expect(parseAil(undefined, "mock")).toEqual({ enabled: false, services: [], soloistPort: 19090 });
    expect(parseAil("on", " Mock, mock ,")).toEqual({ enabled: true, services: ["mock"], soloistPort: 19090 });
    expect(parseAil("on", "voice_relay", undefined, "off", "/cfg")).toEqual({ enabled: true, services: ["voice_relay"], soloistPort: 19090 });
    expect(parseAil("on", "voice_relay", undefined, " FAKE ", "/cfg")).toEqual({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "fake", dir: join("/cfg", "voice-relay") } });
    expect(parseAil("off", "voice_relay", undefined, "fake", "/cfg")).toEqual({ enabled: false, services: [], soloistPort: 19090 });
    for (const bad of ["on", "real", "1"]) expect(() => parseAil("on", "voice_relay", undefined, bad), bad).toThrow(/NOUS_VCR 只接受 off 或 fake/);
    expect(() => loadConfig({ NOUS_VCR: "on" })).toThrow(/NOUS_VCR/);
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "voice_relay", NOUS_VCR: "fake", NOUS_CONFIG_DIR: "/cfg" }).ail.vcr).toEqual({ mode: "fake", dir: join("/cfg", "voice-relay") });
    expect(loadConfig({}).ail).toEqual({ enabled: false, services: [], soloistPort: 19090 });
  });

  it("voice_relay is skipped with a log line when NOUS_VCR is off", () => {
    const lines: string[] = [];
    const ail = createIntegrations({ enabled: true, services: ["voice_relay", "mock"], soloistPort: 19090 }, (l) => lines.push(l))!;
    expect(ail.registry.adapters().map((a) => a.id)).toEqual(["mock"]);
    expect(ail.registry.listTools("api_key").map((t) => t.id)).not.toContain("app.voice_relay.send_intent");
    expect(lines.join("\n")).toMatch(/voice_relay 未啟用（NOUS_VCR=off），略過/);
  });

  it("with NOUS_VCR=fake and no user file, the fixture targets are used and the adapter is mock", async () => {
    const lines: string[] = [];
    const ail = createIntegrations({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "fake", dir: join(tempDir(), "voice-relay") } }, (l) => lines.push(l))!;
    expect(ail.registry.listTools("api_key").map((t) => t.id)).toEqual(["app.voice_relay.send_intent"]);
    const adapter = ail.registry.adapters()[0]!;
    expect(adapter.mock).toBe(true);
    expect(lines.join("\n")).toMatch(/假輸出（模擬）/);
    const result = await ail.dispatcher.execute({ tool: "app__voice_relay__send_intent", args: { target_id: FIXTURE_TARGETS[1]!.id, intent_id: "volume.set", percent: 25 }, route: "api_key", actor: "agent", sessionId: "s" });
    expect(result).toMatchObject({ status: "unconfirmed", ok: false, data: { mock: true, template_id: "google.volume.en1" } });
  });

  it("loads a valid user file (its targets replace the fixtures) and fails closed on an invalid one", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, targets: [{ ...structuredClone(FIXTURE_TARGETS[0]), id: "living_room", fixture: undefined }] }));
    const adapter = createVoiceRelayAdapter({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "fake", dir } })!;
    expect(adapter.tools()[0]!.inputSchema.properties.target_id).toMatchObject({ enum: ["living_room"] });

    for (const body of ["{not json", JSON.stringify({ schemaVersion: 1, extra: true }), JSON.stringify({ schemaVersion: 1, targets: [{ id: "x" }] })]) {
      const bad = tempDir();
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "config.json"), body);
      const lines: string[] = [];
      expect(createVoiceRelayAdapter({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "fake", dir: bad } }, (l) => lines.push(l)), body).toBeNull();
      expect(lines.join("\n")).toMatch(/voice_relay .*未啟用/);
      // Nous 照常啟動：整合層還在，只是沒有 voice_relay。
      const ail = createIntegrations({ enabled: true, services: ["voice_relay", "mock"], soloistPort: 19090, vcr: { mode: "fake", dir: bad } });
      expect(ail!.registry.adapters().map((a) => a.id)).toEqual(["mock"]);
    }
  });
});
