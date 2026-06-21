# Async actions & effects — `await`, `spawn`, and failure

> Status: **PROPOSED (design note).** Split out of
> [`named-actions-and-stores.md`](named-actions-and-stores.md) ("Proposal A").
> This note covers how an action body invokes **remote** effects — server
> commands/queries that can succeed or fail: the explicit `await` / `spawn`
> markers, success-by-sequencing (no `then`), `onError` failure arms, and
> `async` action composition. It **depends on Proposal A, Stage 1** (named
> actions give the markers a body to live in) and supplies the async-outcome
> axis Proposal A deliberately leaves open. Nothing is implemented.
>
> **Why this is split out.** Named *sync* actions (Proposal A, Stage 1) are a
> pure, non-breaking win — they end `event_N` gensym, add a test surface, and
> need **no** change to call semantics (a remote call in a handler behaves
> exactly as it does today). The async surface here **does** change call
> semantics — a remote call must be explicitly marked — which is a breaking
> change that wants its own lint→required migration ramp. Separating them lets
> Stage 1 land clean and lets this note own the migration story.
>
> **Notation.** Examples are tagged **✅ ships today** or **🔶 proposed**. The
> `.ddd` source *and* the projected target (Elmish `update` arms) are shown
> together, per the repo's two-examples rule.

## TL;DR

A handler that invokes a remote effect today does so with an **invisible**
async boundary and no failure handling — `placeOrder(draft)` is a bare call
whose success/failure is implicit. This note makes the boundary **explicit and
compiler-checked**, the way every mainstream language does, and adds first-class
fire-and-forget:

```ddd
async action submit() {                                    // 🔶
  let order = await placeOrder(draft)  onError e => { show(e); return }  // recover or bail
  await sendReceipt(order.id)          onError e => log(e)               // best-effort, continue
  navigate(OrderConsole, { id: order.id })                              // sync; no marker
}
```

Three principles: **success is implicit sequencing** (the next statement — no
`then`); **every remote call carries an explicit `await` or `spawn`** (a bare
remote call is an error); **errors are values** — a remote op returns a
`Result` union (the backend's exception-less one), so `await op()` yields it;
`match` consumes it and **`onError` is flat sugar over that match** (per-call →
block → propagate). No `raises`/checked-exception channel. Each `await` projects
to one MVU `update` arm.

## 1. Success is implicit sequencing — there is no `then`

The success continuation of a remote call is simply **the next statement** —
exactly how a backend operation body already sequences, and how `await` works
in JS / C# / Python / Rust. Earlier drafts of Proposal A floated a statement
-level `then =>` arm; it is **dropped entirely**, because:

- it is only meaningful for async effects (sync statements sequence implicitly
  and have no outcome arm), and
- it **does not stack** — multi-step flows nest into callback-hell shape, the
  thing the ecosystem moved away from.

Implicit sequencing stacks for free (it is just statements) and binds results
with the existing `let`:

```ddd
action submit() {                                   // 🔶
  let order = await placeOrder(draft)               // await + bind the result
  await sendReceipt(order.id)                        // runs only on success of the previous
  navigate(OrderConsole, { id: order.id })           // sync
}
```

The `Action {}` render primitive's shipped success-only `then:` named arg
(`Action { order.confirm, then: navigate(...) }` — ✅) retires when that
primitive becomes the Proposal-A macro over a named action (Stage 3 below),
leaving **no `then` anywhere**.

## 2. Every remote call is explicitly marked — `await` or `spawn`

A bare remote call is rejected. Invisible suspension points are the maintenance
hazard `await`/`async` exist to prevent, so the author chooses one of two
intentful forms. Because async-ness is **decidable** from resolution (a remote
call resolves to a server `operation`; the IR carries `resourceKind`,
`loom-ir.ts:2435`), the marker is **enforced both ways** — the classic "forgot
`await`" floating-promise bug becomes a compile error:

| Form | Suspends? | Continuation | Failure |
|---|---|---|---|
| `await op()` | yes | runs **after** it resolves (MVU arm split) | `onError` recovers/bails inline |
| `spawn op()` | no | runs **immediately** (batched `Cmd`, no split) | **detached** `onError`, or dropped |
| bare `op()` (remote) | — | — | **error** — must choose `await` or `spawn` |

`spawn` is first-class fire-and-forget (analytics, telemetry, optimistic-UI
background saves). Its `onError` is *detached* — it never aborts or blocks the
continuation (which has already run); omit it and the failure is dropped (or
routed to a default telemetry sink). `let x = spawn …` is an error (nothing to
bind). Both `await` and `spawn` reify to `Cmd`s, so the action stays pure
`(state) -> (state', Cmd)` either way.

**`spawn` has no success continuation — by design.** The statement *after* a
`spawn` is the action's immediate continuation (it runs now, regardless of the
op), **not** the op's continuation. The only thing tied to the op's completion
is the detached `onError`. This maps exactly onto the Elmish combinators: bare
`spawn` → `Cmd.OfAsync.start` (dispatch on neither outcome); `spawn … onError` →
`Cmd.OfAsync.attempt` (dispatch on **failure only**); `await` → `Cmd.OfAsync.either`
(both — and its success arm *is* the next statement). The rule that falls out:
**need to react to the result → you're waiting on it → use `await`**; `spawn` is
for "don't need the result (but maybe undo on failure)." The remaining quadrant
— non-blocking *and* react to success (e.g. an autosave "saved ✓" indicator) — is
intentionally **not** designed: it would re-introduce the deleted `then`/`onError`
success-arm pair, and is added only if a concrete case ever justifies a symmetric
detached success handler.

