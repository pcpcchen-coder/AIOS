import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WAKE_CALL_TICK_MS, WakeCallWatch } from "../src/audio/wake-call.ts";
import { NO_VOICE_TIMEOUT_MS } from "../src/audio/no-voice.ts";
import { greetingFor, wakeTriggerAction } from "../src/realtime-session.ts";
import { FakeClock } from "./fixtures/wake.ts";

// WK-02：喚醒開始的通話「沒人出聲就結束」（docs/17 §5.7 第 2 點；George 2026-10-31：沉默 5 秒）。
// 假時鐘與假計時器（fixture）：證明的是規則，不是真的音量門檻或 VAD 表現（WK-03 在 Mac 實測）。

function watch() {
  const clock = new FakeClock();
  const ticks: { run: () => void; cancelled: boolean }[] = [];
  const onTimeout = vi.fn();
  const w = new WakeCallWatch({
    now: clock.now,
    every: (run) => {
      const tick = { run, cancelled: false };
      ticks.push(tick);
      return () => (tick.cancelled = true);
    },
    onTimeout,
  });
  /** 推進時間並跑一次還有效的計時器（每 WAKE_CALL_TICK_MS 一次）。 */
  const advance = (ms: number) => {
    for (let left = ms; left > 0; left -= WAKE_CALL_TICK_MS) {
      clock.advance(Math.min(WAKE_CALL_TICK_MS, left));
      for (const tick of ticks) if (!tick.cancelled) tick.run();
    }
  };
  const activeTicks = () => ticks.filter((t) => !t.cancelled).length;
  return { w, clock, onTimeout, advance, activeTicks };
}

describe("WakeCallWatch", () => {
  it("is 5 seconds by George's decision", () => {
    expect(NO_VOICE_TIMEOUT_MS).toBe(5000);
  });

  it("starts at the first listening and ends the call after 5 s of silence (once)", () => {
    const h = watch();
    h.w.phase("connecting");
    h.advance(10_000);
    expect(h.w.state).toBe("idle"); // 還沒就緒不倒數
    h.w.phase("listening");
    expect(h.w.state).toBe("counting");
    h.advance(4_750);
    h.w.feed(0.001); // 安靜
    expect(h.onTimeout).not.toHaveBeenCalled();
    h.advance(250);
    expect(h.onTimeout).toHaveBeenCalledTimes(1);
    expect(h.w.state).toBe("timed_out");
    expect(h.activeTicks()).toBe(0);
    h.advance(10_000);
    h.w.phase("listening");
    expect(h.onTimeout).toHaveBeenCalledTimes(1);
  });

  it("pauses while Nous speaks or thinks and restarts a full 5 s when listening again", () => {
    const h = watch();
    h.w.phase("listening");
    h.advance(3_000);
    h.w.phase("speaking"); // 問候
    expect(h.w.state).toBe("paused");
    h.advance(20_000);
    expect(h.onTimeout).not.toHaveBeenCalled();
    h.w.phase("listening");
    h.advance(4_750);
    expect(h.onTimeout).not.toHaveBeenCalled();
    h.w.phase("thinking");
    h.advance(10_000);
    h.w.phase("listening");
    h.advance(5_000);
    expect(h.onTimeout).toHaveBeenCalledTimes(1);
  });

  it("hearing speech (level above the threshold, or the server's hearing phase) disarms it for the rest of the call", () => {
    const h = watch();
    h.w.phase("listening");
    h.advance(1_000);
    for (let i = 0; i < 8; i++) {
      h.w.feed(0.2); // 連續超過門檻（未校準的 RMS 門檻）
      h.clock.advance(50);
    }
    expect(h.w.state).toBe("disarmed");
    h.w.phase("speaking");
    h.w.phase("listening");
    h.advance(60_000);
    expect(h.onTimeout).not.toHaveBeenCalled();

    const g = watch();
    g.w.phase("listening");
    g.w.phase("hearing");
    expect(g.w.state).toBe("disarmed");
    g.advance(60_000);
    expect(g.onTimeout).not.toHaveBeenCalled();
  });

  it("typing disarms it; stop() ends everything; levels before listening are ignored", () => {
    const h = watch();
    h.w.feed(0.5);
    h.w.phase("listening");
    h.w.disarm();
    h.advance(60_000);
    expect(h.onTimeout).not.toHaveBeenCalled();
    const s = watch();
    s.w.phase("listening");
    s.w.stop();
    expect(s.w.state).toBe("stopped");
    expect(s.activeTicks()).toBe(0);
    s.advance(60_000);
    expect(s.onTimeout).not.toHaveBeenCalled();
  });
});

