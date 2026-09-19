import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from any sub-path (e.g. GitHub Pages).
  base: "./",
  server: {
    host: true,
    port: 5173,
    // Clip-rendering service (server/app.py) during development.
    proxy: { "/api": { target: process.env.FACE3D_API ?? "http://localhost:8000", changeOrigin: true } },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
