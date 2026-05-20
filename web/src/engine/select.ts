// Engine selection.
//
// Default: `npm-install-bundle` — real npm tarballs, no esm.sh, so
// the drizzle/split-shard bug class (which leaves the esm.sh path
// broken in production) is gone.  The engine is correctness-complete
// (backend boots + serves; all four design packs render in-browser)
// and C1 (local tarball mirror) made install fast.  esm.sh stays as
// an OPT-OUT fallback — `?engine=esbuild-pglite` or localStorage
// `loom.engine` — and is deleted once C2 (vendor prebuild) lands the
// bundle-speed win and the e2e is green.  Unknown ids fall back to
// the default rather than throwing, so a stale link can't brick the
// playground.

import { engineRegistry } from "./registry.js";

const DEFAULT_ENGINE = "npm-install-bundle";

export function selectedEngineId(): string {
  try {
    const q = new URLSearchParams(location.search).get("engine");
    if (q && engineRegistry.has(q)) return q;
    const ls = localStorage.getItem("loom.engine");
    if (ls && engineRegistry.has(ls)) return ls;
  } catch {
    // non-browser / storage blocked → default
  }
  return DEFAULT_ENGINE;
}
