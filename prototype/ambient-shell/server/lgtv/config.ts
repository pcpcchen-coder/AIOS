import { normalizeMac } from "./wol.ts";

// LGTV-1：電視連線設定的檢查。電視 IP 只接受私有網段的 IPv4（10/8、172.16/12、192.168/16）：
// Nous 只在家裡的區網連電視，不連網際網路上的位址。

function privateIpv4(value: string): boolean {
  // 不接受前導 0（010.0.0.1 會被網址解析成八進位的 8.0.0.1）。
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** NOUS_LGTV_HOST：沒有設定回 null（Adapter 不註冊）；設定了但不是私有 IPv4 就報錯。 */
export function parseLgtvHost(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!privateIpv4(v)) throw new Error("NOUS_LGTV_HOST 必須是區網（私有網段）的 IPv4，例如 192.168.1.50");
  return v;
}

/** NOUS_LGTV_MAC：可省略；格式不對就報錯。 */
export function parseLgtvMac(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const mac = normalizeMac(v);
  if (!mac) throw new Error("NOUS_LGTV_MAC 格式不對（例如 a8:23:fe:12:34:56）");
  return mac;
}

/** NOUS_LGTV_BROADCAST：可省略；必須是私有網段的廣播位址（例如 192.168.1.255）。 */
export function parseLgtvBroadcast(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!privateIpv4(v)) throw new Error("NOUS_LGTV_BROADCAST 必須是區網的 IPv4 廣播位址，例如 192.168.1.255");
  return v;
}
