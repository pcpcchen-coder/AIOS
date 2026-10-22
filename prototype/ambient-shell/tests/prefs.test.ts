import { describe, expect, it } from "vitest";
import { formatSeconds, onStep, stepPref, type SecondsPrefSpec } from "../shared/prefs.ts";
import { CAMERA_DISABLED_REASON, describeSeconds, VOICE_UNSAVED_REASON, type SecondsSetting } from "../shared/seconds-menu.ts";
import { CAMERA_PREFS, DEFAULT_CAMERA_PREFS, parseCameraPatch, type CameraSettings } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS, parseVoicePatch, VOICE_PREFS, VoicePatchError } from "../shared/voice-prefs.ts";

const TABLES = [
  { name: "CAMERA_PREFS", specs: CAMERA_PREFS as Record<string, { kind: string }>, parse: parseCameraPatch },
  { name: "VOICE_PREFS", specs: VOICE_PREFS as Record<string, { kind: string }>, parse: parseVoicePatch },
];
const SECONDS = TABLES.flatMap(({ name, specs, parse }) =>
  Object.entries(specs)
    .filter(([, spec]) => spec.kind === "seconds")
    .map(([key, spec]) => [`${name}.${key}`, key, spec as SecondsPrefSpec, parse] as const),
);

const camera: CameraSettings = {
  enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS,
};
const realtime = { available: true, model: "gpt-realtime", detail: "OPENAI_API_KEY 已設定" };

function rowOf(rows: SecondsSetting[], key: string): SecondsSetting {
  return rows.find((r) => r.key === key)!;
}

describe("seconds pref specs", () => {
  it("covers all four seconds settings", () => {
    expect(SECONDS.map(([id]) => id)).toEqual([
      "CAMERA_PREFS.look_to_talk_s",
      "CAMERA_PREFS.look_to_talk_cooldown_s",
      "VOICE_PREFS.voice_idle_s",
      "VOICE_PREFS.realtime_idle_s",
    ]);
  });

  it.each(SECONDS)("%s: presets are ascending, unique, on step, in range, include the default, and pass the store's parse", (_id, key, spec, parse) => {
    expect(spec.presets.length).toBeGreaterThan(1);
    for (let i = 1; i < spec.presets.length; i++) expect(spec.presets[i]).toBeGreaterThan(spec.presets[i - 1]);
    expect(spec.presets).toContain(spec.default);
    for (const v of [...spec.presets, spec.default]) {
      expect(v).toBeGreaterThanOrEqual(spec.min);
      expect(v).toBeLessThanOrEqual(spec.max);
      expect(onStep(v, spec.step)).toBe(true);
      expect(parse({ [key]: v })).toEqual({ [key]: v });
    }
  });
});

describe("VOICE_PREFS", () => {
  it("defaults keep today's timings (90 s voice mode, 120 s realtime)", () => {
    expect(DEFAULT_VOICE_PREFS).toEqual({ voice_idle_s: 90, realtime_idle_s: 120 });
  });

  it("parseVoicePatch accepts bounds and rejects unknown keys, wrong types, out-of-range and off-step values", () => {
    expect(parseVoicePatch({})).toEqual({});
    expect(parseVoicePatch({ voice_idle_s: 30, realtime_idle_s: 600 })).toEqual({ voice_idle_s: 30, realtime_idle_s: 600 });
    for (const bad of [null, [], "x", 1]) expect(() => parseVoicePatch(bad)).toThrow(VoicePatchError);
    expect(() => parseVoicePatch({ active: true })).toThrow(/未知的語音設定/);
    expect(() => parseVoicePatch({ voice_idle_s: "90" })).toThrow(VoicePatchError);
    expect(() => parseVoicePatch({ voice_idle_s: 20 })).toThrow(VoicePatchError);
    expect(() => parseVoicePatch({ realtime_idle_s: 610 })).toThrow(VoicePatchError);
    expect(() => parseVoicePatch({ voice_idle_s: 95 })).toThrow(/30–600 秒、間隔 10/);
    expect(() => parseVoicePatch({ voice_idle_s: Number.POSITIVE_INFINITY })).toThrow(VoicePatchError);
  });

  it("stepPref moves one step and clamps", () => {
    expect(stepPref(VOICE_PREFS.voice_idle_s, 90, 1)).toBe(100);
    expect(stepPref(VOICE_PREFS.voice_idle_s, 30, -1)).toBe(30);
    expect(stepPref(VOICE_PREFS.realtime_idle_s, 600, 1)).toBe(600);
  });
});

