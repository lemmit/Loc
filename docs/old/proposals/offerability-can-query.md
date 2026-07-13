# Offerability projection — teaching `can_<op>` about authorization

> **Status:** Design proposal (no implementation yet). Captures a design
> discussion, not shipped behaviour.
> **Relates to:** [`authorization.md`](./authorization.md) (the `policy {}`
> proposal this extends), [`../auth.md`](../../auth.md) and
> [`../criterion.md`](../../criterion.md) (the shipped `requires` / `when` gates).
> **Scope:** all domain-logic backends that emit the `can_<op>` companion
> (Hono + .NET today; the projection follows wherever `when` is supported).

---

## 1. The four gates, and why this is about exactly one seam

Loom guards an operation with four bool clauses that look mechanically alike
(`if (!expr) throw …`) but sit on different axes and map to different HTTP
statuses. The distinction is deliberate — a client reacts differently to each:

| Clause | Question | Status | Where it runs | Queryable ahead of time? |
|---|---|---|---|---|
| `requires` | **who** — is this caller allowed? | 403 | domain method (first) | **no** (today) |
| `when` | **state** — is this command offerable in the current state? | 409 | route, before the call, **+ `can_<op>`** | **yes** — that's `can_<op>` |
| `precondition` | **args/state** — are these arguments valid? | 400 | domain method | no (needs the args) |
| `invariant` | **always** — structural truth re-asserted post-mutation | 400 | domain method (after) | no |

Honest grading (the reason this doc exists):

- `when` and `invariant` earn their own keyword on **mechanics** alone.
- `precondition` is the baseline domain-validity check.
- **`requires` is the weakest distinction.** Mechanically it is `precondition`
  that throws 403 instead of 400. Its justification is *metadata*: it tags a
  check as authorization so the toolchain can (a) enforce `denyByDefault`
  coverage ([`system-checks.ts`](../../../src/ir/validate/checks/system-checks.ts))
  and (b) hoist it into `policy {}` (the [authorization proposal](./authorization.md)).

The seam this doc is about: **`when` is projected to the client as a
pre-flight query (`can_<op>`); `requires` is not.** So a UI greys a button on
*state* but not on *permission* — the user clicks an action they're forbidden
from and only learns via a 403. That asymmetry is the gap.

## 2. Today

```ts
// GET /{id}/can_close  — emitted ONLY because the op has a `when`
return c.json({ allowed: aggregate.status === TicketStatus.Open }, 200);
```

- Emitted **iff** the op declares a `when`. A `requires`/permission gate alone
  produces no `can_` endpoint.
- Body is the `when` predicate only — **state**, no actor. `currentUser` /
  `permissions` aren't even in scope: `when` type-checks in the bare aggregate
  env (`envForAggregate`,
  [`validators/statements.ts`](../../../src/language/validators/statements.ts)),
  the same env class as an `invariant`.
- Returns a **bare `{ allowed }`** — no reason.

## 3. Proposed end state — project the param-free authorization too

`can_<op>` should answer "is this command offerable **to me**, on this row, in
this state?" — i.e. AND the **param-free** slice of the authorization gate into
the existing state predicate.

```ts
GET /{id}/can_close → {
  allowed: status === Open                                  // when (state)        → 409 live
        && currentUser.permissions.includes("orders.close") // requires/policy authz → 403 live
        && row.dataKey.rootTenant === currentUser.dataKey.rootTenant, // tenant floor
  reason: "forbidden" | "conflict" | null,                  // which axis said no
  pendingValidation: true                                   // args still validated on submit
}
```

### 3.1 The projectability rule (param-free vs param-dependent)

