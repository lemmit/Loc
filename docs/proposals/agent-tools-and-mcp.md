# Agent tools & MCP — one catalog, many transports

> **Status:** PROPOSED / spec — no code yet.
> **Role:** Pins how Loom exposes its operations as **agent-callable tools**:
> a single transport-neutral **tool catalog** over the `src/api/` toolkit, and
> the transports that surface it (an MCP stdio server for external hosts; direct
> / in-memory dispatch for the in-browser playground chat). Build-plan item 6 of
> [`ai-authoring-loop.md`](./ai-authoring-loop.md).
> **Depends on:** the toolkit core
> ([D-API-TOOLKIT](../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface))
> and the diagnostics/patch contracts
> ([`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md)).
> **Decision tag:** pins
> [D-AGENT-TOOLS](../decisions.md#d-agent-tools--one-tool-catalog-over-the-toolkit-mcp-and-in-browser-are-transports).

---

## 1. The question this answers

"Will the MCP server be usable from the playground? Or are tool calls available
if I add an agentic chat in the playground?"

- An **MCP server** speaks **stdio** (a subprocess) or **Streamable HTTP** — it
  serves agents that run *outside* the browser (Claude Desktop, IDE agents, a CI
  agent). A browser can't spawn a stdio subprocess, so the conventional MCP
  server is **not** what the playground runs.
- The playground doesn't need it. The tool *implementations* are the `src/api/`
  toolkit functions, which are browser-safe and already imported by `web/`. An
  in-browser agentic chat dispatches the model's tool calls **directly** to
  those functions.

The risk is hand-coding the tool schemas twice (stdio server + playground) and
letting them drift — the exact mistake the toolkit refactor fixed one layer
down. So the tools get **one definition**, surfaced by thin transports.

## 2. The shape

```
        src/api/   validate · applyPatches · generate · LSP adapters     ← operations (toolkit)
                                   │
        src/tools/   tool CATALOG: { name, description, inputSchema, handler→toolkit }   ← one source of truth, browser-safe
              ┌────────────────────┼─────────────────────────────┐
        stdio MCP server     in-memory / direct            (future) HTTP
        packages/ddd-mcp     playground agentic chat        remote host
        (Node, external)     (browser, same catalog)
```

- **`src/tools/`** — the catalog. Each entry pairs a JSON-schema'd input with a
  handler that calls the toolkit and returns a contract wire shape. **No MCP
  dependency, no Node-only imports** → browser-safe, so every transport reuses
  it verbatim.
- **MCP stdio server** — a tiny Node entrypoint (`@modelcontextprotocol/sdk`)
  that registers the catalog. Ships as `packages/ddd-mcp` so an external host
  runs it via `npx ddd-mcp` (publish-shaped, like the other `packages/`).
- **Playground** — imports the same catalog and dispatches the LLM's `tool_use`
  calls straight to `handler(args)`. Optionally an **in-memory MCP** transport
  (the TS SDK ships one) links an in-browser client+server built from the same
  catalog, so the playground and Claude Desktop run byte-identical tools — but
  direct dispatch is simpler and the default recommendation.

## 3. Tools are pure and stateless (the load-bearing decision)

Every tool is a **pure function of its inputs** — the model `source` goes in,
a report (or new source) comes out. There is **no server-side model state and
no filesystem side effect.** Consequences:

- The **host owns the working model.** The playground (or the agent driver)
  holds the current `.ddd` string and threads it through each call; the loop is
  `validate(source) → read fixHints/diagnostics → applyPatches(source,…) →
  validate(newSource)`.
- The server is **safe by default** — read-only / functional. Nothing writes to
  disk, so no consent prompts, no sandbox concerns. File emission stays in the
  CLI (`generate system -o`), never in a tool.
- Determinism + browser-safety come for free (they're the toolkit's, inherited).

A stateful "session holds the model" design was considered and rejected: it adds
mutable server state, complicates the browser transport, and buys nothing the
host can't do by holding a string.

## 4. The catalog (v1)

| Tool | Input | Returns | Kind |
|---|---|---|---|
| `loom_validate` | `{ source }` | `ValidateReport` (coded diagnostics + `outline`) | read |
| `loom_apply_patch` | `{ source, patches: ModelPatch[] }` | `PatchResult` (new source or errors) | pure |
| `loom_generate` | `{ source }` | `GenerateReport` (validation + deployable manifest) | read |
| `loom_outline` | `{ source }` | `Outline` (the address book) | read |

Planned (as their toolkit ops land):

| Tool | Input | Returns |
|---|---|---|
| `loom_verify` | `{ source, results }` | per-requirement verdicts |
| `loom_read_model` | `{ source }` | canonical re-printed `.ddd` |
| `loom_list_primitives` | `{}` | the closed page-primitive catalog |

Naming: `loom_<verb>`, snake_case. Input schemas are JSON Schema (MCP requires
it); they're generated from / kept in lockstep with the contract types in
`src/diagnostics/contract.ts`.

**Resources & prompts (MCP also has these, future):** expose the model
context-pack (the `.ddd` authoring guide, build-plan item 7) as an MCP
*resource*, and a "build a Loom model" *prompt* — so a host gets the authoring
guidance, not just the verbs.

## 5. Why this directly enables the playground chat

Adding agentic chat to the playground becomes a **UI + LLM-wiring** task with no
new tool logic:

1. Send the conversation to the LLM (Anthropic API tool-use or a local model)
   with the catalog's schemas as the tool definitions.
2. On a `tool_use` block, call `catalog[name].handler(args)` — running the
   toolkit **in-browser** (no network for the tool itself).
3. Return the result; loop until the model stops.
4. Apply an `apply_patch` result to the editor buffer; surface diagnostics via
   the LSP adapters (already shipped) so the model-edit shows squiggles +
   quick-fixes.

The only browser-new concern is **LLM API key / endpoint handling**, which is a
playground settings matter, independent of the tools.

## 6. Layering & homes

- `src/tools/` imports only `src/api/` (the toolkit) + the contract types →
  browser-safe; sits above the pipeline like `cli`/`api` (not scanned by the
  pipeline-layering invariant, no back-edge).
- `packages/ddd-mcp/` — the Node stdio server; depends on `@loom/core`-style
  access to the catalog + the MCP SDK. Publish-shaped per the existing
  `packages/` story (CLAUDE.md).
- The playground imports `src/tools/` straight from `../src` (the existing
  `web/` → `../src` path).

## 7. Open questions

- **Catalog ↔ schema source.** Generate the JSON Schemas from the TS contract
  types (e.g. a build step) vs. hand-author and pin with a test. Proposal:
  hand-author v1 (small surface) + a completeness test that every catalog entry
  has a schema and a handler; revisit codegen when the surface grows.
- **In-memory MCP vs direct dispatch in the playground.** Direct dispatch is
  simpler; in-memory MCP gives byte-identical parity with external hosts (and a
  conformance test "same tool list over both transports"). Proposal: ship direct
  dispatch; add in-memory MCP only if parity drift becomes a real risk.
- **Streamable-HTTP transport.** A hosted Loom MCP endpoint (for web agents that
  can't run a subprocess) is a later transport over the same catalog; out of
  scope for v1.
- **Multi-file (`import`) models.** The toolkit is single-source today; tools
  inherit that. A `{ files: Record<path,source> }` input is the multi-file
  extension when the toolkit gains project-aware parsing.
- **Write-capable tools.** Kept out of v1 deliberately (tools are
  side-effect-free). If a host ever wants `generate-to-disk`, it's a separate,
  consent-gated tool — not folded into `loom_generate`.

## 8. Build order

1. `src/tools/` catalog (`loom_validate` / `loom_apply_patch` / `loom_generate`
   / `loom_outline`) + a completeness test (every entry has schema + handler;
   handlers round-trip against the toolkit).
2. `packages/ddd-mcp/` stdio server registering the catalog; smoke test via the
   MCP SDK's in-memory client (list tools, call `loom_validate`).
3. *(separate slice)* playground agentic chat: catalog dispatch + LLM wiring +
   key handling + apply-to-editor.
