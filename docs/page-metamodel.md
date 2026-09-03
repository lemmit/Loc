# Page metamodel

> The UI half of the language: `ui` blocks holding pages, components, stores,
> areas, layouts and menus, with the CRUD baseline recovered as a `scaffold`
> macro that desugars into the same metamodel.
>
> **Status (audited 2026-09-03 against `main`).**  This began as the v0 RFC and
> is now the shipped surface, so the "v0" scoping notes below are kept only
> where they still describe today's behaviour; every §14 non-goal that has since
> shipped is marked *resolved* in place.  The chaptered reference is
> [`language-reference/15-ui-pages-structure.md`](language-reference/15-ui-pages-structure.md)
> (declarations) and
> [`language-reference/16-ui-walker-primitives.md`](language-reference/16-ui-walker-primitives.md)
> (the primitive library, with generated output per primitive); this page is the
> narrative rationale behind them.

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
   finds, operations, workflows, external APIs — every name typed
   via the existing signature. No parallel type system.
3. **Declarative, expression-driven.** Each property is a fact; structural
   variation lives in the expression engine (`match`), not in dedicated
   declaration forms.

---

## 2. New keywords

The original RFC promised "six declaration keywords".  The shipped surface is
wider — these are the productions in `src/language/ddd.langium` today.

**Declaration-level:**

| Keyword | Role |
|---|---|
| `ui` | The block itself.  A `SystemMember` (peer to `subdomain`, `deployable`, `theme`, `user`, `api`, `layout`) *and* a root-level `ModelMember`, so a `.ddd` file can be a pure UI library. |
| `framework:` | Optional first clause inside `ui` — `react`, `vue`, `svelte`, `angular`, `feliz`, `flutter`, `phoenixLiveView`.  The UI's own technical identity; omitted, it is derived from the hosting deployable's platform (§3). |
| `page` | Route + params + body (§4). |
| `component` | Parameterised region tree — typed function from params (and optional state / derived / actions) to a body expression (§5).  `extern from "<path>"` hands rendering to a hand-written file. |
| `store` | Shared client-side state container: named `state {}` + `action`s, referenced by dotted name (`Cart.lines`).  Optional `persist: memory\|local\|session\|url` lifetime (§6). |
| `area` | Groups pages (and nested areas); the path is half of a page's identity (§10b). |
| `menu` | Two productions: the `ui`-level sidebar block (§11) and per-page metadata (`section`/`label`/`order`/`hidden`). |
| `state` | Block of reactive local fields, in a `page`, `component` or `store` (§6). |
| `derived` | Named computed binding over params / state / other deriveds — `derived label: string = …`. |
| `action` | Named, typed effect handler — the only place a body may write state or call a mutation (§8). |
| `api` / `channel` / `on` / `function` | `ui`-level members: a handle on a system `api`, a realtime `channel` subscription, its `on <chan>.<Event>(e) { … }` handler, and an `extern` frontend function. |
| `layout` | A **system**-level declaration (not a `ui` member) with `header` / `sidebar` / `footer` slots plus exactly one `main`; a page opts in with `layout: <Name>` (presets `default` / `none`). |

`scaffold` is **not** a keyword.  It is a macro applied through the universal
`with` clause (`ui WebApp with scaffold(aggregates: [Order]) { … }`) — see §10
and [`scaffold-macros.md`](scaffold-macros.md).  Mix it with hand-written pages
via override-by-name / unfold — see
[`customization-gradient.md`](customization-gradient.md).

**Expression-level:**

| Keyword | Role |
|---|---|
| `match` | Two shapes: predicate arms (first true arm wins) and **variant** arms over a union subject.  An expression *and* a statement (§7). |
| `else` | Fallthrough arm of `match`. |
| `await` | Marks the awaited remote command in `match await <op>(…) { … }` (§8, [`actions.md`](actions.md)).  A soft keyword — a field named `await` still parses. |

**Reused without change:** `requires` (auth gate), `let`, all existing operators, `:=` / `+=` / `-=` (state mutation, already in operations).

**Soft keywords inside their parent block:** `section`, `link` (inside `menu`), `framework` and `persist` (inside `ui` / `store`) — all still usable as ordinary identifiers elsewhere.

**Channel subscription (channels.md Part I):** two further `ui` members —
`channel <name>: <Ctx>.<Channel>` subscribes the UI to a context's
`delivery: broadcast` channel, and `on <name>.<Event>(e) { … }` runs a
handler as the event arrives.  A handler body admits two actions
(anything else is `loom.ui-handler-statement-unknown`):

- `toast(<expr>)` — show the arriving event as a message notification.
- `refetch(<Aggregate>[, …])` — invalidate that aggregate's query cache,
  the realtime twin of a mutation's `onSuccess` invalidation.  Each target
  must name an aggregate declared in the system (`loom.ui-handler-refetch-target`
  otherwise); the invalidation reuses the exact `["<snake-plural>"]` query
  key the aggregate's api hooks register, so a live event and a local
  mutation refresh the same cache entries.

The handlers compile to one renderless `RealtimeHandlers` component mounted
by the App shell, fed by the `src/api/realtime.ts` SSE client; the toast
call routes through each design pack's `realtime-toast` micro-template, and
each `refetch` emits `qc.invalidateQueries` against the frontend's query
client (react-/vue-/svelte-query alike).

```ddd
channel Orders: Fulfillment.Lifecycle
on Orders.OrderShipped(e) {
  toast("Order " + e.orderNumber + " shipped")
  refetch(Order)
}
```

generates (React `src/components/RealtimeHandlers.tsx`):

```tsx
const qc = useQueryClient();
// …
switch (event.type) {
  case "OrderShipped":
    notifications.show({ message: "Order " + String(event.orderNumber ?? "") + " shipped" });
    qc.invalidateQueries({ queryKey: ["orders"] });
    break;
}
```

---

## 3. Where `ui` lives

`ui` is declared at system scope; deployables reference it.

```ddd
system Acme {
  subdomain Sales { context Orders { ... } }

  theme { primary: "#3b82f6", neutral: "#9ca3af" }
  user  { id: string, permissions: string[] }

  ui SalesAdmin with scaffold(subdomains: [Sales]) {
    framework: react
    api Sales: SalesApi
    page OrderConsole(customerId: Customer id) { ... }
    menu { ... }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }

  deployable api    { platform: dotnet, contexts: [Orders], dataSources: [ordersState], port: 8080 }
  deployable webApp { platform: react,  targets: api, ui: SalesAdmin, port: 3001 }
}
```

A `ui` may equally be declared at the **file root**, outside any `system { … }`
— it is a `ModelMember` as well as a `SystemMember` — so a `.ddd` file can be a
pure UI library pulled in by `import`.

The deployable references the ui via `ui: SalesAdmin`, mirroring how it
already references hosted contexts.  Two binding forms parse:

- **sugar** — `ui: SalesAdmin` (the ui's `api` handles bind to the deployable's
  `targets`);
- **compose** — `ui: SalesAdmin { Sales: api, Billing: billingApi }`, binding
  each `api <name>:` handle to a named backend deployable, so one ui can be fed
  by several backends.  `hosts: [A, B]` is the inverse spelling (a host naming
  the uis it serves).

One ui can be served by **many** frontend deployables at once — the same
`ui SalesAdmin` mounts on react, vue, svelte, angular, feliz and flutter
deployables, and on `platform: elixir` it renders as Phoenix LiveView
(§16).  That is the point of the metamodel being framework-neutral.

**Validator obligations**

- Every **UI-mounting** deployable must declare `ui:` / `hosts:` — not just
  react.  The absence is a hard error (`… deployable '<n>' must declare a 'ui:'
  binding`).
- `deployable.ui` must reference an existing `ui` block.
- Only a platform that mounts a UI may set `ui:` — a `platform: node` API
  deployable may not (`loom.ui-binding-unmountable-platform`).
- The host must be able to *run* the ui's framework: a `framework: phoenixLiveView`
  ui only mounts on `platform: elixir`, and a JS-bundle framework only on a host
  that serves bundles (`loom.ui-framework-unhostable`).
- Every `scaffold` selector and every page-data binding inside the `ui` must
  resolve to a subdomain reachable through the deployable's `targets` chain.

---

## 4. `page`

