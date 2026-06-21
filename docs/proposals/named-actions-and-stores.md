# Named actions (and stores) — first-class page transitions

> Status: **PROPOSED (design note) — core decisions ratified.** Nothing is
> implemented. This note argues for giving page/component event handlers
> *names* — turning today's anonymous handler lambdas into declared, typed
> `action`s whose purity is an **enforced invariant** (not the authoring
> mental model) — and for an optional `store` declaration that bundles shared
> state with the actions that transition it. It catalogues the design space,
> recommends one shape, sketches the pipeline work against the real code, and
> closes with why this is the prerequisite that turns a hypothetical
> Fable/Feliz/Elmish target from "synthesis" into "projection." The decisions
> in §8 are settled (keyword, purity boundary, effect-vocabulary scoping,
> composition, store deferral, async-outcome *shape*); the remaining open items
> are the `await`/`spawn` marker *spelling* (§2.3), whether **actions themselves
> are `async`/awaitable** (§2.4), and `store` persistence — all out of v1 scope.
>
> **Framing note (this revision):** "an action is a pure function" is
> idiomatic to *nobody* — Redux calls the data an action and the *reducer*
> pure; Zustand/Pinia call the action an *impure* mutating method; Elm has no
> "action" and names the pure function `update`. So purity is presented here
> as a **validator-enforced restriction**, not the pitch. Authors write an
> action like a Pinia method (named, imperative-looking `:=`); the compiler
> *proves* it pure by reifying the declared effects. Lead users with "a named
> state transition," reserve the `(state, payload) -> (state', Cmd)` reading
> for the backend author.
>
> **Notation & ground truth.** Examples below are tagged **✅ ships today** or
> **🔶 proposed (this note)**. Three corrections to earlier drafts, verified
> against the grammar: (1) there is **no `call` keyword** — a bare invocation
> is already a statement (`AssignOrCallStmt`, `ddd.langium:1704`; the `call?=`
> there is a *has-parens* flag, not a keyword); (2) the only `then` that ships
> is the **success-only named arg on the `Action {}` render primitive**
> (`then:`, read via `namedArgValue`, `controls.ts:194`) — the statement-level
> `then`/`onError` continuation in §2.3 is 🔶, and its spelling (arrow vs the
> colon precedent) is open; §2.3 now **drops `then` entirely** — async outcomes
use explicit `await`/`spawn` markers + `onError`, and the `Action {}` `then:`
retires when that primitive becomes the Phase-4 macro over named actions; (3)
there is **no nullary `() =>` lambda** — the
> rule requires exactly one param (`Lambda: param=ID '=>' …`,
> `ddd.langium:1896`), so a nullary handler is reached only by *referencing* a
> named action. `toast(…)` ships only inside live-event `on …(e) { toast(…) }`
> handlers today (`react/realtime-handlers-builder.ts`); admitting it in action
> bodies is part of the 🔶 surface.

## TL;DR

