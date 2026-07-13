# MCP server & agent tools

Loom ships an **MCP stdio server** (`ddd-mcp`) that exposes the `.ddd` authoring loop — validate, outline, generate, patch, and the LSP navigation/refactor verbs — to any Model Context Protocol host (Claude Code, Claude Desktop, an IDE agent). It is one thin transport over a transport-neutral **agent-tool catalog**, so the exact same tools that drive the server also back the in-browser playground's agentic chat with no schema drift.

The design rationale is [D-AGENT-TOOLS](decisions.md#d-agent-tools--one-tool-catalog-over-the-toolkit-mcp-and-in-browser-are-transports); this doc is the shipped reference.

## Three layers

The server is the top of a strict three-layer stack — each layer pure, side-effect-free, and browser-safe except the last:

| Layer | Home | Role |
|---|---|---|
| **Toolkit** | `src/api/` | `validate` / `generate` / `applyPatches` over an in-memory `.ddd` source, plus the LSP-backed `findSymbol` / `references` / `hover` / `rename` / `quickfix` / `unfoldMacro`. Parses on `EmptyFileSystem`, returns the `src/diagnostics/contract.ts` wire shapes. Documented separately in [api-toolkit.md](api-toolkit.md). |
| **Tool catalog** | `src/tools/` | `TOOLS: ToolDef[]` — each a `{ name, description, inputSchema (JSON Schema), handler(args) }` pairing an LLM-facing schema with a toolkit call. `callTool(name, args)` is the single dispatch entry every transport reuses. No MCP dependency, no Node-only imports → imports cleanly into a browser bundle. |
| **MCP transport** | `src/mcp/` + `packages/ddd-mcp/` | The Node-only island: registers the catalog over `@modelcontextprotocol/sdk`, connects it to stdio. Owns no tool logic, only protocol wiring. |

The boundary is the same shape as the CLI: `src/cli/` and `src/mcp/` are both Node-only entrypoints over a browser-safe core. The catalog stays importable everywhere; the MCP SDK lives only in `src/mcp/` and the publish wrapper.

## The `loom_*` tool catalog

Ten tools (`src/tools/catalog.ts`), in two families. Every tool is a **pure function of its inputs** — model `source` in, report or new-source out. There is no server-side model state and no filesystem side effect: the host owns the working model and threads it through each call. The rewrite verbs (`rename`, `quickfix`, `unfold_macro`) **return edits, never apply them** — the host applies them to its buffer.

**Generative family** — the authoring/repair loop, pure functions of `source`:

| Tool | Input | What it does |
|---|---|---|
| `loom_validate` | `{ source }` | Validate a model. Returns coded, located diagnostics (each with an optional fix-hint patch) plus the outline. The repair loop's oracle. |
| `loom_outline` | `{ source }` | The model's address book — contexts, aggregates, members. The addresses here are exactly the `target`s `loom_apply_patch` takes and the diagnostics point at. |
| `loom_generate` | `{ source }` | Validate, and report the deployable manifest (name / platform / port). Writes no files. |
| `loom_apply_patch` | `{ source, patches[] }` | Apply node-addressed edits atomically. Each patch is `{ op: add\|replace\|remove\|insert, target, source?, position? }`. If any patch fails to resolve, nothing is applied. Returns the patched source or per-patch errors. |

**Navigational family** — over the LSP providers, addressed by symbol name:

| Tool | Input | What it does |
|---|---|---|
| `loom_find_symbol` | `{ source, symbol, kind? }` | Locate a symbol by dotted name. Returns its canonical address, kind, name-token range, parent. Ambiguous/unknown → `{ error, candidates }` (never a silent pick). |
| `loom_references` | `{ source, symbol }` | Every usage site (incl. the declaration and member accesses the cross-reference index can't see). Returns located ranges. |
| `loom_hover` | `{ source, symbol }` | The hover bubble (markdown) — signature / type summary, exactly as the editor shows. |
| `loom_rename` | `{ source, symbol, newName }` | The text edits to rename everywhere (declaration + every use site), **without applying them**. |
| `loom_quickfix` | `{ source, code, at? }` | The fix-hint edits for a diagnostic code (from `loom_validate`), **without applying them**. `at` disambiguates when several diagnostics share the code. |
| `loom_unfold_macro` | `{ source, macro, on }` | Expand a `with <macro>(...)` clause on a host into its source — the refactor edits, **without applying them**. |

A symbol address uses the same dotted space as `loom_outline` and the diagnostic `node` fields — short form `Order.customerId` when unambiguous, fully qualified `Sales.Order.customerId` otherwise.

## Running the stdio server

The bin is **`ddd-mcp`** (`packages/ddd-mcp/package.json`). Its shim (`bin.js`) launches the compiled entrypoint `out/mcp/main.js`, built from `src/mcp/` by `tsc -b`. So a local checkout runs it after a build:

```bash
npm run build          # tsc -b → out/mcp/main.js
node packages/ddd-mcp/bin.js
# or, once the package is on a registry / installed: npx ddd-mcp
```

The process speaks MCP over stdio and stays alive until the host closes it. Diagnostics go to **stderr** — stdout carries only protocol frames.

### Wiring into an MCP client

The server registers two handlers (`src/mcp/server.ts`): `tools/list` surfaces every catalog entry (`name` + `description` + `inputSchema`), and `tools/call` dispatches through the shared `callTool`. The result is returned as a single JSON text block (the MCP convention for structured output the host re-parses); a handler throw or unknown tool comes back as an MCP tool error (`isError: true`) the host can feed back to the model, not a protocol-level failure.

A host that spawns the server as a subprocess (e.g. Claude Code's `mcpServers` config) points at the bin:

```json
{
  "mcpServers": {
    "loom": { "command": "node", "args": ["packages/ddd-mcp/bin.js"] }
  }
}
```

(Use `"command": "npx", "args": ["ddd-mcp"]` once the package is installed/published rather than run from a checkout.)

A raw `tools/call` frame to validate a model:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "loom_validate",
    "arguments": { "source": "system Shop { context Sales { aggregate Order { id: Id } } }" }
  }
}
```

The response `content[0].text` is the JSON `ValidateReport` (diagnostics + outline).

The advertised server identity is `{ name: "ddd-mcp", version: "0.0.0-experimental" }` — the package is currently `private` and experimental (`loom: { kind: "mcp-server" }`), so the `npx ddd-mcp` form depends on a published or locally-linked build.

## Browser-safety / the Node-only boundary

Everything below `src/mcp/` is browser-safe: `src/tools/` imports only `src/api/` and contract types — no MCP SDK, no `node:` modules. The MCP SDK (`@modelcontextprotocol/sdk`) and the `StdioServerTransport` live exclusively in `src/mcp/` and `packages/ddd-mcp/`. This is the same island discipline the CLI follows, and it's what lets the catalog ship into a browser bundle unchanged.

`createServer()` (`src/mcp/server.ts`) builds the registered server **without a transport attached** — `main.ts` connects it to stdio, while tests connect the same server to an `InMemoryTransport`. So the protocol wiring is exercised end-to-end without spawning a process.

## Same catalog, in-browser

Because the catalog has no transport baggage, an in-process host dispatches the LLM's `tool_use` calls **directly** to `callTool` — no subprocess, no stdio. `src/tools/agent-loop.ts` is the reference in-process driver: `runAgent({ complete, messages, ... })` asks an injected LLM (`Complete`), runs each requested tool through `dispatchToolUses` → `callTool`, feeds the JSON results back as `tool_result` blocks, and repeats until the model stops or a step cap is hit. The LLM call is the only injection point, so the loop is provider-neutral and unit-testable with a scripted fake; `toolSpecs()` exposes the catalog in the Anthropic-shaped `{ name, description, input_schema }` form a tool-use request expects.

This loop is the in-browser playground chat's intended driver (the playground reuses the catalog rather than a second copy of the schemas). An **external MCP host runs its own loop**, so `agent-loop.ts` is not used by the MCP server — the server is just the `tools/list` + `tools/call` surface, and the host orchestrates.

## Further reading

- [api-toolkit.md](api-toolkit.md) — the `src/api/` toolkit the catalog sits on (validate / generate / applyPatches + the navigation verbs and their wire shapes).
- [decisions.md → D-AGENT-TOOLS](decisions.md#d-agent-tools--one-tool-catalog-over-the-toolkit-mcp-and-in-browser-are-transports) and D-API-TOOLKIT — why one catalog over one toolkit.
- `docs/old/proposals/agent-tools-and-mcp.md` — the originating proposal (aspirational; this doc is the shipped subset).
