import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomic } from "../server/fs-atomic.ts";
import { writePairing, type LgtvPairing } from "../server/lgtv/store.ts";
import { memoryEnabledHint } from "../server/nous.ts";
import { ProactiveDailyLog } from "../server/proactive.ts";
import { ProviderManager, type ProviderManagerOptions } from "../server/providers.ts";
import { VOICE_COST_FILE, VOICE_COST_KEEP, VoiceCostLog } from "../server/voice-cost-log.ts";
import type { VoiceCostRecord } from "../shared/voice-cost.ts";

// S4（docs/23 §3）：server/fs-atomic.ts 的 writeAtomic，以及五個改用它的呼叫者寫出的檔與搬之前逐位元組相同。
// 「搬之前」的寫法照 3cc1401 的原始碼抄在下面的 legacy 物件裡，只當比對基準，不是產品程式。
// 全部在暫存資料夾裡做；Windows 沒有 POSIX 權限，權限的斷言在那裡略過。

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-fs-atomic-"));
  dirs.push(dir);
  return dir;
}
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("writeAtomic", () => {
  it("writes a string as UTF-8 bytes exactly, without adding a newline", () => {
    const file = join(temp(), "a.json");
    writeAtomic(file, '{"名稱":"電視"}');
    expect(readFileSync(file).equals(Buffer.from('{"名稱":"電視"}', "utf8"))).toBe(true);
  });

  it("writes a Uint8Array exactly", () => {
    const file = join(temp(), "a.bin");
    const bytes = Uint8Array.from([0, 255, 10, 13, 0, 128]);
    writeAtomic(file, bytes);
    expect([...readFileSync(file)]).toEqual([...bytes]);
  });

  it("replaces an existing file and leaves no temp file behind", () => {
    const dir = temp();
    const file = join(dir, "a.json");
    writeFileSync(file, "old");
    writeAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it.skipIf(!posix)("creates the file with the requested mode", () => {
    const file = join(temp(), "a.json");
    writeAtomic(file, "x", { mode: 0o600 });
    expect(modeOf(file)).toBe(0o600);
  });

  it.skipIf(!posix)("without a mode the file follows the process umask, like writeFileSync", () => {
    const dir = temp();
    writeFileSync(join(dir, "plain"), "x");
    writeAtomic(join(dir, "a.json"), "x");
    expect(modeOf(join(dir, "a.json"))).toBe(modeOf(join(dir, "plain")));
  });

  it.skipIf(!posix)("a stale temp file keeps its mode unless chmodTemp is set", () => {
    const dir = temp();
    // 上次寫到一半留下的暫存檔是 0644：只給 mode 不會改它（writeFileSync 的 mode 只在建立時有效）。
    writeFileSync(join(dir, "a.json.tmp"), "stale", { mode: 0o644 });
    chmodSync(join(dir, "a.json.tmp"), 0o644);
    writeAtomic(join(dir, "a.json"), "x", { mode: 0o600 });
    expect(modeOf(join(dir, "a.json"))).toBe(0o644);

    writeFileSync(join(dir, "b.json.tmp"), "stale", { mode: 0o644 });
    chmodSync(join(dir, "b.json.tmp"), 0o644);
    writeAtomic(join(dir, "b.json"), "x", { mode: 0o600, chmodTemp: true });
    expect(modeOf(join(dir, "b.json"))).toBe(0o600);
  });

  it("does not create the parent directory unless asked", () => {
    const dir = temp();
    const file = join(dir, "missing", "a.json");
    expect(() => writeAtomic(file, "x")).toThrow(/ENOENT/);
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it("mkdir creates missing parents recursively; a number sets their mode", () => {
    const dir = temp();
    writeAtomic(join(dir, "a", "b", "one.json"), "1", { mkdir: true });
    expect(readFileSync(join(dir, "a", "b", "one.json"), "utf8")).toBe("1");
    writeAtomic(join(dir, "c", "two.json"), "2", { mkdir: 0o700 });
    expect(readFileSync(join(dir, "c", "two.json"), "utf8")).toBe("2");
    if (posix) expect(modeOf(join(dir, "c"))).toBe(0o700);
    // 已經在的資料夾不改權限。
    if (posix) {
      chmodSync(join(dir, "a"), 0o755);
      writeAtomic(join(dir, "a", "three.json"), "3", { mkdir: 0o700 });
      expect(modeOf(join(dir, "a"))).toBe(0o755);
    }
  });

  it("uses the given temp suffix", () => {
    const dir = temp();
    // 預設的 a.json.tmp 被一個資料夾佔住；換字尾就不會撞到它。
    mkdirSync(join(dir, "a.json.tmp"));
    expect(() => writeAtomic(join(dir, "a.json"), "x")).toThrow();
    writeAtomic(join(dir, "a.json"), "x", { tempSuffix: ".42.tmp" });
    expect(readdirSync(dir).sort()).toEqual(["a.json", "a.json.tmp"]);
  });

  it("when the rename fails it throws and leaves the temp file, unless removeTempOnError is set", () => {
    const dir = temp();
    // 目標被一個非空資料夾佔住：rename 失敗。
    mkdirSync(join(dir, "a.json", "x"), { recursive: true });
    expect(() => writeAtomic(join(dir, "a.json"), "kept")).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["a.json", "a.json.tmp"]);
    expect(readFileSync(join(dir, "a.json.tmp"), "utf8")).toBe("kept");

    expect(() => writeAtomic(join(dir, "a.json"), "gone", { removeTempOnError: true })).toThrow();
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("when the parent is a regular file it throws the original error and writes nothing", () => {
    const dir = temp();
    writeFileSync(join(dir, "blocker"), "file");
    const file = join(dir, "blocker", "a.json");
    expect(() => writeAtomic(file, "x")).toThrow(/ENOTDIR/);
    expect(() => writeAtomic(file, "x", { removeTempOnError: true })).toThrow(/ENOTDIR/);
    expect(() => writeAtomic(file, "x", { mkdir: 0o700 })).toThrow(/EEXIST|ENOTDIR/);
    expect(readdirSync(dir)).toEqual(["blocker"]);
    expect(readFileSync(join(dir, "blocker"), "utf8")).toBe("file");
  });
});

// ---- 搬之前的寫法（3cc1401 逐字抄下，只把 this.file／this.path 換成參數）----
const legacy = {
  // server/providers.ts:172-176 writeJson
  providers(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  },
  // server/proactive.ts:100-118 ProactiveDailyLog.mark 的寫檔段（失敗只記 log，這裡略去 log）
  proactive(dir: string, path: string, today: string, keys: string[]): void {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ schema_version: 1, date: today, keys: [...keys] }), { mode: 0o600 });
        renameSync(tmp, path);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows 不支援 POSIX 權限
      }
    } catch {
      // 原本在這裡記 log
    }
  },
  // server/voice-cost-log.ts:26-28、47-58、73-80：record() → lines() → write()（失敗只記 log，這裡略去 log）
  voiceCost(file: string, record: VoiceCostRecord): void {
    let all: string[] = [];
    if (existsSync(file)) {
      try {
        all = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
      } catch {
        all = [];
      }
    }
    all.push(JSON.stringify(record));
    try {
      const lines = all.slice(-VOICE_COST_KEEP);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch {
      // 原本在這裡記 log
    }
  },
  // server/lgtv/store.ts:39-46 writePairing
  lgtv(file: string, pairing: LgtvPairing): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pairing, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  },
  // server/nous.ts:684-688 memoryEnabledHint().set
  memoryEnabled(file: string, enabled: boolean): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  },
};