A page/component handler today is an **anonymous, single-param lambda** with a
statement block (`onSubmit: c => { draft.x := c.x; step := 1 }` — grammar
`Lambda` at `ddd.langium:1896`, IR `{ kind: "lambda"; param; body?; block?:
StmtIR[] }` at `loom-ir.ts:2493-2503`). It has no name in the source or the IR.

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
page NewOrder {                                            // 🔶 the action decls + bare-ref handlers are proposed
  state {                                                  // ✅ state block / fields ship today
    step: int = 0
    draft: PlaceOrderRequest = {}
  }

  action next()   { step := step + 1 }                                       // 🔶 (body stmts are ✅ real)
  async action submit() { await placeOrder(draft); navigate(OrderConsole, { customerId: draft.customerId }) }  // 🔶 decl; calls ✅

  body: match {                                            // ✅ match / Form / onSubmit ship today
    step == 0 => Form { into: draft, fields: [customerId], onSubmit: next }     // onSubmit: <named action> is 🔶
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
`ddd.langium:1624`): `:=` / `+=` / `-=` (state writes), local/sync calls
(`navigate(...)`, pure helpers), `emit`, `let`, `for`, `if let`, `return` — all
✅ today. The one **🔶 statement-level addition** is the remote-call markers
`await` / `spawn` + `onError` (§2.3); a *remote* call may not be bare. (`toast(…)`
is *not* yet a general body call either — it ships only in live-event `on`
handlers; admitting it here is 🔶, see §3.2.)

### 2.1 The one rule that earns the payoff — purity by restriction

Split the admissible statements into two buckets:

- **state writes** — `step := 1`, `draft.x := c.x`
- **declared effects** — `placeOrder(draft)`, `navigate(...)`, `emit …`

An action body restricted to *exactly these* is, semantically, a pure
function `(state, payload) -> (state', Cmd)` — Elm's `update` signature. The
imperative `:=` surface is sugar over an immutable transform; the effects are
*reified* (they become `Cmd`s), not arbitrary imperative reach.

> **Purity is the output, not the input.** The author does not "write a pure
> function" — they write a named, imperative-looking transition (the Pinia
> mental model). The compiler *harvests* purity because the effects are
> declared rather than freely invoked. So this is an **enforced invariant**:
> the validator rejects anything outside the admissible set; the author never
> has to hold "pure" in their head, they just bump into the restriction if
> they reach for a DOM poke / raw `fetch` / host escape.

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

### 2.3 Effectful calls and outcomes — `await`, `spawn`, and failure

A pure action that *only* writes state is `(state) -> state'`. The moment it
calls a **remote** effect — a server command/query that can succeed or fail —
it becomes `(state) -> (state', Cmd)` and MVU needs the outcome arms. Loom
splits this by direction:

- **Reads (server state / queries) — derived, no new surface.**
  `QueryView { of: api.Order.byId(id), loading: …, error: …, data: … }`
  already carries the endpoint, the wire shape, *and* the three branches — i.e.
  `Idle | Loading | Loaded of T | Failed of E`. The generator **derives** the
  remote-data union + load `Cmd` + outcome `Msg` from `QueryView`; no DSL
  change.

- **Writes (commands with an outcome) — explicit marker + failure arms.** 🔶
  Settled across the design discussion, on three principles. There is **no
  `then`** — it is dropped entirely (the success-only `then:` on the `Action {}`
  render primitive retires when that primitive becomes the Phase-4 macro over
  named actions, leaving one statement model with no `then` anywhere).

**(1) Success is implicit sequencing.** The success continuation is *the next
statement* — exactly how a backend operation body already sequences, and how
`await` works in every mainstream language. No `then` arm; multi-step flows stay
flat and stack for free:

```ddd
action submit() {                                   // 🔶
  let order = await placeOrder(draft)               // remote write — await + bind result
  await sendReceipt(order.id)                        // runs only on success of the previous
  navigate(OrderConsole, { id: order.id })           // sync; no marker
}
```

