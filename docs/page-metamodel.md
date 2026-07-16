# Page metamodel — final v0

> Supersedes the v22 React generator's hardcoded subdomain-to-CRUD scaffolder
> with a declarative page metamodel: pages, components, scaffolding, state,
> menus. Six declaration keywords, two expression-level reserved tokens,
> one tiny grammar lift on `Lambda` and `Property`. No macro system, no
> record algebra, no per-archetype keywords.

---

## 1. Vision

Today's React generator is a procedural emitter that prints TSX from the
domain IR. There is no source representation of "a page", so any UI choice
that diverges from the implicit list/new/detail-per-aggregate shape requires
forking the generator in TypeScript. This RFC promotes the page to a
first-class language construct, with the existing CRUD behaviour recovered
as a `scaffold` macro that desugars into the same metamodel.

Three rules:

1. **Closed and minimal.** Six declaration keywords. No user-extensible
   macros. The standard component library is closed in v0.
2. **Reuse the existing IR for typing.** Data sources resolve to repository
   finds, views, operations, workflows, external APIs — every name typed
   via the existing signature. No parallel type system.
3. **Declarative, expression-driven.** Each property is a fact; structural
   variation lives in the expression engine (`match`), not in dedicated
   declaration forms.

---

## 2. New keywords

**Declaration-level (6):**

| Keyword | Role |
|---|---|
| `ui` | Top-level block; `SystemMember`, peer to `subdomain`, `deployable`, `theme`, `user`. |
| `page` | Declares a route + body. |
| `component` | Parameterised region tree — typed function from params (and optional state) to a body expression. |
| `scaffold` | Single fixed multi-page rewrite from a domain selector to pages. |
| `state` | Block of reactive local fields. |
| `menu` | Optional `ui`-level block declaring sidebar structure. |

**Expression-level (2):**

| Keyword | Role |
|---|---|
| `match` | Predicate-arms expression; first true arm wins; usable anywhere expressions appear. |
| `else` | Fallthrough arm of `match`. |

**Reused without change:** `requires` (auth gate), `let` (in flows / event-handler blocks), all existing operators, `:=` (state mutation, already in operations).

**Soft keywords inside their parent block:** `section`, `link` (inside `menu`).

**Channel subscription (channels.md Part I):** two further `ui` members —
`channel <name>: <Ctx>.<Channel>` subscribes the UI to a context's
`delivery: broadcast` channel, and `on <name>.<Event>(e) { toast(<expr>) }`
renders the arriving event as a toast (v1 handler bodies are toast-only;
`loom.ui-handler-unsupported`).  The handlers compile to one renderless
`RealtimeHandlers` component mounted by the App shell, fed by the
`src/api/realtime.ts` SSE client; the toast call routes through each design
pack's `realtime-toast` micro-template.

---

## 3. Where `ui` lives

`ui` is declared at system scope; deployables reference it.

```ddd
system Acme {
  subdomain Sales { context Orders { ... } }

  theme { primary: "#3b82f6", neutral: "#9ca3af" }
  user  { id: string, permissions: string[] }

  ui SalesAdmin {
    scaffold subdomains: [Sales]
    page OrderConsole(customerId: Customer id) { ... }
    menu { ... }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }

  deployable api    { platform: dotnet, contexts: [Orders], dataSources: [ordersState], port: 8080 }
  deployable webApp { platform: react,  targets: api, ui: SalesAdmin, port: 3001 }
}
```

The deployable references the ui via `ui: SalesAdmin`, mirroring how it
already references hosted contexts. One ui can be served by multiple react
deployables.

**Validator obligations**

- Every `react` deployable **must** declare `ui: <Name>`. No implicit
  default; the absence is a hard error.
- `deployable.ui` must reference an existing `ui` block.
- Only `react` deployables may set `ui:`.
- Every `scaffold` selector and every page-data binding inside the `ui` must
  resolve to a subdomain reachable through the deployable's `targets` chain.

---

## 4. `page`

A page is a route + parameters + optional state + body + optional menu
metadata. Body is a single expression. Properties use Loom's existing
colon-separator idiom (matches `Deployable`, `ThemeProp`, `EmitField`).

```ddd
page OrderList {
  route: "/orders"
  body:  scaffoldList { of: Order }
}

page OrderDetail(id: Order id) {
  route: "/orders/:id"
  body:  scaffoldDetails { of: Order }
}
```

List/detail pages are normally produced wholesale by `scaffold(aggregates:
[…])`; the `scaffoldList`/`scaffoldDetails` body sentinels above are the
hand-writable form — useful when you want a list or detail *embedded* in a
larger custom page body (a `Stack` alongside other components), or to declare
a page the scaffold selector didn't cover. They expand at lowering time into
the full Breadcrumbs · Toolbar · QueryView · Table tree.

