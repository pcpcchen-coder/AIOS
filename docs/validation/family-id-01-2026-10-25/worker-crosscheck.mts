// 家人辨識 ID-01 雲端核對：產品 worker（dist 建置結果，經本機核心提供，帶 JS CSP）× OpenCV 參考。
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const APP = process.env.APP_DIR ?? fileURLToPath(new URL("../../../prototype/ambient-shell", import.meta.url));
const [frameDir, refDir, outFile] = process.argv.slice(2);
const { startNous } = await import(`${APP}/server/nous.ts`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const tmp = mkdtempSync(join(tmpdir(), "id01-"));
const dist = join(tmp, "dist");
cpSync(join(APP, "dist"), dist, { recursive: true });
// CSP 探針：同源 module worker 嘗試連外與 eval；應該都被 JS 回應的 CSP 擋下。
writeFileSync(join(dist, "assets", "csp-probe.js"), `
const out = [];
try { await fetch("https://example.com/"); out.push("fetch:allowed"); } catch (e) { out.push("fetch:blocked"); }
try { new Function("return 1")(); out.push("eval:allowed"); } catch (e) { out.push("eval:blocked"); }
try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); out.push("wasm:allowed"); } catch (e) { out.push("wasm:blocked"); }
postMessage(out);
`);
const logs: string[] = [];
const fakeBox = { available: () => true, seal: (s: string) => Buffer.from(s), open: (b: Buffer) => b.toString() };
const core = await startNous({
  envFile: null, dataDir: join(tmp, "data"), distDir: dist, fallbackPort: true,
  overrides: { NOUS_CONFIG_DIR: join(tmp, "config"), NOUS_PROVIDER: "mock", NOUS_CAMERA: "on", PORT: "18787", OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  identity: { dir: join(tmp, "identity"), secretBox: fakeBox, confirm: async () => true, modelDir: join(APP, "face-runtime") },
  log: (l: string) => logs.push(l),
});
const worker = readdirSync(join(dist, "assets")).find((f) => f.startsWith("identity-worker-"))!;
const headers = Object.fromEntries((await fetch(`${core.url}/assets/${worker}`)).headers);
const browser = await chromium.launch();
const page = await browser.newPage();
const offOrigin: string[] = [];
const consoleMsgs: string[] = [];
page.on("request", (r: any) => { if (!r.url().startsWith(core.url)) offOrigin.push(r.url()); });
page.on("console", (m: any) => consoleMsgs.push(m.text()));
page.on("worker", (w: any) => w.on("console", (m: any) => consoleMsgs.push(`[worker] ${m.text()}`)));
await page.goto(core.url);
const probe = await page.evaluate(`(async () => {
  const w = new Worker("/assets/csp-probe.js", { type: "module" });
  return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res(["error:" + e.message]); setTimeout(() => res(["timeout"]), 5000); });
})()`);
const ref = JSON.parse(readFileSync(join(refDir, "ref.json"), "utf8")).results;
const names = Object.keys(ref);
const frames: Record<string, string> = {};
for (const n of names) {
  const p = [join(frameDir, n), join(refDir, n)].find((x) => { try { readFileSync(x); return true; } catch { return false; } })!;
  frames[n] = readFileSync(p).toString("base64");
}
const results: any = await page.evaluate(`(async ({ worker, frames }) => {
  const w = new Worker("/assets/" + worker, { type: "module" });
  const next = () => new Promise((res) => { w.onmessage = (e) => res(e.data); });
  const t0 = performance.now();
  w.postMessage({ type: "init", assets: { wasmPrefix: "/face-runtime/", detector: "/face-runtime/face_detection_yunet_2023mar.onnx", recognizer: "/face-runtime/face_recognition_sface_2021dec.onnx" } });
  const ready = await next();
  const loadMs = performance.now() - t0;
  const out = {};
  let gen = 1;
  for (const [name, b64] of Object.entries(frames)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(bytes.buffer.slice(0)), 1280, 720));
      w.postMessage({ type: "frame", gen, bitmap }, [bitmap]);
      const r = await next();
      runs.push({ ...r, feature: r.feature ? Array.from(r.feature) : undefined });
    }
    out[name] = runs;
    gen++;
  }
  return { ready, loadMs, out };
})(${JSON.stringify({ worker, frames })})`);
const dotp = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const summary: any[] = [];
for (const n of names) {
  const runs = results.out[n];
  const r = runs.at(-1);
  const ms = runs.slice(1).map((x: any) => x.ms).sort((a: number, b: number) => a - b);
  const refFaces = ref[n].faces.length;
  const cos = r.feature && ref[n].features.length === 1 ? dotp(r.feature, ref[n].features[0]) : null;
  summary.push({ frame: n, worker_faces: r.face_count, opencv_faces: refFaces, quality: r.quality, cosine_vs_opencv: cos === null ? null : Number(cos.toFixed(5)), ms_median: ms[Math.floor(ms.length / 2)], ms_max: ms.at(-1) });
}
// 同一人／不同人的 cosine（sanity check，不是門檻依據）。
const feats = Object.fromEntries(names.filter((n) => results.out[n].at(-1).feature).map((n) => [n, results.out[n].at(-1).feature]));
const pairs: any[] = [];
const fn = Object.keys(feats);
for (let i = 0; i < fn.length; i++) for (let j = i + 1; j < fn.length; j++) pairs.push({ a: fn[i], b: fn[j], cosine: Number(dotp(feats[fn[i]], feats[fn[j]]).toFixed(4)) });
const report = { features: feats, worker_headers: { csp: headers["content-security-policy"], type: headers["content-type"] }, csp_probe: probe, ready: results.ready, load_ms: Math.round(results.loadMs), summary, pairs, off_origin_requests: offOrigin, console: consoleMsgs.filter((m) => /Content Security|CSP|error/i.test(m)).slice(0, 20), core_log_identity: logs.filter((l) => l.includes("家人辨識") || l.includes("identity")), chromium: browser.version() };
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, pairs: undefined, features: undefined }, null, 2));
console.log(pairs.map((p) => `${p.a} × ${p.b}: ${p.cosine}`).join("\n"));
await browser.close();
await core.close();
rmSync(tmp, { recursive: true, force: true });