**(2) Every remote call carries an explicit, compiler-checked marker.** A bare
remote call is rejected — invisible suspension points are the maintenance hazard
`await`/`async` exist to prevent, so the author must choose one of two intentful
forms. Because async-ness is *decidable* from resolution, the marker is
**enforced both ways** (no floating-promise footgun — the classic "forgot
`await`" bug becomes a compile error):

| Form | Suspends? | Continuation | Failure |
|---|---|---|---|
| `await op()` | yes | runs **after** it resolves (MVU arm split) | `onError` aborts/recovers inline |
| `spawn op()` | no | runs **immediately** (batched `Cmd`, no split) | **detached** `onError`, or dropped |
| bare `op()` (remote) | — | — | **error** — must choose `await` or `spawn` |

`spawn` is first-class fire-and-forget (analytics, telemetry, optimistic-UI
background saves). Its `onError` is *detached* — it never aborts or blocks the
continuation (which already ran); omit it and the failure is dropped (or routed
to a default telemetry sink). `let x = spawn …` is an error (nothing to bind).
Both `await` and `spawn` reify to `Cmd`s, so the action stays pure either way.

**(3) Failure is per-call `onError`, falling back to a block `onError`.** A
postfix handler attaches the *failure* arm to a single call (success is still
the next statement, so this does **not** reintroduce `then`'s nesting); a
block-level `onError` is the catch-all. Precedence: **per-call → block →
propagate** (to a generic UI error boundary):

```ddd
action submit() {                                          // 🔶
  let order = await placeOrder(draft)  onError e => abort show(e)  // recover or bail
  await sendReceipt(order.id)          onError e => log(e)         // best-effort, continue
  await audit(order.id)                                            // falls to block onError
  navigate(OrderConsole, { id: order.id })                        // sync, no error surface
} onError e => toast(e.message)                                  // catch-all
```

After a handler runs: a `let`-bound call must recover a value of the bound type
or `abort`; an unbound call continues by default; `abort` stops the rest of the
body. The sequential block projects to one MVU arm per `await`, with `onError`
selecting the `Failed` arm:

```fsharp
| Submit          -> model, Cmd.OfAsync.either Api.placeOrder draft (Ok>>Placed) (Error>>PlaceFailed)
| Placed (Ok ord) -> { model with Order=ord }, Cmd.OfAsync.either (Api.sendReceipt ord.Id) () (Ok>>Receipted) (Error>>ReceiptFailed)
| PlaceFailed e   -> model, Cmd.ofMsg (Show e)          // abort — no continuation enqueued
| ReceiptFailed e -> model, Cmd.ofMsg (Log e)           // best-effort — continuation still runs
| Receipted _     -> model, Cmd.OfAsync.either (Api.audit ord.Id) () (Ok>>Done) (Error>>Failed)
```

`spawn` is the optimistic-update shape — no arm split, detached rollback:

```ddd
action like(post) {                                         // 🔶
  post.liked := true                                         // optimistic UI update now
  spawn likePost(post.id) onError e => post.liked := false   // background; rollback on failure
}
```

```fsharp
| Like post    -> { model with Liked = true }, Cmd.OfAsync.attempt Api.likePost post.Id (Error>>LikeFailed)
| LikeFailed _ -> { model with Liked = false }, Cmd.none    // detached rollback arm
```

**Backend symmetry.** The `placeOrder` *operation* these calls hit is unchanged
and `await`-free — a straight-line body (I/O at the transaction boundary, not in
the body) ending in the exception-less `Result` union (`return Placed(...)` /
`return Failed(...)`, `dotnet/render-stmt.ts:113-135`, `exception-less.md`). The
frontend's `await … onError` *consumes* exactly that union — backend produces the
`Failed` variant, frontend binds it. Two ends of one `Result<T,E>` contract: one
neutral statement IR, two lowerings (straight-line transaction vs MVU arms).

**Validator rules.**
- `loom.missing-effect-marker` — a remote call that is neither `await` nor
  `spawn` → error.
- `loom.spurious-effect-marker` — `await`/`spawn` on a local call / value-object
  ctor / pure `function` → error.
- `loom.bind-on-spawn` — `let x = spawn …` → error.

This closes the async-outcome MVU axis with an explicit, enforced surface that
matches what every language does, and `spawn` makes fire-and-forget first-class.
See §8.7 for the decision record and §2.4 for whether actions are themselves
awaitable.

### 2.4 Async actions — propagation, awaiting actions, the action interface 🔶

If an action *contains* an `await`, it has a suspension point and an eventual
completion — it is **async**. Three questions follow (raised in review): is
async-ness visible, can one action `await` another, and what interface does an
action expose? The coherent answer reuses the §2.3 discipline uniformly — a
*call with an outcome* is treated the same whether the callee is a remote op or
an async action.

**Async-ness is inferred, but declared.** An action is async iff it
(transitively) awaits a remote op — *decidable*, so (as with the call-site
marker) the compiler needs no `async` keyword to know. But by the same
"explicit at the boundary" principle that gave us `await`, the **declaration**
carries `async` so a caller knows the contract from the signature alone, and the
compiler **checks** it against the body (missing/spurious `async`, mirroring
missing/spurious `await`):

```ddd
action       next()      { step := step + 1 }                           // sync
async action checkout()  { await placeOrder(draft); navigate(Receipt) }  // body awaits ⇒ async
```

**Awaiting an action is the same discipline as awaiting an op.** An async action
is itself `await`/`spawn`-able; a sync one is bare-called (the §3.1 composition
already allows action→action / page→store calls — this just extends the §2.3
marker rule to cover async callees):

```ddd
async action confirm() {                                     // 🔶
  await checkout()           // awaiting another ASYNC action — sequences after it completes
  Cart.clear()               // sync store action — bare call (unchanged from §3.1)
}
```

`loom.missing-effect-marker` / `loom.spurious-effect-marker` now range over
**both** remote ops and async actions: `await next()` (sync) and bare
`checkout()` (async) are both errors. Async-ness propagates transitively up the
(acyclic, §8.4) call graph, so the inference is well-founded.

**The action interface — and what it deliberately omits.** §2.2 framed an
action's interface as *state surface + payload param*. Async-ness adds one
facet; notably it does **not** add a return value:

| Interface facet | Owner | Checked at call site |
|---|---|---|
| payload param (§2.2) | call-site primitive | supplied value assignable to param |
| `async` | the body (inferred → declared → checked) | marker (`await`/`spawn`) matches |
| **return value** | — none — | actions are *transitions*, not functions |

An action returns **nothing bindable** — it is a `(state, payload) -> (state',
Cmd)` transition, not a function. `await checkout()` *sequences* but yields no
value; `let x = await checkout()` is an error (`loom.bind-on-action`). To get a
value back, `await` the **remote op** directly (ops return their result —
`let order = await placeOrder(draft)`) or read shared `store` state. Keeping
actions value-less is what preserves the MVU projection: an action is a `Msg`,
and a `Msg` carries a *payload in*, not a *value out*; a value-returning action
would be a general async function and break the `update`-arm shape.

So actions are awaitable when async, async-ness is inferred-but-declared-and-
checked, and the interface they conform to is `[async] (payload?: T)` with no
return — one uniform marker discipline across ops and actions. **Open (§9):**
whether `async` is a required declaration keyword or fully inferred, and whether
v1 includes async action→action awaiting or defers it with `store`.

## 3. The sharing boundary: `store` (optional extension)

`action` does **not** require a `store`. State used by one page/component and
dying with it stays page-local; naming a transition over it is "store-less"
and is the common case. A `store` is for state that is **shared across pages
or outlives a single page**:

```ddd
store Cart {                               // 🔶 store/use/action all proposed; body stmts (:=, +=, calls) ✅
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

### 3.1 Encapsulation boundary — state is scoped per surface

The one rule that keeps every projection clean: a page action mutates *page*
state directly and may **call** a store action (`Cart.clear()`), but never
writes store state in-line. Store state changes only through store actions
(Pinia/Zustand encapsulation; in Elmish, a child program dispatching to its
parent via a message).

The cross-surface call is what keeps the *single* purity rule sound across
both surfaces: each action `:=`-writes **only its own** state; touching
another surface is a reified **call** (a `Cmd`), never an inline write. So
`discard() { confirming := false; Cart.clear() }` stays pure — `Cart.clear()`
dispatches across the program boundary, it does not reach into Cart's model.
Allowing `Cart.lines := []` from a page would make the page's `update` mutate
foreign state — breaking Pinia/Zustand encapsulation *and* the Elmish
child-program boundary at once. Composition is one-way by lifetime: a page
action may call a store action (shared outlives page); a store action may call
another store action (acyclic, §8.4) but **never** a page action.

### 3.2 Effect vocabulary is scoped per surface — `navigate`/`toast` are view-only

The §3.1 boundary scopes *state* per surface. The same logic scopes *effects*:
an action sees only the declared effects its surface can host. `navigate` and
`toast` are **view-scoped** — they need a router/location (SPA) or a socket
(LiveView `push_navigate`) that only a page/component has. A `store` is
view-less shared state with no route and, on LiveView, no socket to navigate
on. So they are **illegal in store actions**, and the calling page owns the
navigation:

```ddd
store Cart {
  state { lines: OrderLine[] = [] }
  action clear() { lines := [] }            // data only — no navigate/toast
}

page CartPage {                              // 🔶 store/use/action + await/onError; bare call ✅
  use Cart
  async action confirm() {
    await placeOrder(Cart.lines) onError e => showError(e.message)
    Cart.clear()                                       // sync store action
    navigate(OrderConsole, { id: ... })                // page owns the redirect
  }
}
```

```fsharp
// the page program owns the nav Cmd; the Cart program only ever mutates Lines
| Confirm           -> model, Cmd.OfAsync.either Api.placeOrder model.Cart.Lines (Ok>>Confirmed) (Error>>ConfirmFailed)
| Confirmed (Ok ()) -> model, Cmd.batch [ Cmd.ofMsg (CartMsg Clear); Navigation.navigate (Route.OrderConsole ...) ]
| ConfirmFailed e   -> model, Cmd.ofMsg (ShowError e)
```

| In an action body | page / component | store |
|---|---|---|
| `:=` own state · bare call · `emit` · call a store action | ✓ | ✓ |
| `navigate` / `toast` | ✓ | ✗ — view-scoped |

This is not a purity exception (`navigate` reifies to a `Cmd` cleanly) — it is
the effect-side of the ownership boundary. The honest ergonomic cost is
`Auth.logout()` "wanting" to redirect: the answer is either the page that
triggers logout owns the `navigate`, or — better for auth — the redirect is a
declarative reaction to "no session" (route guard / `on_mount`), which is
auth's job, not `store`'s.

## 4. Naming the construct

`action` is the keyword (decided — §8.1): it is the word every web developer knows
(Redux / Zustand / Pinia all say "action"), and inside an action *declaration*
position it is lexically and positionally distinct from the existing
`Action {…}` render primitive (PascalCase builder-call in body position). The
residual conceptual overlap is the cost; familiarity is the benefit, and the
case/position convention carries the disambiguation.

Two cautions, regardless of which word wins. First, the word is familiar but
its *meaning* is not shared: Redux's action is data, Zustand/Pinia's is an
impure method, Elm has no action and names the pure function `update` — so the
keyword buys recognition, not a precise semantic the user already holds. The
unifying truth to teach is "a named state transition," and (per §2.1) purity
is enforced, never advertised. Second, the real practical cost is the
`Action {}` collision, not the semantics; if it bites in real `.ddd` files,
`intent` is the clean fallback.

Rejected alternatives: `intent` (collision-free but less familiar — the
designated fallback if the `Action {}` overlap is judged too costly; it also
honestly carries the dispatch-identity-that-gets-reduced meaning, à la Android
MVI, without falsely promising purity); `transition` (honest about the FSM-ish
semantics but verbose and over-promising); `msg` / `update` / `reducer` (leak
one specific target — Elmish/Redux — into a DSL that is deliberately
target-neutral).

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
   store actions (§3.1); (d) a store action contains no view-scoped effect —
   reject a `navigate`/`toast` `callKind` whose enclosing surface is a `store`
   (§3.2). These are **validator** checks, not scope visibility: scope answers
   *"is this name visible?"* (a store action simply can't *see* page state —
   resolution failure, free), but (c)/(d) are *contextual* — the store field
   is in scope for reads, and `navigate` is a built-in call-kind with no
   declaration to omit, so neither can be expressed as a scope rule. Run them
   at the IR level (phase ⑦) where the `callKind` and l-value are resolved,
   rather than string-matching a bare `navigate` at the AST.
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
against today's IR** (handlers are anonymous; `loom-ir.ts:2493-2503`). Named
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
   declaration keyword vs PascalCase builder-call in body position). The word
   buys recognition, not a shared semantic (it means data in Redux, an impure
   method in Zustand/Pinia, nothing in Elm) — so it is taught as "a named state
   transition," never "a pure function." `intent` remains the fallback only if
   the `Action {}` overlap is later judged too costly.
2. **Action body purity — enforced, not advertised; the admissible set is
   fixed.** An action body may contain *only*: state writes (`:=` / `+=` / `-=`)
   on owned state; declared effects (local/sync calls + `navigate` / `emit`, and
   remote calls via `await` / `spawn` — §2.3); and `let` / `for` / `if let`
   control flow. **No** DOM access, `fetch`, or escape to host
   APIs. This makes an action semantically pure `(state, payload) -> (state',
   Cmd)` — but purity is the *output* (the compiler harvests it by reifying
   declared effects), not the authoring model (Pinia-style named transition).
   The validator enforces the admissible set (§2.1).
3. **Effect vocabulary is scoped per surface (§3.2).** Each action sees only
   the effects its surface can host. `navigate` and `toast` are view-scoped
   (need a router/socket a `store` lacks) and are **illegal in store actions**;
   the calling page owns navigation. State is likewise scoped — an action
   `:=`-writes only its own surface; cross-surface is a reified *call*, never
   an inline write (§3.1). Composition is one-way by lifetime: page → store,
   store → store (acyclic), never store → page.
4. **Action composition is acyclic.** A page action may *call* another action
   on the same surface or a store action (§3.1); the call graph must be acyclic
   — the validator rejects cycles, keeping `update` well-founded.
5. **`derived` and `action` stay distinct.** No effects in `derived`
   (read-only computed, `page-metamodel.md`); no pure-read aliasing in
   `action`.
6. **`store` is deferred — v1 ships store-less page/component actions only.**
   Cross-page sharing and lifetime/persistence are orthogonal to the MVU
   projection (which needs *named actions*, not *shared state*). `store` lands
   second (§3).
7. **Async outcomes (§2.3) — explicit markers, no `then`.** Reads are **derived**
   from `QueryView` (no new surface). For writes, **`then` is dropped entirely**:
   success is implicit statement sequencing (the next statement), every remote
   call carries a compiler-checked **`await`** (sequential) or **`spawn`**
   (fire-and-forget) marker — a bare remote call is an error — and failure is a
   per-call `onError` falling back to a block `onError` (precedence: per-call →
   block → propagate). Each `await` projects to one MVU arm; `onError` selects
   the `Failed` arm of the backend's exception-less `Result` union. The
   `Action {}` `then:` retires when that primitive becomes the Phase-4 macro. The
   marker *spelling*, and whether actions are themselves `async`/awaitable (§2.4),
   are the open items.

## 9. Remaining open items

- **Effect-marker spelling (§2.3).** `await` / `spawn` — confirm the keywords
  (vs `go`/`detach`/`void` for fire-and-forget) and the postfix `onError`
  attachment (call-level vs a wrapping form).
- **Async actions (§2.4).** Whether `async` is a required declaration keyword or
  fully inferred; whether v1 includes awaiting *async actions* (action→action)
  or defers it alongside `store`.
- **`store` lifetime/persistence** — in-memory only, or
  session/local-storage-backed? Out of scope for v1; revisit when `store`
  lands.
