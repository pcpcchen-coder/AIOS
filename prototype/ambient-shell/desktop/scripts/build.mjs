// 組出 App 內容（build/app）：Electron 主程式、打包成單檔的本機核心、前端、圖示與設定範本。
// 不會放入 .env、data/ 或任何登入憑證。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = join(desktop, "..");
const out = join(desktop, "build", "app");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 前端：和終端機版同一份 vite 建置。
execFileSync("npx", ["vite", "build", "--outDir", join(out, "web"), "--emptyOutDir"], { cwd: shell, stdio: "inherit" });

// 本機核心：打包成一個 ESM 檔，由 Electron 內建的 Node 執行。
await build({
  entryPoints: [join(shell, "server", "nous.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // 部分相依套件是 CommonJS，需要 require。
  banner: { js: "import { createRequire as __nousRequire } from 'node:module'; const require = __nousRequire(import.meta.url);" },
  logLevel: "warning",
});

cpSync(join(desktop, "main.mjs"), join(out, "main.mjs"));
cpSync(join(desktop, "settings-menu.mjs"), join(out, "settings-menu.mjs"));
cpSync(join(desktop, "preload.cjs"), join(out, "preload.cjs"));
cpSync(join(desktop, "assets"), join(out, "assets"), { recursive: true, filter: (p) => !p.includes(".iconset") });
cpSync(join(shell, ".env.example"), join(out, "env.example"));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "nous", productName: "Nous", version: pkg.version, type: "module", main: "main.mjs" }, null, 2),
);
console.log(`App 內容已組好：${out}`);
