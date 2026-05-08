# Page metamodel — RFC v0

> **Status:** prototype / discussion. Supersedes the v22 React generator's
> hardcoded module-to-CRUD scaffolder with a small declarative metamodel:
> pages, components, scaffolding, state, menus. Six keywords total.

---

## 1. Vision

Today's React generator is a procedural emitter that prints TSX from the
domain IR. There is no source representation of "a page", so any UI choice
that diverges from the implicit list/new/detail-per-aggregate shape requires
forking the generator in TypeScript. This RFC promotes the page to a
first-class language construct, with the existing CRUD behaviour recovered as
a `scaffold` macro that desugars into the same metamodel.

Design posture, in three rules:

1. **Closed and minimal.** Six new keywords, no macro system, no record
   algebra. Same posture Loom takes for its domain language.
2. **Reuse the existing IR for typing.** Data sources resolve to repository
   finds, views, operations, workflows, external APIs — every name is typed
   via the existing signature, no parallel type system.
3. **Declarative over procedural.** Each line is a fact; structure is
   carried by component invocations (typed function calls), not by nested
   visual trees.

---

## 2. Six new keywords

| Keyword | Role |
|---|---|
| `ui` | Top-level block declaring pages, components, scaffolds, menus. A `SystemMember`, peer to `module`, `deployable`, `theme`, `user`. |
| `page` | Declares a route + body. Body is a component invocation. |
| `component` | Declares a parameterized region tree — a typed function from params (and optional local state) to a body expression. |
| `scaffold` | The one fixed multi-page rewrite from a domain selector (modules / contexts / aggregates / workflows / views) to a set of pages. |
| `state` | Declares a reactive local variable inside a `page` or `component`. Different semantics from `let` (reactive, mutable). |
| `menu` | Optional `ui`-level block declaring the sidebar's structure. If omitted, sidebar is derived from page menu metadata. |

`section` and `link` inside `menu`, and `from`/`bind`/etc. patterns reused
from existing constructs, are **soft keywords** (only reserved within their
parent block) — same posture as `from` inside `view`.

Keywords reused from the existing grammar: `requires` (auth gate, same as
operations), `let` (still inside flows / event handlers), all expression
operators.

---

## 3. Where `ui` lives

A `ui` block is declared at system scope and referenced by deployables:

```ddd
system Acme {
  module Sales { context Sales { ... } }

  theme { primary: "#3b82f6", neutral: "#9ca3af" }
  user  { id: string, permissions: string[] }

  ui SalesAdmin {
    scaffold modules: Sales
    page OrderConsole(customerId: Id<Customer>) { ... }
    menu { ... }
  }

  deployable api    { platform: dotnet, modules: Sales, port: 8080 }
  deployable webApp { platform: react,  targets: api, ui: SalesAdmin, port: 3001 }
}
```

The deployable references the ui via `ui: SalesAdmin`, mirroring how it
already references modules. One ui can be served by multiple deployables
(e.g. customer portal and admin tool sharing a domain but differing in UI).

**Validator obligations**

- `deployable.ui` must reference an existing `ui` block.
- Only `react` deployables may set `ui:`.
- Every `scaffold` selector and every page-data binding inside the `ui` must
  resolve to a module reachable through the deployable's `targets` chain.

---

## 4. `page`

A page is a route + parameters + optional state + a body. The body is a
component invocation expression.

```ddd
page OrderList {
  route: "/orders"
  body:  List(of: Order)
}

page OrderDetail(id: Id<Order>) {
  route: "/orders/:id"
  body:  Detail(of: Order, by: id)
}

page OrderConsole(customerId: Id<Customer>) {
  route:    "/customers/:customerId/orders"
  title:    "Orders for " + customer.name
  requires  currentUser.permissions.contains(sales.viewOrders)

  state selectedId: Id<Order>?

  body: MasterDetail(
    of:      Order,
    scope:   Orders.byCustomer(customerId),
    actions: [confirm, cancel]
  )
}
```

Page properties:

| Property | Meaning |
|---|---|
| `route:` | Path-with-`:params`. Path params bind to the page's typed parameters. |
| `title:` | String expression, may interpolate page data (`"{{customer.name}}"`). |
| `requires` | Auth predicate — same syntax as on operations. |
| `state` | Zero-or-more reactive local declarations. |
| `body:` | Single expression evaluating to a component invocation (which may compose others). |
| `menu { … }` | Optional per-page metadata: `section`, `label`, `order`, `hidden`. |

