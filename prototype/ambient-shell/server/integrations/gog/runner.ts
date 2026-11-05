import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

// AIL-2：gog（github.com/steipete/gogcli，MIT）的共用執行方式。Gmail（MAIL-1）與 Google Calendar（CAL-1）共用：
// - 不經 shell：spawn 參數陣列；呼叫端把旗標寫成 --flag=value。stdin 只放呼叫端給的內容；stderr 一律丟掉（可能含帳號或錯誤細節）。
// - 中止時 SIGTERM，寬限後 SIGKILL；子行程沒能啟動（找不到、沒有執行權限）時錯誤帶 spawnFailed，呼叫端據此判斷「確定沒有執行」。
// - gog 自己管 OAuth 與 refresh token（macOS 鑰匙圈），Nous 不讀、不存任何 Google 權杖。

/** NOUS_GOG_PATH 沒設定時依序找的位置（App 從 Finder 啟動時 PATH 不含 Homebrew）。 */
export const GOG_CANDIDATES = ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"] as const;
/** SIGTERM 之後多久還沒結束就 SIGKILL。 */
export const GOG_KILL_GRACE_MS = 2_000;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

export interface GogRunOptions {
  signal: AbortSignal;
  /** 寫進 stdin 的內容（沒有時 stdin 關閉）。 */
  stdin?: string;
}
export type GogRunner = (file: string, args: string[], opts: GogRunOptions) => Promise<{ code: number | null; stdout: string }>;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** NOUS_GOG_PATH：必須是絕對路徑；沒設定回 null（之後依 GOG_CANDIDATES 找）。 */
export function parseGogPath(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!isAbsolute(v)) throw new Error("NOUS_GOG_PATH 必須是絕對路徑");
  return v;
}

/** 找 gog：設定的路徑優先，否則看 Homebrew 的兩個位置；找不到回 null。 */
export function resolveGogPath(configured: string | null, exists: (path: string) => boolean = existsSync): string | null {
  if (configured) return configured;
  return GOG_CANDIDATES.find((p) => exists(p)) ?? null;
}

/** 預設的執行方式：spawn（不經 shell）、stderr 丟掉、stdout 最多 64 KB；中止時送 SIGTERM。 */
export const defaultGogRunner: GogRunner = (file, args, { signal, stdin }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const child = spawn(file, args, { shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      // 不理 SIGTERM 的 gog：寬限後 SIGKILL，不留下殘餘的子行程。
      killTimer = setTimeout(() => child.kill("SIGKILL"), GOG_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    // 沒能啟動（找不到、沒有執行權限…）：標記 spawnFailed，呼叫端據此判斷「確定沒有送出」。
    let started = false;
    child.once("spawn", () => void (started = true));
    child.once("error", (err) => done(() => reject(started ? err : Object.assign(err, { spawnFailed: true }))));
    child.once("close", (code) => done(() => (signal.aborted ? reject(new Error("aborted")) : resolve({ code, stdout }))));
  });
