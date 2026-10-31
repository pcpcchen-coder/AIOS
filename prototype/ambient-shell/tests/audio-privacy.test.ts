import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WAKE_STATE_REASONS } from "../shared/wake.ts";

// WK-01a 常駐喚醒聆聽的隱私邊界（靜態，仿 tests/camera-privacy.test.ts；docs/17 §5.2、§12、ADR-0003 §2.3 第 3 點）。
// 紅線：未喚醒音訊不得寫檔、進 trace 或外傳。這是字面掃描：間接呼叫抓不到，執行期另由 AudioRing.toJSON、
// isWakeWorkerOut 與 tests/wake-logic.test.ts 的 worker 協定測試擋住。
// WK-01b 準備批次的唯一放寬：worker 載入引擎時經 src/audio/runtime-net.ts 讀同源 /wake-runtime/ 的清單檔案。
// 那個檔案的每一行網路用法都逐字釘在 RUNTIME_NET_LINES；執行期的行為（只接受清單檔名、載入後關閉網路）在
// tests/wake-runtime-loader.test.ts。

const app = join(import.meta.dirname, "..");
const src = join(app, "src");
const audio = join(src, "audio");

function files(dir: string, pattern = /\.(ts|tsx|js|mjs|cjs|mts)$/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "web", "build"].includes(entry.name) ? [] : files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

/** 去掉註解行（// 與 JSDoc 的 *），只看程式。 */
function codeLines(file: string): { line: string; n: number }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

const AUDIO_FORBIDDEN = new RegExp(
  [
    // 錄音、匯出與存檔
    String.raw`\b(MediaRecorder|createObjectURL|toBlob|showSaveFilePicker|captureStream|FileReader)\b`,
    String.raw`new\s+(Blob|File)\s*\(`,
    String.raw`\bBlob\b`,
    // 網路與核心 API
    String.raw`\b(fetch|XMLHttpRequest|WebSocket|WebTransport|EventSource|sendBeacon|RTCPeerConnection)\b`,
    String.raw`\/api\/`,
    String.raw`\bimport\s*\(\s*["'\x60](https?:)?\/\/`,
    // App 的 IPC 與 preload
    String.raw`\b(ipcRenderer|nousDesktop)\b`,
    // 瀏覽器儲存
    String.raw`\b(localStorage|sessionStorage|indexedDB|caches)\b`,
    // 任何 console 輸出（音訊模組不印任何東西，也就不會印出樣本）
    String.raw`\bconsole\.\w+\(`,
  ].join("|"),
);

/**
 * runtime-net.ts 裡允許出現網路字樣的每一行（逐字）。只有一個真正的呼叫點（scope.fetch.bind），其他是型別宣告與
 * lockGlobals() 要覆蓋的全域名稱清單。新增或修改任何一行都要在這裡說明。
 */
const RUNTIME_NET_LINES = [
  'fetch: (input: string, init?: { credentials?: "omit" | "same-origin"; redirect?: "error"; cache?: "no-store" }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;',
  "XMLHttpRequest?: unknown;",
  "WebSocket?: unknown;",
  "EventSource?: unknown;",
  "WebTransport?: unknown;",
  "caches?: unknown;",
  'export const LOCKED_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker", "caches"] as const;',
  "const load = scope.fetch.bind(scope);",
];
/** runtime-net.ts 裡允許出現 importScripts（動態程式規則）的行：型別宣告與要覆蓋的清單。 */
const RUNTIME_NET_DYNAMIC_LINES = ["importScripts?: unknown;", RUNTIME_NET_LINES[6]!];

