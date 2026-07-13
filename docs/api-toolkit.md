# API toolkit

`src/api/` is the **transport-neutral toolkit** — one in-memory implementation of every structured operation over a `.ddd` source (`validate`, `generate`, `outline`, `applyPatches`, plus the navigational/refactor family). Every surface — the CLI (`src/cli/`), the MCP server (`packages/ddd-mcp` via `src/tools/`), the LSP adapters (Monaco/VS Code), and the in-browser playground (`web/`) — is a thin adapter over it, so the operation set never drifts per surface. The wire shapes it returns are pinned once in `src/diagnostics/contract.ts` ([D-API-TOOLKIT](decisions.md)).

It is **browser-safe by construction**: every entry point parses in-memory on Langium's `EmptyFileSystem` (no `langium/node`, no `fs`, no Node-only imports), so `web/` imports `../src/api` straight into the browser worker.

## Why it exists

The structured operations were growing inside `src/cli/` (Node-bound), but the *same* operations are needed by at least four surfaces. Re-implementing per surface is exactly the drift the structured contract exists to prevent, and the patch/diagnostic format is *Loom's own* ([`ai-diagnostics-contract.md`](old/proposals/ai-diagnostics-contract.md)), not an editor/agent standard — so it needs one authoritative implementation plus thin adapters at the boundaries. The toolkit is that core; the CLI shrank to argv + stdout + exit-code wrappers, and `applyPatches` moving from `NodeFileSystem` to `EmptyFileSystem` restored the "`src/language/` is browser-safe" invariant.

## The entry points

All live in `src/api/index.ts`. Signatures (verified against source):

```ts
// Generative family — pure functions of source
validate(source: string, opts?: { path?: string }): Promise<ValidateReport>
generate(source: string, opts?: { path?: string }): Promise<GenerateReport>
outline(source: string): Promise<Outline>
applyPatches(source: string, patches: ModelPatch[]): Promise<PatchResult>   // re-exported from src/language/model-patch.ts

// Navigational read family (src/api/navigate.ts) — address nodes by symbol name
findSymbol(source: string, symbol: string, kind?: string): Promise<FindSymbolResult>
references(source: string, symbol: string): Promise<ReferencesResult>
hover(source: string, symbol: string): Promise<HoverResult>

// Rewrite family (src/api/refactor.ts) — RETURN edits, never apply them
rename(source: string, symbol: string, newName: string): Promise<RenameResult>
quickfix(source: string, code: string, at?: string): Promise<QuickfixResult>
unfoldMacro(source: string, macro: string, on: string): Promise<UnfoldMacroResult>
```

`validate` runs the Langium phases (lex → parse → link → AST-validate) **and** the IR validator (lower → enrich → IR-validate), then returns the full `ValidateReport`. A parse/lex error short-circuits the IR phases — the AST is incomplete and lowering could throw — and any internal IR failure is surfaced as a single `loom.ir-internal` diagnostic rather than a thrown exception. `generate` adds the deployable manifest (name / platform / port) but **writes no files** — file emission stays in the CLI's `generate system -o`. `outline` is cheap (parse + walk, no IR phases) and always returns a valid object, even on a broken AST.

The diagnostic/outline serializers themselves live in `src/api/report.ts` (`buildValidateReport`, `buildGenerateReport`, `langiumDiagnosticToJson`, `irDiagnosticToJson`, `sortDiagnostics`) — pure, no Node imports. `sortDiagnostics` gives a total deterministic order (CST-ranged diagnostics first by `(line, character)`, then rangeless IR diagnostics, tie-broken by `(code, node)`) so two runs over the same model are byte-identical. `LOOM_VERSION` (`"0.1.0"`) is the single source for the report `loomVersion` field and the CLI `.version()`.

## The wire contract

`src/diagnostics/contract.ts` is **pure types, zero imports** — the shared shape both the CLI `--json` mode and the browser `validate` tool speak, so neither can drift. Key shapes:

`ValidateReport` — `parse --json` / `validate --json`:

```ts
interface ValidateReport {
  loomVersion: string;
  model: string;              // the source path / "<source>"
  ok: boolean;                // true iff no diagnostic has severity "error"
  summary: { errors: number; warnings: number; infos: number };
  diagnostics: JsonDiagnostic[];
  outline: Outline;           // always present, even on a failing model
}
```

`JsonDiagnostic` — one diagnostic, normalized across all phases:

```ts
interface JsonDiagnostic {
  code: string;               // stable machine id, e.g. "loom.bare-aggregate-in-type"
  severity: "error" | "warning" | "info";
  phase: "parse" | "macro-expand" | "scope-link" | "ast-validate" | "ir-validate" | "generate";
  message: string;
  node?: string;              // canonical address "<keyword> <Context>.<Decl>[.<member>]"
  range?: JsonRange;          // present for CST-backed diagnostics; absent for IR ones
  sourceText?: string;        // the offending source slice
  fixHint?: JsonFixHint;      // repair affordance in MODEL terms (carries a ModelPatch)
  related?: JsonRelated[];
}
```

`GenerateReport` is `ValidateReport` minus `outline`, plus `deployables: GenerateDeployable[]` (`{ name, platform, port? }`). `Outline` is the node address book — `{ systems: OutlineSystem[]; contexts: OutlineContext[] }`, each context listing its aggregates / valueObjects (each an `OutlineDecl` of `{ node, members[] }`) plus workflows / views / pages / enums / events / repositories — the same address space `node` and `ModelPatch.target` use.

The contract also pins the navigational results: `FindSymbolResult = NavSymbol | NavError`, `ReferencesResult`, `HoverResult`, and the rewrite results `RenameResult | QuickfixResult | UnfoldMacroResult` (each an `EditResult { edits: NavTextEdit[]; title? }` or an `EditError`). An unresolved or ambiguous symbol returns `NavError` with candidate addresses — never a silent pick.

## A concrete round trip

A `.ddd` source with a cross-aggregate bare type reference (which the scope provider forbids):

```ddd
system Shop {
  context Sales {
    aggregate Order { line Item }
  }
}
```

`await validate(src)` returns:

```json
{
  "loomVersion": "0.1.0",
  "model": "<source>",
  "ok": false,
  "summary": { "errors": 1, "warnings": 0, "infos": 0 },
  "diagnostics": [
    {
      "code": "loom.bare-aggregate-in-type",
      "severity": "error",
      "phase": "ast-validate",
      "message": "...",
      "node": "aggregate Sales.Order.line",
      "range": { "start": { "line": 2, "character": 23 },
                 "end":   { "line": 2, "character": 27 } },
      "sourceText": "line Item"
    }
  ],
  "outline": { "systems": [ { "name": "Shop", "contexts": [ /* … */ ], "deployables": [] } ], "contexts": [] }
}
```

(Exact `message` and ranges come from the live validator; the *shape* is what's pinned.)

## Adapters, not re-implementations

| Surface | Home | What it does over the toolkit |
|---|---|---|
| **CLI** | `src/cli/main.ts` | imports `validate` / `generate` / `LOOM_VERSION`; adds argv parsing, stdout, exit codes, and file emission. |
| **Agent tools** | `src/tools/catalog.ts` | wraps each toolkit fn in a `{ name, inputSchema, handler }` entry; `callTool(name, args)` dispatches to the handler. |
| **MCP server** | `packages/ddd-mcp` / `src/mcp/` | registers the `src/tools/` catalog over the Model Context Protocol — transport wiring only, no tool logic. |
| **LSP / editors** | `src/api/lsp.ts` | converts the contract shapes into what Monaco/VS Code speak: `toLspDiagnostic(s)`, `fixHintCodeActions` (`fixHint → CodeAction`), `ModelPatch → TextEdit[]`. |
| **Web playground** | `web/` | imports the toolkit (and the `src/tools/` catalog) straight from `../src` — same code, in the browser worker. |

### Relation to the agent-tool catalog

`src/tools/` (documented in [`mcp.md`](mcp.md)) is a strictly thinner layer *over* this toolkit, not a parallel implementation. Each `loom_*` tool — `loom_validate`, `loom_generate`, `loom_outline`, `loom_apply_patch`, plus the navigational `loom_find_symbol` / `loom_references` / `loom_hover` / `loom_rename` / `loom_quickfix` / `loom_unfold_macro` — is a JSON-Schema-described wrapper whose `handler` just calls the matching `src/api/` function and returns its contract shape. The catalog adds the agent-facing schema and the `callTool` dispatch; it adds no operation logic. The toolkit owns *what an operation does and what it returns*; the catalog owns *how an agent names and invokes it*. Both stay browser-safe, side-effect-free, and deterministic — file emission lives only in the CLI, never in a tool or a toolkit function.
