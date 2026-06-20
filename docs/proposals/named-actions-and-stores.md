# Named actions (and stores) — first-class page transitions

> Status: **PROPOSED (design note) — core decisions ratified.** Nothing is
> implemented. This note argues for giving page/component event handlers
> *names* — turning today's anonymous handler lambdas into declared, typed,
> pure-by-construction `action`s — and for an optional `store` declaration that
> bundles shared state with the actions that transition it. It catalogues the
> design space, recommends one shape, sketches the pipeline work against the
> real code, and closes with why this is the prerequisite that turns a
> hypothetical Fable/Feliz/Elmish target from "synthesis" into "projection."
> The decisions in §8 are settled (keyword, purity boundary, composition,
> store deferral, async outcomes); the only remaining open item is `store`
> persistence, explicitly out of v1 scope.

## TL;DR

A page/component handler today is an **anonymous lambda** with a statement
block (`onSubmit: c => { draft.x := c.x; step := 1 }` — grammar
`ddd.langium:743-747`, IR `{ kind: "lambda"; body?; block?: StmtIR[] }` at
`loom-ir.ts:2500-2511`). It has no name in the source or the IR.

Every target that must **hoist** a handler out of the markup therefore has to
*invent* a name. The LiveView walker does exactly this — it gensyms
throwaway event names:

```ts
// src/generator/elixir/heex-walker-core.ts:965
const eventName = `event_${ctx.handlers.length + 1}`;   // → "event_1", "event_2", …
```

Contrast a handler that maps to a **named domain operation** (`Action { confirm }`),
which hoists to a *meaningful* `confirm_order` event in the same file. The
difference is not the mechanism — it's whether the handler has a name. We
propose to close that gap: let authors name page-local transitions, the same
way `operation` already names domain ones.

```ddd
page NewOrder {
  state { step: int = 0; draft: PlaceOrderRequest = {} }

  action next()   { step := step + 1 }
  action submit() { placeOrder(draft); navigate(OrderConsole, { customerId: draft.customerId }) }

  body: match {
    step == 0 => Form { into: draft, fields: [customerId], onSubmit: next }
    step == 2 => Review { of: draft, onSubmit: submit }
    else => Empty {}
  }
}
```

This is mostly **sugar over an existing block** — `action` adds no new
statement semantics, only a name, a parameter list, and a declaration site.
But that name is what lets one declaration project, *without synthesis*, to a
named React handler, a LiveView `handle_event`, **and** a real Elmish `Msg`
case + `update` arm.

## 1. The problem, precisely

Loom's domain layer is rich in **named, typed actions**: `operation`,
`command`, `event`, workflows. Its UI layer is not — page transitions are
anonymous. Three concrete costs follow:

1. **Gensym'd identities.** Every hoisted LiveView handler that isn't a domain
   op is `event_1`, `event_2`, … — opaque in the generated source, in
   traceability, and in any future MVU target.
2. **No view-logic test surface.** A handler's behaviour is reachable only
   through the rendered markup; there is nothing named to assert against.
3. **No MVU projection.** A `Msg` union *can* be emitted from anonymous
   lambdas, but only by **synthesizing** names and threading a model — going
   from less structure to more. That is the single biggest reason the
   Fable/Elmish target (see §7) is "build a thing," not "project the IR."

## 2. The core construct: `action`

An `action` is a **named, pure-by-construction transition** over a state
surface. Surface form:

```
action <name>(<param>: <Type>?) { <Statement>* }
```

The body reuses the existing handler statement set (`Statement`,
`ddd.langium:1577`): `:=` / `+=` / `-=` (state writes), bare calls
(`placeOrder(draft)`, `navigate(...)`, `toast(...)`), `emit`, `let`, `for`,
`if let`. **No new statement semantics.**

### 2.1 The one rule that earns the payoff — purity by restriction

Split the admissible statements into two buckets:

- **state writes** — `step := 1`, `draft.x := c.x`
- **declared effects** — `placeOrder(draft)`, `navigate(...)`, `emit …`

