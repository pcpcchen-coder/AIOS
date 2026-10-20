import { describe, expect, it } from "vitest";
import { collectRegionActivity, activityDescription, type ActivitySnapshot } from "../src/region-activity.ts";
import { ConversationSession } from "../src/conversation.ts";
import type { ChatEvent } from "../src/api.ts";
import type { Domain } from "../shared/domain.ts";
import { makeTask, step } from "./fixtures.ts";

const idle: ActivitySnapshot = { tasks: [], reply: { kind: "idle" }, conversationVisible: false, capture: { push: false, continuous: false }, playback: false };
const pending = { kind: "pending", requestId: "req_visual", user: "這3張照片", answer: "" } as const;

describe("region activity projection", () => {
  it("combines concurrent task, topic, microphone and actual speech with provenance", () => {
    const task = makeTask({ plan_ready: true, steps: [{ ...step("計算", "running"), domain: "math" }] });
    const activity = collectRegionActivity({ ...idle, tasks: [task], reply: pending, conversationVisible: true, capture: { push: true, continuous: true }, playback: true });
    expect(activity.map((a) => a.domain)).toEqual(["math", "visual", "auditory", "auditory", "language"]);
    expect(activity.map(activityDescription)).toEqual(["數理區 · 模擬任務", "視覺區 · 主題分類", "聽覺區 · 麥克風收音", "聽覺區 · 麥克風收音", "語言區 · 語音播放"]);
    expect(activity[0]).toMatchObject({ owner: task.task_id, requestId: task.request_id, mock: true });
    expect(collectRegionActivity({ ...idle, tasks: [task] })).toHaveLength(1); // Collapsing a task does not cancel it.
  });

  it("represents planning independently and ignores terminal tasks with stale running steps", () => {
    expect(collectRegionActivity({ ...idle, tasks: [makeTask()] })).toMatchObject([{ domain: "planning", source: "task-planning" }]);
    for (const status of ["queued", "cancelling", "cancelled", "failed", "succeeded"] as const) {
      expect(collectRegionActivity({ ...idle, tasks: [makeTask({ status, plan_ready: true, steps: [{ ...step("數學", "running"), domain: "math" }] })] })).toEqual([]);
    }
  });

  it("keeps absent and invalid persisted or external domains neutral", () => {
    for (const domain of [undefined, null, "bad", "toString"]) {
      expect(collectRegionActivity({ ...idle, tasks: [makeTask({ plan_ready: true, steps: [{ ...step("計算", "running"), domain: domain as Domain }] })] })).toEqual([]);
    }
    const tasks = ["art", "auditory", "visual"].map((domain, i) => makeTask({ task_id: `task_${i}`, mode: "claude", plan_ready: true, steps: [{ ...step("執行", "running"), domain: domain as Domain }] }));
    expect(collectRegionActivity({ ...idle, tasks }).map(activityDescription)).toEqual(["藝術區 · 任務步驟", "聽覺區 · 任務步驟", "視覺區 · 任務步驟"]);
  });

  it("focuses only a visible pending topic; speech can finish after the reply", () => {
    for (const kind of ["complete", "interrupted", "error"] as const) {
      const reply = kind === "error" ? { ...pending, kind, message: "失敗", action: null } : { ...pending, kind };
      expect(collectRegionActivity({ ...idle, reply, conversationVisible: true })).toEqual([]);
      expect(collectRegionActivity({ ...idle, reply, conversationVisible: true, playback: true })).toMatchObject([{ domain: "language", source: "tts" }]);
    }
    expect(collectRegionActivity({ ...idle, reply: pending, conversationVisible: false })).toEqual([]);
    expect(collectRegionActivity({ ...idle, reply: { ...pending, user: "嗯" }, conversationVisible: true })).toEqual([]);
    expect(collectRegionActivity(idle)).toEqual([]);
  });

  it("current-turn pulses and focus ignore old completion after a newer completion", async () => {
    const requests: { event(e: ChatEvent): void; resolve(): void }[] = [];
    const pulses: string[] = [];
    const session = new ConversationSession({
      stream: (_m, _id, event) => new Promise<void>((resolve) => requests.push({ event, resolve })),
      output: () => ({ push() {}, end() {}, cancel() {} }), changed() {}, delegated() {},
      activity: (kind, id) => pulses.push(`${kind}:${id}`),
    });
    const projection = () => collectRegionActivity({ ...idle, reply: session.view.reply, conversationVisible: session.view.visible });
    const a = session.send("照片", "a");
    expect(projection()[0]).toMatchObject({ domain: "visual", owner: "a" });
    const b = session.send("規劃排程", "b");
    expect(projection()[0]).toMatchObject({ domain: "planning", owner: "b" });
    requests[1].event({ type: "delta", text: "回答" });
    requests[1].event({ type: "done", model: null }); requests[1].resolve(); await b;
    requests[0].event({ type: "delta", text: "舊回答" }); requests[0].event({ type: "done", model: null }); requests[0].resolve(); await a;
    expect(projection()).toEqual([]);
    expect(pulses).toEqual(["submit:a", "submit:b", "stream:b"]);
    const c = session.send("音樂", "c"); session.dismiss();
    expect(projection()).toEqual([]); requests[2].resolve(); await c;
    const d = session.send("設計海報", "d"); session.reset();
    expect(projection()).toEqual([]); requests[3].resolve(); await d;
  });
});
