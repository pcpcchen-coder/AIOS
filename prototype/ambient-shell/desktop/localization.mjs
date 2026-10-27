import { normalizeLocale, registerMessages, translate } from "../shared/i18n.mjs";
import messages from "./messages.en.json" with { type: "json" };
import serverMessages from "../server/messages.en.json" with { type: "json" };

registerMessages(serverMessages);
registerMessages(messages);
let currentLocale = "zh-TW";
export const isLocale = (value) => value === "zh-TW" || value === "en";
export const getNativeLocale = () => currentLocale;
export function setNativeLocale(value) { currentLocale = normalizeLocale(value); }
export function t(source, ...values) { return translate(source, currentLocale, ...values); }

export function localizeMenu(items, locale = currentLocale) {
  return items.map((item) => ({
    ...item,
    ...(typeof item.label === "string" ? { label: translate(item.label, locale) } : {}),
    ...(typeof item.sublabel === "string" ? { sublabel: translate(item.sublabel, locale) } : {}),
    ...(Array.isArray(item.submenu) ? { submenu: localizeMenu(item.submenu, locale) } : {}),
  }));
}

export function localizeDialog(options, locale = currentLocale) {
  const localized = { ...options };
  for (const key of ["title", "message", "detail", "checkboxLabel"]) {
    if (typeof options[key] === "string") localized[key] = translate(options[key], locale);
  }
  if (Array.isArray(options.buttons)) localized.buttons = options.buttons.map((button) => translate(button, locale));
  return localized;
}

export function languageMenu(locale, change) {
  return {
    label: "語言 / Language",
    submenu: [
      { label: "繁體中文", type: "radio", checked: locale === "zh-TW", click: () => change("zh-TW") },
      { label: "English", type: "radio", checked: locale === "en", click: () => change("en") },
    ],
  };
}

export function trustedLocaleSender(event, win, coreUrl) {
  if (!event || !win || win.isDestroyed?.() || event.sender !== win.webContents || event.senderFrame !== win.webContents?.mainFrame) return false;
  try {
    const page = new URL(event.senderFrame.url);
    const core = new URL(coreUrl);
    return page.origin === core.origin && (page.pathname === "/" || page.pathname === "/index.html");
  } catch { return false; }
}
