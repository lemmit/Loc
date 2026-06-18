# Unfoldable page scaffolding — list/detail as real components

**Status:** PROPOSED · **Created:** 2026-06-18

> One-line thesis: page-body scaffolding (`scaffoldList(of:)` /
> `scaffoldDetails(of:)`, and the `List` / `Detail` / `MasterDetail`
> archetypes) should expand into **real, named `component`s that pages
> reference** — produced at the **macro layer** so they print and
> *unfold* like every other macro — instead of exploding into an
> inline tree at IR lowering phase ⑤c, where nothing can see or edit
> them. This is the UI-side twin of
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md).

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
- **`List` / `Detail` / `MasterDetail` become thin macros**, not
  IR-phase sentinels: `List { of: Order }` expands (at macro time, so
  it unfolds) to `OrderListView()` — a reference to the generated
  component. Embedding a list in a hand-written page
  (`extern-showcase.ddd`'s `Stack { Heading{…}, RiskBadge{…}, List { of:
  Order } }`) just drops the component reference inline; the walker
  already renders user-component invocations. **DEBT-05 dissolves** —
  there is no new walker renderer to write; the component body is
  ordinary primitives the walker (and every frontend) already handles.
- **Scaffold and the archetypes stop being two mechanisms.** Both route
  through one macro that builds the component; scaffold *also* emits the
  wrapping page, the archetype just references the component. No
  duplicate tree-builder, no parallel surface.

The tree-builder logic that lives in
`walker-primitive-expander.ts:expandScaffoldList` /
`expandScaffoldDetails` is reused verbatim — it just runs at macro
`expand()` time producing AST `component` + `BuilderCall` nodes (which
the structural printer already knows how to print) instead of producing
`ExprIR` at lowering time.

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

## Scope (XL — design-first; phase it)

1. **Scaffold emits a real `<Agg>ListView` / `<Agg>DetailView`
   component** + a thin referencing page, via the macro layer; delete
   the `scaffoldList`/`scaffoldDetails` body-sentinel path from
   `walker-primitive-expander.ts`. Behaviour-preserving — gate on
   byte-identical generated output across all frontends.
2. **`List` / `Detail` / `MasterDetail` become macros** over the same
   component builders; remove them from
   `NON_PAGE_BODY_LAYOUT_PRIMITIVES` and the "legacy archetype"
   registry notes. Wire the print/unfold arms.
3. **Docs** — rewrite page-metamodel.md §4/§9 to present list/detail as
   scaffolded-and-unfoldable components; update `examples/sales-ui.ddd`
   + `extern-showcase.ddd` expectations.

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
