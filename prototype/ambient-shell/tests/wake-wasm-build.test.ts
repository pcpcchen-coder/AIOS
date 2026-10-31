import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSha256, esmApi, GPL_PATTERN, licenseFindings, manifestFor, OUTPUT_FILES, patchKwsCmake, readPins, releaseTag } from "../scripts/wake-wasm.mjs";
import { WAKE_RELEASE_FILES } from "../shared/wake.ts";

// WK-01b 準備批次：.github/workflows/wake-wasm.yml 與 scripts/build-wake-wasm.sh、scripts/wake-wasm.mjs 的靜態檢查。
// 這裡**沒有**執行 emsdk 或建置（雲端容器不能跑）；第一次真正的建置在 PR 的 GitHub Actions。

const app = join(import.meta.dirname, "..");
const repo = join(app, "..", "..");
const workflow = readFileSync(join(repo, ".github", "workflows", "wake-wasm.yml"), "utf8");
const script = readFileSync(join(app, "scripts", "build-wake-wasm.sh"), "utf8");

/** 依縮排切出 YAML 區塊（不引入 YAML 套件）：從 `key:` 那一行到下一個同層或更淺的鍵。 */
function block(text: string, key: string, indent: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${" ".repeat(indent)}${key}:` || l.startsWith(`${" ".repeat(indent)}${key}: `));
  if (start < 0) throw new Error(`no ${key}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() !== "" && !l.trim().startsWith("#") && l.length - l.trimStart().length <= indent);
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trimEnd();
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-wake-wasm-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe(".github/workflows/wake-wasm.yml (static)", () => {
  it("triggers on workflow_dispatch and on pull_request only for the workflow and build files", () => {
    const on = block(workflow, "on", 0);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(block(on, "pull_request", 2)).toBe(
      ["  pull_request:", "    paths:", "      - .github/workflows/wake-wasm.yml", "      - prototype/ambient-shell/scripts/build-wake-wasm.sh", "      - prototype/ambient-shell/scripts/wake-wasm.mjs"].join("\n"),
    );
    expect(on).not.toMatch(/^ {2}(push|schedule|release|pull_request_target):/m);
  });

  it("uses minimal permissions: read-only by default; contents: write only on the release job", () => {
    expect(block(workflow, "permissions", 0)).toBe("permissions:\n  contents: read");
    const jobs = block(workflow, "jobs", 0);
    expect(block(jobs, "build", 2)).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    const release = block(jobs, "release", 2);
    expect(release).toMatch(/\n {4}permissions:\n {6}contents: write\n/);
    expect([...workflow.matchAll(/contents: write/g)]).toHaveLength(1);
    expect(workflow).not.toMatch(/write-all|id-token|packages: write|actions: write|pull-requests: write/);
    expect(workflow).toMatch(/persist-credentials: false/);
  });

  it("never publishes on pull_request: the release job runs only for workflow_dispatch on main, and only it calls gh release", () => {
    const jobs = block(workflow, "jobs", 0);
    const build = block(jobs, "build", 2);
    const release = block(jobs, "release", 2);
    expect(release).toMatch(/\n {4}if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n/);
    expect(release).toMatch(/needs: build/);
    expect(build).not.toMatch(/gh release|GH_TOKEN|github\.token|softprops|action-gh-release/);
    expect([...workflow.matchAll(/gh release (\w+)/g)].map((m) => m[1]).sort()).toEqual(["create", "view"]);
    // release 不可變：已存在就失敗，不覆蓋
    expect(workflow).not.toMatch(/--clobber|gh release (upload|edit|delete)/);
    expect(release).toMatch(/if gh release view "\$TAG" > \/dev\/null 2>&1; then\n[^\n]*already exists[^\n]*\n\s*exit 1\n\s*fi\n\s*gh release create/);
    // release job 先以 build job 輸出的清單雜湊核對，再逐檔核對（含 LICENSE）
    expect(build).toMatch(/manifest_sha256: \$\{\{ steps\.manifest\.outputs\.sha256 \}\}/);
    expect(release).toMatch(/echo "\$MANIFEST_SHA256  wake-runtime-manifest\.json" \| sha256sum -c -/);
    expect(release).toMatch(/\.\.\.m\.release_only/);
    // run: 區塊裡不直接展開 ${{ }}（一律經 env:）
    const runBlocks = [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((m) => m[1]).join("\n");
    expect(runBlocks).not.toMatch(/\$\{\{/);
    expect(workflow).not.toMatch(/run: [^|\n]*\$\{\{/);
    expect(workflow.slice(0, workflow.indexOf("  release:"))).not.toMatch(/gh release/);
    // pull_request 上的輸出只有 workflow artifact 與 job summary
    expect(build).toMatch(/actions\/upload-artifact@v4/);
    expect(build).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(build).toMatch(/wake-wasm\.mjs manifest/);
  });

  it("pins versions: actions follow the repo convention (@v4, like the other workflows), runner image, emsdk and sherpa-onnx by full SHA in the build script", () => {
    const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
    expect(uses.sort()).toEqual(["actions/checkout@v4", "actions/download-artifact@v4", "actions/setup-node@v4", "actions/upload-artifact@v4"]);
    // 其他 workflow 也是 @v4 標籤，不是 commit SHA（照 repo 慣例；改成 SHA 屬全 repo 的另一個決定）
    const others = ["aios-product-ci.yml", "bilingual-docs.yml", "pstack-observer.yml", "pstack-public-e2e.yml"].map((f) => readFileSync(join(repo, ".github", "workflows", f), "utf8")).join("\n");
    expect([...others.matchAll(/uses: actions\/[\w-]+@([^\s]+)/g)].every((m) => m[1] === "v4")).toBe(true);
    expect(workflow).not.toMatch(/ubuntu-latest/);
    expect([...workflow.matchAll(/runs-on: (\S+)/g)].map((m) => m[1])).toEqual(["ubuntu-24.04", "ubuntu-24.04"]);
    expect(readPins(script)).toEqual({ sherpa_onnx_version: "2.0.1", sherpa_onnx_commit: "af2d8d81dbfa61c4cea4c568da78f3982edca005", emsdk_version: "4.0.23", emsdk_commit: "c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56" });
    // 取得固定 commit 並核對 HEAD；emsdk 安裝與啟用固定版本並核對 emcc 版本
    expect(script).toMatch(/fetch_commit https:\/\/github\.com\/emscripten-core\/emsdk\.git "\$EMSDK_COMMIT"/);
    expect(script).toMatch(/fetch_commit https:\/\/github\.com\/k2-fsa\/sherpa-onnx\.git "\$SHERPA_ONNX_COMMIT"/);
    expect(script).toMatch(/if \[ "\$head" != "\$commit" \]; then/);
    expect(script).toMatch(/"\$EMSDK_DIR\/emsdk" install "\$EMSDK_VERSION"/);
    expect(script).toMatch(/\*" \$EMSDK_VERSION "\*/);
    expect(script).not.toMatch(/\blatest\b|tip-of-tree|git pull/);
  });

  it("builds only the KWS target with TTS off, and runs the GPL espeak-ng/piper check (in the script and as its own workflow step)", () => {
    expect(script).toMatch(/-DSHERPA_ONNX_ENABLE_TTS=OFF/);
    expect(script).toMatch(/-DSHERPA_ONNX_ENABLE_WASM_TTS=OFF/);
    expect(script).toMatch(/-DSHERPA_ONNX_ENABLE_WASM_KWS=ON/);
    expect(script).not.toMatch(/-DSHERPA_ONNX_ENABLE_(WASM_ASR|WASM_VAD|WASM_NODEJS|WASM_WEB|WASM_SPEAKER_DIARIZATION|SPEAKER_DIARIZATION)=ON/);
    expect(script).toMatch(/node "\$TOOL" license-check "\$BUILD" "\$OUT"/);
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(workflow).toMatch(/wake-wasm\.mjs license-check "\$RUNNER_TEMP\/wake-build\/sherpa-onnx\/build-wasm-simd-kws" "\$RUNNER_TEMP\/wake-out"/);
  });

  it("the release name is wake-runtime-<sherpa version>-<short config hash>", () => {
    expect(releaseTag()).toBe(`wake-runtime-2.0.1-${configSha256().slice(0, 12)}`);
    expect(releaseTag()).toMatch(/^wake-runtime-2\.0\.1-[0-9a-f]{12}$/);
    expect(workflow).toMatch(/wake-wasm\.mjs tag\)" >> "\$GITHUB_OUTPUT"/);
  });
});

describe("scripts/wake-wasm.mjs", () => {
  const upstreamCmake = readFileSync(join(import.meta.dirname, "fixtures", "wake-wasm", "kws-CMakeLists.v2.0.1.txt"), "utf8");
  const upstreamApi = readFileSync(join(import.meta.dirname, "fixtures", "wake-wasm", "sherpa-onnx-kws.v2.0.1.js.txt"), "utf8");

  it("patches the real v2.0.1 wasm/kws/CMakeLists.txt: no preloaded model, ES module factory, FS exported, no .data install", () => {
    const out = patchKwsCmake(upstreamCmake);
    expect(out).not.toMatch(/preload-file|assets\/decoder|\.data"/);
    expect(out).toMatch(/-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSherpaKwsModule -sENVIRONMENT=web,worker/);
    expect(out).toMatch(/-sEXPORTED_RUNTIME_METHODS=\['FS','ccall',/);
    expect(out).toMatch(/SherpaOnnxCreateKeywordSpotter/);
    // 上游一改就停下，不猜
    expect(() => patchKwsCmake(upstreamCmake.replace("--preload-file", "--embed-file"))).toThrow(/expected exactly one match/);
    expect(() => patchKwsCmake(out)).toThrow(/expected exactly one match/);
    // 取代以函式進行（to 裡若有 $& 之類的樣式也照字面）
    expect(readFileSync(join(app, "scripts", "wake-wasm.mjs"), "utf8")).toMatch(/out = out\.replace\(edit\.from, \(\) => edit\.to\);/);
  });

  it("turns the upstream sherpa-onnx-kws.js into an ES module exporting createKws (once)", () => {
    const out = esmApi(upstreamApi);
    expect(out.startsWith(upstreamApi.trimEnd())).toBe(true);
    expect(out.trimEnd().endsWith("export { createKws };")).toBe(true);
    expect(() => esmApi(out)).toThrow(/already has an export/);
    expect(() => esmApi("function other() {}")).toThrow(/no createKws/);
  });

  it("output file names match shared/wake.ts WAKE_RELEASE_FILES", () => {
    expect(OUTPUT_FILES).toEqual([WAKE_RELEASE_FILES.glue, WAKE_RELEASE_FILES.wasm, WAKE_RELEASE_FILES.api]);
  });

  function fakeOutput(extra: Record<string, string> = {}): string {
    const out = mkdtempSync(join(root, "out-"));
    for (const name of [...OUTPUT_FILES, "LICENSE.sherpa-onnx.txt"]) writeFileSync(join(out, name), `fixture ${name} SherpaOnnxOfflineSpeakerDiarization`);
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(out, name), body);
    return out;
  }
  function fakeBuild(cache = "SHERPA_ONNX_ENABLE_TTS:BOOL=OFF\nSHERPA_ONNX_ENABLE_WASM_TTS:BOOL=OFF\nSHERPA_ONNX_ENABLE_WASM_KWS:BOOL=ON\n", files: Record<string, string> = {}): string {
    const build = mkdtempSync(join(root, "build-"));
    mkdirSync(join(build, "lib"), { recursive: true });
    writeFileSync(join(build, "CMakeCache.txt"), cache);
    writeFileSync(join(build, "lib", "libsherpa-onnx-c-api.a"), "SherpaOnnxCreateKeywordSpotter OfflineSpeakerDiarization");
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(build, name, ".."), { recursive: true });
      writeFileSync(join(build, name), body);
    }
    return build;
  }

  it("license check passes a clean KWS-only build (and does not flag OfflineSpeaker)", () => {
    expect(GPL_PATTERN.test("SherpaOnnxOfflineSpeakerDiarization")).toBe(false);
    expect(licenseFindings(fakeBuild(), fakeOutput())).toEqual([]);
  });

  it("license check fails on espeak-ng or piper symbols, files, extra outputs or TTS enabled", () => {
    for (const s of ["espeak_Initialize", "espeak_ng_PrintStatusCodeMessage", "libespeak-ng.a", "_ZN5piper9phonemize", "piper_phonemize", "ESPEAK-NG"]) expect(GPL_PATTERN.test(s), s).toBe(true);
    expect(licenseFindings(fakeBuild(), fakeOutput({ [OUTPUT_FILES[1]!]: "....espeak_SetVoiceByName...." }))).toEqual([`output contains espeak/piper: ${OUTPUT_FILES[1]}`]);
    expect(licenseFindings(fakeBuild(undefined, { "_deps/espeak-ng-src/README": "x" }), fakeOutput())).toEqual(["build tree file: _deps/espeak-ng-src/README"]);
    expect(licenseFindings(fakeBuild(undefined, { "lib/libsherpa-onnx-core.a": "piper::Phonemize" }), fakeOutput())).toEqual(["build artifact contains espeak/piper: lib/libsherpa-onnx-core.a"]);
    expect(licenseFindings(fakeBuild("SHERPA_ONNX_ENABLE_TTS:BOOL=ON\nSHERPA_ONNX_ENABLE_WASM_KWS:BOOL=ON\n"), fakeOutput())).toEqual(["CMakeCache.txt: SHERPA_ONNX_ENABLE_TTS is not OFF"]);
    expect(licenseFindings(null, fakeOutput({ "sherpa-onnx-wasm-kws-main.data": "model" }))[0]).toMatch(/output files must be exactly/);
  });

  it("prints a SHA-256 manifest of the three outputs with the pins and the release name", () => {
    const out = fakeOutput();
    const m = manifestFor(out);
    expect(m.release_tag).toBe(releaseTag());
    expect(m.files.map((f) => f.name)).toEqual(OUTPUT_FILES);
    expect(m.release_only.map((f) => f.name)).toEqual(["LICENSE.sherpa-onnx.txt"]);
    for (const f of [...m.files, ...m.release_only]) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m).toMatchObject(readPins());
  });
});
