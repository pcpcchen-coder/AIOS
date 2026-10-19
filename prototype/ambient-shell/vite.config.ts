import { defineConfig } from "vite";

// 開發時：vite（5173）把 /api 轉給本機核心（8787）。正式啟動用 npm start，由核心直接提供建置後的頁面。
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787" } },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
