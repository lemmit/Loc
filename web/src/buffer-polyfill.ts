// Browser `Buffer` polyfill.
//
// `isomorphic-git` (the workspace versioning store under
// `src/workspace/git/`) reaches for Node's global `Buffer` in a few of
// its blob / hashing code paths.  The browser has no such global, so the
// first git write — e.g. advancing `refs/loom/generated-base` when the
// playground versions a generated tree — throws `ReferenceError: Buffer
// is not defined` ("failed to version generated output" in the console).
//
// Install the `buffer` package's implementation on `globalThis` once, as
// a side-effect import, so it's present before any git operation runs.
// Imported at the very top of `main.tsx` ahead of `App` (whose tree pulls
// in the git store) so the global is set before anything can use it.
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
