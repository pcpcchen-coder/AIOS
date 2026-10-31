import { describe, expect, it, vi } from "vitest";
import { WakeController, type WakeHost } from "../src/audio/controller.ts";
import { AudioFrontEnd, micError, type FrontEndEvents } from "../src/audio/front-end.ts";
import type { WakeReport, WakeRuntimeState, WakeSettingsView } from "../shared/wake.ts";
import { FakeCapture, FakeClock, FakeEarcon, FakeMediaDevices, FakeStream, FakeTrack, flush } from "./fixtures/wake.ts";

// WK-01a AudioFrontEnd（docs/17 §5.1、§5.3、§5.5、§5.8、§10.3）：假的 MediaDevices 與擷取圖（fixture），狀態只由事件推進。

function setup(runtime: WakeRuntimeState = "ok") {
  const media = new FakeMediaDevices();
  const capture = new FakeCapture();
  const states: WakeReport[] = [];
  const listening: [string | null, string][] = [];
  const detected: number[] = [];
  let rt = runtime;
  // Web Speech 結束後的重新取得排到「下一個 macrotask」：測試自己決定什麼時候跑（不用牆鐘）。
  const deferred: (() => void)[] = [];
  const defer = (run: () => void) => {
    let cancelled = false;
    deferred.push(() => { if (!cancelled) run(); });
    return () => { cancelled = true; };
  };
  const runDeferred = () => { for (const run of deferred.splice(0)) run(); };
  const events: FrontEndEvents = {
    state: (r) => states.push(r),
    detected: (k) => detected.push(k),
    listening: (id, how) => listening.push([id, how]),
  };
  const fe = new AudioFrontEnd({ mediaDevices: media, capture, runtime: () => rt, defer }, events);
  return { media, capture, states, listening, detected, fe, runDeferred, setRuntime: (r: WakeRuntimeState) => (rt = r) };
}

