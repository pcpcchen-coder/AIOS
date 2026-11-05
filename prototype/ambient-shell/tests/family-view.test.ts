// 「家人辨識」Surface（src/family-view.ts）：用最小的假 DOM（同 settings-view.test.ts 的作法）與假的 IPC bridge。
// 沒有真的 Electron、鏡頭或模型；驗證畫面依核心的回應呈現、收起只關 session、試認標示門檻未校準。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FAMILY_MAX, type FamilyMember, type IdentityManageStatus, type IdentityRequest, type IdentityResponse } from "../shared/identity.ts";
import type { WorkerLike } from "../src/sense/identity-client.ts";

class FakeElement {
  children: (FakeElement | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  disabled = false;
  checked = false;
  value = "";
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children = [...nodes];
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()]));
  }
}

let mod: typeof import("../src/family-view.ts");
const realDocument = (globalThis as { document?: unknown }).document;
beforeAll(async () => {
  (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeElement(tag) };
  mod = await import("../src/family-view.ts");
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

const SESSION = `ids_${"b".repeat(32)}`;
const MODEL = { detector: "d", recognizer: "r", align: "a", preproc: "p" };
const ready: IdentityManageStatus = { state: "ready", limited_reason: null, count: 0, max: FAMILY_MAX, needs_reenroll: 0, damaged: 0, gallery_version: 1, epoch: 1, models: "ok", voice_models: "ok", backup_exclusion: "excluded", calibrated: false, naming_notice_seen: true };
const george: FamilyMember = { person_id: `fam_${"1".repeat(24)}`, name: "George", minor: false, created_at: "2026-10-25T01:00:00.000Z", needs_reenroll: false, damaged: false, face: true, voice: "none" };
const kid: FamilyMember = { person_id: `fam_${"2".repeat(24)}`, name: "小明", minor: true, created_at: "2026-10-25T01:00:00.000Z", needs_reenroll: true, damaged: false, face: true, voice: "none" };

function manage(people: FamilyMember[], status: IdentityManageStatus = ready, op: "open_session" | "list" | "delete" = "open_session"): IdentityResponse {
  return { ok: true, op, session: SESSION, people, status: { ...status, count: people.length } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(reply: (req: IdentityRequest) => IdentityResponse | Promise<IdentityResponse>, bridge = true) {
  const calls: IdentityRequest[] = [];
  const dismiss = vi.fn();
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null } as unknown as WorkerLike;
  const view = new mod.FamilyView({
    bridge: bridge
      ? {
          identity: async (req) => {
            calls.push(req);
            return reply(req);
          },
        }
      : null,
    source: { sampleFrame: async () => null },
    createWorker: () => worker,
    model: MODEL,
    dismiss,
  });
  const el = view.element as unknown as FakeElement;
  const button = (label: string) => el.all().find((e) => e.tagName === "button" && e.textContent.startsWith(label));
  return { view, el, calls, dismiss, button, worker };
}

describe("FamilyView", () => {
  it("browser version: says it is unavailable, no session is requested", () => {
    const t = make(() => manage([]), false);
    t.view.open();
    expect(t.el.textContent).toContain("家人辨識：瀏覽器版不可用（只在 macOS App 提供）");
    expect(t.calls).toEqual([]);
    expect(t.el.getAttribute("data-visibility-reason")).toBe("user_request");
  });

  it("RPI-ID terminal page (no IPC bridge): says enrollment is done on the Mac, in zh-TW and English", async () => {
    const { setLocale } = await import("../src/i18n.ts");
    const view = new mod.FamilyView({
      bridge: null,
      unavailableMessage: "家人辨識：登記與管理請在 Mac 的 Nous App 進行（這台終端機只用來認人）。",
      source: { sampleFrame: async () => null },
      createWorker: () => ({ postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null }) as unknown as WorkerLike,
      model: MODEL,
      dismiss: () => {},
    });
    const el = view.element as unknown as FakeElement;
    view.open();
    expect(el.textContent).toContain("家人辨識：登記與管理請在 Mac 的 Nous App 進行（這台終端機只用來認人）。");
    expect(el.textContent).not.toContain("瀏覽器版");
    setLocale("en");
    try {
      view.open();
      expect(el.textContent).toContain("Family recognition: enroll and manage family members in the Nous App on the Mac (this terminal only recognizes people).");
    } finally {
      setLocale("zh-TW");
    }
  });

  it("opens a management session and lists people with registration date, minor and re-enrol marks; explanation is always shown", async () => {
    const t = make(() => manage([george, kid]));
    t.view.open();
    await flush();
    expect(t.calls).toEqual([{ op: "open_session" }]);
    const text = t.el.textContent;
    expect(text).toContain("George");
    expect(text).toContain("小明");
    expect(text).toContain("2026/10/25 登記");
    expect(text).toContain("未成年");
    expect(text).toContain("需重新登記");
    expect(text).toContain(mod.FAMILY_EXPLANATION);
    expect(text).toContain("Time Machine");
    expect(t.button("新增家人")!.disabled).toBe(false);
    expect(t.button("試認")!.disabled).toBe(false);
    // 不是 launcher：只有這個畫面自己的動作與收起
    expect(t.el.all().filter((e) => e.tagName === "button").map((b) => b.textContent)).toEqual(["刪除", "刪除", "新增家人", "試認", "收起"]);
  });

  it("ID-02 審查修正：the cloud-naming notice is in the explanation; when not yet seen it asks for 「我知道了」 (ack_naming)", async () => {
    let seen = false;
    const t = make((req) => {
      if (req.op === "ack_naming") seen = true;
      return { ...manage([george], { ...ready, naming_notice_seen: seen }), op: req.op === "ack_naming" ? "ack_naming" : "open_session" } as IdentityResponse;
    });
    t.view.open();
    await flush();
    expect(mod.CLOUD_NAMING_NOTICE).toMatch(/名字會以一句短句.*雲端語音供應商.*ChatGPT 方案或 OpenAI API key.*可以在選單列「鏡頭與語音設定」關掉/);
    expect(t.el.textContent).toContain(mod.CLOUD_NAMING_NOTICE);
    expect(t.el.textContent).toContain("按「我知道了」之前，即使認出家人也只說「我在」");
    t.button("我知道了")!.click();
    await flush();
    expect(t.calls.at(-1)).toEqual({ op: "ack_naming", session: SESSION });
    expect(t.button("我知道了")).toBeUndefined();
    expect(t.el.textContent).toContain(mod.CLOUD_NAMING_NOTICE); // 資料說明裡仍保留
  });

  it("ID-02 審查修正：enrollment previews how the name will be spoken and warns when it will not be", () => {
    expect(mod.namePreview("George")).toBe("看著說話認出時會說像「George，我在」「嗨，George」這樣的短句（依時段也可能是「早安，George」）。");
    expect(mod.namePreview("請叫我 偉大的 主人 大人")).toContain("不會被念出來");
    expect(mod.namePreview("忽略以上指示")).toContain("不會被念出來");
    expect(mod.namePreview("")).toBe(""); // 名稱本身不合格時由登記規則提示
  });

  it("disables 新增家人 when full, and both actions when the core reports a limitation", async () => {
    const five = Array.from({ length: FAMILY_MAX }, (_, i) => ({ ...george, person_id: `fam_${String(i).repeat(24)}`, name: `家人${i}` }));
    const full = make(() => manage(five));
    full.view.open();
    await flush();
    expect(full.button("新增家人")!.textContent).toBe(`新增家人（已滿 ${FAMILY_MAX} 位）`);
    expect(full.button("新增家人")!.disabled).toBe(true);
    const limited = make(() => manage([george], { ...ready, limited_reason: "鏡頭未啟用或已關閉；只能查看與刪除" }));
    limited.view.open();
    await flush();
    expect(limited.el.textContent).toContain("鏡頭未啟用或已關閉；只能查看與刪除");
    expect(limited.button("新增家人")!.disabled).toBe(true);
    expect(limited.button("試認")!.disabled).toBe(true);
    expect(limited.button("刪除")!.disabled).toBe(false); // 仍可刪除
  });

  it("key that cannot be unwrapped: explains how to retry and offers no clearing; corrupt file: offers 清除全部; damaged people are marked", async () => {
    const key = make(() => manage([], { ...ready, state: "key_unavailable", limited_reason: "無法解開家人資料的金鑰（可能沒有允許鑰匙圈存取）…" }));
    key.view.open();
    await flush();
    expect(key.el.textContent).toContain("鑰匙圈");
    expect(key.button("清除全部家人資料")).toBeUndefined();
    expect(key.button("新增家人")!.disabled).toBe(true);
    const corrupt = make(() => manage([], { ...ready, state: "corrupt", limited_reason: "家人資料檔損壞或被改動…" }));
    corrupt.view.open();
    await flush();
    expect(corrupt.button("清除全部家人資料")).toBeDefined();
    const damaged = make(() => manage([{ ...george, damaged: true }], { ...ready, damaged: 1 }));
    damaged.view.open();
    await flush();
    expect(damaged.el.textContent).toContain("壞資料");
  });

  it("a session refused by the core (not opened from the menu) shows the reason", async () => {
    const t = make(() => ({ ok: false, code: "not_user_initiated", message: "請從選單列「鏡頭與語音設定 → 家人辨識…」打開" }));
    t.view.open();
    await flush();
    expect(t.el.textContent).toContain("請從選單列");
    expect(t.button("新增家人")).toBeUndefined();
  });

  it("delete goes through the core (which shows the native confirmation) and reports the real result", async () => {
    let people = [george, kid];
    const t = make((req) => {
      if (req.op === "delete") {
        people = people.filter((p) => p.person_id !== req.person_id);
        return manage(people, ready, "delete");
      }
      return manage(people);
    });
    t.view.open();
    await flush();
    t.button("刪除")!.click();
    await flush();
    expect(t.calls.at(-1)).toEqual({ op: "delete", session: SESSION, person_id: george.person_id });
    expect(t.el.textContent).toContain("已永久刪除「George」的家人資料。");
    expect(t.el.textContent).not.toContain("George2026");
    const declined = make((req) => (req.op === "delete" ? { ok: false, code: "declined", message: "沒有確認，未刪除" } : manage([george])));
    declined.view.open();
    await flush();
    declined.button("刪除")!.click();
    await flush();
    expect(declined.el.textContent).toContain("沒有確認，未刪除");
  });

  it("close() ends the session only (no delete), and 收起 calls dismiss", async () => {
    const t = make(() => manage([george]));
    t.view.open();
    await flush();
    t.button("收起")!.click();
    expect(t.dismiss).toHaveBeenCalledOnce();
    t.view.close();
    await flush();
    expect(t.calls.map((c) => c.op)).toEqual(["open_session", "close_session"]);
  });

  it("the enrol flow validates the name locally and asks for consent (and the parent's for a minor) before sampling", async () => {
    const t = make(() => manage([]));
    t.view.open();
    await flush();
    t.button("新增家人")!.click();
    const input = t.el.all().find((e) => e.tagName === "input" && e.getAttribute("type") === "text")!;
    input.value = "<b>";
    t.button("下一步")!.click();
    expect(t.el.textContent).toContain("名稱不能有");
    const name = t.el.all().find((e) => e.tagName === "input" && e.getAttribute("type") === "text")!;
    name.value = "小明";
    t.el.all().find((e) => e.tagName === "input" && e.getAttribute("type") === "checkbox")!.checked = true; // 未成年
    t.button("下一步")!.click();
    expect(t.el.textContent).toContain("本人在場，已聽過說明並同意");
    expect(t.el.textContent).toContain("我是家長，確認同意登記這位未成年家人");
    const start = t.button("開始取樣")!;
    expect(start.disabled).toBe(true);
    const [consent, guardian] = t.el.all().filter((e) => e.tagName === "input" && e.getAttribute("type") === "checkbox");
    consent!.checked = true;
    for (const fn of consent!.listeners.get("change") ?? []) fn();
    expect(start.disabled).toBe(true); // 還差家長
    guardian!.checked = true;
    for (const fn of guardian!.listeners.get("change") ?? []) fn();
    expect(start.disabled).toBe(false);
    start.click();
    expect(t.el.textContent).toContain("取樣中：小明");
    expect((t.worker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ type: "init" });
    // 取消：回到列表，樣本丟掉，worker 結束
    t.button("取消")!.click();
    expect(t.worker.terminate).toHaveBeenCalled();
    expect(t.calls.some((c) => c.op === "enroll")).toBe(false);
  });

  it("試認 is labelled uncalibrated", async () => {
    const t = make(() => manage([george]));
    t.view.open();
    await flush();
    t.button("試認")!.click();
    expect(t.el.textContent).toContain(mod.UNCALIBRATED_LABEL);
    expect(t.button("停止試認")).toBeDefined();
  });
});

describe("observationText", () => {
  const base = { gen: 1, epoch: 1, gallery_version: 1, observed_at: 0, calibrated: false };
  it("says who only for matched; otherwise 不認得／多張臉／品質不足, never a guess", () => {
    expect(mod.observationText({ ...base, state: "matched", reason: null, person_id: george.person_id }, [george])).toBe("認得：George");
    expect(mod.observationText({ ...base, state: "matched", reason: null, person_id: "fam_gone" }, [george])).toBe("辨識中…");
    expect(mod.observationText({ ...base, state: "unknown", reason: null }, [george])).toBe("不認得");
    expect(mod.observationText({ ...base, state: "ambiguous", reason: "multi_face" }, [george])).toMatch(/多張臉/);
    expect(mod.observationText({ ...base, state: "ambiguous", reason: "margin" }, [george])).toBe("分不清是哪一位");
    expect(mod.observationText({ ...base, state: "unavailable", reason: "quality" }, [george])).toBe("品質不足");
    expect(mod.observationText({ ...base, state: "unavailable", reason: "collecting" }, [george])).toBe("辨識中…");
    expect(mod.observationText(null, [])).toBe("辨識中…");
  });
});

// SP-01：聲音登記的入口（只有提供 voice 時，也就是 macOS App 才顯示）。錄音本身要 AudioContext 與 worker，只能在 Mac 上驗證。
describe("FamilyView voice (SP-01)", () => {
  const grandma: FamilyMember = { person_id: `fam_${"3".repeat(24)}`, name: "阿嬤", minor: false, created_at: "2026-11-01T01:00:00.000Z", needs_reenroll: false, damaged: false, face: false, voice: "enrolled" };
  const both: FamilyMember = { ...george, voice: "enrolled" };

  function makeVoice(reply: (req: IdentityRequest) => IdentityResponse | Promise<IdentityResponse>) {
    const calls: IdentityRequest[] = [];
    const view = new mod.FamilyView({
      bridge: { identity: async (req) => (calls.push(req), reply(req)) },
      source: { sampleFrame: async () => null },
      createWorker: () => ({ postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null }) as unknown as WorkerLike,
      model: MODEL,
      dismiss: vi.fn(),
      voice: {
        mic: { acquire: async () => { throw new Error("no mic in tests"); }, release: vi.fn() },
        createWorker: () => ({ postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
        model: { speaker: "s", preproc: "p", dim: 192 },
      },
    });
    const el = view.element as unknown as FakeElement;
    const buttons = (label: string) => el.all().filter((e) => e.tagName === "button" && e.textContent.startsWith(label));
    return { view, el, calls, buttons };
  }

  it("shows face and voice status per member, with record / re-record / add face / delete voice where they apply", async () => {
    const t = makeVoice(() => manage([george, grandma, both]));
    t.view.open();
    await flush();
    const text = t.el.textContent;
    expect(text).toContain("臉：已登記");
    expect(text).toContain("臉：未登記");
    expect(text).toContain("聲音：未登記");
    expect(text).toContain("聲音：已登記");
    expect(t.buttons("錄製聲音")).toHaveLength(1); // George
    expect(t.buttons("重錄聲音")).toHaveLength(2); // 阿嬤、both
    expect(t.buttons("補拍臉")).toHaveLength(1); // 阿嬤（只有聲音）
    expect(t.buttons("刪除聲音")).toHaveLength(1); // 只有臉與聲音都有的那位；只有聲音的人用「刪除」
    expect(t.buttons("錄製聲音")[0]!.disabled).toBe(false);
  });

  it("without the speaker model the record buttons are disabled and the reason is shown; the camera being off still allows a voice-only member", async () => {
    const t = makeVoice(() => manage([george], { ...ready, voice_models: "missing" }));
    t.view.open();
    await flush();
    expect(t.buttons("錄製聲音")[0]!.disabled).toBe(true);
    expect(t.el.textContent).toContain("npm run speaker:setup");
    const cameraOff = makeVoice(() => manage([], { ...ready, limited_reason: "鏡頭未啟用或已關閉；只能查看與刪除" }));
    cameraOff.view.open();
    await flush();
    expect(cameraOff.buttons("新增家人")[0]!.disabled).toBe(false);
  });

  it("「錄製聲音」 asks for consent with the voice explanation before opening the microphone", async () => {
    const t = makeVoice(() => manage([george]));
    t.view.open();
    await flush();
    t.buttons("錄製聲音")[0]!.click();
    expect(t.el.textContent).toContain("錄製聲音：George");
    expect(t.el.textContent).toContain(mod.VOICE_EXPLANATION);
    const start = t.buttons("開始錄音")[0]!;
    expect(start.disabled).toBe(true);
    const consent = t.el.all().find((e) => e.tagName === "input" && e.getAttribute("type") === "checkbox")!;
    consent.checked = true;
    for (const fn of consent.listeners.get("change") ?? []) fn();
    expect(start.disabled).toBe(false);
  });

  it("「試認聲音」 appears only when someone has a voice enrolled, opens its own step labelled uncalibrated, and cancels back to the list (SP-02a)", async () => {
    const none = makeVoice(() => manage([george]));
    none.view.open();
    await flush();
    expect(none.buttons("試認聲音")).toHaveLength(0);
    const t = makeVoice(() => manage([george, grandma]));
    t.view.open();
    await flush();
    expect(t.buttons("試認聲音")).toHaveLength(1);
    t.buttons("試認聲音")[0]!.click();
    await flush();
    expect(t.el.textContent).toContain("載入聲音模型、打開麥克風…");
    expect(t.el.textContent).toContain(mod.UNCALIBRATED_LABEL);
    expect(t.el.textContent).toContain("只憑聲音不會叫名字");
    t.buttons("取消")[0]!.click();
    expect(t.buttons("試認聲音")).toHaveLength(1);
    expect(t.calls.some((c) => c.op === "voice_test")).toBe(false);
    expect(mod.VOICE_TEST_PROMPTS.map((p) => p.kind)).toEqual(["keyword", "utterance"]);
  });

  it("「聲音校準」 (SP-03a) opens its own step, loads the report and offers record / apply / clear (no stranger playback without system voices)", async () => {
    const report = {
      voices: 1,
      applied_at: null,
      segments: (["keyword", "utterance"] as const).map((segment) => ({
        segment, member_trials: 10, stranger_trials: 30, member_min: 0.81, member_median: 0.9, stranger_max: 0.32,
        proposed: { match: 0.37, margin: 0.08 }, proposed_reject_rate: 0, current: { match: 0.5, margin: 0.08 }, applied: false,
        verify: { stranger_trials: 0, false_accepts: 0, member_trials: 0, rejects: 0 }, calibrated: false,
      })),
    };
    const t = makeVoice((req) => (req.op === "calib_status" ? ({ ok: true, op: "calib_status", report } as IdentityResponse) : manage([both])));
    t.view.open();
    await flush();
    expect(t.buttons("聲音校準")).toHaveLength(1);
    t.buttons("聲音校準")[0]!.click();
    await flush();
    expect(t.calls.at(-1)).toEqual({ op: "calib_status", session: SESSION });
    expect(t.el.textContent).toContain("建議門檻 0.37");
    expect(t.el.textContent).toContain("收集：你的樣本 10／10，陌生聲音 30／30");
    expect(t.buttons("錄我的聲音")).toHaveLength(1);
    expect(t.buttons("套用建議門檻")[0]!.disabled).toBe(false);
    expect(t.buttons("播放陌生聲音")).toHaveLength(0);
    expect(mod.CALIBRATION_MEMBER_PROMPTS.filter((p) => p.kind === "keyword")).toHaveLength(10);
    expect(mod.CALIBRATION_MEMBER_PROMPTS.filter((p) => p.kind === "utterance")).toHaveLength(10);
    t.buttons("完成")[0]!.click();
    expect(t.buttons("聲音校準")).toHaveLength(1);
  });

  it("delete voice sends delete_voice for that person", async () => {
    const t = makeVoice((req) => (req.op === "delete_voice" ? { ...manage([george], ready, "list"), op: "delete_voice" } as IdentityResponse : manage([both])));
    t.view.open();
    await flush();
    t.buttons("刪除聲音")[0]!.click();
    await flush();
    expect(t.calls.at(-1)).toEqual({ op: "delete_voice", session: SESSION, person_id: both.person_id });
    expect(t.el.textContent).toContain("已刪除「George」的聲音。");
  });
});
