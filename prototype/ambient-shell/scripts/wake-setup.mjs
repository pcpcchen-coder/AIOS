// 喚醒詞的模型與引擎檔案（docs/17 §13.4、docs/validation/wk-00-spike-2026-10-29.md、wk-01b-prep-2026-10-31.md）。兩種用法：
//
// 1. WK-00 spike（預設）：
//    npm run wake:setup                 下載兩個 KWS 模型（各約 33 MB，需要網路）
//    npm run wake:setup -- --tts        另外下載雲端離線評估用的兩個 TTS 模型（約 200 MB；只用來在記憶體合成正例）
//    npm run wake:setup -- --from <資料夾>   改用本機已下載的 .tar.bz2（檔名同網址最後一段）
//    模型放在 spike/wake/models/（不進 git），不放 public/：不能進產品 dist 或 release zip。
//
// 2. WK-01b 產品（--product）：只裝 shared/wake-runtime.json 列的檔案：GitHub Actions 建出的 wasm 與 JS（release 資產），
//    以及兩個 KWS 模型的 int8 encoder／joiner、decoder 與 tokens.txt（沿用 spike/wake/models.json 的壓縮檔網址與雜湊）。
//    放到 wake-runtime/（不進 git）；在 macOS 上另外複製到 ~/Library/Application Support/Nous/wake-runtime/，
//    App 的核心從那裡核對雜湊並提供（/wake-runtime/）。App 執行時從不下載。
//    npm run wake:setup -- --product [--from <資料夾>] [--dest <資料夾>]
//    --from：release 資產（gh release download <tag> -R <repo>）與模型 .tar.bz2 都可以先下載到同一個資料夾。
//    清單還是 pending_first_build（release 檔沒有雜湊）時直接失敗，不下載任何東西。
//
// 每個壓縮檔與檔案都核對 SHA-256；任何一項不符或缺雜湊就以非 0 結束，而且（--product）一個檔案都不安裝。
// 解壓縮使用系統的 tar（macOS 與 Linux 內建，支援 bzip2）。
// 模型網址是 sherpa-onnx 的 GitHub release 資產；release 標籤（kws-models、tts-models）不是版本號，所以以雜湊釘住內容。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// 與核心、worker 同一個清單格式檢查（npm run wake:setup 以 tsx 執行，所以可以直接引用 TypeScript）。
import { validateWakeRuntimeManifest } from "../shared/wake.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/;
/** 與 shared/wake.ts 的 FILE_NAME 相同：任何檔名在 join 之前都要通過（沒有子資料夾、沒有 ..）。 */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
function safeName(name, what) {
  if (typeof name !== "string" || !FILE_NAME.test(name)) throw new Error(`不安全的檔名 / unsafe ${what} name: ${JSON.stringify(name)}`);
  return name;
}

