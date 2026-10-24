import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// ID-00 人臉 spike 的獨立 Vite 設定：只在 127.0.0.1 提供，不是主程式的第二個 entry，主程式 build 不會包含它。
// COOP／COEP 讓頁面 crossOriginIsolated，onnxruntime-web 才能使用多執行緒 wasm；鏡頭與模型都只在本機。
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  server: { host: "127.0.0.1", port: 5180, strictPort: true, headers: isolation },
  preview: { host: "127.0.0.1", port: 5181, strictPort: true, headers: isolation },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
