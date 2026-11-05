// desktop/settings-menu.mjs 的型別（給 tests/desktop-menu.test.ts；App 本身直接跑 .mjs）。
import type { MenuPrefSetting } from "../shared/seconds-menu.ts";
import type { SettingsView } from "../shared/types.ts";
import type { WakePrefs, WakeReason, WakeReport, WakeState } from "../shared/wake.ts";
import type { AudioMenuReport, AudioPrefsPatch, AudioSettingsView } from "../shared/audio-devices.ts";
import type { ProactivePrefsPatch, ProactiveSettingsView } from "../shared/proactive.ts";

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
export const WAKE_MENU_TEXT: Record<"group" | "statusPrefix" | "listen" | "listenNote" | "silence" | "silenceNote" | "pause" | "resume" | "speaker" | "speakerNote" | "voiceNameTest" | "voiceNameTestNote" | "notReported", string>;
export const WAKE_SILENCE_OPTIONS_S: number[];
export const DEFAULT_WAKE_SILENCE_S: number;
/** 「喚醒後等你開口」交給 setMenuPref 的列（main.mjs 的 setMenuPref 只用 key、kind、label、write_path）。 */
export interface WakeSilenceRow { key: "wake_silence_s"; kind: "seconds"; label: string; write_path: "/api/settings/wake" }
export interface WakeSpeakerRow { key: "speaker_in_call"; kind: "bool"; label: string; write_path: "/api/settings/wake" }
export function isWakeReport(value: unknown): value is WakeReport;
export function wakeMenu(
  wake: WakePrefs,
  report: WakeReport | null,
  handlers: {
    command(name: string): void;
    setWakeListen?(value: boolean): unknown;
    setVoiceNameTest?(value: boolean): unknown;
    setMenuPref?(row: WakeSilenceRow | WakeSpeakerRow, value: number | boolean): unknown;
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
