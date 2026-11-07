import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeMac } from "./wol.ts";

// LGTV-1：配對金鑰只存在 Mac 核心本機的 <configDir>/lgtv.json（0600）。只有配對指令（npm run tv:pair）會寫；
// 核心只讀。不進 log、不交給頁面或模型、不在 repo 裡。移除金鑰＝刪掉這個檔（npm run tv:pair -- --forget）。

export interface LgtvPairing {
  version: 1;
  /** 配對時的電視 IP（核心以 NOUS_LGTV_HOST 為準；不同時視為沒有配對）。 */
  host: string;
  client_key: string;
  /**
   * Wake-on-LAN 用的 MAC（NOUS_LGTV_MAC 可覆蓋）。電視會回報有線與 Wi‑Fi 兩張網卡（LGTVG3 在 OLED65G3PSA 實測）；
   * 配對時用 ARP 查到目前那張就只記那張，查不到就兩張都記，喚醒時都送。
   */
  macs: string[];
  paired_at: string;
}

export function pairingFile(configDir: string): string {
  return join(configDir, "lgtv.json");
}

/** 讀配對檔；沒有、看不懂或欄位不對都回 null（不丟錯、不印內容）。 */
export function readPairing(file: string): LgtvPairing | null {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<LgtvPairing>;
    if (v?.version !== 1 || typeof v.host !== "string" || typeof v.client_key !== "string" || !v.client_key || v.client_key.length > 256) return null;
    const macs = (Array.isArray(v.macs) ? v.macs : []).map((m) => normalizeMac(typeof m === "string" ? m : null)).filter((m): m is string => !!m).slice(0, 4);
    return { version: 1, host: v.host, client_key: v.client_key, macs: [...new Set(macs)], paired_at: typeof v.paired_at === "string" ? v.paired_at : "" };
  } catch {
    return null;
  }
}

/** 寫配對檔（先寫暫存檔、0600，再改名）。 */
export function writePairing(file: string, pairing: LgtvPairing): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pairing, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function removePairing(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