Path parameters are typed `TypeRef` — same as everywhere else. Their type
drives the URL deserialization (`Id<Order>` parses an `id` segment, etc.).

---

## 5. `component`

Components are typed functions from parameters (and optional local state)
to a body expression. They never declare a route. They may invoke other
components.

```ddd
component OrderPanel(order: Order) {
  body: Stack([
    Heading("Order " + order.id, level: 2),
    Badge(order.status),
    Table(order.lines, columns: [productId, quantity, unitPrice, subtotal]),
    Toolbar([
      Action(confirm, then: navigate(OrderList)),
      Action(cancel,  then: toast("Cancelled"))
    ])
  ])
}
```

A component's signature is type-checked at every call site. The compiler
enforces, for each builtin component, the relationships its parameters
imply — `MasterDetail(of: Order, scope: …)` requires `scope` to produce
`Order[]`; `Detail(of: Order, by: x)` requires `x: Id<Order>`; `actions:`
items must be operations on the `of:` aggregate; `Form(creates: Order)`
binds the form fields to `wireShape(Order.create)` and refuses any other
field reference.

User-defined components are pure functions over their parameters and local
state — they cannot synthesise pages, routes, or menu entries. That keeps
the route map of the app exactly the set of `page` declarations in source.

---

## 6. Builtin component library (closed v0)

The standard library is a small, closed set. Everything else is composed
from it or is a user component built on top.

**Pages-as-bodies (the v0 page kinds, as functions):**

| Component | Purpose |
|---|---|
| `List(of: T, source?)` | Table over `T[]`; row click navigates to `T`'s detail page. |
| `Detail(of: T, by: Id<T>)` | Single-record view; renders fields, embeds `contains`, exposes operations as actions. |
| `Form(creates: T \| runs: workflow, then?)` | Input form bound to a typed request; submit calls the mutation/workflow. |
| `MasterDetail(of: T, scope: query<T>, actions?)` | Split-pane: list with row-select state + detail panel for the selection. |
| `Dashboard(items: [Card \| Stat \| Table \| Count, …])` | Composite read-only page; grid layout. |
| `Wizard(builds: T, stages: Stage[])` | Multi-stage form accumulating a typed draft. (See §10.) |

**Composition primitives:** `Stack`, `Grid`, `Tabs`, `Card`, `Toolbar`,
`Heading`, `Text`, `Badge`.

**Bindable inputs:** `Field`, `Toggle`, `Select`, `Fieldset` (for nested
value objects). All RHF-Controller-wired today; no change.

**Action primitives:** `Action(operation, then?)`, `Button(label, on?)`.

The set is closed in v0 — extending it requires a stdlib change, not a
language change. Users freely define their own `component`s, which compose
the builtins.

---

## 7. `scaffold` — the one macro

`scaffold` is the only multi-page rewrite. It's not a user-extensible macro
system — it's a single fixed pre-codegen pass that synthesises explicit
`page` declarations from a domain selector.

### Granularity hierarchy

```
scaffold modules:    A, B, …    →  ∪  scaffold contexts:   <each context in each module>
scaffold contexts:   X, Y, …    →  ∪ {
                                       scaffold aggregates: <each aggregate in X>,
                                       scaffold workflows:  <each workflow in X>,
                                       scaffold views:      <each view in X>
                                     }
scaffold aggregates: Order, …   →  page <Order>List + <Order>New + <Order>Detail
scaffold workflows:  placeOrder, …  →  page PlaceOrderWorkflow  (+ shared WorkflowsIndex)
scaffold views:      ActiveOrders, …  →  page ActiveOrdersView  (+ shared ViewsIndex)
```

Every form ultimately bottoms out in explicit `page` declarations. Each
level is mechanical expansion of the level below — same single rewrite
pass, applied recursively.

### Stacking and partial scaffolds

Multiple `scaffold` directives stack. There is no `except` clause; you list
what you want, not what you don't.

```ddd
ui SalesAdmin {
  scaffold modules: Catalog                          // bulk
  scaffold aggregates: Customer, Product             // a la carte
  scaffold workflows:  placeOrder
  page OrderList    { ... }                          // custom Order pages
  page OrderDetail  { ... }
}
```

### Override-by-name

Three layered scales of override, all using the same mechanism — explicit
`page <Name>` replaces the scaffolded page with the matching name.

