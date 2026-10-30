import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MemoryStore, type MemorySecretBox, type MemoryStoreLike, type MemoryStoreOptions } from "../../server/memory/store.ts";
import { MemoryService, type MemoryConfirmFn, type MemoryIdentityHooks } from "../../server/memory/service.ts";
import type { ChatTarget } from "../../server/memory/retrieve.ts";
import type { MemoryResponse } from "../../shared/memory.ts";
import { testLockProvider } from "./memory-lock.ts";

// MemoryService 的測試組裝：真 AES-GCM 快照、真 rename／fsync、Linux 上用 flock(1) 測試鎖；只有資料金鑰的包裝是假的
// （正式 App 由 safeStorage／Keychain 包裝）。所有人物、帳號與內容都是虛構的。

export function fakeBox(key: Buffer = randomBytes(32), available = () => true): MemorySecretBox {
  return {
    available,
    seal(plain) { const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]); },
    open(sealed) { const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString(); },
  };
}

export const CLAUDE: ChatTarget = { provider: "claude", account: "fp0000claude0001", label: "Claude" };
export const CHATGPT: ChatTarget = { provider: "chatgpt", account: "fp000chatgpt0001", label: "ChatGPT（fixture@example.invalid）" };
/** MEM-2：ChatGPT 方案即時語音（Codex 登入）的同意鍵（虛構帳號）。 */
export const CODEX: ChatTarget = { provider: "codex", account: "fp0000000codex01", label: "ChatGPT 方案即時語音（Codex 登入）" };

export interface Harness {
  service: MemoryService;
  clock: { now: number };
  target: { current: ChatTarget | null };
  confirms: unknown[];
  /** openStore 被呼叫的次數（碰 Keychain 與建資料夾的時機）。 */
  opens: { count: number };
  call(request: Record<string, unknown>, ctx?: { userInitiated?: boolean }): Promise<MemoryResponse & Record<string, unknown>>;
  turn(text: string, requestId?: string): Promise<MemoryResponse & Record<string, unknown>>;
  close(): Promise<void>;
}

let seq = 0;
export const req = () => `req_fixture${String(++seq).padStart(6, "0")}`;

export function harness(options: { dir: string; key: Buffer; clock?: { now: number }; confirm?: MemoryConfirmFn; identity?: MemoryIdentityHooks | null; store?: Partial<MemoryStoreOptions>; wrap?: (store: MemoryStoreLike) => MemoryStoreLike; available?: () => boolean; targets?: ChatTarget[]; onPresence?: () => void; live?: ChatTarget | null }): Harness {
  const clock = options.clock ?? { now: Date.parse("2026-10-29T02:00:00Z") };
  const target = { current: CLAUDE as ChatTarget | null };
  const confirms: unknown[] = [];
  const opens = { count: 0 };
  const box = fakeBox(options.key, options.available);
  const service = new MemoryService({
    openStore: async () => {
      opens.count++;
      const store = await MemoryStore.open({ dir: options.dir, secretBox: box, lockProvider: testLockProvider, now: () => clock.now, ...options.store });
      return options.wrap ? options.wrap(store) : store;
    },
    available: () => box.available(),
    targets: () => ({ current: target.current, all: [...(options.targets ?? [CLAUDE, CHATGPT]), ...(options.live ? [options.live] : [])], live: options.live ?? null }),
    confirm: options.confirm ?? (async (request) => { confirms.push(request); return true; }),
    identity: () => options.identity ?? null,
    // 開關提示：與記憶資料夾並排的一個檔案（正式 App 在 configDir），跨「重啟」保留。
    enabledHint: {
      get: () => existsSync(`${options.dir}.hint`) && readFileSync(`${options.dir}.hint`, "utf8") === "true",
      set: (enabled) => writeFileSync(`${options.dir}.hint`, String(enabled)),
    },
    onPresence: options.onPresence,
    now: () => clock.now,
  });
  const call = (request: Record<string, unknown>, ctx?: { userInitiated?: boolean }) => service.handle(request, ctx) as Promise<MemoryResponse & Record<string, unknown>>;
  return {
    service, clock, target, confirms, opens, call,
    turn: (text, requestId = req()) => call({ op: "turn", text, request_id: requestId }),
    close: () => service.shutdown(),
  };
}

/** 記憶管理的權杖（等同使用者在選單列點「記憶…」）。 */
export async function manage(h: Harness): Promise<string> {
  const res = await h.call({ op: "list", manage: true }, { userInitiated: true });
  if (!res.ok || typeof res.manage !== "string") throw new Error(JSON.stringify(res));
  return res.manage;
}

/** 從「記憶…」啟用、建立（或沿用）人物、允許服務帳號，再用管理權杖選定那位人物。 */
export async function enable(h: Harness, name: string | null, allow: ChatTarget[] = [CLAUDE]): Promise<MemoryResponse & Record<string, unknown>> {
  const token = await manage(h);
  const res = await h.call({ op: "setup", token, enabled: true, subject: name ? { kind: "name", name } : { kind: "household" }, allow: allow.map(t => ({ provider: t.provider, account: t.account })) });
  if (name) {
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
    const profile = status.profiles.find(p => p.name === name);
    if (profile) await h.call({ op: "select", profile: profile.id, token });
  }
  return res;
}

/** 主視窗「本次人物」選單（帶這個世代的 select_card）。 */
export async function selectProfile(h: Harness, profile: string | null): Promise<MemoryResponse & Record<string, unknown>> {
  const status = await h.call({ op: "status" }) as unknown as { presence: { select_card: string } };
  return h.call({ op: "select", profile, card: status.presence.select_card });
}
