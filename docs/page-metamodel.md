# Page metamodel — final v0

> Supersedes the v22 React generator's hardcoded module-to-CRUD scaffolder
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
| `ui` | Top-level block; `SystemMember`, peer to `module`, `deployable`, `theme`, `user`. |
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

---

## 3. Where `ui` lives

`ui` is declared at system scope; deployables reference it.

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
already references modules. One ui can be served by multiple react
deployables.

**Validator obligations**

- Every `react` deployable **must** declare `ui: <Name>`. No implicit
  default; the absence is a hard error.
- `deployable.ui` must reference an existing `ui` block.
- Only `react` deployables may set `ui:`.
- Every `scaffold` selector and every page-data binding inside the `ui` must
  resolve to a module reachable through the deployable's `targets` chain.

---

## 4. `page`

A page is a route + parameters + optional state + body + optional menu
metadata. Body is a single expression. Properties use Loom's existing
colon-separator idiom (matches `Deployable`, `ThemeProp`, `EmitField`).

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

  state {
    selectedId: Id<Order>?
  }

  body: MasterDetail(
    of:      Order,
    scope:   Orders.byCustomer(customerId),
    actions: [confirm, cancel]
  )

  menu { section: "Sales", label: "Order console" }
}
```

| Property | Meaning |
|---|---|
| `route:` | Path-with-`:params`. Path params bind to typed parameters. |
| `title:` | String expression, may interpolate page data. |
| `requires` | Auth predicate — same syntax as on operations. |
| `state { … }` | Reactive local fields (see §6). At most one, multiples merge. |
| `body:` | Single expression. May be a `match`, a ternary, a component invocation, anything. |
| `menu { … }` | Per-page menu metadata (`section`, `label`, `order`, `hidden`). |

---

## 5. `component`

Components are typed functions from parameters (and optional local state)
to a body expression. They never declare a route.

```ddd
component OrderPanel(order: Order) {
  body: Stack([
    Heading("Order " + order.id, level: 2),
    Badge(order.status),
    Table(order.lines, columns: [productId, quantity, unitPrice, subtotal]),
    Toolbar([
      Action(confirm, then: navigate(OrderConsole, { customerId: order.customerId })),
      Action(cancel,  then: toast("Cancelled"))
    ])
  ])
}
```

The compiler enforces parameter relationships at every call site:
`MasterDetail(of: Order, scope: …)` requires `scope` to produce `Order[]`;
`Detail(of: Order, by: x)` requires `x: Id<Order>`; `actions:` items must
be operations on the `of:` aggregate; `Form(creates: Order)` binds form
fields to `wireShape(Order.create)`.

User-defined components are pure functions over their parameters and local
state — they cannot synthesise pages, routes, or menu entries.

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
  step == 0 => Form(fields: [customerId], onSubmit: c => { … })
  step == 1 => Form(fields: [items],      onSubmit: i => { … })
  step == 2 => Review(draft,              onSubmit: () => { … })
  else      => Empty()
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

## 8. Block-body lambdas

Existing single-expression lambda extends to allow a block of statements.
Required for "mutate then navigate" event handlers.

```ddd
onSubmit: c => {
  draft.customerId := c.customerId
  step := 1
}
```

Reuses the existing `Statement` rule (covers `let`, `:=`, calls, `emit`).

---

## 9. Builtin component library — closed v0

| Component | Purpose |
|---|---|
| `List(of: T, source?)` | Table over `T[]`; row click navigates to `T`'s detail. |
| `Detail(of: T, by: Id<T>)` | Single-record view; fields, embeds `contains`, exposes operations as actions. |
| `Form(creates: T \| runs: workflow \| into: state, fields, onSubmit, then?)` | Input form bound to a typed request slice. |
| `MasterDetail(of: T, scope, actions?, detail?)` | Split-pane: list + selection state + detail panel. |
| `Dashboard(items: […])` | Composite read-only page; grid layout. |
| `Review(of: T, onSubmit)` | Read-only summary view of a typed value, with a submit action. |
| `Stack`, `Grid`, `Tabs`, `Card`, `Toolbar` | Layout primitives. |
| `Heading`, `Text`, `Badge`, `Stat`, `Empty` | Display primitives. |
| `Field`, `Toggle`, `Select`, `Fieldset` | Bindable inputs. |
| `Action(operation, then?)`, `Button(label, on?)` | Action primitives. |

The set is closed in v0. **Removed from earlier drafts:** `Wizard`, `Stage`,
`Switch`, `Case`, `When`, `Sequence` — all subsumed by `match` plus the
state/transition primitives.

Users freely define their own `component`s, which compose these builtins.

---

## 10. `scaffold` — the one macro

Single fixed pre-codegen pass. Not user-extensible. Hierarchical:

```
scaffold modules:    A, B, …    →  ∪  scaffold contexts:   <each context in each module>
scaffold contexts:   X, Y, …    →  ∪ {
                                       scaffold aggregates: <each aggregate in X>,
                                       scaffold workflows:  <each workflow in X>,
                                       scaffold views:      <each view in X>
                                     }