| Property | Meaning |
|---|---|
| `route:` | Path-with-`:params`. Path params bind to typed parameters. |
| `title:` | String expression, may interpolate page data. |
| `requires` | Auth predicate — same syntax as on operations. On a React frontend with `auth: ui`, the page renders a client-side `<Forbidden/>` guard (evaluated against `useSession().user`) — the mirror of the backend's 403. Gates are `currentUser`-only (see [auth.md](auth.md#view-requires-gates)). |
| `state { … }` | Reactive local fields (see §6). At most one, multiples merge. |
| `body:` | Single expression. May be a `match`, a ternary, a component invocation, anything. |
| `menu { … }` | Per-page menu metadata (`section`, `label`, `order`, `hidden`). |

---

## 5. `component`

Components are typed functions from parameters (and optional local state)
to a body expression. They never declare a route.

```ddd
component OrderPanel(order: Order) {
  body: Stack {[
    Heading { "Order " + order.id, level: 2 },
    Badge { order.status },
    Table { order.lines, columns: [productId, quantity, unitPrice, subtotal] },
    Toolbar {[
      Action(confirm, then: navigate(OrderConsole, { customerId: order.customerId })),
      Action(cancel,  then: toast("Cancelled"))
    ]}
  ]}
}
```

The compiler enforces parameter relationships at every call site:
`Form { creates: Order }` binds form fields to `wireShape(Order.create)`;
`scaffoldDetails { of: Order }` resolves the `of:` aggregate and exposes its
operations as actions.

User-defined components are pure functions over their parameters and local
state — they cannot synthesise pages, routes, or menu entries.

### 5.1 Where components may live

Components declare in two scopes; both forms parse identically and share the
same emission path (one `src/components/<Name>.tsx` per ui that references
them).

- **`ui`-scope** (`ui WebApp { component X(…) { … } }`) — visible only to
  pages and other components inside the same ui block. Use when the
  component is specific to one frontend.
- **Top-level** (`component X(…) { … }` at the file root, outside any
  `system { … }`) — visible workspace-wide through Loom's import-graph
  walk. A `.ddd` file can be a pure component library: declare components
  bare at the root and `import "./marketing-lib.ddd"` from any other
  `.ddd` to use them. Lives in the same global scope as root-level value
  objects and enums.

On a name collision the **ui-scope wins** — a `component Hero` inside a ui
shadows a top-level `component Hero` reachable through imports.

### 5.2 Parameter types

| Type | Example | Meaning |
|---|---|---|
| Primitive | `(title: string, level: int)` | Plain value, rendered into JSX positions or used in expressions. |
| Aggregate | `(order: Order)` | Strongly-typed aggregate instance — `order.confirm` resolves to the operation and the walker hoists the mutation hook into the calling page. See `web/src/examples/action-showcase.ddd`. |
| `slot` | `(heading: slot, primaryAction: slot)` | Element-shaped marker — the caller passes any walker expression (`Heading { … }`, `Action { order.confirm }`, even a nested component invocation) and the component body renders it via a bare ref (`Stack { heading }`). Slots are walked in the **caller's** scope, so refs / aggregate ops / route params resolve against the calling page. `slot?` marks an optional slot. |

Slot params unlock generic structural components: a `DetailView` declares
where the heading, summary, and action positions sit; each call site fills
them with site-specific JSX. Every component invocation is implicitly a slot
value, so components nest into each other's slots without further ceremony.

```ddd
component DetailView(heading: slot, primaryAction: slot, secondaryAction: slot?) {
  body: Stack {
    heading,
    Toolbar { primaryAction, secondaryAction }
  }
}

page OrderDetail(order: Order) {
  route: "/orders/:id"
  body: DetailView {
    heading:        Heading { "Order #" + order.id, level: 2 },
    primaryAction:  Action { order.confirm, then: navigate(Home) },
    // secondaryAction is `slot?` — omitting it is admitted.
  }
}
```

The validator rejects `slot` anywhere except a component parameter list
(`loom.slot-out-of-position`) and member access on a slot ref
(`loom.slot-member-access`).

---

## 6. `state { … }` block

Reactive local fields. Same shape as `theme { … }`, `user { … }`,
`permissions { … }` — a block of typed declarations. Multiple blocks merge
(matches `permissions`).

```ddd
state {
  step:  int               = 0
  draft: PlaceOrderRequest = {}
}
```

Each field is `name: TypeRef ('=' init=Expression)?`. Init optional;
omitted fields default to `null` for optionals, zero/empty for non-optionals.
Writes use `:=` (already a Loom statement form).

URL synchronisation deferred to a later revision. v0 state is in-memory
only.

