import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../server/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "nous-store-"));
  dirs.push(d);
  return d;
}

describe("TaskStore 持久化", () => {
  it("任務與成果寫入檔案，重啟後可喚回同一版本", () => {
    const dir = tempDir();
    const a = new TaskStore(dir);
    const task = a.create({ title: "保存我", request_id: "req_aaaaaaaa", mode: "mock" });
    const artifact = a.addArtifact({
      task_id: task.task_id,
      title: "保存我",
      content: "內容",
      mode: "mock",
      model: null,
      assumptions: [],
      capability_gaps: [],
      status: "complete",
    });
    a.update(task.task_id, (t) => {
      t.status = "succeeded";
      t.artifact_id = artifact.artifact_id;
    });

    const b = new TaskStore(dir);
    expect(b.get(task.task_id)).toMatchObject({ status: "succeeded", artifact_id: artifact.artifact_id });
    expect(b.getArtifact(artifact.artifact_id)).toEqual(artifact);
  });

  it("重啟時未完成的任務誠實標為失敗，不假裝仍在執行", () => {
    const dir = tempDir();
    const a = new TaskStore(dir);
    const task = a.create({ title: "跑到一半", request_id: "req_aaaaaaaa", mode: "claude" });
    a.update(task.task_id, (t) => {
      t.status = "running";
      t.steps = [{ title: "規劃步驟", status: "running", started_at: t.created_at, finished_at: null, output_chars: null }];
    });

    const b = new TaskStore(dir);
    const t = b.get(task.task_id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toContain("中斷");
    expect(t.steps[0].status).toBe("failed");
    const onDisk = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
    expect(onDisk[0].status).toBe("failed");
  });

  it("回傳的是複本，外部修改不影響儲存內容", () => {
    const store = new TaskStore(null);
    const task = store.create({ title: "x", request_id: "req_aaaaaaaa", mode: "mock" });
    task.status = "succeeded";
    expect(store.get(task.task_id)!.status).toBe("queued");
  });
});