describe("AudioFrontEnd: one microphone owner, states driven by device events", () => {
  it("off by default: no getUserMedia at all", async () => {
    const s = setup();
    s.fe.setPreference(false, null, "auto_resume");
    await flush();
    expect(s.media.calls).toEqual([]);
    expect(s.fe.current).toEqual({ state: "off", reason: null });
  });

  it("enable → armed → listening_local only after the worklet reports started; one getUserMedia with the realtime constraints", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    expect(s.media.calls).toHaveLength(1);
    expect(s.media.calls[0]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(s.fe.current).toEqual({ state: "armed", reason: "starting" });
    expect(s.capture.connects).toBe(1);
    // track 是 live、擷取圖也接好了，但 worklet 還沒處理第一塊：仍然不是聆聽中。
    expect(s.states.some((r) => r.state === "listening_local")).toBe(false);
    s.capture.last!.events.started();
    expect(s.fe.current).toEqual({ state: "listening_local", reason: null });
    expect(s.listening).toEqual([["mic-a", "enable"]]);
  });

  it("detections pass through only while listening_local", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.detected(0);
    expect(s.detected).toEqual([]);
    s.capture.last!.events.started();
    s.capture.last!.events.detected(1);
    expect(s.detected).toEqual([1]);
  });

  it("runtime missing: error runtime_missing and the microphone is never opened", async () => {
    const s = setup("missing");
    s.fe.setPreference(true, null, "enable");
    await flush();
    expect(s.media.calls).toEqual([]);
    expect(s.capture.connects).toBe(0);
    expect(s.fe.current).toEqual({ state: "error", reason: "runtime_missing" });
    expect(s.states.some((r) => r.state === "armed" || r.state === "listening_local")).toBe(false);
  });

  it("worker load_error after the mic opened: error, source stopped, graph stopped", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.failed("runtime_load_failed");
    expect(s.fe.current).toEqual({ state: "error", reason: "runtime_load_failed" });
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.capture.active).toBe(0);
  });

  it("permission denied → error permission_denied, never listening", async () => {
    const s = setup();
    s.media.failWith = "NotAllowedError";
    s.fe.setPreference(true, null, "enable");
    await flush();
    expect(s.fe.current).toEqual({ state: "error", reason: "permission_denied" });
    expect(s.capture.connects).toBe(0);
  });

  it("auto-resume uses the exact deviceId; a missing device is error device_missing (no fallback to another mic)", async () => {
    const s = setup();
    s.media.devices = ["mic-a"];
    s.fe.setPreference(true, "mic-b", "auto_resume");
    await flush();
    expect(s.media.calls).toHaveLength(1);
    expect((s.media.calls[0]!.audio as { deviceId: unknown }).deviceId).toEqual({ exact: "mic-b" });
    expect(s.fe.current).toEqual({ state: "error", reason: "device_missing" });
    expect(s.media.liveTracks()).toEqual([]);
  });

  it("auto-resume with the device present: armed(auto_resume) then listening, reported as auto_resume", async () => {
    const s = setup();
    s.fe.setPreference(true, "mic-b", "auto_resume");
    await flush();
    expect(s.fe.current).toEqual({ state: "armed", reason: "auto_resume" });
    s.capture.last!.events.started();
    expect(s.listening).toEqual([["mic-b", "auto_resume"]]);
  });

  it("track ended → error device_ended, no retry and no other device", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    (s.media.streams[0]!.tracks[0] as FakeTrack).unplug();
    await flush();
    expect(s.fe.current).toEqual({ state: "error", reason: "device_ended" });
    expect(s.media.calls).toHaveLength(1);
    expect(s.capture.active).toBe(0);
  });

  it("realtime lease returns a clone of the single source and disconnects the worklet (in_call); release returns to listening", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    const leased = (await s.fe.lease()) as unknown as FakeStream;
    expect(s.media.calls).toHaveLength(1); // 沒有第二次 getUserMedia
    expect(leased.tracks[0]!.origin).toBe(s.media.streams[0]!.tracks[0]);
    expect(s.fe.current).toEqual({ state: "in_call", reason: "realtime" });
    expect(s.capture.active).toBe(0); // worklet 斷開（環形緩衝由 stop 清空）
    // 即時語音結束時停的是複製品，來源還在
    leased.tracks[0]!.stop();
    expect(s.media.streams[0]!.tracks[0]!.stopped).toBe(false);
    s.fe.releaseLease(leased as unknown as MediaStream);
    s.fe.releaseLease(leased as unknown as MediaStream); // 可重複呼叫
    await flush();
    expect(s.fe.current).toEqual({ state: "armed", reason: "starting" });
    s.capture.last!.events.started();
    expect(s.fe.current.state).toBe("listening_local");
    expect(s.media.calls).toHaveLength(1);
  });

  it("with wake off, a lease opens the source on demand and stops it after the last lease (same as before)", async () => {
    const s = setup();
    const leased = (await s.fe.lease()) as unknown as FakeStream;
    expect(s.media.calls).toHaveLength(1);
    expect(s.fe.current.state).toBe("off");
    expect(s.capture.connects).toBe(0);
    leased.tracks[0]!.stop();
    s.fe.releaseLease(leased as unknown as MediaStream);
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.fe.hasSource).toBe(false);
  });

  it("a failed lease rethrows the getUserMedia error and leaves wake as it was", async () => {
    const s = setup();
    s.media.failWith = "NotAllowedError";
    await expect(s.fe.lease()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(s.fe.leased).toBe(false);
  });

  it("Web Speech: released stops the source; reclaim reopens the same device after the event", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    s.fe.webSpeech(true);
    expect(s.fe.current).toEqual({ state: "released", reason: "web_speech" });
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.capture.active).toBe(0);
    s.fe.webSpeech(false);
    await flush();
    expect(s.media.calls).toHaveLength(1); // 還沒到下一個 macrotask
    s.runDeferred();
    await flush();
    expect((s.media.calls[1]!.audio as { deviceId: unknown }).deviceId).toEqual({ exact: "mic-a" });
    expect(s.fe.current.state).toBe("armed");
    s.capture.last!.events.started();
    expect(s.fe.current.state).toBe("listening_local");
  });

  it("sleep and lock stop capture; resume/unlock auto-resume with the exact device; user pause survives power events", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    s.fe.pause("lock");
    s.fe.pause("sleep");
    expect(s.fe.current).toEqual({ state: "paused", reason: "lock" });
    expect(s.media.liveTracks()).toEqual([]);
    s.fe.resume("sleep");
    await flush();
    expect(s.fe.current).toEqual({ state: "paused", reason: "lock" }); // 還鎖著
    s.fe.resume("lock");
    await flush();
    expect(s.fe.current).toEqual({ state: "armed", reason: "auto_resume" });
    s.capture.last!.events.started();
    expect(s.listening.at(-1)).toEqual(["mic-a", "auto_resume"]);
    // 使用者暫停：只到本次執行結束；睡眠回來不恢復
    s.fe.pause("user_pause");
    s.fe.pause("sleep");
    s.fe.resume("sleep");
    await flush();
    expect(s.fe.current).toEqual({ state: "paused", reason: "user_pause" });
    s.fe.resume("user_pause");
    await flush();
    expect(s.fe.current.state).toBe("armed");
  });

  it("turning the preference off stops the source within the same call and reports pref_off", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    s.fe.setPreference(false, null, "auto_resume");
    expect(s.fe.current).toEqual({ state: "off", reason: "pref_off" });
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.capture.active).toBe(0);
  });

  it("turning off while getUserMedia is pending: the late stream is stopped and never listens", async () => {
    const s = setup();
    s.media.hold();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.fe.setPreference(false, null, "auto_resume");
    s.media.open();
    await flush();
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.capture.connects).toBe(0);
    expect(s.fe.current.state).toBe("off");
  });

  // 審查 M1：過時的工作階段晚到的歸還不得停掉新通話的複製品（原本 releaseLease() 會停掉全部）。
  it("concurrent leases: releasing a stale session's clone keeps the newer call's clone live", async () => {
    const s = setup();
    s.media.hold();
    const a = s.fe.lease();
    const b = s.fe.lease();
    s.media.open();
    const sa = (await a) as unknown as FakeStream;
    const sb = (await b) as unknown as FakeStream;
    for (const t of sa.getTracks()) t.stop();
    s.fe.releaseLease(sa as unknown as MediaStream);
    expect(sb.getTracks()[0]!.stopped).toBe(false);
    expect(s.fe.leased).toBe(true);
    expect(s.media.liveTracks().length).toBeGreaterThan(0);
    // 別人的串流不在租用清單裡：什麼都不做
    s.fe.releaseLease(new FakeStream([new FakeTrack("x")]) as unknown as MediaStream);
    expect(sb.getTracks()[0]!.stopped).toBe(false);
    s.fe.releaseLease(sb as unknown as MediaStream);
    expect(sb.getTracks()[0]!.stopped).toBe(true);
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.fe.hasSource).toBe(false);
  });

  it("releaseAllLeases (the page's safeguard once no call is active) stops every remaining clone", async () => {
    const s = setup();
    const a = (await s.fe.lease()) as unknown as FakeStream;
    s.fe.releaseAllLeases();
    expect(a.getTracks()[0]!.stopped).toBe(true);
    expect(s.media.liveTracks()).toEqual([]);
  });

  // 審查 m1：偏好關著時通話中拔掉麥克風，不得出現喚醒錯誤。
  it("unplugging during a call with the preference off shows no wake error", async () => {
    const s = setup();
    const leased = (await s.fe.lease()) as unknown as FakeStream;
    s.media.streams[0]!.tracks[0]!.unplug();
    expect(s.states.some((r) => r.state === "error")).toBe(false);
    s.fe.releaseLease(leased as unknown as MediaStream);
    await flush();
    expect(s.states.some((r) => r.state === "error")).toBe(false);
    expect(s.fe.current.state).toBe("off");
    expect(s.media.liveTracks()).toEqual([]);
  });

  it("unplugging during a call with the preference on reports device_ended only after the call, without reopening", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    const leased = (await s.fe.lease()) as unknown as FakeStream;
    s.media.streams[0]!.tracks[0]!.unplug();
    expect(s.fe.current).toEqual({ state: "in_call", reason: "realtime" });
    s.fe.releaseLease(leased as unknown as MediaStream);
    await flush();
    expect(s.fe.current).toEqual({ state: "error", reason: "device_ended" });
    expect(s.media.calls).toHaveLength(1);
  });

  // 審查 m2：引擎缺少時，通話前後都不開喚醒用的麥克風；只有通話本身開一次。
  it("runtime missing: a call opens the mic once for the call only and wake never opens one", async () => {
    const s = setup("missing");
    s.fe.setPreference(true, null, "auto_resume");
    await flush();
    expect(s.media.calls).toHaveLength(0);
    const leased = await s.fe.lease();
    s.fe.releaseLease(leased);
    await flush();
    expect(s.media.calls).toHaveLength(1);
    expect(s.media.liveTracks()).toEqual([]);
    expect(s.fe.current).toEqual({ state: "error", reason: "runtime_missing" });
  });

  // 審查 m5：語音模式結束後同一輪就租用，不會有兩個 getUserMedia。
  it("a lease right after Web Speech ends cancels the deferred reclaim (one getUserMedia, no double capture)", async () => {
    const s = setup();
    s.fe.setPreference(true, null, "enable");
    await flush();
    s.capture.last!.events.started();
    s.fe.webSpeech(true);
    s.fe.webSpeech(false);
    const leased = await s.fe.lease();
    s.runDeferred();
    await flush();
    expect(s.media.calls).toHaveLength(2); // 啟用一次＋通話一次（語音模式時來源已停）
    expect(s.fe.current).toEqual({ state: "in_call", reason: "realtime" });
    expect(s.capture.connects).toBe(1);
    s.fe.releaseLease(leased);
    await flush();
    expect(s.fe.current.state).toBe("armed");
    expect(s.media.calls).toHaveLength(2);
  });

  it("maps getUserMedia errors honestly", () => {
    expect(micError({ name: "NotAllowedError" }, false)).toBe("permission_denied");
    expect(micError({ name: "OverconstrainedError" }, true)).toBe("device_missing");
    expect(micError({ name: "NotFoundError" }, true)).toBe("device_missing");
    expect(micError({ name: "NotFoundError" }, false)).toBe("audio_failed");
    expect(micError(new Error("x"), false)).toBe("audio_failed");
  });
});

