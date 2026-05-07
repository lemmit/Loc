import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The web app imports the Loom toolchain straight from `../src` — the
// language services, IR lowering, and generators are pure TS with no
// Node-only APIs (the only Node seams are in `src/cli/` and
// `src/language/main.ts`, neither of which we import).  Vite's bundler
// handles the `.js`-extension import specifiers used throughout `src/`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@loom": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // Monaco ships ESM that Vite scans fine; pre-bundle it to avoid a
    // long cold start on first edit.
    include: ["monaco-editor"],
  },
});
