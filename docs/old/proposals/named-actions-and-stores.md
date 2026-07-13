# Named actions (and stores) — first-class page transitions

> Status: **PARTIAL — Stage 1 (named sync actions) + Stage 5 (`store`) SHIPPED**
> (2026-07 code-verified against `main`). The store-less page/component `action`
> surface (grammar `ActionDecl`, `ActionIR`, lowering with `onSubmit: <name>` →
> typed `action-ref` resolution, the purity + payload-conformance validators
> `loom.action-payload-mismatch`/`loom.unresolved-action-ref`, and the
> `event_N`-gensym-replacing hoist on all four JS frontends + Phoenix HEEx) is
> live, with per-target `named-actions.test.ts`. `store` (Stage 5) shipped too —
> **in-memory only**; the `persist:`/`sync:` lifetimes remain grammar-reserved and
> gated (`loom.store-lifetime-unsupported`, owned by
> [`frontend-state-management.md`](frontend-state-management.md)). **Remaining:
> Stages 2–4** (`await`/`match`, retire `Action {}` `then:`, `async` composition)
> — the async surface in [`async-actions-and-effects.md`](async-actions-and-effects.md),
> still unstarted and actively gated by `loom.action-requires-await` (an action
> body currently cannot inline a remote mutating command). Core decisions §8 are
> ratified. This note argues for giving page/component event handlers
> *names* — turning today's anonymous handler lambdas into declared, typed
> `action`s whose purity is an **enforced invariant** (not the authoring
> mental model) — and for an optional `store` declaration that bundles shared
> state with the actions that transition it. It catalogues the design space,
> recommends one shape, sketches the pipeline work against the real code, and
> closes with why this is the prerequisite that turns a hypothetical
> Fable/Feliz/Elmish target from "synthesis" into "projection." The decisions
> in §8 are settled (keyword, purity boundary, effect-vocabulary scoping,
> composition, store deferral); the **async-effect surface** (`await`/`spawn`,
> `onError`, `async` actions) is split into its own note,
> [`async-actions-and-effects.md`](async-actions-and-effects.md) ("Proposal B"),
> because it changes call semantics and wants its own migration ramp. Keyword
> spelling and `store` persistence are now settled (§9 — default in-memory,
> persistence a deferred opt-in). The full phased plan across both notes is in
> [Rollout](#rollout--the-whole-initiative).
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
> (`then:`, read via `namedArgValue`, `controls.ts:194`); the async-effect
> surface (Proposal B) **drops `then` entirely** in favour of explicit
> `await`/`spawn` markers + `onError`, and the `Action {}` `then:` retires when
> that primitive becomes the macro over named actions; (3) there is **no nullary
> `() =>` lambda** — the
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
✅ today. The one **🔶 statement-level addition** is the remote-call marker
`await` (§2.3); a *remote* call may not be bare, and its `Result` is consumed by
the existing `match` (`onError` sugar and `spawn` are deferred — Proposal B).
(`toast(…)` is *not* yet a general body call either — it ships only in live-event
`on` handlers; admitting it here is 🔶, see §3.2.)

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

### 2.3 Effectful calls and outcomes — split into a separate proposal

How an action invokes a **remote** effect (a server command/query that can
succeed or fail) — the explicit `await` / `spawn` markers, success-by-sequencing
(no `then`), `onError` failure arms, and `async` action composition — is its own
note: [`async-actions-and-effects.md`](async-actions-and-effects.md)
("Proposal B"). It was split out because it **changes call semantics** (a remote
call must be marked) and so wants its own lint→required migration ramp, whereas
*this* note's named sync actions are a non-breaking addition.

**In this note's scope (sync named actions), the two outcome directions are:**

- **Reads (server state / queries) — derived, no new surface.**
  `QueryView { of: api.Order.byId(id), loading: …, error: …, data: … }` already
  carries the endpoint, the wire shape, *and* the three branches
  (`Idle | Loading | Loaded of T | Failed of E`). The generator **derives** the
  remote-data union + load `Cmd` + outcome `Msg`; no DSL change.

- **Writes (commands with an outcome) — Proposal B.** Until Proposal B's markers
  land, a remote call inside an action behaves exactly as a handler call does
  today (implicit, unmarked). Proposal B then makes the async boundary explicit
  and enforced. The one-line summary of what it settles: success is implicit
  statement sequencing (no `then`); every remote call carries the explicit
  `await` marker; **errors are values** — ops return a `Result` union consumed by
  the existing `match` (no `raises`); actions have no return value (they handle
  errors internally or reduce them to state); `async` is a required, checked
  declaration keyword. The `onError` sugar and `spawn` are **deferred, additive**
  ergonomics (added only when multi-step chains / optimistic UI demand them).

## 3. The sharing boundary: `store` (optional extension)

> **The `store` keyword itself is owned by
> [`frontend-state-management.md`](frontend-state-management.md)** — that note
> designs the keyword, the **lifetime ladder** (`store` in-memory default ·
> `store … persist: local|session` · `store … sync: url`), the grammar
> (`StoreLifetime`), and the full per-frontend × per-lifetime lowering matrix
> (incl. the LiveView server-side wrinkle). *This* note adds only **named
> actions over store state**; treat the two as one feature split by concern
> (container/lifetime there, named transitions here). The persistence question
> in §9 is answered there, not re-litigated here.

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

page CartPage {                              // 🔶 store/use/action ✅; await/onError → Proposal B
  use Cart
  async action confirm() {
    await placeOrder(Cart.lines) onError e => showError(e.message)   // await/onError: async-actions-and-effects.md
    Cart.clear()                                       // sync store action — call (this note)
    navigate(OrderConsole, { id: ... })                // page owns the redirect (view-scoped effect)
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
converts the Elmish target from a synthesis problem into a projection — the full
gap analysis is [`fable-elmish-frontend.md`](fable-elmish-frontend.md), which
names this note as its prerequisite.

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
7. **Reads are derived; writes are Proposal B.** Query/read outcomes are
   **derived** from `QueryView` (no new surface). The async-*write* surface
   (`await`/`spawn`, `onError`, `async` actions) is settled in
   [Proposal B](async-actions-and-effects.md) — the only decision recorded here
   is that it is a **separate, post-Stage-1** body of work, because it changes
   call semantics and carries its own lint→required migration ramp.

## 9. Remaining open items

- **`store` lifetime/persistence — owned by
  [`frontend-state-management.md`](frontend-state-management.md), not open here.**
  That note's **lifetime ladder** already answers it: default **in-memory**
  (session-volatile — Zustand/Pinia module store / global Elmish program), with
  `persist: local|session` and `sync: url` as opt-in longer lifetimes, and a
  per-frontend lowering matrix (incl. the LiveView server-side-session wrinkle).
  Named actions (this note) sit on top of whichever lifetime a store declares.
- Remaining async-effect open items (async-action awaiting timing, default
  failure sink) live in [Proposal B §8](async-actions-and-effects.md). Keyword
  spelling is **settled** (`action`/`store`/`use`/`await`/`spawn`/`attempt`/
  `async`/`onError`).

## Rollout — the whole initiative

Five stages spanning both notes. Each is independently shippable and leaves the
system in a **coherent, improved** state — never a half-built bridge.

| Stage | What lands | Note | Breaking? | The system after |
|---|---|---|---|---|
| **1. Named sync actions** | `action name(p){…}` in page/component: grammar, `ActionIR`, lower, validator (purity + payload conformance), generators replace the `event_N` gensym with the action name. Remote calls behave **exactly as today** (unmarked). | A (§2, §5) | **No** — pure addition | Handlers are named & testable; gensym gone. |
| **2. `await` + `match`** | Just the `await` marker; `await op()` yields the op's `Result` union, consumed by the **existing `match`**. No new error syntax. Lint-first (bare remote call = warning + codemod), then required. | B (Stages 1–2) | Yes, via ramp | Async boundary visible & enforced; failures handled via `match`. |
| **3. Retire `Action {}` `then:`** | Rewrite the `Action {}` render primitive as a macro over a named action with an `await`-sequenced body; remove the `then:` named arg. | B (cleanup) | Macro keeps surface | **One** continuation model — no `then` anywhere. |
| **4. Async action composition** | `async` keyword (lint → required), transitive inference, action→action awaiting. | B (Stage 4) | Yes, via ramp | Async flows compose across actions. |
| **5. `store`** | Shared/persistent state + store actions (async store actions already work from Stages 2/4). | A (§3) | No | Cross-page sharing; Zustand/Pinia emission. |
| **— `onError` sugar + `spawn`** *(deferred)* | `onError` flat sugar over `match` (added when multi-step `await` chains nest); `spawn` fire-and-forget (added for optimistic UI/telemetry). Both additive — desugar to / sit beside Stage 2. | B (Stage 3) | No — additive | Ergonomic happy-path + optimistic UI, once justified. |

**Ordering rationale.** Stage 1 is the non-breaking foundation everything builds
on. Stage 2 makes async *explicit* with the **smallest possible surface** —
`await` + the `match` Loom already has, no `onError`/`spawn` yet. Stage 3 follows
so the legacy `then:` dies before more async surface accretes (avoids two
continuation models coexisting). Stage 4 extends the markers to action
composition. Stage 5 (`store`) depends only on Stage 1 and can be pulled earlier
if sharing is prioritised. The `onError` sugar and `spawn` are **deferred and
additive** — slotted in whenever real `.ddd` shows nesting pain / optimistic
patterns, with no migration cost.

**Enabled, separate initiative:** the Fable/Feliz/Elmish target (§7). Stages 1–4
turn its `Msg`/`update` emission from synthesis into projection; it is tracked in
the gap analysis alongside these notes, not scheduled here.

**Parallel, cross-cutting track:** global error handling — the frontend error
boundary + backend error handler that anything unhandled propagates to — is its
own note, [`error-handling-and-failure-sink.md`](error-handling-and-failure-sink.md)
("Proposal C"). It is largely independent of the actions/async stages (the
backend sink exists regardless of actions) and ships defaults-first.
