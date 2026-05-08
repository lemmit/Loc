# Page metamodel — RFC

> **Status:** prototype / discussion. The current `react` generator is a one-shot
> module-to-CRUD scaffolder. This document proposes a **page metamodel** that
> makes pages, data sources, state, and on-page event flows first-class language
> constructs, with the existing CRUD generation re-expressed as a `scaffold`
> macro that desugars into the same metamodel.

---

## 1. The problem with today's React generator

`src/generator/react/` (3.7K LOC) is a procedural emitter that walks the IR and
prints TSX. It's a **single hardcoded layout per construct kind**:

- `aggregate` → list / new / detail (+ master-detail for `contains`, modals
  for operations)
- `workflow` → form page
- `view` → table page

The result is good for the 80% CRUD case, but the *source of truth* for the UI
lives only in the generator's string builders. That has four costs:

1. **No textual representation of "a page".** You can't read, refer to, test, or
   override a page in the DSL — only by editing TypeScript in the generator.
2. **No event flows.** The implicit flow is "submit → mutate → invalidate →
   navigate". There's no syntax for "submit → if status == Draft → call
   `confirm` → toast → navigate", or "filter changes → debounce → refetch".
3. **No composition.** Master-detail across two aggregates, a dashboard, a
   wizard, a settings page that mixes a view and a workflow — none of these
   have a representation. They have to be hand-written outside the generator.
4. **Three concept-specific page generators already exist** (aggregate, view,
   workflow). That's the metamodel knocking on the door.

The user's framing: today's behaviour should be a **special case** —
*the unrolling* of a per-module scaffold macro — not the only way to express
a frontend.

---

## 2. What no-code metamodels converge on

Surveying **Retool, Appsmith, Budibase, ToolJet, OutSystems, Mendix, Bubble,
PowerApps, Sanity Studio, Refine.dev, IFML/WebRatio**, the metamodel lands on
six concepts:

| # | Concept | What it is | Already in Loom? |
|---|---------|------------|------------------|
| 1 | **Page / Screen** | Routable unit with parameters & layout | ✗ implicit |
| 2 | **DataSource / Query** | Typed, named, parameterized read or write | ✓ as repo finds, views, ops, workflows |
| 3 | **State** | Local reactive variables (selection, filter, modal-open) | ✗ |
| 4 | **Component / Block** | Visual primitive bound to data + state | ✗ implicit |
| 5 | **Action / Flow** | Event-handler graph: `let`, `call`, `assign`, `navigate`, `emit` | ✓ statement vocabulary covers most |
| 6 | **Layout** | Composition: stack, grid, tabs, master-detail, drawer | ✗ |

Loom already has 4 of 6. The new constructs are **page**, **component**,
**state**, and **layout** — and they all reuse the existing types, expressions,
and statements.

Two specific influences are worth naming:

- **Refine.dev** — `<Refine resource="orders">` auto-derives list/show/edit
  routes; you override per-route. Same shape we want: zero-cost CRUD plus an
  escape hatch.
- **IFML / WebRatio** — formal metamodel of *view containers*, *view components*
  with typed input/output ports, and *navigation flows* connecting events to
  actions. The typed-port idea is the reason "data flows are typed" can be
  enforced statically rather than at run time.

---

## 3. Proposed metamodel

A new top-level construct `ui` lives alongside `system`, peer to `module` and
`deployable`. It owns pages, components, layouts, and reusable flows, and it
binds to one (optionally many) `react` deployable.

```ddd
ui SalesAdmin for webApp {
  scaffold modules: Sales, Catalog       // = today's behaviour, as one line

  // Override or add custom pages — both forms coexist
  page OrderConsole(customerId: Id<Customer>) {
    route: "/customers/:customerId/orders"
    title: "Orders for {{customer.name}}"
    requires currentUser.permissions.contains(sales.viewOrders)

    data customer = Customers.byId(customerId)
    data orders   = Orders.byCustomer(customerId)
    data confirm  = mutation Order.confirm
    data summary  = view OrderSummary

    state selectedId: Id<Order>?
    state showDraftsOnly: bool = false

    layout MasterDetail(masterWidth: 360) {
      master {
        show Toolbar {
          show Toggle(showDraftsOnly) { label: "Drafts only" }
        }
        show List(orders, filter: o => !showDraftsOnly || o.status == Draft) {
          item: o => Card {
            title: "Order " + o.id,
            subtitle: o.placedAt,
            badge: o.status
          }
          on select: o => selectedId := o.id
        }
      }
      detail when selectedId != null {
        show OrderPanel(orders[selectedId])
      }
    }

    on orders.error: e => toast.error(e.message)
  }
}
```

### 3.1 `page`

```
page <Name> [(<params>)] {
    route: <string>                 // path-with-:params
    title: <string>?                // optional, accepts "{{expr}}"
    requires <expr>?                // auth gate, same syntax as operations

    (data | state)*                 // declarations
    (layout | show)*                // visual content
    (on <event>: <flow>)*           // top-level page events
}
```