describe("wake trigger → call (pure parts of src/main.ts)", () => {
  it("ignores a trigger during a call, while starting or with the family view open; reports when realtime is unavailable", () => {
    expect(wakeTriggerAction({ callActive: true, familyOpen: false, realtimeReady: true })).toBe("ignore");
    expect(wakeTriggerAction({ callActive: false, familyOpen: true, realtimeReady: true })).toBe("ignore");
    expect(wakeTriggerAction({ callActive: false, familyOpen: false, realtimeReady: false })).toBe("unavailable");
    expect(wakeTriggerAction({ callActive: false, familyOpen: false, realtimeReady: true })).toBe("start");
    // 沒有即時語音同意：每個限速時窗最多打開一次同意說明
    expect(wakeTriggerAction({ callActive: false, familyOpen: false, realtimeReady: true, consent: false, consentAskedRecently: false })).toBe("ask_consent");
    expect(wakeTriggerAction({ callActive: false, familyOpen: false, realtimeReady: true, consent: false, consentAskedRecently: true })).toBe("ignore");
    expect(wakeTriggerAction({ callActive: false, familyOpen: false, realtimeReady: true, consent: true, consentAskedRecently: true })).toBe("start");
  });

  it("a wake start always greets (no setting is read); look_to_talk still follows its setting; user never greets", async () => {
    const off = () => false;
    const wake = greetingFor("wake_word", off, { decide: async () => "我在" });
    expect(wake).not.toBeNull();
    expect(await wake!.take("api_key")).toBe("我在");
    expect(await wake!.take("api_key")).toBeNull(); // 一次喚醒最多一次（改路徑時共用同一個物件）
    const look = greetingFor("look_to_talk", off);
    expect(await look!.take("api_key")).toBeNull();
    expect(greetingFor("user", () => true)).toBeNull();
  });

  it("src/main.ts wires the trigger handler, the no-voice end and the F6 end reason", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("wake.setTriggerHandler(onWakeTrigger);");
    expect(main).toContain('startRealtime("wake_word", { wake: trigger });');
    expect(main).toMatch(/stopRealtime\("no_voice"\);\s*showSubtitle\(t\(WAKE_TEXT\.noVoice\)\);/);
    expect(main).toMatch(/if \(!decision\.ok && decision\.wake_limited\) wake\?\.pauseFor\("rate_limited", /);
    expect(main).toMatch(/if \(source === "typed"\) wakeCall\?\.disarm\(\);/);
    // F6 一律記錄（不綁喚醒開關）：/end 一律帶結束原因，API key 路徑一律帶 usage
    expect(main).toMatch(/end: async \(\) => void \(await api\.realtimeEnd\(ticket, \{ reason: takeEndReason\(ticket\.session_id\) \}\)\)/);
    expect(main).toMatch(/api\.realtimeEnd\(ticketOf\(ticket\), \{ reason: takeEndReason\(ticket\.session_id\), usage: realtime\.usage \?\? null \}\)/);
    // 通話在問候決定前結束：同步辨識不再放寬
    const stop = main.slice(main.indexOf("function stopRealtime("), main.indexOf("function makeRealtimeSession("));
    expect(stop).toContain("wakeGreetingInteraction = null;");
    const callbacks = main.slice(main.indexOf("const realtimeCallbacks: RealtimeCallbacks = {"));
    const closed = callbacks.slice(callbacks.indexOf("onClosed: (reason) => {"), callbacks.indexOf("onClosed: (reason) => {") + 200);
    expect(closed).toContain("wakeGreetingInteraction = null;");
    // 喚醒打開的同意說明：同意後以 wake_word 開始
    expect(main).toContain('startRealtime(wakeTrigger ? "wake_word" : "user", wakeTrigger ? { wake: wakeTrigger } : {})');
  });
});

describe("WK-02 copy is in the shared translation tables", () => {
  it("every new wake string has an English entry without Chinese characters", async () => {
    const { translate } = await import("../shared/i18n.mjs");
    const { WAKE_REASON_LABEL, WAKE_TEXT } = await import("../shared/wake.ts");
    const { localize } = await import("../server/localization.ts");
    const { WAKE_LIMITED_TEXT } = await import("../server/realtime-routes.ts");
    const han = /\p{Script=Han}/u;
    for (const source of [WAKE_REASON_LABEL.rate_limited, WAKE_TEXT.noVoice]) {
      const en = translate(source, "en");
      expect(en, source).not.toBe(source);
      expect(han.test(en), en).toBe(false);
    }
    expect(translate(WAKE_TEXT.unavailable, "en", "Not configured")).toBe("Realtime voice is unavailable (Not configured)");
    expect(translate("這個環境不支援即時語音", "en")).toBe("This environment does not support realtime voice");
    const limited = localize(WAKE_LIMITED_TEXT, "en");
    expect(han.test(limited), limited).toBe(false);
    expect(WAKE_REASON_LABEL.rate_limited).toContain("3 次");
  });
});
