import { spawnSync } from "node:child_process";
import type { MemoryLockProvider } from "../../server/memory/store.ts";

// 測試專用的單寫入者鎖。macOS 上回 undefined，store 照正式路徑使用 /usr/bin/lockf；
// Linux 用 util-linux 的 flock(1) 對繼承的 fd 3 取同樣的 BSD 鎖（鎖跟著 open file description，flock 結束後核心仍持有）。
// 這只讓雲端能跑真 AES-GCM、rename 與崩潰點測試，不代表 Linux 是支援的正式平台。
export const testLockProvider: MemoryLockProvider | undefined = process.platform === "darwin"
  ? undefined
  : (fd) => spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "pipe", "pipe", fd] }).status;

/** 有正式鎖（macOS）或測試鎖（有 flock 的 Linux）時才跑真檔案測試。 */
export const realLockAvailable = process.platform === "darwin" || spawnSync("flock", ["--version"]).status === 0;