---

## 7. `match` expression

Predicate-arms expression — first true arm wins, optional `else`. Lives in
the expression engine and is usable anywhere an expression appears.

```ddd
body: match {
  step == 0 => Form { fields: [customerId], onSubmit: toItems }
  step == 1 => Form { fields: [items],      onSubmit: toReview }
  step == 2 => Review(draft,              onSubmit: submitOrder)
  else      => Empty {}
}
```

Reusable across the language, not just in page bodies:

```ddd
derived display: string = match {
  status == Draft     => "Pending"
  status == Confirmed => "Awaiting shipment"
  status == Shipped   => "In transit"
  else                => "Closed"
}

view OrderSummary {
  riskLevel: string
  from Order
  bind riskLevel = match {
    total.amount > 10000 => "high"
    total.amount > 1000  => "medium"
    else                 => "low"
  }
}
```

Validator may warn on non-exhaustive matches that lack `else`.

---

## 8. Effectful handlers live in a named `action`

A "mutate then navigate" event handler is a block of statements — `:=` state
writes, `+=`/`-=`, calls, `emit`, `navigate`. **These live in a named `action`,
never in an inline render-tree lambda.** An inline effect handler
(`onSubmit: c => { step := 1 }`) is rejected by `loom.effect-in-lambda`
([`docs/actions.md`](actions.md)); a render-tree lambda must be pure (a value
projection — §8.1). Declare the handler and reference it by name:

```ddd
page PlaceOrderWizard {
  state { step: int = 0  draft: PlaceOrderRequest = {} }
  action toItems(c) {
    draft.customerId := c.customerId   // nested state write
    step := 1                          // scalar state write
    tags  += newTag                    // collection append
    tags  -= oldTag                    // collection remove
    count += 1                         // scalar increment
  }
  body: match {
    step == 0 => Form { fields: [customerId], onSubmit: toItems }
    else      => Empty {}
  }
}
```

An `action` body reuses the `Statement` rule (`let`, `:=`, calls, `emit`); the
block-body lambda still exists in the render tree, but only for **pure** value
composition (§8.1). The split is **read vs write** — a render-tree lambda may
read `state`/`store`/props and compute freely, but only an `action` may write —
tabulated allowed/rejected in
[`docs/actions.md` → "What belongs in a lambda vs an action"](actions.md).

State-mutation lowering across the frontends (inside an `action` body):

- **`:=` nested** (`addr.zip := v`) — React rebuilds the object immutably
  (`setAddr({ ...addr, zip: v })`); Vue refs / Svelte `$state` / Angular
  signals mutate in their native idiom (Vue/Svelte in place, Angular via
  `set`).
- **`+=` / `-=` are type-driven.** On a **collection** target they append /
  remove (`[...tags, v]` / `tags.filter(x => x !== v)`); on a **scalar**
  target they're arithmetic (`count + 1`). The collection-vs-scalar signal
  rides the lowered target type.

### 8.1 Inline collection ops

A lambda is also admissible in plain **expression** position — as the
callback of a higher-order collection op on a list value. This lets a page
shape a collection inline instead of pushing every variant back into a
backend `view`/`find` `where`-clause:

```ddd
body: Stack {
  For { each: orders.filter(o => o.status == Confirmed), o => OrderCard(o) }
}
```

`filter` / `map` (native JS array methods) render verbatim through the body
walker — the callback's parameter binds in scope exactly like a `For` item
or a `Table` column accessor. Chains compose (`orders.filter(…).map(…)`).

Two boundaries to know:

- **Single-param callbacks only** — the grammar's `Lambda` is `param=ID =>
  …`, so a two-arg comparator (`sort((a, b) => …)`) isn't expressible. A
  single-arg key-sort (`sortBy(o => o.key)`) has no native array method or
  runtime helper yet on any frontend, so pre-shape ordering in a backend
  `view`/`find` for now.
- **All frontends.** React, Vue, Svelte, and Angular share the `emitExpr` engine; Feliz supplies its own F# leaves (`src/generator/feliz/fs-expr.ts`) through the same dispatcher;
  Phoenix/HEEx runs a parallel engine that mirrors the same ops to Elixir
  idioms (`filter`/`map` → `Enum.filter/2` / `Enum.map/2`), so inline
  `filter`/`map` shaping works on every frontend.

### 8.2 Dependent / conditional form validation — use `state`

There is **no dedicated "conditional field" or "dependent validation"
construct**, and you don't need one — the existing pieces compose to it.
Split the problem by where the rule lives:

- **Cross-field rules over fields that travel the wire** (`endDate >
  startDate`, `total <= creditLimit`, "`vatId` required when `kind ==
  company`") are a **contract** concern, not a form concern. Declare them as
  an aggregate / value-object `invariant … (when …)` (or an operation
  `precondition`). Loom already lowers each to a zod `.refine((data) => …, {
  path, message })` on the form's request schema **and** to every backend's
  validator **and** to the live RFC-7807 `errors[]` surface — so a
  `CreateForm { of: T }` shows the error inline, with no per-form wiring.
  See [`docs/language.md`](language.md) (invariants) and the shipped
  `validation-error-extension.md`.

- **Rules over client-only fields that never reach the server**
  (`confirmPassword == password`, "repeat email", an un-stored consent
  checkbox, or showing/hiding a field on another's live value) belong on the
  **page**, not the wire. Hand-compose the form from the bindable inputs
  (`Field` / `PasswordField` / `SelectField` / `Toggle`) over `state`,
  derive the predicate with `derived`, gate visibility with `match`, and pass
  the inline message through each input's **`error:`** slot:

  ```ddd
  page SignUp {
    route: "/signup"
    state {
      email:           string = ""
      password:        string = ""
      confirmPassword: string = ""
    }
    derived passwordsMatch: bool = confirmPassword == password

    body: Stack {[
      Field         { "Email",    bind: email },
      PasswordField { "Password", bind: password },
      PasswordField { "Confirm",  bind: confirmPassword,
                      error: passwordsMatch ? "" : "Passwords must match" },
      Button { "Create account",
               disabled: !passwordsMatch,
               on: () => call signup({ email, password }) }  // confirmPassword never sent
    ]}
  }
  ```

  ```tsx
  const passwordsMatch = useMemo(() => confirmPassword === password, [confirmPassword, password]);
  // …
  <PasswordInput label="Confirm" value={confirmPassword}
                 onChange={(e) => setConfirmPassword(e.currentTarget.value)}
                 error={ passwordsMatch ? "" : "Passwords must match" } />
  ```

  `confirmPassword` is a `state` field, so it is in scope for `derived` /
  `match` / `error:`, and `call signup({ email, password })` posts only the
  wire fields — the confirmation never travels. `error:` takes any expression
  (empty string ⇒ no error); it renders in each pack's native error slot —
  Mantine's `error=` prop, MUI's `helperText`, Chakra's `ErrorText`, shadcn's
  destructive `<p>`, Vuetify's `:error-messages`, Angular Material's error
  span — across all React / Vue / Svelte / Angular packs.

---

## 9. Builtin component library — closed v0

| Component | Purpose |
|---|---|
| `scaffoldList { of: T }`, `scaffoldDetails { of: T }` | Canonical list / single-record page bodies (Breadcrumbs · Toolbar · QueryView · Table; field card · operation actions). Emitted by `scaffold(aggregates: […])`; also hand-writable to embed a list/detail in a custom page body. *(The earlier `List` / `Detail` / `MasterDetail` archetype names were inert, never-rendered duplicates of these and were **removed** — see [decisions.md → D-NO-PAGE-ARCHETYPES](decisions.md#d-no-page-archetypes).)* |
| `Form { creates: T \| runs: workflow \| into: state, fields, onSubmit, then? }` | Input form bound to a typed request slice. |
| `Dashboard(items: […])` | Composite read-only page; grid layout. |
| `Review(of: T, onSubmit)` | Read-only summary view of a typed value, with a submit action. |
| `Stack`, `Group`, `Grid`, `Tabs` (+ `Tab`), `Card`, `Toolbar`, `Container`, `Paper`, `Breadcrumbs`, `Divider`, `Section`, `Sticky` | Layout primitives. `Section` is a semantic anchor target; `Sticky` a sticky-position wrapper; `Tab` is the sub-element of `Tabs`. |
| `Heading`, `Text`, `Bold`, `Italic`, `InlineCode`, `Badge`, `Stat`, `Empty`, `Anchor`, `Image`, `Avatar`, `Loader`, `Skeleton`, `Alert`, `KeyValueRow`, `Icon` | Display primitives. `Bold`/`Italic`/`InlineCode` are inline-emphasis spans; `Icon` is a builtin-name or `svg:` literal. |
| `Field`, `NumberField`, `PasswordField`, `MultilineField`, `Toggle`, `SelectField { label, bind, options }`, `Select`, `Fieldset` | Bindable inputs. `MultilineField` is the textarea twin of `Field`; `SelectField` is a controlled single-select over a string-array `options:` expression. All accept an optional `error:` expression rendered in the pack's inline error slot (§8.2). |
| `Action(operation, then?)`, `Button { label, on? }` | Action primitives. |
| `Modal { trigger, … }` | Disclosure surface — hosts an `OperationForm` (scaffold detail pages) or a state-controlled `open:` body. |
| `Money`, `DateDisplay`, `EnumBadge`, `IdLink` | Formatter primitives. |
| `CodeBlock` | Syntax-highlighted code block (highlight.js at runtime). |
| `Table`, `Column` | Tabular display (data lambda accessors). |
| `For { each: T[], empty?: markup, item => markup }` | List comprehension — emits the item lambda's markup once per element. TSX lowers to a keyed `.map` + `<Fragment>`, Vue to `<template v-for :key>`, Svelte to a keyed `{#each}`, Angular to an `@for (… ; track …)` block, Phoenix LiveView to a `for … do … end` block. A child primitive (nest inside a layout container — it isn't a standalone page body); the list key is the loop index. The optional `empty:` arm is rendered when the collection is empty — Svelte's native `{:else}`, a TSX `length === 0 ? … : .map(…)` ternary, a Vue `v-if` sibling `<template>`, Angular's `@for`/`@empty` block, a HEEx `Enum.empty?/1` guard. |
| `QueryView { of:, loading:, error:, empty:, data:, single?: }` | 4-arm query-state branching (collection or single-record). |

The set is closed in v0. **Removed from earlier drafts:** `Wizard`, `Stage`,
`Switch`, `Case`, `When`, `Sequence` — all subsumed by `match` plus the
state/transition primitives. The polymorphic `Form { creates: | runs: |
into: | <instance>.<op> }` dispatcher is also gone: it split into the four
named-leaf forms above (`CreateForm` / `OperationForm` / `WorkflowForm` /
`DestroyForm`), each a distinct primitive rather than one overloaded name.
The narrative `Form { … }` snippets in §7 and the §12 wizard sketches
predate that split — read them as the corresponding named-leaf form (the
`into:` / `fields:` draft-binding shapes remain illustrative; multi-step
draft forms are a §14 non-goal, not a shipped primitive).

`List` / `Detail` / `MasterDetail` were also retired: they were legacy
archetype names that never had walker renderers (they silently degraded to a
`// not supported` comment), so they're gone as standalone primitives. The
list / detail use case is served by `scaffoldList { of: T }` /
`scaffoldDetails { of: T }` (the scaffold archetypes, usable as explicit
bodies — `List { of: T }` is now spelled `scaffoldList { of: T }`) or by
composing `QueryView` + `Table` directly. The `List`/`Detail`/`MasterDetail`
snippets in §4, §5, and §12 predate that removal — read them as the
`scaffold*` archetypes (`MasterDetail`'s split-pane has no built-in
archetype; compose it from a list + selection `state {}` + a detail panel).

Four further names from earlier drafts of this table never shipped as
primitives at all: `Dashboard` and `Review` (composite read-only pages —
express them as a `Stack`/`Grid` of the display primitives; the `Review(…)`
calls in the §12 wizard sketches are illustrative, like the draft-form
shapes above), `Select` (use `SelectField`), and `Fieldset` (an internal
value-object render shape, not a hand-writable input). The closed set is
exactly the rows above.

Users freely define their own `component`s, which compose these builtins.

---

## 10. `scaffold` — the one macro

Single fixed pre-codegen pass. Not user-extensible. Hierarchical:

```
scaffold subdomains: A, B, …    →  ∪  scaffold contexts:   <each context in each subdomain>
scaffold contexts:   X, Y, …    →  ∪ {
                                       scaffold aggregates: <each aggregate in X>,
                                       scaffold workflows:  <each workflow in X>,
                                       scaffold views:      <each view in X>
                                     }
scaffold aggregates: Order, …   →  page <Order>List + <Order>New + <Order>Detail
scaffold workflows:  placeOrder, … → page PlaceOrderWorkflow  (+ shared WorkflowsIndex)
scaffold views:      ActiveOrders, … → page ActiveOrdersView  (+ shared ViewsIndex)
```

### What each scaffolded page contains

Scaffold is sugar: the `with scaffold(...)` macro emits each page with a
walker-stdlib body (built by `src/macros/stdlib/scaffold/_body-builders.ts`)
identical to one the user could hand-write. The contract per page:

| Page | Body |
|---|---|
| `<Agg>List` | Breadcrumbs · Toolbar (heading + "New" button) · `QueryView { of: api.<Agg>.all }` → `Table` with one `Column` per **non-collection** scalar field (`IdLink` / `EnumBadge` / `DateDisplay` / text by type), per-row testid. |
| `<Agg>New` | Breadcrumbs · heading · `Card { CreateForm { of: <Agg> } }` — RHF + Zod + `useCreate<Agg>`, one input per required field. |
| `<Agg>Detail` | Breadcrumbs · heading · `QueryView { of: api.<Agg>.byId(id), single: true }` whose data card holds **three** sections: ① `KeyValueRow` per scalar field; ② one **operation control** per `public operation` — a button that opens a `Modal` hosting an auto-generated `OperationForm { data.<operation> }` (the operation referenced through the loaded record) bound to the `use<Op><Agg>` mutation hook (params dispatched by the same type rules as `CreateForm { of: }`); ③ one **related-entity list** per `contains` collection — a titled `Card { Table }` over `data.<containment>` with a `Column` per part field. |
| `<Workflow>Workflow` | Breadcrumbs · heading · `Card { WorkflowForm { runs: <wf> } }`. |
| `<View>View` | Heading · `QueryView { of: Views.<name> }` → `Table`. |

The Detail page's operations + related-entity lists are the
platform-completeness proof for the modal/disclosure and nested-table
primitives: if `scaffold` can emit them, an explicit `page` can too
(see `examples/acme-order-explicit.ddd`).

Multiple `scaffold` directives stack. No `except` clause — list what you
want, not what you don't.

```ddd
ui SalesAdmin {
  scaffold subdomains: [Catalog]             // bulk
  scaffold aggregates: Customer, Product     // a la carte
  scaffold workflows:  placeOrder
  page OrderList   { ... }                   // custom
  page OrderDetail { ... }
}
```

### Override-by-name

Three layered scales of override, all the same mechanism — explicit
`page <Name>` replaces the scaffolded page with the matching name.

| Granularity | Override |
|---|---|
| Whole context | Don't `scaffold context X` — list its aggregates, omit some |
| Whole aggregate | Don't `scaffold aggregates: X` — write its pages explicitly |
| Single page | `scaffold` it but declare a `page <Name>` with the matching name |

### Validator obligations

- Each `scaffold <kind>: <name>` resolves to an existing declaration of
  that kind, reachable through the deployable's `targets`.
- Stacked `scaffold` directives may not double-scaffold the same construct.
- Two `scaffold` directives may not produce pages with identical generated
  names; explicit `page <Name>` overrides exactly one source.

---

## 11. `menu` — layered defaults + explicit composition

Pages carry `menu { … }` metadata; sidebar is derived. Optional `ui`-level
`menu` block overrides for full control.

### Lowering

```
1. Run scaffold → pages, each with default `menu { section, label }`
   (defaults: aggregates → "Aggregates", workflows → "Workflows", views → "Views")
2. Apply explicit `page X` overrides (by name)
3. If `ui` has a `menu { … }` block:
       sidebar = that block, resolved against the page registry
   else:
       sidebar = pages grouped by `menu.section`, sorted by `menu.label`
```

### Explicit form

```ddd
menu {
  section "Sales"   { link Orders.List, link OrderConsole, link Orders.New }
  section "Lookup"  { link Customers.List, link Products.List }
  section "Reports" { link ActiveOrdersView, link OrderSummaryView }
  section "External" {
    link "Docs" -> "https://docs.acme.com"
  }
}
```

A scaffold names an aggregate's pages by **role** (`List` / `New` / `Detail`)
inside its per-aggregate `area` (`area Orders`), so a bare `link List` is
ambiguous across aggregates.  Disambiguate with the **area-qualified** form
`link Orders.List` / `link Orders.New`.  Pages with a unique name — custom pages
(`OrderConsole`), views (`ActiveOrdersView`), and the singleton dashboards
(`Home`) — link by bare name.

`scaffold` doesn't *return* anything — it contributes pages-with-menu-metadata
to a shared registry. The `menu` block is the explicit composition operator
over that registry.

Per-link auth: a `link Orders.List` inherits the underlying page's `requires`
clause.  The React page guard (above) already renders `<Forbidden/>` on a gated
page; conditionally **hiding** the matching menu link (so it never shows for a
caller who can't reach it) is the next slice — today the link still renders and
the destination page guards itself.

---

## 12. Wizard via composition

Wizard is **not** a language construct. It's a pattern that emerges from
state + match + block-body lambdas + navigation. Two shapes both work:

### Single-page wizard (in-memory, fastest)

```ddd
page PlaceOrderWizard {
  route: "/orders/new"

  state {
    step:  int               = 0
    draft: PlaceOrderRequest = {}
  }

  action toItems()  { step := 1 }
  action toReview() { step := 2 }
  action submitOrder() {
    call placeOrder(draft)
    navigate(OrderConsole, { customerId: draft.customerId })
  }
  body: match {
    step == 0 => Form {into: draft, fields: [customerId], onSubmit: toItems}
    step == 1 => Form {into: draft, fields: [items],      onSubmit: toReview}
    step == 2 => Review(of: draft,                        onSubmit: submitOrder)
    else      => Empty {}
  }
}
```

### Multi-page wizard (URL-encoded state, deep-linkable)

```ddd
page CustomerStep {
  route: "/orders/new/customer"
  action next(c) { navigate(ItemsStep, { customerId: c.customerId }) }
  body:  Form {fields: [customerId], onSubmit: next}
}
page ItemsStep(customerId: Customer id) {
  route: "/orders/new/items"
  action next(i) { navigate(ReviewStep, { customerId, items: i.items }) }
  body:  Form {fields: [items], onSubmit: next}
}
page ReviewStep(customerId: Customer id, items: OrderLine[]) {
  route: "/orders/new/review"
  action submit() {
    call placeOrder({ customerId, placedAt: now(), items })
    navigate(OrderConsole, { customerId })
  }
  body:  Review(of: { customerId, placedAt: now(), items }, onSubmit: submit)
}
```

Both fall out of existing primitives. Type safety on the final
`call placeOrder(…)` enforces draft completeness.

---

## 13. Migration

**Explicit `ui` is required for every `react` deployable.** No implicit
defaults — every existing `.ddd` file with a `platform: react` deployable
gains an explicit `ui` block. The minimum is a one-liner that recovers
today's behaviour verbatim:

```ddd
ui WebApp { scaffold subdomains: [Catalog, Sales, CustomerMgmt] }

deployable webApp {
    platform: react
    targets:  api
    ui:       WebApp
    port:     3001
}
```

The `examples/acme.ddd` `webApp` deployable is updated to this form.
Validator rejects a `react` deployable without `ui:` (HTTP analogue: the
deployable is missing its mount point).

**Generator changes** (this refactor has shipped — described in
present tense here is historical; current reality is below):

- The legacy archetype renderer (`pages-builder.ts`) is **removed**.
  Page bodies — both hand-written and scaffolded — now route through
  `src/generator/react/body-walker.ts`, which dispatches every
  walker-stdlib primitive into the active design pack.
- `view-builder.ts` and `workflow-builder.ts` still exist for
  per-aggregate plumbing the walker calls into.
- `pages-emitter.ts` is the shell emitter that wraps the walker's
  body output with `useForm` / mutation hook / `useParams` / imports.
- `page-objects-builder.ts` stays — driven by route + testid metadata.
- `theme-builder.ts` stays — theme is a system concern.

---

## 14. Open questions / non-goals (v0)

- **Per-page theming.** Today `theme { … }` is system-wide. Per-page
  overrides not in v0.
- **Internationalisation.** Strings in `title:` etc. likely want a `t("…")`
  form. Not in v0.
- **URL-synced state.** Deferred. v0 state is in-memory only.
- **Multi-step named flows.** Not in v0; block-body lambdas + custom
  components cover realistic cases. Add a `flow` keyword later only if
  forced.
- **User-extensible component library.** v0 stdlib is closed.
- **App-shell beyond menu.** Header, footer, breadcrumb stay hardcoded.
  Add `header { … }` / `footer { … }` later only if real cases force them.

---

## 15. Grammar sketch (appendix)

Productions added or extended in `src/language/ddd.langium`. Reuses
existing `TypeRef`, `Expression`, `Parameter`, `Statement`, `Property`.

```langium
// 1. Add Ui to SystemMember
SystemMember:
    Module | Deployable | BoundedContext | TestE2E | UserBlock | ThemeBlock | Ui;

// 2. Deployable gains optional ui reference
Deployable:
    'deployable' name=ID '{'
        ...
        ('ui' ':' ui=[Ui:ID] ','?)?           // new, react-only (validator)
    '}';

// 3. Ui block
Ui:
    'ui' name=ID '{'
        members+=UiMember*
    '}';

UiMember:
    UiApiParam | Page | Component | MenuBlock;

// 3a. UI api parameter — local handle on a system-level `api` contract.
UiApiParam:
    'api' name=ID ':' contract=[Api:ID];

// (An earlier draft also shipped `import helper <name> from "<path>"`
//  (UiHelperImport) — a TS-function escape hatch.  It was removed
//  (unused, untyped, and it overloaded the `import` keyword used for
//  Loom-file imports); a future typed foreign-code hatch would live in
//  the `extern` family, not under `import`.)

// 4. Page
Page:
    'page' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? '{'
        props+=PageProp*
    '}';

PageProp:
      'route'    ':' route=STRING
    | 'title'    ':' title=Expression
    | 'requires'      auth=Expression
    | StateBlock
    | 'body'     ':' body=Expression
    | PageMenuMeta;

PageMenuMeta:
    'menu' '{' (entries+=MenuMetaEntry (',' entries+=MenuMetaEntry)* ','?)? '}';

MenuMetaEntry:
    name=('section' | 'label' | 'order' | 'hidden') ':' value=Expression;

// 5. Component
Component:
    'component' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
        decls+=ComponentDecl*
        'body' ':' body=Expression
    '}';

ComponentDecl:
    StateBlock;

// 6. State block
StateBlock:
    'state' '{'
        fields+=StateField*
    '}';

StateField:
    name=ID ':' type=TypeRef ('=' init=Expression)?;

// 7. Scaffold — NOTE: no longer a grammar rule.  Earlier versions of
// the page metamodel parsed `scaffold modules: A, B` as a first-class
// UiMember.  The shipping grammar removes that production; scaffolding
// is now an AST-phase macro applied via the universal `with` clause on
// the host UI block:
//
//   ui WebApp with scaffold(subdomains: [Sales, Catalog]) { ... }
//
// The macro expands to the same set of Page nodes the old grammar rule
// produced.  See docs/scaffold-macros.md for the full surface
// (scaffold / scaffoldModule / scaffoldContext / scaffoldAggregate /
// scaffoldWorkflow / scaffoldView) and the `with` syntax in
// docs/language.md.

// 8. Menu
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

// 9. Match expression — slots into the expression precedence ladder
Expression:
    MatchExpr | TernaryExpr;

MatchExpr:
    'match' '{'
        arms+=MatchArm (','? arms+=MatchArm)* ','?
        ('else' '=>' elseExpr=Expression)?
    '}';

MatchArm:
    cond=Expression '=>' value=Expression;

// 10. Lambda gains block body — for multi-statement event handlers
Lambda:
    param=ID '=>' (body=Expression | block=BlockBody);

BlockBody:
    '{' stmts+=Statement* '}';
```

`navigate(<Page>, { params })` and `toast(<msg>)` reuse the existing
`CallExpr` rule — looked up in the page-language standard library at
lowering time, lowered to typed router calls / notifications.

---

## 16. LiveView lowering (`platform: elixir`)

A deployable that picks `platform: elixir` consumes the same
`ui { … }` source the React platform consumes — the metamodel is
framework-neutral by design.  The generator (`src/generator/elixir/`)
lowers the IR onto Phoenix LiveView semantics.  Per-construct mapping:

| Metamodel construct | LiveView lowering |
|---|---|
| `page X { route: "/path", body: … }` | `lib/<app>_web/live/<page_snake>_live.ex` — a `Phoenix.LiveView` module with `mount/3`, `handle_params/3`, `handle_event/3`, `render/1`. |
| `state { step: int = 0, draft: T = {} }` | `socket.assigns.step` / `socket.assigns.draft`; `mount/3` initialises via `assign(socket, :step, …)`. |
| `step := 1` (inside a lambda body) | `assign(socket, :step, 1)` inside the corresponding `handle_event/3` clause. |
| `match { p1 => v1, … else => fallback }` | `cond do p1 -> v1; … true -> fallback end` (expressions); `<%= cond do … end %>` in HEEx templates. |
| `requires <expr>` (page-level) | guard in `handle_params/3` that `push_navigate`s home with a `flash` on failure (v0 stub: bind only — full guard is a follow-up). |
| `navigate(<Page>, {…})` (in a lambda) | `push_navigate(socket, to: ~p"/route?…")` with the target page's route + interpolated args. |
| `CreateForm { of: T }` (and the illustrative `into: state` draft binding) | `<.simple_form for={@form} phx-submit="save">` over `to_form(changeset)` (or a draft assign for wizard steps). |
| Body of an aggregate-scaffolded page | `pack.render("page-list" | "page-new" | "page-detail", vm)` → HEEx inline in the LiveView's `render/1` — the same framework-neutral preparer VMs the React generator uses (`src/generator/react/templating/preparers/`). |
| `Sales.Customer.create.mutate(args)` (api binding) | direct context call `<App>.Sales.create_customer!(args)` — no hook hoisting, since LiveView reads in `mount/3` / `handle_event/3`. |
| Page object emission | unchanged — Playwright drives any rendered HTML, including LiveView, via the same testid-keyed page objects. |

The framework-specific seams (state read/write, `match` lowering,
api-call lowering, navigation, helper imports) live behind the
`WalkerTarget` interface in `src/generator/_walker/target.ts`.  v0
covers scaffold-driven pages end-to-end; pages with explicit `body:`
expressions emit a TODO stub pending the HEEx walker.

## 17. See also

- [`examples/sales-ui.ddd`](../examples/sales-ui.ddd) — concrete example
  exercising every construct above.
- `experience_gathered.md` slice 10 — page-object lessons the new
  metamodel must continue to honour (1:1 page ↔ route, chainable methods,
  testid-driven, no abstraction over Mantine quirks).
