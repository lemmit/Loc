// Browser `Buffer` polyfill.  Side-effect import — installs the `buffer`
// package's implementation on `globalThis` once, for whichever realm
// imports it.  A worker has its OWN global scope, so every realm that
// needs `Buffer` must import this itself; there are two.
//
// MAIN THREAD (`main.tsx`, top of file, ahead of `App`):
// `isomorphic-git` (the workspace versioning store under
// `src/workspace/git/`) reaches for Node's global `Buffer` in a few of
// its blob / hashing code paths.  The browser has no such global, so the
// first git write — e.g. advancing `refs/loom/generated-base` when the
// playground versions a generated tree — throws `ReferenceError: Buffer
// is not defined` ("failed to version generated output" in the console).
//
// RUNTIME WORKER (`runtime/runtime.worker.ts`, before the bundle import):
// the generated backend bundles `pg` (pinned by both Hono backends, and
// bundled even though the playground's live path is PGlite), and
// pg-protocol allocates at MODULE-EVALUATION time — `parser.js:14`
// `const emptyBuffer = Buffer.allocUnsafe(0)`, plus `serializer.js` and
// `b.js`.  So `await import(bundleUrl)` threw before a single line of
// generated code ran: "Bundle import failed: Can't find variable: Buffer".
// Same defect class as the `process` members in `engine/npm/postprocess.ts`
// — a Node global read while a dependency's module body evaluates, where
// no `try`/`catch` at a call site can help.
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
