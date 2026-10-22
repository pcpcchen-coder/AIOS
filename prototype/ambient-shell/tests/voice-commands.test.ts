import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APPROVE_VERBS, matchApproval, REJECT_WORDS, type ApprovalDecision } from "../src/approval.ts";
import { isStopWord, STOP_WORDS } from "../src/echo.ts";
import { classify, type Intent } from "../src/intent.ts";
import { CAMERA_RULES, matchCameraCommand, type CameraCommand } from "../src/sense/controller.ts";
import { buildRealtimeTools, HOME_CONTROL_TOOL, HOME_STATUS_TOOL, REALTIME_TOOLS } from "../server/realtime.ts";
import {
  APPROVAL_COMMANDS,
  ASK_THE_AI,
  BARGE_IN,
  CAMERA_COMMANDS,
  CAVEATS,
  CHANNEL_KEYS,
  commandSections,
  CONTROLS,
  INTENT_COMMANDS,
  LOCAL_ROUTING,
  REPLACES_CONFIRM_CARD,
  type ApprovalDecision as TableApprovalDecision,
  type CameraEffect,
  type Channel,
  type Expect,
  type LocalCommand,
  type LocalIntentKind,
  type Matcher,
  type Provider,
  type RealtimeToolName,
} from "../shared/voice-commands.ts";

// 指令表不能從正規式推導，所以這裡把表裡每一句丟進真正的比對函式；表與程式不一致時測試失敗。

const LOCAL: LocalCommand[] = [
  ...CAMERA_COMMANDS,
  ...Object.values(INTENT_COMMANDS).flat(),
  ...Object.values(APPROVAL_COMMANDS).flat(),
];

function effect(command: CameraCommand | null): CameraEffect | null {
  if (!command) return null;
  return "preview" in command ? { preview: command.preview } : { set: command.set };
}

function intentKind(phrase: string): LocalIntentKind | "task" | "empty" {
  return classify(phrase).kind;
}

/** 這個比對函式認不認得這句話（認得就不再交給後面的比對或 AI）。 */
function claims(matcher: Matcher, phrase: string): boolean {
  if (matcher === "camera") return matchCameraCommand(phrase) !== null;
  if (matcher === "intent") return !["task", "empty"].includes(intentKind(phrase));
  return matchApproval(phrase) !== null;
}

/** 依 LOCAL_ROUTING 推算：這句話在哪些路徑上會由 matcher 處理。 */
function channelsFor(matcher: Matcher, phrase: string): Channel[] {
  return CHANNEL_KEYS.filter((channel) => {
    const { matchers, firstClaimWins } = LOCAL_ROUTING[channel];
    const index = matchers.indexOf(matcher);
    if (index < 0 || !claims(matcher, phrase)) return false;
    return !firstClaimWins || matchers.slice(0, index).every((earlier) => !claims(earlier, phrase));
  });
}

function actual(expectation: Expect, phrase: string): Expect | null {
  if (expectation.matcher === "camera") {
    const e = effect(matchCameraCommand(phrase));
    return e && { matcher: "camera", effect: e };
  }
  if (expectation.matcher === "intent") {
    const intent = classify(phrase);
    if (intent.kind === "task" || intent.kind === "empty") return null;
    return intent.kind === "use_provider" ? { matcher: "intent", kind: "use_provider", provider: intent.provider } : { matcher: "intent", kind: intent.kind };
  }
  const decision = matchApproval(phrase);
  return decision && { matcher: "approval", decision };
}

describe("compile-time coverage", () => {
  it("the table's unions equal the real intent kinds, providers, approval decisions and realtime tools", () => {
    expectTypeOf<LocalIntentKind>().toEqualTypeOf<Exclude<Intent["kind"], "empty" | "task">>();
    expectTypeOf<Provider>().toEqualTypeOf<Extract<Intent, { kind: "use_provider" }>["provider"]>();
    expectTypeOf<TableApprovalDecision>().toEqualTypeOf<ApprovalDecision>();
    expectTypeOf<RealtimeToolName>().toEqualTypeOf<
      (typeof REALTIME_TOOLS)[number]["name"] | (typeof HOME_STATUS_TOOL)["name"] | (typeof HOME_CONTROL_TOOL)["name"]
    >();
  });
});

