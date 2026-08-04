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
//      3.07 MB of a 15.87 MB eager total.  (LikeC4 has since been removed
//      outright; the grouping hazard it demonstrated has not.)
//   3. `\0vite/preload-helper` — the helper EVERY `await import(...)` routes
//      through.  Being a VIRTUAL module it matched no `manualChunks` rule, so
//      rollup put it in the `monaco` chunk, and the entry's static import of
//      the helper became a static import of 9.56 MB.  Every lazy boundary in
//      the app was correct and Monaco still shipped on first paint.
//   4. …the next one, which is what this script exists to catch.
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
  "mermaid", // diagram renderer — the mermaid viewer
  "craftjs", // page builder — the Builder tab
  "monaco-views-optional", // service overrides for a viewsConfig we never use
  // The editor itself.  Desktop fetches it immediately after first paint (it
  // renders the editor), which is fine — what must not happen is it being a
  // STATIC dependency of the entry, because then mobile downloads and parses
  // 9.56 MB it will never show.  Reached only via `layout/lazy-panels.ts`.
  "monaco",
];

/** Code that must not be on the eager path, identified by a SIGNATURE rather
 *  than a chunk name — because `manualChunks` only names vendor scopes, and
 *  what got promoted here was our own `src/` toolchain, which rollup places
 *  wherever the import graph says.  The name-based list above cannot see it.
 *
 *  Each signature is a string literal that survives minification (a package
 *  identifier or a tool name), and each is checked BOTH ways:
 *
 *    - it must appear SOMEWHERE in `dist/assets` — otherwise the signature has
 *      rotted and the check silently passes forever (the vacuous-gate failure
 *      mode, `experience_gathered.md` §59/§63);
 *    - it must NOT appear in any eagerly-reachable chunk.
 *
 *  History: `App.tsx` imported `runAgentDemo` from `./agent/demo`, which has a
 *  value import of `src/tools` → `src/api` → `src/language` + `src/ir`.  One
 *  symbol put Langium, chevrotain and the whole grammar into the eager entry
 *  chunk (2.57 MB, of which ~1.5 MB was compiler) — a THIRD resident copy
 *  alongside `build.worker` and `ddd-server.worker`, on the main thread.  See
 *  M-T8.15. */
const FORBIDDEN_IN_EAGER = [
  {
    needle: "chevrotain",
    what: "the Langium parser / Loom grammar (src/language)",
    fix: "reach it through `await import(...)`, or move the work into the build worker",
  },
  {
    needle: "loom_validate",
    what: "the agent tool catalog (src/tools → src/api → src/language + src/ir)",
    fix: "import the agent modules type-only and `await import(...)` at the call site",
  },
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

const allJs = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
const eagerBytes = [...via.keys()].reduce((a, f) => a + bytes(f), 0);
const allBytes = allJs.reduce((a, f) => a + bytes(f), 0);
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

console.log(`eager JS: ${mb(eagerBytes)} of ${mb(allBytes)} total (${via.size} chunks)`);

// --- signature check -------------------------------------------------------
const read = (f) => {
  try {
    return readFileSync(path.join(ASSETS, f), "utf8");
  } catch {
    return "";
  }
};
const eagerFiles = [...via.keys()].filter((f) => allJs.includes(f));
const rotted = [];
const leaked = [];
for (const sig of FORBIDDEN_IN_EAGER) {
  if (!allJs.some((f) => read(f).includes(sig.needle))) {
    rotted.push(sig);
    continue;
  }
  const hits = eagerFiles.filter((f) => read(f).includes(sig.needle));
  if (hits.length > 0) leaked.push({ sig, hits });
}

if (rotted.length > 0) {
  console.error("\ncheck-eager-chunks: signature(s) no longer present ANYWHERE in dist/:\n");
  for (const s of rotted) console.error(`  "${s.needle}"  — meant to mark ${s.what}`);
  console.error(
    "\nThe check can no longer fail, which makes it worthless.  Either the code " +
      "\ngenuinely left the bundle (delete the signature) or the minifier/dep " +
      "\nrenamed it (pick a new one that survives).\n",
  );
  process.exit(1);
}

if (leaked.length > 0) {
  console.error("\ncheck-eager-chunks: code that must stay lazy is on the eager path:\n");
  for (const { sig, hits } of leaked) {
    console.error(`  ${sig.what}`);
    console.error(`    signature "${sig.needle}" found in: ${hits.join(", ")}`);
    console.error(`    importer chain starts at: ${hits.map((h) => via.get(h)).join(", ")}`);
    console.error(`    fix: ${sig.fix}`);
  }
  console.error(
    "\nOn iOS the main thread and every worker share ONE process memory budget, " +
      "\nand the playground has to find 128 MB contiguous for Postgres-in-WASM on " +
      "\ntop of whatever is resident.  See M-T8.15.\n",
  );
  process.exit(1);
}

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

console.log(
  `check-eager-chunks: OK — ${MUST_BE_LAZY.length} lazy chunk(s) verified lazy, ` +
    `${FORBIDDEN_IN_EAGER.length} signature(s) verified off the eager path`,
);
