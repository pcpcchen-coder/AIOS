import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";
import { pageHeaders } from "./server/page-headers.ts";

// 開發時：vite（5173）把 /api 轉給本機核心（8787）。正式啟動用 npm start，由核心直接提供建置後的頁面。
// dev／preview 與核心共用頁面標頭；不知道核心的鏡頭設定，一律用鏡頭啟用時的版本，讓鏡頭管線能載入 wasm。
// HMR 的 websocket 是同源，connect-src 'self' 已允許。dev 由 Vite 以 <style> 注入 CSS，只在 dev 放寬 style-src。
// dev 伺服器對所有回應（含 worker 腳本）都送這組標頭，所以家人辨識的 worker 在 dev 也受 connect-src 'self' 限制。
// onnxruntime-web 用「外部 wasm」版本（onnxruntime-web-use-extern-wasm 條件）：家人辨識的 wasm 與模型只由
// npm run face:setup -- --product 安裝、由核心從 /face-runtime/ 提供，不打包進 dist（也就不進 release zip）。
const page = pageHeaders(true);
const csp = page["Content-Security-Policy"];
const dev = { ...page, "Content-Security-Policy": csp.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';") };

export default defineConfig({
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions] },
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // /face-runtime/ 也轉給核心：模型與 wasm 只由核心核對雜湊後提供。
    proxy: { "/api": { target: "http://127.0.0.1:8787" }, "/face-runtime": { target: "http://127.0.0.1:8787" } },
    headers: dev,
  },
  preview: { headers: page },
  // 兩個頁面：主畫面（index.html）與成果紀錄的獨立網頁（history.html，核心以 /history 提供；只在使用者自己打開時出現）。
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        history: fileURLToPath(new URL("./history.html", import.meta.url)),
      },
    },
  },
});