scaffold aggregates: Order, …   →  page <Order>List + <Order>New + <Order>Detail
scaffold workflows:  placeOrder, … → page PlaceOrderWorkflow  (+ shared WorkflowsIndex)
scaffold views:      ActiveOrders, … → page ActiveOrdersView  (+ shared ViewsIndex)
```

Multiple `scaffold` directives stack. No `except` clause — list what you
want, not what you don't.

```ddd
ui SalesAdmin {
  scaffold modules: Catalog                  // bulk
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
  section "Sales"   { link OrderList, link OrderConsole, link OrderNew }
  section "Lookup"  { link CustomerList, link ProductList }
  section "Reports" { link ActiveOrdersView, link OrderSummaryView }
  section "External" {
    link "Docs" -> "https://docs.acme.com"
  }
}
```

`scaffold` doesn't *return* anything — it contributes pages-with-menu-metadata
to a shared registry. The `menu` block is the explicit composition operator
over that registry.

Per-link auth comes free: a `link OrderList` inherits the underlying page's
`requires` clause, so menu links hide automatically.

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

  body: match {
    step == 0 => Form(into: draft, fields: [customerId],
                      onSubmit: () => step := 1)
    step == 1 => Form(into: draft, fields: [items],
                      onSubmit: () => step := 2)
    step == 2 => Review(of: draft,
                        onSubmit: () => {
                          call placeOrder(draft)
                          navigate(OrderConsole, { customerId: draft.customerId })
                        })
    else      => Empty()
  }
}
```

### Multi-page wizard (URL-encoded state, deep-linkable)

```ddd
page CustomerStep {
  route: "/orders/new/customer"
  body:  Form(fields: [customerId],
              onSubmit: c => navigate(ItemsStep, { customerId: c.customerId }))
}
page ItemsStep(customerId: Id<Customer>) {
  route: "/orders/new/items"
  body:  Form(fields: [items],
              onSubmit: i => navigate(ReviewStep,
                                       { customerId, items: i.items }))
}
page ReviewStep(customerId: Id<Customer>, items: OrderLine[]) {
  route: "/orders/new/review"
  body:  Review(of: { customerId, placedAt: now(), items },
                onSubmit: () => {
                  call placeOrder({ customerId, placedAt: now(), items })
                  navigate(OrderConsole, { customerId })
                })
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
ui WebApp { scaffold modules: Catalog, Sales, CustomerMgmt }

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

**Generator changes:**

- Current `pages-builder.ts`, `view-builder.ts`, `workflow-builder.ts`
  become scaffold expanders that produce page-IR nodes.
- A single new emitter (`pages-emitter.ts`) consumes the page IR.
- `page-objects-builder.ts` stays — already driven by route + testid
  metadata.
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
    Page | Component | Scaffold | MenuBlock;

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

// 7. Scaffold
Scaffold:
    'scaffold' selector=ScaffoldSelector ':' targets+=ID (',' targets+=ID)* ','?;

ScaffoldSelector returns string:
    'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views';

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

## 16. LiveView lowering (`platform: phoenixLiveView`)

A deployable that picks `platform: phoenixLiveView` consumes the same
`ui { … }` source the React platform consumes — the metamodel is
framework-neutral by design.  The generator (`src/generator/phoenix-live-view/`)
lowers the IR onto Phoenix LiveView semantics.  Per-construct mapping:

| Metamodel construct | LiveView lowering |
|---|---|
| `page X { route: "/path", body: … }` | `lib/<app>_web/live/<page_snake>_live.ex` — a `Phoenix.LiveView` module with `mount/3`, `handle_params/3`, `handle_event/3`, `render/1`. |
| `state { step: int = 0, draft: T = {} }` | `socket.assigns.step` / `socket.assigns.draft`; `mount/3` initialises via `assign(socket, :step, …)`. |
| `step := 1` (inside a lambda body) | `assign(socket, :step, 1)` inside the corresponding `handle_event/3` clause. |
| `match { p1 => v1, … else => fallback }` | `cond do p1 -> v1; … true -> fallback end` (expressions); `<%= cond do … end %>` in HEEx templates. |
| `requires <expr>` (page-level) | guard in `handle_params/3` that `push_navigate`s home with a `flash` on failure (v0 stub: bind only — full guard is a follow-up). |
| `navigate(<Page>, {…})` (in a lambda) | `push_navigate(socket, to: ~p"/route?…")` with the target page's route + interpolated args. |
| `Form(creates: T)` / `Form(into: state)` | `<.simple_form for={@form} phx-submit="save">` over `AshPhoenix.Form.for_create/3` (or a draft assign for wizard steps). |
| Body of an aggregate-scaffolded page | `pack.render("page-list" | "page-new" | "page-detail", vm)` → HEEx inline in the LiveView's `render/1` — the same framework-neutral preparer VMs the React generator uses (`src/generator/react/templating/preparers/`). |
| `import helper X from "path"` | Elixir `alias` / `import` directives at the LiveView module top (vs JS `import` in TSX). |
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
