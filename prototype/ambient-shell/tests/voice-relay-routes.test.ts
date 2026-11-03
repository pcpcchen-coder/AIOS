import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockAdapter } from "../server/integrations/adapters/mock.ts";
import { createVoiceRelayAdapter } from "../server/integrations/adapters/voice-relay.ts";
import { createIntegrations, type Integrations } from "../server/integrations/index.ts";
import type { SayRunner } from "../server/integrations/voice-relay/mac-say.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { VoiceRelayView } from "../shared/voice-relay.ts";

// VCR-2：設定頁「語音中繼（實驗）」的 HTTP 路由，跑真的 HTTP app；say 用假的 runner（這台不是 Mac，沒有實際發聲）。
// 診斷畫面可以播候選說法（使用者明確選的）；模型路徑只播採用（approved）的說法；結果最多 unconfirmed，永遠不是 confirmed。

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "nous-vcr-routes-"));
  dirs.push(d);
  return d;
};

const VOICES = "Meijia              zh_TW    # 你好，我叫美佳。\nSamantha            en_US    # Hello, my name is Samantha.\n";
const DEVICES = "   91 MacBook Pro Speakers\n  120 USB Audio Device\n";

function fakeSay() {
  const plays: string[][] = [];
  const run: SayRunner = async (_file, args, { onSpawn }) => {
    if (args[1] === "?") return { code: 0, stdout: args[0] === "-v" ? VOICES : DEVICES };
    plays.push([...args]);
    onSpawn();
    return { code: 0, stdout: "" };
  };
  return { run, plays };
}