A page is a route + parameters + optional state + body + optional menu
metadata. Body is a single expression. Properties use Loom's existing
colon-separator idiom (matches `Deployable`, `ThemeProp`, `EmitField`).

```ddd
page OrderDetail(id: Order id) {
  route: "/orders/:id"
  title: "Order detail"
  body: QueryView {
    of: Sales.Order.byId(id),
    single: true,
    loading: Loader {},
    empty: Empty { "Order not found" },
    data: o => Stack { KeyValueRow { "Status", o.status } }
  }
}
```

List/detail pages are normally produced wholesale by `with scaffold(aggregates:
[…])` (§10).  **There is no `scaffoldList { … }` / `scaffoldDetails { … }` body
sentinel** — earlier drafts of this doc described one, but the macro emits each
page's *full* walker body up front (so `unfold` ejects real `.ddd`), and a page
body naming `scaffoldList` is now a parse-level error:

```ddd
// ✗ error: Unknown builder type 'scaffoldList'.
page OrderList { route: "/orders"  body: scaffoldList { of: Order } }
```

To embed a list in a larger custom body, compose `QueryView` + `Table` directly
(§9.2), or scaffold the page and edit the unfolded source.

| Property | Meaning |
|---|---|
| `route:` | Path-with-`:params`. Path params bind to typed parameters. |
| `title:` | String expression, may interpolate page data. |
| `requires` | Auth predicate — same syntax as on operations. On a frontend with `auth: ui`, the page renders a client-side `<Forbidden/>` guard (evaluated against the session user) — the mirror of the backend's 403. Gates are `currentUser`-only (see [auth.md](auth.md)). |
| `state { … }` | Reactive local fields (see §6). Multiple blocks merge. |
| `derived <n>: T = <expr>` | Named computed binding over params / state (§6). |
| `action <n>(…) { … }` | Named effect handler — the only place effects may live (§8). |
| `body:` | Single expression. May be a `match`, a ternary, a component invocation, anything. |
| `layout:` | `default`, `none`, or the name of a system-level `layout <Name> { … }`. |
| `menu { … }` | Per-page menu metadata (`section`, `label`, `order`, `hidden` — validated key set). |
| `description:` / `ogImage:` / `canonical:` | Static SEO / social-graph metadata (string literals), projected into the generated `index.html` shell. |

---

## 5. `component`

Components are typed functions from parameters (and optional local state)
to a body expression. They never declare a route.

```ddd
component OrderPanel(order: Order) {
  body: Stack {
    Heading { `Order {order.id}`, level: 2 },
    EnumBadge { order.status },
    Money { order.total, decimals: 2 },
    Table { rows: order.lines,
      Column { "Product", l => l.productName },
      Column { "Qty",     l => l.quantity } },
    Toolbar {
      Action { order.confirm, then: navigate(Home) },
      Action { order.cancel,  then: toast("Cancelled") }
    }
  }
}
```

Two things that example pins down and earlier drafts got wrong:

- **A user-visible slot may not be built by `+` concatenation.**
  `Heading { "Order " + order.id }` is rejected (`loom.user-visible-concat`) —
  word order, plural rules and formatting don't survive translation.  Use a
  backtick template (`` `Order {order.id}` ``), which the extractor turns into
  one ICU catalog message.
- **Every named argument is read by name, so an invented one is an error.**
  `Table { …, columns: [ … ] }` raises `loom.page-primitive-unknown-arg`
  (`Table` has no `columns:` argument) — columns are `Column { … }` children.

The compiler enforces parameter relationships at every call site: `CreateForm
{ of: Order }` binds form fields to `wireShape(Order.create)`; `OperationForm
{ of: <record>.<op> }` resolves the operation and its payload.

User-defined components are pure functions over their parameters and local
state — they cannot synthesise pages, routes, or menu entries.

### 5.1 Where components may live

