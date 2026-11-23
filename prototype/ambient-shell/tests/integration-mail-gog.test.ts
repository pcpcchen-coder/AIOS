import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.ts";
import {
  buildSendArgs,
  cleanBody,
  cleanSubject,
  findMessageId,
  GmailGogAdapter,
  MAIL_TOOL_ID,
  resolveGogPath,
  type GogRunner,
} from "../server/integrations/adapters/gmail-gog.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { CONFIRMATION_EXEMPT_TOOLS, decide } from "../server/integrations/policy.ts";
import { buildRealtimeTools } from "../server/realtime.ts";

// MAIL-1：用 gog 寄信給自己。雲端沒有 gog、沒有 Gmail：一部分用注入的假 runner，一部分用一支假的 gog 腳本（真的 spawn、不經 shell）。
// 信箱都是虛構的（self@example.test）；真實信箱只放在 Mac 的 .env。gog --json 的輸出格式是假設的，需在 Mac 上核對。

const SELF = "self@example.test";
const ctx = (signal = new AbortController().signal) => ({ actor: "agent" as const, route: "live" as const, sessionId: "s", requestId: "r", signal });

function fakeRunner(reply: { code: number | null; stdout: string } | Error | ((signal: AbortSignal) => Promise<{ code: number | null; stdout: string }>)) {
  const calls: { file: string; args: string[]; stdin: string | undefined }[] = [];
  const run: GogRunner = async (file, args, { signal, stdin }) => {
    calls.push({ file, args, stdin });
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(signal);
    return reply;
  };
  return { run, calls };
}

describe("gmail_gog helpers", () => {
  it("cleans subject (no header injection) and body", () => {
    expect(cleanSubject("Hi\r\nBcc: evil@example.test\t x")).toBe("Hi Bcc: evil@example.test x");
    expect(cleanSubject("x".repeat(300))).toHaveLength(200);
    expect(cleanBody("a\r\nb\u0000c\rd")).toBe("a\nbc\nd");
    expect(cleanSubject("a\u0085b\u202ec\u2066d")).toBe("a b c d");
  });

  it("builds argv with --flag=value only; the recipient is always the configured self", () => {
    expect(buildSendArgs(SELF, "--to=other@example.test")).toEqual(["gmail", "send", `--account=${SELF}`, `--to=${SELF}`, "--subject=--to=other@example.test", "--body-file=-", "--json"]);
  });

  it("finds a message id in several JSON shapes, nothing otherwise", () => {
    expect(findMessageId('{"id":"18c2f0a1b2c3d4e5","threadId":"x"}')).toBe("18c2f0a1b2c3d4e5");
    expect(findMessageId('{"messageId":"abc123"}')).toBe("abc123");
    expect(findMessageId('{"message":{"id":"abc_123"}}')).toBe("abc_123");
    expect(findMessageId("sent")).toBeNull();
    expect(findMessageId('{"id":"has space"}')).toBeNull();
    expect(findMessageId("")).toBeNull();
  });

  it("resolves gog: configured path first, then Homebrew locations", () => {
    expect(resolveGogPath("/x/gog", () => false)).toBe("/x/gog");
    expect(resolveGogPath(null, (p) => p === "/usr/local/bin/gog")).toBe("/usr/local/bin/gog");
    expect(resolveGogPath(null, () => false)).toBeNull();
  });
});

