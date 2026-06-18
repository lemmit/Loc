# Unfoldable page scaffolding — list/detail as real components

**Status:** PROPOSED · **Created:** 2026-06-18

> One-line thesis: page-body scaffolding (`scaffoldList(of:)` /
> `scaffoldDetails(of:)`, and the `List` / `Detail` / `MasterDetail`
> archetypes) should be **macros that emit a real, named `component`**
> the page references — not an inline tree exploded at IR lowering phase
> ⑤c, where nothing can see, edit, or unfold it. This is the UI-side
> twin of [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md).

## The dividing line: does it need to investigate the model?

The clean rule for "macro vs component":

- A **component is not magical** — it carries no build-time logic; it
  just lowers to its target (the walker renders it). `For { each:, item
  => … }` is a true component: it iterates a value *at render time* and
  needs **zero** model knowledge. Correctly a walker primitive (shipped
  as one).
- A **scaffold/macro runs at build time and investigates the model** —
  `List` derives table columns from `agg.fields` + a filter bar from the
  repository's `finds`; `Detail` needs *more* (containments, derived
  fields, related-entity cards from associations); `MasterDetail` needs
  list + selection + detail together. None can render without reflecting
  over the model, and there is no runtime reflection. So **all three are
  scaffold**, not components.
- **The scaffold's output is a real `component`** (returned, and
  referenced by the page). Once a `component` is what comes out, nothing
  is magic: it is named, printable, unfoldable, and lowers like any
  hand-written component. *"If somewhere we are returning a component,
  then it is good."*

## Problem — the transparency chain dead-ends at the page body

Loom's macro layer is transparent and **ejectable**: `with scaffold(…)`
unfolds one level at a time (subdomain → context → aggregate → pages)
through the structural printer (`src/language/lsp/unfold-macro.ts` +
`src/language/print/`). A user can drill into a scaffold and turn any
level into literal, editable source.

But the **page bodies** the scaffold macro emits are not part of that
chain. Those bodies are sentinel calls — `scaffoldList(of: <Agg>)`,
`scaffoldDetails(of: <Agg>)`, `scaffoldNewForm(of:)`, … (and the
user-facing archetypes `List { of: T }`, `Detail { of: T, by: id }`,
`MasterDetail { … }`) — which explode into a ~100-line inline
`Stack`/`Breadcrumbs`/`QueryView`/`Table` tree at **IR lowering phase
⑤c** (`src/ir/lower/walker-primitive-expander.ts`). That step:

- has **no printer arm** (`src/language/print/` has nothing for the
  scaffold sentinels — confirmed),
- has **no unfold** (it runs after parsing/scope, inside lowering),
- and produces a tree the user **cannot see, edit, or eject**.

So the chain is: `with scaffold(…)` *(unfoldable)* → `page <Agg>List
{ body: scaffoldList(of: X) }` *(unfoldable to here)* → **inline IR
tree** *(opaque magic)*. The interesting part — what the list/detail
page actually renders — is exactly the part you can't open.

The same opacity is why the `List` / `Detail` / `MasterDetail`
*archetype components* (page-metamodel.md §4, §9) read as confusing
"legacy" today: they're documented as the canonical page bodies, they
appear in committed examples (`examples/sales-ui.ddd`,
`web/src/examples/extern-showcase.ddd`), yet they render as
`// not supported by the React walker yet` comments because they were
never given the IR-phase expansion the scaffold sentinels have. They
are a parallel surface to scaffolding with no shared, inspectable
lowering.

## Proposed model — scaffold to real components, at the macro layer

Move list/detail/master-detail body generation **out of phase ⑤c and
into the macro layer**, and have it emit **real `component`
declarations** that pages reference:

```ddd
// today (opaque): a page whose body explodes in the IR
page OrderList { route: "/orders"  body: scaffoldList(of: Order) }

// proposed (unfoldable): scaffold emits a real component + a thin page
component OrderListView {
  body: Stack {
    Breadcrumbs { … }
    Toolbar { Heading { "Orders" }, Button { "New order", to: "/orders/new" } }
    QueryView { of: api.Order.all, data: rows => Paper { Table { … } } }
  }
}
page OrderList { route: "/orders"  body: OrderListView() }
```

- **Higher granularity (the "unfold all the way down" ask):** the chain
  becomes `with scaffold(…)` → page + `component <Agg>ListView` →
  the component's literal `Stack`/`QueryView`/`Table` body — every step
  printable and unfoldable. A user can unfold to the component, then
  unfold again (or just hand-edit it) to customise the table columns,
  the empty state, the toolbar.
