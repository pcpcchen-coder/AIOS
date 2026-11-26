import type { SessionLifecycleEvent } from "../realtime-routes.ts";
import type { VoiceSessionEvent } from "./presence.ts";

// DUCK-1（D4a）：核心看得到的工作階段事件 → 鴨子 presence 的輸入事件。
// 核心只知道「決定開始、連上、live 的委派、結束」，不知道頁面上的聽／想／說（那要頁面回報，之後的批次）。
// 所以這裡的對應是粗略的，而且只由真實事件驅動：
//   started（來源是喚醒詞）→ wake；其他來源 → 連線中（thinking）
//   connected              → listening（連上之後一律算在聽；核心分不出模型正在說話）
//   delegation started     → working；finished／failed／unknown → 回到 listening
//   ended                  → 沒有其他進行中的工作階段時才 idle（因錯誤結束先 error）
// 同時可能有兩通（live 與 api_key 各一）；鴨子只有一個，所以用「還有沒有進行中的」決定要不要回 idle。

export interface PresenceBridgeOptions {
  handle: (event: VoiceSessionEvent) => void;
  /** 決定開始之後多久沒連上就當作沒有這通（預設 60 秒，等於 RealtimeSessions 的 pendingTtlMs 預設值）。 */
  pendingMs?: number;
}

export function createPresenceBridge(options: PresenceBridgeOptions): { observe(event: SessionLifecycleEvent): void; dispose(): void } {
  const pendingMs = options.pendingMs ?? 60_000;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const active = new Set<string>();
  const clearPending = (id?: string) => {
    for (const [key, timer] of [...pending]) {
      if (id !== undefined && key !== id) continue;
      clearTimeout(timer);
      pending.delete(key);
    }
  };
  return {
    observe(event) {
      switch (event.kind) {
        case "started":
          clearPending(event.sessionId);
          pending.set(
            event.sessionId,
            setTimeout(() => {
              pending.delete(event.sessionId);
              // 頁面一直沒有送出連線：這通沒有發生，不是錯誤。
              if (!active.size && !pending.size) options.handle({ kind: "session_ended", reason: "expired" });
            }, pendingMs),
          );
          options.handle({ kind: "session_started", source: event.source });
          break;
        case "connected":
          // 改路徑時連上的工作階段 ID 可能和決定開始時不同：連上就把等待中的都清掉。
          clearPending();
          active.add(event.sessionId);
          options.handle({ kind: "phase", phase: "listening" });
          break;
        case "delegation":
          if (!active.has(event.sessionId)) break;
          // 委派＝模型交給核心去做事（工具、交辦）。核心不知道頁面的 phase，所以這裡自己切：做事中 → working，做完 → 回到 listening。
          if (event.state === "started") {
            options.handle({ kind: "phase", phase: "thinking" });
            options.handle({ kind: "working", active: true });
          } else {
            options.handle({ kind: "working", active: false });
            options.handle({ kind: "phase", phase: "listening" });
          }
          break;
        case "ended":
          clearPending(event.sessionId);
          if (!active.delete(event.sessionId) && (active.size || pending.size)) break;
          if (!active.size && !pending.size) options.handle({ kind: "session_ended", reason: event.reason });
          break;
      }
    },
    dispose() {
      clearPending();
      active.clear();
    },
  };
}