Only the **param-free** part of any gate is projectable — it is exactly the
rule that already makes `when` projectable and `precondition` not. Partition a
`policy { allow execute on Order.FulfillLine { … } }` block (or an inline
`requires`) by its [declared scope](./authorization.md#target-decides-scope):

- **param-free** clauses — `isManager()`, `isOwner()` (→ `currentUser.id ==
  resource.ownerId`), `permissions.contains(…)`, tenant floor. Need only
  `currentUser` + the loaded `resource`. **Answerable before the call → project.**
- **param-dependent** clauses — `qty > 0`, `canFulfill(order)`. Need the call's
  arguments. **Not projectable** — they stay a submit-time check (and `qty > 0`
  is really a `precondition` in disguise).

### 3.2 Emit-when rule generalizes

| Op has | `can_<op>` emitted? | Body |
|---|---|---|
| `when` only | yes | `{ allowed: <state> }` |
| param-free authz gate only | **yes (new)** | `{ allowed: <authz> }` |
| both | yes | `{ allowed: <state> && <authz> }` |
| only param-dependent clauses | no | nothing answerable pre-call |
| neither | no | — |

The trigger moves from "has a `when`" to "has **any** param-free offerability
predicate (`when` or projectable `policy`/`requires` clause)."

### 3.3 Return a reason, not a bare bool

`{ allowed }` collapses 403 and 409 into one bit and loses *why*. Return
`{ allowed, reason }` (and `pendingValidation` for the param-dependent
remainder) so the UI can show "you don't have permission" vs "not in this
state" — without changing the **live** `POST`, which still throws the distinct
403 / 409 / 400. **The projection is additive and advisory; it never replaces
the authoritative per-axis failure.**

## 4. Prior art — NakedObjects / Restful Objects got here first

This is not novel; it is the [Naked Objects](https://en.wikipedia.org/wiki/Naked_objects)
convention, which Loom's `when` comment already nods to ("NakedObjects-style
split"). Each action carries up to three auto-projected supporting hooks:

| NakedObjects hook | Returns | Controls | Loom analogue |
|---|---|---|---|
| `Hide<X>()` | bool | **visibility** — show the action at all | *(no equivalent today)* |
| `Disable<X>()` | **reason string** (null = enabled) | **usability** — greyed-out + tooltip | `when` → `can_<op>` |
| `Validate<X>(p)` | **reason string** (null = valid) | per-invocation **arg validation** | `precondition` |

Two confirmations for the design above
([InfoQ RAD article](https://www.infoq.com/articles/RAD-Naked-Objects/),
[nakedobjects.org §37](http://www.nakedobjects.org/book/section37.html)):

1. **`Disable` returns a reason string**, surfaced as a tooltip — i.e. the
   `{ allowed, reason }` of §3.3, never a bare bool.
2. **Authorization folds into "usable."** Role auth is a separate mechanism
   (`IAuthorizer` with `IsVisible` / `IsUsable`), but it feeds the *same*
   per-member visible/usable answer the UI consumes — so permission state and
   domain state collapse into one projected verdict. That is precisely §3's
   "teach `can_` about permissions."

The one thing NakedObjects splits that Loom does **not**: **Hide (visibility)
vs Disable (enablement)**. Loom has only the enablement axis. If `can_` grows
up, that becomes a real choice (grey-out-with-reason vs hide-entirely); see
Open questions.

## 5. Relationship to `policy {}`

This is the **write-side symmetric completion** of a projection the
[authorization proposal already accepts on the read side](./authorization.md#5-field-rules):
field masking is projected to the client as `fieldCapabilities` (§10 of that
doc: React "consumes redacted wire shape + optional view `fieldCapabilities`").

- `fieldCapabilities` : "may I **see** this column?"
- `can_<op>` (projected) : "may I **run** this command?"

Once `requires` relocates into `policy {}`, its param-free clauses are the
natural source for the `can_` authz term. So no new authorization machinery —
`can_` reads the same gate the live `POST` enforces, minus the params.

## 6. Open questions

- **Hide vs Disable.** Add a visibility axis (omit the action from a
  capabilities manifest entirely) or keep only grey-out-with-reason? NakedObjects
  has both; Loom has neither cleanly.
- **Endpoint shape by scope.** Execute gates reference `resource` → per-id
  (`/{id}/can_<op>`). Workflow gates have [no resource](./authorization.md#target-decides-scope)
  → per-user (`/can_<workflow>`). Two shapes.
- **Caching.** `when`'s `can_` is resource-relative (cacheable per id). Adding
  `currentUser` makes it actor-relative → `Vary` by auth, no shared cache.
- **Intuitiveness.** The param-free/param-dependent split decides whether the
  endpoint even exists — silent and subtle. Mitigation: emit `can_` for **any**
  gated op and always return the same `{ allowed, reason, pendingValidation }`
  shape, so its presence never depends on a property the author didn't state.
- **Backends.** Mirrors `when` support (Hono + .NET; gated on elixir via
  `loom.when-unsupported`).

## 7. Non-goals

- Changing the **live** request semantics. The authoritative `POST` keeps the
  distinct 403 / 409 / 400 per axis; this is a pre-flight advisory projection only.
- Removing any of the four gates. Only `requires` relocates (into `policy {}`);
  `when` / `precondition` / `invariant` stay where they are.
- A client-side authorization engine. The projection is computed server-side
  from the same gates; the client only renders the verdict.
