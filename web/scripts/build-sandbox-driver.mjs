// Bundle the sandbox-side UI test driver (src/sandbox/driver.ts → its
// serveDriverOps + DomPage/executeDriverOp deps) into a stably-named
// module the preview stub loads at <sandbox-origin>/sandbox/driver.js.
//
// Mirrors scripts/build-vendor.mjs: a native-esbuild prebuild that emits
// into web/public/ (copied verbatim into the build by Vite).  Code
// splitting is on so the entry stays `driver.js` (no content hash) while
// the lazy `import("./screenshot.js")` (→ html-to-image, for test-proof
// screenshots) rides in a sibling chunk loaded on demand.

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/sandbox/driver.ts");
const outDir = path.resolve(here, "../public/sandbox");

mkdirSync(outDir, { recursive: true });
// Clear stale chunks from a previous build (the entry name is stable, but
// the lazy chunk hash changes).
for (const f of ["driver.js"]) {
  rmSync(path.join(outDir, f), { force: true });
}

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outdir: outDir,
  entryNames: "[name]",
  chunkNames: "driver-[hash]",
  logLevel: "info",
});

console.log("# sandbox driver bundled → web/public/sandbox/driver.js");
