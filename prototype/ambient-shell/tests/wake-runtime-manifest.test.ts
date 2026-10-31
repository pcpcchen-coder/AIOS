import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installVerified, verifyProduct } from "../scripts/wake-setup.mjs";
import { readPins } from "../scripts/wake-wasm.mjs";
import { checkWakeRuntime, WAKE_RUNTIME } from "../server/wake-runtime.ts";
import { validateWakeRuntimeManifest, WAKE_RELEASE_FILES, wakeRuntimeBlockers, type WakeRuntimeManifest } from "../shared/wake.ts";
import models from "../spike/wake/models.json" with { type: "json" };
import { builtTestManifest, FAKE_BYTES, sha256 } from "./fixtures/wake-wasm.ts";

// WK-01b 準備批次：shared/wake-runtime.json 的格式、pending_first_build 與 built 標記的效果，以及 npm run wake:setup -- --product 的核對
// （下載以注入的 fetchBytes 代替，不連網）。2026-10-31 起出貨的清單是 built（release wake-runtime-2.0.1-5961b4196003，
// run 41206217255），關鍵詞仍是 pending_owner_numbers，所以引擎仍回報 missing（只剩 keywords_pending）。
// pending_first_build 的情況改以 pendingManifest() 明確建構來測。

const app = join(import.meta.dirname, "..");
/** 2026-10-31 release（GitHub Actions run 41206217255，main bf76595）三個 release 檔的 SHA-256，與 PR 建置 run 41188249061 相同。 */
const RELEASE_TAG = "wake-runtime-2.0.1-5961b4196003";
const CONFIG_SHA256 = "5961b4196003b5d06967f045c81ee8c98f48b763d1d8c4c446cf8182291461fd";
const RELEASE_SHA256: Record<string, string> = {
  "sherpa-onnx-wasm-kws-main.mjs": "31342b5316cb03aabf43696d8166f74c8acfc86301bba70c44859d4a584aa136",
  "sherpa-onnx-wasm-kws-main.wasm": "116728205719c761bd8d301cae6745957dd86cd5a6a7b4ab63e6424ccec76aca",
  "sherpa-onnx-kws.mjs": "bd10d04c191f9db1e12884fa7f41c6a1aea5b50becddda94eee799fef6d2acc8",
};
/** 第一次 CI 建置之前的清單狀態（以出貨的清單明確建構，不依賴出貨檔本身）。 */
function pendingManifest(): WakeRuntimeManifest {
  const m = structuredClone(WAKE_RUNTIME);
  m.status = "pending_first_build";
  m.build.release_tag = null;
  m.build.config_sha256 = null;
  for (const f of m.files) if (f.source === "release") f.sha256 = "";
  return m;
}
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-wake-manifest-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("shared/wake-runtime.json schema", () => {
  it("the shipped manifest is valid and built from the 2026-10-31 release (real release hashes, tag carries the config hash prefix) with empty keywords", () => {
    expect(validateWakeRuntimeManifest(WAKE_RUNTIME)).toEqual([]);
    expect(WAKE_RUNTIME.status).toBe("built");
    expect(WAKE_RUNTIME.build.release_repo).toBe("pcpcchen-coder/AIOS");
    expect(WAKE_RUNTIME.build.release_tag).toBe(RELEASE_TAG);
    expect(WAKE_RUNTIME.build.config_sha256).toBe(CONFIG_SHA256);
    // tag 的尾碼是建置設定雜湊的前 12 碼
    expect(WAKE_RUNTIME.build.release_tag).toBe(`wake-runtime-${WAKE_RUNTIME.build.sherpa_onnx_version}-${CONFIG_SHA256.slice(0, 12)}`);
    const release = WAKE_RUNTIME.files.filter((f) => f.source === "release");
    expect(release.map((f) => f.name).sort()).toEqual(Object.values(WAKE_RELEASE_FILES).sort());
    expect(Object.fromEntries(release.map((f) => [f.name, f.sha256]))).toEqual(RELEASE_SHA256);
    // 不是測試替身的雜湊
    for (const f of release) expect(f.sha256, f.name).not.toBe(sha256(FAKE_BYTES[f.name]!));
    expect(WAKE_RUNTIME.keywords).toEqual({ status: "pending_owner_numbers", model: null, keywords_score: null, keywords_threshold: null, entries: [] });
  });

  it("model files reuse the WK-00 pinned archives and hashes (spike/wake/models.json), int8 encoder/joiner + decoder + tokens for both models", () => {
    const modelFiles = WAKE_RUNTIME.files.filter((f) => f.source === "model_archive");
    expect(modelFiles).toHaveLength(8);
    for (const f of modelFiles) {
      const entry = models.kws.find((m) => m.id === f.model)!;
      expect(entry, f.name).toBeDefined();
      expect(f.sha256, f.name).toBe((entry.files as unknown as Record<string, string>)[f.member!]);
      expect(f.name).toBe(`${f.model}.${f.member}`);
      expect([entry.encoder.int8, entry.decoder.int8, entry.joiner.int8, "tokens.txt"]).toContain(f.member);
    }
    expect(WAKE_RUNTIME.models.map((m) => m.id).sort()).toEqual(["wenetspeech-3.3M", "zh-en-3M"]);
  });

  it("build pins match scripts/build-wake-wasm.sh and the workflow", () => {
    const pins = readPins();
    expect(pins).toEqual({ sherpa_onnx_version: "2.0.1", sherpa_onnx_commit: "af2d8d81dbfa61c4cea4c568da78f3982edca005", emsdk_version: "4.0.23", emsdk_commit: "c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56" });
    expect(WAKE_RUNTIME.build).toMatchObject(pins);
    expect(existsSync(join(app, "..", "..", WAKE_RUNTIME.build.workflow))).toBe(true);
    expect(existsSync(join(app, "..", "..", WAKE_RUNTIME.build.script))).toBe(true);
  });

  it("rejects invented or malformed states", () => {
    const pending = pendingManifest();
    expect(validateWakeRuntimeManifest(pending)).toEqual([]);
    const bad = (edit: (m: WakeRuntimeManifest) => void, base: WakeRuntimeManifest = pending): string[] => {
      const m = structuredClone(base);
      edit(m);
      return validateWakeRuntimeManifest(m);
    };
    // pending 時 release 檔不得有雜湊、不得有 release_tag／config_sha256；built 時一定要有雜湊
    expect(bad((m) => (m.files[0]!.sha256 = "a".repeat(64)))).not.toEqual([]);
    expect(bad((m) => (m.status = "built"))).not.toEqual([]);
    expect(bad((m) => (m.build.release_tag = RELEASE_TAG))).not.toEqual([]);
    expect(bad((m) => (m.build.config_sha256 = CONFIG_SHA256))).not.toEqual([]);
    expect(bad((m) => (m.status = "pending_first_build"), WAKE_RUNTIME)).not.toEqual([]);
    expect(bad((m) => (m.files[0]!.sha256 = ""), WAKE_RUNTIME)).not.toEqual([]);
    expect(bad((m) => (m.files[1]!.sha256 = "not-a-hash"), WAKE_RUNTIME)).not.toEqual([]);
    expect(bad((m) => ((m as { status: string }).status = "released"), WAKE_RUNTIME)).not.toEqual([]);
    expect(bad((m) => (m.keywords.entries = [{ id: "X", tokens: "a", boost: null, threshold: null }]))).not.toEqual([]);
    expect(bad((m) => (m.files[3]!.sha256 = ""))).not.toEqual([]);
    expect(bad((m) => (m.files[3]!.name = "../x.onnx"))).not.toEqual([]);
    expect(bad((m) => (m.url_prefix = "https://cdn.example/"))).not.toEqual([]);
    expect(bad((m) => (m.build.sherpa_onnx_commit = "v2.0.1"))).not.toEqual([]);
    expect(bad((m) => (m.models[0]!.encoder = "zh-en-3M.tokens.txt".replace("zh-en-3M", "other")))).not.toEqual([]);
    // 設定好的關鍵詞：發音單元不得含 : # @ 或換行；門檻在 (0, 1)
    const built = builtTestManifest();
    expect(validateWakeRuntimeManifest(built)).toEqual([]);
    for (const tokens of ["n ǔ @X", "a:1", "a#0.1", "a\nb"]) {
      const m = structuredClone(built);
      m.keywords.entries[0]!.tokens = tokens;
      expect(validateWakeRuntimeManifest(m), tokens).not.toEqual([]);
    }
    const m = structuredClone(built);
    m.keywords.keywords_threshold = 1.5;
    expect(validateWakeRuntimeManifest(m)).not.toEqual([]);
  });

  it("the shipped built manifest is still not ok while keywords are pending (only keywords_pending); pending_first_build is never ok", () => {
    expect(wakeRuntimeBlockers(WAKE_RUNTIME)).toEqual(["keywords_pending"]);
    expect(checkWakeRuntime(root)).toEqual({ state: "missing", problems: ["keywords_pending"] });
    expect(checkWakeRuntime(null)).toEqual({ state: "missing", problems: ["keywords_pending"] });
    // 第一次建置之前的狀態：三個阻擋理由
    expect(wakeRuntimeBlockers(pendingManifest())).toEqual(["pending_first_build", "hash_missing", "keywords_pending"]);
    // 即使雜湊與關鍵詞都設好，只要還標著 pending_first_build 就不是 ok（格式也不合法）
    const m = builtTestManifest();
    m.status = "pending_first_build";
    expect(wakeRuntimeBlockers(m)).not.toEqual([]);
    // 關鍵詞未定（等 George 的數字）也不是 ok
    const k = builtTestManifest();
    k.keywords = { status: "pending_owner_numbers", model: null, keywords_score: null, keywords_threshold: null, entries: [] };
    expect(wakeRuntimeBlockers(k)).toEqual(["keywords_pending"]);
    expect(wakeRuntimeBlockers(builtTestManifest())).toEqual([]);
  });
});