/** 一個資料夾的可觀察結果：資料夾權限、每個檔名的位元組（hex）與權限。 */
function snapshot(dir: string): unknown {
  return {
    dirMode: posix ? modeOf(dir) : null,
    files: readdirSync(dir).sort().map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? { name, dir: true } : { name, hex: readFileSync(path).toString("hex"), mode: posix ? modeOf(path) : null };
    }),
  };
}

function costRecord(n: number): VoiceCostRecord {
  return {
    v: 1, session_id: `rt_${n}`, route: "api_key", model: "gpt-realtime", source: "wake_word", wake_id: "int_0000000000000001",
    started_at: new Date(n * 1000).toISOString(), ended_at: new Date(n * 1000 + 500).toISOString(),
    connected: true, connected_ms: 500, end_reason: "ended", no_voice_auto_end: false, usage: "unknown", cost: "unknown",
  };
}

function manager(dir: string): ProviderManager {
  // 只走 select("mock")：不會碰到任何引擎或登入，其餘欄位用不到。
  return new ProviderManager({ claude: null, chatgpt: {}, mock: {}, auth: { usable: false }, dir, preferred: null, onChange() {} } as unknown as ProviderManagerOptions);
}

const pairing: LgtvPairing = { version: 1, host: "192.0.2.10", client_key: "fixture-key-客廳", macs: ["AA:BB:CC:DD:EE:01"], paired_at: "2026-11-10T00:00:00.000Z" };

