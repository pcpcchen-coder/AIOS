// WK-01b：自建 sherpa-onnx KWS 瀏覽器 wasm 的輔助工具（docs/17 §14.1 D2；由 scripts/build-wake-wasm.sh 與
// .github/workflows/wake-wasm.yml 呼叫，tests/wake-wasm-build.test.ts 直接測這裡的純函式）。
//
//   node scripts/wake-wasm.mjs patch <sherpa-onnx 原始碼>            改 wasm/kws/CMakeLists.txt（見 patchKwsCmake）
//   node scripts/wake-wasm.mjs package <sherpa-onnx 原始碼> <建置資料夾> <輸出資料夾>
//   node scripts/wake-wasm.mjs license-check <建置資料夾> <輸出資料夾>   有 GPL espeak-ng／piper 的檔案或符號就以非 0 結束
//   node scripts/wake-wasm.mjs manifest <輸出資料夾>                    印出 SHA-256 清單（JSON）
//   node scripts/wake-wasm.mjs tag                                      印出 release 名稱 wake-runtime-<版本>-<設定雜湊前 12 碼>
//
// 只用 Node 內建模組；不下載任何東西（下載與編譯在 build-wake-wasm.sh）。

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** build-wake-wasm.sh 裡的固定版本（單一來源是那個檔案；這裡只讀出來）。 */
export function readPins(script = readFileSync(join(here, "build-wake-wasm.sh"), "utf8")) {
  const pick = (key) => {
    const m = new RegExp(`^${key}="([^"]+)"$`, "m").exec(script);
    if (!m) throw new Error(`build-wake-wasm.sh has no ${key}`);
    return m[1];
  };
  return {
    sherpa_onnx_version: pick("SHERPA_ONNX_VERSION"),
    sherpa_onnx_commit: pick("SHERPA_ONNX_COMMIT"),
    emsdk_version: pick("EMSDK_VERSION"),
    emsdk_commit: pick("EMSDK_COMMIT"),
  };
}

/** 建置設定的雜湊：建置腳本與本工具的內容（換任何一個就是另一個 release）。 */
export function configSha256(files = [join(here, "build-wake-wasm.sh"), join(here, "wake-wasm.mjs")]) {
  const h = createHash("sha256");
  for (const file of files) {
    const body = readFileSync(file);
    h.update(`${relative(here, file)}\0${body.length}\0`);
    h.update(body);
  }
  return h.digest("hex");
}

export function releaseTag(pins = readPins(), config = configSha256()) {
  return `wake-runtime-${pins.sherpa_onnx_version}-${config.slice(0, 12)}`;
}

// ───────────── 對上游 v2.0.1 wasm/kws/CMakeLists.txt 的修改 ─────────────
// 上游把模型以 --preload-file 打包進 .data，模型沒放進 assets/ 就 FATAL_ERROR；輸出是 classic script。
// 我們要：模型不進 wasm（另由 wake:setup 安裝、在 worker 寫進 Emscripten 的記憶體檔案系統），輸出 ES module（module worker
// 不能 importScripts），並匯出 FS。每一處都要求原文完全相符，找不到就丟錯（上游改了就停下，不猜）。

const CMAKE_EDITS = [
  {
    why: "models are not baked into the wasm; drop the assets existence check",
    from: `if(NOT EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/assets/decoder-epoch-12-avg-2-chunk-16-left-64.onnx")
    message(WARNING "\${CMAKE_CURRENT_SOURCE_DIR}/assets/decoder-epoch-12-avg-2-chunk-16-left-64.onnx does not exist")
    message(FATAL_ERROR "Please read \${CMAKE_CURRENT_SOURCE_DIR}/assets/README.md before you continue")
endif()
`,
    to: "",
  },
  {
    why: "no --preload-file; build an ES module factory for a module worker",
    from: `string(APPEND MY_FLAGS "--preload-file \${CMAKE_CURRENT_SOURCE_DIR}/assets@. ")`,
    to: `string(APPEND MY_FLAGS " -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSherpaKwsModule -sENVIRONMENT=web,worker ")`,
  },
  {
    why: "export FS so the worker can write the verified model bytes into MEMFS",
    from: `-sEXPORTED_RUNTIME_METHODS=['ccall',`,
    to: `-sEXPORTED_RUNTIME_METHODS=['FS','ccall',`,
  },
  {
    why: "there is no .data file to install",
    from: `        "$<TARGET_FILE_DIR:sherpa-onnx-wasm-kws-main>/sherpa-onnx-wasm-kws-main.data"
`,
    to: "",
  },
];