The optimistic-update shape — no arm split, detached rollback — is the
canonical `spawn`:

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

(An `await` here would freeze the button until the server answered — exactly
what optimistic UI avoids.)

## 3. Failure — `Result` + `match` (day one); `onError` is deferred sugar

Errors are **values**, consistent with Loom's existing unions / `match` /
`T option` / `A or B` *and* the backend's exception-less Result returns. A
remote op returns its outcome as a `Result`-shaped union — the same
`Placed | Failed` union the backend emits (`exception-less.md`) — so `await op()`
*yields that union*, consumed by the ordinary `match`. **This is the entire
day-one failure surface** — it adds no error syntax beyond `await`, reusing
machinery Loom already has:

```ddd
action submit() {                                          // 🔶 day-one
  match await placeOrder(draft) {
    Placed order => navigate(OrderConsole, { id: order.id })
    Failed e     => showError(e.message)
  }
}
```

For the **single-async-op** action — the common first case — that is all you
need: one call, one `match`, no nesting.

### 3a. `onError` — deferred ergonomic sugar (not day one)

`onError` is **flat sugar over the same `match`**, and is **deferred** until real
`.ddd` files show multi-step `await` chains that nest badly (the *only*
justification — plain `match` stacks one level per step, the flaw that sank
`then`). It auto-binds the success payload and makes *the rest of the block* the
success continuation. The two forms are identical, so adding `onError` later is
**purely additive** — it desugars to the `match` above, needs no migration, and
changes no semantics:

```ddd
let order = await placeOrder(draft) onError e => { showError(e); return }   // 🔶 (Stage 2b)
navigate(OrderConsole, { id: order.id })
```

There is **no separate error system** either way — no `raises`, no
checked-exception channel. `match` for rich, multi-variant errors (day one);
`onError` for the flat binary case (deferred); both are the same `Result` arms. A
postfix `onError` attaches the failure arm to a single call; a block-level
`onError` is the catch-all. Precedence: **per-call → block → propagate** (to a
generic UI error boundary):

```ddd
action submit() {                                          // 🔶
  let order = await placeOrder(draft)  onError e => { show(e); return }  // recover or bail (early `return`)
  await sendReceipt(order.id)          onError e => log(e)               // best-effort, continue
  await audit(order.id)                                                  // falls to block onError
  navigate(OrderConsole, { id: order.id })                              // sync, no error surface
} onError e => toast(e.message)                                        // catch-all
```

After a handler runs: a `let`-bound call must recover a value of the bound type
or `return` (early-exit; actions are void, so the existing `return` statement is
the bail — no new keyword); an unbound call continues by default. The sequential
block projects to one MVU arm per `await`, `onError` selecting the `Failed` arm:

```fsharp
| Submit          -> model, Cmd.OfAsync.either Api.placeOrder draft (Ok>>Placed) (Error>>PlaceFailed)
| Placed (Ok ord) -> { model with Order=ord }, Cmd.OfAsync.either (Api.sendReceipt ord.Id) () (Ok>>Receipted) (Error>>ReceiptFailed)
| PlaceFailed e   -> model, Cmd.ofMsg (Show e)          // return — no continuation enqueued
| ReceiptFailed e -> model, Cmd.ofMsg (Log e)           // best-effort — continuation still runs
| Receipted _     -> model, Cmd.OfAsync.either (Api.audit ord.Id) () (Ok>>Done) (Error>>Failed)
```

Per-surface effect scoping (Proposal A §3.2) applies to `await`/`spawn`/`onError`
unchanged: a **store** action may `await` a remote op and recover *store* state
in `onError`, but still may not `navigate`/`toast` (view-scoped) — the calling
page owns the redirect.

## 4. Async actions — `async`, awaiting actions, the interface

If an action (transitively) `await`s a remote op, it has a suspension point and
an eventual completion — it is **async**.

**`async` is inferred but REQUIRED and checked.** The compiler can *infer*
async-ness (it is decidable), but by the same "explicit at the boundary"
principle that justifies `await`, the **declaration must carry `async`** so a
caller reads the contract from the signature alone — and the compiler enforces
the keyword matches the body (missing `async` on an awaiting body → error;
spurious `async` on a sync body → error), mirroring missing/spurious `await`.
(During migration this enforcement lands as a **lint warning** first, then flips
to **error** — see Stage 4.)

```ddd
action       next()      { step := step + 1 }                           // sync
async action checkout()  { await placeOrder(draft); navigate(Receipt) }  // body awaits ⇒ `async` required
```

**Awaiting an action is the same discipline as awaiting an op.** An async action
is itself `await`/`spawn`-able; a sync one is bare-called (Proposal A §3.1
already allows action→action / page→store calls — this extends the §2 marker
rule to async callees). Async-ness propagates transitively up the (acyclic,
Proposal A §8.4) call graph, so the inference is well-founded:

```ddd
async action confirm() {                                     // 🔶
  await checkout()           // awaiting another ASYNC action — sequences after it completes
  Cart.clear()               // sync store action — bare call (unchanged)
}
```

**The action interface — and what it omits.** Proposal A §2.2 framed an action's
interface as *state surface + payload param*. Async-ness adds one facet;
notably it adds **no return value**:

| Interface facet | Owner | Checked at call site |
|---|---|---|
| payload param | call-site primitive | supplied value assignable to param |
| `async` | the body (inferred → declared → checked) | marker (`await`/`spawn`) matches |
| **return value** | — none — | actions are *transitions*, not functions |

An action returns **nothing bindable** — it is a `(state, payload) -> (state',
Cmd)` transition. `await checkout()` *sequences* but yields no value;
`let x = await checkout()` is an error. To get a value back, `await` the remote
**op** directly (ops return their `Result` — `let order = await placeOrder(draft)`)
or read shared `store` state. Keeping actions value-less preserves the MVU
projection: an action is a `Msg` (payload *in*, no value *out*); a
value-returning action would be a general async function and break the
`update`-arm shape.

**Action failure is handled internally — not propagated.** Because `Result` is
the only error model (no `raises`), and an action has no return value to carry a
`Result`, an action is **infallible from its caller's view**: it handles its
own op failures inline (the failing thing is a leaf op, `onError`/`match`-ed
right there — the common case), or it signals failure as **error state**
(`error := e`) the caller reads (errors-as-state, the MVU-native form). So
`onError` on an *action* call is spurious — only a remote *op* call is fallible.
This keeps one error idiom: ops return `Result`; actions reduce it to state.

## 5. Backend symmetry — one `Result` contract, two lowerings

The `placeOrder` *operation* these calls hit is unchanged and `await`-free — a
straight-line body (I/O at the transaction boundary, not in the body) ending in
the exception-less `Result` union (`return Placed(...)` / `return Failed(...)`,
`dotnet/render-stmt.ts:113-135`, `exception-less.md`). The frontend's
`await … onError` **consumes** exactly that union — backend produces the
`Failed` variant, frontend binds it. Two ends of one `Result<T,E>` contract:
one neutral statement IR, two lowerings (straight-line transaction vs MVU arms).
This is why the async surface is frontend-only — the backend already sequences
implicitly and signals failure by return/rollback; there is nothing to mark.