An action body restricted to *exactly these* is, semantically, a pure
function `(state, payload) -> (state', Cmd)` — Elm's `update` signature. The
imperative `:=` surface is sugar over an immutable transform; the effects are
*reified* (they become `Cmd`s), not arbitrary imperative reach.

> **This restriction is the design.** It is what makes one `action`
> projectable to a Zustand action, a Pinia action, an Elmish `Msg` + `update`
> arm, a LiveView `handle_event` — *and* unit-testable as a pure function with
> no DOM. Relax it (let an action do arbitrary imperative work — DOM pokes,
> `fetch`, escape into host APIs) and only the imperative targets survive; the
> Elmish/testability rows stop being derivable. The validator must enforce
> "state-writes + declared-effects only" for `action` bodies.

### 2.2 Who owns the interface — the action and the call site, jointly

An action's interface has two halves with two different owners (confirmed
against the Form contract, `page-metamodel.md:256` vs `:525`):

| Half of the interface | Declared by | Example |
|---|---|---|
| The **state** an action reads/writes | the enclosing `state {}` / `store` | `step`, `draft` |
| The action's **payload param** (if any) | the **call-site primitive** | Form value `c`, Table row `id`, or *nothing* |

The two Form idioms make the split visible:

```ddd
Form { into: draft, fields: [customerId], onSubmit: next }        // `into:` two-way-binds ⇒ handler NULLARY
Form { fields: [customerId],              onSubmit: setCustomer } // no `into:` ⇒ Form supplies its value ⇒ payload param
```

So wiring `onSubmit: <action>` is a **conformance check**: the value the
primitive supplies (form value / row / nothing) must be assignable to the
action's declared param. This is the *same* typed-boundary pattern as
`extern` (`loom-ir.ts:1953-1960`) — a declared interface on one side, call
sites checked against it on the other. The cost relative to an anonymous
lambda (which infers the param type from the site for free) is one
annotation; the benefit is a stable, reusable, projectable identity.

### 2.3 Effectful calls and outcomes — success/failure continuations

A pure action that *only* writes state is `(state) -> state'`. The moment it
invokes an async effect with a result — an API write that can succeed or fail —
it is `(state) -> (state', Cmd)` and MVU needs **both** outcome arms. Loom
splits this by direction:

- **Reads (server state / queries) — derived, no new surface.**
  `QueryView { of: api.Order.byId(id), loading: …, error: …, data: … }`
  already carries the endpoint, the wire shape, *and* the three branches — i.e.
  `Idle | Loading | Loaded of T | Failed of E`. The generator **derives** the
  remote-data union + load `Cmd` + outcome `Msg` from `QueryView`; no DSL
  change.

- **Writes (commands with an outcome) — reuse `then:`, add a failure arm.**
  The language already has a *success continuation*: the
  `Action { confirm, then: navigate(...) }` primitive's `then:`. We extend that
  one idea — an effectful call carries an optional `then` (success) and an
  optional `onError` (failure); the pair **is** a `Result<T, E>` outcome `Msg`
  with its two `update` arms. A call with neither keeps today's terse
  implicit-success behaviour (failure bubbles to the generic error surface), so
  the common case stays short.

```ddd
action submit() {
  call placeOrder(draft)
    then      => navigate(OrderConsole, { customerId: draft.customerId })
    onError e => toast(e.message)
}
```

projects to:

```fsharp
| Submit ->
    model,
    Cmd.OfAsync.either Api.placeOrder model.Draft
        (fun _ -> Submitted (Ok ())) (fun e -> Submitted (Error e.Message))
| Submitted (Ok ())   -> model, Navigation.navigate (Route.OrderConsole model.Draft.CustomerId)
| Submitted (Error m) -> model, Cmd.ofMsg (Toast m)
```

This closes the one MVU axis named actions do not (async effect outcomes) with
a single *precedented* syntactic addition rather than a new concept, and it
degrades gracefully — the `onError` arm is optional. See §8 for the decision
record.

## 3. The sharing boundary: `store` (optional extension)

`action` does **not** require a `store`. State used by one page/component and
dying with it stays page-local; naming a transition over it is "store-less"
and is the common case. A `store` is for state that is **shared across pages
or outlives a single page**:

