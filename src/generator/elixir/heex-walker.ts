// ---------------------------------------------------------------------------
// HEEx walker — public facade.
//
// The walker was split into two cohesive halves for readability:
//   - heex-walker-core.ts  — the expression/statement engine, WalkContext,
//     the generic `renderPrimitive`, and the markup helpers.
//   - heex-primitives.ts    — the leaf presentational component renderers.
// This module re-exports both so importers (and the walker registry at
// src/generator/_walker/registry.ts) keep importing from "./heex-walker.js".
// ---------------------------------------------------------------------------

export * from "./heex-primitives.js";
export * from "./heex-walker-core.js";