describe("audio privacy (static)", () => {
  const audioFiles = files(audio);

  it("src/audio has the expected modules and no file name mentions the engine (kws)", () => {
    expect(audioFiles.map((f) => relative(audio, f)).sort()).toEqual(
      ["capture-worklet.ts", "capture.ts", "controller.ts", "detector.ts", "earcon.ts", "front-end.ts", "guard.ts", "index.ts", "no-voice.ts", "resample.ts", "ring.ts", "runtime-net.ts", "wake-worker.ts", "worker-core.ts"].sort(),
    );
    expect(audioFiles.filter((f) => /kws|sherpa/i.test(relative(audio, f)))).toEqual([]);
  });

  it("only src/audio/front-end.ts calls getUserMedia({ audio }); the only other audio caller is the unchanged flag-off realtime path", () => {
    const callers = files(src).flatMap((file) =>
      codeLines(file)
        .filter(({ line }) => /\bgetUserMedia\s*\(/.test(line))
        .map(({ line, n }) => ({ file: relative(src, file), n, line: line.trim() })),
    );
    const byFile = (name: string) => callers.filter((c) => c.file === name);
    // 常駐喚醒聆聽：唯一的擁有者
    expect(byFile(join("audio", "front-end.ts")).length).toBeGreaterThan(0);
    expect(callers.filter((c) => c.file.startsWith(`audio${"/"}`) && c.file !== join("audio", "front-end.ts"))).toEqual([]);
    // 旗標關閉時即時語音照舊（同 9778b41 的那一行）；旗標開啟時 main.ts 以 AudioFrontEnd 的租用取代它
    expect(byFile("realtime.ts").map((c) => c.line)).toEqual([
      "getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),",
    ]);
    // 鏡頭管線：不收音（audio: false）
    expect(byFile(join("sense", "pipeline.ts")).length).toBe(2);
    expect(readFileSync(join(src, "sense", "pipeline.ts"), "utf8")).toMatch(/audio: false/);
    expect(callers.filter((c) => ![join("audio", "front-end.ts"), "realtime.ts", join("sense", "pipeline.ts")].includes(c.file))).toEqual([]);
  });

  it("src/audio never records, exports, uploads, stores, logs or talks to IPC; the only network lines are the pinned ones in runtime-net.ts", () => {
    const hits = audioFiles.flatMap((file) =>
      codeLines(file)
        .filter(({ line }) => AUDIO_FORBIDDEN.test(line))
        .map(({ line }) => ({ file: relative(audio, file), line: line.trim() })),
    );
    expect(hits.filter((h) => h.file !== "runtime-net.ts")).toEqual([]);
    expect(hits.filter((h) => h.file === "runtime-net.ts").map((h) => h.line)).toEqual(RUNTIME_NET_LINES);
    // 唯一的呼叫點只用在 bytes()，而且之前一定先經過 pathOf（已關閉就丟錯、只接受清單檔名、只拼同源前綴）
    const net = readFileSync(join(audio, "runtime-net.ts"), "utf8");
    // `load` 只出現在定義與 `await load(pathOf(` 這一種用法（不能被傳出去或另外呼叫）
    const uses = [...net.matchAll(/\bload\b.{0,12}/g)].map((m) => m[0]);
    expect(uses).toEqual(["load = scope.fet", "load(pathOf(name"]);
    expect([...net.matchAll(/await load\(pathOf\(/g)]).toHaveLength(1);
    expect(net).toMatch(/const res = await load\(pathOf\(name, globalsLocked\), \{ credentials: "same-origin", redirect: "error", cache: "no-store" \}\);/);
    expect(net).toMatch(/const pathOf = \(name: string, closed: boolean\): string => \{\s*if \(closed\) throw new NetworkLockedError\(\);\s*if \(!allowed\.has\(name\)\) throw new Error\("not a listed wake runtime file"\);\s*return `\$\{prefix\}\$\{name\}`;\s*\};/);
    expect(net).toMatch(/if \(prefix !== "\/wake-runtime\/"\) throw/);
  });

  it("the worker has exactly one other network path (import() in runtime-net.ts, listed names only), and the network is locked before third-party init and after load", () => {
    const dynamicImports = audioFiles.flatMap((file) =>
      codeLines(file)
        .filter(({ line }) => /\bimport\s*\(/.test(line))
        .map(({ line }) => `${relative(audio, file)}: ${line.trim()}`),
    );
    expect(dynamicImports).toEqual(["runtime-net.ts: importer: (path: string) => Promise<unknown> = (path) => import(/* @vite-ignore */ path),"]);
    const net = readFileSync(join(audio, "runtime-net.ts"), "utf8");
    expect(net).toMatch(/module\(name\) \{\s*return importer\(pathOf\(name, importsLocked\)\);\s*\}/);
    // lockGlobals() 覆蓋 LOCKED_GLOBALS（含 Worker、SharedWorker、caches），定義成不可寫、不可重設
    expect(net).toMatch(/for \(const key of LOCKED_GLOBALS\) Object\.defineProperty\(scope, key, \{ value: blocked, writable: false, configurable: false, enumerable: false \}\);/);
    // 只有 wake-worker.ts 建立 runtime-net，用清單的前綴與檔名
    const creators = audioFiles.filter((f) => /createRuntimeNet\(/.test(readFileSync(f, "utf8"))).map((f) => relative(audio, f)).sort();
    expect(creators).toEqual(["runtime-net.ts", "wake-worker.ts"]);
    expect(readFileSync(join(audio, "wake-worker.ts"), "utf8")).toMatch(/const net = createRuntimeNet\(scope, runtime\.url_prefix, runtime\.files\.map\(\(f\) => f\.name\)\);/);
    // 偵測器：清單未就緒時不連網就 lock；載入時先讀完、核對雜湊，然後 lockGlobals 才 import()（第三方 module 的頂層程式執行時
    // 網路全域已關閉），import 完 lockImports，之後才執行 Emscripten 初始化；finally 再 lock 一次
    const detector = readFileSync(join(audio, "detector.ts"), "utf8");
    const load = detector.slice(detector.indexOf("async load(): Promise<void> {"), detector.lastIndexOf("accept(samples: Float32Array)"));
    expect(load.indexOf("wakeRuntimeBlockers(this.manifest)")).toBeLessThan(load.indexOf("net.bytes("));
    expect(load.indexOf("net.sha256(bytes)")).toBeGreaterThan(load.indexOf("net.bytes("));
    const globalsAt = load.indexOf("net.lockGlobals();");
    const importsAt = load.indexOf("net.lockImports();");
    expect(globalsAt).toBeGreaterThan(load.lastIndexOf("await verified("));
    expect(globalsAt).toBeLessThan(load.indexOf("net.module("));
    expect(load.lastIndexOf("net.module(")).toBeLessThan(importsAt);
    expect(importsAt).toBeLessThan(load.indexOf("glue.default("));
    expect([...load.matchAll(/net\.bytes\(/g)]).toHaveLength(1); // 只在 verified() 裡
    expect(load).toMatch(/\} finally \{\s*net\.lock\(\);\s*\}/);
    // 其他 src/audio 模組不呼叫 bytes()／module()
    const callers = audioFiles.filter((f) => /\bnet\.(bytes|module)\(/.test(readFileSync(f, "utf8"))).map((f) => relative(audio, f));
    expect(callers).toEqual(["detector.ts"]);
  });

  it("flags the patterns it is meant to catch", () => {
    const samples = [
      "new MediaRecorder(stream)",
      "const b = new Blob([pcm])",
      "URL.createObjectURL(b)",
      "await fetch('/wake')",
      "navigator.sendBeacon(u, d)",
      "window.nousDesktop.reportState(x)",
      "ipcRenderer.send('x', pcm)",
      "localStorage.setItem('ring', x)",
      "indexedDB.open('a')",
      "console.log(samples)",
      "console.debug(chunk.length)",
      'await import("https://cdn.example/x.js")',
      "api.post('/api/settings/wake')",
    ];
    expect(samples.filter((line) => !AUDIO_FORBIDDEN.test(line))).toEqual([]);
    expect(AUDIO_FORBIDDEN.test("this.port.postMessage(this.buf, [this.buf.buffer]);")).toBe(false);
  });

  it("src/audio imports only itself, shared/wake.ts, the runtime manifest and the energy detector", () => {
    const allowed = /^(\.\/[\w-]+\.ts(\?worker&url)?|\.\.\/\.\.\/shared\/wake\.ts|\.\.\/\.\.\/shared\/wake-runtime\.json|\.\.\/early-speech\.ts)$/;
    const imports = audioFiles.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g)].map((m) => ({ file: relative(audio, file), spec: m[1]! })),
    );
    expect(imports.filter((i) => !allowed.test(i.spec))).toEqual([]);
    // 測試替身（假偵測器）不在產品程式裡
    const product = ["src", "server", "shared", "desktop"].flatMap((d) => files(join(app, d)));
    const IMPORTS_FIXTURE = /(\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`][^"'`]*tests\/fixtures/;
    expect(product.filter((f) => IMPORTS_FIXTURE.test(readFileSync(f, "utf8")) || codeLines(f).some(({ line }) => /\bFakeDetector\b/.test(line)))).toEqual([]);
  });

  it("every postMessage in src/audio is on a fixed allowlist: the worker posts only events, the worklet sends samples only to the worker port", () => {
    // 審查 m4：逐一列出每個 postMessage（含 port 與 worker），新增任何一個都要在這裡說明。
    const ALLOWED: Record<string, string[]> = {
      "capture-worklet.ts": ["this.out.postMessage(this.buf, [this.buf.buffer]);"],
      "capture.ts": [
        'node?.port.postMessage({ type: "stop" });',
        'w.postMessage({ type: "clear" });',
        'w.postMessage({ type: "close" });',
        'worker.postMessage({ type: "init", sampleRate: ctx.sampleRate }, [channel.port2]);',
        'node.port.postMessage({ type: "port" }, [channel.port1]);',
      ],
      "wake-worker.ts": ["postMessage(message: WakeWorkerOut): void;", "core = new WakeWorkerCore(new SherpaWasmDetector(runtime, net), (out) => scope.postMessage(out));", "scope.postMessage(closed);"],
    };
    const found: Record<string, string[]> = {};
    for (const file of audioFiles) {
      const lines = codeLines(file).filter(({ line }) => /postMessage/.test(line)).map(({ line }) => line.trim());
      if (lines.length) found[relative(audio, file)] = lines;
    }
    expect(found).toEqual(ALLOWED);
    // worker 的輸出：worker-core 只經 emit（先 isWakeWorkerOut 檢查），closed 是固定物件
    const core = readFileSync(join(audio, "worker-core.ts"), "utf8");
    expect([...core.matchAll(/this\.post\(([^;]+)\);/g)].map((m) => m[1])).toEqual(["message"]);
    expect(core).toMatch(/private emit\(message: WakeWorkerOut\): void \{\s*if \(isWakeWorkerOut\(message\)\) this\.post\(message\);\s*\}/);
    expect(readFileSync(join(audio, "wake-worker.ts"), "utf8")).toMatch(/const closed: WakeWorkerOut = \{ type: "closed" \};/);
    // 主執行緒只接受檢查過的事件
    expect(readFileSync(join(audio, "capture.ts"), "utf8")).toMatch(/if \(stopped \|\| !isWakeWorkerOut\(event\.data\)\) return;/);
    // 環形緩衝不可序列化
    expect(readFileSync(join(audio, "ring.ts"), "utf8")).toMatch(/toJSON\(\): never \{\s*throw/);
  });

  it("src/audio has no indirect global access or dynamic code, and new URL only points at the wake worker", () => {
    const DYNAMIC = /\bself\.|\bscope\s*\[|\bglobalThis\s*\[|\bReflect\.|\beval\s*\(|\bnew\s+Function\b|\bimportScripts\b|\bwindow\s*\[/;
    // worker／worklet 的進入點以 self 取得自己的範圍；只允許 `self as unknown as Scope` 這一種寫法
    const SELF_ALLOWED = new Set(["wake-worker.ts"]);
    const hits = audioFiles.flatMap((file) =>
      codeLines(file)
        .filter(({ line }) => DYNAMIC.test(line) || (/\bself\b/.test(line) && !(SELF_ALLOWED.has(relative(audio, file)) && /const scope = self as unknown as Scope;/.test(line))))
        .filter(({ line }) => !(relative(audio, file) === "runtime-net.ts" && RUNTIME_NET_DYNAMIC_LINES.includes(line.trim())))
        .map(({ line, n }) => `${relative(audio, file)}:${n}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
    // 例外的那兩行確實存在（不是空的放行）
    const netLines = codeLines(join(audio, "runtime-net.ts")).map(({ line }) => line.trim());
    for (const line of RUNTIME_NET_DYNAMIC_LINES) expect(netLines).toContain(line);
    for (const sample of ["self.postMessage(x)", "globalThis['fetch'](u)", "Reflect.get(window, 'fetch')", "eval('x')", "new Function('return fetch')", "importScripts('x.js')", "window['fetch'](u)", "scope['fetch'](u)", "scope [key] = f"]) {
      expect(DYNAMIC.test(sample), sample).toBe(true);
    }
    const urls = audioFiles.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/new URL\(([^)]*)\)/g)].map((m) => `${relative(audio, file)}: ${m[1]}`));
    expect(urls).toEqual(['capture.ts: "./wake-worker.ts", import.meta.url']);
  });

  it("src/audio is loaded only by dynamic import from main.ts when settings.wake exists; no other module (incl. views that render generated content) can reach it", () => {
    const product = ["src", "server", "shared", "desktop"].flatMap((d) => files(join(app, d))).filter((f) => !f.startsWith(audio));
    const IMPORTS_AUDIO = /(\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`][^"'`]*\baudio\/[\w-]+\.ts/;
    const importers = product.filter((f) => IMPORTS_AUDIO.test(readFileSync(f, "utf8"))).map((f) => relative(app, f));
    expect(importers).toEqual([join("src", "main.ts")]);
    const main = readFileSync(join(src, "main.ts"), "utf8");
    const statics = [...main.matchAll(/^import\s+(type\s+)?[^;]*from\s+["']\.\/audio\/[^"']+["'];$/gm)];
    expect(statics.map((m) => Boolean(m[1]))).toEqual([true]); // 只有 import type（編譯後消失）
    expect([...main.matchAll(/import\(\s*["']\.\/audio\/([^"']+)["']\s*\)/g)].map((m) => m[1])).toEqual(["index.ts"]);
    const loader = main.slice(main.indexOf("function syncWake("), main.indexOf("function renderWakeIndicator("));
    expect(loader).toMatch(/if \(!view\) \{/);
    expect(loader.indexOf("if (!view)")).toBeLessThan(loader.indexOf('import("./audio/index.ts")'));
    // 旗標關閉時 getMicrophone 是 browserRealtimeDeps 原本的函式：wakeMicrophone() 在沒有控制器時回空物件
    expect(main).toMatch(/const owner = wake;\s*if \(!owner\) return \{\};/);
    // 審查 M1／m9：保險的歸還只在沒有任何進行中或開始中的通話時；旗標在通話中關掉時等通話結束才結束常駐聆聽
    expect(main).toMatch(/if \(phase === "off" && !realtime\.on && !realtimeStarting\) \{\s*wake\?\.releaseAllLeases\(\);/);
    expect(main).toMatch(/releaseMicrophone: \(stream\) => owner\.releaseLease\(stream\)/);
    expect(main).not.toMatch(/releaseLease\(\)/);
    expect(main).toMatch(/if \(realtime\.on \|\| realtimeStarting\) wakeDisposePending = true;\s*else disposeWake\(\);/);
    // 喚醒的狀態不點亮聽覺區：區域活動的收音來源仍只有三種語音模式
    expect(main).toMatch(/capture: \{ push: voice\.capturing, continuous: conversation\.capturing \|\| realtime\.capturing \}/);
    expect(main.slice(main.indexOf("const activity = collectRegionActivity("), main.indexOf("renderRegionActivity(activity);"))).not.toMatch(/wake/);
  });

  it("preload passes only enum wake reports and power events (same allowlist as shared/wake.ts)", () => {
    const preload = readFileSync(join(app, "desktop", "preload.cjs"), "utf8");
    const exposed: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
    const send = vi.fn();
    const on = vi.fn();
    const require = () => ({
      contextBridge: { exposeInMainWorld: (key: string, api: Record<string, (...args: unknown[]) => unknown>) => (exposed[key] = api) },
      ipcRenderer: { invoke: vi.fn(), send, sendSync: vi.fn(() => "zh-TW"), on, removeListener: vi.fn() },
    });
    new Function("require", "process", preload)(require, { argv: [] });
    const bridge = exposed.nousDesktop!;
    bridge.reportState!({ voice: "off", activeTasks: 0, settings: "x", wake: { state: "listening_local", reason: null, deviceId: "mic-a", samples: [1, 2] } });
    expect(send).toHaveBeenLastCalledWith("nous:state", { voice: "off", activeTasks: 0, settings: "x", wake: { state: "listening_local", reason: null } });
    for (const wake of [{ state: "listening_local", reason: "sleep" }, { state: "hacked", reason: null }, { state: "error", reason: "mic-a" }, "listening_local", null]) {
      bridge.reportState!({ voice: "off", activeTasks: 0, settings: "x", wake });
      expect(send.mock.lastCall![1]).not.toHaveProperty("wake");
    }
    // 白名單和 shared/wake.ts 一致
    const table = /const WAKE_STATE_REASONS = (\{[\s\S]*?\n\});/.exec(preload)![1]!;
    expect(new Function(`return ${table}`)()).toEqual(WAKE_STATE_REASONS);
    // onPower 只轉四個列舉值
    const received: unknown[] = [];
    bridge.onPower!((kind: unknown) => received.push(kind));
    const listener = on.mock.calls.find((c) => c[0] === "nous:power")![1] as (e: unknown, k: unknown) => void;
    for (const kind of ["suspend", "resume", "lock", "unlock", "shutdown", { kind: "resume" }, "resume; rm"]) listener({}, kind);
    expect(received).toEqual(["suspend", "resume", "lock", "unlock"]);
    // preload 不碰 deviceId 或樣本
    expect(codeLines(join(app, "desktop", "preload.cjs")).filter(({ line }) => /deviceId|device_id|samples|Float32Array/.test(line))).toEqual([]);
  });

  it("main.mjs forwards only the allowlisted wake report and power enums", () => {
    const main = readFileSync(join(app, "desktop", "main.mjs"), "utf8");
    expect(main).toMatch(/wake: isWakeReport\(state\.wake\) \? \{ state: state\.wake\.state, reason: state\.wake\.reason \?\? null \} : null/);
    expect([...main.matchAll(/notifyPower\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual(["lock", "resume", "suspend", "unlock"]);
    expect(main).toMatch(/win\.webContents\.send\("nous:power", event\)/);
  });
});
