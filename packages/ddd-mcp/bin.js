#!/usr/bin/env node
// Thin launcher for the Loom MCP stdio server — mirrors the root `bin/cli.js`
// shim.  The compiled entrypoint lives in `out/mcp/main.js` (built from
// `src/mcp/` by `tsc -b`); errors surface on stderr so stdout stays a clean
// MCP transport channel.
import("../../out/mcp/main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