describe("formatSeconds", () => {
  it.each([
    [0.5, "0.5 秒"], [1, "1 秒"], [1.5, "1.5 秒"], [1.6, "1.6 秒"], [45, "45 秒"],
    [60, "1 分鐘"], [90, "1 分 30 秒"], [120, "2 分鐘"], [600, "10 分鐘"],
  ])("%s → %s", (seconds, text) => {
    expect(formatSeconds(seconds)).toBe(text);
  });
});

describe("describeSeconds", () => {
  it("one row per seconds spec in table order, each with exactly one checked option equal to the live value", () => {
    const rows = describeSeconds({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime });
    expect(rows.map((r) => [r.key, r.group, r.group_label, r.write_path])).toEqual([
      ["look_to_talk_s", "camera", "鏡頭", "/api/settings/camera"],
      ["look_to_talk_cooldown_s", "camera", "鏡頭", "/api/settings/camera"],
      ["voice_idle_s", "voice", "語音", "/api/settings/voice"],
      ["realtime_idle_s", "voice", "語音", "/api/settings/voice"],
    ]);
    for (const r of rows) {
      const checked = r.options.filter((o) => o.checked);
      expect(checked).toHaveLength(1);
      expect(checked[0].value).toBe(r.value);
      expect(r.disabled_reason).toBeNull();
    }
    expect(rowOf(rows, "look_to_talk_s")).toMatchObject({
      label: "面向螢幕幾秒後開始對話",
      value_label: "1.5 秒",
      options: [
        { value: 1, label: "1 秒", checked: false },
        { value: 1.5, label: "1.5 秒（預設）", checked: true },
        { value: 2, label: "2 秒", checked: false },
        { value: 3, label: "3 秒", checked: false },
      ],
    });
    expect(rowOf(rows, "voice_idle_s").options.map((o) => o.label)).toEqual(["30 秒", "1 分鐘", "1 分 30 秒（預設）", "2 分鐘", "3 分鐘", "5 分鐘"]);
    expect(rowOf(rows, "realtime_idle_s").note).toBe(VOICE_PREFS.realtime_idle_s.hint);
  });

  it("inserts an off-preset live value in order as a checked 「（目前）」 option", () => {
    const rows = describeSeconds({ camera: { ...camera, look_to_talk_s: 1.6 }, voice: { voice_idle_s: 70, realtime_idle_s: 120 }, voiceWritable: true, realtime });
    const look = rowOf(rows, "look_to_talk_s");
    expect(look.options.map((o) => [o.label, o.checked])).toEqual([
      ["1 秒", false], ["1.5 秒（預設）", false], ["1.6 秒（目前）", true], ["2 秒", false], ["3 秒", false],
    ]);
    expect(look.value_label).toBe("1.6 秒");
    expect(rowOf(rows, "voice_idle_s").options.map((o) => o.label)).toContain("1 分 10 秒（目前）");
  });

  it("camera rows are disabled with the reason when the camera is not enabled or not configured; voice rows still work", () => {
    for (const source of [{ camera: { ...camera, enabled: false } }, {}]) {
      const rows = describeSeconds({ ...source, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime });
      expect(rows.filter((r) => r.group === "camera").map((r) => r.disabled_reason)).toEqual([CAMERA_DISABLED_REASON, CAMERA_DISABLED_REASON]);
      expect(rows.filter((r) => r.group === "voice").map((r) => r.disabled_reason)).toEqual([null, null]);
    }
  });

  it("notes say when a value is unused right now, without disabling it", () => {
    const rows = describeSeconds({
      camera: { ...camera, look_to_talk: false },
      voice: DEFAULT_VOICE_PREFS,
      voiceWritable: false,
      realtime: { available: false, model: "gpt-realtime", detail: "未設定 OPENAI_API_KEY" },
    });
    expect(rowOf(rows, "look_to_talk_s")).toMatchObject({ disabled_reason: null, note: "看著說話目前關閉，這個秒數暫時用不到" });
    expect(rowOf(rows, "realtime_idle_s")).toMatchObject({ note: "即時語音目前不可用（未設定 OPENAI_API_KEY）" });
    expect(rowOf(rows, "voice_idle_s").disabled_reason).toBe(VOICE_UNSAVED_REASON);
  });
});
