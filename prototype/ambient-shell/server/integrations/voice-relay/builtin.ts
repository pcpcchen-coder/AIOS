import { GENRES, RELAY_SCHEMA_VERSION, type CommandEntry, type CommandPack, type IntentDef, type Target, type VoiceDefault, type VoiceProfile } from "../../../shared/voice-relay.ts";
import type { RelayUserConfig } from "./catalog.ts";

// VCR-0（docs/19 §4.3）：內建資料。
// - 意圖目錄：V1 只有低風險的音樂、音量、燈光、計時；沒有付款、門鎖、保全、購物、帳號類意圖。
// - Google Home Mini 的 zh-TW／en-US 命令說法全部是「候選」（candidate、NOT_TESTED）：沒有在實體音箱上測過，
//   不是官方相容保證。Apple／Amazon／Xiaomi 只有空的命令包（還沒有任何候選說法）。
// - 聲線與裝置表是示範資料（fixture）：聲音沒有在任何 Mac 上驗證；裝置表只在 NOUS_VCR=fake 使用。

export const BUILTIN_CATALOG_VERSION = 1;

const required = true as const;
const percent = { kind: "integer", min: 0, max: 100, required } as const;

export const BUILTIN_INTENTS: readonly IntentDef[] = [
  { id: "music.next", riskClass: "low", category: "music", slots: {} },
  { id: "music.pause", riskClass: "low", category: "music", slots: {} },
  { id: "music.resume", riskClass: "low", category: "music", slots: {} },
  { id: "music.play_genre", riskClass: "low", category: "music", slots: { genre: { kind: "enum", values: GENRES, required } } },
  { id: "volume.set", riskClass: "low", category: "volume", slots: { percent } },
  { id: "light.power", riskClass: "low", category: "light", slots: { device: { kind: "device", deviceKind: "light", required }, on: { kind: "boolean", required } } },
  { id: "light.brightness", riskClass: "low", category: "light", slots: { device: { kind: "device", deviceKind: "light", required }, percent } },
  { id: "assistant.timer", riskClass: "low", category: "timer", slots: { seconds: { kind: "integer", min: 1, max: 3600, required } } },
];

const SOURCE = "docs/19 §4.3 candidate (待實測; not an official compatibility guarantee)";

/** 候選說法（selected 預設 true；status candidate、NOT_TESTED）。 */
function candidate(templateId: string, intentId: CommandEntry["intentId"], utteranceTemplate: string, downstreamService: CommandEntry["downstreamService"], extra: Partial<CommandEntry> = {}): CommandEntry {
  return { templateId, version: 1, intentId, utteranceTemplate, selected: true, supported: true, status: "candidate", downstreamService, source: SOURCE, testedOn: null, testResult: "NOT_TESTED", ...extra };
}

const GENRE_ZH = { pop: "流行", jazz: "爵士", classical: "古典", rock: "搖滾", lofi: "Lo-Fi", kids: "兒童" };
const GENRE_EN = { pop: "pop", jazz: "jazz", classical: "classical", rock: "rock", lofi: "lo-fi", kids: "kids" };

const googleMini = { scope: "model", vendor: "google", assistant: "google_assistant", model: "home_mini" } as const;

export const BUILTIN_PACKS: readonly CommandPack[] = [
  {
    id: "google.home_mini.zh-TW.v1",
    version: 1,
    ...googleMini,
    locale: "zh-TW",
    wakePhrases: [
      { id: "google.wake.ok.zh", text: "Ok Google", selected: true },
      { id: "google.wake.hey.zh", text: "Hey Google", selected: false },
    ],
    entries: [
      candidate("google.next.zh1", "music.next", "下一首歌", "configured_music_service"),
      candidate("google.pause.zh1", "music.pause", "暫停音樂", "configured_music_service"),
      candidate("google.resume.zh1", "music.resume", "繼續播放", "configured_music_service"),
      candidate("google.genre.zh1", "music.play_genre", "播放{genre}音樂", "configured_music_service", { slotText: { genre: GENRE_ZH } }),
      // 只用來證明政策會擋下 Spotify（不選定）。
      candidate("google.genre_spotify.zh1", "music.play_genre", "用 Spotify 播放{genre}音樂", "spotify", { selected: false, slotText: { genre: GENRE_ZH } }),
      candidate("google.volume.zh1", "volume.set", "音量調到百分之{percent}", "assistant_builtin"),
      candidate("google.light.zh1", "light.power", "{on}{device}", "smart_home", { slotText: { on: { true: "打開", false: "關掉" } } }),
      candidate("google.brightness.zh1", "light.brightness", "把{device}的亮度調到百分之{percent}", "smart_home"),
    ],
  },
  {
    id: "google.home_mini.en-US.v1",
    version: 1,
    ...googleMini,
    locale: "en-US",
    wakePhrases: [
      { id: "google.wake.ok.en", text: "Ok Google", selected: true },
      { id: "google.wake.hey.en", text: "Hey Google", selected: false },
    ],
    entries: [
      candidate("google.next.en1", "music.next", "next song", "configured_music_service"),
      candidate("google.pause.en1", "music.pause", "pause the music", "configured_music_service"),
      candidate("google.resume.en1", "music.resume", "resume the music", "configured_music_service"),
      candidate("google.genre.en1", "music.play_genre", "play {genre} music", "configured_music_service", { slotText: { genre: GENRE_EN } }),
      candidate("google.genre_spotify.en1", "music.play_genre", "play {genre} music on Spotify", "spotify", { selected: false, slotText: { genre: GENRE_EN } }),
      candidate("google.volume.en1", "volume.set", "set the volume to {percent} percent", "assistant_builtin"),
      candidate("google.light.en1", "light.power", "turn {on} the {device}", "smart_home", { slotText: { on: { true: "on", false: "off" } } }),
      candidate("google.brightness.en1", "light.brightness", "set the {device} brightness to {percent} percent", "smart_home"),
    ],
  },
  // 還沒有任何候選說法的品牌（空的命令包；任何意圖都會是 unsupported_intent）。
  { id: "apple.homepod.zh-TW.v0", version: 1, scope: "model", vendor: "apple", assistant: "siri", model: "homepod_mini", locale: "zh-TW", wakePhrases: [], entries: [] },
  { id: "amazon.echo.en-US.v0", version: 1, scope: "model", vendor: "amazon", assistant: "alexa", model: "echo_dot", locale: "en-US", wakePhrases: [], entries: [] },
  { id: "xiaomi.xiaoai.zh-CN.v0", version: 1, scope: "model", vendor: "xiaomi", assistant: "xiaoai", model: "xiaoai_speaker", locale: "zh-CN", wakePhrases: [], entries: [] },
];

