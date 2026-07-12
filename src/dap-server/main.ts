// ---------------------------------------------------------------------------
// src/dap-server/main.ts — the stdio entrypoint for the Loom DAP server.
//
// Compiled to `out/dap-server/main.js` and invoked by the `packages/ddd-dap/
// bin.js` shim (`npx ddd-dap`). Mirrors `src/mcp/main.ts`'s role for the MCP
// server / `src/cli/main.ts`'s role for the CLI bin: loads the fs-backed
// `.loom/sourcemap.json` (via `load-map.ts`), constructs the fs-free
// `LoomDebugSession` over it, and wires it to the stdio DAP transport via the
// SDK's `ProtocolServer.start(inStream, outStream)`.
//
// NOTE — the map path is intentionally simple for this slice: `--map=<path>`
// on argv, else the `LOOM_DAP_MAP` env var, else `.loom/sourcemap.json`
// relative to the current working directory (the same default
// `src/cli/main.ts`'s `resolveMapPath` uses for `ddd trace`/`ddd
// breakpoints`). A real editor launch config sets one of these explicitly.
// ---------------------------------------------------------------------------

import * as path from "node:path";
import { loadSourceMap, makeFsReadSource } from "./load-map.js";
import { LoomDebugSession } from "./session.js";

const MAP_ARG_PREFIX = "--map=";

function resolveMapPath(): string {
  const argMap = process.argv.slice(2).find((a) => a.startsWith(MAP_ARG_PREFIX));
  if (argMap) return path.resolve(argMap.slice(MAP_ARG_PREFIX.length));
  if (process.env.LOOM_DAP_MAP) return path.resolve(process.env.LOOM_DAP_MAP);
  return path.resolve(".loom", "sourcemap.json");
}

function main(): void {
  const mapPath = resolveMapPath();
  const map = loadSourceMap(mapPath);
  const session = new LoomDebugSession(map, makeFsReadSource());
  session.start(process.stdin, process.stdout);
  // The process stays alive on the stdio transport until the host closes it
  // (or the session `shutdown()`s itself) — same lifecycle note as
  // `src/mcp/main.ts`.
}

try {
  main();
} catch (err) {
  // Diagnostics go to stderr — stdout is the DAP transport channel and must
  // carry only protocol frames.
  console.error(err);
  process.exit(1);
}