export function patchKwsCmake(text) {
  let out = text;
  for (const edit of CMAKE_EDITS) {
    const count = out.split(edit.from).length - 1;
    if (count !== 1) throw new Error(`wasm/kws/CMakeLists.txt: expected exactly one match for edit (${edit.why}), found ${count}`);
    // 以函式取代：to 裡的 $ 不會被當成取代樣式
    out = out.replace(edit.from, () => edit.to);
  }
  if (/preload-file|\.data"/.test(out)) throw new Error("wasm/kws/CMakeLists.txt still preloads assets");
  return out;
}

/** 上游 sherpa-onnx-kws.js（classic script，最後只在 Node 下 module.exports）→ ES module（加一行 export）。 */
export function esmApi(text) {
  if (!/^function createKws\(Module, myConfig\) \{$/m.test(text)) throw new Error("sherpa-onnx-kws.js has no createKws(Module, myConfig)");
  if (/^\s*export\s/m.test(text)) throw new Error("sherpa-onnx-kws.js already has an export");
  return `${text.trimEnd()}\n\n// Added by prototype/ambient-shell/scripts/wake-wasm.mjs (ES module for the Nous wake worker).\nexport { createKws };\n`;
}

/** 產出的三個檔案（與 shared/wake.ts 的 WAKE_RELEASE_FILES 相同；tests 核對）。 */
export const OUTPUT_FILES = ["sherpa-onnx-wasm-kws-main.mjs", "sherpa-onnx-wasm-kws-main.wasm", "sherpa-onnx-kws.mjs"];
/** 只放在 release、不安裝的檔案；也列進清單並附雜湊，release job 一樣核對。 */
export const RELEASE_ONLY_FILES = ["LICENSE.sherpa-onnx.txt"];

export function packageOutput(srcDir, buildDir, outDir) {
  const bin = join(buildDir, "install", "bin", "wasm");
  mkdirSync(outDir, { recursive: true });
  const glue = readFileSync(join(bin, "sherpa-onnx-wasm-kws-main.js"), "utf8");
  if (!/export default createSherpaKwsModule/.test(glue)) throw new Error("glue is not an ES module factory (EXPORT_ES6 missing)");
  writeFileSync(join(outDir, OUTPUT_FILES[0]), glue);
  copyFileSync(join(bin, "sherpa-onnx-wasm-kws-main.wasm"), join(outDir, OUTPUT_FILES[1]));
  writeFileSync(join(outDir, OUTPUT_FILES[2]), esmApi(readFileSync(join(srcDir, "wasm", "kws", "sherpa-onnx-kws.js"), "utf8")));
  copyFileSync(join(srcDir, "LICENSE"), join(outDir, RELEASE_ONLY_FILES[0]));
}

// ───────────── 授權檢查：GPL espeak-ng 與 piper 不得出現在建置產物 ─────────────
// 不區分大小寫，但前面不能是英文字母，避免把 OfflineSpeaker（e-Speak-er）誤判。只掃建置產物（不是原始碼註解）。

export const GPL_PATTERN = /(?<![a-z])(?:lib)?espeak|(?<![a-z])piper(?![a-z])/i;
const SCANNED = /\.(wasm|m?js|a|o|data|so|dylib)$/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function fileHasPattern(path) {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = "";
    let n;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const text = carry + chunk.toString("latin1", 0, n);
      if (GPL_PATTERN.test(text)) return true;
      carry = text.slice(-32);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** 回傳發現的問題（空陣列才算通過）。buildDir 可以是 null（只檢查輸出）。 */
export function licenseFindings(buildDir, outDir) {
  const findings = [];
  const out = walk(outDir).map((f) => relative(outDir, f)).sort();
  const expected = [...OUTPUT_FILES, ...RELEASE_ONLY_FILES].sort();
  if (JSON.stringify(out) !== JSON.stringify(expected)) findings.push(`output files must be exactly ${expected.join(", ")}; got ${out.join(", ")}`);
  for (const rel of out) {
    if (GPL_PATTERN.test(rel)) findings.push(`output file name: ${rel}`);
    if (rel !== "LICENSE.sherpa-onnx.txt" && fileHasPattern(join(outDir, rel))) findings.push(`output contains espeak/piper: ${rel}`);
  }
  if (buildDir) {
    const cache = join(buildDir, "CMakeCache.txt");
    const text = existsSync(cache) ? readFileSync(cache, "utf8") : "";
    if (!/^SHERPA_ONNX_ENABLE_TTS:BOOL=OFF$/m.test(text)) findings.push("CMakeCache.txt: SHERPA_ONNX_ENABLE_TTS is not OFF");
    if (/^SHERPA_ONNX_ENABLE_WASM_TTS:BOOL=ON$/m.test(text)) findings.push("CMakeCache.txt: SHERPA_ONNX_ENABLE_WASM_TTS is ON");
    if (!/^SHERPA_ONNX_ENABLE_WASM_KWS:BOOL=ON$/m.test(text)) findings.push("CMakeCache.txt: SHERPA_ONNX_ENABLE_WASM_KWS is not ON");
    for (const file of walk(buildDir)) {
      const rel = relative(buildDir, file);
      if (GPL_PATTERN.test(rel)) findings.push(`build tree file: ${rel}`);
      else if (SCANNED.test(rel) && fileHasPattern(file)) findings.push(`build artifact contains espeak/piper: ${rel}`);
    }
  }
  return findings;
}

export function manifestFor(outDir, pins = readPins(), config = configSha256()) {
  const entry = (name) => {
    const body = readFileSync(join(outDir, name));
    return { name, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
  };
  return {
    sherpa_onnx_version: pins.sherpa_onnx_version,
    sherpa_onnx_commit: pins.sherpa_onnx_commit,
    emsdk_version: pins.emsdk_version,
    emsdk_commit: pins.emsdk_commit,
    config_sha256: config,
    release_tag: releaseTag(pins, config),
    files: OUTPUT_FILES.map(entry),
    release_only: RELEASE_ONLY_FILES.map(entry),
  };
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "patch") {
    const file = join(args[0], "wasm", "kws", "CMakeLists.txt");
    writeFileSync(file, patchKwsCmake(readFileSync(file, "utf8")));
    console.log(`patched ${file}`);
    return 0;
  }
  if (cmd === "package") {
    packageOutput(args[0], args[1], args[2]);
    console.log(`packaged ${OUTPUT_FILES.join(", ")} into ${args[2]}`);
    return 0;
  }
  if (cmd === "license-check") {
    const findings = licenseFindings(args[0] === "-" ? null : args[0], args[1]);
    for (const f of findings) console.error(`LICENSE CHECK FAILED: ${f}`);
    if (findings.length === 0) console.log("license check passed: no espeak-ng or piper files or symbols; TTS off, KWS only");
    return findings.length === 0 ? 0 : 1;
  }
  if (cmd === "manifest") {
    console.log(JSON.stringify(manifestFor(args[0]), null, 2));
    return 0;
  }
  if (cmd === "tag") {
    console.log(releaseTag());
    return 0;
  }
  console.error("usage: wake-wasm.mjs patch|package|license-check|manifest|tag ...");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
