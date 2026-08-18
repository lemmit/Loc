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
   finds, operations, workflows, external APIs — every name typed
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
| `scaffold` | Single fixed multi-page rewrite from a domain selector to pages.  Mix it with hand-written pages via override-by-name / unfold — see [`customization-gradient.md`](customization-gradient.md). |
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
| `requires` | Auth predicate — same syntax as on operations. On a React frontend with `auth: ui`, the page renders a client-side `<Forbidden/>` guard (evaluated against `useSession().user`) — the mirror of the backend's 403. Gates are `currentUser`-only (see [auth.md](auth.md)). |
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
same emission path (one component per ui that references them: react
`src/components/<Name>.tsx`, vue `.vue`, svelte `src/lib/components/<Name>.svelte`,
**angular** a standalone class at `src/app/components/<Name>.ts`, flutter a widget
in `lib/components.dart`, and **feliz** — which has no per-component file — an F#
props function in App.fs's nested `Components` module).  Per-target deferrals are
listed in [`generators.md`](generators.md).

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

Two limits:

- **`money.min` / `money.max` / `money.round`** need `decimal.js`'s `Decimal`
  constructor in scope, which the page emitters don't yet import — they still
  emit verbatim. Every other intrinsic (including `money.abs` / `.floor()` /
  `.ceil()`, which are methods on the value) renders.
- **Feliz and Flutter** have no intrinsic table on the walker path yet, so a
  page-body intrinsic still emits verbatim there.

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
| `Stack`, `Group`, `Grid`, `Tabs` (+ `Tab`), `Card`, `Toolbar`, `Container`, `Paper`, `Breadcrumbs`, `Divider`, `Section`, `Sticky` | Layout primitives. `Section` is a semantic anchor target; `Sticky` a sticky-position wrapper; `Tab` is the sub-element of `Tabs` — `Tab { <label>, …children }`, a children container like `Card`: every positional after the label renders in the panel. |
| `Heading`, `Text`, `Bold`, `Italic`, `InlineCode`, `Badge`, `Stat`, `Empty`, `Anchor`, `Image`, `Avatar`, `Loader`, `Skeleton`, `Alert`, `KeyValueRow`, `Icon` | Display primitives. `Bold`/`Italic`/`InlineCode` are inline-emphasis spans; `Icon` is a builtin-name or `svg:` literal, decorative-by-default (`aria-hidden`) unless `label:` gives it meaning — which makes it a named `role="img"` and makes that name a user-visible slot, translated through the message catalog. |
| `Field`, `NumberField`, `PasswordField`, `MultilineField`, `Toggle`, `SelectField { label, bind, options }`, `Select`, `Fieldset` | Bindable inputs. `MultilineField` is the textarea twin of `Field`; `SelectField` is a controlled single-select over a string-array `options:` expression. All accept an optional `error:` expression rendered in the pack's inline error slot (§8.2). |
| `Action(operation, then?)`, `Button { label, on? }` | Action primitives. |
| `Modal { trigger, … }` | Disclosure surface — hosts an `OperationForm` (scaffold detail pages) or a state-controlled `open:` body. The state-controlled form ships on **all six frontends**. Flutter's dialogs are imperative (`showDialog` pushes a route), so there is no widget to conditionally render: it bridges through a generated `LoomModalHost` that drives `showDialog` on the flag's rising edge and reports dismissal back, keeping the page's state the single source of truth. `title:` is a user-visible slot on both shapes — it is the dialog's title, translated through the message catalog. |
| `Money`, `DateDisplay`, `EnumBadge`, `IdLink`, `FileLink` | Formatter primitives. |
| `ProvenanceInfo(of:, field:)` | A "?" disclosure over a `provenanced` field's lineage (a native `<details>`/`<summary>`; [provenance.md](provenance.md)). Reads the co-located `<field>_provenance` lineage; scaffolded onto a provenanced field's detail row. Renders on **five of the six frontends** (all but Flutter) plus the Phoenix/HEEx server render — React/Vue/Svelte/Angular/Feliz off the JSON wire sibling; HEEx reads the string-keyed jsonb struct field server-side (`<%= if … %>`/`<%= for … %>`). |
| `CodeBlock` | Syntax-highlighted code block (highlight.js at runtime). `title:` is a user-visible slot — a caption above the sample, translated through the message catalog. The code SOURCE deliberately is not: translating code breaks it, so an untitled block leaves a page string-less. |
| `Table`, `Column` | Tabular display (data lambda accessors). `Column` is the sub-element of `Table`/`DataGrid`. |
| `DataGrid` | **React, Vue, Svelte, Angular, Feliz.** Interactive grid over the same `Column` children — multi-column sort, per-column filters, column-visibility toggles, client pagination, optional row selection. Backed by [TanStack Table](https://tanstack.com/table); see §9.1 below. Using it on HEEx or Flutter is a compile error (`loom.datagrid-unsupported-target`) — use `Table`, which sorts, pages and filters on every frontend. |
| `For { each: T[], empty?: markup, item => markup }` | List comprehension — emits the item lambda's markup once per element. TSX lowers to a keyed `.map` + `<Fragment>`, Vue to `<template v-for :key>`, Svelte to a keyed `{#each}`, Angular to an `@for (… ; track …)` block, Phoenix LiveView to a `for … do … end` block. A child primitive (nest inside a layout container — it isn't a standalone page body); the list key is the loop index. The optional `empty:` arm is rendered when the collection is empty — Svelte's native `{:else}`, a TSX `length === 0 ? … : .map(…)` ternary, a Vue `v-if` sibling `<template>`, Angular's `@for`/`@empty` block, a HEEx `Enum.empty?/1` guard. |
| `QueryView { of:, loading:, error:, empty:, data:, single?:, paged?: }` | 4-arm query-state branching (collection or single-record). The `data:` binding also exposes the paged envelope's page metadata — see §9.2. |

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

**Containers vs fixed slots.** A layout primitive (`Stack`, `Group`, `Card`,
`Tab`, `Section`, `Toolbar`, `Container`, …) renders *every* positional as a
child. A handful of display primitives are not containers but fixed SLOT
shapes, and every design pack renders exactly their declared positions:
`Stat { <label>, <value> }`, `KeyValueRow { <label>, <value> }`, and the
op-form `Modal { trigger: …, OperationForm { … } }` (which renders the trigger
button plus the operation's generated field set, and nothing else). An extra
positional on one of those is rendered by nobody, so it is a validation error
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
(`primitive-data-grid.hbs` — all eleven JS packs ship one); the TanStack wiring above it is framework-level. The checkbox column
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

## 10. `scaffold` — the one macro

Single fixed pre-codegen pass. Not user-extensible. Hierarchical:

```
scaffold subdomains: A, B, …    →  ∪  scaffold contexts:   <each context in each subdomain>
scaffold contexts:   X, Y, …    →  ∪ {
                                       scaffold aggregates: <each aggregate in X>,
                                       scaffold workflows:  <each workflow in X>
                                     }
scaffold aggregates: Order, …   →  page <Order>List + <Order>New + <Order>Detail
scaffold workflows:  placeOrder, … → page PlaceOrderWorkflow  (+ shared WorkflowsIndex)
```

### What each scaffolded page contains

Scaffold is sugar: the `with scaffold(...)` macro emits each page with a
walker-stdlib body (built by `src/macros/stdlib/scaffold/_body-builders.ts`)
identical to one the user could hand-write. The contract per page:

| Page | Body |
|---|---|
| `<Agg>List` | Breadcrumbs · Toolbar (heading + "New" button) · `QueryView { of: api.<Agg>.all }` → `Table` with one `Column` per **non-collection** scalar field (`IdLink` / `EnumBadge` / `DateDisplay` / text by type), per-row testid. |
| `<Agg>New` | Breadcrumbs · heading · `Card { CreateForm { of: <Agg> } }` — RHF + Zod + `useCreate<Agg>`, one input per required field. A field's declared default (`field: T = <expr>`) seeds that input when it is client-evaluable (constant / enum member); otherwise the input starts at the type-zero placeholder. |
| `<Agg>Detail` | Breadcrumbs · heading · `QueryView { of: api.<Agg>.byId(id), single: true }` whose data card holds **three** sections: ① `KeyValueRow` per scalar field; ② one **operation control** per `public operation` — a button that opens a `Modal` hosting an auto-generated `OperationForm { data.<operation> }` (the operation referenced through the loaded record) bound to the `use<Op><Agg>` mutation hook (params dispatched by the same type rules as `CreateForm { of: }`); ③ one **related-entity list** per `contains` collection — a titled `Card { Table }` over `data.<containment>` with a `Column` per part field. |
| `<Workflow>Workflow` | Breadcrumbs · heading · `Card { WorkflowForm { runs: <wf> } }`. |

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
- `workflow-builder.ts` still exists for
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
// scaffoldWorkflow) and the `with` syntax in
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
