// desktop/settings-menu.mjs 的型別（給 tests/desktop-menu.test.ts；App 本身直接跑 .mjs）。
import type { MenuPrefSetting } from "../shared/seconds-menu.ts";
import type { SettingsView } from "../shared/types.ts";

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

export function settingsMenu(
  settings: SettingsView | null,
  handlers: { command(name: string): void; setMenuPref(row: MenuPrefSetting, value: number | boolean): unknown },
): MenuItemTemplate[];
