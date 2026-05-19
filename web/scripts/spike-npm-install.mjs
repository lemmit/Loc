// THROWAWAY SPIKE (Phase B3).  Run with tsx.  Not wired into the app.
//
// Highest-uncertainty check: does the WHOLE real generated
// Sales-System backend dependency set fetch + extract + resolve with
// browser-compatible code (DecompressionStream gzip, the flat
// planner, exports-aware resolver)?  If the key bare imports the
// generated Hono backend uses all land on real files, the
// install+resolve core is sound and B3b (esbuild VFS plugin) +
// B3c (engine class + cache) are de-risked.

import { install } from "../src/engine/npm/install.ts";
import { resolveBare } from "../src/engine/node-resolve.ts";

const log = (...a) => console.log(...a);

// The generator's BACKEND_PINS.dependencies + the runtime-layer
// PGlite pin (src/generator/typescript/index.ts + plugin.ts).
const rootDeps = {
  hono: "^4.12.0",
  "@hono/node-server": "^1.14.0",
  "@hono/zod-openapi": "^0.19.0",
  zod: "^3.24.0",
  "drizzle-orm": "^0.45.0",
  pg: "^8.13.0",
  "@electric-sql/pglite": "0.4.5",
};

/** @type {Map<string,Uint8Array>} */
const files = new Map();
log("# installing the real generated backend dep set…");
const t0 = Date.now();
const res = await install(rootDeps, (p, d) => files.set(p, d));
log(
  `  ${res.versions.size} packages, ${res.fileCount} files, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
for (const [n, v] of [...res.versions].sort()) log(`    ${n}@${v}`);

const dec = new TextDecoder();
const src = {
  read: (p) => (files.has(p) ? dec.decode(files.get(p)) : undefined),
  exists: (p) => files.has(p),
};

// The bare specifiers the generated Hono backend + the bundle entry
// stdin actually import.
const specs = [
  "hono",
  "hono/cors",
  "@hono/zod-openapi",
  "zod",
  "drizzle-orm",
  "drizzle-orm/pg-core",
  "drizzle-orm/pglite",
  "@electric-sql/pglite",
];
let ok = true;
log("# resolve the backend's imports against installed node_modules:");
for (const s of specs) {
  const r = resolveBare(s, src);
  const good = r != null && files.has(r);
  log(`  ${s.padEnd(24)} → ${r ?? "NULL"}  ${good ? "OK" : "FAIL"}`);
  if (!good) ok = false;
}

log("");
log(
  ok
    ? "PASS — full real backend stack installs + resolves with browser-safe code. B3 core sound; B3b/B3c unblocked."
    : "FAIL — some import did not resolve; fix install/resolve before B3b.",
);
process.exit(ok ? 0 : 1);
