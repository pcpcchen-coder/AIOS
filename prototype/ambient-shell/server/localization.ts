import { registerMessages, translate, type Locale } from "../shared/i18n.mjs";
import type { SettingsView } from "../shared/types.ts";
import messages from "./messages.en.json";

registerMessages(messages);

export function localize(text: string, locale: Locale = "zh-TW"): string {
  if (locale !== "en") return text;
  for (const [prefix, key] of [
    ["即時語音無法開始：", "即時語音無法開始：{0}"],
    ["這次改用 OpenAI API key（依用量計費）：", "這次改用 OpenAI API key（依用量計費）：{0}"],
  ]) {
    if (text.startsWith(prefix)) return translate(key, locale, text.slice(prefix.length).split("；").map(part => localize(part, locale)).join("; "));
  }
  return translate(text, locale);
}

export function localizeSettings(view: SettingsView, locale: Locale = "zh-TW"): SettingsView {
  if (locale !== "en") return view;
  const t = (text: string) => localize(text, locale);
  const nullable = (text: string | null) => text === null ? null : t(text);
  const tools = (text: string) => text.split("；").map(part => part.split("、").map(t).join(", ")).join("; ");
  const detail = (text: string): string => {
    const api = text.match(/^OpenAI Realtime（(.*?)），使用 \.env 的 OPENAI_API_KEY，依用量計費；工具：(.*)$/);
    if (api) return translate("OpenAI Realtime（{0}），使用 .env 的 OPENAI_API_KEY，依用量計費；工具：{1}", locale, api[1], tools(api[2]));
    const live = text.match(/^ChatGPT 方案（Codex 登入，(.*?)），用方案的 Codex 額度；工具：(.*)；MCP 不可用$/);
    if (live) return translate("ChatGPT 方案（Codex 登入，{0}），用方案的 Codex 額度；工具：{1}；MCP 不可用", locale, live[1], tools(live[2]));
    return t(text);
  };
  const note = (text: string): string => {
    const needsRealtime = "；需要即時語音（目前不可用）";
    if (text.endsWith(needsRealtime)) return `${t(text.slice(0, -needsRealtime.length))}; ${t(needsRealtime.slice(1))}`;
    const unavailable = text.match(/^即時語音目前不可用（(.*)）$/);
    if (unavailable) return translate("即時語音目前不可用（{0}）", locale, detail(unavailable[1]));
    const direct = t(text);
    return direct !== text ? direct : text.split("；").map(t).join("; ");
  };
  const realtime = view.realtime;
  return {
    ...view,
    providers: view.providers.map(provider => ({ ...provider, label: t(provider.label), detail: t(provider.detail) })),
    chatgpt: { ...view.chatgpt, last_error: nullable(view.chatgpt.last_error) },
    ...(view.identity ? { identity: { ...view.identity, disabled_reason: nullable(view.identity.disabled_reason), limited_reason: nullable(view.identity.limited_reason) } } : {}),
    ...(view.seconds ? { seconds: view.seconds.map(row => ({
      ...row, group_label: t(row.group_label), label: t(row.label), value_label: t(row.value_label),
      disabled_reason: nullable(row.disabled_reason), note: note(row.note),
      ...(row.kind !== "bool" ? { options: row.options.map(option => ({ ...option, label: t(option.label) })) } : {}),
    })) } : {}),
    ...(view.camera_preview_disabled_reason !== undefined ? { camera_preview_disabled_reason: nullable(view.camera_preview_disabled_reason) } : {}),
    ...(realtime ? { realtime: {
      ...realtime, detail: detail(realtime.detail), billing_line: nullable(realtime.billing_line),
      ...(realtime.active ? { active: { ...realtime.active, billing_line: t(realtime.active.billing_line) } } : {}),
      ...(realtime.live_account ? { live_account: { ...realtime.live_account, last_error: nullable(realtime.live_account.last_error) } } : {}),
      routes: realtime.routes.map(route => ({ ...route, detail: detail(route.detail), tools: tools(route.tools), billing_line: t(route.billing_line) })),
    } } : {}),
  };
}
