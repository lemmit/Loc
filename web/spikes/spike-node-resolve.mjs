// THROWAWAY SPIKE (Phase B2).  Run with tsx.  Not wired into the app.
//
// Proves the exports-aware resolver (src/engine/node-resolve.ts)
// resolves the package that breaks esm.sh — drizzle-orm — to its
// REAL published files: bare ".", "./pg-core", "./pglite" via the
// 443-key exports map, and that the resolved pg-core entry reaches
// the real utils module B1 proved exports `extractUsedTable`.

import { gunzipSync } from "node:zlib";
import { resolveBare } from "../src/engine/node-resolve.ts";

const log = (...a) => console.log(...a);

// --- fetch + extract (same as B1) → Map under /node_modules/... -----------
const meta = await fetch("https://registry.npmjs.org/drizzle-orm/0.45.2").then(
  (r) => r.json(),
);
const tgz = new Uint8Array(
  await fetch(meta.dist.tarball).then((r) => r.arrayBuffer()),
);
const tar = gunzipSync(tgz);
const dec = new TextDecoder();
/** @type {Map<string,Uint8Array>} */
const files = new Map();
for (let off = 0; off + 512 <= tar.length; ) {
  const block = tar.subarray(off, off + 512);
  if (block.every((b) => b === 0)) break;
  const name = dec.decode(block.subarray(0, 100)).replace(/\0.*$/, "");
  const size = parseInt(dec.decode(block.subarray(124, 136)).trim(), 8) || 0;
  const type = String.fromCharCode(block[156]);
  const dataOff = off + 512;
  if (type === "0" || type === "") {
    files.set(
      "/node_modules/drizzle-orm/" + name.replace(/^package\//, ""),
      tar.subarray(dataOff, dataOff + size),
    );
  }
  off = dataOff + Math.ceil(size / 512) * 512;
}
log(`extracted ${files.size} files under /node_modules/drizzle-orm/`);

const src = {
  read: (p) => (files.has(p) ? dec.decode(files.get(p)) : undefined),
  exists: (p) => files.has(p),
};

// --- resolve via the exports map -----------------------------------------
const cases = ["drizzle-orm", "drizzle-orm/pg-core", "drizzle-orm/pglite"];
let ok = true;
const resolved = {};
for (const spec of cases) {
  const r = resolveBare(spec, src);
  resolved[spec] = r;
  const good = r != null && files.has(r);
  log(`  ${spec.padEnd(22)} → ${r ?? "NULL"}  ${good ? "OK" : "FAIL"}`);
  if (!good) ok = false;
}

// --- the headline: pg-core entry reaches the real utils export -----------
const pgCore = resolved["drizzle-orm/pg-core"];
let reachesUtils = false;
if (pgCore) {
  const dir = pgCore.slice(0, pgCore.lastIndexOf("/"));
  // pg-core/index.js re-exports its submodules; probe the real utils
  // file the way a relative import would resolve.
  for (const cand of ["utils.js", "utils.mjs", "utils.cjs"]) {
    const p = `${dir}/${cand}`;
    if (files.has(p) && /extractUsedTable/.test(dec.decode(files.get(p)))) {
      log(`  pg-core → ${p} contains extractUsedTable  OK`);
      reachesUtils = true;
      break;
    }
  }
}
if (!reachesUtils) ok = false;

log("");
log(
  ok
    ? "PASS — exports-aware resolver lands drizzle-orm on its real published files (incl. the utils module esm.sh drops). B2 sound; B3 (assemble the engine) is unblocked."
    : "FAIL — resolver did not reach the real files; fix node-resolve.ts before B3.",
);
process.exit(ok ? 0 : 1);
