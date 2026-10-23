import { describe, expect, it } from "vitest";
import { formatFactor, formatSeconds, onStep, snapToStep, stepPref, type NumberPrefSpec, type SecondsPrefSpec } from "../shared/prefs.ts";
import { CAMERA_DISABLED_REASON, CAMERA_OFF_PREVIEW_REASON, cameraPreviewDisabledReason, describeMenuPrefs, describeSeconds, isNumberRow, VOICE_UNSAVED_REASON, type MenuBoolSetting, type MenuNumberSetting, type MenuPrefSetting, type SecondsSetting } from "../shared/seconds-menu.ts";
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

const FACTORS = TABLES.flatMap(({ name, specs, parse }) =>
  Object.entries(specs)
    .filter(([, spec]) => spec.kind === "factor")
    .map(([key, spec]) => [`${name}.${key}`, key, spec as NumberPrefSpec, parse] as const),
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

  it.each([...SECONDS, ...FACTORS])("%s: presets are ascending, unique, on step, in range, include the default, and pass the store's parse", (_id, key, spec, parse) => {
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

describe("factor pref specs", () => {
  it("covers the one factor setting", () => {
    expect(FACTORS.map(([id]) => id)).toEqual(["CAMERA_PREFS.brain_zoom_max"]);
  });

  it.each([[1, "1 倍"], [1.5, "1.5 倍"], [2, "2 倍"], [2.3, "2.3 倍"], [3, "3 倍"]])("formatFactor(%s) → %s", (factor, text) => {
    expect(formatFactor(factor)).toBe(text);
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

  it("a value within onStep's tolerance is stored on the grid, so the menu shows no duplicate", () => {
    expect(parseVoicePatch({ voice_idle_s: 90.000001 })).toEqual({ voice_idle_s: 90 });
    expect(parseVoicePatch({ realtime_idle_s: 119.9999999 })).toEqual({ realtime_idle_s: 120 });
    expect(parseCameraPatch({ look_to_talk_s: 1.6000001 })).toEqual({ look_to_talk_s: 1.6 });
    expect(snapToStep(0.1 + 0.2, 0.1)).toBe(0.3);
    const voice = { ...DEFAULT_VOICE_PREFS, ...parseVoicePatch({ voice_idle_s: 90.000001 }) };
    const row = rowOf(describeSeconds({ camera, voice, voiceWritable: true, realtime }), "voice_idle_s");
    expect(row.options.map((o) => o.label)).toEqual(["30 秒", "1 分鐘", "1 分 30 秒（預設）", "2 分鐘", "3 分鐘", "5 分鐘"]);
    expect(row.options.filter((o) => o.checked).map((o) => o.value)).toEqual([90]);
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

describe("describeMenuPrefs (tray rows: seconds and factor)", () => {
  function zoomRow(rows: MenuPrefSetting[]): MenuNumberSetting {
    return rows.filter(isNumberRow).find((r) => r.key === "brain_zoom_max")!;
  }

  it("adds the brain zoom factor row after the camera seconds, with its presets and the live value checked", () => {
    const rows = describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime });
    expect(rows.map((r) => [r.key, r.kind, r.group])).toEqual([
      ["active", "bool", "camera"],
      ["look_to_talk", "bool", "camera"],
      ["look_to_talk_s", "seconds", "camera"],
      ["look_to_talk_cooldown_s", "seconds", "camera"],
      ["look_to_talk_greet", "bool", "camera"],
      ["stop_gesture", "bool", "camera"],
      ["brain_zoom_max", "factor", "camera"],
      ["voice_idle_s", "seconds", "voice"],
      ["realtime_idle_s", "seconds", "voice"],
    ]);
    expect(zoomRow(rows)).toEqual({
      key: "brain_zoom_max",
      kind: "factor",
      group: "camera",
      group_label: "鏡頭與手勢",
      label: "靠近時電子腦放大倍率",
      value: 2,
      value_label: "2 倍",
      options: [
        { value: 1, label: "1 倍", checked: false },
        { value: 1.5, label: "1.5 倍", checked: false },
        { value: 2, label: "2 倍（預設）", checked: true },
        { value: 2.5, label: "2.5 倍", checked: false },
        { value: 3, label: "3 倍", checked: false },
      ],
      disabled_reason: null,
      note: CAMERA_PREFS.brain_zoom_max.hint,
      write_path: "/api/settings/camera",
    });
    expect(CAMERA_PREFS.brain_zoom_max.hint).toContain("0.6 m");
    expect(CAMERA_PREFS.brain_zoom_max.hint).toContain("2.5 m");
  });

  it("an off-preset live factor is inserted as a checked 「（目前）」 option", () => {
    const row = zoomRow(describeMenuPrefs({ camera: { ...camera, brain_zoom_max: 2.3 }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
    expect(row.value_label).toBe("2.3 倍");
    expect(row.options.map((o) => [o.label, o.checked])).toEqual([
      ["1 倍", false], ["1.5 倍", false], ["2 倍（預設）", false], ["2.3 倍（目前）", true], ["2.5 倍", false], ["3 倍", false],
    ]);
  });

  it("the factor row is disabled with the camera, notes when the camera is off, and ignores look-to-talk", () => {
    expect(zoomRow(describeMenuPrefs({ voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime })).disabled_reason).toBe(CAMERA_DISABLED_REASON);
    const off = zoomRow(describeMenuPrefs({ camera: { ...camera, active: false, look_to_talk: false }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
    expect(off).toMatchObject({ disabled_reason: null, note: "鏡頭目前關閉，量不到距離，電子腦不會放大" });
    const noLook = zoomRow(describeMenuPrefs({ camera: { ...camera, look_to_talk: false }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
    expect(noLook.note).toBe(CAMERA_PREFS.brain_zoom_max.hint);
  });

  it("describeSeconds is describeMenuPrefs without the factor and bool rows", () => {
    const source = { camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime };
    expect(describeSeconds(source)).toEqual(describeMenuPrefs(source).filter((r) => r.kind === "seconds"));
  });
});

describe("describeMenuPrefs (tray rows: camera switches)", () => {
  function boolRows(rows: MenuPrefSetting[]): MenuBoolSetting[] {
    return rows.filter((r): r is MenuBoolSetting => r.kind === "bool");
  }
  const unavailable = { available: false, model: "gpt-realtime", detail: "未設定 OPENAI_API_KEY" };

  it("one checkbox row per CAMERA_PREFS bool, in table order, with the live value and the spec's label and hint", () => {
    const rows = boolRows(describeMenuPrefs({ camera: { ...camera, stop_gesture: false }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
    expect(rows.map((r) => r.key)).toEqual(Object.entries(CAMERA_PREFS).filter(([, s]) => s.kind === "bool").map(([k]) => k));
    expect(rows.map((r) => [r.label, r.value, r.value_label])).toEqual([
      ["鏡頭", true, "開"],
      ["看著說話", true, "開"],
      ["看著說話時先打招呼", true, "開"],
      ["手掌停止播報", false, "關"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ group: "camera", group_label: "鏡頭與手勢", disabled_reason: null, write_path: "/api/settings/camera" });
      expect(r.note).toBe(CAMERA_PREFS[r.key].hint);
      expect(r).not.toHaveProperty("options");
    }
  });

  it("all switches are disabled with CAMERA_DISABLED_REASON when the camera is not enabled or not configured (defaults shown)", () => {
    for (const source of [{ camera: { ...camera, enabled: false } }, {}]) {
      const rows = boolRows(describeMenuPrefs({ ...source, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.disabled_reason === CAMERA_DISABLED_REASON)).toBe(true);
    }
    const none = boolRows(describeMenuPrefs({ voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }));
    expect(none.map((r) => r.value)).toEqual([true, true, true, true]);
  });

  it("look_to_talk notes that realtime voice is needed when it is unavailable (same hint as the settings page)", () => {
    for (const rt of [unavailable, undefined]) {
      const row = boolRows(describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime: rt })).find((r) => r.key === "look_to_talk")!;
      expect(row).toMatchObject({ disabled_reason: null, note: `${CAMERA_PREFS.look_to_talk.hint}；需要即時語音（目前不可用）` });
    }
  });

  it("camera switched off: the other switches note that, like the zoom row; the 鏡頭 switch keeps its hint", () => {
    const rows = boolRows(describeMenuPrefs({ camera: { ...camera, active: false, look_to_talk: false }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime: unavailable }));
    expect(rows.map((r) => [r.key, r.disabled_reason, r.note])).toEqual([
      ["active", null, CAMERA_PREFS.active.hint],
      ["look_to_talk", null, "鏡頭目前關閉，這個開關暫時用不到"],
      ["look_to_talk_greet", null, "鏡頭目前關閉，這個開關暫時用不到"],
      ["stop_gesture", null, "鏡頭目前關閉，這個開關暫時用不到"],
    ]);
  });

  it("cameraPreviewDisabledReason: not enabled → CAMERA_DISABLED_REASON; switched off → 「鏡頭目前關閉…」; on → null", () => {
    expect(cameraPreviewDisabledReason(undefined)).toBe(CAMERA_DISABLED_REASON);
    expect(cameraPreviewDisabledReason({ ...camera, enabled: false })).toBe(CAMERA_DISABLED_REASON);
    expect(cameraPreviewDisabledReason({ ...camera, active: false })).toBe(CAMERA_OFF_PREVIEW_REASON);
    expect(cameraPreviewDisabledReason(camera)).toBeNull();
  });

  it("the greeting switch notes when look-to-talk is off, without disabling it", () => {
    const row = boolRows(describeMenuPrefs({ camera: { ...camera, look_to_talk: false }, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime })).find((r) => r.key === "look_to_talk_greet")!;
    expect(row).toMatchObject({ disabled_reason: null, value: true, note: "看著說話目前關閉，這個開關暫時用不到" });
  });
});

describe("describeSeconds", () => {
  it("one row per seconds spec in table order, each with exactly one checked option equal to the live value", () => {
    const rows = describeSeconds({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime });
    expect(rows.map((r) => [r.key, r.group, r.group_label, r.write_path])).toEqual([
      ["look_to_talk_s", "camera", "鏡頭與手勢", "/api/settings/camera"],
      ["look_to_talk_cooldown_s", "camera", "鏡頭與手勢", "/api/settings/camera"],
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
