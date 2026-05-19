// Bundle post-process for the npm-in-browser engine (Phase B4).
//
// Distinct from plugin.ts's `postProcessBundle`, which is tuned to
// esm.sh's *minified* PGlite output (its node-detection regex matches
// esm.sh's specific mangled variable names).  The real
// @electric-sql/pglite npm tarball is bundled differently, so that
// regex would silently no-op.
//
// What actually has to be rewritten is source-independent: PGlite
// computes asset URLs as `new URL("./pglite.wasm", import.meta.url)`.
// When the bundle is loaded from a `blob:` URL in the runtime worker,
// `import.meta.url` is that blob URL and the URL constructor throws
// ("blob: cannot be a base").  Replacing `import.meta.url` with a
// real jsdelivr base fixes it regardless of how PGlite was built —
// the same fix plugin.ts applies, minus the esm.sh-only node-
// detection regex.
//
// Node-detection is also neutralised.  In a real browser worker
// `typeof process.versions.node` is falsy so PGlite *would* take the
// browser branch on its own — but forcing it (a) guarantees the
// browser path even under any process-shim, and (b) makes node-side
// verification representative of the browser.  Unlike esm.sh's
// mangled output, the npm tarball keeps the detection un-mangled
// (`typeof process.versions.node == "string"`), so the pattern is
// stable and readable rather than a brittle minifier-shape regex.

import { pgliteImportMetaUrl } from "../../bundle/plugin.js";

// Matches `typeof process.versions.node == "string"` with flexible
// spacing around `==`.  npm pglite emits this un-mangled.
const NPM_PGLITE_NODE_DETECTION =
  /typeof process\.versions\.node\s*==\s*"string"/g;

export function postProcessNpmBundle(code: string): string {
  const urlHits = (code.match(/import\.meta\.url/g) ?? []).length;
  if (urlHits === 0) {
    throw new Error(
      "postProcessNpmBundle: no `import.meta.url` in the bundle — " +
        "PGlite's asset-URL mechanism changed; re-verify the WASM/data " +
        "injection path before trusting the npm engine's boot.",
    );
  }
  const nodeHits = (code.match(NPM_PGLITE_NODE_DETECTION) ?? []).length;
  if (nodeHits === 0) {
    throw new Error(
      "postProcessNpmBundle: PGlite node-detection pattern not found — " +
        "@electric-sql/pglite's build shape changed; inspect its dist " +
        "and update NPM_PGLITE_NODE_DETECTION before trusting boot.",
    );
  }
  return code
    .replace(NPM_PGLITE_NODE_DETECTION, "false")
    .replaceAll("import.meta.url", JSON.stringify(pgliteImportMetaUrl()));
}
