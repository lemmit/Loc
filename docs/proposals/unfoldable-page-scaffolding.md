# Unfoldable page scaffolding — lift the ⑤c expander into the macro layer

**Status:** PROPOSED (adopted direction; phased implementation underway) ·
**Created:** 2026-06-18

> One-line thesis: the scaffold **page-body expansion**
> (`scaffoldList` / `scaffoldDetails` / `scaffoldNewForm` / … → the
> `Stack`/`Breadcrumbs`/`QueryView`/`Table` tree) must be a **macro-layer
> (AST→AST) transform that is unfoldable to literal `.ddd` source** — not an
> IR-phase ⑤c rewrite. Scaffolds are macros; macros are unfoldable; this one
> isn't, and that is a layering defect, not a cosmetic gap. UI-side twin of
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md).

> **Context.** This doc began as "implement the `List`/`Detail`/`MasterDetail`
> archetypes." Those turned out to be **inert duplicates** of the
> `scaffoldList`/`scaffoldDetails` sentinels and were **removed**
> ([D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)). What remains
> — and what this rewrite is about — is the real defect the investigation
> surfaced: the sentinels themselves expand as opaque IR magic.

## The defect

`with scaffold(…)` is a real macro and unfolds one level at a time
(subdomain → context → aggregate → pages) through the structural printer
(`src/language/lsp/unfold-macro.ts` + `src/language/print/`). But the **page
bodies** it emits are sentinel calls — `callExpr("scaffoldList", { of })`
(`src/macros/stdlib/scaffold/_pages.ts`) — and the actual ~100-line body tree
is produced by `expandScaffoldList` / `expandScaffoldDetails` / … in
`src/ir/lower/walker-primitive-expander.ts`, called as the **last step of
`lowerSystem` (phase ⑤c)**. That step is **IR → IR**, so it:

- has **no printer arm** (the printer is AST→source; this runs in IR-space),
- has **no unfold** (unfold targets `with X(…)` clauses at the AST layer),
- and produces a tree that exists only transiently as IR, then as generated
  TSX — **never** as `.ddd` source the user can see, edit, or eject.

The transparency chain — Loom's stated value (everything scaffolded is
ejectable to literal source) — dead-ends exactly at the page body. It is also
a one-directional-layering smell: a language-surface construct (`scaffoldList`)
carries its semantics as a hardcoded IR transform in the lowering pass.

## Design — move the expansion to phase ② (AST→AST)

Relocate the body-builders from `src/ir/lower/walker-primitive-expander.ts`
(IR→IR, ⑤c) into the scaffold macro family (`src/macros/stdlib/scaffold/`) as
**AST→AST builders** that read the AST and emit AST builder-calls
(`callExpr`/`nameRefExpr`/`stringLit`/`intLit`/lambda — the `_pages.ts`-style
factories, extended). One shared module serves three consumers:

1. **The compile path** — the scaffold macro (or a phase-② pass right after
   macro expansion, before scope/link ③) expands the sentinel into the full
   body AST. Downstream just lowers a normal page body; the ⑤c scaffold pass
   is **deleted** (~1k LOC of IR magic gone). A correctness bonus: the expanded
   body now flows through scope/link (③) and AST-validate (④), which the ⑤c
   output bypasses today.
2. **Unfold (eject)** — the LSP code action runs the *same* builder on a
   selected sentinel, prints the result, and splices it in. `scaffoldList
   { of: Order }` → the literal `Stack { Breadcrumbs … QueryView … Table … }`,
   editable.
