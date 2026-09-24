import { defineConfig } from "vite";

// 开发时把 /api 代理到 Rust 后端；构建产物可由后端的 --dist 托管
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
