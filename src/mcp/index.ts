// Public surface of the Loom MCP server core — re-exported by the publish
// wrapper `packages/ddd-mcp/`.  Transport wiring lives in `main.ts`.
export { createServer, SERVER_INFO } from "./server.js";
