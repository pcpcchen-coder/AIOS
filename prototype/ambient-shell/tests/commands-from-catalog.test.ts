import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCommandsPage } from "../server/commands-page.ts";
import { TimerAdapter } from "../server/integrations/adapters/timer.ts";
import { liveCatalog, staticCatalog, type CatalogEntry } from "../server/integrations/catalog.ts";
import { IntegrationRegistry } from "../server/integrations/registry.ts";
import type { AlarmCenter } from "../server/alarms.ts";
import { commandSections, type CommandContext } from "../shared/voice-commands.ts";
import type { SettingsView } from "../shared/types.ts";
import { commandsPageOutputs } from "./fixtures/commands-page.ts";
import { modelToolAdapters } from "./fixtures/model-tools.ts";

// CAP-2（docs/24 §3.3）：/help/commands 與 README 的「定時器與鬧鐘」「App 整合」兩段由能力總表產生。
// 全部是 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收。

const HAN = /\p{Script=Han}/u;
const PRE = JSON.parse(readFileSync(new URL("./fixtures/commands-page.pre-cap-2.json", import.meta.url), "utf8")) as Record<string, string>;
const visible = staticCatalog().filter((e) => e.kind === "integration" && !e.hidden);
const READY: CommandContext = { cameraEnabled: true, realtimeAvailable: true, webSearch: true, home: true, route: "api_key", seconds: {} };

