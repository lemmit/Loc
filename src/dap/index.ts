// ---------------------------------------------------------------------------
// `src/dap/` — pure, dependency-free breakpoint-translation core (docs/
// proposals/source-map-and-debugging.md §6E, docs/plans/dap-node-debug.md
// phase 8 first slice). A `.ddd` file+line → generated file:line lookup
// over a parsed `.loom/sourcemap.json` — the reverse of `src/trace/`, whose
// discipline this mirrors exactly: no `fs`, no Node-only API, safe to
// import from browser-bundled code. The eventual DAP protocol shell (a
// `packages/ddd-dap` workspace, `@vscode/debugadapter`) is glue built on top
// of this function later; none of that lands in this slice.
// ---------------------------------------------------------------------------

export type { BreakpointTarget } from "./breakpoints.js";
export { translateBreakpoint } from "./breakpoints.js";
