# AI diagnostics contract — `ddd validate --json` and friends

> **[2026-06-20 status audit]** Stale impl path — there is no `src/cli/json-report.ts`; the JSON report lives in `src/api/report.ts` (+ `src/diagnostics/contract.ts`), driven by `runParseJson` in `src/cli/main.ts`.

> **Status:** PARTIAL — slice 1 shipped. `ddd parse --json` emits the
> `ValidateReport` envelope (§2): located/coded/phase-attributed `diagnostics[]`
> from phases ①③④⑦, deterministic ordering (§3.4), the always-valid envelope on
> parse failure (§6), and a name-only `outline` (§5). The flagship
> `loom.bare-aggregate-in-type` code is now actually emitted (it was previously
> comment-only). Implementation: `src/cli/json-report.ts`,
> `src/language/print/outline.ts`, `src/diagnostics/contract.ts`; gate:
> `test/cli/json-report.test.ts`. **Decision:** the contract names
> `ddd validate --json`; the shipped surface is **`ddd parse --json`** (the
> `parse` verb, extended under `--json` to also run the IR phases) — there is no
> separate `validate` verb. **Slice 2 shipped:** every IR diagnostic in
> `src/ir/validate/validate.ts` now carries a stable `loom.*` code (the
> `loom.ir-validate` fallback is now only a defensive net), gated by
> `test/ir/diagnostic-codes-completeness.test.ts`. **Slice 4 shipped:**
> `fixHint` (§3.3) — CST-backed diagnostics can carry an applyable `ModelPatch`,
> via a per-code provider registry (`src/language/fix-hints.ts`); the flagship
> `loom.bare-aggregate-in-type` ships a `replace-text` fix (robust for scalar
> and `[]` collection refs), and the validate→repair loop is proven closed
> end-to-end (diagnostic → fixHint → `applyPatches` → clean re-validate) in
> `test/language/fix-hints.test.ts`. More per-code providers are additive.
> **Slice 5 shipped:** `generate --json` (§4) — `ddd generate system --json`
> emits the `GenerateReport` (validation + the deployable manifest:
> name/platform/port; writes no files). Landed alongside a **transport-neutral
> toolkit** (`src/api/`): `validate()` / `generate()` / `applyPatches()` are now
> one shared core that the CLI, the future MCP server, the LSP adapters, and the
> in-browser playground all call (browser-safe, EmptyFileSystem) — see
> [D-API-TOOLKIT](../../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface).
> **Deferred to follow-up slices:** `related[]`, IR-diagnostic *ranges* and
> their fixHints (need CST provenance through lowering); per-deployable file
> counts + `.loom/` artifact paths in the GenerateReport; multi-file generate.
> **Role:** Defines the machine-readable interface the AI authoring loop
> consumes. The loop in [`ai-authoring-loop.md`](./ai-authoring-loop.md) and
> the platform vision in [`ai-generation-platform.md`](./ai-generation-platform.md)
> both rest on Loom emitting **structured, located, repairable** diagnostics
> and generation results as JSON. This doc pins the wire shape, the field
> semantics, the severity/phase model, and the `fixHint` design that lets an
> LLM repair without seeing generated code.
> **Precedent:** Loom already ships a structured *runtime* error wire format
> (RFC 7807 §3.2 `errors[]`, see
> [`validation-error-extension.md`](./validation-error-extension.md)). This
> proposal does the analogous thing for *compile-time* diagnostics: one stable,
> language-agnostic, diffable JSON contract.
> **Scope:** a `--json` output mode on the existing CLI verbs in
> `src/cli/main.ts` (`parse`, `generate`, `verify`) plus the equivalent
> in-browser entry point. No new analysis — Loom's phases ②③④⑦ already compute
> these diagnostics; this is a serialization contract over them.

---

## 1. Design goals

1. **Located.** Every diagnostic carries a precise source range so the agent
   can patch the *named node* it concerns (§4 of the authoring-loop doc).
2. **Coded.** Every diagnostic carries a stable machine code (`loom.<kebab>`),
   the same identifier used in the validators (e.g.
   `loom.bare-aggregate-in-type`), so agent behaviour and golden tests pin to
   codes, not message prose.
3. **Repairable without reading code.** A `fixHint` expresses the remedy in
   *model* terms, never generated-code terms — preserving the no-context-rot
   property.
