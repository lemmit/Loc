// ---------------------------------------------------------------------------
// @loom/backend-hono-v4 — workspace package wrapper.
//
// packaging-split P3 slice 1 (docs/packaging-split.md).  This is the
// real, npm-shaped home of the hono@v4 backend.  Today it is a thin
// re-export of the in-tree `src/platform/hono/v4/` module so the
// workspace symlink + `package.json` `loom` key exist on disk and
// can be discovered by the fs resolver (next slice), without yet
// moving source.  Future slices will physically relocate the
// implementation into this package and drop the re-export.
//
// `loomManifest` here matches `src/platform/hono/v4/index.ts`'s
// constant by reference (single source of truth until source moves).
// The published-package contract — what `fs`-backed discovery reads —
// is the sibling `package.json`'s `loom` key, not this file.
// ---------------------------------------------------------------------------

export {
  default,
  loomManifest,
} from "../../src/platform/hono/v4/index.js";
export { BACKEND_PINS } from "../../src/platform/hono/v4/pins.js";
