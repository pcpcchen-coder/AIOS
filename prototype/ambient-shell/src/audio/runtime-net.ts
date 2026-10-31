// 喚醒 worker 唯一能連網的地方（WK-01b；tests/audio-privacy.test.ts 逐行釘住這個檔案的網路用法）。
// 只在載入引擎時使用：讀同源 /wake-runtime/ 下、shared/wake-runtime.json 列出的檔名，不帶憑證、不跟隨轉址。音訊樣本從來不經過這裡。
// 關閉分兩步（SherpaWasmDetector 的載入順序）：
//   1. lockGlobals()：所有檔案位元組讀完、雜湊核對過之後，**在 import() 任何第三方 module 之前**，把 worker 範圍的
//      LOCKED_GLOBALS（fetch、XMLHttpRequest、WebSocket、EventSource、WebTransport、importScripts、Worker、SharedWorker、caches）
//      換成一律丟錯、不可寫、不可重設的函式；之後 bytes() 一律拒絕。所以第三方 module 的頂層程式執行時已經不能用這些 API。
//   2. lockImports()：兩個 module 都 import 完之後；之後 module() 一律拒絕。
// 動態 import() 是語法、無法以指定覆蓋：只有 module() 用到，且只接受清單檔名。最後的邊界是 worker 的 CSP
// （server/app.ts scriptHeaders：script-src 與 connect-src 只允許 'self'，不允許 blob:）：即使有遺漏的 API，也只能連到同源。

export interface NetScope {
  fetch: (input: string, init?: { credentials?: "omit" | "same-origin"; redirect?: "error"; cache?: "no-store" }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  XMLHttpRequest?: unknown;
  WebSocket?: unknown;
  EventSource?: unknown;
  WebTransport?: unknown;
  importScripts?: unknown;
  Worker?: unknown;
  SharedWorker?: unknown;
  caches?: unknown;
  crypto: { subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
}

export interface WakeRuntimeNet {
  /** 讀清單上一個檔案的位元組（同源）；lockGlobals() 之後拒絕。 */
  bytes(name: string): Promise<Uint8Array>;
  /** 以 import() 載入清單上的 ES module（同一個同源路徑；呼叫端先以 bytes() 核對過雜湊，核心每次讀取也再核對）；lockImports() 之後拒絕。 */
  module(name: string): Promise<unknown>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** 覆蓋 worker 的網路全域並拒絕 bytes()。可重複呼叫。 */
  lockGlobals(): void;
  /** 拒絕 module()。可重複呼叫。 */
  lockImports(): void;
  /** 兩者都做（失敗或不載入時）。 */
  lock(): void;
  /** 兩者都已關閉。 */
  readonly locked: boolean;
}

export class NetworkLockedError extends Error {
  constructor() {
    super("wake worker network is locked");
  }
}

const blocked = (): never => {
  throw new NetworkLockedError();
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** lockGlobals() 覆蓋的全域名稱；tests/audio-privacy.test.ts 核對這份清單。 */
export const LOCKED_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker", "caches"] as const;

export function createRuntimeNet(
  scope: NetScope,
  prefix: string,
  names: readonly string[],
  importer: (path: string) => Promise<unknown> = (path) => import(/* @vite-ignore */ path),
): WakeRuntimeNet {
  if (prefix !== "/wake-runtime/") throw new Error("wake runtime prefix must be /wake-runtime/");
  const allowed = new Set(names.filter((n) => SAFE_NAME.test(n)));
  const load = scope.fetch.bind(scope);
  let globalsLocked = false;
  let importsLocked = false;
  const pathOf = (name: string, closed: boolean): string => {
    if (closed) throw new NetworkLockedError();
    if (!allowed.has(name)) throw new Error("not a listed wake runtime file");
    return `${prefix}${name}`;
  };
  const net: WakeRuntimeNet = {
    async bytes(name) {
      const res = await load(pathOf(name, globalsLocked), { credentials: "same-origin", redirect: "error", cache: "no-store" });
      if (!res.ok) throw new Error(`wake runtime HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async module(name) {
      return importer(pathOf(name, importsLocked));
    },
    async sha256(bytes) {
      const digest = new Uint8Array(await scope.crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    },
    lockGlobals() {
      if (globalsLocked) return;
      globalsLocked = true;
      // 定義成不可寫、不可重新設定，之後的程式（包括第三方 module 的頂層程式與 glue）也換不回來。
      for (const key of LOCKED_GLOBALS) Object.defineProperty(scope, key, { value: blocked, writable: false, configurable: false, enumerable: false });
    },
    lockImports() {
      importsLocked = true;
    },
    lock() {
      net.lockGlobals();
      net.lockImports();
    },
    get locked() {
      return globalsLocked && importsLocked;
    },
  };
  return net;
}