const voice = (id: string, voiceId: string, locale: string, patch: Partial<VoiceProfile> = {}): VoiceProfile => ({
  id, engine: "macos_say", voiceId, locale, rate: 1, pitch: 0, gainDb: 0, wakeToCommandPauseMs: 600, leadSilenceMs: 300, tailSilenceMs: 300, testedAt: null, recognitionStatsId: null, fixture: true, ...patch,
});

/** 示範聲線（fixture）：聲音名稱沒有在任何 Mac 上驗證過。 */
export const BUILTIN_PROFILES: readonly VoiceProfile[] = [
  voice("google_zh_a", "Meijia", "zh-TW"),
  voice("google_zh_b", "Meijia", "zh-TW", { rate: 0.9, wakeToCommandPauseMs: 1000 }),
  voice("google_en_a", "Samantha", "en-US"),
  voice("google_en_b", "Alex", "en-US", { wakeToCommandPauseMs: 1000 }),
];

export const BUILTIN_VOICE_DEFAULTS: readonly VoiceDefault[] = [
  { vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", voiceProfileId: "google_zh_a" },
  { vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "en-US", voiceProfileId: "google_en_a" },
];

const FIXTURE_NOTE = "fixture only — not a real test result";
const approveSelected = (packId: string) =>
  BUILTIN_PACKS.find((p) => p.id === packId)!.entries
    .filter((e) => e.selected && e.downstreamService !== "spotify")
    .map((e) => ({ templateId: e.templateId, version: e.version, status: "approved" as const, reviewedAt: "fixture", note: FIXTURE_NOTE }));

/** 示範裝置表（只在 NOUS_VCR=fake；輸出是假的，沒有實體喇叭）。 */
export const FIXTURE_TARGETS: readonly Target[] = [
  {
    id: "fixture_google_mini_zh", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "zh-TW", enabled: true,
    outputNode: "fake_node", outputDeviceId: "fake_speaker_1", voiceProfileId: "google_zh_a", candidateVoiceProfileIds: ["google_zh_b"],
    templateOverrides: {}, reviewedTemplates: approveSelected("google.home_mini.zh-TW.v1"), musicService: "youtube_music",
    devices: [{ id: "fixture_light", kind: "light", name: "測試燈" }], fixture: true,
  },
  {
    id: "fixture_google_mini_en", vendor: "google", assistant: "google_assistant", model: "home_mini", locale: "en-US", enabled: true,
    outputNode: "fake_node", outputDeviceId: "fake_speaker_2", voiceProfileId: "google_en_a", candidateVoiceProfileIds: ["google_en_b"],
    templateOverrides: {}, reviewedTemplates: approveSelected("google.home_mini.en-US.v1"), musicService: "youtube_music",
    devices: [{ id: "fixture_light", kind: "light", name: "test lamp" }], fixture: true,
  },
];

/**
 * 組出整份目錄（尚未驗證）：內建意圖＋內建命令包＋使用者額外命令包；內建聲線＋使用者聲線；
 * 預設聲線以使用者的為準（同一組品牌／助理／型號／語系覆蓋內建）；裝置表：有設定檔就只用設定檔的；
 * 沒有設定檔時，fixtures（只在 NOUS_VCR=fake）用示範目標，否則（mac）沒有任何目標。
 */
export function composeRelayDocument(user: RelayUserConfig | null, opts: { fixtures: boolean } = { fixtures: true }): unknown {
  const userDefaults = (user?.voiceDefaults ?? []) as Partial<VoiceDefault>[];
  const key = (d: Partial<VoiceDefault> | null) => `${d?.vendor}|${d?.assistant}|${d?.model ?? ""}|${d?.locale}`;
  const overridden = new Set(userDefaults.map(key));
  return {
    schemaVersion: RELAY_SCHEMA_VERSION,
    catalogVersion: BUILTIN_CATALOG_VERSION,
    intents: BUILTIN_INTENTS,
    packs: [...BUILTIN_PACKS, ...(user?.commandPacks ?? [])],
    profiles: [...BUILTIN_PROFILES, ...(user?.voiceProfiles ?? [])],
    voiceDefaults: [...BUILTIN_VOICE_DEFAULTS.filter((d) => !overridden.has(key(d))), ...userDefaults],
    targets: user ? (user.targets ?? []) : opts.fixtures ? FIXTURE_TARGETS : [],
  };
}