function controller(runtime: WakeRuntimeState = "ok") {
  const clock = new FakeClock();
  const media = new FakeMediaDevices();
  const capture = new FakeCapture();
  const earcon = new FakeEarcon();
  const captions: string[] = [];
  const saved: string[] = [];
  const reports: WakeReport[] = [];
  let visible = true;
  const visibleListeners = new Set<() => void>();
  let ids = 0;
  const host: WakeHost = {
    now: clock.now,
    runtime: () => runtime,
    caption: (text, ...values) => captions.push(values.length ? `${text}|${values.join("|")}` : text),
    visible: () => visible,
    onVisible: (listener) => {
      visibleListeners.add(listener);
      return () => visibleListeners.delete(listener);
    },
    state: (r) => reports.push(r),
    saveDeviceId: async (id) => void saved.push(id),
    newId: () => `wake_${++ids}`,
  };
  const timers: { run: () => void; at: number; cancelled: boolean }[] = [];
  const timer = (run: () => void, ms: number) => {
    const entry = { run, at: clock.t + ms, cancelled: false };
    timers.push(entry);
    return () => (entry.cancelled = true);
  };
  const c = new WakeController(host, { mediaDevices: media, capture, earcon, timer });
  const view = (listen: boolean, device: string | null = null): WakeSettingsView => ({ wake_listen: listen, device_id: device, runtime });
  return {
    c, clock, media, capture, earcon, captions, saved, reports, view, timers,
    /** 推進假時鐘並執行到期、沒被取消的計時器。 */
    advance(ms: number) {
      clock.advance(ms);
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.at <= clock.t) t.run();
        else timers.push(t);
      }
    },
    setVisible(v: boolean) {
      visible = v;
      if (v) for (const l of [...visibleListeners]) l();
    },
    async listen(device: string | null = null) {
      c.applySettings(view(false));
      c.applySettings(view(true, device));
      await flush();
      capture.last!.events.started();
    },
  };
}

