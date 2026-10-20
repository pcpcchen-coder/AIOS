import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startNous } from "./nous.ts";

// 終端機版（npm start）：.env、data/ 與 dist/ 都在原型資料夾裡。
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await startNous({
  envFile: join(root, ".env"),
  dataDir: join(root, "data"),
  distDir: join(root, "dist"),
});
