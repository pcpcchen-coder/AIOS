import { defaultClientConditions, defineConfig } from "vite";

// 開發時：vite（5173）把 /api 轉給本機核心（8787）。正式啟動用 npm start，由核心直接提供建置後的頁面。
// onnxruntime-web 用「外部 wasm」版本（onnxruntime-web-use-extern-wasm 條件）：家人辨識的 wasm 與模型只由
// npm run face:setup -- --product 安裝、由核心從 /face-runtime/ 提供，不打包進 dist（也就不進 release zip）。
export default defineConfig({
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions] },
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // /face-runtime/ 也轉給核心：模型與 wasm 只由核心核對雜湊後提供（開發伺服器沒有 CSP，正式頁面以核心為準）。
    proxy: { "/api": { target: "http://127.0.0.1:8787" }, "/face-runtime": { target: "http://127.0.0.1:8787" } },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
