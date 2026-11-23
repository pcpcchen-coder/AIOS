import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parseLgtvHost } from "../server/lgtv/config.ts";
import { connectSsap, SSAP, SsapPairingRequired } from "../server/lgtv/ssap.ts";
import { pairingFile, readPairing, removePairing, writePairing } from "../server/lgtv/store.ts";
import { normalizeMac } from "../server/lgtv/wol.ts";

// LGTV-1：在 Mac 上和客廳的 LG 電視配對（電視要開著；畫面會跳出提示，用遙控器按「允許」）。
//   npm run tv:pair                     讀 .env 的 NOUS_LGTV_HOST
//   npm run tv:pair -- --host 192.168.1.50
//   npm run tv:pair -- --forget         刪掉配對金鑰（<configDir>/lgtv.json）
// 金鑰只寫進 <configDir>/lgtv.json（0600），不印出、不寫 log。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function loadEnv(): { env: NodeJS.ProcessEnv; file: string | null } {
  const candidates = [flag("--env"), join(root, ".env"), join(homedir(), "Library", "Application Support", "Nous", ".env")].filter((f): f is string => !!f);
  for (const file of candidates) if (existsSync(file)) return { env: { ...process.env, ...parseEnv(readFileSync(file, "utf8")) }, file };
  return { env: process.env, file: null };
}

/** 本機 ARP 表裡電視 IP 的 MAC（macOS 多網卡時 `arp -n` 可能查不到，所以也查整張表 `arp -an`）。 */
function macFromArp(ip: string): string | null {
  for (const argv of [["-n", ip], ["-an"]]) {
    try {
      const out = execFileSync("arp", argv, { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of out.split("\n")) {
        if (!line.includes(`(${ip})`) && !line.trim().startsWith(`${ip} `)) continue;
        const m = /([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i.exec(line);
        // macOS 的 arp 會省略前導 0（a:b:c…）：補成兩位數。
        const mac = m ? normalizeMac(m[1]!.split(":").map((x) => x.padStart(2, "0")).join(":")) : null;
        if (mac && mac !== "00:00:00:00:00:00") return mac;
      }
    } catch {
      // 沒有 arp 指令或查不到
    }
  }
  return null;
}

const { env, file: envFile } = loadEnv();
const configDir = env.NOUS_CONFIG_DIR?.trim() || join(homedir(), ".config", "nous");
const target = pairingFile(configDir);

if (args.includes("--forget")) {
  console.log(removePairing(target) ? `已刪除配對金鑰：${target}` : `沒有配對金鑰：${target}`);
  process.exit(0);
}

let host: string | null;
try {
  host = parseLgtvHost(flag("--host") ?? env.NOUS_LGTV_HOST);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
if (!host) {
  console.error(`沒有電視 IP：請用 --host 192.168.x.x，或在 .env 設定 NOUS_LGTV_HOST${envFile ? `（讀的是 ${envFile}）` : ""}。`);
  process.exit(2);
}

const existing = readPairing(target);
console.log(`連線到電視 ${host}（wss:3001）…`);
try {
  const session = await connectSsap({
    host,
    clientKey: existing?.host === host ? existing.client_key : null,
    connectTimeoutMs: 5_000,
    allowPrompt: true,
    promptTimeoutMs: 60_000,
    onPrompt: () => console.log("請看電視：用遙控器按「允許」（60 秒內）。"),
  });
  // 電視回報有線與 Wi‑Fi 兩張網卡（LGTVG3 實測）。ARP 查得到目前那張就只記它；查不到就兩張都記（喚醒時都送）。
  let reported: string[] = [];
  try {
    const info = await session.request(SSAP.connectionInfo);
    reported = ["wiredInfo", "wifiInfo"]
      .map((k) => normalizeMac(String((info[k] as Record<string, unknown> | undefined)?.macAddress ?? "")))
      .filter((m): m is string => !!m);
  } catch {
    // 讀不到：開機時要另外設定 NOUS_LGTV_MAC。
  }
  const arp = macFromArp(host);
  const macs = arp && (!reported.length || reported.includes(arp)) ? [arp] : [...new Set(reported)];
  let model: string | null = null;
  try {
    const sys = await session.request(SSAP.systemInfo);
    model = typeof sys.modelName === "string" ? sys.modelName : null;
  } catch {
    // ignore
  }
  writePairing(target, { version: 1, host, client_key: session.clientKey, macs, paired_at: new Date().toISOString() });
  session.close();
  console.log(`配對完成${model ? `（${model}）` : ""}。金鑰存在 ${target}（只有你的帳號能讀）。`);
  console.log(macs.length ? `電視 MAC：${macs.join("、")}（網路喚醒用）。` : "讀不到電視的 MAC：要用語音開機，請在 .env 設定 NOUS_LGTV_MAC。");
  console.log("接著在 .env 的 NOUS_AIL_SERVICES 加上 lg_tv，重新啟動 Nous。");
  process.exit(0);
} catch (err) {
  if (err instanceof SsapPairingRequired) console.error("配對沒有完成（電視上沒有按「允許」或拒絕了）。請再試一次。");
  else console.error("連不上電視：確認電視開著、和 Mac 在同一個區網，並開啟「LG Connect Apps」（設定 → 一般 → 裝置 → 外部裝置／電視管理）。");
  process.exit(1);
}
