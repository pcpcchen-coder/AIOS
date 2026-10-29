import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// WK-00 喚醒詞 spike 頁的獨立 Vite 設定：只在 127.0.0.1 提供，不是主程式的 entry，主程式 build 不會包含它。
// public/kws-wasm/ 放使用者自建的 sherpa-onnx KWS wasm（npm 套件只有 Node 版，見驗證文件）；不進 git。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  server: { host: "127.0.0.1", port: 5182, strictPort: true },
  preview: { host: "127.0.0.1", port: 5183, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
