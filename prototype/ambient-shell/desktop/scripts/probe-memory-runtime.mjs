import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { build } from "esbuild";

const roundtrip = process.argv.includes("--roundtrip");
if (process.argv.slice(2).some(arg => arg !== "--roundtrip")) throw new Error("Only --roundtrip is supported");
if (process.platform !== "darwin") throw new Error("This probe requires the target Mac runtime");
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const lockedVersion = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).devDependencies.electron;
if (lockedVersion !== "44.9.3") throw new Error("Review the probe before changing the locked Electron version");
const scratch = mkdtempSync(join(tmpdir(), "nous-memory-runtime-"));
const source = join(scratch, "source");
mkdirSync(source, { mode: 0o700 });
cpSync(join(desktop, "memory-safe-storage.mjs"), join(source, "memory-safe-storage.mjs"));
await build({ entryPoints: [join(desktop, "..", "server", "memory", "store.ts")], outfile: join(source, "memory-store.mjs"), bundle: true, platform: "node", format: "esm", target: "node24" });
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "nous-memory-probe", version: "0.0.0", type: "module", main: "main.mjs" }));
writeFileSync(join(source, "main.mjs"), `
import { app, safeStorage } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemorySecretBox } from "./memory-safe-storage.mjs";
import { MemoryStore, newStoreOperation } from "./memory-store.mjs";
const root = process.env.NOUS_MEMORY_PROBE_ROOT;
const phase = process.env.NOUS_MEMORY_PROBE_PHASE;
if (!root || !["capabilities", "store_fixture", "write", "read"].includes(phase)) process.exit(2);
app.setName("NousMemoryProbe");
app.setPath("userData", join(root, "isolated-user-data"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
const output = { mode: phase, electron: process.versions.electron, packaged: app.isPackaged, platform: process.platform };
const finish = (code) => { writeFileSync(join(root, phase + ".json"), JSON.stringify(output, null, 2), { mode: 0o600 }); app.exit(code); };
app.whenReady().then(async () => {
  app.dock?.hide();
  output.methods = Object.fromEntries(["isEncryptionAvailable", "encryptString", "decryptString", "isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"].map(key => [key, typeof safeStorage[key]]));
  if (output.electron !== "44.9.3" || !app.isPackaged) { output.status = "wrong_runtime"; finish(1); return; }
  if (phase === "capabilities") { output.status = "capabilities_only"; output.keychainAccessAttempted = false; finish(0); return; }
  if (phase === "store_fixture") {
    output.keychainAccessAttempted = false;
    output.wrapper = "synthetic AES-GCM fixture, not safeStorage";
    const key = randomBytes(32);
    const secretBox = {
      available: () => true,
      seal(plain) { const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]); },
      open(sealed) { const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString(); },
    };
    const options = { dir: join(root, "fixture-store"), secretBox };
    let store;
    try {
      store = await MemoryStore.open(options);
      let secondBlocked = false;
      try { const second = await MemoryStore.open(options); await second.close(); }
      catch (error) { secondBlocked = error.code === "locked"; }
      const op = newStoreOperation(0, "fictional fixture profile");
      const result = await store.commit(op, data => { data.profiles.push({ id: "fictional-probe", name: "Fictional Probe", createdAt: "2026-10-26T00:00:00Z" }); return "saved"; });
      await store.close();
      store = await MemoryStore.open(options);
      output.status = secondBlocked && result.status === "saved" && store.read().profiles[0]?.name === "Fictional Probe" && store.receipt(op.operationId).status === "saved" ? "packaged_fixture_store_passed" : "packaged_fixture_store_failed";
      await store.close();
    } catch { output.status = "packaged_fixture_store_failed"; }
    finally { await store?.close(); key.fill(0); }
    finish(output.status.endsWith("passed") ? 0 : 1); return;
  }
  output.keychainAccessAttempted = true;
  try {
    const box = createMemorySecretBox({ safeStorage, ready: () => app.isReady() });
    if (!box.available()) throw new Error("unavailable");
    const hash = value => createHash("sha256").update(value).digest("hex");
    if (phase === "write") {
      const plain = randomBytes(32).toString("base64");
      const sealed = box.seal(plain);
      writeFileSync(join(root, "synthetic-key.enc"), sealed, { mode: 0o600 });
      writeFileSync(join(root, "synthetic-key.sha256"), hash(plain), { mode: 0o600 });
      output.status = box.open(sealed) === plain ? "roundtrip_passed" : "roundtrip_failed";
    } else {
      const plain = box.open(readFileSync(join(root, "synthetic-key.enc")));
      output.status = hash(plain) === readFileSync(join(root, "synthetic-key.sha256"), "utf8") ? "restart_decrypt_passed" : "restart_decrypt_failed";
    }
    const store = await MemoryStore.open({ dir: join(root, "native-store"), secretBox: box });
    try {
      const canary = "MEM0_SYNTHETIC_NATIVE_STORE_CANARY";
      if (phase === "write") {
        const op = newStoreOperation(0, "synthetic native-store seed");
        const result = await store.commit(op, data => {
          data.profiles.push({ id: "fictional-native", name: "Fictional Native", createdAt: "2026-10-26T00:00:00Z", facePersonId: null, minor: false });
          data.facts = Array.from({ length: 1000 }, (_, i) => ({ id: "fact-" + i, profileId: "fictional-native", revision: 1, topic: "food", key: "fixture-" + i, kind: "preference", value: canary, audience: "household", source: { kind: "explicit", turnId: "synthetic-turn", at: "2026-10-26T00:00:00Z", excerpt: canary }, validFrom: "2026-10-26T00:00:00Z", expiresAt: null, reviewAfter: null, pinned: false }));
          return "saved";
        });
        if (result.status !== "saved") throw new Error("native store not saved");
        writeFileSync(join(root, "native-receipt-id.json"), JSON.stringify({ operationId: op.operationId }), { mode: 0o600 });
      }
      const receipt = JSON.parse(readFileSync(join(root, "native-receipt-id.json"), "utf8"));
      const snapshot = store.read();
      const noPlaintext = !readFileSync(join(root, "native-store", "store.v1.enc")).includes(Buffer.from(canary));
      const receiptStatus = store.receipt(receipt.operationId).status;
      if (snapshot.facts.length !== 1000 || snapshot.facts.some(fact => fact.value !== canary) || receiptStatus !== "saved" || !noPlaintext) throw new Error("native store validation failed");
      output.nativeStore = { facts: snapshot.facts.length, revision: snapshot.revision, receiptStatus, canaryAbsentFromCiphertext: noPlaintext };
    } finally { await store.close(); }
    finish(output.status.endsWith("passed") ? 0 : 1);
  } catch { output.status = "key_unavailable_or_roundtrip_failed"; finish(1); }
}).catch(() => { output.status = "startup_failed"; finish(1); });
`);