describe("GmailGogAdapter (injected runner)", () => {
  it("confirmed only with a message id; the body goes through stdin, never argv", async () => {
    const { run, calls } = fakeRunner({ code: 0, stdout: '{"id":"18c2f0a1b2c3d4e5"}' });
    const adapter = new GmailGogAdapter({ self: SELF, gogPath: "/opt/fake/gog", run });
    const result = await adapter.execute(MAIL_TOOL_ID, { subject: "購物清單", body: "SECRET-BODY 牛奶" }, ctx());
    expect(result).toEqual({ ok: true, status: "confirmed", message: "信已寄到你的 Gmail。" });
    expect(calls).toEqual([{ file: "/opt/fake/gog", args: buildSendArgs(SELF, "購物清單"), stdin: "SECRET-BODY 牛奶" }]);
    expect(calls[0]!.args.join(" ")).not.toContain("SECRET-BODY");
    // 結果不帶信箱與內容。
    expect(JSON.stringify(result)).not.toMatch(/example\.test|SECRET/);
  });

  it("exit 0 without id → unconfirmed; non-zero → failed; gog missing → failed; abort → rethrow (Dispatcher says unknown)", async () => {
    const noId = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner({ code: 0, stdout: "ok" }).run });
    expect(await noId.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ ok: false, status: "unconfirmed" });
    // 非 0：gog 可能在 Gmail 收下之後才出錯 → unknown（不說沒寄出）。
    const bad = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner({ code: 3, stdout: "" }).run });
    expect(await bad.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "unknown", reason: "adapter_error" });
    const missing = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })).run });
    expect(await missing.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "failed", reason: "unavailable" });
    const noExec = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner(Object.assign(new Error("spawn EACCES"), { code: "EACCES", spawnFailed: true })).run });
    expect(await noExec.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "failed", reason: "unavailable" });
    const controller = new AbortController();
    const hang = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))).run });
    const pending = hang.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx(controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow();
    const blank = new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner({ code: 0, stdout: "{}" }).run });
    expect(await blank.execute(MAIL_TOOL_ID, { subject: "\n\n", body: "b" }, ctx())).toMatchObject({ status: "refused" });
  });

  it("at most 5 emails a minute per adapter (no confirmation card, so a loop cannot flood the inbox)", async () => {
    let now = 0;
    const { run, calls } = fakeRunner({ code: 0, stdout: '{"id":"abcd1234"}' });
    const adapter = new GmailGogAdapter({ self: SELF, gogPath: "/g", run, now: () => now });
    for (let i = 0; i < 5; i++) expect(await adapter.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "confirmed" });
    expect(await adapter.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "refused", reason: "rate_limited" });
    expect(calls).toHaveLength(5);
    now = 60_001;
    expect(await adapter.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ status: "confirmed" });
  });

  it("health: gog runs → available; missing → unavailable not_configured; non-zero → unknown", async () => {
    const signal = new AbortController().signal;
    expect(await new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner({ code: 0, stdout: "gog 1.0" }).run }).health(signal)).toEqual({ health: "available", reason: "ok" });
    expect(await new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner(Object.assign(new Error("x"), { code: "ENOENT" })).run }).health(signal)).toEqual({ health: "unavailable", reason: "not_configured" });
    expect(await new GmailGogAdapter({ self: SELF, gogPath: "/g", run: fakeRunner({ code: 1, stdout: "" }).run }).health(signal)).toEqual({ health: "unknown", reason: "error" });
  });

  it("rejects a bad self address or a relative gog path", () => {
    expect(() => new GmailGogAdapter({ self: "not-an-email", gogPath: "/g" })).toThrow();
    expect(() => new GmailGogAdapter({ self: SELF, gogPath: "gog" })).toThrow();
  });
});

describe("real spawn against a fake gog script (no shell)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nous-fake-gog-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "gog");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("gog fake 0.0\\n"); process.exit(0); }
const body = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ args, body }));
process.stdout.write(JSON.stringify({ id: "fakeMsg123", threadId: "t1" }));
`,
  );
  chmodSync(script, 0o755);
  // 不理 SIGTERM、一直不結束的 gog；以及結束代碼非 0 的 gog。
  const stubborn = join(dir, "gog-stubborn");
  writeFileSync(stubborn, `#!/usr/bin/env node
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(stubborn, 0o755);
  const failing = join(dir, "gog-fail");
  writeFileSync(failing, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(4));\n");
  chmodSync(failing, 0o755);

  it("non-zero exit through real spawn is unknown, not 'not sent'", async () => {
    const adapter = new GmailGogAdapter({ self: SELF, gogPath: failing });
    expect(await adapter.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx())).toMatchObject({ ok: false, status: "unknown" });
  });

  it("abort kills a gog that ignores SIGTERM (SIGKILL after the grace period)", async () => {
    const adapter = new GmailGogAdapter({ self: SELF, gogPath: stubborn });
    const controller = new AbortController();
    const pending = adapter.execute(MAIL_TOOL_ID, { subject: "s", body: "b" }, ctx(controller.signal));
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 30));
      try { pid = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { /* 還沒啟動 */ }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(false);
  }, 10_000);

  it("passes argv verbatim (shell metacharacters stay literal) and the body on stdin", async () => {
    const adapter = new GmailGogAdapter({ self: SELF, gogPath: script });
    const subject = "$(touch pwned) `id` ; rm -rf ~";
    const result = await adapter.execute(MAIL_TOOL_ID, { subject, body: "第一行\n第二行 $HOME" }, ctx());
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as { args: string[]; body: string };
    expect(seen.args).toEqual(buildSendArgs(SELF, subject));
    expect(seen.body).toBe("第一行\n第二行 $HOME");
    expect(await adapter.health(new AbortController().signal)).toEqual({ health: "available", reason: "ok" });
  });
});

