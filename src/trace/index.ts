// ---------------------------------------------------------------------------
// `src/trace/` — pure, dependency-free consumer of `.loom/sourcemap.json`
// that powers `ddd trace` (docs/old/proposals/source-map-and-debugging.md §6B).
// Mirrors the `src/verify/` pattern: no `fs`, no Node-only API, safe to
// import from browser-bundled code. The CLI wiring (file IO, exit codes)
// lives in `src/cli/main.ts`.
// ---------------------------------------------------------------------------

export { annotateTrace, LineIndex } from "./annotate.js";
export type { ParsedFrame } from "./frames.js";
export { parseFrames } from "./frames.js";
export type { Resolution, SourceMap, WireOriginRef, WireRegion } from "./resolve.js";
export { isSamePath, matchPath, resolveFrame, toOriginRef } from "./resolve.js";
