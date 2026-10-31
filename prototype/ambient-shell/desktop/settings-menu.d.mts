// desktop/settings-menu.mjs 的型別（給 tests/desktop-menu.test.ts；App 本身直接跑 .mjs）。
import type { MenuPrefSetting } from "../shared/seconds-menu.ts";
import type { SettingsView } from "../shared/types.ts";
import type { WakePrefs, WakeReason, WakeReport, WakeState } from "../shared/wake.ts";

export interface MenuItemTemplate {
  label?: string;
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
export const WAKE_MENU_TEXT: Record<"group" | "statusPrefix" | "listen" | "listenNote" | "pause" | "resume" | "speaker" | "speakerNote" | "notReported", string>;
export function isWakeReport(value: unknown): value is WakeReport;
export function wakeMenu(
  wake: WakePrefs,
  report: WakeReport | null,
  handlers: { command(name: string): void; setWakeListen?(value: boolean): unknown; translate?(source: string): string },
): MenuItemTemplate[];

export function settingsMenu(
  settings: SettingsView | null,
  handlers: {
    command(name: string): void;
    setMenuPref(row: MenuPrefSetting, value: number | boolean): unknown;
    openFamily?(): void;
    setWakeListen?(value: boolean): unknown;
    wakeReport?: WakeReport | null;
    wakeCommand?(name: string): void;
    translate?(source: string): string;
  },
): MenuItemTemplate[];