describe("MAIL-1 through config, policy and the integration layer", () => {
  it("George's exemption: send_to_self runs without a card; other external_commit tools still need confirmation", () => {
    expect(CONFIRMATION_EXEMPT_TOOLS[MAIL_TOOL_ID]).toMatch(/George 2026-11-04/);
    expect(decide("external_commit", MAIL_TOOL_ID)).toEqual({ kind: "run" });
    expect(decide("external_commit", "app.mail.send")).toEqual({ kind: "confirm" });
    expect(decide("external_commit")).toEqual({ kind: "confirm" });
    expect(decide("read", MAIL_TOOL_ID)).toEqual({ kind: "run" });
    expect(decide("reversible_write", "app.mock.toggle")).toEqual({ kind: "run" });
  });

  it("config: NOUS_MAIL_SELF is read only when gmail_gog is listed, and must be an email; NOUS_GOG_PATH must be absolute", () => {
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "mock", NOUS_MAIL_SELF: "junk" }).ail.mail).toBeUndefined();
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "gmail_gog", NOUS_MAIL_SELF: SELF }).ail.mail).toEqual({ self: SELF, gogPath: null });
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "gmail_gog", NOUS_MAIL_SELF: "junk" })).toThrow(/NOUS_MAIL_SELF/);
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "gmail_gog", NOUS_MAIL_SELF: SELF, NOUS_GOG_PATH: "gog" })).toThrow(/NOUS_GOG_PATH/);
  });

  it("not registered without NOUS_MAIL_SELF; registered with it; the model sees subject/body only and the dispatcher runs it without a card", async () => {
    const lines: string[] = [];
    const none = createIntegrations({ enabled: true, services: ["gmail_gog"], soloistPort: 19090, mail: { self: null, gogPath: "/g" } }, (l) => lines.push(l))!;
    expect(none.registry.adapters()).toEqual([]);
    expect(lines.join("\n")).toMatch(/NOUS_MAIL_SELF/);
    const { run, calls } = fakeRunner({ code: 0, stdout: '{"id":"abcd1234"}' });
    const ail = createIntegrations({ enabled: true, services: ["gmail_gog"], soloistPort: 19090, mail: { self: SELF, gogPath: "/g" } }, () => undefined, {
      gmail_gog: (c) => new GmailGogAdapter({ self: c.mail!.self!, gogPath: "/g", run }),
    })!;
    const tools = buildRealtimeTools({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("live", l) });
    const mail = tools.find((t) => t.name === "app__mail__send_to_self") as { parameters: { properties: Record<string, unknown> } };
    expect(Object.keys(mail.parameters.properties)).toEqual(["subject", "body"]);
    expect(JSON.stringify(tools)).not.toContain(SELF);
    const result = await ail.dispatcher.execute({ tool: "app__mail__send_to_self", args: '{"subject":"提醒","body":"明天帶傘"}', route: "live", actor: "agent", sessionId: "s" });
    expect(result).toMatchObject({ ok: true, status: "confirmed" });
    expect(calls).toHaveLength(1);
    // 模型想自己加收件人：Schema 拒絕，不會執行。
    expect(await ail.dispatcher.execute({ tool: "app__mail__send_to_self", args: { subject: "x", body: "y", to: "other@example.test" }, route: "live", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(calls).toHaveLength(1);
  });
});