| Granularity | Override |
|---|---|
| Whole context | Don't `scaffold context X` — list its aggregates instead, omit some |
| Whole aggregate | Don't `scaffold aggregates: X` — write its pages explicitly |
| Single page | `scaffold` it but declare a `page <Name>` with the matching generated name |

### Validator obligations (additions)

- Each `scaffold <kind>: <name>` resolves to an existing declaration of
  that kind in a module reachable through the deployable's `targets`.
- Stacked `scaffold` directives may not double-scaffold the same construct
  (validator rejects `scaffold modules: Sales` + `scaffold aggregates:
  Customer` if Customer is in Sales).
- Two distinct `scaffold` directives may not produce pages with the same
  generated name; explicit `page <Name>` may override exactly one source.

---

## 8. `menu` — layered defaults + explicit composition

Pages carry `menu { … }` metadata; sidebar is derived. An optional
`ui`-level `menu` block overrides this for full control.

### Page-local default

```ddd
page OrderList {
  route: "/orders"
  menu  { section: "Sales", label: "Orders" }      // optional; default derived from page kind
  body:  List(of: Order)
}
```

### Explicit `ui`-level menu

```ddd
ui SalesAdmin {
  scaffold modules: Sales

  menu {
    section "Sales"   { link OrderList, link OrderConsole, link OrderNew }
    section "Lookup"  { link CustomerList, link ProductList }
    section "Reports" { link ActiveOrdersView, link OrderSummaryView }
    section "External" {
      link "Docs" -> "https://docs.acme.com"
    }
  }
}
```

### Lowering

```
1. Run scaffold → pages, each with default `menu { section: <derived>, label: <derived> }`
   (defaults: aggregates → "Aggregates", workflows → "Workflows", views → "Views")
2. Apply explicit `page X` overrides (by name)
3. If `ui` has a `menu { … }` block:
       sidebar = that block, resolved against the page registry
   else:
       sidebar = pages grouped by `menu.section`, sorted by `menu.label`
```

`scaffold` doesn't *return* anything — it contributes pages-with-menu-metadata
to a shared registry. The `menu` block (when present) is the explicit
composition operator over that registry.

Per-link auth comes free: a `link OrderList` inherits the underlying page's
`requires` clause, so menu links hide automatically when the user lacks
permission.

---

## 9. `state` and events

State is reactive and local to the enclosing `page` or `component`:

```ddd
state selectedId: Id<Order>?
state showDrafts: bool = false
```

Same `TypeRef` vocabulary as everywhere else. Initial value is optional
(types default to `null`/zero of the type); writes re-render dependents.

URL synchronisation is deferred to a later revision — for v0 every
`state` declaration is in-memory only.

**Events** are component parameters typed as lambdas. Loom already has
single-expression lambdas (`x => expr`); the most common event shapes are
single calls or single navigations:

```ddd
List(
  of: Order,
  source: Orders.all(),
  onRowSelect: row => navigate(OrderDetail, { id: row.id })
)

Action(confirm, then: navigate(OrderList))
```

For multi-step actions, use a component that bundles the steps (e.g.,
`Action(operation, then: <expr>)` covers "run op then do one more thing"),
or write a custom component with local state. **No `flow` keyword in v0** —
the surface is small enough that named flows aren't needed; if real cases
force multi-step flows, the keyword can be added later without breaking
existing programs.

`navigate(<Page>, { params })` and `toast(<msg>)` are builtin calls, not
new statement forms. The compiler type-checks `<Page>` against the page
registry and `{ params }` against that page's typed parameters.

---

## 10. Wizard — a component, not a keyword

A wizard is structurally distinct from a single-region page (multiple
sub-states, accumulating typed draft, sequential validation), but the
distinction is captured in its component signature, not in the grammar:

```ddd
page PlaceOrder {
  route: "/orders/new"
  body:  Wizard(
    builds: PlaceOrderRequest,                                   // accumulating typed draft
    stages: [
      Stage("Customer", fields: [customerId]),
      Stage("Items",    fields: [items], guard: draft.customerId != null),
      Stage("Review",   summary: draft, submits: placeOrder)
    ]
  )
}
```

The compiler type-checks: every `Stage.fields[i]` is a member of `builds`;
`submits:` is a workflow whose input matches `builds`; `guard`'s expression
types to `bool` against the partial draft. "Current stage" and "partial
draft" are local state inside the `Wizard` component implementation —
exactly what local component state is for.

**Why not a keyword?** Adding `wizard` and `stage` as top-level forms saves
a few characters of syntax (block-per-stage instead of array-of-records)
but signals that any "structurally rich" UI archetype deserves its own
grammar — `dataGrid`, `mapView`, `kanban`, `chartDashboard`. Wizard-as-
component holds that line.