describe("migrated callers produce the same files as before S4", () => {
  // 每個案例：old 在一個新資料夾用舊寫法寫，now 在另一個新資料夾走現在的呼叫者；兩邊的 snapshot 要完全相同。
  // sub 是資料夾底下還不存在的子路徑，用來比「上層不在時」的行為（建不建、建成什麼權限）。
  const cases: { name: string; sub: string[]; old(dir: string): void; now(dir: string): void }[] = [
    { name: "providers.ts settings.json", sub: [], old: (d) => legacy.providers(join(d, "settings.json"), { provider: "mock" }), now: (d) => manager(d).select("mock") },
    {
      name: "proactive.ts proactive-log.json", sub: ["cfg"],
      old: (d) => legacy.proactive(d, join(d, "proactive-log.json"), "2026-11-10", ["weather", "行事曆"]),
      now: (d) => new ProactiveDailyLog({ dir: d }).mark("2026-11-10", ["weather", "行事曆"]),
    },
    {
      name: "voice-cost-log.ts voice-cost.jsonl", sub: ["cfg"],
      old: (d) => { legacy.voiceCost(join(d, VOICE_COST_FILE), costRecord(1)); legacy.voiceCost(join(d, VOICE_COST_FILE), costRecord(2)); },
      now: (d) => { const log = new VoiceCostLog({ dir: d }); log.record(costRecord(1)); log.record(costRecord(2)); },
    },
    { name: "lgtv/store.ts lgtv.json", sub: ["cfg"], old: (d) => legacy.lgtv(join(d, "lgtv.json"), pairing), now: (d) => writePairing(join(d, "lgtv.json"), pairing) },
    {
      name: "nous.ts memory-enabled.json", sub: ["cfg"],
      old: (d) => legacy.memoryEnabled(join(d, "memory-enabled.json"), true),
      now: (d) => memoryEnabledHint(join(d, "memory-enabled.json")).set(true),
    },
  ];

  it.each(cases)("$name: same bytes, file mode, directory mode and leftovers", ({ sub, old, now }) => {
    const a = join(temp(), ...sub);
    const b = join(temp(), ...sub);
    old(a);
    now(b);
    expect(snapshot(b)).toEqual(snapshot(a));
    expect((snapshot(b) as { files: unknown[] }).files).toHaveLength(1);
  });

  it.each(cases)("$name: same result when the target is blocked by a directory", ({ old, now }) => {
    // 目標檔名被非空資料夾佔住：rename 失敗。比丟不丟錯，以及暫存檔留不留。
    const [a, b] = [temp(), temp()];
    const block = (dir: string, run: (dir: string) => void): { threw: boolean; left: unknown } => {
      run(dir);
      const name = readdirSync(dir)[0]!;
      rmSync(join(dir, name));
      mkdirSync(join(dir, name, "x"), { recursive: true });
      let threw = false;
      try { run(dir); } catch { threw = true; }
      return { threw, left: snapshot(dir) };
    };
    expect(block(b, now)).toEqual(block(a, old));
  });
});
