// ---------------------------------------------------------------------------
// src/mcp/server.ts — the Loom MCP server core (transport-agnostic).
//
// Registers the transport-neutral agent-tool catalog (`src/tools/`) over the
// Model Context Protocol so an external host (Claude Desktop, an IDE agent, …)
// can drive the `.ddd` authoring loop — validate / outline / generate /
// apply_patch — exactly as the in-browser playground does through direct
// `callTool` dispatch.  One catalog, many transports (D-AGENT-TOOLS); this
// module owns NO tool logic, only the MCP wiring.
//
// Like `src/cli/`, this is a Node-only island over the browser-safe toolkit:
// the catalog stays side-effect-free and importable everywhere, while the
// MCP-SDK / stdio dependency lives only here and in `main.ts`.  The publish
// wrapper is `packages/ddd-mcp/` (bin shim → `out/mcp/main.js` + the SDK dep),
// paralleling how `bin/cli.js` wraps `src/cli/`.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, TOOLS } from "../tools/index.js";

/** The server's advertised identity.  Version tracks the package. */
export const SERVER_INFO = { name: "ddd-mcp", version: "0.0.0-experimental" } as const;

/** Build a Loom MCP `Server` with the agent-tool catalog registered.  Pure —
 *  no transport attached.  Callers connect it to a transport
 *  (`StdioServerTransport` in `main.ts`, `InMemoryTransport` in tests). */
export function createServer(): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  // tools/list — surface every catalog entry with its JSON-Schema input.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // tools/call — dispatch through the shared `callTool`.  The result is the
  // toolkit's contract wire shape, returned as a single JSON text block (the
  // MCP convention for structured output the host re-parses).  An unknown tool
  // or a handler throw surfaces as an MCP tool error (`isError: true`) rather
  // than a protocol-level failure, so the host can feed it back to the model.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}
