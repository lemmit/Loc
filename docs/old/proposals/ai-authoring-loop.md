# AI authoring loop — agent, validate/repair, model patches

> **[2026-06-20 status audit]** Header lags body — fixHint patches (`src/language/fix-hints.ts`), the agent driver `runAgent` (`src/tools/agent-loop.ts`), and the MCP server (`src/mcp/main.ts`, `packages/ddd-mcp/`) have SHIPPED. Remaining = the wedge demo + the playground chat UI.

> **Status:** PARTIAL. Shipped: the diagnostics half of the loop
> (`ddd parse --json`, build-plan items 1–2; see
> [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md)) and the
> **model-patch applier** (§4, build-plan item 3) — `ddd patch <file>
> --patches <json>` plus `applyPatches()` in `src/language/model-patch.ts`,
> with `add`/`replace`/`remove` ops, atomic batches, CST-range splicing that
> preserves untouched bytes, and a round-trip gate
> (`test/language/model-patch.test.ts`). `rename` is deferred (it needs
> reference rewriting). Still to come: `fixHint` patches keyed to diagnostics,
> the agent driver (build-plan item 4), and the wedge demo (item 5).
> **Role:** Specifies the mechanics behind
> [`ai-generation-platform.md`](./ai-generation-platform.md): how an LLM
> authors and evolves a `.ddd` model through Loom's existing compiler as a set
> of tools, how the validate→repair→verify loop converges, the model-patch
> protocol, the in-browser runtime wiring, and the concrete wedge build plan.
> **Depends on:** the machine-readable diagnostics/result contract in
> [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md). This doc
> defines the *loop and the agent*; that doc defines the *interface the loop
> consumes*.
> **Scope:** an authoring layer on top of the existing pipeline. No grammar/IR
> change. The CLI surface (`ddd parse/generate/verify`, `src/cli/main.ts`) and
> the browser toolchain (`web/`, importing `../src`) are the substrate; this
> spec adds (a) a JSON tool surface over them and (b) an agent that drives it.

---

## 1. Why the loop converges (the architectural argument)

An agentic generator is only as good as its feedback signal. Code-first
builders have one loose oracle ("it crashed somewhere"). Loom already ships
**two precise oracles**, both emitting *structured, located* signals:

- **Compile-time** — phases ② macro-expand, ③ scope/link, ④ AST-validate, ⑦
  IR-validate produce diagnostics with codes (e.g. `loom.bare-aggregate-in-type`)
  and source ranges.
- **Run-time** — `ddd verify` (`src/verify/`) joins test results onto the
  traceability graph for per-requirement verdicts, and the conformance harness
  (`docs/conformance.md`) diffs OpenAPI/wire shape across backends.

That is the difference between an agent that converges and one that thrashes:
Loom can tell the model *exactly* what is wrong and *where*, in the model, in
machine-readable form. The repair loop is bounded because the error surface is
bounded — and it is bounded because the model is ~10–20× smaller than the code
it generates.

---

## 2. The loop

```
user intent ("wallets can't go negative; confirming an order debits the wallet atomically")
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  AGENT                                                        │
  │  - reads current canonical model (via src/language/print/)   │
  │  - drafts a MODEL PATCH (§4), not whole-file, not code        │
  └─────────────────────────────────────────────────────────────┘
        │ apply patch → candidate .ddd
        ▼
  ddd validate --json   (phases ②③④⑦)
        │
   ┌────┴─────────────── diagnostics[] (codes + ranges + fixHints) ──────────┐
   │ (errors)                                                                │
   ▼                                                                         │
  AGENT repair: localised, because each diagnostic names a node + range ─────┘
   │ (clean)
   ▼
  ddd generate system --json   (phases ⑤⑥⑧⑨⑩)  → file map (4 stacks)
   │
   ▼
  live preview  +  ddd verify --json  +  conformance diff
        │
   ┌────┴──────────── verdicts[] / parity[] ──────────┐
   │ (fail)                                           │
   ▼                                                  │
  AGENT repair against verdicts ─────────────────────┘
   │ (green)
   ▼
  present MODEL diff (not code) → user approves → ship + .loom/ audit bundle
```

Two repair channels (compile-time, run-time) feed the same agent. Both are
structured per [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md);
neither requires the agent to read generated code.

---

## 3. Tool surface for the agent

The tools are **one transport-neutral toolkit** (`src/api/`,
[D-API-TOOLKIT](../../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface)),
exposed across surfaces by thin adapters. The operation set lives in one place
so it never drifts per surface:

| Tool | Toolkit fn | Returns | Status |
|---|---|---|---|
| `validate` | `validate(source)` | `ValidateReport` — located, coded, phase-attributed `diagnostics[]` (with `fixHint`) + `outline` | **shipped** |
| `apply_patch` | `applyPatches(source, patches)` | `PatchResult` — patched text, or a patch-conflict error (§4) | **shipped** |
| `generate` | `generate(source)` | `GenerateReport` — `ok` + the deployable manifest | **shipped** |
| `read_model` | (canonical print) `src/language/print/` | canonical model text + the `outline` address book | partial (outline shipped) |
| `verify` | `ddd verify` (`src/verify/`) | per-requirement `verdicts[]` | planned |
| `conformance` | the parity harness | cross-backend `parity[]` diffs | planned |
| `list_primitives` | `src/language/walker-stdlib.ts` | the closed page-primitive catalog | planned |

