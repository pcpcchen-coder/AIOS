// 家人聲音辨認（SP-01）的講者模型與 onnxruntime wasm（shared/speaker-runtime.json）。
//   npm run speaker:setup [-- --from <資料夾>] [--dest <資料夾>] [--force]
// 放到 speaker-runtime/（不進 git）；在 macOS 上另外複製到 ~/Library/Application Support/Nous/speaker-runtime/，
// App 的核心從那裡核對雜湊並提供（/speaker-runtime/）。不放 public/：那會進瀏覽器版 dist 與 release zip。
// 每個檔案都核對 SHA-256；任何一個不符就什麼都不安裝並以非 0 結束，不留下未驗證的模型。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fromDir = arg("--from") ? resolve(arg("--from")) : null;
const force = process.argv.includes("--force");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const manifest = JSON.parse(readFileSync(join(root, "shared", "speaker-runtime.json"), "utf8"));
const dests = arg("--dest") ? [resolve(arg("--dest"))] : [join(root, "speaker-runtime")];
// macOS App 的核心從 userData（~/Library/Application Support/Nous）讀。
if (!arg("--dest") && process.platform === "darwin") dests.push(join(homedir(), "Library", "Application Support", "Nous", "speaker-runtime"));
const ortDir = join(root, "node_modules", "onnxruntime-web", "dist");

let failed = false;
const verified = new Map();
for (const file of manifest.files) {
  const existing = join(dests[0], file.name);
  if (!force && existsSync(existing) && sha256(readFileSync(existing)) === file.sha256) {
    verified.set(file.name, readFileSync(existing));
    console.log(`已存在且雜湊相符：${file.name}`);
    continue;
  }
  let buf;
  const local = file.package ? join(ortDir, file.name) : fromDir ? join(fromDir, file.name) : null;
  if (local) {
    if (!existsSync(local)) {
      console.error(file.package ? `找不到 ${local}，請先執行 npm ci。` : `--from 資料夾沒有 ${file.name}`);
      failed = true;
      continue;
    }
    buf = readFileSync(local);
  } else {
    const res = await fetch(file.url);
    if (!res.ok) {
      console.error(`下載失敗（HTTP ${res.status}）：${file.url}`);
      failed = true;
      continue;
    }
    buf = Buffer.from(await res.arrayBuffer());
  }
  const got = sha256(buf);
  if (got !== file.sha256) {
    console.error(`SHA-256 不符：${file.name}\n  預期 ${file.sha256}\n  實際 ${got}`);
    failed = true;
    continue;
  }
  verified.set(file.name, buf);
  console.log(`已核對 ${file.name}（${buf.length} bytes，${file.license}）`);
}
if (failed) {
  console.error("有檔案沒有通過核對，沒有安裝任何檔案。");
  process.exit(1);
}
for (const dest of dests) {
  mkdirSync(dest, { recursive: true });
  for (const [name, buf] of verified) writeFileSync(join(dest, name), buf);
  console.log(`已安裝到 ${dest}`);
}
console.log("完成。聲音登記只在 macOS App 提供；App 啟動時核心會再核對一次雜湊（「家人辨識…」裡的「錄製聲音」會顯示結果）。");
