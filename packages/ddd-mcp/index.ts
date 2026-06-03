// ---------------------------------------------------------------------------
// ddd-mcp — publish-shaped wrapper for the Loom MCP stdio server.
//
// The server core lives in `src/mcp/` (a Node-only island over the
// browser-safe agent-tool catalog, like `src/cli/`); this package is its
// publish identity — the `bin` (`ddd-mcp` → `bin.js` → `out/mcp/main.js`) and
// the `@modelcontextprotocol/sdk` dependency declaration.  Re-exports the
// server core so external consumers can embed it, paralleling how `@loom/core`
// re-exports the toolchain.
// ---------------------------------------------------------------------------

export { createServer, SERVER_INFO } from "../../src/mcp/index.js";