Components declare in two scopes; both forms parse identically and share the
same emission path (one component per ui that references them: react
`src/components/<Name>.tsx`, vue `.vue`, svelte `src/lib/components/<Name>.svelte`,
**angular** a standalone class at `src/app/components/<Name>.ts`, flutter a widget
in `lib/components.dart`, and **feliz** — which has no per-component file — an F#
props function in App.fs's nested `Components` module).  Per-target deferrals are
listed in [`generators.md`](generators.md).

A component body admits the same declarations a page does *except* routing
metadata: `state { … }`, `derived …`, `action …`, then one `body:` expression.
`component X(…) extern from "./X.tsx"` declares only the typed param contract —
Loom emits a re-export shim plus a typed `<Name>.props.ts` and the user owns the
module (`loom.extern-component-has-body` if such a declaration also carries a
body; `loom.component-missing-body` if a non-extern one doesn't).

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

The `Slot { }` **primitive** is the unnamed sibling of a `slot` param: it
renders the extra positional arguments a caller passed (`PageBox { "Welcome",
Text { "hi" } }`), and the component shell declares the matching children
parameter for it. It therefore only means something in a `component` body — a
page has no caller, so a page-level `Slot { }` emits an unbound children
reference (a compile error on React and Feliz, silently empty on Vue / Svelte /
Angular / Flutter). The validator rejects that placement with
`loom.slot-outside-component`.

**Sub-element placement is the same kind of contract.** `Tab` and `Column` have
no renderer of their own — their parent consumes them inline, so `Tab` is only
meaningful as a direct child of `Tabs`, and `Column` only as a direct child of
`Table` or `DataGrid`. Anywhere else the primitive reaches the walker's own
dispatch, finds no renderer, and degrades to a comment on every frontend
(`{/* Tab: not supported by the walker yet */}` on the JSX family,
`<%!-- Tab: … --%>` on Phoenix LiveView) — the element and everything nested
inside it silently vanish from the page, with nothing failing to compile. The
validator rejects the misplacement with `loom.sub-primitive-misplaced`.

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
Writes use `:=` (already a Loom statement form), and only inside an `action`
(§8).

A sibling `derived <name>: <T> = <expr>` declares a computed binding over
params / state / other deriveds — it is read-only, so it needs no action.

### `store` — shared state across pages, and its lifetime

A `store` is a `ui`-level member holding the same `state { }` + `action`s a page
does, referenced from any page or component by **dotted name** — there is no
`use` clause and no per-page binding; the dependency is derived from the refs.

```ddd
store Cart persist: local {
  state { lines: string[] = [ ]  step: int = 0 }
  action add(id: string) { lines += id }
  action clear() { lines := [ ] }
}

page Home {
  route: "/"
  body: Stack { Text { Cart.step }, Button { "Clear cart", onClick: Cart.clear } }
}
```

generates (React, `src/stores/cart.ts` — zustand + the `persist` middleware):

```ts
export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      step: 0,
      add: (id) => set((s) => ({ lines: [...s.lines, id] })),
      clear: () => set(() => ({ lines: [] })),
    }),
    { name: "loom.store.Cart", storage: createJSONStorage(() => localStorage) },
  ),
);
```

**`persist:` is the lifetime ladder** — `memory` (default), `local`, `session`,
`url`.  It answers the v0 "URL synchronisation deferred" note: URL-synced state
ships, as `persist: url`.  The value is parsed as an identifier, not a keyword,
so `url` / `local` / `session` stay usable as ordinary field names.

Its gates, all in the catalog:

| Rule | Diagnostic |
|---|---|
| The lifetime must be one of the four | `loom.store-lifetime-invalid` |
| `persist: url` fields must be scalar (string/number/bool/enum/id) — structural state needs `persist: local` | `loom.store-url-field-invalid` |
| A page/component action may not write store state inline (`Cart.step := 1`) — mutate through a store action | `loom.store-state-inline-write` |
| A store action may not run a view effect (`navigate` / `toast`) — a store has no router | `loom.store-action-view-effect` |
| Store actions must compose acyclically | `loom.store-action-cycle` |
| On `phoenixLiveView` a store is a server-side per-process struct: no browser storage, no URL ownership | `loom.store-lifetime-liveview-invalid`, `loom.store-cross-store-on-liveview-invalid` |
| Feliz / Flutter persist through a typed codec, so a field of an uncovered type can't cross | `loom.store-lifetime-target-unsupported` |

Stores emit on all six `walkBody` frontends (react/vue/svelte/angular/feliz/flutter).

---

## 7. `match` expression

Predicate-arms expression — first true arm wins, optional `else`. Lives in
the expression engine and is usable anywhere an expression appears.

```ddd
body: match {
  step == 0 => Stack { Field { "Customer", bind: customerName },
                       Button { "Continue", onClick: toReview } }
  step == 1 => Stack { KeyValueRow { "Customer", customerName },
                       Button { "Place order", onClick: submit } }
  else      => Empty { "Unknown step" }
}
```

> **Known emitter gap (2026-09-03).**  A page whose `body:` is a *top-level*
> `match { … }` is silently **dropped** by the React and Svelte page emitters —
> no file, no route, no diagnostic — because `isWalkableLayoutBody`
> (`src/generator/_walker/walker-core.ts`) admits only a `call` or `ternary`
> body, even though the walker itself renders `match` fine.  Vue, Angular and
> the other targets emit the page.  Until that is fixed, wrap the `match` in a
> layout container (`body: Stack { match { … } }`) or use a ternary.

Reusable across the language, not just in page bodies:

```ddd
derived display: string = match {
  status == Draft     => "Pending"
  status == Confirmed => "Awaiting shipment"
  status == Shipped   => "In transit"
  else                => "Closed"
}
```

### Variant `match` — over a union subject

The second shape discriminates a union (an operation's `T or E` result, a
`payload` union, a `T option`) by **variant arms**:

```ddd
match outcome {
  Order o    => Text { o.status }
  Rejected r => Alert { r.reason }
  else       => Empty { "unknown" }
}
```

- The subject must be a simple ref or let-bound name, not a call
  (`loom.match-subject-not-simple`) — the one exception being the `await`-marked
  call of `match await` (§8).
- Arms name variants of the subject's union (`loom.match-unknown-variant`,
  `loom.match-duplicate-variant`, `loom.match-non-union-subject`); a variant
  match that covers neither every variant nor an `else` is
  `loom.match-non-exhaustive`.

`match` is also a **statement** (`MatchStmt`, with statement-block arms), which
is what an `action` body uses (§8).

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
  body: Stack { match {
    step == 0 => Field { "Customer", bind: customerName }
    else      => Empty { "done" }
  } }
}
```

An `action` body reuses the `Statement` rule (`let`, `:=`, calls, `emit`); the
block-body lambda still exists in the render tree, but only for **pure** value
composition (§8.1). The split is **read vs write** — a render-tree lambda may
read `state`/`store`/props and compute freely, but only an `action` may write —
tabulated allowed/rejected in
[`docs/actions.md` → "What belongs in a lambda vs an action"](actions.md).

### `match await` and the effect marker

A **remote, mutating** command called bare in an action body has an invisible
async boundary, so the validator asks for the effect marker —
`loom.missing-effect-marker` — pointing at the `match await` form that handles
the returned union:

```ddd
page OrderDetail(id: Order id) {
  route: "/orders/:id"
  state { message: string = "" }
  action confirmOrder() {
    match await Sales.Order.confirm() {
      Order o    => { message := o.status }
      Rejected r => { message := r.reason }
    }
  }
  body: Stack { Button { "Confirm", onClick: confirmOrder } }
}
```

Reads (`byId`, finders), sibling-action calls, and the view effects `navigate` /
`toast` are not flagged — and there is **no** "spurious marker" diagnostic in
the catalog, so an `await` you didn't strictly need is never an error.  An
instance-op `match await` needs the page's route `:id` record
(`loom.instance-effect-needs-route-id`); the arg list must match the operation
signature (`loom.match-await-arg-mismatch` / `loom.match-await-arg-type`).
Full treatment, with the generated client- and LiveView-side output, in
[`actions.md`](actions.md).

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
backend `find` `where`-clause:

```ddd
body: Stack {
  For { each: orders.filter(o => o.status == Confirmed), o => OrderCard(o) }
}
```

`filter` / `map` (native JS array methods) render verbatim through the body
walker — the callback's parameter binds in scope exactly like a `For` item
or a `Table` column accessor. Chains compose (`orders.filter(…).map(…)`).

Three boundaries to know:

- **Single-param callbacks only** — the grammar's `Lambda` is `param=ID =>
  …`, so a two-arg comparator (`sort((a, b) => …)`) isn't expressible.
- **`filter` / `map` are the whole inline vocabulary.** The rest of the
  stdlib **collection ops** (`docs/stdlib.md` — `count`, `sum`, `where`,
  `any`, `all`, `first`, `sortBy`, `distinct`, `take`, `skip`, `join`,
  `min`, `max`, `avg`, …) are a **backend** vocabulary: every backend
  renders them through `src/generator/_expr/target.ts`, the frontend walker
  has no arm for them and would emit them verbatim. Using one in a page /
  component expression is an **error**,
  `loom.frontend-collection-op-unsupported`:

  ```ddd
  // ✗ loom.frontend-collection-op-unsupported
  body: QueryView { of: Orders.Order.all, data: rows => Stat("n", rows.count) }
  ```

  Compute the value where the data lives — a repository `find`, an
  aggregate `derived`, or a `projection` read model — and bind the result
  in the page. (The gate is target-agnostic: it fires on Phoenix too, where
  the parallel HEEx engine happens to map `count`, so that a `.ddd` renders
  on every frontend or fails on every frontend rather than silently
  breaking on a `framework:` change.)
- **Frontend coverage.** React, Vue, Svelte, and Angular share the
  `emitExpr` engine and get `filter`/`map` from native `Array.prototype`;
  Phoenix/HEEx runs a parallel engine that mirrors them to Elixir idioms
  (`Enum.filter/2` / `Enum.map/2`). Feliz supplies its own F# leaves
  (`src/generator/feliz/fs-expr.ts`) for the **action/update** path only —
  in a page **body** its method-call rendering still goes through the shared
  walker arm, so inline `filter`/`map` shaping there emits JS-shaped F#;
  prefer pre-shaping in a backend `find` when targeting Feliz or Flutter.

### 8.1a Scalar intrinsics in a page body

Unlike the collection ops, the **scalar intrinsics** ([`stdlib.md`](stdlib.md)
Layer 0 — `toUpper`, `trim`, `substring`, `replace`, `abs`, `round`, …) *do*
belong in a page body: they act on page-local `state` that may never reach the
server, so "compute it server-side" is not an available answer.

On the four JS frontends they render through the **same snippet table the
TypeScript backend uses** (`src/generator/_expr/js-intrinsics.ts`), so an
intrinsic means the same thing wherever you write it:

```ddd
state { code: string = "" }
body: Text(code.toUpper())
```

```tsx
<Text>{code.toUpperCase()}</Text>
```

That sharing is the point. Loom's spelling is its own, and two intrinsics have
contracts JavaScript spells identically but defines differently — `replace`
replaces **every** occurrence (JS `.replace` replaces the first) and
`substring(start, len)` takes a **length** (JS `.substring` takes an end
index). Before the table was shared, a page body emitted the raw JS spelling
and those two were **silently wrong**: the same expression computed one thing
in an aggregate `derived` and another in the page.

Two earlier limits are now closed, and one rule is worth knowing:

- **`money.min` / `money.max` / `money.round` render.**  The page shells detect
  a `Decimal`-binding intrinsic (`usesDecimalBinding`, `_expr/js-intrinsics.ts`)
  and pull `decimal.js` into scope, so `Money { amount.min(money("2.00")) }`
  emits `<MoneyValue value={ Decimal.min(amount, new Decimal("2.00")) } />`.
- **Feliz and Flutter have their own intrinsic tables** on the walker path —
  `renderIntrinsic` is a `WalkerTarget` seam, fed by `feliz/fs-expr.ts`
  (`"string.toUpper": recv => (recv.ToUpper())`) and `flutter/dart-expr.ts`.  A
  page-body intrinsic no longer emits verbatim there.
- **A nullable receiver is rejected** (#2711, `loom.intrinsic-nullable-receiver`):
  every backend emits a bare dereference, so `nick.toUpper()` on a `string?` is
  an error — guard it with a null-narrowing ternary
  (`nick != null ? nick.toUpper() : ""`), which the checker treats as narrowing.
  Arity and argument types are checked too (`loom.intrinsic-arity`,
  `loom.intrinsic-arg-type`, `loom.intrinsic-unknown`).

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

## 9. Builtin component library — closed

The set is **closed**: 56 top-level primitives (`WALKER_LAYOUT_PRIMITIVES`) plus
two sub-elements (`Tab`, `Column`), all declared in
`src/util/walker-primitive-names.ts` and dispatched from
`src/generator/_walker/registry.ts`.  Users compose them into their own
`component`s; they cannot add primitives.  The per-primitive reference, with
generated output for each, is
[`language-reference/16-ui-walker-primitives.md`](language-reference/16-ui-walker-primitives.md);
the table below is the map.

| Component | Purpose |
|---|---|
| `CreateForm { of: T }`, `OperationForm { of: <record>.<op> }`, `WorkflowForm { runs: <wf> }`, `DestroyForm { of: T }` | The four named-leaf forms (the old polymorphic `Form { creates: \| runs: \| into: }` split into these). `DestroyForm`'s `of:` names the **aggregate**, not a loaded record — the emitter resolves it through the aggregate map, and anything else degrades to a comment on every target with no diagnostic (an honest gap to know about). |
| `Stack`, `Group`, `Grid`, `Tabs` (+ `Tab`), `Card`, `Toolbar`, `Container`, `Paper`, `Breadcrumbs`, `Divider`, `Section`, `Sticky` | Layout primitives. `Section` is a semantic anchor target; `Sticky` a sticky-position wrapper; `Tab` is the sub-element of `Tabs` — `Tab { <label>, …children }`, a children container like `Card`: every positional after the label renders in the panel. |
| `Heading`, `Text`, `Bold`, `Italic`, `InlineCode`, `Badge`, `Stat`, `Empty`, `Anchor`, `Image`, `Avatar`, `Loader`, `Skeleton`, `Alert`, `KeyValueRow`, `Icon` | Display primitives. `Bold`/`Italic`/`InlineCode` are inline-emphasis spans; `Icon` is a builtin-name or `svg:` literal, decorative-by-default (`aria-hidden`) unless `label:` gives it meaning — which makes it a named `role="img"` and makes that name a user-visible slot, translated through the message catalog. |
| `Field`, `NumberField`, `PasswordField`, `MultilineField`, `Toggle`, `SelectField { label, bind, options }`, `FileUpload` | Bindable inputs, each `bind:`-bound to a `state` field. `MultilineField` is the textarea twin of `Field`; `SelectField` is a controlled single-select over a string-array `options:` expression; `FileUpload` binds a `File` state field (`loom.file-upload-not-file-field`). All accept an optional `error:` expression rendered in the pack's inline error slot (§8.2). |
| `Chart { of:, kind:, x:, y: }` | Line / bar series over a **grouped** query-time `projection` — `kind:` is `"line"` or `"bar"` (`loom.chart-kind-invalid`), `of:` must be a grouped projection (`loom.chart-of-not-grouped`), and the accessors must be simple row fields (`loom.chart-accessor-not-field`). Ships on every frontend, LiveView included (inline SVG there — no JS charting library). |
| `Timeline { of: <entries> }` | An `audited` aggregate's history (the `AuditEntry[]` served at `GET /<agg>/{id}/history`) as an ordered action / time / actor / field-change list. |
| `Action(operation, then?)`, `Button { label, on? }` | Action primitives. |
| `Modal { trigger, … }` | Disclosure surface — hosts an `OperationForm` (scaffold detail pages) or a state-controlled `open:` body. The state-controlled form ships on **all six frontends**. Flutter's dialogs are imperative (`showDialog` pushes a route), so there is no widget to conditionally render: it bridges through a generated `LoomModalHost` that drives `showDialog` on the flag's rising edge and reports dismissal back, keeping the page's state the single source of truth. `title:` is a user-visible slot on both shapes — it is the dialog's title, translated through the message catalog. The two shapes do not COMBINE on every target: `Modal { open: <stateBool>, OperationForm { … } }` renders on Angular, Feliz and HEEx (which drive the dialog from their own trigger) and collapses the whole modal to a comment on React/Vue/Svelte/Flutter, so it is a compile error there (`loom.modal-controlled-op-form-unsupported`) — use the trigger shape, which drives the dialog itself. |
| `Money(value, currency?, decimals?)`, `DateDisplay`, `EnumBadge`, `IdLink`, `FileLink` | Formatter primitives. `Money` renders the wire value **verbatim** by default — its own digits, locale-neutral, with no `Number()` coercion, no grouping separators, no currency symbol and no re-scaling, so a `NUMERIC(19,4)` value's 4th decimal is visible (Loom `money` has no currency dimension, so nothing may be invented for it). `decimals: n` re-scales the digit string to exactly *n* fraction digits, half away from zero — the backends' own rounding family, never through a float. `currency: "EUR"` prefixes **the code you passed**, verbatim (`EUR 12.3456`). The contract is one shared implementation across all 15 design packs (`src/generator/_frontend/money-format.ts`; [design-packs.md](design-packs.md) § the money-display contract). Feliz already rendered the raw string and prefixes only a declared currency, so it matches by construction — it ignores `decimals:`; Flutter still formats through `NumberFormat.decimalPattern()` (M-T1.21). |
| `ProvenanceInfo(of:, field:)` | A "?" disclosure over a `provenanced` field's lineage (a native `<details>`/`<summary>`; [provenance.md](provenance.md)). Reads the co-located `<field>_provenance` lineage; scaffolded onto a provenanced field's detail row. Renders on **five of the six frontends** (all but Flutter) plus the Phoenix/HEEx server render — React/Vue/Svelte/Angular/Feliz off the JSON wire sibling; HEEx reads the string-keyed jsonb struct field server-side (`<%= if … %>`/`<%= for … %>`). |
| `CodeBlock` | Syntax-highlighted code block (highlight.js at runtime). `title:` is a user-visible slot — a caption above the sample, translated through the message catalog. The code SOURCE deliberately is not: translating code breaks it, so an untitled block leaves a page string-less. |
| `Table`, `Column` | Tabular display (data lambda accessors). `Column` is the sub-element of `Table`/`DataGrid`. `filter: <state>` binds a client-side search box above the table; it renders on the six `walkBody` frontends and on a CLIENT-paged table only. On HEEx there is no filter seam (`loom.table-filter-unsupported`), and a server-paged table's rows are one server window, so a client filter there would narrow that page rather than the result set (`loom.table-filter-server-paged`) — note the auto-paged rewrite turns the simplest hand-written `Table { rows: rows, filter: q }` over a paged `.all` into the server-paged shape. |
| `DataGrid` | **React, Vue, Svelte, Angular, Feliz.** Interactive grid over the same `Column` children — multi-column sort, per-column filters, column-visibility toggles, client pagination, optional row selection. Backed by [TanStack Table](https://tanstack.com/table); see §9.1 below. Using it on HEEx or Flutter is a compile error (`loom.datagrid-unsupported-target`) — use `Table`, which sorts and pages on every frontend (its client `filter:` is the six `walkBody` frontends, client-paged only — see the `Table` row). |
| `For { each: T[], empty?: markup, item => markup }` | List comprehension — emits the item lambda's markup once per element. TSX lowers to a keyed `.map` + `<Fragment>`, Vue to `<template v-for :key>`, Svelte to a keyed `{#each}`, Angular to an `@for (… ; track …)` block, Phoenix LiveView to a `for … do … end` block. A child primitive (nest inside a layout container — it isn't a standalone page body); the list key is the loop index. The optional `empty:` arm is rendered when the collection is empty — Svelte's native `{:else}`, a TSX `length === 0 ? … : .map(…)` ternary, a Vue `v-if` sibling `<template>`, Angular's `@for`/`@empty` block, a HEEx `Enum.empty?/1` guard. |
| `QueryView { of:, loading:, error:, empty:, data:, single?:, paged?: }` | 4-arm query-state branching (collection or single-record). The `data:` binding also exposes the paged envelope's page metadata — see §9.2. |

**Removed from earlier drafts:** `Wizard`, `Stage`, `Switch`, `Case`, `When`,
`Sequence` — all subsumed by `match` plus the state/transition primitives.  The
polymorphic `Form { creates: | runs: | into: | <instance>.<op> }` dispatcher is
also gone: it split into the four named-leaf forms above.  The `Form { … }`
snippets that remain in the §12 wizard sketches predate that split — read them
as the corresponding named-leaf form (the `into:` / `fields:` draft-binding
shapes are illustrative only; multi-step draft forms are a §14 non-goal, not a
shipped primitive).

**Containers vs fixed slots.** A layout primitive (`Stack`, `Group`, `Card`,
`Tab`, `Section`, `Toolbar`, `Container`, …) renders *every* positional as a
child. Most display primitives are not containers but fixed SLOT shapes, and
every design pack renders exactly their declared positions: `Stat { <label>,
<value> }`, `KeyValueRow { <label>, <value> }`, `Text { <text> }`,
`EnumBadge { <value> }`, `Image { <src> }`, `Icon { }` (named args only), and the
op-form `Modal { trigger: …, OperationForm { … } }` (which renders the trigger
button plus the operation's generated field set, and nothing else). Each
primitive's slot count is declared once, in `WALKER_PRIMITIVE_SLOTS`
(`src/util/walker-primitive-names.ts`), where every primitive is classified as
capped or as a children container — so a new one cannot land outside the rule.
An extra positional past the cap is rendered by nobody, so it is a validation error
(`loom.page-primitive-extra-children`) rather than content that silently
disappears — wrap the extra markup in a `Stack { … }` and pass that as the slot,
or use the state-controlled `Modal { …children, open: <stateBool> }`, which *is*
a children container.


A bare name in a rendered slot must resolve to a route parameter, a `state`
field, a `derived` binding, an enclosing lambda's parameter, or a store field.
An unresolved one (`Text { nosuchthing }`) has nothing to read and used to emit
a comment in its place — the content vanished from every frontend — so it is now
rejected as `loom.unresolved-page-ref`, the ref-spelling twin of
`loom.unknown-page-element`.

`List` / `Detail` / `MasterDetail` were also retired: they were legacy
archetype names that never had walker renderers (they silently degraded to a
`// not supported` comment), so they're gone as standalone primitives — see
[decisions.md → D-NO-PAGE-ARCHETYPES](decisions.md#d-no-page-archetypes).  The
list / detail use case is served by the `scaffold` macro (§10), or by composing
`QueryView` + `Table` directly.  The **`scaffoldList { of: T }` /
`scaffoldDetails { of: T }` body sentinels earlier drafts of this doc described
never shipped either** — a page body naming one is a parse error (§4).

Six further names from earlier drafts of this table are not primitives:
`Dashboard` and `Review` (composite read-only pages — express them as a
`Stack`/`Grid` of the display primitives; the `Review(…)` calls in the §12
wizard sketches are illustrative, like the draft-form shapes above), `Select`
(use `SelectField`), `Fieldset` (an internal value-object render shape, not a
hand-writable input), and `Switch` (control flow is `match`; the boolean input
is `Toggle`).  A body naming any of them raises `loom.unknown-page-element`.
The closed set is exactly the rows above.

Users freely define their own `component`s, which compose these builtins.

### 9.1 `DataGrid` — the interactive grid

`Table` is deliberately simple and portable: it renders markup around a rows
expression the walker has already sorted/sliced, so all six frontends (plus the
parallel HEEx engine) implement it. It covers single-column sort, one substring
filter, and prev/next paging — and for the scaffold's server-paged list the
server does the work anyway.

`DataGrid` is the case where hand-rolling stops paying: **multi-column sort,
per-column filters, and column visibility** are row-model concerns, which is
exactly what [TanStack Table](https://tanstack.com/table) is. So the primitive
delegates to it rather than growing `Table` a fourth and fifth interactive mode.

```ddd
page CustomerList {
  route: "/customers"
  state { picked: string[] }
  body: Stack(
    Button { label: "Delete selected ({picked.length})", on: bulkDelete },
    QueryView { of: Sales.Customer.all, data: rows => DataGrid(
      Column("Name",  o => o.name,  sortable: true, filterable: true),
      Column("Tier",  o => o.tier,  sortable: true),
      rows: rows,
      selection: picked,
      multiSort: true,
      columnVisibility: true,
      pageSize: 25,
      testid: "customers-grid") }
  )
}
```

| Arg | Meaning |
|---|---|
| `rows:` | The collection to render (usually a `QueryView` `data:` lambda param). |
| `Column(header, accessor, sortable?, filterable?)` | Same children as `Table`. A column whose accessor isn't a simple member has no value to sort or filter *by*, so both flags are forced off rather than emitted and silently ignored. |
| `multiSort:` | Shift-click accumulates sort columns instead of replacing. |
| `columnVisibility:` | Renders a per-column show/hide toggle row. |
| `pageSize:` | Client page size (default 25). |
| `selection:` | Names a `string[]` field in the page's `state { }`; the grid adds a leading checkbox column and keeps that field in sync with the selected rows' ids. |
| `testid:` | Test id on the grid root; also names the emitted component (`customers-grid` → `CustomersGrid`). |

**It emits a child component, not inline markup.** `useReactTable` is a hook,
and a `DataGrid` almost always sits in a `QueryView`'s `data:` slot, which the
walker emits as a *conditional expression* — a hook cannot run there. Hoisting
the hook to the page component doesn't work either (it needs `rows`, which only
exists inside the lambda), and a component declared *inside* the page would get
a fresh identity every render, remounting the grid and losing its sort state.
So the walker hoists a generic child to **module scope** and renders
`<CustomersGrid rows={…} />` at the call site — the same shape shadcn's own
DataTable recipe uses.

Only `selection:` crosses back out of that child. Sort, filter, and visibility
are opaque view-state nothing outside the grid reads; a selected-id list is the
one thing a sibling ("Delete selected (3)") has a real need for, so it lives in
`state { }` like any other page state. It must be declared `string[]` —
`loom.datagrid-selection-not-array` rejects any other type, and
`loom.datagrid-selection-not-state` rejects a ref that isn't a declared state
field (which the walker would otherwise silently drop).

The grid's **chrome** comes from the active design pack
(`primitive-data-grid.hbs` — all 15 JS design packs ship one); the TanStack wiring above it is framework-level. The checkbox column
is walker-emitted as a plain `<input type="checkbox">` rather than a pack
component: it is the one cell whose *behaviour* is load-bearing, so keeping it
out of the packs means selection needs no template change anywhere.

**Where the child lands differs by framework, and that is the whole reason the
grid is a walker seam rather than a pack template.** React declares the child at
module scope in the page's own file. A Vue SFC cannot — `<script setup>` compiles
to exactly one component per file — so the Vue target emits a whole
`src/components/<Name>.vue` and the page imports it like any other component.
Svelte does the same at `src/lib/components/<Name>.svelte`, and Angular at
`src/app/components/<kebab>.component.ts` (a standalone component needs both an
import line and an `imports: []` entry on the page). Cells diverge for the same
reason: React's column defs carry `cell: ({ row }) => <JSX/>`, while the other
three would have to return framework-specific render output, so a computed
column renders in the markup selected by column id.

**Feliz hosts the real row model too, through Fable interop.** It has no
per-component *file*, so the child is a `[<ReactComponent>]` declaration spliced
into `App.fs` ahead of the page views (F# is order-sensitive). Because the
walker resolves no DTO type name and F# has no structural typing to stand in for
that generic, the **call site** projects each row into a plain JS object — one
key per `accessorKey` column, plus a lazy `unit -> ReactElement` thunk per
computed column, closing over the typed row. `selection:` cannot be a direct
write on Feliz (Elmish state lives in `update`), so the grid dispatches a
`SetSelectedIds` Msg like any other bound input.

The two remaining targets are honest gaps, not silent ones, and for different
reasons. `loom.datagrid-unsupported-target` rejects a `DataGrid` on **HEEx**
(LiveView has no client row model; `Table` is server-driven there instead) and
on **Flutter** — permanently. `DataGrid` is a TanStack row model, so a target
can host it only if it can host TanStack; there is no Dart adapter or port, and
while Flutter *web* has `dart:js_interop`, the shipping target is a native build
with no JS runtime. Flutter's own `DataTable`/`PaginatedDataTable` are the trap
that decision exists to avoid: they give you *a* grid, not *the same* grid.

**Svelte and Feliz drive `@tanstack/table-core` directly rather than an adapter.**
The official `@tanstack/svelte-table` peers on Svelte 3/4 — it predates runes —
and Svelte 5 support exists only in a `9.0.0-beta` whose API differs enough to
make the Svelte grid behave differently from the others. `table-core` is the
framework-agnostic package every adapter wraps, on the same v8 API, with no
framework peer; runes supply the reactivity the adapter would have. Feliz uses
the same package for the simpler reason that no F# adapter exists at all.

Two consequences are visible in the emitted code for both. *Every* state slice
is controlled, including `pagination`, because the table is rebuilt on each
render and an uncontrolled `pageIndex` would reset to 0 on every sort click. And
because `table-core`'s `getState()` returns the raw `state` option — it does not
merge its own defaults the way the framework adapters do — both targets spread
`table.initialState` in first. Without that, `getHeaderGroups()` throws and the
grid renders nothing, with the compiler and the bundler both reporting success.

---

### 9.2 `QueryView` over a paged read — the envelope's page metadata

The auto-`findAll` is **paged by default** (M-T2.6), so `X.all` returns the
`paged<T>` envelope rather than a bare array:

```
paged(T) → { items: T[]; page: int; pageSize: int; total: int; totalPages: int }
```

`QueryView` binds its `data:` lambda so both halves of that envelope are
reachable from one binding — the rows to iterate, and the page metadata to
label:

```ddd
QueryView {
  of: Sales.Order.all,
  data: rows => Stack {
    Text { rows.total },                     // 1 284 — across ALL pages
    Table { rows: rows, Column { "ID", o => o.id } }   // this page's rows
  }
}
```

```tsx
const orderAll = useAllOrders();
…
<Text>{orderAll.data.total}</Text>
<Table>{ orderAll.data.items.map((row) => ( … )) }</Table>
```

Note the two different levels of the same envelope. Which one `rows` itself
binds to depends on the mode:

| Mode | `rows` is | Written by |
|---|---|---|
| **auto-paged** — no `paged:` flag, but the query returns `paged<T>` | the row **array** (`.data.items`) | hand-written pages: the body was written for a collection, so `Table { rows: rows }` keeps iterating records |
| **explicit** `paged: true` | the **envelope** (`.data`) | the scaffold's server-paged list, whose `Table` reads `rows.items` and whose pager reads `rows.totalPages` |

In **both** modes a page-metadata read (`rows.total`, `rows.pageSize`,
`rows.totalPages`) resolves against the envelope. Under auto-paging the binding
was unwrapped one level, and the metadata read is re-rooted past that unwrap —
`rows` stays the array and `rows.total` is still the true all-pages count.
`rows.items` is deliberately **not** re-rooted: on an unwrapped binding `rows`
already *is* the array.

**Every frontend resolves it**, but not all of them by holding the envelope.
The four JSX frontends and HEEx keep the whole object, so a metadata read is a
plain member access. The two that decode the wire into typed values carry the
metadata deliberately, through the `renderPagedEnvelopeMember` seam:

| Frontend | How the metadata survives the decode |
|---|---|
| react / vue / svelte / angular / HEEx | the binding holds the envelope; nothing to do |
| **feliz** | the Elmish decoder splits it — rows into the read's `Remote<'T list>` field, metadata into a sibling `PageMeta` record — so `rows.total` resolves to `model.<Read>PageMeta.Total`. The list field stays a plain `'T list` because `View.idOptions` (FK selects) and the realtime refetch both read it |
| **flutter** | the Riverpod provider yields `Paged<T>` rather than a bare `List<T>`, so `rows.total` is a field of the loaded value |

### A bare `Table` over a paged read pages itself

The simplest list page you can write is complete:

```ddd
page TaskList {
  route: "/tasks"
  body: QueryView { of: Api.Task.all, data: rows => Table { rows: rows,
    Column { "Title", o => Text { o.title } } } }
}
```

`.all` is paged, so this used to render the backend's default first page — 20
rows, no pager, rows 21+ unreachable and nothing on screen saying so. A macro
now rewrites it into the shape the **scaffold** already emits, so "a working
paged table" has one definition rather than two:

```ddd
state { pageNum: int = 1  sortKey: string = ""  sortDir: string = "asc" }
QueryView { of: Api.Task.all(pageNum, 20, sortKey, sortDir), paged: true,
  data: rows => Table { rows: rows.items, page: pageNum, sortKey: sortKey,
    sortDir: sortDir, serverPaged: true, totalPages: rows.totalPages,
    Column { "Title", o => Text { o.title }, sortable: true, field: "title" } } }
```

It runs at the **macro layer**, so `unfold` ejects that as real `.ddd` source
you can edit — the rewrite is a starting point, not a black box.

**Taking control is the opt-out.** Any of these is left exactly as written:

| You wrote | Why it's left alone |
|---|---|
| `paged: true` on the `QueryView` | you're binding the envelope and driving it yourself |
| arguments on the read (`X.all(p, n, k, d)`) | you're threading your own controls |
| `page:` or `serverPaged:` on the `Table` | you own the pager |
| a table over a plain array find | nothing to page — one response is the whole set |

A column is made sortable only when its accessor is a **simple member read**
(`o => o.name`, `o => Text { o.name }`). A computed column has no aggregate
field behind it, and the backend's `sort` parameter is whitelisted per field —
so leaving it unsortable is the correct answer, not a degradation.

### The flags are opt-ins; the shape is derived

`paged:` and `single:` look like they *declare* what a read returns. They do
not — both are properties of the find, resolved once in
`_walker/paged-query.ts` (`queryShape`) and consumed by the JSX walker, the
HEEx renderer, and the Feliz and Flutter read collectors alike:

| Fact | Derived from | What the flag adds |
|---|---|---|
| **paged** | the find returns `paged<T>` | `paged: true` also binds the ENVELOPE instead of unwrapping to the rows — a binding-shape choice the fact can't make for you (the scaffold's list reads `rows.items` itself) |
| **single** | the read is `byId`, or the find returns `T` / `T?` | nothing the fact doesn't already say; kept as an override |

Writing neither flag is the normal case and now works: a hand-written
`QueryView { of: X.all, data: rows => Table { rows: rows } }` iterates records,
reports the true `rows.total`, and — on Phoenix — asks emptiness of the rows
rather than of the envelope map. Taking these from the flags alone is what made
the same page render blank on the JSX frontends and raise on LiveView.

---

## 10. `scaffold` — the macro family

Scaffolding is **not** a `ui` member keyword.  It is a macro applied through the
universal `with` clause, expanded in AST phase ② — either on the `ui`
declaration or as a `with …` line inside it:

```ddd
ui SalesAdmin with scaffold(aggregates: [Customer], workflows: [placeOrder]) {
  api Sales: SalesApi
  page Home { route: "/"  body: Heading { "Welcome", level: 1 } }
}
```

The four selector arguments are `subdomains:`, `contexts:`, `aggregates:`,
`workflows:` (ref-lists; a wrong-kind ref is `loom.macro-arg-kind-mismatch`, a
wrong host is `loom.macro-target-mismatch`).  There is no `modules:` selector —
the subdomain-level spelling is `subdomains:`.  It fans out hierarchically:

```
scaffold(subdomains: [A])   →  scaffoldSubdomain(of: A)  → one scaffoldContext per context
scaffold(contexts:   [X])   →  scaffoldContext(of: X)    → scaffoldAggregate / scaffoldWorkflow per member
scaffold(aggregates: [Order]) →  area Order { page List, page New, page Detail }
scaffold(workflows: [placeOrder]) → page PlaceOrderWorkflow (+ the shared WorkflowsIndex)
```

Siblings in the family, documented in [`scaffold-macros.md`](scaffold-macros.md):
`scaffoldSubdomain` / `scaffoldContext` / `scaffoldAggregate` / `scaffoldWorkflow`
(the ui-side composers and leaves), `scaffoldApi` / `scaffoldHandlers` /
`scaffoldPaged` / `scaffoldPagedApi` (the api/context side), and
**`scaffoldDashboard`** (target `context`), which emits one singleton query-time
`projection` per aggregate — a row count plus a sum per numeric/money field,
aggregated in SQL — while the ui-side `scaffold` grows `Home` a matching row of
`Stat` tiles bound to it (a money tile through `Money`).  Both halves derive the
projection name in `_dashboard-shared.ts`.

`scaffoldView` is **gone** with the `view` declaration it scaffolded (#2200);
read models are `projection`s now.

### What each scaffolded page contains

Scaffold is sugar: the `with scaffold(...)` macro emits each page with a
walker-stdlib body (built by `src/macros/stdlib/scaffold/_body-builders.ts`)
identical to one the user could hand-write. The contract per page:

| Page | Body |
|---|---|
| `<Agg>List` | Breadcrumbs · Toolbar (heading + "New" button) · optional **filter bar** · `QueryView { of: api.<Agg>.all(page, size, sortKey, sortDir), paged: true }` → server-paged `Table` with one `Column` per **non-collection** scalar field (`IdLink` / `EnumBadge` / `DateDisplay` / text by type), per-row testid. The filter bar binds one input per parameter of the aggregate's parameterised finds — `string` / `guid` / `datetime` / `bool` / enum / id params all render; a parameter shape with no input is the honest gate `loom.scaffold-filter-param-unsupported` rather than a silently dropped filter. |
| `<Agg>New` | Breadcrumbs · heading · `Card { CreateForm { of: <Agg> } }` — RHF + Zod + `useCreate<Agg>`, one input per required field. A field's declared default (`field: T = <expr>`) seeds that input when it is client-evaluable (constant / enum member); otherwise the input starts at the type-zero placeholder. |
| `<Agg>Detail` | Breadcrumbs · heading · `QueryView { of: api.<Agg>.byId(id), single: true }` whose data card holds **three** sections: ① `KeyValueRow` per scalar field; ② one **operation control** per `public operation` — a button that opens a `Modal` hosting an auto-generated `OperationForm { data.<operation> }` (the operation referenced through the loaded record) bound to the `use<Op><Agg>` mutation hook (params dispatched by the same type rules as `CreateForm { of: }`); ③ one **related-entity list** per `contains` collection — a titled `Card { Table }` over `data.<containment>` with a `Column` per part field. |
| `<Workflow>Workflow` | Breadcrumbs · heading · `Card { WorkflowForm { runs: <wf> } }`. |

The Detail page's operations + related-entity lists are the
platform-completeness proof for the modal/disclosure and nested-table
primitives: if `scaffold` can emit them, an explicit `page` can too
(see `examples/acme-order-explicit.ddd`).

Multiple `scaffold` calls stack (`with a(...), b(...)`, or several `with` lines).
No `except` clause — list what you want, not what you don't.

```ddd
ui SalesAdmin with scaffold(subdomains: [Catalog]),
                   scaffold(aggregates: [Customer, Product], workflows: [placeOrder]) {
  api Sales: SalesApi
  page OrderList   { ... }                   // custom
  page OrderDetail(id: Order id) { ... }
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

- Each selector entry resolves to an existing declaration of that kind
  (`loom.macro-arg-kind-mismatch`), reachable through the deployable's `targets`.
- A `with scaffold(...)` clause that survives into lowering unexpanded is
  `loom.scaffold-unexpanded`.
- Stacked `scaffold` directives may not double-scaffold the same construct.
- Two `scaffold` directives may not produce pages with identical generated
  names; explicit `page <Name>` overrides exactly one source.

---

## 10b. `area { … }` — page grouping, and the identity it defines

An `area <Name> { … }` block groups pages (and nested areas) inside a `ui`.
The scaffold emits one per aggregate (`area Orders { page List, page New,
page Detail }`), and you can write them by hand and nest them freely.

The area path is not cosmetic — **it is half of a page's identity**:

- **File placement.**  A page inside `area Ops { area Billing { … } }` lands at
  `src/pages/ops/billing/<page>.tsx` (`.vue`, `.dart`, `_live.ex`, … per
  frontend).  Lowering resolves this into `PageIR.emitPath`.
- **Emitted identifiers.**  `page.name` is unique only WITHIN one area scope, so
  every emitted identifier is derived from the area path plus the name:
  `area Ops { page Dashboard }` emits the React component `OpsDashboard`, the
  Angular `OpsDashboardComponent`, the Feliz `Page` case `OpsDashboard`, the
  Phoenix `OpsDashboardLive`, the Flutter `OpsDashboardPage`, and the Playwright
  page object `e2e/pages/ops_dashboard.ts`.  A page with no area keeps its bare
  name.  Scaffold aggregate pages are the one exception: their role name
  (`List`) is replaced by the aggregate-qualified `OrderList`, which is already
  unique.  (`pageEmitName` / `pageFileBase`, `src/ir/util/page-kind.ts` +
  `src/generator/_frontend/page-identity.ts`.)

Because that identity has to be unique, three rules are enforced:

| Rule | Diagnostic |
|---|---|
| Page names are unique **within one scope** (the ui top level, or one area) | duplicate-page error in `checkPageScope` |
| Area names are unique **within one scope** — two `area Ops { … }` blocks compute the same directory | `loom.ui-duplicate-area` |
| No two pages may resolve to the same `emitPath`, or claim the same scaffold archetype slot | `loom.ui-page-path-collision` / `loom.ui-page-slot-collision` |

The last two used to be silent: the file map kept whichever page was written
last, so one page's body simply vanished from the build.

**Overriding a scaffold page** means declaring yours in the SAME scope as the
scaffold's area — `area Orders { page List { … } }` at ui top level.  The macro
expander merges same-named areas and drops the synthesised `page List`, leaving
exactly one page in the slot.  Declaring it in a DIFFERENT scope
(`area Sales { area Orders { page List } }`) does not override anything: it is
a second page claiming the same archetype, and `loom.ui-page-slot-collision`
rejects it.

---

## 11. `menu` — layered defaults + explicit composition

Pages carry `menu { … }` metadata; sidebar is derived. Optional `ui`-level
`menu` block overrides for full control.

### Lowering

```
1. Run the scaffold macro → pages, each with default `menu { section, label }`
   (defaults: aggregates → "Aggregates", workflows → "Workflows")
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
  section "External" {
    link "Docs" -> "https://docs.acme.com"
  }
}
```

A scaffold names an aggregate's pages by **role** (`List` / `New` / `Detail`)
inside its per-aggregate `area` (`area Orders`), so a bare `link List` is
ambiguous across aggregates.  Disambiguate with the **area-qualified** form
`link Orders.List` / `link Orders.New`.  Pages with a unique name — custom pages
(`OrderConsole`) and the singleton dashboards
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

## 13. Migration *(historical — completed)*

This section records the one-time migration off the pre-metamodel React
generator.  It is done; kept for the rationale.

**Explicit `ui` is required for every UI-mounting deployable.** No implicit
defaults — every `.ddd` file with a frontend deployable declares a `ui` block.
The minimum is a one-liner that recovers the old behaviour:

```ddd
ui WebApp with scaffold(subdomains: [Catalog, Sales, CustomerMgmt]) { }

deployable webApp {
    platform: react
    targets:  api
    ui:       WebApp
    port:     3001
}
```

`examples/acme.ddd` uses this form.  The validator rejects a UI-mounting
deployable without `ui:` (HTTP analogue: the deployable is missing its mount
point).

**Generator changes** (all landed):

- The legacy archetype renderer (`pages-builder.ts`) is **removed**.  Page
  bodies — hand-written and scaffolded alike — route through the shared body
  walker (`src/generator/_walker/walker-core.ts`; `react/body-walker.ts` is now
  a thin re-export), which dispatches every walker primitive into the active
  design pack.
- `pages-emitter.ts` is the shell emitter that wraps the walker's body output
  with `useForm` / mutation hooks / `useParams` / imports.
- `page-objects-builder.ts` stays — driven by route + testid metadata.
- The per-aggregate `workflow-builder.ts` and `theme-builder.ts` files named by
  the original plan no longer exist: workflow plumbing moved into the walker's
  form primitives, and the theme is emitted from the pack layer
  (`react/templating/preparers/theme.ts`).

---

## 14. Open questions / non-goals *(v0 list, re-dispositioned 2026-09-03)*

- **Per-page theming.** *Still open.*  `theme { … }` is system-wide; a page
  picks a `layout:`, not a palette.
- **Internationalisation.** **Resolved.**  The string-catalog layer ships: user-visible
  literals extract to `.loom/messages.en.json`, emit as `t("<key>", "<default>")`
  on every frontend, backtick templates lower to ICU messages, and
  `ddd i18n {extract,init,sync,status,check,prune}` is the translator workflow
  (`check --strict` is the CI gate).  Concatenation in a user-visible slot is now
  an error (`loom.user-visible-concat`, §5).
- **URL-synced state.** **Resolved.**  `store X persist: url` syncs scalar store
  fields to the query string (`loom.store-url-field-invalid` for non-scalars);
  `persist: local` / `session` cover the storage cases (§6).
- **Multi-step named flows.** *Still open, and still a non-goal.*  `state` +
  `match` + named `action`s cover the wizard cases (§12); no `flow` keyword.
- **User-extensible component library.** *Partly resolved.*  The 56 walker
  primitives stay closed, but the extension points around them shipped: user
  `component`s, `component X(…) extern from "<path>"` for hand-written render
  code, `function … extern` for hand-written logic, and the macro-authoring API
  ([`macro-api.md`](macro-api.md)) for source-level expansion.
- **App-shell beyond menu.** **Resolved.**  A system-level
  `layout <Name> { header { … } sidebar { … } footer { … } main }` declares the
  shell slots (bodies are ordinary walker expressions), and a page opts in with
  `layout: <Name>` (presets `default` / `none`).

---

## 15. Grammar sketch (appendix)

A faithful (but abridged) transcription of the UI productions in
`src/language/ddd.langium` as of 2026-09-03 — cross-references, soft-keyword
unions and unrelated members elided.  The grammar file is the authority.

```langium
// 1. `ui` is BOTH a SystemMember and a root-level ModelMember
SystemMember:
    Subdomain | Deployable | BoundedContext | TestE2E | UserBlock | AuthBlock
  | TenancyDecl | ThemeBlock | Ui | Api | Storage | Resource | ChannelSource
  | TimerSource | Layout | Capability | FunctionDecl;

// 2. Deployable's ui binding — sugar or compose, plus `hosts:`
UiSugarBinding:   'ui' ':' ref=[Ui:ID] ','?;
UiComposeBinding: 'ui' ':' ref=[Ui:ID] '{' (bindings+=UiParamBinding (',' …)*)? '}' ','?;
UiParamBinding:   name=LooseName ':' source=[Deployable:LooseName];

// 3. Ui block
Ui:
    'ui' name=ID withClause=WithClause? '{'
        ('framework' ':' framework=Framework ','?)?
        members+=UiMember*
    '}';

Framework returns string:
    'react' | 'svelte' | 'vue' | 'angular' | 'feliz' | 'flutter' | 'phoenixLiveView';

UiMember:
    UiApiParam | UiChannelParam | UiNotification | UiFunction
  | Page | Component | Store | Area | MenuBlock;

UiApiParam:     'api' name=ID ':' apiRef=[Api:ID];
UiChannelParam: 'channel' name=ID ':' context=[BoundedContext:ID] '.' channel=[Channel:ID];
UiNotification: 'on' param=[UiChannelParam:ID] '.' event=[EventDecl:ID]
                    '(' bind=ID ')' '{' body+=AssignOrCallStmt* '}';
UiFunction:     'function' name=ID '(' params? ')' ':' returnType=TypeRef
                    'extern' 'from' externPath=STRING;

// 4. Page
Page:
    'page' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? '{'
        props+=PageProp*
    '}';

PageProp:
      RouteProp | TitleProp | RequiresProp | StateBlock | DerivedProp | ActionDecl
    | BodyProp | PageMenuMeta | LayoutProp | DescriptionProp | OgImageProp | CanonicalProp;

RouteProp:  'route' ':' value=STRING;
TitleProp:  'title' ':' value=Expression;
BodyProp:   'body'  ':' expr=Expression;
LayoutProp: 'layout' ':' value=ID;          // `default` | `none` | a Layout name
RequiresProp: 'requires' expr=Expression;

PageMenuMeta:  'menu' '{' (entries+=MenuMetaEntry (','? …)* ','?)? '}';
MenuMetaEntry: name=LooseName ':' value=Expression;   // section|label|order|hidden (validator)

// 5. Component — `extern from` replaces the body
Component:
    'component' name=ID '(' (params+=Parameter (',' …)*)? ')'
        (extern?='extern' 'from' externPath=STRING)?
        ('{' decls+=ComponentDecl* ('body' ':' body=Expression)? '}')?;

ComponentDecl: StateBlock | DerivedProp | ActionDecl;

// 6. State / derived / action — shared by page, component and store
StateBlock:  'state' '{' fields+=StateField* '}';
StateField:  name=StateFieldName ':' type=TypeRef ('=' init=Expression)?;
DerivedProp: 'derived' name=ID ':' type=TypeRef '=' expr=Expression;
ActionDecl:  'action' name=(ID | 'write') '(' (params+=Parameter (',' …)*)? ')'
                 '{' stmts+=Statement* '}';

// 7. Store — shared client state, referenced by dotted name
Store:     'store' name=ID ('persist' ':' lifetime=LooseName)? '{' decls+=StoreDecl* '}';
StoreDecl: StateBlock | ActionDecl;

// 8. Area — page grouping by containment
Area:       'area' name=ID '{' members+=AreaMember* '}';
AreaMember: Page | Area;

// 9. Layout — a SYSTEM member, not a ui member
Layout:          'layout' name=ID '{' slots+=LayoutSlot+ '}';
LayoutSlot:      LayoutNamedSlot | LayoutMainSlot;
LayoutNamedSlot: name=LayoutSlotName '{' body=Expression '}';
LayoutMainSlot:  'main';
LayoutSlotName returns string: 'header' | 'sidebar' | 'footer';

// 10. Menu
MenuBlock:   'menu' '{' sections+=MenuSection* '}';
MenuSection: 'section' label=STRING '{' (links+=MenuLink (','? …)* ','?)? '}';
MenuLink:
      'link' page=[Page:QualifiedPageName] ('{' (props+=MenuLinkProp …)? '}')?
    | 'link' externalLabel=STRING '->' externalUrl=STRING;
MenuLinkProp: name=LooseName ':' value=Expression;      // label|order (validator)

// 11. Scaffolding is a MACRO, not a production
WithClause: 'with' calls+=MacroCall (',' calls+=MacroCall)*;
MacroCall:  name=ID ('(' (args+=MacroArg (',' args+=MacroArg)*)? ')')?;
MacroArg:   name=LooseName ':' value=MacroArgValue;     // e.g. aggregates: [Order]

// 12. `match` — predicate arms OR variant arms, expression AND statement
Expression: Lambda | MatchExpr | TernaryExpr;

MatchExpr:
    'match' (subject=MatchSubject '{' varArms+=VariantArm* ('else' '=>' elseExpr=Expression)? '}'
           | '{' arms+=MatchArm* ('else' '=>' elseExpr=Expression)? '}');

MatchArm:     cond=Expression '=>' value=Expression;
VariantArm:   varType=TypeAtom (binding=ID)? '=>' value=Expression;
MatchSubject: {infer AwaitExpr} 'await' inner=MatchScrutinee | MatchScrutinee;

MatchStmt:       'match' subject=MatchSubject '{' varArms+=VariantStmtArm* … '}';
VariantStmtArm:  varType=TypeAtom (binding=ID)? '=>' ('{' body+=Statement* '}' | body+=Statement);

// 13. Lambda — expression body or statement block
Lambda: param=ID '=>' (body=Expression | '{' stmts+=Statement* '}');

// 14. Primitive/component invocation — one brace-form builder call
BuilderCall:  type=ID '{' (entries+=BuilderEntry (',' entries+=BuilderEntry)* ','?)? '}';
BuilderEntry: name=LooseName ':' value=Expression | value=Expression;

// 15. `slot` / `action` parameter types
SlotType:   name='slot';
ActionType: name='action' ('(' arg=TypeRef ')')?;
```

`navigate(<Page>, { params })` and `toast(<msg>)` are ordinary calls — resolved
in the page-language standard library at lowering time and lowered to typed
router calls / notifications (the walker's `navigate` arm,
`src/generator/_walker/walker-core.ts`).  A primitive call also parses in the
paren form (`Action(order.confirm)`); the brace form is the documented spelling.

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