```ddd
store Cart {
  state { lines: OrderLine[] = [] }
  action add(l: OrderLine) { lines += l }
  action clear()           { lines := [] }
}

page Catalog { use Cart   body: Table { Products.all, rowAction: add } }     // add(l) ← row payload
page CartPage {
  use Cart
  state { confirming: bool = false }      // page-local AND shared, side by side
  action checkout() { confirming := true }
  action discard()  { Cart.clear() }      // page action may CALL a store action…
}
```

**Scope is the only difference; the action construct and its rules are
identical.** A `store` is "named state + named actions, shared." The
projection table:

| Surface | Lifetime | Projects to |
|---|---|---|
| page/component `state {}` + actions | dies with the page | React `useState` + named fns · **F# `UseElmish`** (component-local MVU) · LiveView page assigns + `handle_event` |
| `store {}` | shared / persistent | Zustand · Pinia · Svelte store module · **global/context Elmish program** · LiveView assigns |

That the store-less case maps to Fable's **`UseElmish`** (the community's
preferred component-scoped MVU pattern) and the store case maps to a
global/context program is the tell that both are first-class, not one a
shortcut for the other.

### 3.1 Encapsulation boundary

The one rule that keeps every projection clean: a page action mutates *page*
state directly and may **call** a store action (`Cart.clear()`), but never
writes store state in-line. Store state changes only through store actions
(Pinia/Zustand encapsulation; in Elmish, a child program dispatching to its
parent via a message).

## 4. Naming the construct

`action` is the keyword (decided — §8.1): it is the word every web developer knows
(Redux / Zustand / Pinia all say "action"), and inside an action *declaration*
position it is lexically and positionally distinct from the existing
`Action {…}` render primitive (PascalCase builder-call in body position). The
residual conceptual overlap is the cost; familiarity is the benefit, and the
case/position convention carries the disambiguation.

Rejected alternatives: `intent` (collision-free but unfamiliar — a viable
fallback if the `Action {}` overlap is judged too costly); `transition`
(honest about the FSM-ish semantics but verbose and over-promising);
`msg` / `update` / `reducer` (leak one specific target — Elmish/Redux — into a
DSL that is deliberately target-neutral).

## 5. Pipeline work (sketch, against the real code)

1. **Grammar** (`src/language/ddd.langium`): an `ActionDecl` member
   (`'action' name=ID '(' params? ')' '{' stmts* '}'`) admissible in `page`,
   `component`, and a new `store` declaration. Reuse `Parameter` and
   `Statement`. Add `StoreDecl` + a `use <Store>` binding clause. Regenerate
   (`npm run langium:generate`); add the print arms
   (`print-completeness.test.ts` gates this).
2. **IR** (`src/ir/types/loom-ir.ts`): `ActionIR { name; params: ParamIR[];
   body: StmtIR[] }`; add `actions: ActionIR[]` next to
   `state: StateFieldIR[]` on `PageIR` (`:1855`) and `ComponentIR` (`:1941`).
   New `StoreIR { name; state: StateFieldIR[]; actions: ActionIR[] }` +
   per-page store bindings.
3. **Lower** (`src/ir/lower/lower-ui.ts`): lower action bodies through the
   existing `lower-stmt` path (no new statement lowering). Resolve
   `onSubmit: <name>` references to actions; record the call-site-supplied
   payload type for the conformance check.
4. **Validate** (new check leaf under `src/ir/validate/checks/`): (a) action
   bodies contain only state-writes + declared effects (§2.1); (b) every
   `onSubmit:`/`rowAction:` action reference conforms to the
   primitive-supplied payload type (§2.2); (c) store state is written only by
   store actions (§3.1).
5. **Generators**: the existing `WalkerTarget` seam already lowers handler
   bodies per framework (`renderStateWrite`, `renderEventHandler`,
   `renderApiCall`, `renderNavigate`). A named action changes *where the body
   lives* (a named declaration) and *what the hoisted handler is called*, not
   *how a statement renders*. React/Vue/Svelte/Angular emit a named local /
   store member; the LiveView walker replaces the `event_N` gensym
   (`heex-walker-core.ts:965`) with the action name. No new per-statement
   render logic.

