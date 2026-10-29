// WK-00 喚醒詞 spike 的模型（docs/17 §13.4、docs/validation/wk-00-spike-2026-10-29.md）。
//
// npm run wake:setup                 下載兩個 KWS 模型（各約 33 MB，需要網路）
// npm run wake:setup -- --tts        另外下載雲端離線評估用的兩個 TTS 模型（約 200 MB；只用來在記憶體合成正例）
// npm run wake:setup -- --from <資料夾>   改用本機已下載的 .tar.bz2（檔名同網址最後一段）
//
// 模型放在 spike/wake/models/（不進 git），不放 public/：不能進產品 dist 或 release zip。
// 每個壓縮檔先核對 SHA-256，只解出 spike/wake/models.json 列出的檔案，逐一再核對 SHA-256；
// 任何一項不符就刪掉暫存並以非 0 結束，不留下未驗證的模型。解壓縮使用系統的 tar（macOS 與 Linux 內建，支援 bzip2）。
// 網址是 sherpa-onnx 的 GitHub release 資產；release 標籤（kws-models、tts-models）不是版本號，所以以雜湊釘住內容。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "spike", "wake", "models");
const manifest = JSON.parse(readFileSync(join(root, "spike", "wake", "models.json"), "utf8"));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fromIndex = process.argv.indexOf("--from");
const fromDir = fromIndex < 0 ? null : process.argv[fromIndex + 1];
const force = process.argv.includes("--force");
const entries = [...manifest.kws, ...(process.argv.includes("--tts") ? manifest.tts.map((t) => ({ ...t, dir: join("tts", t.dir) })) : [])];

function installed(entry) {
  const dir = join(out, entry.dir);
  return Object.entries(entry.files).every(([name, hash]) => existsSync(join(dir, name)) && sha256(readFileSync(join(dir, name))) === hash);
}

async function archiveBytes(entry) {
  const file = entry.url.split("/").pop();
  if (fromDir) {
    const local = join(fromDir, file);
    if (!existsSync(local)) throw new Error(`--from 資料夾沒有 ${file} / ${file} not found in --from folder`);
    return readFileSync(local);
  }
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`下載失敗 / download failed (HTTP ${res.status}): ${entry.url}`);
  return Buffer.from(await res.arrayBuffer());
}

let failed = false;
mkdirSync(out, { recursive: true });
for (const entry of entries) {
  if (!force && installed(entry)) {
    console.log(`已存在且雜湊相符，略過 / already verified: ${entry.dir}`);
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), "aios-wake-setup-"));
  try {
    const buf = await archiveBytes(entry);
    const got = sha256(buf);
    if (got !== entry.archive_sha256) throw new Error(`壓縮檔 SHA-256 不符 / archive SHA-256 mismatch: ${entry.url}\n  預期 expected ${entry.archive_sha256}\n  實際 actual   ${got}`);
    const top = entry.url.split("/").pop().replace(/\.tar\.bz2$/, "");
    const members = Object.keys(entry.files).map((name) => `${top}/${name}`);
    const tar = spawnSync("tar", ["-xjf", "-", "-C", tmp, ...members], { input: buf, maxBuffer: 1 << 20 });
    if (tar.status !== 0) throw new Error(`tar 解壓失敗 / tar failed: ${tar.stderr.toString().trim()}`);
    const staged = join(tmp, top);
    for (const [name, hash] of Object.entries(entry.files)) {
      const actual = sha256(readFileSync(join(staged, name)));
      if (actual !== hash) throw new Error(`檔案 SHA-256 不符 / file SHA-256 mismatch: ${entry.dir}/${name}\n  預期 expected ${hash}\n  實際 actual   ${actual}`);
    }
    const target = join(out, entry.dir);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    // 暫存資料夾可能在另一個磁碟區，所以複製而不是 rename
    cpSync(staged, target, { recursive: true });
    console.log(`已${fromDir ? "複製" : "下載"}並核對 / installed ${entry.dir}（${buf.length} bytes；${entry.license}）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    failed = true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (failed) process.exit(1);
console.log("完成 / done. 離線評估 / offline: npm run wake:spike -- eval --help；瀏覽器頁 / browser page: npm run wake:page");