**Transports (thin adapters over the toolkit):**

| Surface | Status | Notes |
|---|---|---|
| **CLI** | shipped | `ddd parse --json` / `generate system --json` / `patch --patches` |
| **LSP / editor** (Monaco, VS Code) | shipped | `toLspDiagnostic` / `toLspDiagnostics` / `fixHintCodeActions` + `resolvePatchEdits` in `src/api/lsp.ts` (`ModelPatch → TextEdit/WorkspaceEdit`); plus the `loom.bare-aggregate-in-type` quick-fix in the live LSP provider (`ddd-code-actions.ts`), so it appears in the playground + VS Code now |
| **MCP server** (`ddd-mcp`) | planned | declared tool handlers — the recognized way agents call tools; the agent-driver's foundation |
| **Web playground** | available | imports the toolkit directly (`../src/api`, browser-safe) |

Design rules:

- **The agent never sees generated code.** Its world is the model and the
  structured result streams. This is what keeps its context small and its
  edits reviewable.
- **`validate` is the hot path** and must be cheap. The toolkit parses on
  `EmptyFileSystem`, so it runs client-side (§6) with no network latency.
- **Tools are pure functions of the model.** No hidden state; re-running
  `validate` on the same model is deterministic, matching the compiler's
  determinism guarantee.

---

## 4. The model-patch protocol

The agent edits *models incrementally*, never regenerates them wholesale.
Whole-file regeneration is how code-first builders lose stability; a patch
protocol preserves the "exactly-derivable diff" property.

### 4.1 Patch granularity

Patches address **named model nodes**, not byte ranges, so they survive
reformatting and are robust to the model being re-printed canonically:

```jsonc
{
  "patches": [
    {
      "op": "add",
      "target": "context Sales",            // structural address
      "kind": "aggregate",
      "source": "aggregate Wallet with crudish {\n  ownerId: Customer id\n  balance: Money\n  invariant balance.amount >= 0\n  operation debit(amount: Money) {\n    precondition balance.amount >= amount.amount\n    balance := Money { amount: balance.amount - amount.amount, currency: balance.currency }\n    emit WalletDebited { wallet: id, amount: amount, at: now() }\n  }\n}"
    },
    {
      "op": "replace",
      "target": "workflow Sales.checkout",
      "source": "workflow checkout(customerId: Customer id, walletId: Wallet id, productId: Product id, qty: int) transactional {\n  let wallet = Wallets.getById(walletId)\n  wallet.debit(totalPrice)\n  let order = Order.create({ customerId, status: Draft })\n  order.addLine(productId, totalPrice, qty)\n  order.confirm()\n}"
    }
  ]
}
```

Supported `op`s: `add` (append a member to a free-body container), `replace`,
`remove`, and `insert` (position-aware: `before`/`after` a sibling, or
`header-end` — just before the target declaration's opening `{`, for header
clauses like `inheritanceUsing(...)`). `rename` is still deferred (it needs
reference rewriting). `target` uses the same fully-qualified addressing the
printer emits (`<context>.<decl>` / `<aggregate>.<member>`), so the agent can
name any node it just read.

### 4.2 Apply semantics

1. Parse the patch; resolve each `target` against the current AST.
2. Splice via the printer's canonical forms (so the result is always
   canonically formatted — no whitespace drift between agent edits).
3. Re-print the whole model canonically. The *diff the user reviews* is the
   canonical model diff — minimal and semantic, never reformatting noise.
4. Hand the patched model to `validate`.

### 4.3 Why patches, not prose-regeneration

- **Bounded blast radius.** A patch touches named nodes; unrelated parts of the
  model (and therefore unrelated generated code across all four stacks) are
  provably untouched.
- **Reviewability.** Approvals happen at model granularity. "Add `Wallet` + a
  `debit` operation + thread it through `checkout`" is three patch entries the
  user can read, not a 40-file code diff.
- **Determinism preserved end-to-end.** Patch → canonical model → deterministic
  codegen means the same conversation replays to the same system.

---

## 5. Making the LLM author valid `.ddd`

The single biggest technical risk (`ai-generation-platform.md` §5.2) is that
`.ddd` is scarce in training data. Three compounding mitigations, in order of
leverage:

1. **The grammar is closed and small.** Unlike "write a React app," the target
   space is a Langium grammar plus a *closed* page-primitive library
   (`src/language/walker-stdlib.ts`, pinned by
   `walker-stdlib-completeness.test.ts`). This makes **grammar-constrained /
   structured decoding tractable** — generation can be pinned to syntactically
   valid `.ddd` before a single token reaches the compiler. Ship the grammar in
   a constrained-decoding-friendly form (GBNF or a JSON-schema'd patch
   envelope) as part of `@loom/core`.