## 6. Validator rules

- `loom.missing-effect-marker` — a remote call (op **or** async action) that is
  neither `await` nor `spawn` → error (lint-warning during the Stage-2/4 ramp).
- `loom.spurious-effect-marker` — `await`/`spawn` on a local call / value-object
  ctor / pure `function` / sync action → error.
- `loom.bind-on-spawn` — `let x = spawn …` → error.
- `loom.bind-on-action` — `let x = await <action>()` (actions have no return) →
  error.
- `loom.spurious-onerror` — `onError` on anything but a remote **op** call (the
  only fallible call) — e.g. on an action call or a local call → error (§4).
- `loom.missing-async` / `loom.spurious-async` — `async` keyword must match the
  body (§4) → error (lint-warning during the Stage-4 ramp).

## 7. Staging (this proposal) — see Proposal A for the whole-initiative rollout

This note is **Stages 2–4** of the rollout in
[`named-actions-and-stores.md` → Rollout](named-actions-and-stores.md#rollout--the-whole-initiative).
Internally, the **minimum first cut is just `await` + `match`** — everything
else is additive sugar/capability, added only when real `.ddd` files show the
need:

1. **`await` + `match` (lint)** — add only the `await` marker (grammar, IR,
   lower, `WalkerTarget` await-lowering seam); `await op()` becomes an expression
   yielding the op's `Result` union, consumed by the **existing** `match`. No
   `onError`, no `spawn`. A bare remote call is a **warning**; ship a codemod
   (bare remote call → `await`).
2. **`await` required** — flip `loom.missing-effect-marker` /
   `loom.spurious-effect-marker` to **error** once the codemod has run. Every
   remote call is now explicitly `await`-marked and its `Result` handled by
   `match`.
3. **`onError` sugar + `spawn`** *(deferred — add when patterns demand it)* — the
   `onError` postfix/block sugar over `match` (§3a), and `spawn` for
   fire-and-forget/optimistic UI (§2), with `loom.bind-on-spawn` /
   `loom.spurious-onerror`. Purely additive — `onError` desugars to step-1
   `match`, so this breaks nothing.
4. **`async` actions** — the `async` keyword + transitive inference +
   action→action awaiting (`loom.*-async` lint → error, same ramp).

Each step is independently shippable: step 1 makes async *visible* with zero new
error syntax; step 2 makes it *enforced*; step 3 adds *ergonomics* once justified;
step 4 makes it *composable*.

## 8. Decisions & open items

**Settled (this note):** no `then` (success = implicit sequencing); explicit
`await` marker, enforced both ways; **errors are values — `Result` is the
foundation** (a remote op returns the backend's exception-less `Result` union;
`await op()` yields it, consumed by the **existing `match`**); **no
`raises`/checked-exception channel**; actions have no return value and are
infallible from the caller (they handle op failures internally or reduce them to
error state); **`async` is required and checked** (via a lint→error ramp).

**Deferred — designed, but not in the first cut** (added only when real `.ddd`
shows the need; both are non-breaking, additive):
- **`onError` sugar** — flat per-call/block sugar over `match` (§3a); justified
  only by multi-step `await` chains that nest. Desugars to step-1 `match`.
- **`spawn`** — fire-and-forget for optimistic-UI/telemetry (§2); a distinct
  capability, deferred until those patterns appear.

**Open:**
- **Keyword spelling.** `await` / `spawn` — confirm vs alternatives
  (`go`/`detach`/`void` for fire-and-forget); and the postfix `onError`
  attachment (call-level vs a wrapping form).
- **Async action→action awaiting in v1** — ship in Stage 4, or defer alongside
  `store` if it proves to interact with store lifetime.
- **Default failure sink** — what an unhandled `spawn` failure and a
  fully-unhandled `await` (no per-call, no block `onError`) route to (a generic
  toast/error-boundary vs a hard requirement to handle).
