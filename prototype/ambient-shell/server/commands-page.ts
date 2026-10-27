import { localize } from "./localization.ts";
import type { Locale } from "../shared/i18n.mjs";
import { createHash } from "node:crypto";
import type { SettingsView } from "../shared/types.ts";
import { commandContext, commandSections, COMMANDS_INTRO, type TableSection } from "../shared/voice-commands.ts";

// 唯讀的語音指令表頁（GET /help/commands）：每次請求依目前設定產生，所以「目前：鏡頭未啟用」這類標註在打開當下是真的。
// 沒有任何 script；App 的視窗也關掉 JavaScript，CSP 是第二道鎖。路由在 SPA fallback 之前（server/app.ts）。

export const COMMANDS_PATH = "/help/commands";

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f7f9; --fg: #16181d; --muted: #5d6270; --line: #d9dbe1; --head: #eceef3; --accent: #3557c9; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0d14; --fg: #e8eaf0; --muted: #9aa0ae; --line: #2a2e3a; --head: #161a24; --accent: #8aa4ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 -apple-system, "PingFang TC", "Noto Sans TC", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 32px; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 16px; margin: 26px 0 6px; }
p { margin: 4px 0 10px; }
.muted, .intro { color: var(--muted); }
.status { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--head); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { background: var(--head); font-weight: 600; white-space: nowrap; }
td.mark { text-align: center; white-space: nowrap; }
tr.unmet td { color: var(--muted); }
.unmet-note { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--accent); font-size: 12px; }
footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** 只允許上面那段 inline style；沒有 script、連線、圖片、frame 或表單。 */
export function commandsPageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
  };
}

export function renderCommandsPage(view: SettingsView, now: Date, locale: Locale = "zh-TW"): string {
  const t = (text: string) => localize(text, locale);
  const sections = commandSections(commandContext(view)).map(section => locale === "en" ? {
    ...section, title: t(section.title), intro: section.intro ? t(section.intro) : null,
    columns: section.columns.map(t), rows: section.rows.map(row => ({
      ...row, cells: row.cells.map(cell => localizeHelpCell(cell)), unmet: row.unmet ? t(row.unmet) : null,
    })),
  } : section).map(renderSection).join("\n");
  const camera = view.camera?.enabled ? "鏡頭：啟用" : "鏡頭：未啟用（.env NOUS_CAMERA=on）";
  const realtime = view.realtime?.available ? "即時語音：可用" : `即時語音：不可用（${view.realtime?.detail ?? "未設定"}）`;
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `<!doctype html>
<html lang="${locale === "en" ? "en" : "zh-Hant"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t("Nous 語音指令表"))}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(t("Nous 語音指令表"))}</h1>
${locale === "en" ? '<p class="muted">English interface commands include “open settings”, “show progress”, “show results”, and “stop task”. For an action confirmation, use “confirm execution”; “yes” alone does not authorize it. The table below preserves exact Chinese input examples with English explanations.</p>' : ""}
<p class="intro">${escapeHtml(t(COMMANDS_INTRO))}</p>
<p class="status">${escapeHtml(locale === "en" ? `Current: ${t(camera)} · ${t(realtime)}` : `目前：${camera} · ${realtime}`)}</p>
${sections}
<footer>${escapeHtml(t(`依 ${time} 打開時的設定產生；之後改了設定，請按 ⌘R 重新整理。`))}</footer>
</main>
</body>
</html>
`;
}

function localizeHelpCell(cell: string): string {
  const dynamic = cell.match(/^(.*)；目前 (.*?)（預設 (.*?)），macOS App：選單列「鏡頭與語音設定」；瀏覽器：設定畫面可調$/);
  if (dynamic) {
    const prefix = localize(`${dynamic[1]}；預設 ${dynamic[3]}，macOS App：選單列「鏡頭與語音設定」；瀏覽器：設定畫面可調`, "en");
    return `${prefix}. Current: ${localize(dynamic[2], "en")} (default ${localize(dynamic[3], "en")}).`;
  }
  return localize(cell, "en");
}

function renderSection(section: TableSection): string {
  const head = section.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = section.rows
    .map((row) => {
      const cells = row.cells.map((cell, i) => {
        const mark = cell === "✓" || cell === "—";
        const note = row.unmet && i === 0 ? `<span class="unmet-note">${escapeHtml(row.unmet)}</span>` : "";
        return `<td${mark ? ' class="mark"' : ""}>${escapeHtml(cell)}${note}</td>`;
      });
      return `<tr data-row="${escapeHtml(row.id)}"${row.unmet ? ' class="unmet"' : ""}>${cells.join("")}</tr>`;
    })
    .join("\n");
  return `<section id="${escapeHtml(section.id)}">
<h2>${escapeHtml(section.title)}</h2>
${section.intro ? `<p class="muted">${escapeHtml(section.intro)}</p>` : ""}
<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></div>
</section>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
