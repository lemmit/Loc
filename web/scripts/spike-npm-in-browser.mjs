// THROWAWAY SPIKE (Phase B1).  Not wired into the app, not shipped.
//
// Thesis under test: the esm.sh `extractUsedTable` failure is an
// esm.sh re-build artefact, and the *real published npm tarball* of
// drizzle-orm exposes that symbol consistently — so an install+bundle
// engine that resolves against real node_modules sidesteps the whole
// esm.sh-split-shard bug class.
//
// Steps (the npm-in-browser pipeline, minus the browser libs):
//   1. registry client    GET registry.npmjs.org/<pkg>/<version>
//   2. tarball fetch       GET dist.tarball
//   3. extract             gunzip + minimal tar walk → in-memory files
//   4. verify              the real pg-core/utils module exports
//                          `extractUsedTable`
//
// Node's zlib is used for gunzip (browser swap = pako, decided in B3);
// the tar walk is hand-rolled so the spike has zero deps.  PASS means
// the approach is sound and B2/B3 are worth building.

import { gunzipSync } from "node:zlib";

const PKG = "drizzle-orm";
const VERSION = "0.45.2"; // the exact version esm.sh breaks on today

const log = (...a) => console.log(...a);

// --- 1. registry client --------------------------------------------------
log(`# 1/4 registry: registry.npmjs.org/${PKG}/${VERSION}`);
const meta = await fetch(`https://registry.npmjs.org/${PKG}/${VERSION}`).then(
  (r) => {
    if (!r.ok) throw new Error(`registry ${r.status}`);
    return r.json();
  },
);
const tarballUrl = meta?.dist?.tarball;
if (!tarballUrl) throw new Error("no dist.tarball in packument");
log(`  resolved tarball: ${tarballUrl}`);
log(
  `  declared deps: ${Object.keys(meta.dependencies ?? {}).length}, ` +
    `peerDeps: ${Object.keys(meta.peerDependencies ?? {}).length}`,
);

// --- 2. tarball fetch ----------------------------------------------------
log(`# 2/4 fetch tarball`);
const tgz = new Uint8Array(
  await fetch(tarballUrl).then((r) => {
    if (!r.ok) throw new Error(`tarball ${r.status}`);
    return r.arrayBuffer();
  }),
);
log(`  ${(tgz.byteLength / 1024).toFixed(0)} KB gzipped`);

// --- 3. extract (gunzip + minimal ustar walk) ----------------------------
log(`# 3/4 extract`);
const tar = gunzipSync(tgz);
/** @type {Map<string,Uint8Array>} */
const files = new Map();
const dec = new TextDecoder();
for (let off = 0; off + 512 <= tar.length; ) {
  const block = tar.subarray(off, off + 512);
  // End of archive: two consecutive zero blocks.
  if (block.every((b) => b === 0)) break;
  const name = dec.decode(block.subarray(0, 100)).replace(/\0.*$/, "");
  const size = parseInt(dec.decode(block.subarray(124, 136)).trim(), 8) || 0;
  const type = String.fromCharCode(block[156]);
  const dataOff = off + 512;
  if (type === "0" || type === "") {
    files.set(
      name.replace(/^package\//, ""),
      tar.subarray(dataOff, dataOff + size),
    );
  }
  off = dataOff + Math.ceil(size / 512) * 512;
}
log(`  ${files.size} files extracted`);

// --- 4. verify the symbol esm.sh drops -----------------------------------
log(`# 4/4 verify extractUsedTable is a real published export`);
const candidates = [...files.keys()].filter(
  (p) => /pg-core\/utils\.(js|mjs|cjs|d\.ts)$/.test(p) || /pg-core\/utils\//.test(p),
);
let found = false;
for (const p of candidates) {
  const src = dec.decode(files.get(p));
  if (/extractUsedTable/.test(src)) {
    const exported =
      /export\s+(function|const|\{[^}]*extractUsedTable)/.test(src) ||
      /exports\.extractUsedTable/.test(src) ||
      /\bextractUsedTable\b/.test(src);
    log(`  ${p}: contains extractUsedTable=${/extractUsedTable/.test(src)} exported=${exported}`);
    if (exported) found = true;
  }
}
// Also scan the whole package for the definition site, regardless of path.
if (!found) {
  for (const [p, buf] of files) {
    if (!/\.(js|mjs|cjs)$/.test(p)) continue;
    const src = dec.decode(buf);
    if (/(export[^;]*extractUsedTable|exports\.extractUsedTable\s*=|function extractUsedTable)/.test(src)) {
      log(`  definition/export found in ${p}`);
      found = true;
      break;
    }
  }
}

log("");
log(
  found
    ? "PASS — the real npm tarball exposes extractUsedTable. esm.sh drops it in its re-build; install+bundle against real node_modules fixes the whole class. B2/B3 are worth building."
    : "FAIL — symbol not found in the real tarball either; rethink the thesis before investing in B2/B3.",
);
process.exit(found ? 0 : 1);
