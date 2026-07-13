# Page & component `derived` bindings — named computed values in a render scope

**Status:** SHIPPED — **every frontend**. JS frontends hoist a reactive
computed before the body (React `useMemo`, Vue `computed`, Svelte
`$derived`, Angular `readonly … = computed`); Phoenix/HEEx inline-recomputes
the binding's expr at each use (LiveView re-renders on assign change, so each
use stays fresh; the assign-hoist optimization stays deferred). No framework
gate remains. Pages + components on all; sequential `derived` (referencing an
earlier one) works everywhere.

## TL;DR

A page or component body is a *single expression*, so any value computed
from page data must be **inlined at every use**. Write a list filter once
and reuse it in a count *and* a list, and you repeat the whole expression
— and on Vue/HEEx the duplication also costs a re-evaluation.

This proposal adds a top-level **`derived name: T = expr`** member to
**pages and components** — a typed, read-only, reactive value computed in
the render scope, named once and referenced anywhere in the body. It is
the *same* `derived` concept aggregates already have; only the evaluation
site differs (client render vs server wire shape).

```ddd
page OrderBoard {
  route: "/orders"
  state { query: string = "" }
  derived visible: Order[] = activeOrders.filter(o => o.customer.contains(query))
  body: Stack {
    Field { label: "Search", bind: query }
    Stat  { "Matches", value: visible.count }
    For   { each: visible, o => OrderCard(o) }
  }
}
```

## 1. The defect — a page body can only inline

The page metamodel ([`docs/page-metamodel.md`](../../page-metamodel.md))
gives a page a `route`, optional `state { }` (mutable reactive fields),
and a single `body` expression. Structural variation lives in the
expression engine (`match`, ternaries, inline collection ops). There is
**no way to bind an intermediate value** in the render scope. Consequences:

- **Repetition.** `activeOrders.filter(o => o.status == Confirmed)` used
  in both a `Stat` count and a `For` is written — and computed — twice.
- **No composition.** A second computed value can't build on a first
  (`total = promoApplied ? subtotal * 0.9 : subtotal`); the whole of
  `subtotal` must be re-inlined.
- **Readability.** Long inline chains in markup positions obscure the
  layout they sit inside.

`state` is the wrong tool: it's *mutable* (the user writes to it). What's
missing is the *read-only computed* sibling.

## 2. The pattern to mirror — aggregate `derived`

Aggregates already have exactly this concept:

```ddd
aggregate Order {
  name: string
  derived display: string = name      // computed, read-only, part of wireShape
}
```

`derived` means "a value computed from other fields, read-only, always
reflects its inputs." On an aggregate it's evaluated **server-side** and
becomes part of the wire shape. The page/component case is the **same
concept evaluated in the client render scope** — so it reuses the keyword,
the grammar production, and the `DerivedIR` node. (See §6 for why
`derived`, not `let`.)

## 3. Proposed surface

`derived <name>: <Type> = <expr>` is a top-level member of a `page` or a
`component`, sitting **beside** `state` / `body` (not inside `state { }`),
repeatable, evaluated in declaration order.

```ddd
component Cart(lines: CartLine[]) {
  state { promoApplied: bool = false }
  derived subtotal: money = lines.sum(l => l.amount)
  derived total:    money = promoApplied ? subtotal * 0.9 : subtotal
  body: Stack {
    For { each: lines, l => KeyValueRow { l.name, Money(l.amount) } }
    Toggle { label: "Apply promo", bind: promoApplied }
    KeyValueRow { "Total", Money(total) }
  }
}
```

**Scope.** A `derived` may reference page/component **params**, `state`
fields, API/view data in scope, and **earlier** `derived` bindings.
References resolve inside `body`, `title`, and later `derived` exprs with
`refKind` pointing at the binding.

**Reactivity.** Bindings are **reactive over `state`**: when a `state`
field a binding reads changes, the binding recomputes. This is the natural
render-scope semantics (a `derived` is conceptually `state`'s read-only
twin).

**Hosts.** Pages and components only — see §5.

## 4. Grammar additions

`derived` is already a production used by aggregate members:

```langium
DerivedProp: 'derived' name=ID ':' type=TypeRef '=' expr=Expression;
```

Admit the same production as a `PageProp` and a component member:

```langium
PageProp:
      RouteProp | TitleProp | RequiresProp | StateBlock | DerivedProp
    | BodyProp  | PageMenuMeta | LayoutProp | … ;
```

No new keyword (`derived` is already reserved). The single-line,
type-annotated shape matches the aggregate member exactly, so the printer
arm and reflection unions extend trivially.

