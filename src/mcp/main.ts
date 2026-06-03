// ---------------------------------------------------------------------------
// src/mcp/main.ts — the stdio entrypoint for the Loom MCP server.
//
// Compiled to `out/mcp/main.js` and invoked by the `packages/ddd-mcp/bin.js`
// shim (`npx ddd-mcp`).  Connects the catalog-backed server (`server.ts`) to a
// stdio transport — the conventional MCP wiring for a host that spawns the
// server as a subprocess.  Mirrors `src/cli/main.ts`'s role for the CLI bin.
// ---------------------------------------------------------------------------

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process stays alive on the stdio transport until the host closes it.
}

main().catch((err) => {
  // Diagnostics go to stderr — stdout is the MCP transport channel and must
  // carry only protocol frames.
  console.error(err);
  process.exit(1);
});
