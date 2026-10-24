import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: { outDir: "../dist", emptyOutDir: true, target: "es2020" },
});
