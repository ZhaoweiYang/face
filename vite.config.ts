import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from any sub-path (e.g. GitHub Pages).
  base: "./",
  server: { host: true, port: 5173 },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
