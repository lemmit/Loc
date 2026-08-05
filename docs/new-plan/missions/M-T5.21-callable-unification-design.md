# M-T5.21 — Callable unification: one production for "a named body runs here" (design)

> **Status: PROPOSED — no code yet.** Grammar/IR/print refactor with a
> byte-identical-output gate; **no capability added, none removed.**
> Sources: language-size review 2026-08-04 (this doc's §Problem is its finding);
> `src/language/ddd.langium` (the fifteen callable-shaped rules enumerated
> below); [`docs/customization-gradient.md`](../../customization-gradient.md)
> (the depth this mission explicitly protects);
> [`surface-redundancy-cuts.md`](../../old/proposals/surface-redundancy-cuts.md)
> ("one spelling per concept" — the same principle, previously applied only to
> trivia). Relates to M-T5.17 (header-modifier normalization — same *class* of
> finding, one layer down), M-T5.18 (soft-keyword sprawl).

## Problem

Loom's language surface is large, and the reflex when reading the count is to
cut **depth** — drop custom handlers, keep aggregates + operations, land nearer
Naked Objects. That is the wrong axis, and this mission exists to name the
right one.

Two independent things get conflated:

| axis | what it is | verdict |
|---|---|---|
| **customization depth** | how far down an author can go before leaving the tool | **the moat — do not cut** |
| **carrier count** | how many *distinct constructs* express "a named body of statements runs here" | **the cost — cut this** |

Depth is the differentiator. Every comparable tool — Naked Objects, Django
admin, Retool, Rails scaffolding — dies at the same cliff, and
`customization-gradient.md` opens by naming it: *"you scaffold, you love it, you
need one custom screen, and you fall off into rewriting everything."* Delete
rungs 2–3 and Loom is a scaffolder competing on ecosystem maturity with a decade
of head start against it. The bet is *one model → eleven targets*, and depth is
what makes that survive contact with a real app.

The cost is somewhere else entirely: **fifteen grammar rules mean "a named body
of statements runs here"**, most of them the same shape forked by *where they
live*, each carrying an arbitrary subset of modifiers.

### The inventory (`src/language/ddd.langium`, verified against `de4955d`)

| rule | line | name production | params | return type | body form | modifiers |
|---|---|---|---|---|---|---|
| `Operation` | 1855 | `ID \| 'write'` | yes | optional | `{ stmts }` | `private` `extern` `audited` `requires` `when` |
| `Create` | 1867 | optional `ID` | yes | — | `{ stmts }` | `audited` |
| `Destroy` | 1878 | optional `ID` | optional | — | `{ stmts }` | `audited` |
| `Apply` | 1891 | — | 1 (event) | — | `{ stmts }` | — |
| `FunctionDecl` | 1844 | `ID` | yes | **required** | `= expr` \| `{ stmts }` | — |
| `CommandHandler` | 972 | `ID` | yes | optional | `{ stmts }` \| `;` | `extern` (prefix) |
| `QueryHandler` | 976 | `ID` | yes | **required** | `{ stmts }` \| `;` | `extern` (prefix) |
| `DomainServiceOperation` | 1717 | `ID \| 'write'` | yes | optional | `{ stmts }` | **none, by explicit exclusion** |
| `WorkflowCreateDecl` | 1458 | optional `ID` | yes | — | `{ stmts }` | `by` correlation |
| `HandleDecl` | 1473 | `ID` | yes | — | `{ stmts }` | `requires` |
| `OnDecl` | 1484 | — | 1 (event) | — | `{ stmts }` | `by` correlation |
| `ActionDecl` | 685 | `ID \| 'write'` | yes | — | `{ stmts }` | — |
| `UiFunction` | 647 | `ID` | yes | **required** | **extern-only** | `extern from` (mandatory) |
| `Component` | 779 | `ID` | yes | — | `{ decls }` | `extern from` (suffix) |
| `Criterion` | 1631 | `ID` | optional | (bool) | `= expr` | `of` target, `as` alias |

Four axes — name, params, return type, body form — and each rule picks a
different combination, with no semantic reason for most of the differences. The
grammar records the arbitrariness in its own comments:

- `DomainServiceOperation` (1712–1716): *"Does NOT carry `private` / `extern` /
  `audited` / `when` — those are aggregate-operation-only."* No reason given,
  because there isn't one — it is where the rule was forked.
- Workflow `function` reuses `FunctionDecl` but is validator-restricted to the
  expression form (`loom.workflow-function-block-body`) because *"a workflow
  body is not a class"* — a constraint enforced one layer away from the grammar
  that states it.

### Symptom 1 — `extern` has four spellings

One modifier, four syntactic positions:

```
extern commandHandler place(cmd: PlaceOrder) ;          // prefix        (972, 976)
operation cancel(reason: string) extern { … }           // infix, post-params (1855)
component Chart(series: Series[]) extern from "./chart" // suffix + path (779)
function fmt(m: Money): string extern from "./fmt"      // IS the body   (647)
```

An author who learns `extern` in one position cannot write it in another. This
is the M-T5.17 finding ("modifier zoo") one layer down, and it is worse here
because it repeats per carrier rather than per declaration header.

### Symptom 2 — `function` means three different things

`function` parses through `FunctionDecl` at five sites (grammar lines 23, 115,
994, 1140, 1328, 1449) — and through a *separate* rule, `UiFunction` (647),
inside `ui`. So:

- aggregate/valueobject `function` — expression **or** block body, pure helper
- workflow `function` — expression body only (validator-gated), inlined at call sites
- ui `function` — **extern only**, must carry a `from` path

Same keyword, three capability sets, two grammar rules.

### Symptom 3 — the fork leaks into diagnostics

The duplicate `loom.*` codes found in the same review are not a naming problem;
they are the carrier fork surfacing downstream. Every one of these pairs is
**one rule** stated twice because the *carrier* was stated twice:

```
loom.emitted-event-no-applier      ↔ loom.workflow-emitted-event-no-applier
loom.applier-on-non-event-sourced  ↔ loom.workflow-applier-on-non-event-sourced
loom.duplicate-applier             ↔ loom.workflow-duplicate-applier
loom.event-sourced-direct-mutation ↔ loom.workflow-event-sourced-mutation
loom.create-unknown-field          ↔ loom.workflow-create-unknown-field
loom.unknown-name                  ↔ loom.workflow-unknown-name
```

The same shape recurs in `lower/` (per-rule lowerers with near-identical param
/ return / body handling), in `print-structural.ts` (one arm per rule —
`print-completeness.test.ts` makes every fork a mandatory extra arm), and in
each backend's emitters.

### Symptom 4 — some forks never earned their keep

Usage across every `.ddd` in the repo (test/example-biased — **not** adopter
data, and the mission should re-measure before acting on it):

| construct | `.ddd` files |
|---|---|
| `operation` | 188 |
| `workflow` | 71 |
| `commandHandler` / `queryHandler` | 7 |
| `domainService` | 4 |

`commandHandler` / `queryHandler` appear nowhere in
[`docs/language.md`](../../language.md) — they are documented only in proposals
(`extern.md`, `unfoldable-api-derivation.md`, and this plan). `domainService`,
by contrast, has a worked three-tier justification in
[`docs/domain-services.md`](../../domain-services.md); its low count reads as
*young*, not redundant.

**The usage table is a prompt to ask the question per carrier, not a licence to
delete the low rows** — and the handler row is the worked example of why. Its
seven files are five `scaffold-handlers` *build fixtures*, one `extern-handlers`
corpus fixture, and one explicit-handler test: handlers are barely
hand-written, but they sit on the **macro output path**. `scaffoldHandlers`
(`target: "context"`) synthesises one per create / operation / find / get-by-id
for every aggregate in the host context, so every `with scaffoldHandlers`
context emits them. Low authorship ≠ low load-bearing. See §Open question 4 for
the dispositions this leaves.

## Why this is the cheap fix

Under the standing policy — **no permanent skips; every target supports the
whole surface** — each *modeled* construct is a permanent eleven-target
obligation. The cost of the language is therefore not `keywords`, it is
`carriers × targets`. Cutting depth reduces the first factor by destroying the
product's reason to exist. Cutting carrier duplication reduces it for free.

There is already precedent in this repo for exactly this move, at every other
layer of the pipeline:

- `src/generator/_expr/target.ts` — one 17-arm `ExprIR.kind` dispatcher, five
  backend **leaf tables** instead of five dispatchers (#843, byte-identical gate).
- `src/generator/_walker/target.ts` — one walker core, six framework targets.
- `src/generator/_type/target.ts`, `_workflow/stmt-target.ts` — same pattern.
- `FunctionDecl` itself is already one rule instantiated at five sites.

This mission applies the established pattern to the **grammar** layer, which is
the one place it has not been applied.

## Proposal

**One `Callable` production; the differences become declared data.**

```
Callable:
    modifiers+=CallableModifier*
    kw=CallableKeyword name=CallableName?
    '(' (params+=Parameter (',' params+=Parameter)*)? ')'
    (':' returnType=TypeRef)?
    clauses+=CallableClause*
    body=CallableBody;

CallableBody:  '{' stmts+=Statement* '}'  |  '=' expr=Expression  |  ';' ;
```

Every site — `operation`, `create`, `destroy`, `apply`, `function`,
`commandHandler`, `queryHandler`, `handle`, `on`, `action`, domain-service
`operation` — instantiates it. What differs per site is a **legality table**,
not a rule:

```ts
// src/language/callable-sites.ts  (new)
export const CALLABLE_SITES = {
  "aggregate.operation": {
    keyword: "operation",
    name: "required-or-write",
    returnType: "optional",
    body: ["block"],
    modifiers: ["private", "extern", "audited"],
    clauses:   ["requires", "when"],
  },
  "domainService.operation": { /* … same shape; a different modifier set */ },
  "workflow.handle":         { /* … */ },
  // …
} as const satisfies Record<string, CallableSite>;
```

One validator (`loom.callable-modifier-not-allowed-here`) reads the table and
reports *"`audited` is not allowed on a domain-service operation"* — replacing
today's silent grammar-level exclusion, which an author discovers as a parse
error with no explanation.

### Rules for the table

1. **A difference must be justified in the table's comment or it is deleted.**
   The exclusions inherited from today's forks (`domainService` has no
   `private`/`extern`/`audited`/`when`) get re-derived, not copied. Several will
   not survive contact with the question.
2. **`extern` gets one spelling.** Prefix, uniformly, with `from <path>` where a
   path applies. The other three positions become deprecated-then-removed
   spellings (§Migration).
3. **A new behavior site costs a table row**, not a grammar rule + a lower
   branch + a print arm + five emitter arms.

### What this explicitly does NOT change

- **No rung of the customization gradient is removed.** Rungs 0–3 of
  `customization-gradient.md` all still work, unchanged, at the source level.
- **No capability is lost.** Every program that parses today parses after
  Phase 1 (§Migration).
- **No emission changes.** The gate is byte-identical output across all eleven
  targets — the same gate that guarded #607–#627 and #843.
- **`Criterion` and `Component` stay separate.** `criterion` carries `of
  <target>` / `as <alias>` and lowers by inlining at call sites; `component`
  returns markup, not a value. Both are callable-*shaped* but not callable-*kind*;
  folding them in would be the mistake this mission warns against.

## Migration

Source-compatible by construction — this is a grammar *refactor*, not a surface
change.

**Phase 1 — unify, accept everything (no author-visible change).**
`Callable` + `CALLABLE_SITES` land; every legacy spelling stays legal, including
all four `extern` positions. Gate: byte-identical emitted output for the corpus
+ examples on all eleven targets, and `print-structural-roundtrip.test.ts` green.

**Phase 2 — collapse the diagnostic forks.** The six `loom.workflow-*` /
`loom.*` pairs above merge to the non-prefixed code (context comes from the node
location, which the diagnostic already carries). Coordinate with the
diagnostics-registry mission so each retirement is one registry row.

**Phase 3 — one `extern` spelling.** The three non-prefix positions become
warnings (`loom.extern-legacy-position`, with a fix hint — `fix-hints.ts`
already has the machinery), then hard errors one release later. Corpus
codemodded in the same PR, per the M-T5.17 Phase-2 precedent.

**Phase 4 — re-derive the exclusions.** Walk `CALLABLE_SITES` row by row and
either justify each exclusion in a comment or delete it. §Open question 4 is the
first row to walk.

## Sizing, sequencing, gates

- **Size: L** — a PR stack. Phase 1 is the large one (grammar + `langium:generate`
  + `lower/` + `print-structural.ts` + validators); Phases 2–4 are S–M each.
- **Priority: P2.** Not user-visible, but it lowers the marginal cost of every
  future behavior site — and under the no-skips policy that marginal cost is
  paid eleven times, permanently.
- **Gates:** `langium-generated.yml` (committed parser output must be
  deterministic), `print-completeness.test.ts` + `print-structural-roundtrip.test.ts`,
  the byte-identical-output comparison over `test/fixtures/corpus/*.ddd` on all
  eleven targets, and `corpus-build.yml` per backend.
- **Mutation-prove it:** per CLAUDE.md, Phase 1's byte-identity gate must be
  shown to FAIL when a single callable's lowering is perturbed — a green first
  run on a refactor of this size proves nothing.

## Open questions

1. **Does `apply` / `on` belong?** Both are event-parameterized and unnamed —
   `name: "none"`, `params: "single-event"` in the table. Plausible rows, but
   they may be better modeled as an event-reactor kind that *contains* a
   callable body rather than *being* one. Settle in Phase 1 design.
2. **Where does the table live?** `src/language/callable-sites.ts` keeps it
   language-layer, but the IR lowerers and `print-structural.ts` both want it.
   If a third consumer appears it belongs in `src/util/` — the pack-identity
   precedent (CLAUDE.md, "a shared helper belongs at the layer its consumers
   live at").
3. **Is `Create`/`Destroy`'s optional name worth keeping?** Three of the fifteen
   rules allow an unnamed form. Uniformity says no; `destroy { }` reading well
   says yes. Cosmetic — decide with the table, not before it.

4. **Do `commandHandler` / `queryHandler` stay two keywords?** The dispositions,
   with the two that are already ruled out:

   | | disposition | verdict |
   |---|---|---|
   | **A** | keep both keywords; they become two `CALLABLE_SITES` rows, the rules are deleted | **default** — zero user-visible change, cost is two rows |
   | **B** | one `handler` keyword, command-vs-query **derived** from the body | **no** — see below |
   | **B′** | one `handler` keyword + a `readonly` modifier row | **the only cut worth evaluating** |
   | **C** | demote to a context-level `operation` | **no** — `operation` would mean two things by site |
   | **D** | keep them, unexported from the author surface (macro-internal) | **not viable** — see below |

   **Why not B.** The compiler already derives the split: `handlerMutates()`
   (`src/ir/validate/checks/api-checks.ts:36`) walks the body for
   saves / emits / op-calls / creates / assignments, and `aggregatesTouched()`
   counts aggregates — the same shape as `classifyDomainServiceTier`. So the
   keyword carries no information the compiler lacks, which *looks* like a
   textbook "derive, don't stamp" candidate. It isn't: the keyword is **declared
   intent that the derivation checks**, and the checking is the whole value —

   ```
   loom.query-handler-saves             // "you said queryHandler; the body mutates"
   loom.command-handler-multi-aggregate // "you said commandHandler; you touched 2 → workflow"
   ```

   Derive the kind silently and a read-only handler that starts mutating simply
   *becomes* a command handler; the diagnostic cannot exist and the guarantee
   goes with it. Derivation is right for facts, declaration is right for intent
   you want enforced. **B′ is the version that keeps the check** — the assertion
   moves from a keyword to a legality-table modifier, so
   `loom.query-handler-saves` survives verbatim and the keyword count still
   drops by one.

   **Why not C.** An aggregate `operation` mutates `this`; a context has no
   `this`. One keyword meaning two things by site is precisely the overload this
   mission exists to remove (see `function`'s three meanings, §Symptom 2).

   **Why D is not viable.** `scaffoldHandlers` is a `with`-clause macro, and
   `src/language/lsp/unfold-macro.ts` states the contract: *"Macros become
   demonstrably sugar — any user can unfold and edit … the unfolded output
   re-parses to a working program."* A keyword an author cannot write makes
   `unfold` emit source that does not parse. **The unfold guarantee forces every
   macro-emitted construct to stay author-writable** — a general constraint on
   this mission, not a fact about handlers alone, and the reason "just make it
   internal" is unavailable for any carrier a stdlib macro emits.
