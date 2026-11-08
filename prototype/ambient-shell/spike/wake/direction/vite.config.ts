import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { contentTypeFor, runtimeFileFor } from "./serve.ts";

// 喚醒方向性診斷頁（docs/validation/wake-direction-2026-11-08.md）的獨立 Vite 設定：只在 127.0.0.1:5184，
// 不是主程式的 entry，主程式 build 不會包含它。/wake-runtime/ 只給清單上的檔名，來源是 npm run wake:setup -- --product
// 裝在 prototype/ambient-shell/wake-runtime/ 的檔案（gitignored）；沒裝時 404，頁面照實顯示「引擎檔案不在」。
const runtimeDir = fileURLToPath(new URL("../../../wake-runtime/", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  worker: { format: "es" },
  server: { host: "127.0.0.1", port: 5184, strictPort: true },
  plugins: [
    {
      name: "nous-wake-runtime",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/wake-runtime/")) return next();
          const file = runtimeFileFor(req.url, runtimeDir);
          if (!file || !existsSync(file)) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader("Content-Type", contentTypeFor(file));
          res.setHeader("Cache-Control", "no-store");
          createReadStream(file).pipe(res);
        });
      },
    },
  ],
});
