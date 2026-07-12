// ---------------------------------------------------------------------------
// `src/dap/` — pure, dependency-free DAP resolution core (docs/proposals/
// source-map-and-debugging.md §6E, docs/plans/dap-node-debug.md phase 8).
// Hosts the forward core, `translateBreakpoint` — a `.ddd` file+line →
// generated file:line lookup over a parsed `.loom/sourcemap.json`, the
// reverse of `src/trace/` — AND BOTH DAP-shaped resolvers built on top of
// `src/dap`/`src/trace`: the forward `resolveSetBreakpoints` (arm a `.ddd`
// breakpoint at the generated location) and the reverse `remapStackFrames`
// (rewrite the debugged runtime's reported stack frames, in generated
// coordinates, back to `.ddd` source). Whose discipline this mirrors
// exactly: no `fs`, no Node-only API, safe to import from browser-bundled
// code. The eventual DAP protocol shell (a `packages/ddd-dap` workspace,
// `@vscode/debugadapter`) is glue built on top of these functions later;
// none of that lands in this slice.
// ---------------------------------------------------------------------------

export type { BreakpointTarget } from "./breakpoints.js";
export { translateBreakpoint } from "./breakpoints.js";
export type {
  DapBreakpoint,
  DapSetBreakpointsArguments,
  DapSource,
  DapSourceBreakpoint,
  DapStackFrame,
} from "./dap-protocol.js";
export { resolveSetBreakpoints } from "./set-breakpoints.js";
export { remapStackFrames } from "./stack-trace.js";
