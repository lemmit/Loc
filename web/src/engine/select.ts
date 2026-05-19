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

// Default stays the proven `esbuild-pglite`.  npm-install-bundle was
// briefly defaulted, but the #2 parity spike proved its React build
// is not yet system-mode-ready (CSS imports + deep mantine subpath
// resolution).  Until that lands (CSS pipeline + resolver hardening,
// or a hybrid: npm backend + esm.sh React), npm stays OPT-IN —
// ?engine=npm-install-bundle / localStorage loom.engine.  Re-flip by
// changing DEFAULT_ENGINE once the React build passes e2e.
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