---

## 11. Migration

- Existing `.ddd` files keep working — a deployable with `platform: react`
  but no `ui:` is treated as if a synthesised `ui Default { scaffold modules:
  <all in targets chain> }` were declared and referenced.
- The current `pages-builder.ts`, `view-builder.ts`, `workflow-builder.ts`
  become **scaffold expanders** that produce page-IR nodes instead of TSX
  strings.
- A single new emitter (`pages-emitter.ts`) consumes the page IR.
- `page-objects-builder.ts` stays — it's already driven by route + testid
  metadata, which is exactly what the page IR carries.
- `theme-builder.ts` stays unchanged; theme is a `system` concern.

---

## 12. Open questions / non-goals

- **Per-page theming.** Today `theme { … }` is system-wide. Per-page
  overrides not in v0.
- **Internationalisation.** Strings in `title:`, button labels, etc. likely
  want a `t("…")` form. Not in v0; design so the expression slot can hold
  it later.
- **URL-synced state.** Deferred. v0 state is in-memory only.
- **Multi-step flows as a named construct.** Not in v0; `Action(op, then)`
  + custom components cover the realistic cases. Add `flow` later only if
  forced.
- **User-extensible component library.** v0 stdlib is closed; users compose
  via `component` declarations on top of builtins. A future revision could
  open the stdlib.
- **App-shell beyond menu.** Header (logo / user / search), footer,
  breadcrumb stay hardcoded in v0. Add `header { … }` / `footer { … }`
  later only if real cases force them.

---

## 13. Grammar sketch (appendix)

Productions added to `src/language/ddd.langium`. Reuses existing `TypeRef`,
`Expression`, `Parameter`. Soft keywords noted where applicable.

```langium
// Add to SystemMember alternatives:
SystemMember:
    Module | Deployable | BoundedContext | TestE2E | UserBlock | ThemeBlock | Ui;

// Add to Deployable property block:
Deployable:
    'deployable' name=ID '{'
        ...                                    // existing properties
        ('ui' ':' ui=[Ui:ID] ','?)?            // new: react-only
    '}';

Ui:
    'ui' name=ID '{'
        members+=UiMember*
    '}';

UiMember:
    Page | Component | Scaffold | MenuBlock;

Page:
    'page' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? '{'
        props+=PageProp*
    '}';

PageProp:
      'route'    ':' route=STRING
    | 'title'    ':' title=Expression
    | 'requires'      auth=Expression
    | StateDecl
    | 'body'     ':' body=Expression           // expression must resolve to a Component invocation
    | PageMenuMeta;

PageMenuMeta:
    'menu' '{' (entries+=MenuMetaEntry (',' entries+=MenuMetaEntry)* ','?)? '}';

MenuMetaEntry:
    name=('section' | 'label' | 'order' | 'hidden') ':' value=Expression;

Component:
    'component' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
        decls+=ComponentDecl*
        'body' ':' body=Expression
    '}';

ComponentDecl:
    StateDecl;

StateDecl:
    'state' name=ID ':' type=TypeRef ('=' init=Expression)?;

Scaffold:
    'scaffold' selector=ScaffoldSelector ':' targets+=ID (',' targets+=ID)* ','?;

ScaffoldSelector returns string:
    'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views';

MenuBlock:
    'menu' '{'
        sections+=MenuSection*
    '}';

MenuSection:
    'section' name=STRING '{'
        (links+=MenuLink (',' links+=MenuLink)* ','?)?
    '}';

MenuLink:
      'link' page=[Page:ID] ('{' (props+=MenuLinkProp (',' props+=MenuLinkProp)* ','?)? '}')?
    | 'link' label=STRING '->' url=STRING;

MenuLinkProp:
    name=('label' | 'order') ':' value=Expression;
```

`navigate(<Page>, { params })` and `toast(<msg>)` reuse the existing
`CallExpr` rule — they are looked up in the page-language standard
library at lowering time and lowered to typed React Router calls / Mantine
notifications.

---

## 14. See also

- [`examples/sales-ui.ddd`](../examples/sales-ui.ddd) — concrete example
  exercising every construct in this proposal.
- `experience_gathered.md` slice 10 — page-object lessons the new
  metamodel must continue to honour (1:1 page ↔ route, chainable methods,
  testid-driven, no abstraction over Mantine quirks).