describe("local command rows match the real matchers", () => {
  const cases = LOCAL.flatMap((row) => row.says.map((phrase) => [row.id, phrase, row] as const));

  it.each(cases)("%s: 「%s」 gives the stated result on exactly the stated channels", (_id, phrase, row) => {
    expect(actual(row.expect, phrase)).toEqual(row.expect);
    expect(channelsFor(row.expect.matcher, phrase)).toEqual([...row.works]);
  });

  it("row ids are unique", () => {
    const ids = [...LOCAL.map((r) => r.id), ...CAVEATS.map((c) => c.id), ...CONTROLS.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every local rule has a row", () => {
  it("one camera row per CAMERA_RULES entry, same effect", () => {
    const rules = CAMERA_RULES.map((rule) => effect(rule.command));
    expect(CAMERA_COMMANDS.map((row) => row.expect.matcher === "camera" && row.expect.effect)).toEqual(rules);
  });

  it("every provider has a use_provider row", () => {
    const providers = INTENT_COMMANDS.use_provider.map((row) => row.expect.matcher === "intent" && row.expect.kind === "use_provider" && row.expect.provider);
    expect(providers.sort()).toEqual(["chatgpt", "claude", "mock"]);
  });

  it("intent rows sit under their own kind", () => {
    for (const [kind, rows] of Object.entries(INTENT_COMMANDS)) {
      for (const row of rows) expect(row.expect).toMatchObject({ matcher: "intent", kind });
    }
    for (const [decision, rows] of Object.entries(APPROVAL_COMMANDS)) {
      for (const row of rows) expect(row.expect).toEqual({ matcher: "approval", decision });
    }
  });

  it("the approval notes name every approve verb and every reject word", () => {
    for (const verb of APPROVE_VERBS) expect(APPROVAL_COMMANDS.approve[0].note).toContain(verb);
    for (const word of REJECT_WORDS) expect(APPROVAL_COMMANDS.reject[0].note).toContain(word);
  });

  it("the barge-in row lists exactly STOP_WORDS, matched by prefix, only in voice mode", () => {
    expect([...BARGE_IN.says]).toEqual([...STOP_WORDS]);
    for (const word of BARGE_IN.says) expect(isStopWord(word)).toBe(true);
    expect(isStopWord("停止任務")).toBe(true);
    expect(isStopWord("等等我")).toBe(true);
    expect(BARGE_IN.works).toEqual(["voice_mode"]);
  });

  it("every realtime model tool has an ask-the-AI row", () => {
    const tools = buildRealtimeTools({ webSearch: true, home: true, mcp: [] }).map((tool) => tool.name);
    expect(Object.keys(ASK_THE_AI).sort()).toEqual([...tools].sort());
  });
});

describe("caveats are what they say", () => {
  const cases = CAVEATS.flatMap((caveat) => caveat.cases.map((c) => [caveat.id, c.says, c.checks] as const));

  it.each(cases)("%s: 「%s」", (_id, phrase, checks) => {
    if ("camera" in checks) expect(effect(matchCameraCommand(phrase))).toEqual(checks.camera);
    if (checks.intent) expect(intentKind(phrase)).toBe(checks.intent);
    if ("approval" in checks) expect(matchApproval(phrase)).toBe(checks.approval);
    if (checks.stopWord !== undefined) expect(isStopWord(phrase)).toBe(checks.stopWord);
    for (const channel of checks.notLocalIn ?? []) {
      expect(LOCAL_ROUTING[channel].matchers.filter((m) => claims(m, phrase))).toEqual([]);
    }
  });

  it("every camera phrase that also rejects a confirm card is listed as a caveat", () => {
    const listed = new Set(CAVEATS.flatMap((c) => c.cases.map((x) => x.says)));
    const rejecting = CAMERA_COMMANDS.flatMap((row) => row.says).filter((phrase) => matchApproval(phrase) !== null);
    expect(rejecting.length).toBeGreaterThan(0);
    for (const phrase of rejecting) expect(listed).toContain(phrase);
  });

  it("phrases people expect to be commands are not local commands", () => {
    for (const phrase of ["結束對話", "開始語音對話", "再見"]) {
      for (const channel of CHANNEL_KEYS) expect(LOCAL_ROUTING[channel].matchers.filter((m) => claims(m, phrase))).toEqual([]);
    }
  });
});

describe("LOCAL_ROUTING mirrors src/main.ts", () => {
  // 這是表裡唯一手寫的路由事實；這裡只檢查最容易走樣的兩點，避免過度依賴原始碼文字。
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const realtime = readFileSync(new URL("../src/realtime.ts", import.meta.url), "utf8");

  it("realtime speech runs only the camera rules and the approval phrases, never classify", () => {
    const transcript = main.slice(main.indexOf("onUserTranscript:"), main.indexOf("onAssistantTranscript:"));
    expect(transcript).toContain("handleCameraCommand(text)");
    expect(transcript).not.toMatch(/handleCommand\(|classify\(/);
    const completed = realtime.slice(realtime.indexOf('"conversation.item.input_audio_transcription.completed"'), realtime.indexOf('"response.created"'));
    expect(completed).toContain("this.checkApproval(");
    expect(LOCAL_ROUTING.realtime).toEqual({ matchers: ["camera", "approval"], firstClaimWins: false });
  });

  it("handleCommand runs the camera rules before classify, and approval only through realtime.sendText", () => {
    const body = main.slice(main.indexOf("async function handleCommand("), main.indexOf("async function cancelTask("));
    expect(body.indexOf("handleCameraCommand(text)")).toBeGreaterThan(-1);
    expect(body.indexOf("handleCameraCommand(text)")).toBeLessThan(body.indexOf("classify(text)"));
    expect(body).toContain("realtime.sendText(intent.text)");
    const sendText = realtime.slice(realtime.indexOf("  sendText(text: string): void {"), realtime.indexOf("  addContext("));
    expect(sendText).toContain("this.checkApproval(text)");
  });

  // handleCommand 每個 case 的原始碼片段（case "progress": … 到下一個 case）。
  const handleCommand = main.slice(main.indexOf("async function handleCommand("), main.indexOf("async function cancelTask("));
  const cases = Object.fromEntries(
    handleCommand.split(/\n    case "/).slice(1).map((chunk) => [chunk.slice(0, chunk.indexOf('"')), chunk] as const),
  );
  const functionBody = (name: string) => main.slice(main.indexOf(`async function ${name}(`), main.indexOf("\n}\n", main.indexOf(`async function ${name}(`)));
  const showsSurface = (block: string) =>
    block.includes('dispatch({ type: "show.')
    || (block.includes("selectProvider(") && functionBody("selectProvider").includes('dispatch({ type: "show.'))
    || (block.includes("cancelTask(") && functionBody("cancelTask").includes('dispatch({ type: "show.'));

  it("every case is found (the slicing still matches the source)", () => {
    expect(Object.keys(cases).sort()).toEqual([...Object.keys(INTENT_COMMANDS), "task"].sort());
  });

  it("typed text reaches realtime.sendText (and so checkApproval) exactly for task and LOCAL_ROUTING.typed.alsoSendsText", () => {
    const sending = Object.entries(cases).filter(([, block]) => block.includes("realtime.sendText(")).map(([kind]) => kind);
    expect(sending.sort()).toEqual(["task", ...(LOCAL_ROUTING.typed.alsoSendsText ?? [])].sort());
    for (const channel of ["push_to_talk", "voice_mode", "realtime"] as const) expect(LOCAL_ROUTING[channel].alsoSendsText).toBeUndefined();
  });

  it("an intent that also sends text has already replaced the confirm card first, so its checkApproval decides nothing", () => {
    for (const kind of LOCAL_ROUTING.typed.alsoSendsText ?? []) {
      const block = cases[kind];
      expect(block.indexOf('dispatch({ type: "show.')).toBeGreaterThan(-1);
      expect(block.indexOf('dispatch({ type: "show.')).toBeLessThan(block.indexOf("realtime.sendText("));
      expect(REPLACES_CONFIRM_CARD).toContain(kind);
    }
  });

  it("REPLACES_CONFIRM_CARD lists exactly the intents whose case dispatches show.*, and dispatch rejects a replaced card", () => {
    const showing = Object.entries(cases).filter(([kind, block]) => kind !== "task" && showsSurface(block)).map(([kind]) => kind);
    expect(showing.sort()).toEqual([...REPLACES_CONFIRM_CARD].sort());
    const dispatchBody = main.slice(main.indexOf("function dispatch(event: ShellEvent)"), main.indexOf("// ───────────── 伺服器事件"));
    expect(dispatchBody).toContain('shell.surface?.kind === "confirm" && next.surface?.surface_id !== shell.surface.surface_id');
    expect(dispatchBody).toContain('realtime.resolveApproval(false, "dismissed")');
  });

  it("the typed-replaces-card caveat covers every intent in REPLACES_CONFIRM_CARD", () => {
    const caveat = CAVEATS.find((c) => c.id === "typed-replaces-card")!;
    expect([...new Set(caveat.cases.map((c) => c.checks.intent))].sort()).toEqual([...REPLACES_CONFIRM_CARD].sort());
  });

  it("Esc never stops a task, and the table never says it does", () => {
    const esc = main.slice(main.indexOf('if (e.key === "Escape") {'), main.indexOf("return;", main.indexOf('if (e.key === "Escape") {')));
    expect(esc).not.toMatch(/cancelTask|api\.cancel|"stop"/);
    const texts = [...CAVEATS.map((c) => c.truth), ...CONTROLS.map((c) => c.does)];
    for (const text of texts) {
      for (const sentence of text.split(/[。；]/)) {
        if (sentence.includes("Esc") && sentence.includes("停止任務")) expect(sentence).toContain("不會停止任務");
      }
    }
  });

  it("look-to-talk starts only after realtime consent was given, and the row says so", () => {
    const sense = main.slice(main.indexOf("canAutoTalk:"), main.indexOf("\n", main.indexOf("canAutoTalk:")));
    expect(sense).toContain('hasVoiceConsent("realtime")');
    expect(CONTROLS.find((c) => c.id === "look")?.does).toContain("同意");
  });
});

describe("commandSections", () => {
  it("marks unmet preconditions and shows the live seconds when given the settings", () => {
    const sections = commandSections({
      cameraEnabled: false, realtimeAvailable: false, webSearch: false, home: false,
      seconds: { look_to_talk_s: 1.6, look_to_talk_cooldown_s: 10, voice_idle_s: 60, realtime_idle_s: 300 },
    });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.id === "camera-off")?.unmet).toBe("目前：鏡頭未啟用");
    expect(rows.find((r) => r.id === "preview-off")?.unmet).toBeNull();
    expect(rows.find((r) => r.id === "ai-web_search")?.unmet).toBe("目前：上網查詢不可用");
    expect(rows.find((r) => r.id === "voice-idle")?.cells[1]).toContain("目前 1 分鐘（預設 1 分 30 秒）");
    expect(rows.find((r) => r.id === "realtime-idle")?.cells[1]).toContain("目前 5 分鐘（預設 2 分鐘）");
    expect(rows.find((r) => r.id === "look")?.cells[1]).toContain("目前 1.6 秒");
  });

  it("without settings (README) nothing is marked and seconds show only the defaults", () => {
    const rows = commandSections(null).flatMap((s) => s.rows);
    expect(rows.every((r) => r.unmet === null)).toBe(true);
    expect(rows.find((r) => r.id === "voice-idle")?.cells[1]).toContain("預設 1 分 30 秒");
    expect(rows.map((r) => r.cells.join(" ")).join("\n")).not.toContain("目前 ");
  });
});
