import { DuckAdapter } from "../../server/integrations/adapters/duck.ts";
import type { DuckTiming } from "../../server/duck/exec.ts";
import { DuckLinkHub, type DuckLinkHubOptions } from "../../server/duck/link.ts";
import { MockDuck, type MockDuckOptions } from "./mock-duck.ts";
import type { ExecutionContext } from "../../server/integrations/contracts.ts";

// 測試共用：hub 聽臨時埠（port 0），對面是標示 mock 的 TypeScript 鴨子。時間都縮短，讓整組測試在幾秒內跑完。

export const FAST: DuckTiming = { ackTimeoutMs: 250, readbackMs: 400, lookSettleMaxMs: 900, gestureReadbackMs: 500, staleStateMs: 3_000 };

export interface Rig {
  hub: DuckLinkHub;
  duck: MockDuck;
  adapter: DuckAdapter;
  url: string;
  logs: string[];
  close(): Promise<void>;
}

export async function rig(options: { duck?: Partial<MockDuckOptions>; hub?: DuckLinkHubOptions; connect?: boolean } = {}): Promise<Rig> {
  const logs: string[] = [];
  const hub = new DuckLinkHub({ port: 0, heartbeatMs: 40, log: (l) => logs.push(l), ...options.hub });
  const port = await hub.start();
  const url = `ws://127.0.0.1:${port}/duck-link`;
  const duck = new MockDuck({ url, stateIntervalMs: 50, speed: 10, leaseMs: 300, ...options.duck });
  if (options.connect !== false) {
    await duck.connect();
    await until(() => hub.snapshot().connected && hub.snapshot().state !== null);
  }
  const adapter = new DuckAdapter(hub, { timing: FAST, enableAllTools: true });
  return {
    hub,
    duck,
    adapter,
    url,
    logs,
    async close() {
      duck.disconnect();
      await hub.stop();
    },
  };
}

export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待條件逾時");
    await sleep(5);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let n = 0;
export function ctx(signal: AbortSignal = new AbortController().signal): ExecutionContext {
  return { actor: "agent", route: "live", sessionId: "test-session", requestId: `test_req_${String(++n).padStart(6, "0")}`, signal };
}