2. **A model context-pack.** A curated system-prompt/tool-spec bundle: the
   declaration vocabulary, the validation codes and what they mean, the closed
   primitive list, and a handful of canonical idioms (an aggregate with an
   invariant + operation, a transactional workflow, a scaffolded page, a view
   with a `bind` projection). Derived mechanically from `examples/` and the
   validator so it never drifts from the language.
3. **The typed repair loop is the safety net.** Even an imperfect draft
   converges, because every diagnostic is located and carries a `fixHint`
   (companion doc). Constrained decoding handles *syntax*; the repair loop
   handles *semantics* (unresolved refs, type mismatches, cross-aggregate
   rules like `loom.bare-aggregate-in-type`).

A small fine-tune on `examples/` + generated model/patch pairs is a later
optimisation, not a prerequisite.

---

## 6. In-browser runtime wiring

Loom has a quietly large asset: **the toolchain already runs in the browser.**
`web/` imports the compiler straight from `../src` (pure TS, no Node-only APIs
outside `src/cli/` and `src/language/main.ts`), with a Vite shim swapping
`_packs/loader-fs.js` for a VFS-backed loader, and the playground already does
editor → generate → bundle → boot → preview.

Consequences for the loop:

- **`validate` and `generate` run client-side, in-session, no server
  round-trip.** The inner repair loop (the hot path) has zero network latency.
- **The compiler is the fast repair oracle**; only the LLM call needs the
  network. This is the spine of a responsive AI-platform UX, already built.
- **Privacy posture.** Models can be validated and generated entirely on the
  client; only the prose↔patch turn touches a model provider (and even that can
  be a local/edge model for sensitive deployments).

The remaining build is the **agent driver** and the **JSON tool surface**, not
a new runtime.

---

## 7. Wedge build plan

Concrete, ordered, mostly assembly over existing parts. Target: the demo in
`ai-generation-platform.md` §6.

1. ✅ **Diagnostics JSON contract** — `ddd parse --json` (PRs #863/#865):
   located, coded (`loom.*`), phase-attributed diagnostics + `outline`.
2. ✅ **Patch apply** (§4) — `applyPatches` + `ddd patch` (PR #871):
   node-addressed `add`/`replace`/`remove`, atomic, byte-preserving, round-trip
   gated.
3. ✅ **fixHint** (§3.3) — diagnostics carry an applyable `ModelPatch`; the
   validate→repair loop is proven closed end-to-end (PR #873).
4. ✅ **Transport-neutral toolkit + `generate --json`** — the `src/api/` core
   ([D-API-TOOLKIT](../../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface))
   + the `GenerateReport` (PR #877).
5. ✅ **LSP / editor adapters** — `src/api/lsp.ts` (`toLspDiagnostic[s]`,
   `fixHintCodeActions`, `resolvePatchEdits`) + the `loom.bare-aggregate-in-type`
   quick-fix wired into the live LSP provider, so squiggles + quick-fixes show
   in the playground's Monaco editor and VS Code now. Gated by converter and
   provider tests (apply-the-edit → clean re-validate).
6. **MCP server (`ddd-mcp`)** *(next)* — declared tool handlers (`validate`/`patch`/
   `generate`/`verify`) over the toolkit; the recognized way agents call tools
   and the agent-driver foundation.
7. **Model context-pack** — system-prompt bundle from `examples/` + the
   validator code registry. *Gate:* a frontier model emits a valid
   `Order`/`Wallet`/`checkout` model zero-shot (validated by `validate`).
8. **Agent driver** — wire the tool surface (§3) into a loop: draft patch →
   `validate` → repair until clean → `generate` → `verify`/`conformance` →
   present model diff. Runs client-side (§6).
9. **The demo** — prose → AI-authored `.ddd` → Hono + .NET + React with the
   conformance harness green → review *the model diff* → show the `.loom/`
   audit bundle. *Gate:* the whole loop runs in the playground end-to-end.

Items 1–5 are independently useful (the diagnostics/patch/fixHint/toolkit core
also powers the editor and the IR-first `@loom/core` embedding story in
`ai-generation-platform.md` §4.4), so the plan delivers value well before the
end-to-end demo.

---

## 8. Open questions

- **Patch addressing under rename.** A `rename` op changes the address space
  mid-conversation; define whether subsequent patches in the same batch see
  pre- or post-rename addresses (proposal: patches apply sequentially, later
  entries see earlier renames).
- **Multi-edit transactions.** Should a batch of patches validate atomically
  (all-or-nothing) or incrementally? Proposal: atomic — validate the fully
  patched model once, so cross-node consistency (e.g. a new aggregate + the
  workflow that references it) is checked together.
- **Verify without a runtime.** `ddd verify` consumes test-run results; in a
  pure in-browser session, decide whether to run generated tests in-browser, in
  a sandboxed worker, or defer `verify` to a server tier.
- **Agent visibility into generated code.** Default is *never*; an advanced
  "explain the generated handler" affordance may read code for the *user*
  without feeding it back into the agent's authoring context (keep the two
  contexts separate to preserve the no-context-rot property).
