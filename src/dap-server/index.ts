// Public surface of the Loom DAP server core — re-exported by the publish
// wrapper `packages/ddd-dap/`. Transport wiring (stdio, map-path resolution)
// lives in `main.ts`; this barrel is the embeddable surface (mirrors
// `src/mcp/index.ts`).
export { loadSourceMap, makeFsReadSource } from "./load-map.js";
export type { ReadSource } from "./session.js";
export { LoomDebugSession } from "./session.js";
