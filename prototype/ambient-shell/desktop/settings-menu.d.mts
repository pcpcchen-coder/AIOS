// desktop/settings-menu.mjs 的型別（給 tests/desktop-menu.test.ts；App 本身直接跑 .mjs）。
import type { MenuPrefSetting } from "../shared/seconds-menu.ts";
import type { SettingsView } from "../shared/types.ts";
import type { WakePrefs, WakeReason, WakeReport, WakeState } from "../shared/wake.ts";
import type { AudioMenuReport, AudioPrefsPatch, AudioSettingsView } from "../shared/audio-devices.ts";
import type { ProactivePrefsPatch, ProactiveSettingsView } from "../shared/proactive.ts";
import type { ClockPrefsPatch, ClockSettingsView } from "../shared/clock.ts";
import type { DayNightPatch, DayNightSettingsView } from "../shared/day-night.ts";
import type { HomeCornerPrefsPatch, HomeCornerSettingsView } from "../shared/home-corner.ts";
import type { MemoriesPrefsPatch, MemoriesSettingsView } from "../shared/memories.ts";

export interface MenuItemTemplate {
  label?: string;
  accelerator?: string;
  sublabel?: string;
  type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  click?: () => void;
  submenu?: MenuItemTemplate[];
}

export function radio(label: string, checked: boolean, click: () => void, enabled?: boolean): MenuItemTemplate;

export const WAKE_STATE_REASONS: Record<WakeState, readonly (WakeReason | null)[]>;
export const WAKE_STATE_LABEL: Record<WakeState, string>;
export const WAKE_REASON_LABEL: Record<WakeReason, string>;
export const WAKE_MENU_TEXT: Record<"group" | "statusPrefix" | "listen" | "listenNote" | "silence" | "silenceNote" | "pause" | "resume" | "speaker" | "speakerNote" | "voiceNameTest" | "voiceNameTestNote" | "notReported" | "threshold" | "thresholdNote", string>;
export const WAKE_THRESHOLD_OFFSETS: number[];
export const WAKE_THRESHOLD_LABEL: Record<string, string>;
export const WAKE_SILENCE_OPTIONS_S: number[];
export const DEFAULT_WAKE_SILENCE_S: number;
/** 「喚醒後等你開口」交給 setMenuPref 的列（main.mjs 的 setMenuPref 只用 key、kind、label、write_path）。 */
export interface WakeSilenceRow { key: "wake_silence_s"; kind: "seconds"; label: string; write_path: "/api/settings/wake" }
export interface WakeSpeakerRow { key: "speaker_in_call"; kind: "bool"; label: string; write_path: "/api/settings/wake" }
export interface WakeThresholdRow { key: "wake_threshold_offset"; kind: "threshold"; label: string; write_path: "/api/settings/wake" }
export function isWakeReport(value: unknown): value is WakeReport;
export function wakeMenu(
  wake: WakePrefs,
  report: WakeReport | null,
  handlers: {
    command(name: string): void;
    setWakeListen?(value: boolean): unknown;
    setVoiceNameTest?(value: boolean): unknown;
    setMenuPref?(row: WakeSilenceRow | WakeSpeakerRow | WakeThresholdRow, value: number | boolean): unknown;
    servicePaused?: boolean;
    translate?(source: string): string;
  },
): MenuItemTemplate[];

export const AUDIO_TEXT: Record<string, string>;
export function sanitizeAudioMenuReport(value: unknown): AudioMenuReport | null;
export function audioMenu(
  audio: AudioSettingsView,
  report: AudioMenuReport | null,
  handlers: { setAudio?(patch: AudioPrefsPatch): unknown; translate?(source: string, ...values: unknown[]): string },
): MenuItemTemplate[];

export const PROACTIVE_TEXT: Record<string, string>;
export function proactiveMenu(
  proactive: ProactiveSettingsView,
  handlers: { setProactive?(patch: ProactivePrefsPatch): unknown; translate?(source: string, ...values: unknown[]): string },
): MenuItemTemplate[];