4. **Deterministic & diffable.** Stable ordering and stable field shapes, so
   two runs over the same model produce byte-identical JSON (matching the
   compiler's determinism guarantee) and so result diffs are meaningful.
5. **Phase-attributed.** Each diagnostic names the pipeline phase that raised
   it, so the agent (and humans) can reason about *why* — a scope/link error
   (③) is a different repair class than an IR cross-aggregate error (⑦).

---

## 2. Top-level envelope

`ddd validate --json <file.ddd>` (alias for `parse --json` plus IR-level
phases) emits a single JSON object:

```jsonc
{
  "loomVersion": "0.1.0",
  "model": "examples/acme.ddd",
  "ok": false,                       // true iff no diagnostics of severity "error"
  "summary": { "errors": 2, "warnings": 1, "infos": 0 },
  "diagnostics": [ /* §3, sorted §3.4 */ ],
  "outline": { /* §5, present even when ok=false so the agent can address nodes */ }
}
```

- `ok` is the agent's loop condition: repair while `ok=false`.
- `summary` lets the agent (and CI) branch without scanning the array.
- `outline` is always present so the agent can resolve patch `target`
  addresses even on a failing model.

---

## 3. The diagnostic object

```jsonc
{
  "code": "loom.bare-aggregate-in-type",     // stable machine id
  "severity": "error",                        // "error" | "warning" | "info"
  "phase": "scope-link",                      // §3.2
  "message": "Type 'Customer' refers to another aggregate; use 'Customer id'.",
  "node": "aggregate Order.customer",         // canonical address (§5 addressing)
  "range": {                                  // 0-based, half-open, LSP-compatible
    "start": { "line": 42, "character": 13 },
    "end":   { "line": 42, "character": 21 }
  },
  "sourceText": "customer: Customer",          // the offending CST slice (free error context)
  "fixHint": {                                 // §3.3 — optional but strongly preferred
    "kind": "replace-text",
    "summary": "Reference the other aggregate by id.",
    "patch": { "op": "replace", "target": "aggregate Order.customer",
               "source": "customer: Customer id" }
  },
  "related": [                                 // optional secondary locations
    { "node": "aggregate Customer", "range": { /* … */ },
      "message": "'Customer' is declared here." }
  ]
}
```

### 3.1 Severity

- `error` — blocks generation; clears `ok`. (Phases ④/⑦ semantic failures,
  scope/link failures, parse errors.)
- `warning` — does not block, but the agent should attempt resolution (e.g. an
  unused declaration, a deprecated form).
- `info` — advisory (e.g. "this aggregate has no operations; consider
  `with crudish`"). Useful as *authoring nudges* the agent can act on
  proactively.

### 3.2 Phase attribution

`phase` is one of the pipeline phases that can raise a diagnostic, named for
the architecture in `docs/technical.md`:

| `phase` value | Pipeline phase | Typical codes |
|---|---|---|
| `parse` | ① parse | syntax errors (Langium) |
| `macro-expand` | ② macro expand | malformed `with X(...)` clauses |
| `scope-link` | ③ scope/link | unresolved refs, `loom.bare-aggregate-in-type` |
| `ast-validate` | ④ AST validate | type mismatches, precondition not `bool` |
| `ir-validate` | ⑦ IR validate | cross-aggregate / multi-file rules |

Generation-phase failures (⑤⑥⑧⑨⑩) should not occur on a model that passed
`ir-validate` — that is the architectural contract (validate-before-generate).
If one does, it is surfaced under §6 as a `generator-internal` error and is a
compiler bug, not a user-model error.

### 3.3 `fixHint`

The repair affordance. Optional, but every diagnostic that *can* carry one
*should*, because it is what makes the loop converge fast and keeps the agent
out of generated code. `kind`s:

| `kind` | Meaning | Carries |
|---|---|---|
| `replace-text` | a concrete model edit is known | a model `patch` (§4 of authoring-loop doc) |
| `insert-decl` | a missing declaration should be added | a `patch` with `op: "add"` |
| `choose` | several valid repairs exist | `options[]`, each a `{ summary, patch }` |
| `manual` | no mechanical fix; guidance only | `summary` prose only |

`fixHint.patch` uses the **same model-patch envelope** as the authoring loop,
so the agent can apply a suggested fix by handing the hint's `patch` straight
to `apply_patch` — no translation. This is the tight coupling that makes
single-shot repairs common rather than rare.

### 3.4 Ordering (determinism)

`diagnostics` is sorted by `(model-file, range.start.line, range.start.character,
code)`. Stable and total, so output is byte-identical across runs and golden
tests are trivial. Multi-file models (after `import`) sort by file path first.

---

## 4. `generate --json`

`ddd generate system --json <file> -o <out>` emits:

```jsonc
{
  "loomVersion": "0.1.0",
  "model": "examples/acme.ddd",
  "ok": true,
  "diagnostics": [ /* same diagnostic shape; normally empty on a validated model */ ],
  "deployables": [
    { "name": "api",       "platform": "dotnet", "files": 84, "port": 8080 },
    { "name": "catalogWeb","platform": "hono",   "files": 37, "port": 3000 },
    { "name": "webApp",    "platform": "react",  "files": 121, "port": 3001 }
  ],
  "artifacts": {
    "wireSpec": ".loom/wire-spec.json",
    "traceability": ".loom/traceability.json",
    "mermaid": [ ".loom/context-map.mmd" ]
  },
  "files": [ /* optional, behind --json-files: [{ path, bytes, deployable }] */ ]
}
```

- The agent uses `deployables` + `artifacts` to drive preview and to surface
  the audit bundle, without parsing the file tree.
- `files` is opt-in (`--json-files`) to keep the default payload small; the
  agent rarely needs per-file detail (it never reads generated code).

---

## 5. The `outline` and node addressing

The agent must be able to name any node it patches. `outline` is the address
book, emitted by the same printer that produces canonical `.ddd`
(`src/language/print/`):

```jsonc
{
  "systems": [{
    "name": "Acme",
    "contexts": [{
      "name": "Sales",
      "aggregates": [
        { "node": "aggregate Sales.Order",
          "members": ["aggregate Sales.Order.customerId",
                      "aggregate Sales.Order.status",
                      "operation Sales.Order.confirm"] }
      ],
      "workflows": ["workflow Sales.checkout"],
      "views": ["view Sales.OrderSummary"],
      "pages": ["page Sales.OrderConsole"]
    }]
  }]
}
```

Addressing rules:

- A node address is `<keyword> <qualified-name>`, qualified by enclosing
  context (and aggregate, for members). This is exactly what `diagnostic.node`
  and `fixHint.patch.target` use, so diagnostics, the outline, and patches all
  share **one address space**.
- Addresses are stable under canonical re-printing (they are name-based, not
  offset-based), so they survive the apply→print→re-read cycle in the
  authoring loop.

---

## 6. Error robustness

The contract must never hand the agent malformed JSON, even on internal
failure:

- **Parse failure (phase ①):** still returns the envelope with
  `ok:false` and `parse`-phase diagnostics; `outline` may be partial (best
  effort from the recovered CST) but is always a valid object.
- **Generator-internal failure:** a single diagnostic with
  `code:"loom.generator-internal"`, `severity:"error"`,
  `phase:"generate"`, and a `manual` `fixHint` pointing at the bug. The agent
  treats this as non-repairable and escalates to the user (it is a compiler
  defect, not a model defect).
- **Always-valid envelope:** the top-level object is schema-valid in every
  case, so the agent never needs to parse-or-catch raw stderr.

---

## 7. Relationship to existing surfaces

- **`verify --json`** reuses this envelope's `diagnostics` shape for any
  model-level issues, and adds a `verdicts[]` array (per-requirement
  pass/fail from `src/verify/`). Specified in the authoring-loop doc §3; the
  *diagnostic* shape is shared with this contract.
- **Conformance** parity diffs are a sibling structured stream (cross-backend),
  not diagnostics; they share the `node`/`range` location convention where
  applicable but live under their own `parity[]` array.
- **LSP.** The `range`/`severity` model is intentionally LSP-compatible
  (0-based, half-open ranges; `error`/`warning`/`info`), so the same diagnostic
  computation can feed the VS Code extension (`vscode/`) and the browser
  playground without divergence.

---

## 8. Open questions

- **Code registry as a single source.** Today validator codes live across
  `src/language/validators/*` and `src/ir/validate/`. A generated registry
  (code → { phase, default-severity, has-fixHint }) would let the context-pack
  (`ai-authoring-loop.md` §5.2) and golden tests stay in lockstep with the
  validators. Worth pinning whether the registry is hand-kept or derived.
- **`fixHint` coverage target.** Not every diagnostic can carry a mechanical
  fix, but the high-frequency authoring errors should. Propose a coverage
  gate: the N most-common codes (measured from the wedge demo) must ship a
  non-`manual` `fixHint`.
- **Streaming vs. batch.** For very large models, decide whether `validate`
  streams diagnostics (NDJSON) or returns them batched. Batch is simpler and
  matches the determinism/ordering goal; revisit only if latency demands it.
- **Versioning the contract.** `loomVersion` pins the producer; consider a
  separate `contractVersion` so the agent tool layer can evolve independently
  of the compiler version.
