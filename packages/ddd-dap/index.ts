// ---------------------------------------------------------------------------
// ddd-dap — publish-shaped wrapper for the Loom DAP (Debug Adapter Protocol)
// stdio server.
//
// The server core lives in `src/dap-server/` (a Node-only island over the
// browser-safe `src/dap/` resolution cores, like `src/cli/` and `src/mcp/`);
// this package is its publish identity — the `bin` (`ddd-dap` → `bin.js` →
// `out/dap-server/main.js`) and the `@vscode/debugadapter` /
// `@vscode/debugprotocol` dependency declarations.  Re-exports the session
// class so external consumers (an editor extension) can embed it, paralleling
// how `ddd-mcp/index.ts` re-exports the MCP server core.
//
// SCOPE: this ships the REMAP LAYER — `LoomDebugSession`'s
// initialize/setBreakpoints/stackTrace handlers wired over the two shipped
// pure cores (`resolveSetBreakpoints`, `remapStackFrames`).  It does NOT
// implement the full delegating target-debugger proxy (spawning
// js-debug/coreclr/JDWP for `launch`/`attach`) — that remains the documented,
// editor-verified frontier.  See docs/old/proposals/source-map-and-debugging.md
// §6E and docs/old/plans/dap-node-debug.md (Milestone 27).
// ---------------------------------------------------------------------------

export { LoomDebugSession } from "../../src/dap-server/index.js";
