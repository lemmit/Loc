// ---------------------------------------------------------------------------
// @loom/backend-hono-v5 — workspace package wrapper.
//
// The npm-shaped home of the hono@v5 backend (zod 4 / TypeScript 6).
// Like its v4 sibling this is a thin re-export of the in-tree
// `src/platform/hono/v5/` module so the workspace `package.json` `loom`
// key exists on disk and is discoverable by the fs resolver, without
// moving source.  The published-package contract — what fs-backed
// discovery reads — is the sibling `package.json`'s `loom` key.
// ---------------------------------------------------------------------------

export { default, loomManifest } from "../../src/platform/hono/v5/index.js";
export { BACKEND_PINS } from "../../src/platform/hono/v5/pins.js";