- **`List` / `Detail` / `MasterDetail` become macros that emit a
  component**, not IR-phase sentinels: `List { of: Order }` expands (at
  macro time, so it unfolds) to a `component OrderListView` + a
  reference `OrderListView()` at the call site. Embedding a list in a
  hand-written page
  (`extern-showcase.ddd`'s `Stack { Heading{…}, RiskBadge{…}, List { of:
  Order } }`) just drops the component reference inline; the walker
  already renders user-component invocations. **DEBT-05 dissolves** —
  there is no new walker renderer to write; the component body is
  ordinary primitives the walker (and every frontend) already handles.
- **Scaffold and the archetypes stop being two mechanisms.** Both route
  through one macro that builds the component; scaffold *also* emits the
  wrapping page, the archetype just references the component. No
  duplicate tree-builder, no parallel surface.

### The real cost: re-homing the builder to where it can see the model

Today there is a deliberate **two-stage split**:

- **Stage A — macro (phase ②, AST):** `scaffold` emits *pages* whose
  bodies are sentinel calls (`callExpr("scaffoldList", …)` in
  `src/macros/stdlib/scaffold/_pages.ts`). It chooses page name / route /
  menu, but not the body tree.
- **Stage B — phase ⑤c (IR):** `expandScaffoldList` /
  `expandScaffoldDetails` (`walker-primitive-expander.ts`) replace each
  sentinel with the full tree, reading **IR-level** data — `agg.fields`,
  the repository's `finds` (`ctx.bcByAggregate…`), and `findApiHandleFor`.

The split exists *because* body-building wanted resolved model data the
AST layer doesn't hand you for free. So the work is **collapsing A+B into
one macro-level emit that produces a `component`** — and the cost is
giving the builder its model data at the macro/AST layer instead of the
IR:

- The **tree *shape*** (the `QueryView`/`Table`/`Paper` structure) is
  reused — it is the same tree of named primitive calls, expressed as
  `callExpr(...)` AST builders instead of `call(...)` IR.
- What must be *re-derived from the AST* is exactly the model
  investigation: columns from the AST aggregate's `Property` members;
  the filter bar from the AST `repository`'s `find`s; the api handle by
  convention; `.all` by convention (the enriched auto-`findAll`);
  Detail's containments / derived / associations from the AST. This is
  "scaffold investigating context" — the thing you said scaffold should
  do. It is bounded, but it is the actual work, and it is **larger for
  `Detail`** (more model to read) than for `List`.
- A small **`component(...)` macro factory** is needed in
  `src/macros/api/ui-factories.ts` (today there is only `page(...)`).

## Relationship to existing work

- **[`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)** —
  the *same principle on the API side*: "every layer is macro-scaffolded
  by default, unfoldable to literal source," expanding through
  `scaffoldContext` / `scaffoldAggregate` / … down to per-output leaves.
  This proposal is its UI-side twin and should share the
  scaffold-aggregator vocabulary where it can.
- **DEBT-05** (prioritized backlog) — currently "implement the
  `List`/`Detail`/`For` walker primitives." `For` shipped as a genuine
  walker primitive (#1283). This proposal **reframes the `List`/`Detail`/
  `MasterDetail` half**: the fix is not a per-frontend renderer but
  macro-emitted components. DEBT-05's List/Detail line should point here.
- **Macro stdlib** (`src/macros/stdlib/scaffold/`) — the existing
  `scaffold` / `scaffoldAggregate` / … macros are where the new
  component-emitting expansion lands.

## Scope (Medium → Large, phaseable — *not* XL)

Re-estimated after reading the code: the tree shape is reused and the
walker already renders the output, so this is a bounded refactor, not a
multi-month epic. Phase it so List proves the pattern first.

1. **List (Medium).** Add the `component(...)` macro factory; port
   `expandScaffoldList` to emit a `component <Agg>ListView` (reading the
   AST aggregate + repository) + a page body `<Agg>ListView()`; delete
   the `scaffoldList` ⑤c arm. Filter state moves from the host page onto
   the component (*cleaner* there). Highest-value, lowest-cost — proves
   the unfold-to-component chain end to end.
2. **Detail (Medium–Large).** Same, for `expandScaffoldDetails`, plus the
   `:id` route-param threading and the extra model reads (containments /
   derived / associations / `scaffoldOperations` fan-out).
3. **`MasterDetail` (new builder).** The one piece with *no* existing
   tree-builder — list + selection state + detail, two child component
   references. Largest single new piece; a fair follow-up phase.
4. **Archetypes + cleanup.** `List`/`Detail`/`MasterDetail` become the
   macros from 1–3; remove them from `NON_PAGE_BODY_LAYOUT_PRIMITIVES`
   and the "legacy archetype" registry notes; wire print/unfold arms.
5. **Docs/examples.** Rewrite page-metamodel.md §4/§9; update
   `examples/sales-ui.ddd` + `extern-showcase.ddd`.

**Gate.** This is *behaviour-preserving, not byte-identical* — the page
output changes (a new `<Agg>ListView.tsx` component file; the page
imports and references it instead of inlining the JSX). So the gate is
"equivalent rendered UI + reviewed diff" (the React/Vue/Svelte build
suites + a Playwright smoke), **not** a sha256 fixture match. (Correcting
an earlier draft that claimed byte-identical.)

## Open questions

- **Component naming / placement.** `<Agg>ListView` vs `<Agg>List`
  (collision with the scaffold *page* name `<Agg>List`); where the
  generated component source lives relative to the page.
- **The `id` route param for Detail.** `scaffoldDetails` hardcodes
  `ref("id")`; a referencing page must thread its route param into the
  component (`OrderDetailView(id)`), generalising the hardcoded `id`.
- **List filter state.** `expandScaffoldList` synthesises find-filter
  state onto the *host page* (`ctx.pendingPageState`). As a component
  this gets *cleaner* — the component owns its own `state {}` — but the
  migration must move that state from page to component.
- **`MasterDetail`.** No scaffold analog today (split-pane list +
  selection + detail); it needs a new component builder (selection
  state + two child component references). Largest single piece; can be
  a follow-up phase.
- **Decision tag.** Requests a `D-UNFOLDABLE-PAGES` pin once the
  direction is accepted (mirroring the API-side decision).
