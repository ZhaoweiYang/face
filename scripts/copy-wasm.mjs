// Copies the MediaPipe WASM runtime from node_modules into public/ so the app
// is fully self-hosted (no CDN dependency at runtime).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dst = join(root, "public", "mediapipe", "wasm");

if (!existsSync(src)) {
  console.warn("[copy-wasm] @mediapipe/tasks-vision wasm directory not found, skipping");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`[copy-wasm] copied ${src} -> ${dst}`);