const [bundle] = await packager({
  dir: source, out: join(scratch, "packaged"), name: "NousMemoryProbe",
  appBundleId: "org.nous.mem0.probe", platform: "darwin", arch: process.arch,
  electronVersion: lockedVersion, asar: false, overwrite: false,
});
const appPath = join(bundle, "NousMemoryProbe.app");
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "pipe" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
const binary = join(appPath, "Contents", "MacOS", "NousMemoryProbe");
const report = { mode: roundtrip ? "explicit_keychain_roundtrip" : "capabilities_only", passed: false, phases: [] };
for (const phase of roundtrip ? ["capabilities", "store_fixture", "write", "read"] : ["capabilities", "store_fixture"]) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NOUS_MEMORY_PROBE_ROOT: scratch, NOUS_MEMORY_PROBE_PHASE: phase };
  const run = spawnSync(binary, [], { env, timeout: 30_000, encoding: "utf8" });
  let result;
  try { result = JSON.parse(readFileSync(join(scratch, phase + ".json"), "utf8")); }
  catch { result = { mode: phase, status: run.error?.code === "ETIMEDOUT" ? "timeout" : "missing_result" }; }
  report.phases.push(result);
  if (run.status !== 0) break;
}
report.passed = report.phases.length === (roundtrip ? 4 : 2)
  && report.phases.every(result => ["capabilities_only", "packaged_fixture_store_passed", "roundtrip_passed", "restart_decrypt_passed"].includes(result.status));
writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log("Evidence: " + join(scratch, "report.json"));
console.log(roundtrip ? "Only an isolated synthetic key was tested." : "No Keychain availability or encryption method was called. Run --roundtrip only when ready to approve the isolated probe's Keychain access.");
if (!report.passed) process.exitCode = 1;