This is deliberately incremental: **store-less page/component actions first**
(names, exhaustive `Msg`, testability, end of `event_N`), **`store` second**
(sharing/lifetime). The first slice touches no statement rendering at all.

## 6. What this buys the existing targets (today, no new backend)

- **LiveView**: every non-domain hoisted handler gets a meaningful
  `phx-click="set_customer"` instead of `event_1`.
- **Traceability / provenance**: page transitions become named, addressable
  nodes alongside domain operations.
- **Generated tests**: pure actions (§2.1) are unit-testable without a DOM —
  the generator can emit `update(SetCustomer c) model = …` assertions.
- **React/Vue/Svelte**: handlers become named functions / store actions
  instead of inline arrows — more readable generated source, natural Zustand /
  Pinia emission once `store` lands.

## 7. The connection to a Fable/Feliz/Elmish target

This note is the prerequisite the (separate) Fable/Elmish-target analysis kept
running into. The headline claim of that analysis — "Loom already models
named, typed actions, so the Elmish `Msg` union is a *projection*" — is **false
against today's IR** (handlers are anonymous; `loom-ir.ts:2500-2511`). Named
actions make it **true**:

```fsharp
type Msg =
  | Next                          // action next()             → nullary case
  | SetCustomer of CustomerRef    // action setCustomer(c:..)  → param IS the payload
  | Submit                        // action submit()           → effects become Cmds in update
```

- `action <name>(<p>: T)` → `Msg.<Name> of T` (no synthesis — projection).
- A pure action body (§2.1) → one `update` arm returning `(Model, Cmd)`.
- `state {}` → `Model`; store-less → `UseElmish`; `store {}` → a shared program.
- The §2.2 conformance check is exactly what guarantees the `Msg` payload type
  matches what the view dispatches.

Independently of whether F# is ever emitted, named actions are worth doing for
§6. They just *also* happen to be the missing structural premise that
converts the Elmish target from a synthesis problem into a projection — see
the gap analysis tracked alongside this note.

## 8. Decisions (ratified)

These were settled and are no longer open. They define v1.

1. **Keyword — `action`.** The universal word (Redux/Zustand/Pinia/Vuex);
   distinct from the `Action {}` render primitive by case + position (lowercase
   declaration keyword vs PascalCase builder-call in body position). `intent`
   remains the fallback only if the overlap is later judged too costly.
2. **Action body purity — the admissible set is fixed.** An action body may
   contain *only*: state writes (`:=` / `+=` / `-=`) on owned state; declared
   effects (`call` / `navigate` / `emit`); and `let` / `for` / `if let` control
   flow. **No** DOM access, `fetch`, or escape to host APIs. This is what makes
   an action a pure `(state, payload) -> (state', Cmd)`; the validator enforces
   it (§2.1).
3. **Action composition is acyclic.** A page action may *call* another action
   on the same surface or a store action (§3.1); the call graph must be acyclic
   — the validator rejects cycles, keeping `update` well-founded.
4. **`derived` and `action` stay distinct.** No effects in `derived`
   (read-only computed, `page-metamodel.md`); no pure-read aliasing in
   `action`.
5. **`store` is deferred — v1 ships store-less page/component actions only.**
   Cross-page sharing and lifetime/persistence are orthogonal to the MVU
   projection (which needs *named actions*, not *shared state*). `store` lands
   second (§3).
6. **Async outcomes (§2.3).** Reads are **derived** from `QueryView` (no new
   surface). Writes reuse the existing `then:` success continuation and add an
   optional `onError` failure arm; the `(then, onError)` pair projects to a
   `Result<T, E>` outcome `Msg` + two `update` arms. Continuation-less calls
   keep implicit-success behaviour.

## 9. Remaining open item

- **`store` lifetime/persistence** — in-memory only, or
  session/local-storage-backed? Out of scope for v1; revisit when `store`
  lands.