Page parameters are typed and bound from the route + query string. The
generator already derives a Zod schema for them (current grammar's `Property`).

### 3.2 `data` — typed data sources

```
data <name> = <DataSourceExpr>
```

`DataSourceExpr` resolves to one of the **already-typed** Loom artifacts:

| Form | Resolves to | Generated as |
|---|---|---|
| `Repo.findName(args)` | `T[]` or `T` | `useQuery` |
| `Repo.byId(id)` | `T` | `useQuery` |
| `view <ViewName> [where <filter>]` | row-shape `[]` | `useQuery` |
| `mutation <Aggregate>.<op>` | `(input: OpInput) => Promise<T>` | `useMutation` |
| `workflow <wfName>` | `(input: WfInput) => Promise<void>` | `useMutation` |
| `api <ExternalDS>.<call>(args)` | typed from external schema | `useQuery`/`useMutation` |

The typing reuses the existing IR — there is no parallel page-type system.
`orders.error`, `orders.loading`, `orders.data` are members of the data-source
handle, surfaced statically via the React Query state shape.

### 3.3 `state` — local reactive variables

```
state <name>: <TypeRef> [= <expr>]
```

Same `TypeRef` as everywhere else in the language. State is reactive (writes
re-render), URL-syncable (`@url state filter: string = ""`), and addressable
from flows (`selectedId := order.id`).

### 3.4 `show` — components

```
show <Component>([positional, ...] [, named: value, ...]) [{
    <prop>: <expr>
    on <event>: <flow>
    <child show>*
}]
```

Built-in components form a small, intentional set: **Stack, Grid, Tabs, Card,
Heading, Text, Table, List, Form, Field, Button, Badge, Toggle, Select, Drawer,
Modal, Toolbar, Breadcrumb**. Each has typed props (e.g. `Table` takes
`rows: T[]` and infers columns from `T`). Anything outside the set is a
user-defined `component`.

### 3.5 `component` — reusable parameterized blocks

```
component OrderPanel(order: Order) {
    show Stack {
        show Heading("Order " + order.id)
        show Table(order.lines) {
            column unitPrice: line => line.unitPrice
            column qty:       line => line.quantity
            column subtotal:  line => line.subtotal
        }
        show Button("Confirm") {
            enabled: order.isMutable()
            on click: flow {
                call confirm({ id: order.id })
                toast.success("Order confirmed")
                navigate to OrderConsole(customerId: order.customerId)
            }
        }
    }
}
```

`component` is to a page what `function` is to an operation: a typed,
parameterized, reusable unit. They compose via `show`.

### 3.6 `flow` — on-page event flows

Flows are statement bodies. They reuse Loom's existing statement grammar
(`precondition`, `requires`, `let`, `emit`, `:= / += / -=` , bare calls) and
add three actions:

| New action | Meaning |
|---|---|
| `navigate to <Page>([args])` | Client-side route change with typed params |
| `toast.success(<expr>)` / `toast.error(<expr>)` | UX side-effect |
| `<state> := <expr>` | Already legal syntax; here it targets `state`, not aggregate fields |

A flow can be inline at an event site, or named at the top of a `ui` block:

```ddd
flow placeAndOpen(customerId: Id<Customer>) {
    let order = call placeOrder({ customerId, placedAt: now() })
    navigate to OrderConsole(customerId: customerId)
}
```

Because flows reuse Loom statements, every flow is type-checkable against the
data-source signatures, and `requires`/`precondition` give you button-disable
semantics for free (the lowering can render `enabled` from the same predicate).

### 3.7 `layout` — composition primitives

```
layout MasterDetail(masterWidth: int = 320) { master { ... } detail when <expr> { ... } }
layout Tabs                                  { tab "Lines" { ... } tab "Audit" { ... } }
layout Grid(cols: int)                       { ... }
layout Stack(gap: int = 16)                  { ... }
```

Layouts are containers; `show` is the leaf. A layout can be referenced as if it
were a component, which means the user can wrap a custom layout into a reusable
named component just like any other.

---

## 4. Auto-CRUD as desugaring (the "unrolling")

The current generator behaviour is recovered as a macro:

```ddd
ui SalesAdmin for webApp {
    scaffold modules: Sales
}
```

…lowers, before code generation, to a set of explicit page declarations
synthesised from the IR — one per `aggregate` (list/new/detail), one per `view`,
one per `workflow`, plus the home and navigation. That synthesised AST is what
the page-emitter sees; the existing `react/` builders move from "walk the
domain IR" to "walk the page IR." The output is bit-identical to today's, but
the source of truth is now a metamodel artifact you can inspect, override, or
replace piece by piece.

**Partial overrides** become trivial:

```ddd
ui SalesAdmin for webApp {
    scaffold modules: Sales

    // Replace just one scaffolded page; rest is auto
    page OrderDetail(id: Id<Order>) {
        // …custom layout that mixes in OrderSummary view + audit log…
    }
}
```

Resolution: scaffold runs first; explicit `page <Name>` with a matching name
**replaces** the scaffolded one. Same idea as Mendix's "override page from
template" or Refine's per-resource action override.

---

## 5. Why this fits Loom specifically

1. **Types reused, not parallel.** `data o = Orders.byId(id)` types
   `o: Order` via the existing repository signature; `mutation Order.confirm`
   types as `(input: ConfirmInput) => Promise<Order>` from the existing
   operation signature.
2. **Statements reused.** Flows are Loom statements with three additions.
   Lowering already knows `let`, `precondition`, calls, `:=`, `emit`.
3. **Expressions reused.** Conditional render (`when`), data bindings, list
   filters — all use the existing `Expression` rule (`TernaryExpr`, lambdas,
   member access, etc.).
4. **Backends already produce the right shapes.** Repo finds, views, operation
   and workflow input shapes are already wired to typed HTTP routes with Zod
   schemas. The page generator consumes those — no new wire layer.
5. **Theme, sidebar, page objects survive.** Scaffolded and explicit pages both
   register their route/title/testids; the existing AppShell + Playwright
   emitters loop over the unified page list.
6. **Aligns with extern API plans.** `data fx = api ExchangeRates.usd(now())`
   slots external typed datasources into the same vocabulary as internal ones —
   no second concept.
7. **Validation has an obvious home.** The Loom validator already cross-checks
   types in operation bodies; flows are operation bodies in disguise.

---

## 6. What the page IR looks like

```ts
type Page = {
    name: string
    params: Param[]              // typed route/query params
    route: string
    title?: Expression
    requires?: Expression
    data: DataDecl[]             // typed reactive sources
    state: StateDecl[]
    children: ShowOrLayout[]     // visual tree
    pageEvents: EventBinding[]   // on <event>: <flow>
}

type DataDecl = {
    name: string
    source:
      | { kind: "repoFind",   repository, find,   args: Expression[] }
      | { kind: "repoById",   repository,         id:   Expression }
      | { kind: "view",       view,               filter?: Expression }
      | { kind: "mutation",   aggregate, operation }
      | { kind: "workflow",   workflow }
      | { kind: "externalApi", source, call,      args: Expression[] }
    inferredType: Type           // from the resolved target's signature
}

type ShowOrLayout =
  | { kind: "show",    component, args: Arg[], props: Prop[], events: EventBinding[], children: ShowOrLayout[] }
  | { kind: "layout",  layout, args: Arg[], slots: { name: string, when?: Expression, children: ShowOrLayout[] }[] }
```

Lowering steps (mirrors today's generator pipeline):

1. **Parse** `ui` blocks → CST
2. **Expand `scaffold`** → synthetic `Page[]` derived from the domain IR
3. **Resolve & type-check** data sources, state references, navigation targets,
   flow statements (reuses existing type system)
4. **Validate** (every `data` resolved, every `navigate to` page exists with
   matching params, no state cycles, every `requires` types to `bool`, …)
5. **Emit** TSX from the page IR — replaces today's procedural builders

---

## 7. Migration

- Existing `.ddd` files keep working — no `ui` block means an implicit
  `ui Default for <reactDeployable> { scaffold modules: <all> }`.
- The current `pages-builder.ts`, `view-builder.ts`, `workflow-builder.ts`
  become **scaffold expanders** that produce page-IR nodes instead of TSX
  strings.
- A single new emitter (call it `pages-emitter.ts`) consumes the page IR.
- Page-objects-builder stays — it's already driven by route + testid metadata,
  which is exactly what the page IR carries.

---

## 8. Open questions

- **Cross-page selection / global state.** Is there a `ui`-level `state` peer
  to page state, or do we make users hoist via URL? Lean: URL-only for the
  prototype; revisit when a real use case appears.
- **Imperative escapes.** `code "tsx" { ... }` block to drop down? Risky —
  invites "the generator is just printf templates again." Defer.
- **Which built-ins are in scope.** The list in §3.4 is a starting set;
  finalising it is a real exercise. Use the current generator's actually-emitted
  Mantine components as the v0 set.
- **Theming per-page vs system-wide.** Today `theme { ... }` is system-wide.
  Per-page overrides are a future extension; not in v0.
- **Internationalisation.** Strings in `title:`, button labels, etc. likely
  want a `t("...")` form. Out of scope for the prototype; design so the
  expression slot can hold it later.

---

## 9. See also

- [`examples/sales-ui.ddd`](../examples/sales-ui.ddd) — concrete DSL example
  that exercises every construct in this proposal, including a `scaffold` line
  alongside three explicit overrides.
- `experience_gathered.md` slice 10 — page-object lessons that the new
  metamodel must continue to honour (1:1 page ↔ route, chainable methods,
  testid-driven, no abstraction over Mantine quirks).