/** 從 --from 資料夾或網址取得位元組。 */
async function sourceBytes(fromDir, fileName, url) {
  if (fromDir) {
    const local = join(fromDir, fileName);
    if (!existsSync(local)) throw new Error(`--from 資料夾沒有 ${fileName} / ${fileName} not found in --from folder`);
    return readFileSync(local);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 / download failed (HTTP ${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 以系統 tar 從 .tar.bz2 解出指定成員（壓縮檔的頂層資料夾 + 成員名），回傳 Map<成員, Buffer>。 */
export function extractMembers(archive, top, members) {
  const tmp = mkdtempSync(join(tmpdir(), "aios-wake-setup-"));
  try {
    const tar = spawnSync("tar", ["-xjf", "-", "-C", tmp, ...members.map((m) => `${top}/${m}`)], { input: archive, maxBuffer: 1 << 20 });
    if (tar.status !== 0) throw new Error(`tar 解壓失敗 / tar failed: ${tar.stderr.toString().trim()}`);
    return new Map(members.map((m) => [m, readFileSync(join(tmp, top, m))]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * --product 的核對（純流程，測試注入 fetchBytes 與 extract）。全部通過才回傳要寫入的檔案；任何問題都丟錯（fail closed）。
 * manifest：shared/wake-runtime.json；models：spike/wake/models.json；fetchBytes(fileName, url)：取得位元組。
 */
export async function verifyProduct({ manifest, models, fetchBytes, extract = extractMembers, log = () => {} }) {
  // 先做完整的格式檢查（含每個檔名）；有任何錯誤就停下，不下載。
  const schema = validateWakeRuntimeManifest(manifest);
  if (schema.length > 0) throw new Error(`清單格式錯誤 / invalid manifest:\n${schema.join("\n")}`);
  const problems = [];
  if (manifest.status !== "built") problems.push(`清單仍是 ${manifest.status}：wasm 的雜湊要等第一次 CI 建置寫進 shared/wake-runtime.json / manifest is ${manifest.status}: wasm hashes come from the first CI build`);
  if (!manifest.build?.release_tag || !REPO.test(manifest.build?.release_repo ?? "")) problems.push("清單沒有 build.release_tag 或 release_repo 格式不對 / manifest has no release tag or a malformed release repo");
  else if (!FILE_NAME.test(manifest.build.release_tag)) problems.push("release_tag 格式不對 / malformed release tag");
  for (const f of manifest.files) {
    try {
      safeName(f.name, "file");
      if (f.member !== undefined) safeName(f.member, "archive member");
    } catch (error) {
      problems.push(error.message);
    }
  }
  for (const f of manifest.files) if (!SHA256.test(f.sha256 ?? "")) problems.push(`缺雜湊 / missing hash: ${f.name}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const verified = new Map();
  const failures = [];
  for (const file of manifest.files.filter((f) => f.source === "release")) {
    try {
      const url = `https://github.com/${manifest.build.release_repo}/releases/download/${manifest.build.release_tag}/${file.name}`;
      const buf = await fetchBytes(file.name, url);
      const got = sha256(buf);
      if (got !== file.sha256) throw new Error(`SHA-256 不符 / mismatch: ${file.name}\n  預期 expected ${file.sha256}\n  實際 actual   ${got}`);
      verified.set(file.name, buf);
      log(`已核對 / verified ${file.name}（${buf.length} bytes，${file.license}）`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const byModel = new Map();
  for (const file of manifest.files.filter((f) => f.source === "model_archive")) byModel.set(file.model, [...(byModel.get(file.model) ?? []), file]);
  for (const [modelId, files] of byModel) {
    try {
      const entry = models.kws.find((m) => m.id === modelId);
      if (!entry) throw new Error(`spike/wake/models.json 沒有模型 / unknown model ${modelId}`);
      const archiveName = safeName(entry.url.split("/").pop(), "archive");
      const buf = await fetchBytes(archiveName, entry.url);
      const got = sha256(buf);
      if (got !== entry.archive_sha256) throw new Error(`壓縮檔 SHA-256 不符 / archive SHA-256 mismatch: ${archiveName}\n  預期 expected ${entry.archive_sha256}\n  實際 actual   ${got}`);
      const top = archiveName.replace(/\.tar\.bz2$/, "");
      const members = extract(buf, top, files.map((f) => f.member));
      for (const file of files) {
        const body = members.get(file.member);
        const actual = body ? sha256(body) : "(missing)";
        if (actual !== file.sha256) throw new Error(`檔案 SHA-256 不符 / file SHA-256 mismatch: ${file.name}\n  預期 expected ${file.sha256}\n  實際 actual   ${actual}`);
        verified.set(file.name, body);
        log(`已核對 / verified ${file.name}（${body.length} bytes）`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  if (verified.size !== manifest.files.length) throw new Error("不是每個清單檔案都核對過 / not every listed file was verified");
  return verified;
}

/** 寫入核對過的檔案（只寫清單上的檔名）。 */
/**
 * 原子安裝：每個目的地先寫到同一磁碟區的 `<dest>.tmp-XXXX`，寫完才 rename 成 dest（原本的 dest 先改名備份）。
 * 任何一步失敗就刪掉暫存並還原備份；第二個目的地失敗時，第一個也還原。成功後才刪備份。
 * 目的地整個換成這次核對過的檔案（不留舊的、不在清單上的檔案）。
 */
export function installVerified(verified, dests) {
  for (const name of verified.keys()) safeName(name, "install");
  const done = [];
  try {
    for (const dest of dests) {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = mkdtempSync(`${dest}.tmp-`);
      let backup = null;
      try {
        for (const [name, buf] of verified) writeFileSync(join(tmp, name), buf);
        if (existsSync(dest)) {
          backup = `${tmp}.old`;
          renameSync(dest, backup);
        }
        renameSync(tmp, dest);
      } catch (error) {
        rmSync(tmp, { recursive: true, force: true });
        if (backup && !existsSync(dest)) renameSync(backup, dest);
        throw error;
      }
      done.push({ dest, backup });
    }
  } catch (error) {
    for (const { dest, backup } of done.reverse()) {
      rmSync(dest, { recursive: true, force: true });
      if (backup) renameSync(backup, dest);
    }
    throw error;
  }
  for (const { backup } of done) if (backup) rmSync(backup, { recursive: true, force: true });
}

async function setupProduct(argv) {
  const manifest = JSON.parse(readFileSync(join(root, "shared", "wake-runtime.json"), "utf8"));
  const models = JSON.parse(readFileSync(join(root, "spike", "wake", "models.json"), "utf8"));
  const fromIndex = argv.indexOf("--from");
  const fromDir = fromIndex < 0 ? null : argv[fromIndex + 1];
  const destIndex = argv.indexOf("--dest");
  const dests = destIndex >= 0 ? [resolve(argv[destIndex + 1])] : [join(root, "wake-runtime")];
  // macOS App 的核心從 userData（~/Library/Application Support/Nous）讀，與 desktop/main.mjs 的 wakeRuntimeDir 相同。
  if (destIndex < 0 && process.platform === "darwin") dests.push(join(homedir(), "Library", "Application Support", "Nous", "wake-runtime"));
  let verified;
  try {
    verified = await verifyProduct({ manifest, models, fetchBytes: (name, url) => sourceBytes(fromDir, name, url), log: (line) => console.log(line) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("有檔案沒有通過核對，沒有安裝任何檔案。 / Verification failed; nothing was installed.");
    return 1;
  }
  try {
    installVerified(verified, dests);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("安裝失敗，已還原，沒有留下部分安裝。 / Install failed and was rolled back; nothing was partially installed.");
    return 1;
  }
  for (const dest of dests) console.log(`已安裝到 / installed to ${dest}`);
  console.log("完成 / done. App 啟動時核心會再核對一次雜湊；關鍵詞與門檻仍以 shared/wake-runtime.json 的 keywords 為準。");
  return 0;
}

async function setupSpike(argv) {
  const out = join(root, "spike", "wake", "models");
  const manifest = JSON.parse(readFileSync(join(root, "spike", "wake", "models.json"), "utf8"));
  const fromIndex = argv.indexOf("--from");
  const fromDir = fromIndex < 0 ? null : argv[fromIndex + 1];
  const force = argv.includes("--force");
  const entries = [...manifest.kws, ...(argv.includes("--tts") ? manifest.tts.map((t) => ({ ...t, dir: join("tts", t.dir) })) : [])];
  const installed = (entry) => {
    const dir = join(out, entry.dir);
    return Object.entries(entry.files).every(([name, hash]) => existsSync(join(dir, name)) && sha256(readFileSync(join(dir, name))) === hash);
  };

  let failed = false;
  mkdirSync(out, { recursive: true });
  for (const entry of entries) {
    if (!force && installed(entry)) {
      console.log(`已存在且雜湊相符，略過 / already verified: ${entry.dir}`);
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "aios-wake-setup-"));
    try {
      const file = entry.url.split("/").pop();
      const buf = await sourceBytes(fromDir, file, entry.url);
      const got = sha256(buf);
      if (got !== entry.archive_sha256) throw new Error(`壓縮檔 SHA-256 不符 / archive SHA-256 mismatch: ${entry.url}\n  預期 expected ${entry.archive_sha256}\n  實際 actual   ${got}`);
      const top = file.replace(/\.tar\.bz2$/, "");
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
  if (failed) return 1;
  console.log("完成 / done. 離線評估 / offline: npm run wake:spike -- eval --help；瀏覽器頁 / browser page: npm run wake:page");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  process.exit(await (argv.includes("--product") ? setupProduct(argv) : setupSpike(argv)));
}