/** 去掉由總表產生的兩段（頁面是 <section>，README 是 #### 標題到「不用說話」）。 */
function withoutCatalogSections(text: string): string {
  return text
    .replace(/<section id="timers">[\s\S]*?<\/section>\n(?:<section id="apps">[\s\S]*?<\/section>\n)?/, "")
    .replace(/#### 定時器與鬧鐘[\s\S]*?(?=#### 不用說話)/, "")
    .replace(/#### Timers and alarms[\s\S]*?(?=#### )/, "");
}

const rowsOf = (catalog: readonly CatalogEntry[], ctx: CommandContext | null = READY) => commandSections(ctx, catalog).flatMap((s) => s.rows);
const row = (catalog: readonly CatalogEntry[], id: string, ctx?: CommandContext | null) => rowsOf(catalog, ctx).find((r) => r.id === `cap-${id}`);

describe("gate: everything outside the two catalog sections is byte-for-byte the pre-CAP-2 output", () => {
  it("page (zh-TW, en) and README: local phrases, the 9 page tools (ASK_THE_AI) and the controls are unchanged", () => {
    const now = commandsPageOutputs();
    expect(Object.keys(now)).toEqual(Object.keys(PRE));
    for (const key of Object.keys(PRE)) {
      expect(withoutCatalogSections(PRE[key]!), key).not.toBe(PRE[key]);
      expect(withoutCatalogSections(now[key]!), key).toBe(withoutCatalogSections(PRE[key]!));
    }
  });

  it("section order is unchanged; the App integrations section comes right after timers", () => {
    expect(commandSections(null, staticCatalog()).map((s) => s.id)).toEqual(["camera", "conversation", "tasks", "approval", "barge-in", "caveats", "ask", "timers", "apps", "controls"]);
  });
});

describe("rows come from the catalog", () => {
  it("every non-hidden integration tool has exactly one row; hidden ones (mock, legacy Facade) have none", () => {
    const ids = rowsOf(staticCatalog(), null).map((r) => r.id).filter((id) => id.startsWith("cap-"));
    expect(ids).toEqual([...visible.filter((e) => e.builtin), ...visible.filter((e) => !e.builtin)].map((e) => `cap-${e.id}`));
    expect(ids).toHaveLength(staticCatalog().filter((e) => e.kind === "integration").length - 5);
    for (const e of staticCatalog().filter((x) => x.hidden)) expect(ids, e.id).not.toContain(`cap-${e.id}`);
    const html = commandsPageOutputs()["page/zh-TW"]!;
    for (const id of ["app.mock.echo", "app.mock.toggle", "app.home.status", "app.home.control", "app.home.confirm"]) expect(html).not.toContain(`data-row="cap-${id}"`);
  });

  it("TV, calendar, mail, weather and the voice relay appear in App integrations; timers and alarms stay in their own section", () => {
    const sections = commandSections(null, staticCatalog());
    const apps = sections.find((s) => s.id === "apps")!.rows.map((r) => r.id);
    const timers = sections.find((s) => s.id === "timers")!.rows.map((r) => r.id);
    for (const id of ["app.tv.power", "app.tv.play_youtube", "app.calendar.list_events", "app.calendar.create_event", "app.mail.send_to_self", "app.weather.today", "app.voice_relay.send_intent"]) expect(apps, id).toContain(`cap-${id}`);
    expect(timers).toEqual(visible.filter((e) => e.builtin).map((e) => `cap-${e.id}`));
    expect(timers.every((id) => /^cap-app\.(timer|alarm)\./.test(id))).toBe(true);
    expect(apps.some((id) => /^cap-app\.(timer|alarm)\./.test(id))).toBe(false);
  });

  it("cells are service, examples, summary and needs from the catalog", () => {
    const tv = staticCatalog().find((e) => e.id === "app.tv.volume")!;
    expect(row(staticCatalog(), tv.id, null)!.cells).toEqual([tv.group_label, tv.examples.map((x) => `「${x}」`).join(""), tv.summary, `需要即時語音，${tv.needs}`]);
  });

  it("what the old hand-written TIMER_ASK said is still on the table", () => {
    const text = (id: string) => row(staticCatalog(), id, null)!.cells.join(" ");
    const intro = commandSections(null, staticCatalog()).find((s) => s.id === "timers")!.intro!;
    expect(intro).toContain("重新啟動後還在");
    expect(intro).toContain("沒說是哪一個時，AI 會問");
    expect(text("app.timer.start")).toContain("那台不在線時每個畫面都響");
    expect(text("app.timer.start")).toContain("右下角按需顯示倒數");
    expect(text("app.timer.start")).toContain("5 分鐘後叫我");
    expect(text("app.timer.resume")).toContain("「繼續」");
    expect(text("app.alarm.set")).toContain("跨夏令時間照當地時間響");
    expect(text("app.alarm.set")).toContain("可以取名字");
    expect(text("app.alarm.list")).toContain("設定頁也可以管理");
    for (const id of ["app.timer.start", "app.alarm.set"]) expect(text(id)).toContain("設定頁「鬧鐘與定時器」開著（預設開）");
  });
});

describe("unavailable rows are marked from the live state", () => {
  const registry = () => new IntegrationRegistry({ enabled: { has: (id) => id !== "timer" } });

  it("README (no context) marks nothing", () => {
    expect(rowsOf(staticCatalog(), null).every((r) => r.unmet === null)).toBe(true);
  });

  it("realtime unavailable wins over every other reason", () => {
    expect(row(liveCatalog(registry()), "app.tv.power", { ...READY, realtimeAvailable: false, route: null })!.unmet).toBe("目前：即時語音不可用");
  });

  it("a service without configuration (no Adapter registered) is 'not configured'", () => {
    expect(row(liveCatalog(registry()), "app.tv.power")!.unmet).toBe("目前：未設定");
  });

  it("a registered but turned-off tool is 'turned off'; a registered, enabled tool has no mark", () => {
    const off = registry();
    off.register(new TimerAdapter({} as AlarmCenter));
    expect(row(liveCatalog(off), "app.timer.start")!.unmet).toBe("目前：已停用");
    const on = new IntegrationRegistry({ enabled: { has: () => true } });
    for (const adapter of modelToolAdapters("fake")) on.register(adapter);
    for (const id of ["app.timer.start", "app.tv.power", "app.calendar.list_events", "app.voice_relay.send_intent"]) expect(row(liveCatalog(on), id)!.unmet, id).toBeNull();
  });

  it("the status on the route the next call will use decides: unsupported and authorization required", () => {
    const base = staticCatalog().find((e) => e.id === "app.tv.power")!;
    const entry = (status: CatalogEntry["status"]): CatalogEntry => ({ ...base, configured: true, status });
    expect(row([entry({ api_key: "unsupported", live: "available" })], base.id)!.unmet).toBe("目前：這條語音路徑不支援");
    expect(row([entry({ api_key: "unsupported", live: "available" })], base.id, { ...READY, route: "live" })!.unmet).toBeNull();
    expect(row([entry({ api_key: "authorization_required", live: "authorization_required" })], base.id)!.unmet).toBe("目前：需要授權");
  });

  it("the page renders the marks with the existing unmet style", () => {
    const view = { schema_version: "proto-0.1", provider: "mock", providers: [], chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
      realtime: { available: true, model: "fixture", detail: "fixture", preference: "auto", route: "api_key", billing: null, billing_line: null, routes: [], live_account: null, active: null } } as unknown as SettingsView;
    const html = renderCommandsPage(view, liveCatalog(registry()), new Date("2026-11-24T08:00:00Z"));
    expect(html).toContain('<tr data-row="cap-app.tv.power" class="unmet"><td>客廳電視<span class="unmet-note">目前：未設定</span>');
    const en = renderCommandsPage(view, liveCatalog(registry()), new Date("2026-11-24T08:00:00Z"), "en");
    expect(en).toContain('<tr data-row="cap-app.tv.power" class="unmet"><td>Living-room TV<span class="unmet-note">Currently: not configured</span>');
  });
});

describe("both languages", () => {
  it("English page: service, summary, needs and marks are English; examples stay the exact Chinese input phrases", () => {
    const en = commandsPageOutputs()["page/en"]!;
    for (const e of visible) {
      const tr = en.match(new RegExp(`<tr data-row="cap-${e.id.replace(/\./g, "\\.")}"[^>]*>(.*?)</tr>`))?.[1];
      expect(tr, e.id).toBeDefined();
      const cells = [...tr!.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<span[^>]*>(.*?)<\/span>/, " $1"));
      expect(cells, e.id).toHaveLength(4);
      for (const i of [0, 2, 3]) expect(HAN.test(cells[i]!), `${e.id} cell ${i}: ${cells[i]}`).toBe(false);
      expect(cells[3]).toMatch(/^Requires realtime/);
      expect(cells[1]).toContain(e.examples[0]!);
    }
    for (const title of ["Timers and alarms (realtime, model decides, no guarantee)", "App integrations (realtime, model decides, no guarantee)", "<th>Service</th>"]) expect(en).toContain(title);
    const intros = [...en.matchAll(/<section id="(?:timers|apps)">\n<h2>.*?<\/h2>\n<p class="muted">(.*?)<\/p>/g)].map((m) => m[1]!);
    expect(intros).toHaveLength(2);
    for (const intro of intros) expect(HAN.test(intro), intro).toBe(false);
  });

  it("Chinese page and README use the same rows", () => {
    const zh = commandsPageOutputs()["page/zh-TW"]!;
    const readme = commandsPageOutputs().readme!;
    for (const e of visible) {
      expect(zh, e.id).toContain(`data-row="cap-${e.id}"`);
      expect(readme, e.id).toContain(`| ${e.group_label} | ${e.examples.map((x) => `「${x}」`).join("")} | ${e.summary} |`);
    }
  });
});
