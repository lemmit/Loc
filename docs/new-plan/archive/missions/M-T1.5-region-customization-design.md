# M-T1.5 — Region-level customization / UI unfold (design)

> **Status: Slice A shipped; Slice B descoped (not required — 2026-07-19).**
> Per-page unfold (Slice A) is the delivered cliff-softener. Named override
> slots (Slice B) are **not being built** — kept below as design-record only,
> demand-pulled: revive it only if a concrete case needs region-fill on a
> still-generated page that per-page unfold (eject the page, then edit) can't
> serve. Both rungs were designed; the owner's call is that the unfold rung
> suffices.
> Sources: `docs/audits/architecture-weak-spots-2026-07.md` §1 (the
> customization-cliff), `docs/page-metamodel.md` §10 (override-by-name) /
> §5.2 + §9 (`slot` / `Slot`) / §14 (open questions),
> `src/language/lsp/unfold-macro.ts`, `src/macros/stdlib/scaffold/`.

## Problem

The scaffolded UI is excellent right up to the edge of the closed primitive
set — then customization is **all-or-nothing**. The weak-spot review names this
the product's #1 gap. Today there are exactly three rungs, and the jump between
them is a cliff:

| Rung | Mechanism | Granularity | What you give up |
|---|---|---|---|
| Whole `ui` block | `unfold` the `with scaffold(...)` clause | **every** page at once | you now own the entire UI surface |
| Whole page | override-by-name — declare `page <Name>` (§10) | one page | the generated body: you hand-write from a **blank** page |
| Whole component | `extern component` | one component | the component is yours; no model wiring inside it |

The missing middle is *region-level* and *body-preserving* customization:

- **Per-page unfold** — the model already emits a full, hand-writable body for
  every scaffolded page (`_body-builders.ts`), and `unfold` already ejects
  **all** of them. There is no way to eject **one** page's body to `.ddd`
  source and leave its siblings scaffolded. Override-by-name gets you a single
  page but starts you at a blank body — you throw away the generated starting
  point.
- **Named override slots** — no way to keep a page model-owned and
  regenerable while injecting custom markup into one declared spot. The
  component library already has a `slot` element param + `Slot {}` primitive
  (§5.2, grammar `ddd.langium:1890`/`2278`), but scaffolded **pages** expose
  none.

### Correction to the mission text

The mission says "`unfold` explicitly excludes `ui` hosts." That is imprecise
and should not be carried forward: the only hard `ui` guard is in
`unfoldCapability` (`unfold-macro.ts:192`) — correct, because capabilities are
pure *domain* mixins. The `scaffold` **macro** targets `ui`
(`scaffold.macro.ts:30`) and **does** unfold (`unfold-macro.ts:77` matches
`macro.target === hostKind === "ui"`), ejecting real `.ddd` page source. The
gap is *granularity*, not a blanket exclusion.

## Direction — two independent rungs

Both slices are additive and can land in either order; slot injection is the
cliff-*softener* (you never fall off), per-page unfold is the finer *escape
hatch* (a smaller cliff). We build both so the gradient is continuous.

### Slice A — Per-page unfold (LANDED)

**Shipped.** The LSP code-action provider now offers, alongside the whole-macro
*"Unfold macro 'scaffold'"*, one *"Unfold page 'Orders / Detail'"* per page the
macro produces. `enumerateScaffoldPageUnfolds` (`src/language/lsp/unfold-macro.ts`)
runs the macro's **full** `invokeMacro` composition (a new executing invoker,
vs. the one-level recording invoker) down to the leaf page-builders, flattens
the produced tree to individual pages, and for the chosen page emits
`area <Plural> { page <Role> { … } }` (loose page for ui-scope singletons like
`Home`) as an **insert-only** edit — the `with scaffold(...)` clause is left in
place, so scope-local override-by-name (`expander.ts:mergeScopedMembers`)
suppresses exactly that scaffolded page while its siblings keep generating.
Wired in `ddd-code-actions.ts`; tests in `test/macro/unfold-page.test.ts`
(actions offered, single-page eject keeps the macro, re-parses clean,
loose-singleton path). Byte-identity of the ejected body is inherited from the
existing structural-print roundtrip guarantee. **Design note:** A1's "offered on
each classified page" is realised as per-produced-page actions on the scaffold
macro call itself (top-level `scaffold` included, via full execution) — no need
to drill to `scaffoldAggregate` first.

