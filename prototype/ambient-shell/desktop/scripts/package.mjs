// 把 build/app 打包成 macOS 的 Nous.app，做本機（ad-hoc）簽章，並壓成 zip 方便放上 GitHub Release。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const outDir = join(desktop, "release");

rmSync(outDir, { recursive: true, force: true });
const [dir] = await packager({
  dir: join(desktop, "build", "app"),
  out: outDir,
  name: "Nous",
  executableName: "Nous",
  platform: "darwin",
  arch,
  appVersion: pkg.version,
  appBundleId: "com.pcpcchen.nous",
  appCategoryType: "public.app-category.productivity",
  appCopyright: "Nous prototype",
  icon: join(desktop, "assets", "Nous.icns"),
  asar: true,
  overwrite: true,
  extendInfo: {
    NSMicrophoneUsageDescription: "Nous 需要麥克風才能進行即時語音對話；只有在你按下「開始語音對話」後才會收音。",
    LSMinimumSystemVersion: "13.0",
    NSHumanReadableCopyright: "Nous prototype",
  },
});

const appPath = join(dir, "Nous.app");
// 沒有 Apple Developer 憑證時用 ad-hoc 簽章：本機可以執行，麥克風權限也能正常詢問。
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

const zip = join(outDir, `Nous-${pkg.version}-mac-${arch}.zip`);
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip], { stdio: "inherit" });
console.log(`App：${appPath}`);
console.log(`壓縮檔：${zip}`);