export const CLOCK_TEXT: Record<string, string>;
export function clockMenu(
  clock: ClockSettingsView,
  handlers: { setClock?(patch: ClockPrefsPatch): unknown; translate?(source: string, ...values: unknown[]): string },
): MenuItemTemplate[];

export const DAY_NIGHT_TEXT: Record<string, string>;
export function dayNightMenu(
  dayNight: DayNightSettingsView,
  handlers: { setDayNight?(patch: DayNightPatch): unknown; translate?(source: string, ...values: unknown[]): string; now?: number },
): MenuItemTemplate[];

export const HOME_CORNER_TEXT: Record<string, string>;
export function homeCornerMenu(
  homeCorner: HomeCornerSettingsView,
  handlers: { setHomeCorner?(patch: HomeCornerPrefsPatch): unknown; translate?(source: string, ...values: unknown[]): string },
): MenuItemTemplate[];

export const MEMORIES_TEXT: Record<string, string>;
export function memoriesMenu(
  memories: MemoriesSettingsView,
  handlers: { setMemories?(patch: MemoriesPrefsPatch): unknown; memoriesGoogle?(action: "pick" | "cancel" | "clear"): unknown; openMemoriesFolder?(): unknown; translate?(source: string, ...values: unknown[]): string },
): MenuItemTemplate[];

export function settingsMenu(
  settings: SettingsView | null,
  handlers: {
    command(name: string): void;
    setMenuPref(row: MenuPrefSetting | WakeSilenceRow | WakeSpeakerRow, value: number | boolean): unknown;
    openFamily?(): void;
    setWakeListen?(value: boolean): unknown;
    setVoiceNameTest?(value: boolean): unknown;
    wakeReport?: WakeReport | null;
    wakeCommand?(name: string): void;
    setAudio?(patch: AudioPrefsPatch): unknown;
    audioReport?: AudioMenuReport | null;
    setProactive?(patch: ProactivePrefsPatch): unknown;
    setClock?(patch: ClockPrefsPatch): unknown;
    setDayNight?(patch: DayNightPatch): unknown;
    setHomeCorner?(patch: HomeCornerPrefsPatch): unknown;
    setMemories?(patch: MemoriesPrefsPatch): unknown;
    /** MEMO-2「Google 相簿」：pick（主程序開 picker_uri）、cancel、clear（主程序先確認）。 */
    memoriesGoogle?(action: "pick" | "cancel" | "clear"): unknown;
    /** 「打開回憶資料夾」：主程序用 Finder 打開核心的回憶資料夾（路徑不下發頁面）。 */
    openMemoriesFolder?(): unknown;
    /** 服務模式：鏡頭與常駐喚醒聆聽的開關、鏡頭畫面與家人辨識停用（保存的設定不變）。 */
    servicePaused?: boolean;
    translate?(source: string, ...values: unknown[]): string;
  },
): MenuItemTemplate[];

export const SERVICE_TEXT: Record<"connected" | "disconnected" | "note" | "exit" | "enter" | "enterNote" | "paused" | "needsWindow" | "settingsPaused", string>;
export function serviceStatusLine(terminal: { connected: boolean } | null | undefined): string;
export function serviceTray(options: {
  serviceMode: boolean;
  terminal?: { connected: boolean } | null;
  voiceOn?: boolean;
  showWindow(): void;
  command(name: string): void;
  enterService(): void;
  exitService(): void;
}): { head: MenuItemTemplate[]; actions: MenuItemTemplate[] };

export const REALTIME_METER_TEXT: Record<"tokens" | "liveUnknown" | "terminal", string>;
export function formatCallClock(ms: number): string;
export function realtimeMeter(active: NonNullable<SettingsView["realtime"]>["active"] | null | undefined, now: number, translate?: (source: string, ...values: unknown[]) => string): string;