### Slice A — original design (extends existing machinery)

A code action on a scaffolded page (or on the `with scaffold(...)` clause,
scoped to one produced page) that ejects **that page's** walker-stdlib body as
`.ddd` source and narrows the scaffold directive so it no longer produces that
name.

```ddd
// before — Order pages are all scaffolded
ui SalesAdmin with scaffold(aggregates: [Order, Customer]) { }
```

Invoking *Unfold page 'OrderDetail'* rewrites to:

```ddd
ui SalesAdmin with scaffold(aggregates: [Order, Customer]) {
  page OrderDetail {                 // ← ejected, byte-identical to the scaffold body
    // Breadcrumbs · heading · QueryView { of: api.Order.byId(id), single: true } …
    // (the full _body-builders.ts body, printed via printStructural)
  }
}
```

`Customer`'s pages and `Order`'s other two pages stay scaffolded. This reuses
the exact override-by-name contract already in §10 ("`scaffold` it but declare
a `page <Name>` with the matching name") — the *only* new work is producing the
ejected **body** instead of a blank page. Mechanically:

- The scaffold macro already builds every page's full AST body
  (`_body-builders.ts`); a per-page unfold runs the macro, selects the one
  produced `page` node whose classified name matches the target, and prints its
  body through the existing structural printer (`printStructural`) — the same
  printer the whole-`ui` unfold already uses.
- The `with scaffold(...)` clause is **not** removed (siblings still need it);
  instead the ejected page name is recorded so the validator's
  double-scaffold/duplicate-name obligations (§10 "Validator obligations") pass
  — this is already exactly the override-by-name rule (explicit `page <Name>`
  overrides exactly one scaffold source). No new validator; the existing one
  must simply treat the ejected page as the override it structurally is.

**Decision A1 (resolved 2026-07-19): per individual page.** `classifyPage`
already gives every produced page a stable identity, so the code action anchors
on the `with scaffold(...)` clause and offers one *"Unfold page &lt;Name&gt;"*
per produced page; the existing whole-`ui` unfold stays as *"Unfold all"*.
"All `Order` pages" is three invocations — no separate per-aggregate action
(consistent with scaffold's "list what you want, not what you don't" ethos).

### Slice B — Named override slots (DESIGN-RECORD ONLY — not being built)

> Descoped 2026-07-19: not required. Per-page unfold covers the practical need.
> The design below is retained so a future demand-pull starts from a settled
> plan rather than a blank page — do not treat it as open work.


Let a scaffolded page stay model-owned while a `.ddd` author fills a declared
slot with custom markup — no ejection, page keeps regenerating.

Two sub-decisions, both reusing existing surface rather than inventing:

1. **Where slots live — and their scope.** The scaffold body-builders gain a
   small, *fixed*, closed set of named slots at stable positions. The
   load-bearing subtlety: a scaffold body is **not flat**. The Detail body is
   `Stack[Breadcrumbs, Heading, QueryView{ data → Stack[card, related, ops] }]`
   (`_body-builders.ts:scaffoldDetailsParts`), so a slot placed **inside** the
   `data` lambda can reference the loaded record and one at page level cannot.
   Every slot therefore declares a **scope**, and the validator rejects a
   record reference (`data.…`) in a static slot.

2. **How an author fills one.** A top-level `ui` member
   `override <Page>.<slot> { … }` whose body is ordinary walker-stdlib markup,
   dispatched through the existing `Slot`/`slot` element mechanism. Sketch:

```ddd
ui SalesAdmin with scaffold(aggregates: [Order]) {
  override OrderDetail.afterOperations {          // record-scoped: `data` in scope
    Card { title: "Audit trail" QueryView { of: api.Order.history(data.id) } … }
  }
}
```

The scaffolded `OrderDetail` still regenerates from the model; only the named
region carries user content. This is the invariant-preserving path — the model
stays the single source of truth.

**Decision B1 (resolved 2026-07-19): `override <Page>.<slot> { … }`** as a
top-level `ui` member, `override` admitted as a soft keyword. Verified: `override`
has **zero** identifier occurrences across `examples/`, `web/src/examples/`, and
`test/fixtures/corpus/`, and is not already a grammar keyword (the only current
uses are prose comments) — clean to claim, à la M-T2.1's `rename` check.
Rejected `page X { fill slot { } }`: declaring `page X` already triggers
override-by-name = **full replacement** (§10). Overloading it with region-fill
would give one syntax two opposite meanings ("replace the whole page" vs "keep
generating, fill one region"). A distinct `override` member keeps them separate.

**Decision B2 (resolved 2026-07-19): the closed slot set per archetype, each
with a scope.** Slot names are a closed set (like the primitive library);
`static` slots see no record, `record` slots run inside the Detail `data`
lambda with the loaded entity bound as `data`.

| Archetype | `static` slots | `record` slots (`data` bound) |
|---|---|---|
| `<Agg>List` | `header`, `toolbarActions`, `footer` | — |
| `<Agg>New` | `header`, `beforeForm`, `afterForm`, `footer` | — |
| `<Agg>Detail` | `header`, `footer` | `beforeRecord`, `afterRecord`, `afterOperations` |
| `<Wf>Workflow` | `header`, `beforeForm`, `afterForm`, `footer` | — |

The set is pinned by a `slot-set.test.ts` freeze test mirroring
`test/generator/elixir/heex-parity.test.ts`: a slot added to the TSX
body-builders without a renderer on every walker target (or a pinned reason)
fails CI, so a slot can't silently skip HEEx/Feliz. Validator obligations:
`loom.slot-unknown` (name not in the archetype's set), `loom.slot-scope` (a
`data.…` reference in a `static` slot), `loom.slot-target-not-scaffolded` (an
`override` for a page the model doesn't scaffold), `loom.slot-duplicate` (two
`override`s for the same `Page.slot`).

## Decisions honored

- **Invariant #7 (no primitive-local-state seam):** slots carry markup, not
  new state channels — page-level `state {}` remains the only state surface,
  same as M-T1.1's decision (A).
- **Macros emit final AST (CLAUDE.md conventions):** per-page unfold prints the
  macro's real produced body; no sentinel/placeholder — consistent with the
  "unfold ejects real `.ddd` source" guarantee.
- **Closed primitive set:** slot names are a closed set, freeze-tested across
  targets — no user-extensible component library (§14 non-goal upheld).

## Cross-target scope

- **Slice A (unfold)** is toolchain-only (LSP code action + structural printer)
  — framework-agnostic, no per-backend emitter work. Lands once.
- **Slice B (slots)** touches the body-builders + every walker target's markup
  seam (React/Vue/Svelte/Angular/Feliz + HEEx). HEEx pinned in `heex-parity`
  with a reason if the LiveView topology can't carry a slot cleanly, per the
  standing walker-parity discipline.

## Acceptance

- **A:** a scaffolded example with 2 aggregates; unfolding one page yields a
  `page <Name>` whose body re-parses and generates byte-identically to the
  scaffold output for that page; siblings unchanged. Round-trip gated like the
  existing `print-structural-roundtrip` test.
- **B:** a scaffolded page with a filled `override <Page>.<slot>` renders the
  custom region while the rest stays generated; all `generated-*-build` gates
  green on the JSX targets; HEEx renders or is pinned.

## Sequencing

Slice A shipped (self-contained, no emitter fan-out, immediate DX win). Slice B
descoped as not-required — no further work planned; the design above is record
only, revived only on a concrete demand-pull.