describe("npm run wake:setup -- --product (verification; downloads replaced by an injected source)", () => {
  const archiveFor = (id: string) => `archive:${id}`;
  /** 假的來源：release 檔回 FAKE_BYTES；模型壓縮檔回一個代表字串（壓縮檔雜湊因此要以測試清單覆寫）。 */
  function source(overrides: Record<string, Uint8Array> = {}) {
    const requested: string[] = [];
    return {
      requested,
      fetchBytes: async (name: string, url: string) => {
        requested.push(url);
        if (overrides[name]) return overrides[name]!;
        if (FAKE_BYTES[name]) return Buffer.from(FAKE_BYTES[name]!);
        const entry = models.kws.find((m) => url === m.url);
        if (entry) return Buffer.from(archiveFor(entry.id));
        throw new Error(`fixture: unknown ${name}`);
      },
    };
  }
  /** 測試用的 models.json：壓縮檔雜湊換成上面代表字串的雜湊（真的檔案雜湊仍在 shared/wake-runtime.json）。 */
  const testModels = () => ({ ...models, kws: models.kws.map((m) => ({ ...m, archive_sha256: sha256(archiveFor(m.id)) })) });
  const extract = (archive: Uint8Array, _top: string, members: string[]) => {
    const id = Buffer.from(archive).toString().slice("archive:".length);
    const files = builtTestManifest().files.filter((f) => f.model === id);
    return new Map(members.map((m) => [m, Buffer.from(FAKE_BYTES[files.find((f) => f.member === m)!.name]!)]));
  };

  it("fails closed before any download when the manifest is pending_first_build (constructed; missing hashes)", async () => {
    const src = source();
    await expect(verifyProduct({ manifest: pendingManifest(), models, fetchBytes: src.fetchBytes, extract })).rejects.toThrow(/pending_first_build[\s\S]*missing hash: sherpa-onnx-wasm-kws-main\.mjs/);
    expect(src.requested).toEqual([]);
  });

  it("with the shipped manifest it downloads from the real release tag and rejects bytes that do not match the release hashes (nothing to install)", async () => {
    const src = source();
    const run = verifyProduct({ manifest: WAKE_RUNTIME, models, fetchBytes: src.fetchBytes, extract });
    await expect(run).rejects.toThrow(/mismatch: sherpa-onnx-wasm-kws-main\.mjs/);
    await expect(run).rejects.toThrow(/mismatch: sherpa-onnx-wasm-kws-main\.wasm/);
    await expect(run).rejects.toThrow(/mismatch: sherpa-onnx-kws\.mjs/);
    await expect(run).rejects.toThrow(new RegExp(`expected ${RELEASE_SHA256["sherpa-onnx-wasm-kws-main.wasm"]}`));
    // 注入的模型壓縮檔也不是真的壓縮檔
    await expect(run).rejects.toThrow(/archive SHA-256 mismatch/);
    expect(src.requested.filter((u) => u.includes("/releases/download/wake-runtime-")).sort()).toEqual(
      Object.values(WAKE_RELEASE_FILES).map((n) => `https://github.com/pcpcchen-coder/AIOS/releases/download/${RELEASE_TAG}/${n}`).sort(),
    );
  });

  it("keywords pending does not stop setup (the script checks only the build and hashes); the installed folder still reports missing with only keywords_pending", async () => {
    // 出貨的清單，release 雜湊換成測試替身的雜湊（真的 release 位元組不在測試裡）；keywords 仍是 pending_owner_numbers
    const m = structuredClone(WAKE_RUNTIME);
    for (const f of m.files) f.sha256 = sha256(FAKE_BYTES[f.name]!);
    expect(m.keywords.status).toBe("pending_owner_numbers");
    expect(validateWakeRuntimeManifest(m)).toEqual([]);
    const src = source();
    const verified = await verifyProduct({ manifest: m, models: testModels(), fetchBytes: src.fetchBytes, extract });
    expect([...verified.keys()].sort()).toEqual(m.files.map((f) => f.name).sort());
    expect(src.requested.filter((u) => u.includes("/releases/download/wake-runtime-")).map((u) => u.split("/").at(-2))).toEqual([RELEASE_TAG, RELEASE_TAG, RELEASE_TAG]);
    const dest = join(root, "wake-runtime");
    installVerified(verified, [dest]);
    expect(readdirSync(dest).sort()).toEqual(m.files.map((f) => f.name).sort());
    // 檔案都對，但關鍵詞未定：引擎仍不可用
    expect(checkWakeRuntime(dest, m.files, wakeRuntimeBlockers(m))).toEqual({ state: "missing", problems: ["keywords_pending"] });
  });

  it("fails on any single missing hash, and on any manifest format error, before downloading", async () => {
    for (const index of [0, 4]) {
      const m = builtTestManifest();
      m.files[index]!.sha256 = "";
      const src = source();
      await expect(verifyProduct({ manifest: m, models: testModels(), fetchBytes: src.fetchBytes, extract })).rejects.toThrow(/invalid manifest/);
      expect(src.requested).toEqual([]);
    }
    // 不安全的檔名（子資料夾、..）在 join 之前就被擋下
    for (const name of ["../escape.wasm", "sub/x.onnx", ".hidden"]) {
      const m = builtTestManifest();
      m.files[3]!.name = name;
      const src = source();
      await expect(verifyProduct({ manifest: m, models: testModels(), fetchBytes: src.fetchBytes, extract }), name).rejects.toThrow(/invalid manifest/);
      expect(src.requested).toEqual([]);
    }
    const m = builtTestManifest();
    m.files[3]!.member = "../../etc/passwd";
    await expect(verifyProduct({ manifest: m, models: testModels(), fetchBytes: source().fetchBytes, extract })).rejects.toThrow(/unsafe archive member name/);
    expect(() => installVerified(new Map([["../x", Buffer.from("x")]]), [join(root, "d")])).toThrow(/unsafe install name/);
  });

  it("verifies every file, downloads release files from the release tag, and installs only after everything passed", async () => {
    const m = builtTestManifest();
    const src = source();
    const verified = await verifyProduct({ manifest: m, models: testModels(), fetchBytes: src.fetchBytes, extract });
    expect([...verified.keys()].sort()).toEqual(m.files.map((f) => f.name).sort());
    expect(src.requested.filter((u) => u.includes("/releases/download/wake-runtime-")).sort()).toEqual(
      Object.values(WAKE_RELEASE_FILES).map((n) => `https://github.com/pcpcchen-coder/AIOS/releases/download/${m.build.release_tag}/${n}`).sort(),
    );
    expect(src.requested.filter((u) => u.includes("/kws-models/")).sort()).toEqual(models.kws.map((x) => x.url).sort());
    const dest = join(root, "wake-runtime");
    installVerified(verified, [dest]);
    expect(readdirSync(dest).sort()).toEqual(m.files.map((f) => f.name).sort());
    for (const f of m.files) expect(sha256(readFileSync(join(dest, f.name)))).toBe(f.sha256);
    // 裝好的資料夾通過核心的核對（以測試清單的檔案與無阻擋理由）
    expect(checkWakeRuntime(dest, m.files, wakeRuntimeBlockers(m)).state).toBe("ok");
  });

  it("a mismatch on a release file, an archive or an extracted model file fails closed (nothing returned to install)", async () => {
    const m = builtTestManifest();
    await expect(verifyProduct({ manifest: m, models: testModels(), fetchBytes: source({ [WAKE_RELEASE_FILES.wasm]: Buffer.from("tampered") }).fetchBytes, extract })).rejects.toThrow(
      /mismatch: sherpa-onnx-wasm-kws-main\.wasm/,
    );
    await expect(verifyProduct({ manifest: m, models, fetchBytes: source().fetchBytes, extract })).rejects.toThrow(/archive SHA-256 mismatch/);
    const badExtract = (archive: Uint8Array, top: string, members: string[]) => new Map([...extract(archive, top, members)].map(([k, v]) => [k, k === "tokens.txt" ? Buffer.from("x") : v]));
    await expect(verifyProduct({ manifest: m, models: testModels(), fetchBytes: source().fetchBytes, extract: badExtract })).rejects.toThrow(/file SHA-256 mismatch: .*tokens\.txt/);
  });

  it("installs atomically: replaces each destination by rename, and rolls back the first destination if the second fails", async () => {
    const m = builtTestManifest();
    const verified = await verifyProduct({ manifest: m, models: testModels(), fetchBytes: source().fetchBytes, extract });
    const first = join(root, "a", "wake-runtime");
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, "old.txt"), "previous install");
    // 第二個目的地的上層是一個檔案：mkdir 失敗
    writeFileSync(join(root, "blocker"), "file");
    const second = join(root, "blocker", "wake-runtime");
    expect(() => installVerified(verified, [first, second])).toThrow();
    expect(readdirSync(first)).toEqual(["old.txt"]);
    expect(readFileSync(join(first, "old.txt"), "utf8")).toBe("previous install");
    expect(readdirSync(join(root, "a"))).toEqual(["wake-runtime"]); // 沒有留下 .tmp- 或 .old
    // 成功時整個換成新的檔案，備份也刪掉
    installVerified(verified, [first]);
    expect(readdirSync(first).sort()).toEqual(m.files.map((f) => f.name).sort());
    expect(readdirSync(join(root, "a"))).toEqual(["wake-runtime"]);
  });

  it("the product never downloads at runtime: only the setup script knows the release URL; server, src, shared and desktop do not fetch wake files", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (["node_modules", "build", "dist"].includes(e.name) ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
    const product = ["src", "server", "shared", "desktop"].flatMap((d) => walk(join(app, d))).filter((f) => /\.(ts|mjs|cjs|js)$/.test(f));
    const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    const hits = product.filter((f) => /releases\/download|kws-models|wake-setup|github\.com\/k2-fsa/.test(code(f)));
    expect(hits).toEqual([]);
    expect(readFileSync(join(app, "scripts", "wake-setup.mjs"), "utf8")).toMatch(/releases\/download/);
    expect(readFileSync(join(app, ".gitignore"), "utf8")).toContain("wake-runtime/");
  });
});
