// Engine selection (Phase B4).
//
// Default stays the proven `esbuild-pglite`.  The npm-in-browser
// engine is opt-in — `?engine=npm-install-bundle` or
// localStorage `loom.engine` — so it can be exercised / dogfooded
// without a silent default flip.  Unknown ids fall back to the
// default rather than throwing, so a stale link can't brick the
// playground.  Flip the default by changing DEFAULT_ENGINE once e2e
// parity is confirmed.

import { engineRegistry } from "./registry.js";

// Default: the proven `esbuild-pglite`.  npm-install-bundle is
// CORRECTNESS-proven (node spikes: install/resolve/bundle/boot/serve,
// React+CSS+externalisation) and stays available OPT-IN
// (?engine=npm-install-bundle).  It is NOT the default: the #188 e2e
// proved the in-browser path (esbuild-wasm — ~10× slower than the
// native esbuild the spikes used — + a per-session npm install of a
// Mantine-scale tree) does not produce a bundle within the 180s spec
// budget.  Re-flip only once an in-browser perf story lands (shipped
// warm/prebuilt install cache or precomputed bundles) and the e2e is
// green on npm-default.
const DEFAULT_ENGINE = "esbuild-pglite";

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
