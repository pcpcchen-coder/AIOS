export type Locale = 'zh-TW' | 'en';
export const LOCALES: readonly Locale[];
export const DEFAULT_LOCALE: 'zh-TW';
export function normalizeLocale(value: unknown): Locale;
export function registerMessages(catalog: Record<string, string>): void;
export function translate(source: string, locale?: Locale, ...values: unknown[]): string;
