import type { Locale } from "../shared/i18n.mjs";
export function isLocale(value: unknown): value is Locale;
export function getNativeLocale(): Locale;
export function setNativeLocale(value: unknown): void;
export function t(source: string, ...values: unknown[]): string;
export interface LocalizableMenuItem { label?: string; sublabel?: string; submenu?: LocalizableMenuItem[]; }
export function localizeMenu<T extends LocalizableMenuItem>(items: T[], locale?: Locale): T[];
export function localizeDialog<T extends Record<string, unknown>>(options: T, locale?: Locale): T;
export function languageMenu(locale: Locale, change: (locale: Locale) => unknown): { label: string; submenu: { label: string; type: "radio"; checked: boolean; click(): unknown }[] };
export function trustedLocaleSender(event: unknown, win: unknown, coreUrl: unknown): boolean;
