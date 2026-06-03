# AI authoring loop — agent, validate/repair, model patches

> **Status:** PROPOSED / spec — no code yet.
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

The agent is an LLM with exactly these tools. Each wraps an existing pipeline
entry point and returns JSON (contract in the companion doc):

| Tool | Wraps | Returns |
|---|---|---|
| `read_model` | `src/language/print/` (IR→`.ddd`) | canonical model text + a structural outline (contexts/aggregates/pages) |
| `apply_patch` | new (§4) | patched model text, or a patch-conflict error |
| `validate` | `ddd parse` / phases ②③④⑦ | `diagnostics[]` (errors + warnings, located, with `fixHint`) |
| `generate` | `ddd generate system` | `files[]` summary + `ok` (or surfaced generation errors) |
| `verify` | `ddd verify` (`src/verify/`) | per-requirement `verdicts[]` |
| `conformance` | the parity harness | cross-backend `parity[]` diffs |
| `list_primitives` | `src/language/walker-stdlib.ts` | the closed page-primitive catalog (for page bodies) |

Design rules:

- **The agent never sees generated code.** Its world is the model and the four
  structured result streams. This is what keeps its context small and its
  edits reviewable.
- **`validate` is the hot path** and must be cheap. Run it client-side
  (§6) so the inner repair loop has no network latency.
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

Supported `op`s: `add`, `replace`, `remove`, `rename`. `target` uses the same
fully-qualified addressing the printer emits (`<context>.<decl>` /
`<aggregate>.<member>`), so the agent can name any node it just read.

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

1. **Diagnostics/result JSON contract** — implement `--json` on `ddd parse`
   and `ddd generate` per [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md).
   (Loom already produces structured diagnostics internally; this is surfacing,
   not inventing.) *Gate:* a golden-file test pinning the JSON for a known-bad
   and known-good model.
2. **Model context-pack** — generate the system-prompt bundle from `examples/`
   + the validator code registry. *Gate:* a frontier model emits a valid
   `Order`/`Wallet`/`checkout` model zero-shot (validated by tool #1).
3. **Patch apply** (§4) — implement `apply_patch` over the AST + printer.
   *Gate:* round-trip property test (apply → print → re-parse → identical AST)
   and a canonical-diff test (unrelated nodes byte-unchanged).
4. **Agent driver** — wire the tool surface (§3) into a loop: draft patch →
   `validate` → repair until clean → `generate` → `verify`/`conformance` →
   present model diff. Run `validate`/`generate` client-side (§6).
5. **The demo** — prose → AI-authored `.ddd` → Hono + .NET + React with the
   conformance harness green → review *the model diff* → show the `.loom/`
   audit bundle. *Gate:* the whole loop runs in the playground end-to-end.

Items 1–3 are independently useful (they also enable the IR-first
`@loom/core` embedding story in `ai-generation-platform.md` §4.4), so the plan
delivers value before item 5.

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
