import { defineConfig } from "vite";
import { pageHeaders } from "./server/page-headers.ts";

// 開發時：vite（5173）把 /api 轉給本機核心（8787）。正式啟動用 npm start，由核心直接提供建置後的頁面。
// dev／preview 與核心共用頁面標頭；不知道核心的鏡頭設定，一律用鏡頭啟用時的版本，讓鏡頭管線能載入 wasm。
// HMR 的 websocket 是同源，connect-src 'self' 已允許。dev 由 Vite 以 <style> 注入 CSS，只在 dev 放寬 style-src。
const page = pageHeaders(true);
const csp = page["Content-Security-Policy"];
const dev = { ...page, "Content-Security-Policy": csp.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';") };

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787" } },
    headers: dev,
  },
  preview: { headers: page },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
