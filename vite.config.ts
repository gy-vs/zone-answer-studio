import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时服务端以 middleware 模式挂载 Vite（见 server/main.ts），
// 前端构建产物在生产模式下由同一服务直接托管。
export default defineConfig({
  root: ".",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: false,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
