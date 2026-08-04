// Fail the build when a chunk that is supposed to be LAZY is statically
// reachable from the entry.
//
// This has now bitten three times, always the same way: `manualChunks` groups
// a package scope into one chunk, some module in that group is imported
// statically by app code, and the WHOLE group is promoted onto the eager path
// — silently, because chunk-size output looks identical either way and the
// `await import(...)` call sites still read as lazy.
//
//   1. monaco-vscode-workbench-service-override — grouped into `monaco`, its
//      top-level listeners then ran and rejected on every page load.
//   2. @xyflow (the system-builder canvases import it statically) — grouped
//      with likec4, dragging LikeC4 + the Graphviz WASM layouter eager:
//      3.07 MB of a 15.87 MB eager total.
//   3. …the next one, which is what this script exists to catch.
//
// Eager JS matters here beyond first paint: the playground boots
// Postgres-in-WASM, which demands a 128 MB CONTIGUOUS heap (declared by
// pglite.wasm — not a setting).  Every megabyte resident when that
// allocation happens is a megabyte the device has to find on top of it, and
// on iOS the failure mode is the tab being killed with no error at all.
//
// Run against a built `dist/`.  Deliberately independent of vite: it reads
// the emitted graph, so it stays true no matter how the config is refactored.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const ASSETS = path.join(DIST, "assets");

/** Chunk-name prefixes that must never be statically reachable from the
 *  entry.  Each is reached through a real `await import(...)` and is big
 *  enough that promoting it is a genuine regression, not a rounding error. */
const MUST_BE_LAZY = [
  "likec4", // LikeC4 model/react + @hpcc-js Graphviz WASM — the `.c4` viewer
  "mermaid", // diagram renderer — the mermaid viewer
  "craftjs", // page builder — the Builder tab
  "monaco-views-optional", // service overrides for a viewsConfig we never use
];

/** Static import edges only.  `from"./x.js"` and bare `import"./x.js"` are
 *  static; `import("./x.js")` is dynamic and is exactly what we want to see
 *  instead. */
function staticEdges(src) {
  const out = [];
  for (const m of src.matchAll(/from"\.\/([A-Za-z0-9_.-]+\.js)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?<!\()import"\.\/([A-Za-z0-9_.-]+\.js)"/g)) out.push(m[1]);
  return out;
}

const html = readFileSync(path.join(DIST, "index.html"), "utf8");
const roots = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => path.basename(m[1]));
if (roots.length === 0) {
  console.error("check-eager-chunks: no entry scripts found in dist/index.html");
  process.exit(1);
}

// Breadth-first over static edges, recording HOW we got somewhere so a
// failure names the importer rather than just the victim.
const via = new Map(roots.map((r) => [r, "<entry>"]));
const queue = [...roots];
while (queue.length > 0) {
  const file = queue.pop();
  let src;
  try {
    src = readFileSync(path.join(ASSETS, file), "utf8");
  } catch {
    continue;
  }
  for (const next of staticEdges(src)) {
    if (!via.has(next)) {
      via.set(next, file);
      queue.push(next);
    }
  }
}

const bytes = (f) => {
  try {
    return statSync(path.join(ASSETS, f)).size;
  } catch {
    return 0;
  }
};

const violations = [];
for (const [file, importer] of via) {
  const hit = MUST_BE_LAZY.find((p) => file.startsWith(`${p}-`) || file === `${p}.js`);
  if (hit) violations.push({ file, importer, prefix: hit, size: bytes(file) });
}

const eagerBytes = [...via.keys()].reduce((a, f) => a + bytes(f), 0);
const allBytes = readdirSync(ASSETS)
  .filter((f) => f.endsWith(".js"))
  .reduce((a, f) => a + bytes(f), 0);
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

console.log(`eager JS: ${mb(eagerBytes)} of ${mb(allBytes)} total (${via.size} chunks)`);

if (violations.length > 0) {
  console.error("\ncheck-eager-chunks: LAZY chunk(s) promoted to the eager path:\n");
  for (const v of violations) {
    console.error(`  ${v.file}  (${mb(v.size)})`);
    console.error(`    statically imported by: ${v.importer}`);
  }
  console.error(
    "\nSomething in the eager graph statically imports a module that " +
      "`manualChunks` groups into this chunk.\nFix by splitting that package " +
      "into its own chunk (see the @xyflow case in vite.config.ts), not by " +
      "\nremoving it from the list.\n",
  );
  process.exit(1);
}

console.log(`check-eager-chunks: OK — ${MUST_BE_LAZY.length} lazy chunk(s) verified lazy`);
