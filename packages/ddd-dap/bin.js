#!/usr/bin/env node
// Thin launcher for the Loom DAP stdio server — mirrors the root `bin/cli.js`
// and `packages/ddd-mcp/bin.js` shims.  The compiled entrypoint lives in
// `out/dap-server/main.js` (built from `src/dap-server/` by `tsc -b`); errors
// surface on stderr so stdout stays a clean DAP transport channel.
import("../../out/dap-server/main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
