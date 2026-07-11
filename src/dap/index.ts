// ---------------------------------------------------------------------------
// `src/dap/` — pure, dependency-free DAP resolution core (docs/proposals/
// source-map-and-debugging.md §6E, docs/plans/dap-node-debug.md phase 8).
// Hosts both the forward core, `translateBreakpoint` — a `.ddd` file+line →
// generated file:line lookup over a parsed `.loom/sourcemap.json`, the
// reverse of `src/trace/` — AND the DAP-shaped `setBreakpoints` resolver
// built on it, `resolveSetBreakpoints`. Whose discipline this mirrors
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
} from "./dap-protocol.js";
export { resolveSetBreakpoints } from "./set-breakpoints.js";