describe("WakeController: guard → earcon → trigger (WK-01 end point)", () => {
  it("the default trigger only shows the 「聽到了」 caption and stays listening; WK-02 can replace it", async () => {
    const h = controller();
    await h.listen();
    h.capture.last!.events.detected(0);
    expect(h.earcon.plays).toHaveLength(1);
    h.earcon.plays[0]!.finish();
    await flush();
    expect(h.captions).toContain("聽到了");
    expect(h.c.state.state).toBe("listening_local");
    const trigger = vi.fn();
    h.c.setTriggerHandler(trigger);
    h.clock.advance(3000);
    h.capture.last!.events.detected(2);
    h.earcon.plays[1]!.finish();
    await flush();
    expect(trigger).toHaveBeenCalledExactlyOnceWith({ wake_id: "wake_2", detected_at: 3000, keyword_index: 2 });
  });

  it("cancelling the earcon (Esc, palm, 收起) sends no trigger", async () => {
    const h = controller();
    const trigger = vi.fn();
    h.c.setTriggerHandler(trigger);
    await h.listen();
    h.capture.last!.events.detected(0);
    expect(h.c.cancelEarcon()).toBe(true);
    expect(h.c.cancelEarcon()).toBe(false);
    await flush();
    expect(trigger).not.toHaveBeenCalled();
    expect(h.earcon.plays[0]!.cancelled).toBe(true);
  });

  it("drops detections during speech (+1.5 s tail), remote playback and within 3 s of the last accepted wake", async () => {
    const h = controller();
    const trigger = vi.fn();
    h.c.setTriggerHandler(trigger);
    await h.listen();
    h.c.begin("speech");
    h.capture.last!.events.detected(0);
    h.c.end("speech");
    h.clock.advance(1499);
    h.capture.last!.events.detected(0);
    h.c.begin("playback");
    h.clock.advance(10_000);
    h.capture.last!.events.detected(0);
    h.c.end("playback");
    expect(h.earcon.plays).toHaveLength(0);
    h.capture.last!.events.detected(0);
    expect(h.earcon.plays).toHaveLength(1);
    // 提示音期間的偵測也丟掉
    h.capture.last!.events.detected(0);
    expect(h.earcon.plays).toHaveLength(1);
    h.earcon.plays[0]!.finish();
    await flush();
    h.clock.advance(2999);
    h.capture.last!.events.detected(0);
    expect(h.earcon.plays).toHaveLength(1);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("leaving listening during the earcon (pause, call, sleep) cancels it without a trigger", async () => {
    const h = controller();
    const trigger = vi.fn();
    h.c.setTriggerHandler(trigger);
    await h.listen();
    h.capture.last!.events.detected(0);
    h.c.power("lock");
    await flush();
    expect(h.earcon.plays[0]!.cancelled).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("saves the deviceId of the last real listening_local and shows the resume caption once on auto-resume", async () => {
    const h = controller();
    h.c.applySettings(h.view(true, "mic-b"));
    await flush();
    h.capture.last!.events.started();
    expect(h.saved).toEqual([]); // 同一支，不用再存
    expect(h.captions.filter((c) => c.startsWith("已恢復"))).toHaveLength(1);
    // 使用者在選單關掉再打開：用預設麥克風，記下新的那一支，不顯示恢復字幕
    h.c.applySettings(h.view(false));
    h.c.applySettings(h.view(true, null));
    await flush();
    h.capture.last!.events.started();
    expect(h.saved).toEqual(["mic-a"]);
    expect(h.captions.filter((c) => c.startsWith("已恢復"))).toHaveLength(1);
  });

  it("resume caption waits until the window is visible", async () => {
    const h = controller();
    h.setVisible(false);
    await h.listen("mic-a");
    h.c.power("suspend");
    h.c.power("resume");
    await flush();
    h.capture.last!.events.started();
    expect(h.captions.filter((c) => c.startsWith("已恢復"))).toHaveLength(0);
    h.setVisible(true);
    expect(h.captions.filter((c) => c.startsWith("已恢復"))).toHaveLength(1);
    h.setVisible(true);
    expect(h.captions.filter((c) => c.startsWith("已恢復"))).toHaveLength(1);
  });

  it("errors are captioned with their reason; runtime missing never opens the mic", async () => {
    const h = controller("missing");
    h.c.applySettings(h.view(true));
    await flush();
    expect(h.media.calls).toEqual([]);
    expect(h.captions).toEqual(["常駐喚醒聆聽沒有開啟：{0}|喚醒引擎尚未安裝，沒有開啟麥克風"]);
    // 審查 m2：同一個原因在每通電話結束後不重複
    for (let i = 0; i < 3; i++) {
      const leased = await h.c.lease();
      h.c.releaseLease(leased);
      await flush();
    }
    expect(h.captions).toHaveLength(1);
    expect(h.c.state).toEqual({ state: "error", reason: "runtime_missing" });
  });

  it("a device that ends while listening is captioned as stopped, not 'not on'; the guard resets when turned off", async () => {
    const h = controller();
    await h.listen();
    (h.media.streams[0]!.tracks[0] as FakeTrack).unplug();
    expect(h.captions).toEqual(["常駐喚醒聆聽已停止：{0}|麥克風已拔除或停止，沒有改用其他麥克風"]);
    const reset = vi.spyOn(h.c.guard, "reset");
    h.c.command("wake-off");
    expect(reset).toHaveBeenCalled();
  });

  it("menu commands: pause is run-only, wake-off stops at once and ignores stale 'on' settings until the core saves 'off'", async () => {
    const h = controller();
    await h.listen();
    expect(h.c.command("wake-pause")).toBe(true);
    expect(h.c.state).toEqual({ state: "paused", reason: "user_pause" });
    h.c.command("wake-resume");
    await flush();
    h.capture.last!.events.started();
    expect(h.c.command("wake-off")).toBe(true);
    expect(h.c.state).toEqual({ state: "off", reason: "pref_off" });
    expect(h.media.liveTracks()).toEqual([]);
    h.c.applySettings(h.view(true, "mic-a")); // 還沒保存的舊設定
    await flush();
    expect(h.c.state.state).toBe("off");
    h.c.applySettings(h.view(false));
    h.c.applySettings(h.view(true));
    await flush();
    expect(h.c.state.state).toBe("armed");
    expect(h.c.command("voice")).toBe(false);
  });
});

describe("WakeController: WK-02 hooks (subscribers, rate-limit pause, calls)", () => {
  it("Companion activation=wake: subscribers get each trigger once (ids, time and keyword only) and can unsubscribe", async () => {
    const h = controller();
    await h.listen();
    const handler = vi.fn();
    h.c.setTriggerHandler(handler);
    const got: unknown[] = [];
    const off = h.c.subscribe((a) => got.push(a));
    h.c.subscribe(() => {
      throw new Error("a broken subscriber does not break wake");
    });
    h.capture.last!.events.detected(1);
    h.earcon.plays[0]!.finish();
    await flush();
    expect(handler).toHaveBeenCalledExactlyOnceWith({ wake_id: "wake_1", detected_at: 0, keyword_index: 1 });
    expect(got).toEqual([{ activation: "wake", wake_id: "wake_1", detected_at: 0, keyword_index: 1 }]);
    off();
    h.clock.advance(3000);
    h.capture.last!.events.detected(0);
    h.earcon.plays[1]!.finish();
    await flush();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(got).toHaveLength(1);
  });

  it("pauseFor(rate_limited) stops capture, reports paused/rate_limited and resumes listening by itself when the time is up", async () => {
    const h = controller();
    await h.listen();
    h.c.pauseFor("rate_limited", 30_000);
    expect(h.c.state).toEqual({ state: "paused", reason: "rate_limited" });
    expect(h.media.liveTracks()).toEqual([]);
    h.advance(29_999);
    expect(h.c.state.state).toBe("paused");
    h.advance(1);
    await flush();
    expect(h.c.state.state).toBe("armed");
    h.capture.last!.events.started();
    expect(h.c.state).toEqual({ state: "listening_local", reason: null });
    // 同一支麥克風（exact deviceId），也不顯示「已恢復」字幕（不是自動恢復）
    expect(h.media.calls.at(-1)).toMatchObject({ audio: { deviceId: { exact: "mic-a" } } });
    expect(h.captions).not.toContain("已恢復常駐喚醒聆聽（只在本機偵測「哈囉努斯」）");
  });

  it("a user pause during the rate-limit pause wins; a new pauseFor replaces the old timer; dispose cancels it", async () => {
    const h = controller();
    await h.listen();
    h.c.pauseFor("rate_limited", 10_000);
    h.c.command("wake-pause");
    h.advance(10_000);
    await flush();
    expect(h.c.state).toEqual({ state: "paused", reason: "user_pause" });
    h.c.command("wake-resume");
    await flush();
    h.capture.last!.events.started();
    h.c.pauseFor("rate_limited", 10_000);
    h.advance(5_000);
    h.c.pauseFor("rate_limited", 10_000);
    h.advance(5_000);
    await flush();
    expect(h.c.state.reason).toBe("rate_limited");
    h.c.dispose();
    h.advance(10_000);
    expect(h.c.state.state).toBe("off");
  });

  it("pauseFor with a timer that fires synchronously still resumes (no read of an unassigned cancel)", async () => {
    const clock = new FakeClock();
    const media = new FakeMediaDevices();
    const capture = new FakeCapture();
    const host: WakeHost = {
      now: clock.now, runtime: () => "ok", caption: () => {}, visible: () => true, onVisible: () => () => {}, state: () => {}, saveDeviceId: async () => {}, newId: () => "w",
    };
    const c = new WakeController(host, { mediaDevices: media, capture, earcon: new FakeEarcon(), timer: (run) => { run(); return () => {}; } });
    c.applySettings({ wake_listen: false, device_id: null, runtime: "ok" });
    c.applySettings({ wake_listen: true, device_id: null, runtime: "ok" });
    await flush();
    capture.last!.events.started();
    expect(() => c.pauseFor("rate_limited", 0)).not.toThrow();
    await flush();
    expect(c.state.state).toBe("armed");
  });

  it("no trigger while a call holds the microphone (in_call): detections are dropped", async () => {
    const h = controller();
    await h.listen();
    const handler = vi.fn();
    h.c.setTriggerHandler(handler);
    const stream = await h.c.lease();
    expect(h.c.state.state).toBe("in_call");
    h.capture.graphs[0]!.events.detected(0);
    await flush();
    expect(h.earcon.plays).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    h.c.releaseLease(stream);
    await flush();
    h.capture.last!.events.started();
    expect(h.c.state.state).toBe("listening_local");
  });

  it("watchCall uses the host clock", () => {
    const h = controller();
    const onTimeout = vi.fn();
    const w = h.c.watchCall({ every: () => () => {}, onTimeout });
    w.phase("listening");
    h.clock.advance(5_000);
    w.check();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