describe("HTTP /api/voice-relay (NOUS_VCR=mac, fake say runner)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function app(integrations: Integrations | null) {
    const store = new TaskStore(null);
    const dir = tempDir();
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, ...(integrations ? { integrations } : {}), port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = async <T = VoiceRelayView>(path: string, body: unknown): Promise<T> => {
      const res = await post(path, body);
      const json = await res.json();
      expect(res.status, JSON.stringify(json)).toBe(200);
      return json as T;
    };
    return { base, post, ok };
  }

  async function macApp(config?: unknown) {
    const relayDir = join(tempDir(), "voice-relay");
    if (config) {
      mkdirSync(relayDir, { recursive: true });
      writeFileSync(join(relayDir, "config.json"), JSON.stringify(config));
    }
    const say = fakeSay();
    const integrations = createIntegrations({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "mac", dir: relayDir } }, () => undefined, {
      voice_relay: (c, l) => createVoiceRelayAdapter(c, l, { platform: "darwin", run: say.run, now: () => new Date("2026-11-03T08:00:00.000Z") }),
    })!;
    await integrations.voiceRelay!.ready;
    return { a: await app(integrations), integrations, say, relayDir };
  }

  it("not registered: 404 and no voice_relay key in settings", async () => {
    const a = await app(null);
    expect((await fetch(`${a.base}/api/voice-relay`)).status).toBe(404);
    expect((await a.post("/api/voice-relay/play", {})).status).toBe(404);
    expect("voice_relay" in ((await (await fetch(`${a.base}/api/settings`)).json()) as object)).toBe(false);
    // 整合層開著但沒有 voice_relay：一樣 404、沒有鍵。
    const b = await app(createIntegrations({ enabled: true, services: ["mock"], soloistPort: 19090 }, () => undefined, { mock: () => new MockAdapter() }));
    expect((await fetch(`${b.base}/api/voice-relay`)).status).toBe(404);
    expect("voice_relay" in ((await (await fetch(`${b.base}/api/settings`)).json()) as object)).toBe(false);
  });

  it("full diagnostics flow: create → preview → play → adopt → model path → unadopt → trial", async () => {
    const { a, integrations, say, relayDir } = await macApp();
    expect(((await (await fetch(`${a.base}/api/settings`)).json()) as { voice_relay?: boolean }).voice_relay).toBe(true);

    const empty = (await (await fetch(`${a.base}/api/voice-relay`)).json()) as VoiceRelayView;
    expect(empty).toMatchObject({ mode: "mac", mock: false, restart_required: false, targets: [], output: { error: null, devices: [{ id: "MacBook Pro Speakers", name: "MacBook Pro Speakers" }, { id: "USB Audio Device", name: "USB Audio Device" }] } });
    expect(empty.output.voices).toEqual([{ id: "Meijia", locale: "zh-TW" }, { id: "Samantha", locale: "en-US" }]);
    expect(existsSync(join(relayDir, "config.json"))).toBe(false);

    // 新增目標 → config.json（0600）可以解析，模型的工具清單要重新啟動。
    let view = await a.ok("/api/voice-relay/target", { locale: "zh-TW", output_device_id: "MacBook Pro Speakers", voice_id: "Meijia", music_service: "youtube_music" });
    expect(view.restart_required).toBe(true);
    const t = view.targets[0]!;
    expect(t).toMatchObject({ id: "google_mini_1", locale: "zh-TW", enabled: true, output_device_id: "MacBook Pro Speakers", voice_profile_id: "mac_meijia_zhtw_1" });
    expect(t.profiles).toEqual([{ id: "mac_meijia_zhtw_1", voice_id: "Meijia", locale: "zh-TW", rate: 1, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300, selected: true, editable: true, available: true }]);
    const file = join(relayDir, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(relayDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ schemaVersion: 1, targets: [{ id: "google_mini_1", outputNode: "mac_local" }] });
    const next = t.intents.find((i) => i.intent_id === "music.next")!;
    expect(next.templates).toEqual([{ template_id: "google.next.zh1", version: 1, text: "下一首歌", wake: "Ok Google", status: "candidate", selected_default: true, adopted: false, policy_blocked: false }]);
    const genre = t.intents.find((i) => i.intent_id === "music.play_genre")!;
    expect(genre.slots).toEqual(["genre"]);
    expect(genre.templates.find((x) => x.template_id === "google.genre_spotify.zh1")).toMatchObject({ policy_blocked: true, selected_default: false });

    // 新增候選聲線、修改它。
    view = await a.ok("/api/voice-relay/profile", { target_id: "google_mini_1", voice_id: "Meijia", rate: 0.9, gain_db: -6, pause_ms: 1000, lead_ms: 200, tail_ms: 200 });
    expect(view.targets[0]!.profiles.map((p) => [p.id, p.selected])).toEqual([["mac_meijia_zhtw_1", true], ["mac_meijia_zhtw_2", false]]);
    view = await a.ok("/api/voice-relay/profile", { target_id: "google_mini_1", id: "mac_meijia_zhtw_2", voice_id: "Meijia", rate: 1.1, gain_db: -3, pause_ms: 900, lead_ms: 200, tail_ms: 200 });
    expect(view.targets[0]!.profiles[1]).toMatchObject({ rate: 1.1, gain_db: -3, pause_ms: 900 });
    expect((await a.post("/api/voice-relay/profile", { target_id: "google_mini_1", voice_id: "Meijia", rate: 5, gain_db: 0, pause_ms: 0, lead_ms: 0, tail_ms: 0 })).status).toBe(400);
    expect((await a.post("/api/voice-relay/profile", { target_id: "google_mini_1", id: "google_zh_a", voice_id: "Meijia", rate: 1, gain_db: 0, pause_ms: 0, lead_ms: 0, tail_ms: 0 })).status).toBe(400);

    // 預覽候選說法（診斷）。
    const preview = await a.ok<{ result: unknown }>("/api/voice-relay/preview", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", voice_profile_id: "mac_meijia_zhtw_2" });
    expect(preview.result).toEqual({ kind: "resolved", template_id: "google.next.zh1", level: "diagnostic", voice_profile_id: "mac_meijia_zhtw_2", wake: "Ok Google", command: "下一首歌", spoken: "Ok Google 下一首歌", output_device_id: "MacBook Pro Speakers", test_status: "NOT_TESTED" });
    expect((await a.ok<{ result: unknown }>("/api/voice-relay/preview", { target_id: "google_mini_1", intent_id: "music.next" })).result).toEqual({ kind: "refused", reason: "not_reviewed", detail: "candidate" });
    expect((await a.ok<{ result: unknown }>("/api/voice-relay/preview", { target_id: "google_mini_1", intent_id: "music.play_genre", slots: { genre: "jazz" }, template_id: "google.genre_spotify.zh1" })).result).toMatchObject({ kind: "refused", reason: "policy_blocked" });

    // 測試喚醒：只有喚醒詞。
    const wake = await a.ok<Record<string, unknown>>("/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", part: "wake" });
    expect(wake).toMatchObject({ ok: false, status: "unconfirmed" });
    expect(say.plays.at(-1)!.at(-1)).toBe("[[volm 1]] [[slnc 300]] Ok Google [[slnc 300]]");
    // 測試整句（候選說法，使用者明確選的）。
    const full = await a.ok<Record<string, unknown>>("/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", voice_profile_id: "mac_meijia_zhtw_2", part: "full" });
    expect(full).toMatchObject({ ok: false, status: "unconfirmed", message: "已發出語音命令，但執行結果尚未確認。" });
    expect(say.plays.at(-1)).toEqual(["-v", "Meijia", "-r", "193", "-a", "91", "[[volm 0.71]] [[slnc 200]] Ok Google [[slnc 900]] 下一首歌 [[slnc 200]]"]);
    expect(await a.ok("/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next", part: "full" })).toEqual({ status: "refused", reason: "not_reviewed", detail: "candidate" });

    // 模型路徑：同一個候選說法被拒絕（not_reviewed），沒有播放。
    const model = (args: Record<string, unknown>) => integrations.voiceRelay!.execute("app.voice_relay.send_intent", args, { actor: "agent", route: "api_key", sessionId: "s", requestId: "r1", signal: new AbortController().signal });
    const playsBefore = say.plays.length;
    expect(await model({ target_id: "google_mini_1", intent_id: "music.next" })).toMatchObject({ status: "refused", data: { vcr_reason: "not_reviewed" } });
    expect(say.plays.length).toBe(playsBefore);

    // 採用（用第二個聲線）→ 模型路徑可以播 → unconfirmed，不是 confirmed。
    view = await a.ok("/api/voice-relay/adopt", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", template_version: 1, voice_profile_id: "mac_meijia_zhtw_2" });
    const adopted = view.targets[0]!;
    expect(adopted.voice_profile_id).toBe("mac_meijia_zhtw_2");
    expect(adopted.intents.find((i) => i.intent_id === "music.next")!.templates[0]).toMatchObject({ status: "approved", adopted: true, selected_default: true });
    expect(JSON.parse(readFileSync(file, "utf8")).targets[0].reviewedTemplates).toEqual([{ templateId: "google.next.zh1", version: 1, status: "approved", reviewedAt: "2026-11-03T08:00:00.000Z", note: "adopted in diagnostics" }]);
    const played = await model({ target_id: "google_mini_1", intent_id: "music.next" });
    expect(played).toMatchObject({ ok: false, status: "unconfirmed", data: { mock: false, voice_profile_id: "mac_meijia_zhtw_2" } });
    expect(played.status).not.toBe("confirmed");
    // 政策擋下的說法不能採用。
    expect((await a.post("/api/voice-relay/adopt", { target_id: "google_mini_1", intent_id: "music.play_genre", template_id: "google.genre_spotify.zh1", template_version: 1, voice_profile_id: "mac_meijia_zhtw_2" })).status).toBe(400);

    // 取消採用 → 模型路徑又被拒絕。
    view = await a.ok("/api/voice-relay/unadopt", { target_id: "google_mini_1", template_id: "google.next.zh1", template_version: 1 });
    expect(view.targets[0]!.intents.find((i) => i.intent_id === "music.next")!.templates[0]).toMatchObject({ status: "candidate", adopted: false });
    expect(await model({ target_id: "google_mini_1", intent_id: "music.next" })).toMatchObject({ status: "refused", data: { vcr_reason: "not_reviewed" } });

    // 試驗紀錄 → trials.json，統計。
    const trial = { target_id: "google_mini_1", template_id: "google.next.zh1", template_version: 1, voice_profile_id: "mac_meijia_zhtw_2", kind: "positive", wake: "WAKE_OK", command: "COMMAND_OK", evidence: "visual" };
    await a.ok("/api/voice-relay/trial", trial);
    view = await a.ok("/api/voice-relay/trial", { ...trial, wake: "NO_WAKE", command: "NO_COMMAND", evidence: "human_confirmed" });
    expect(view.targets[0]!.trials).toEqual([
      expect.objectContaining({ templateId: "google.next.zh1", voiceProfileId: "mac_meijia_zhtw_2", trials: 2, wakeDetected: 1, correctCommand: 1, status: "MEASURED", wakeRate: { num: 1, den: 2, value: 0.5 }, commandRate: { num: 1, den: 1, value: 1 }, falseWakeRate: { num: 0, den: 0, value: null } }),
    ]);
    const trialsFile = join(relayDir, "trials.json");
    expect(statSync(trialsFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(trialsFile, "utf8")).trials.map((x: { id: string; at: string }) => [x.id, x.at])).toEqual([["t_1", "2026-11-03T08:00:00.000Z"], ["t_2", "2026-11-03T08:00:00.000Z"]]);
    // commandOK 不能超過 wakeOK；device_state_api 不能從設定頁宣稱。
    expect((await a.post("/api/voice-relay/trial", { ...trial, wake: "NO_WAKE" })).status).toBe(400);
    expect((await a.post("/api/voice-relay/trial", { ...trial, evidence: "device_state_api" })).status).toBe(400);

    // 停用／啟用。
    view = await a.ok("/api/voice-relay/enabled", { target_id: "google_mini_1", enabled: false });
    expect(view.targets[0]!.enabled).toBe(false);
    expect(await a.ok("/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", part: "wake" })).toEqual({ status: "refused", reason: "target_disabled" });
    // restart_required：停用後啟用的目標清單又和啟動時（0 個）相同。
    expect(view.restart_required).toBe(false);

    // 重新讀取。
    expect((await a.ok("/api/voice-relay/refresh", {})).output.devices).toHaveLength(2);
  });

  it("invalid bodies → 400 with a fixed message (no echo)", async () => {
    const { a } = await macApp();
    await a.ok("/api/voice-relay/target", { locale: "en-US", output_device_id: "USB Audio Device", voice_id: "Samantha", music_service: "spotify" });
    const bad: [string, unknown][] = [
      ["/api/voice-relay/refresh", { x: 1 }],
      ["/api/voice-relay/preview", { target_id: "google_mini_1" }],
      ["/api/voice-relay/preview", { target_id: "google_mini_1", intent_id: "music.next", extra: "SECRET_VALUE" }],
      ["/api/voice-relay/preview", { target_id: "google_mini_1", intent_id: "music.play_genre", slots: { genre: "jazz", raw: "x" } }],
      ["/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next", part: "SECRET_VALUE" }],
      ["/api/voice-relay/play", { target_id: "google_mini_1", intent_id: "music.next" }],
      ["/api/voice-relay/target", { locale: "fr-FR", output_device_id: "91", voice_id: "Meijia", music_service: "youtube_music" }],
      ["/api/voice-relay/target", { locale: "zh-TW", output_device_id: "91", voice_id: "Meijia", music_service: "youtube_music", id: "BAD ID" }],
      ["/api/voice-relay/target", { locale: "zh-TW", output_device_id: "MacBook Pro Speakers", voice_id: "[[volm 0]]", music_service: "youtube_music" }],
      // 聲音必須是輸出端讀到的、語系相同。
      ["/api/voice-relay/target", { locale: "zh-TW", output_device_id: "MacBook Pro Speakers", voice_id: "Nobody", music_service: "youtube_music" }],
      ["/api/voice-relay/target", { locale: "zh-TW", output_device_id: "MacBook Pro Speakers", voice_id: "Samantha", music_service: "youtube_music" }],
      ["/api/voice-relay/profile", { target_id: "google_mini_1", voice_id: "Meijia", rate: 1, gain_db: 0, pause_ms: 0, lead_ms: 0, tail_ms: 0 }],
      ["/api/voice-relay/profile", { target_id: "google_mini_1", voice_id: "Nobody", rate: 1, gain_db: 0, pause_ms: 0, lead_ms: 0, tail_ms: 0 }],
      ["/api/voice-relay/adopt", { target_id: "nope", intent_id: "music.next", template_id: "google.next.en1", template_version: 1, voice_profile_id: "x" }],
      ["/api/voice-relay/adopt", { target_id: "google_mini_1", intent_id: "music.next", template_id: "google.next.zh1", template_version: 1, voice_profile_id: "mac_samantha_enus_1" }],
      ["/api/voice-relay/unadopt", { target_id: "google_mini_1", template_id: "google.next.en1", template_version: 1 }],
      ["/api/voice-relay/enabled", { target_id: "google_mini_1", enabled: "yes" }],
      ["/api/voice-relay/trial", { target_id: "google_mini_1" }],
    ];
    for (const [path, body] of bad) {
      const res = await a.post(path, body);
      const text = await res.text();
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(text).not.toContain("SECRET_VALUE");
      expect(text).not.toContain("BAD ID");
    }
    expect((await a.post("/api/voice-relay/nope", {})).status).toBe(404);
    // Spotify 音樂服務：音樂類意圖全部政策封鎖，非音樂的不受影響。
    const view = (await (await fetch(`${a.base}/api/voice-relay`)).json()) as VoiceRelayView;
    const t = view.targets[0]!;
    expect(t.intents.filter((i) => i.intent_id.startsWith("music.")).every((i) => i.templates.every((x) => x.policy_blocked))).toBe(true);
    expect(t.intents.find((i) => i.intent_id === "volume.set")!.templates[0]!.policy_blocked).toBe(false);
  });

  it("one adoption per intent; editing the selected voice clears adoptions; trials must fit the target", async () => {
    const entry = { templateId: "user.next.zh", version: 1, intentId: "music.next", utteranceTemplate: "跳到下一首", selected: false, supported: true, status: "candidate", downstreamService: "configured_music_service", source: "user test", testedOn: null, testResult: "NOT_TESTED" };
    const profile = { id: "mac_meijia_zhtw_1", engine: "macos_say", voiceId: "Meijia", locale: "zh-TW", rate: 1, pitch: 0, gainDb: 0, wakeToCommandPauseMs: 800, leadSilenceMs: 300, tailSilenceMs: 300, testedAt: null, recognitionStatsId: null };
    const target = {
      id: "living", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", enabled: true, outputNode: "mac_local", outputDeviceId: "MacBook Pro Speakers",
      voiceProfileId: "mac_meijia_zhtw_1", candidateVoiceProfileIds: [], templateOverrides: {}, reviewedTemplates: [], musicService: "youtube_music", devices: [],
    };
    const pack = { id: "user.zh", version: 1, scope: "assistant", vendor: "google", assistant: "google_assistant", locale: "zh-TW", wakePhrases: [], entries: [entry] };
    const { a, integrations, say } = await macApp({ schemaVersion: 1, targets: [target], voiceProfiles: [profile], commandPacks: [pack] });
    const next = (v: VoiceRelayView) => v.targets[0]!.intents.find((i) => i.intent_id === "music.next")!.templates;
    const adopt = (template_id: string) => a.ok("/api/voice-relay/adopt", { target_id: "living", intent_id: "music.next", template_id, template_version: 1, voice_profile_id: "mac_meijia_zhtw_1" });
    const model = () => integrations.voiceRelay!.execute("app.voice_relay.send_intent", { target_id: "living", intent_id: "music.next" }, { actor: "agent", route: "api_key", sessionId: "s", requestId: "r", signal: new AbortController().signal });

    let view = await adopt("google.next.zh1");
    expect(next(view).map((x) => [x.template_id, x.status, x.adopted])).toEqual([["google.next.zh1", "approved", true], ["user.next.zh", "candidate", false]]);
    // 改採用 B：A 的 approved 審閱被拿掉，只有 B 是採用。
    view = await adopt("user.next.zh");
    expect(next(view).map((x) => [x.template_id, x.status, x.adopted, x.selected_default])).toEqual([["google.next.zh1", "candidate", false, false], ["user.next.zh", "approved", true, true]]);
    expect(await model()).toMatchObject({ status: "unconfirmed" });
    expect(say.plays.at(-1)!.at(-1)).toContain("跳到下一首");

    // 改模型正在用的聲線 → 採用全部作廢。
    view = await a.ok("/api/voice-relay/profile", { target_id: "living", id: "mac_meijia_zhtw_1", voice_id: "Meijia", rate: 1.2, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 });
    expect(next(view).every((x) => !x.adopted && x.status === "candidate")).toBe(true);
    expect(await model()).toMatchObject({ status: "refused", data: { vcr_reason: "not_reviewed" } });
    // 改候選聲線不影響採用。
    await adopt("google.next.zh1");
    view = await a.ok("/api/voice-relay/profile", { target_id: "living", voice_id: "Meijia", rate: 0.8, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 });
    view = await a.ok("/api/voice-relay/profile", { target_id: "living", id: "mac_meijia_zhtw_2", voice_id: "Meijia", rate: 0.9, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 });
    expect(next(view)[0]).toMatchObject({ adopted: true });

    // 試驗：模板要能用在這個目標，聲線要是目標的。
    const trial = { target_id: "living", template_id: "google.next.zh1", template_version: 1, voice_profile_id: "mac_meijia_zhtw_1", kind: "positive", wake: "WAKE_OK", command: "COMMAND_OK", evidence: "visual" };
    await a.ok("/api/voice-relay/trial", trial);
    await a.ok("/api/voice-relay/trial", { ...trial, voice_profile_id: "mac_meijia_zhtw_2" });
    for (const bad of [{ template_id: "google.next.en1" }, { template_id: "google.genre_spotify.zh1" }, { template_version: 2 }, { voice_profile_id: "google_zh_a" }]) {
      expect((await a.post("/api/voice-relay/trial", { ...trial, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("adopted is false for an approved review the resolver would not pick", async () => {
    const profile = { id: "p1", engine: "macos_say", voiceId: "Meijia", locale: "zh-TW", rate: 1, pitch: 0, gainDb: 0, wakeToCommandPauseMs: 800, leadSilenceMs: 300, tailSilenceMs: 300, testedAt: null, recognitionStatsId: null };
    const genre = (id: string) => ({ templateId: id, version: 1, status: "approved", reviewedAt: "x" });
    const target = {
      id: "living", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", enabled: true, outputNode: "mac_local", outputDeviceId: "MacBook Pro Speakers",
      voiceProfileId: "p1", candidateVoiceProfileIds: [], templateOverrides: {}, reviewedTemplates: [genre("google.genre.zh1"), genre("google.genre_spotify.zh1")], musicService: "youtube_music", devices: [],
    };
    const { a } = await macApp({ schemaVersion: 1, targets: [target], voiceProfiles: [profile] });
    const view = (await (await fetch(`${a.base}/api/voice-relay`)).json()) as VoiceRelayView;
    const templates = view.targets[0]!.intents.find((i) => i.intent_id === "music.play_genre")!.templates;
    expect(templates.map((x) => [x.template_id, x.status, x.adopted])).toEqual([["google.genre.zh1", "approved", true], ["google.genre_spotify.zh1", "approved", false]]);
  });

  it("NOUS_VCR=fake: fixture targets are listed but read-only (mock)", async () => {
    const integrations = createIntegrations({ enabled: true, services: ["voice_relay"], soloistPort: 19090, vcr: { mode: "fake", dir: join(tempDir(), "voice-relay") } })!;
    const a = await app(integrations);
    const view = (await (await fetch(`${a.base}/api/voice-relay`)).json()) as VoiceRelayView;
    expect(view).toMatchObject({ mode: "fake", mock: true, restart_required: false, fixtures_active: true });
    expect(view.targets.map((t) => t.id)).toEqual(["fixture_google_mini_zh", "fixture_google_mini_en"]);
    expect(view.targets[0]!.profiles.every((p) => !p.editable)).toBe(true);
    expect(view.targets[0]!.devices).toEqual([{ id: "fixture_light", name: "測試燈" }]);
    const res = await a.post("/api/voice-relay/enabled", { target_id: "fixture_google_mini_zh", enabled: false });
    expect(res.status).toBe(400);
    const full = await (await a.post("/api/voice-relay/play", { target_id: "fixture_google_mini_zh", intent_id: "music.next", part: "full" })).json();
    expect(full).toMatchObject({ status: "unconfirmed", data: { mock: true } });
    // 新增自己的目標 → 示範目標被取代（fixtures_active 變 false）。
    const created = (await (await a.post("/api/voice-relay/target", { locale: "zh-TW", output_device_id: "fake_speaker_1", voice_id: "Meijia", music_service: "youtube_music" })).json()) as VoiceRelayView;
    expect(created.fixtures_active).toBe(false);
    expect(created.targets.map((t) => t.id)).toEqual(["google_mini_1"]);
  });
});
