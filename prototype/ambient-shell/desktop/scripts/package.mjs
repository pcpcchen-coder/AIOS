// 把 build/app 打包成 macOS 的 Nous.app，簽章（有固定憑證就用它，否則 ad-hoc），並壓成 zip 方便放上 GitHub Release。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const outDir = join(desktop, "release");
const LOCAL_IDENTITY = "Nous Local Signing";

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
  extraResource: [join(desktop, "assets", "en.lproj"), join(desktop, "assets", "zh-Hant.lproj")],
  extendInfo: {
    CFBundleDevelopmentRegion: "en",
    CFBundleLocalizations: ["en", "zh-Hant"],
    NSMicrophoneUsageDescription: "Nous uses the microphone for voice conversations after you enable voice interaction. Audio is sent to your selected voice service. End the conversation to stop capture.",
    NSCameraUsageDescription: "Nous uses the camera for presence, head direction, gestures, nominal distance, and optional family recognition. Images are processed only on this Mac, without saving or upload.",
    LSMinimumSystemVersion: "13.0",
    NSHumanReadableCopyright: "Nous prototype",
  },
});

const appPath = join(dir, "Nous.app");
const identity = signingIdentity();
console.log(identity === "-"
  ? "簽章：ad-hoc（每次打包簽章都不同，macOS 會重新詢問鏡頭與麥克風權限；見 README「固定簽章」）"
  : `簽章：${identity}（固定身分，更新後保留鏡頭與麥克風權限）`);
execFileSync("codesign", ["--force", "--deep", "--sign", identity, appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

const zip = join(outDir, `Nous-${pkg.version}-mac-${arch}.zip`);
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip], { stdio: "inherit" });
console.log(`App：${appPath}`);
console.log(`壓縮檔：${zip}`);

/**
 * 選簽章身分。ad-hoc 簽章的「指定要求」是這次打包的 cdhash，每次打包都不同，
 * macOS 會把更新後的 App 當成新 App，重新詢問鏡頭與麥克風（等待期間鏡頭停在「啟動中」）。
 * 有固定的程式碼簽署憑證時改用它：NOUS_SIGN_IDENTITY 指定，或鑰匙圈裡名為「Nous Local Signing」的自簽憑證。
 */
function signingIdentity() {
  if (process.env.NOUS_SIGN_IDENTITY) return process.env.NOUS_SIGN_IDENTITY;
  let identities = "";
  try {
    // 不加 -v：自簽憑證未被系統信任，但仍可用來簽本機 App。
    identities = execFileSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
  } catch {
    return "-";
  }
  return identities.includes(`"${LOCAL_IDENTITY}"`) ? LOCAL_IDENTITY : "-";
}
