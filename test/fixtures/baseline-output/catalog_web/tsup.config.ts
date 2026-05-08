// Auto-generated.  tsup bundles index.ts → dist/index.js for
// production.  Externals match runtime deps from package.json so
// pg's native bindings + drizzle's heavy modules stay outside the
// bundle (loaded from node_modules at runtime).
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  // `tsc --noEmit` (npm run typecheck) is the type-check; tsup is
  // build-only, no .d.ts emit needed.
  dts: false,
});
