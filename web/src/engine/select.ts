// Engine selection.
//
// `npm-install-bundle` (real npm tarballs in-browser, prebuilt vendor)
// is the only engine today, so it's the default.  The `?engine=` /
// localStorage `loom.engine` override is kept as the selection seam
// for a future runtime that registers alongside it; unknown ids fall
// back to the default rather than throwing, so a stale link can't
// brick the playground.

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
