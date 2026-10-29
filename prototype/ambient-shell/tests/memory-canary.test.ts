import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import type { ChatMessage } from "../server/chat.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { SettingsView } from "../shared/types.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CLAUDE, enable, harness, req } from "./fixtures/memory-service.ts";

// M14：明文掃描專用 canary。記憶目錄（快照、暫存、鎖）、TaskStore、log、全體 SSE、settings 與錯誤訊息都不能出現；
// 只有「授權的當次模型 payload」（這裡是假引擎收到的 system）可以有，而且要經過同意。

const CANARY = "M14_MEMORY_CANARY_七三九";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function scanDir(dir: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...scanDir(path));
    else if (readFileSync(path).includes(Buffer.from(CANARY))) hits.push(path);
  }
  return hits;
}

describe.skipIf(!realLockAvailable)("M14 canary scan", () => {
  it("never leaves the encrypted store except in the consented model payload", async () => {
    const memoryDir = temp("nous-m14-memory-"), dataDir = temp("nous-m14-data-");
    const logs: string[] = [];
    const h = harness({ dir: memoryDir, key: randomBytes(32) });
    (h.service as unknown as { log: (l: string) => void }).log = (l) => logs.push(l);
    const systems: string[] = [];
    const chat = {
      chatTarget: () => CLAUDE,
      async chat(input: { system: string; messages: ChatMessage[] }, onDelta: (t: string) => void) {
        systems.push(input.system);
        onDelta("好的，");
        onDelta("⟦交辦：照偏好規劃晚餐⟧");
        return { model: "fixture" };
      },
    };
    const probe = createServer();
    await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    const store = new TaskStore(dataDir);
    const auth = new ChatGPTAuth({ dir: dataDir, callbackPort: 0, onChange: () => {} });
    const settings = { view: (): SettingsView => ({ schema_version: "proto-0.1", provider: "mock", providers: [], chatgpt: auth.info() }), select: () => {} };
    const app = createApp({ store, runner: new TaskRunner(store, new MockExecutor(1)), settings, auth, chat, memory: h.service, port, devPort: 5173, distDir: null });
    await new Promise<void>(r => app.listen(port, "127.0.0.1", r));
    try {
      const base = `http://localhost:${port}`;
      const controller = new AbortController();
      const sse = await fetch(`${base}/api/events`, { signal: controller.signal });
      const reader = sse.body!.getReader();
      let broadcast = "";
      const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; broadcast += new TextDecoder().decode(value); } } catch { /* aborted */ } })();

      await enable(h, "George");
      await h.turn(`記住我晚餐喜歡吃${CANARY}`);
      const id = req();
      const t = await h.turn("晚餐吃什麼", id) as unknown as { chat: { text: string; memory_turn: string } };
      const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: t.chat.text }], request_id: id, memory_turn: t.chat.memory_turn }) });
      const stream = await res.text();
      // M-3：第二輪沒有 memory_turn（例如語音來源），但歷史含上一輪帶 canary 的回答：交辦仍被擋下，任務不會帶出 canary。
      const id2 = req();
      const history = [{ role: "user", content: t.chat.text }, { role: "assistant", content: `我記得你晚餐喜歡吃${CANARY}。` }, { role: "user", content: "那幫我排一週菜單" }];
      const res2 = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history, request_id: id2 }) });
      const stream2 = await res2.text();
      // 錯誤路徑：不相符的 nonce 與壞的 IPC 請求，訊息也不能帶出內容。
      const bad = await h.call({ op: "forget", id: "mem_ffffffffffffffff", revision: 1 });
      const tampered = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], request_id: req(), memory_turn: "mt_" + "f".repeat(32) }) });
      const tamperedText = await tampered.text();
      const settingsJson = await (await fetch(`${base}/api/settings`)).text();
      await h.service.withChat({ nonce: null, requestId: "req_none0000", lastUser: "x", target: CLAUDE }, async () => {});
      controller.abort();
      await pump;
      await h.close();

      expect(systems.some(s => s.includes(CANARY))).toBe(true); // 已同意的 Claude 帳號、當次 payload
      expect(scanDir(memoryDir)).toEqual([]);
      expect(scanDir(dataDir)).toEqual([]);
      expect(JSON.stringify(store.list())).not.toContain(CANARY);
      expect(logs.join("\n")).not.toContain(CANARY);
      expect(broadcast).not.toContain(CANARY);
      expect(settingsJson).not.toContain(CANARY);
      expect(JSON.stringify(bad)).not.toContain(CANARY);
      expect(tamperedText).not.toContain(CANARY);
      // 帶記憶的那一輪：交辦被擋下，標題是使用者原句（不是模型帶記憶的改寫）。
      expect(stream).toContain('"type":"delegate_blocked","title":"晚餐吃什麼"');
      expect(stream).not.toContain(CANARY);
      expect(stream2).toContain('"type":"delegate_blocked","title":"那幫我排一週菜單"');
      expect(stream2).not.toContain('"type":"delegate",');
    } finally {
      app.closeAllConnections();
      await new Promise<void>(r => app.close(() => r()));
    }
  });
});