3. **Hand-written sentinels** — `extern-showcase.ddd`'s embedded `scaffoldList
   { of: Order }` expands by the same pass, so emitted and hand-written
   sentinels behave (and unfold) identically.

Optionally the builder can emit a **named `component` + a page reference**
instead of an inline body (the monomorphized `<Agg>ListView` discussed
below) — a reusable, embeddable artifact. That is a refinement on top of the
relocation, not a prerequisite.

### The data is AST-derivable (this is why it can leave ⑤c)

The only reason body-building was deferred to ⑤c is that it read *enriched* IR.
Every input has an AST-layer equivalent:

| ⑤c reads (IR) | AST/macro-layer equivalent |
|---|---|
| `agg.fields` (typed; skip VO/array) | the aggregate's `Property` members + type AST |
| repo `finds` (filter bar) | the `repository`'s `find` members (string params, array return) |
| `findApiHandleFor` | the `ui`'s api params + the system's `api` decls (all AST) |
| auto-`findAll` → `api.X.all` | **convention** (`.all`) — no enrichment needed |
| wireShape order / containments / derived | declared field order + containment/derived/`X id[]` members |

The tree *shape* is reused verbatim — same named-primitive calls, expressed as
`callExpr(...)` instead of `call(...)`. The work is re-reading these from the
AST; it is **larger for Detail** (containments / derived / associations /
operation fan-out) than for List.

## The key coupling: origin is inferred from the sentinel

The one genuinely hard part. `inferPageOrigin` (`src/ir/lower/lower-ui.ts`)
classifies a page (`aggregate-list` / `aggregate-detail` / `aggregate-new` /
`view-list` / `home` / …) by **pattern-matching the body sentinel** during
lowering — there is **no** separate origin slot (`scaffoldOrigin` is only a
validator predicate). `applyPageOriginSideEffects` then uses `origin` to set
the `emitPath` (`pages/orders/list.tsx`), synthesise the detail `:id` param,
and route page-object emission. (Menu metadata is already emitted explicitly by
the macro.)

So if the body expands to full source *before* lowering, the sentinel — and
thus the inferred origin — is gone. The relocation therefore needs origin to
become an **explicit stamp**, not a reverse-engineered one:

- **The macro stamps origin when it emits the page** (it knows it is making an
  `aggregate-list` page). This requires a place to put it: an optional `origin`
  marker on the `Page` AST/IR that lowering reads (preferred over re-inferring
  from a full body). This is the one grammar/IR addition the refactor needs.
- A page **ejected** by the user becomes an ordinary `custom` page — it lands
  at `pages/<name>.tsx`, the user owns it. That is correct: eject = "I own this
  now", origin no longer applies.
- The detail `:id` param is emitted **explicitly** by the macro
  (`page OrderDetail(id: Order id)`) rather than synthesised from origin —
  cleaner, and visible in the unfolded source.

## Phased implementation (with gates)

1. **Foundation (this slice).** Add the missing AST expression factories
   (`intLit`, …) and a shared `src/macros/stdlib/scaffold/_body-builders.ts`
   that builds page-body AST from the AST aggregate, starting with the
   data-light `scaffoldNewForm` shape. Test: build → print → re-parse → assert
   valid source + expected structure. *Additive; zero change to the compile
   path; proves AST-derivability + printability.*
2. **Origin stamp.** Add the explicit `origin` marker on `Page` (grammar +
   IR + printer + `inferPageOrigin` prefers it, falls back to body-inference).
   Byte-identical (the stamp duplicates what inference derives). Unblocks
   moving bodies off the sentinel.
3. **Relocate List + New.** Build the `scaffoldList`/`scaffoldNewForm` body AST
   at phase ②; the macro stamps origin + emits params/menu; delete those ⑤c
   arms. **Gate: byte-identical generated output** across all frontends (the
   lowered AST body must reproduce the ⑤c `ExprIR`).
4. **Relocate Detail + the rest.** `scaffoldDetails`/`scaffoldOperations`/
   `scaffoldViewList`/`scaffoldInstance*`/`scaffoldWorkflowForm` + the index
   singletons; delete the remainder of `walker-primitive-expander.ts`.
5. **Unfold wiring.** Extend the LSP code action to eject a body sentinel via
   the shared builder.
6. **(Optional) component emission.** Switch the builders to emit
   `component <Agg>ListView` + a page reference, for reuse/embedding.

## `List` (archetype) vs `<Agg>ListView` (if we emit components)

Kept for the component-emission option (phase 6): `List { of: X }` could not be
one shared component — columns are baked per-aggregate at build time (no
runtime reflection) — so the macro **monomorphizes** it into a concrete
`<Agg>ListView` (distinct from the scaffold *page* name `OrderList`). The
indirection *is* the scaffold step.

## Open questions

- **Origin marker surface.** Is the `Page` `origin` stamp a user-writable
  keyword or a macro-only annotation that the printer round-trips? (Leaning:
  printer round-trips it, so an unfolded scaffold page still shows its origin.)
- **Byte-identical vs. accepted-diff.** Phases 3–4 aim byte-identical; if the
  state-on-page → state-where-it-belongs move forces a diff, gate on
  equivalent-UI + reviewed diff instead.
- **Component emission (phase 6) naming/placement** — `<Agg>ListView` vs
  `OrdersList`; where the generated component source lives.
- **Decision tag.** Requests `D-UNFOLDABLE-SCAFFOLD` once ratified.
