import { afterEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
function environment(initial?: string, native?: string) {
  values.clear();
  if (initial) values.set("nous.locale", initial);
  const events = new Map<string, (event: { key: string; newValue: string | null }) => void>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("document", { documentElement: { lang: "" } });
  vi.stubGlobal("window", { ...(native ? { nousDesktop: { initialLocale: native } } : {}), addEventListener: (type: string, callback: (event: { key: string; newValue: string | null }) => void) => events.set(type, callback) });
  return events;
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("frontend language state", () => {
  it("keeps every transcript byte after the localized speaker prefix, including UI words and punctuation", async () => {
    environment("en");
    const locale = await import("../src/i18n.ts");
    const text = "設定；收起、取消\n鏡頭";
    for (const speaker of ["user", "assistant"] as const) {
      const english = locale.transcriptText(speaker, text);
      expect(english).toBe((speaker === "user" ? "You: " : "Nous: ") + text);
      locale.setLocale("zh-TW");
      expect(locale.transcriptText(speaker, text)).toBe((speaker === "user" ? "你：" : "Nous：") + text);
      locale.setLocale("en");
    }
  });

  it("carries the original chat locale through a late delegation after an interface switch", async () => {
    environment("en");
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const locale = await import("../src/i18n.ts");
    const { api } = await import("../src/api.ts");
    const { ConversationSession } = await import("../src/conversation.ts");
    let release: () => void = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const used: unknown[] = [];
    const delegated: Promise<unknown>[] = [];
    const chat = new ConversationSession({
      stream: async (_messages, _request, event, _signal, requestLocale) => {
        used.push(requestLocale);
        await waiting;
        event({ type: "delegate", title: "設定" });
        event({ type: "done", model: "fixture" });
      },
      output: () => ({ push: () => {}, end: () => {}, cancel: () => {} }), changed: () => {},
      delegated: (title, request, requestLocale) => { delegated.push(api.createTask(title, request, requestLocale)); },
    });
    const pending = chat.send("Please prepare a report", "req_fixture", locale.getLocale());
    locale.setLocale("zh-TW");
    release();
    await pending;
    await Promise.all(delegated);
    expect(used).toEqual(["en"]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Nous-Locale": "en" }, body: JSON.stringify({ text: "設定", request_id: "req_fixture" }) });
  });

  it("retains continuous recognition and TTS language until the voice session restarts", async () => {
    environment("en");
    const instances: RecognitionFixture[] = [];
    class RecognitionFixture {
      lang = "";
      onend: (() => void) | null = null;
      start() {}
      abort() {}
      constructor() { instances.push(this); }
    }
    Object.assign(window, { webkitSpeechRecognition: RecognitionFixture });
    class UtteranceFixture {
      lang = "";
      onend: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    const spoken: UtteranceFixture[] = [];
    vi.stubGlobal("SpeechSynthesisUtterance", UtteranceFixture);
    vi.stubGlobal("speechSynthesis", { cancel: () => {}, getVoices: () => [], speak: (utterance: UtteranceFixture) => { spoken.push(utterance); queueMicrotask(() => utterance.onend?.()); } });
    const locale = await import("../src/i18n.ts");
    const { VoiceConversation } = await import("../src/voice.ts");
    const voice = new VoiceConversation({ onUtterance: () => {}, onInterim: () => {}, onStateChange: () => {}, onBargeIn: () => {}, onClosed: () => {} }, { idleMs: 30000 });
    voice.start();
    locale.setLocale("zh-TW");
    instances[0]?.onend?.();
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(instances[1]?.lang).toBe("en-US");
    await voice.speak("設定。");
    expect(spoken[0]?.lang).toBe("en-US");
    voice.stop();
    voice.start();
    expect(instances[2]?.lang).toBe("zh-TW");
    voice.stop();
  });

  it("keeps fallback greeting language fixed for an already-started voice interaction", async () => {
    environment("en");
    const locale = await import("../src/i18n.ts");
    const { GreetingOnce } = await import("../src/realtime-session.ts");
    const greeting = new GreetingOnce(() => true, { interaction: "int_fixture", decide: async () => { throw new Error("fixture unavailable"); } });
    locale.setLocale("zh-TW");
    const instruction = await greeting.take("api_key");
    expect(instruction).toContain("I'm here");
    expect(instruction).toContain("English");
  });

  it("selects recognition and computer-speech languages without translating spoken content", async () => {
    environment("en");
    const recognitionInstances: { lang: string }[] = [];
    class RecognitionFixture {
      lang = "";
      start() {}
      abort() {}
      constructor() { recognitionInstances.push(this); }
    }
    Object.assign(window, { webkitSpeechRecognition: RecognitionFixture });
    const locale = await import("../src/i18n.ts");
    const voice = await import("../src/voice.ts");
    const input = new voice.PushToTalk({ onInterim: () => {}, onFinal: () => {}, onListeningChange: () => {}, onError: () => {} });
    input.start();
    expect(recognitionInstances[0]?.lang).toBe("en-US");
    input.abort();
    locale.setLocale("zh-TW");
    input.start();
    expect(recognitionInstances[1]?.lang).toBe("zh-TW");
    input.abort();
    class UtteranceFixture {
      lang = "";
      voice: unknown;
      onend: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    const spoken: UtteranceFixture[] = [];
    vi.stubGlobal("SpeechSynthesisUtterance", UtteranceFixture);
    vi.stubGlobal("speechSynthesis", { cancel: () => {}, getVoices: () => [{ lang: "en-US" }, { lang: "zh-TW" }], speak: (utterance: UtteranceFixture) => { spoken.push(utterance); queueMicrotask(() => utterance.onend?.()); } });
    locale.setLocale("en");
    await voice.speakText("設定");
    expect(spoken[0]?.lang).toBe("en-US");
    expect(spoken[0]?.text).toBe("設定");
  });

  it("defaults to Traditional Chinese, remembers English, and follows storage changes without reload", async () => {
    const events = environment();
    const locale = await import("../src/i18n.ts");
    expect(locale.getLocale()).toBe("zh-TW");
    const changed = vi.fn();
    const off = locale.onLocaleChange(changed);
    locale.setLocale("en");
    expect(values.get("nous.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(locale.t("設定")).toBe("Settings");
    events.get("storage")?.({ key: "nous.locale", newValue: "zh-TW" });
    expect(locale.t("設定")).toBe("設定");
    expect(changed).toHaveBeenCalledTimes(2);
    off();
    locale.setLocale("en");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("loads the saved browser preference and gives native persisted language precedence", async () => {
    environment("en");
    expect((await import("../src/i18n.ts")).getLocale()).toBe("en");
    vi.resetModules();
    environment("en", "zh-TW");
    expect((await import("../src/i18n.ts")).getLocale()).toBe("zh-TW");
  });

  it("keeps session language usable if local storage is unavailable", async () => {
    environment();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } });
    const locale = await import("../src/i18n.ts");
    expect(() => locale.setLocale("en")).not.toThrow();
    expect(locale.getLocale()).toBe("en");
  });

  it("translates only template wording and keeps names, symbols, and source content intact", async () => {
    environment("en");
    const locale = await import("../src/i18n.ts");
    const name = "設定 <family> $& {9}";
    expect(locale.msg`認得：${name}`).toBe(`Recognized: ${name}`);
    expect(locale.uiText("ChatGPT 方案路徑尚未登入（設定 → 即時語音 → 用 ChatGPT 方案登入）；未設定 OPENAI_API_KEY")).toBe("ChatGPT plan route is signed out (Settings → Realtime voice → Sign in with ChatGPT plan); OPENAI_API_KEY is not configured");
    expect(locale.t("Untranslated user-authored content")).toBe("Untranslated user-authored content");
  });

  it("sends request language without putting locale in strict settings patch bodies", async () => {
    environment("en");
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const locale = await import("../src/i18n.ts");
    const { api } = await import("../src/api.ts");
    const sessionLanguage = locale.getLocale();
    locale.setLocale("zh-TW");
    await api.createTask("設定", "req_fixture", sessionLanguage);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Nous-Locale": "en" }, body: JSON.stringify({ text: "設定", request_id: "req_fixture" }) });
    await api.updateCamera({ active: false });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { "X-Nous-Locale": "zh-TW" }, body: JSON.stringify({ active: false }) });
  });
});
