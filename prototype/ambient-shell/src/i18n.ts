import { normalizeLocale, registerMessages, translate, type Locale } from "../shared/i18n.mjs";
import messages from "./messages.en.json" with { type: "json" };

import serverMessages from "../server/messages.en.json" with { type: "json" };

registerMessages(serverMessages);
registerMessages(messages);
export type { Locale };
export const LOCALE_KEY = "nous.locale";
const listeners = new Set<(locale: Locale) => void>();

function savedLocale(): Locale {
  try { return normalizeLocale(globalThis.localStorage?.getItem(LOCALE_KEY)); }
  catch { return "zh-TW"; }
}
function initialLocale(): Locale {
  if (typeof window !== "undefined" && window.nousDesktop?.initialLocale) return normalizeLocale(window.nousDesktop.initialLocale);
  return savedLocale();
}
let locale: Locale = initialLocale();
export function getLocale(): Locale { return locale; }
export function t(source: string, ...values: unknown[]): string { return translate(source, locale, ...values); }
export function uiText(source: string): string {
  const direct = t(source);
  if (locale !== "en" || direct !== source) return direct;
  return source.split(/(；|、|\n)/u).map(part => part === "；" ? "; " : part === "、" ? ", " : t(part)).join("");
}

export function transcriptText(speaker: "user" | "assistant", text: string, interim = false): string {
  return t(speaker === "user" ? "你：{0}" : "Nous：{0}", text) + (interim ? "…" : "");
}

export function msg(parts: TemplateStringsArray, ...values: unknown[]): string {
  const source = parts.reduce((text, part, i) => text + (i ? `{${i - 1}}` : "") + part, "");
  return t(source, ...values);
}
function applyLanguage(): void {
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = locale === "en" ? "en" : "zh-Hant-TW";
}
function updateLocale(value: unknown, persist: boolean): void {
  const next = normalizeLocale(value);
  if (persist) { try { globalThis.localStorage?.setItem(LOCALE_KEY, next); } catch {} }
  if (next === locale) { applyLanguage(); return; }
  locale = next;
  applyLanguage();
  for (const listener of [...listeners]) listener(locale);
}
export function setLocale(value: Locale): void { updateLocale(value, true); }
/** 只換這一頁的介面語言，不寫入共用的語言偏好（成果紀錄獨立網頁的 ?lang= 與語言切換用）。 */
export function useLocale(value: Locale): void { updateLocale(value, false); }
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function applyStaticTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n ?? ""); });
  for (const attribute of ["aria-label", "title", "placeholder"]) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach(el => {
      el.setAttribute(attribute, t(el.getAttribute(`data-i18n-${attribute}`) ?? ""));
    });
  }
}
applyLanguage();
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === LOCALE_KEY) updateLocale(event.newValue, false);
});