## 5. Where it lives — and where it does not

| Construct | Gets `derived`? | Rationale |
|---|:--:|---|
| **Page** | ✅ | has a render scope (`state` + `body`) |
| **Component** | ✅ | a page minus `route`/`menu`; same body walker, same render scope |
| **Aggregate** | ✅ *(already)* | the original `derived` — evaluated server-side into `wireShape` |
| **Workflow** | ❌ | orchestration, no UI render; already has statement-level `let` in action bodies |

Pages and components share one render-scope code path (the walker already
takes `params` + `state` + `body` for both), so the feature is implemented
once and surfaces on both.

## 6. Why `derived`, not `let`

A statement-level `let` already exists (operation / flow / event-handler
bodies). Two reasons the render-scope binding is `derived`, not a
page-level `let`:

1. **Semantics.** `let` reads as an *imperative snapshot* — "save this
   value for later in a sequence of steps." A render-scope binding is the
   opposite: a *reactive* value that re-derives whenever its inputs change.
   `derived` names that correctly.
2. **One concept, one keyword.** `derived` already means "computed,
   read-only, reflects its inputs" on aggregates. Using it on
   pages/components keeps that meaning intact; the only axis that varies is
   *where* it evaluates (server wire shape vs client render). Spending a
   second keyword (`let`) on the same idea would split one concept in two.

Statement-`let` stays exactly as-is (a local in an *execution* scope);
`derived` is the declaration-level *render*-scope binding.

## 7. Lowering

- IR: `PageIR.derived: DerivedIR[]` and `ComponentIR.derived: DerivedIR[]`
  (reuse the existing `DerivedIR` node — `{ name, type, expr }`).
- Lower each binding's `expr` via `lower-expr` in a render env seeded with
  params + `state` + previously-lowered `derived` names, so forward
  references are impossible and refs carry the right `refKind`.
- Thread the binding names into the walk context (alongside `stateNames`)
  so `body` refs resolve to the binding rather than `/* unresolved */`.

## 8. Per-frontend emission

The binding lowers to each framework's idiomatic reactive-computed form,
emitted in the page/component shell **before** the body:

| Frontend | Emission |
|---|---|
| React | `const visible = useMemo(() => activeOrders.filter(o => o.customer.includes(query)), [activeOrders, query]);` |
| Vue | `const visible = computed(() => activeOrders.value.filter(o => o.customer.includes(query.value)));` |
| Svelte 5 | `const visible = $derived(activeOrders.filter(o => o.customer.includes(query)));` |
| Phoenix/HEEx | inline-recompute at each use (`Enum.filter(@active_orders, …)`); LiveView re-renders on assign change, so each use stays fresh. **Compute-once via a socket assign is a follow-up (§10).** |

The JS frontends share `emitExpr`, so the *callback* bodies already render
identically (the inline-collection-op work, DEBT-31); this proposal adds
only the *binding* line in each shell.

## 9. Validation

- **Unknown ref** in a binding `expr` → existing scope error.
- **Forward / self reference** (`derived a = b` where `b` is declared
  later, or `derived a = a`) → reject (`loom.derived-forward-ref`),
  enabled for free by sequential lowering.
- **Type mismatch** between the declared `: T` and the inferred `expr`
  type → reuse the aggregate-`derived` type check.

## 10. Open questions

1. **HEEx compute-once.** Inline-recompute is correct but duplicates work
   when a binding is used N times. A socket-assign hoist (recompute in
   `handle_params/3` + on each state-mutating `handle_event`) gives real
   single-compute but needs assign plumbing + a recompute-on-change
   dependency walk. Defer to a follow-up; ship inline-recompute first.
2. **Memoization deps (React).** A plain `const` recomputes every render
   and is always correct; `useMemo` needs a dependency array. Start with
   `useMemo` over the binding's free state/data refs (the walker already
   tracks `usedParams` / `usesState`), or ship plain `const` first and
   add memo later. (Vue `computed` / Svelte `$derived` track deps
   automatically.)
3. **`title` / `requires` references.** Should a `derived` be referenceable
   from `title:` and `requires:`? Lateral — they're evaluated in the same
   scope, so "yes" is cheap, but confirm against the auth-gate emission
   order.
4. **Non-reactive escape.** Is there demand for a *snapshot* (compute once
   at mount, never recompute)? Not in v0; revisit if a use case appears.

## 11. Non-goals (v0)

- No `derived` on workflows or other non-render constructs.
- No HEEx assign-hoist (inline-recompute only).
- No two-arg comparator / `sortBy` (orthogonal; see page-metamodel §
  inline collection ops).
