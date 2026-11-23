import { createSocket } from "node:dgram";

// LGTV-1：Wake-on-LAN。電視待機時 SSAP 不回應，只能用 magic packet 喚醒（LGTVG3 wol.py 的做法：連送幾次、port 9 與 7）。
// 電視要開「透過 Wi‑Fi 開機」（設定 → 一般 → 裝置 → 電視管理）；Mac 必須和電視在同一個區網（廣播出不了路由器）。

const MAC = /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

/** 正規化 MAC（aa:bb:cc:dd:ee:ff）；格式不對回 null。 */
export function normalizeMac(value: string | null | undefined): string | null {
  const m = MAC.exec(String(value ?? "").trim());
  return m ? m.slice(1, 7).join(":").toLowerCase() : null;
}

export function magicPacket(mac: string): Buffer {
  const norm = normalizeMac(mac);
  if (!norm) throw new Error("MAC 位址格式錯誤");
  const bytes = Buffer.from(norm.replace(/:/g, ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** 送出 magic packet 的函式（測試可替換）。 */
export type WolSender = (mac: string, broadcast: string | null) => Promise<void>;

export const sendWol: WolSender = async (mac, broadcast) => {
  const packet = magicPacket(mac);
  const targets = [...new Set([broadcast || "255.255.255.255", "255.255.255.255"])];
  const sock = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(() => {
        sock.setBroadcast(true);
        resolve();
      });
    });
    // 至少有一個送出成功才算送出（Mac 不在區網時 send 會回 ENETUNREACH 等錯誤）。
    let ok = 0;
    let lastErr: unknown = null;
    for (const addr of targets) {
      for (const port of [9, 7]) {
        await new Promise<void>((resolve) =>
          sock.send(packet, port, addr, (err) => {
            if (err) lastErr = err;
            else ok++;
            resolve();
          }),
        );
      }
    }
    if (!ok) throw lastErr instanceof Error ? lastErr : new Error("網路喚醒封包送不出去");
  } finally {
    sock.close();
  }
};
