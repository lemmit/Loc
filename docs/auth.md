# Auth, `currentUser`, and permissions

Loom systems can declare a strongly-typed JWT claim shape at system
scope and opt deployables in to JWT-decode middleware per request.
Modules can declare a typed permission catalogue used to gate
command entry from inside operation / workflow bodies.  Repository
finds can reference `currentUser` to scope query
results to the requester.

Shipped over four slices:

- **Slice 1A** — `user { ... }` + `currentUser` magic identifier +
  per-deployable `auth: required` middleware + verifier hook.
- **Slice 1B** — per-subdomain `permissions { ... }` block +
  `permissions.<name>` magic identifier resolving to a stable
  `<subdomain>.<name>` runtime string + the `.contains(x)` collection
  op for ergonomic claim membership checks.
- **Slice 1C** — `currentUser` admissible inside repository find
  `where` filters; the renderer threads the resolved user
  through as a closure-captured parameter on the generated method.
- **Slice 2**  — `requires <expr>` statement: a declarative
  authorization gate that maps to HTTP 403, distinct from
  `precondition` (which maps to 422 — RS-15).

**Default-deny enforcement** is opt-in via
`auth { enforcement: denyByDefault }` (the language default stays `opt`,
which preserves the per-`requires` behaviour — the default-flip to
`denyByDefault` is deferred to a major version).  **Deny-by-default is the
recommended posture** for anything security-sensitive, and `ddd new`'s
scaffold points at it.  Under `denyByDefault`, every **client-reachable
command AND read** on an `auth: required` deployable must declare a
`requires` gate — `requires true` is the explicit "intentionally public"
escape — else `loom.default-deny-ungated` fires.  Covered:

- public aggregate **operations, creates, and destroys** (each carries
  `requires` in its body);
- **workflows** — every command-triggered `create … {}` starter and named
  `handle …(){}` continuation (event-triggered creates and `on(...)`
  reactors are not client-reachable, so they are excluded);
- **repository `find`s** — the same optional `requires` gate (see
  [Find gates](#find-requires-gates) below).  The auto-injected `find all`
  list route is the one exception: it is compiler-synthesized with no author
  source line, so it is out of default-deny scope.  Declaring an explicit
  `find all(): T[] requires <expr>` gates that route, and does so on **all
  five** backends — node/Hono and .NET emit a route per repository find and so
  always honoured it, while java, python and elixir each special-case `all` out
  of their named-find loop and used to emit the list route without reading its
  gate.  All five now resolve the list read through one shared derivation
  (`src/ir/util/read-gates.ts`).
- **`projection`s — both kinds** — the same optional `requires` gate, declared
  on the projection HEADER (`projection X keyed by k requires <expr> { … }`,
  after `keyed by`, like every other gate in the language), evaluated against
  `currentUser` before the read; failure → 403.  It is the projection twin of
  the find gate, currentUser-only (a source-row reference is rejected by
  `loom.projection-gate-not-current-user`), and it enforces on all five
  backends:
  - a **query-time** projection gates its comprehension route
    (`GET /projections/<p>`), 403 before the query runs;
  - a **folded** (materialized) projection gates BOTH read-model routes
    (`GET /projections/<p>` and `GET /projections/<p>/{key}`), 403 before the
    lookup — so a denied caller cannot distinguish "forbidden" from "no such
    key".

  A folded projection used to be unable to carry a gate at all: the keyword
  lived inside the query-clause fragment, which a folded projection has none
  of, and `loom.projection-gate-without-source` rejected the combination.  Both
  halves are fixed and that diagnostic is gone.

What's intentionally **not** here yet:

- Workflow bodies calling currentUser-bound finds — the validator
  currently rejects this with a pointer at `getById` or moving the
  call out to the route layer.

## Surface

```ddd
system Acme {
  user {
    id: string
    role: string
    permissions: string[]          // populated by the verifier hook from JWT claims
    customerId: Customer id?
    tenantId: string
  }

  subdomain Sales {
    permissions {
      ordersConfirm,
      ordersCancel,
      ordersRead
    }

    context Orders {
      enum OrderStatus { Draft, Confirmed, Cancelled }

      aggregate Order {
        customerId: Customer id
        status: OrderStatus

        // currentUser is in scope inside operation bodies.  The
        // precondition runs per request; failure throws
        // DomainException → 422 from the framework filter.
        // permissions.ordersCancel lowers to the literal
        // "sales.ordersCancel" so the runtime check reduces to
        // a plain string-array .includes(...) on the verified
        // claim payload.
        operation cancel() {
          precondition currentUser.role == "manager"
                    || (currentUser.customerId == this.customerId
                        && currentUser.permissions.contains(permissions.ordersCancel))
          status := Cancelled
        }
      }

      repository Orders for Order { }
    }
  }

  // Per-deployable opt-in.  Without `auth: required` the deployable
  // stays open (existing behaviour).
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }

  deployable api {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 8080
    auth: required
  }
}
```

### Computed principal members — `orgPath`, `rootOrg`

Beyond the declared `user { … }` claim fields, `currentUser` carries two
computed members under multi-tenancy (Phase 2):

| Member | Type | Meaning |
| --- | --- | --- |
| `currentUser.orgPath` | `string` | The caller org's materialized path in the tenant registry tree (`root.child.grandchild`). Under flat tenancy it equals the tenant claim; under a hierarchy (`implements tenantRegistry`) each backend resolves it from the registry per request, memoized. |
| `currentUser.rootOrg` | `string` | The first segment of `orgPath` — a pure string derivation, no DB read. Anchors the `global` read level's subtree widening. |

Both are fail-closed: referencing either without a `tenancy by`
declaration is a validation error (`loom.orgpath-without-tenancy`).
Full semantics, per-backend seams, and the `policy {}` read ladder they
feed live in [tenancy.md](tenancy.md).

### Permissions surface

`permissions { ... }` lives at subdomain scope; each declared name
becomes a typed identifier (`permissions.<name>`) usable in any
expression body that resolves through the enclosing subdomain.  The
identifier lowers to a plain string literal of the form
`<lowercase-subdomain>.<name>` — `permissions.ordersCancel` inside
`subdomain Sales` becomes `"sales.ordersCancel"` everywhere it
appears.  Backends never see a separate `Permission` type; the
runtime is `string[].includes(string)` either side of the wire.

Multiple `permissions { ... }` blocks in the same subdomain merge
their declarations.  Cross-subdomain references aren't supported in
slice 1B — referencing a permission declared in another subdomain
shows up as the same "no permission named 'X'" diagnostic as a
typo.

#### `implies` — permission grant hierarchy (authorization.md §6)

A permission may declare that holding it transitively **grants** one or more
others.  Single target omits the brackets; multiple targets require them:

```ddd
permissions {
  read,
  edit   implies read,        // holding `edit` grants `read`
  approve implies edit,       // … and `approve` grants `edit` (so also `read`)
  admin  implies [read, edit] // fan-out
}
```

The transitive closure is **precomputed at lowering**; the runtime check stays a
flat membership test.  A gate `currentUser.permissions.contains(permissions.read)`
expands to an OR over `read` plus every permission that (transitively) implies
it, so a caller holding `approve` or `edit` satisfies the `read` gate without the
token carrying `read`:

```ts
// generated (Hono) — `read` gate on the `edit implies read`, `approve implies edit` catalogue
if (!((currentUser.permissions).includes("m.read")
   || (currentUser.permissions).includes("m.approve")
   || (currentUser.permissions).includes("m.edit"))) throw new ForbiddenError("Forbidden: …");
```

| Diagnostic | When |
| --- | --- |
| `loom.permission-implies-unknown` | an `implies` target names no permission declared in the subdomain |
| `loom.permission-implies-self` | a permission `implies` itself (a no-op) |

A mutual-implication cycle (`a implies b`, `b implies a`) is **allowed** — the
two simply grant each other; the closure computation is cycle-safe.

#### Policy decision-id (audit seam)

Every authorization gate has a stable, deterministic **decision-id**
(`policyDecisionId(qualifiedTarget, gateSource)` → `pd_<8-hex>`), derived purely
from the gate's identity so an audit entry can reference *which* decision
authorised an action and still resolve after a regeneration.  Gates are already
IR-inspectable (each `requires` lowers to a `requires` StmtIR carrying its
`source`), so the id is **derived on demand**, not stamped.  Its consumer — the
strict-tier `AuditRecord.policyDecisionId` — lands with the audit-promotion
mission; the stable formula is the seam that mission plugs into.

### `.contains(x)` on arrays

Slice 1B introduces `.contains(x)` as a collection op (joining
`count`, `sum`, `all`, `any`, `where`, `first`, `firstOrNull`):

| Backend | Renders to |
| --- | --- |
| TypeScript | `array.includes(value)` |
| C# / .NET | `array.Contains(value)` (LINQ) |
| Python | `value in array` |
| Java | `array.contains(value)` |
| Elixir | `value in array` |

It's available on any array — not just `currentUser.permissions`
— so the same vocabulary covers any membership check the domain
needs.

### Row-level visibility (slice 1C)

`currentUser` is admissible inside repository find
`where` clauses; the renderer threads the resolved User through
the generated method as a closure-captured parameter:

```ddd
repository Orders for Order {
  find mine(): Order[] where customerId == currentUser.customerId
}
```

What gets emitted:

| Backend | Repo method signature | Caller threads user via |
| --- | --- | --- |
| .NET   | `Task<...> Mine(User currentUser, CancellationToken ct)` | Mediator handler injects `ICurrentUserAccessor`, calls `_repo.Mine(_currentUser.User, ct)` |
| Hono   | `async mine(currentUser: User): Promise<Order[]>` | Route reads `c.get("currentUser")` and passes it in |

The Drizzle / EF predicate translates `currentUser.customerId`
into a closure-captured value — Drizzle parametrises it into the
SQL bind, EF lifts it via Linq-to-Entities — so no string
interpolation hits the SQL surface.

Slice 1C does **not** yet support workflow bodies calling such
finds; the validator points users at `getById` (with an explicit
id parameter) or asks them to call the user-aware find from the
route layer.

### `requires` clauses (slice 2)

`requires <expr>` is a declarative authorization gate at the top
of an operation or workflow body.  Failure surfaces as HTTP 403,
distinct from `precondition`'s 422 — the two are deliberately
separate so domain validity (state) and authorization (caller)
don't share an error class:

```ddd
operation cancel() {
  requires currentUser.role == "manager"
        || currentUser.permissions.contains(permissions.ordersCancel)
  precondition status != "cancelled"
  status := Cancelled
}
```

| Statement | Maps to | Failure means |
| --- | --- | --- |
| `precondition` | HTTP 422 (`DomainException` / `DomainError`) | The request is well-formed but the aggregate state is invalid for this op (RFC 9110 §15.5.21; see RS-15 in `conformance-semantics.md`).  400 is reserved for a genuinely malformed body. |
| `requires`     | HTTP 403 (`ForbiddenException` / `ForbiddenError`) | The caller isn't authorized to invoke this op. |

Both type-check to `bool` and may reference `currentUser`,
`permissions.<name>`, parameters, `this.<field>`, and any
declared `function`.  `requires` is admissible in workflow
bodies too; the workflow handler / route handler maps it to 403
the same way as the operation route does.

#### Header `requires` clause (authorization.md §11.3)

The gate can also ride the **declaration header** — the write-side twin of the
find `requires` gate.  It relocates the authorization decision out of the
body onto the signature, and is exactly equivalent to a first-body `requires`
statement (same 403, same pre-body evaluation, same scope):

```ddd
// header form — reads as part of the signature
operation cancel() requires currentUser.role == "manager" {
  precondition status != "cancelled"
  status := Cancelled
}

// workflow starter / command handler carry it too
workflow Fulfil {
  create open(ref: string) requires currentUser.role == "ops" { … }
  handle retry(order: Order id) requires currentUser.role == "agent" { … }
}
```

On an operation it sits after the return type and before `when`; it is evaluated
**post-load** (against the loaded `this` instance), so it may reference the
resource, the operation params, and `currentUser`.  A header gate and a first-body
`requires` are the same thing by the time a backend sees them — lowering prepends
the header form to the body as a synthetic `requires` statement — so both emit the
identical guard.

#### Where the guard lands

The gate is **not** domain logic, and it is not emitted into the aggregate.  A
`precondition` (→ 422) says the aggregate is in an invalid state; a `requires`
(→ 403) says the *caller* may not issue the command.  The second is an
application-layer decision, so the **leading run** of `requires` statements is
hoisted out of the entity and evaluated by whatever calls it — the HTTP handler,
or a workflow's / explicit handler's inline op-call:

```ddd
operation cancel(reason: string) requires currentUser.role == "manager" && reason != "" {
  status := Cancelled
}
```

```ts
// generated (Hono) — http/order.routes.ts, post-load and pre-call
const aggregate = await repo.getById(Ids.OrderId(id));
if (!(currentUser.role === "manager" && body.reason !== "")) throw new ForbiddenError("Forbidden: currentUser.role == \"manager\" && reason != \"\"");
aggregate.cancel(body.reason);

// domain/order.ts — no gate, no principal parameter
public cancel(reason: string): void {
  this._status = "cancelled";
  this._assertInvariants();
}
```

Consequences worth knowing:

- The aggregate method **drops its `currentUser: User` parameter** when the gate
  was its only use, so the entity stays callable from a saga, a seed, or a timer
  without fabricating a principal.
- A gate that references operation **parameters** resolves them to whatever the
  call site passes (`body.<name>` on a route, the caller's own expression at an
  inline op-call) — the parameters are not locals outside the method.
- `requires` is evaluated **before** `when`, so an unauthorized caller gets 403
  and never learns whether the operation would have been allowed in the row's
  current state.
- A `requires` that is **not** in the leading run (one that appears after a
  mutation or a `let` it depends on) stays in the body and still throws from the
  domain — hoisting it would change *when* it evaluates, not just where it lives.

This is how all five backends behave, by two different routes. **Node, .NET,
Java, and Python** needed the hoist: each emitted the 403 inside the aggregate
method, so the gate moved out to the caller — the route handler / command
handler / service, plus the inline op-call inside a workflow or explicit
handler, because a gate that only the HTTP path evaluates is a gate a saga can
walk around.

**Phoenix/Elixir was already right**, and by a better factoring. Its guards
(`requires`, `precondition`, and the `when` gate alike) lift into a leading
`with :ok <- ensure(…)` chain on the **context function** — Phoenix's
application layer — leaving the Ecto schema a plain data struct. Because every
caller goes *through* the context function, enforcement is inherited rather than
re-emitted per call site:

```elixir
# lib/<app>/<context>.ex — the context function owns the gate
def close_ticket(%App.C.Ticket{} = record, params, current_user \\ nil) do
  with :ok <- ensure(current_user.role == "agent", {:forbidden, "Forbidden: currentUser.role == \"agent\""}) do
    ...
  end
end
```

A workflow `create` gate scopes to `currentUser` + the starter's command params
(a saga has no aggregate `this`) and renders identically.  (A workflow `handle`
gate lowers the same way but is inert until `handle` command handlers are
surfaced as HTTP routes.)

`currentUser` types against the system's `user { … }` claim block, so a gate
that is a **bare boolean claim expression** — the simplest permission check —
type-checks on its own:

```ddd
operation close() requires currentUser.permissions.contains(permissions.ticketsClose) { … }
```

No surrounding `== …` / `&& …` is needed to satisfy the `bool` requirement:
`currentUser.permissions` types as the claim's declared `string[]`, so the
`.contains(…)` membership types as `bool`.

Default-deny is opt-in via `auth { enforcement: denyByDefault }`
(see the note at the top).  Without it (`enforcement: opt`, the
default) a deployable on `auth: required` still serves any
operation that doesn't declare a `requires` gate — Slice 2's
original behaviour.

#### The canonical `create` / `destroy` gate

`requires` is legal inside the canonical lifecycle actions too, and it is
enforced the same way — 403, at the caller.  The two halves differ in one respect
only, and it is the receiver:

```ddd
aggregate Shipment {
  reference: string
  quantity: int = 0

  create(reference: string) {
    requires currentUser.permissions.contains(permissions.manage)
  }

  destroy {
    requires currentUser.permissions.contains(permissions.manage) && quantity == 0
  }
}
```

```ts
// generated (Hono) — the create route: gate, THEN the factory
const currentUser = (c as unknown as { get(k: "currentUser"): User }).get("currentUser");
if (!((currentUser.permissions).includes("ops.manage"))) throw new ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage)");
const created = Shipment.create({ reference: body.reference, quantity: body.quantity });

// …and the destroy route: load (the 404 probe), gate, THEN delete
const __loaded = await repo.getById(Ids.ShipmentId(id));
if (!((currentUser.permissions).includes("ops.manage") && __loaded.quantity === 0)) throw new ForbiddenError("Forbidden: …");
await repo.delete(Ids.ShipmentId(id));
```

- A **`create`** guard may read `currentUser` and nothing else.  There is no
  instance until the factory runs, and the emitted `POST /<aggs>` takes the
  field-derived create input rather than the declared parameter list, so a
  parameter has no wire slot either.  Both are refused by
  `loom.lifecycle-guard-unreadable`, which names the offending refs.
- A **`destroy`** guard may also read `this`: the route already loads the row for
  its 404 probe, and the gate runs against that load.  So an unreachable id
  answers **404**, not 403 — same order as the operation routes.  A parameter is
  still out (a DELETE carries no body).
- The gate precedes the write **and** any audit staging, so a denied create
  constructs nothing and a denied destroy records nothing.
- `errorStatuses("create" | "destroy", guarded)` declares the 403, so a generated
  client types the denial instead of treating it as an unexpected throw.

Placement per backend is each one's own chokepoint: the route (Hono, FastAPI),
the Mediator command handler (.NET — its controller is a thin dispatch), the
service (Java), and the **context function** (Phoenix).  Phoenix's placement is
load-bearing rather than stylistic: it is the only backend whose frontend runs
in-process, and its scaffolded LiveView calls `<Ctx>.create_<agg>` and
`<Ctx>.destroy_<agg>!` **directly**, so a controller-level gate would have a
second front door.  The principal is threaded as an explicit argument (a LiveView
is a separate process from the HTTP request, so the plug's `conn.assigns` is not
reachable from it), and a nil principal denies rather than raising:

```elixir
# lib/<app>/<context>.ex — every REQUEST-side caller passes through this
def create_shipment(attrs, current_user \\ nil) do
  with :ok <- ensure(not is_nil(current_user) and (Enum.member?(current_user.permissions, "ops.manage")),
                     {:forbidden, "Forbidden: currentUser.permissions.contains(permissions.manage)"}) do
    create_shipment_unguarded(attrs)
  end
end

@doc "Create a Shipment with NO authorization gate — the in-process entry."
defdelegate create_shipment_unguarded(attrs), to: App.Warehouse.ShipmentRepository, as: :insert
```

**The seam splits, because not every caller is a request.**  A workflow
`factory-let` step, an event dispatcher, and the emitted integration tests all
create aggregates IN-PROCESS, with no request and no principal — and on the other
four backends a workflow body calls the domain factory directly, so the
aggregate's create gate never applies there at all.  Routing those through the
guarded seam denied (nil principal) a workflow whose own caller *did* hold the
permission: the same `.ddd` answering 200 on four backends and 403 on one.

So there are two entries, and the naming is the safety property:

| function | who calls it |
|---|---|
| `create_<agg>/2` (the plain name) | the request-side doors — controller, LiveView form, `DestroyForm` |
| `create_<agg>_unguarded/1` | the in-process callers — workflow step, event dispatch, emitted integration test |

The guarded one keeps the obvious name and delegates *through* the unguarded one,
so a caller that guesses `create_<agg>` gets the gate and there is exactly one
write path; bypassing authorization is something a call site has to say in a word
that shows up in review.  A workflow's own authorization is its own `requires`
gate, evaluated where the request is — re-checking the aggregate's create gate
underneath it would make Phoenix enforce a rule the other four do not, and would
fail closed for every principal-less internal caller (a timer, a seed, a saga).
`delete_<agg>` splits the same way for a workflow `destroy` step.

**Not supported: an event-sourced lifecycle guard.**  An `eventLog` aggregate's
create body renders into the domain `_init`, which has no principal in scope, so
the guard could not be evaluated there at all — `loom.lifecycle-guard-event-sourced`
refuses it and points at the caller (the named `operation` / `workflow` that
issues the create) instead.  The rest of a canonical lifecycle body is still not
rendered on a state-based aggregate: a `precondition`, an `emit`, or a computed
`assign` there is a `loom.lifecycle-body-dropped` error, not a silent drop.

### Named policy functions (P3.2)

A **named policy function** names a reusable `requires` predicate once so a
non-trivial gate isn't re-typed at every operation it guards.  It is a
context-level declaration —

```
policy <Name>(<params>): bool ( = <expr> | { <expr> } )
```

— an **ambient** boolean predicate (it sees `currentUser`, its own parameters,
`permissions.<name>`, enum values, and sibling policy functions / criteria; it
has **no candidate row** — pass row fields in as arguments).  Parentheses are
**required** (even for zero parameters) so the parser distinguishes the
function form from the `policy {}` read-ladder block ([tenancy](tenancy.md)).

```ddd
context Orders {
  permissions { approve, manage }

  policy CanApprove(cap: money): bool =
    currentUser.permissions.contains(permissions.approve) && cap <= 10000
  policy IsManager(): bool { currentUser.permissions.contains(permissions.manage) }

  aggregate Order {
    amount: money
    status: OrderStatus
    operation approve() {
      requires CanApprove(amount)   // ← argument bound to the parameter
      requires IsManager()
      status := OrderStatus.Approved
    }
  }
}
```

A `requires PolicyName(args)` reference is **inlined** at the gate (the
argument substituted for the parameter), exactly like a `criterion … of bool`
reference (see [`docs/criterion.md`](criterion.md)).  Because the result is an
ordinary boolean gate expression, **every backend enforces it through the same
`requires` → 403 path** — no new render code.  The generated `approve` body:

```ts
// node / Hono
if (!((currentUser.permissions).includes("sales.approve") && this._amount.lte(new Decimal("10000"))))
  throw new ForbiddenError("Forbidden: CanApprove(amount)");
if (!((currentUser.permissions).includes("sales.manage")))
  throw new ForbiddenError("Forbidden: IsManager()");
```

```csharp
// .NET / EF
if (!((currentUser.Permissions).Contains("sales.approve") && this.Amount <= 10000m))
    throw new ForbiddenException("Forbidden: CanApprove(amount)");
```

Composition falls out of the ordinary boolean operators
(`requires IsManager() && CanApprove(amount)`), like criteria.

| Diagnostic | When |
| --- | --- |
| `loom.policy-fn-return-type` | the return annotation is not `bool` |
| `loom.policy-fn-arity` | a `PolicyName(args)` call supplies the wrong argument count |
| `loom.policy-fn-cycle` | a policy function (transitively) references itself |

**Not yet shipped (P3.x follow-ups):** the `resource` scope (referencing the
gated row's fields directly instead of passing them as arguments), field
masking, and hosting policy functions inside the `policy {}` block.

### Deny carve-outs (Phase 4)

A **`deny` rule** is the negative twin of `allow`: a **deny-wins** carve-out that
removes access to an aggregate. It sits in the same `policy {}` block as the
`allow` read/write ladder, and — like the bare `allow` form — omits the `read`
word (bare = read); the shipped `write` verb selects the write access:

```ddd
policy {
  allow deep on Invoice   // widen the read scope …
  deny on Secret          // … but Secret is invisible (total READ carve-out)
  deny write on Invoice   // … and Invoice is read-only (WRITE carve-out)
}
```

- **`deny on X`** denies **read**: `X` becomes invisible — `findAll` returns `[]`
  and `findById` 404s. Because every backend's write command-load reuses the read
  filter, writes fail too.
- **`deny write on X`** denies **write** only: reads still work, but every instance
  mutation (update-style ops, `destroy`, applier dispatch) 404s.

Deny is **all-or-nothing at the aggregate** — there is no level word (a partial
deny is field-masking / row-clause territory, a later slice). It composes as an
**always-false predicate** through the *existing* filter seams — the read
`contextFilters` (deny read) and the `writeScopeFilter` command load (deny write)
— so no backend grows new render architecture; each just renders the deny sentinel
to its native always-false fragment:

```ts
// node / Hono — deny read ANDs an always-false term into every Secret read
.where(and(eq(schema.secrets.id, id), and(isNull(schema.secrets.id), isNotNull(schema.secrets.id))))
```
```java
// Java / Spring — deny read is a Hibernate @SQLRestriction on the entity;
// deny write is `and 1 = 0` in the for-write @Query
@SQLRestriction("1 = 0")
@Query("select e from Invoice e where e.id = :id and 1 = 0")
Optional<Invoice> findByIdForWrite(@Param("id") InvoiceId id);
```

Deny wins: it is applied **after** the `allow` read/write-level passes, so an
always-false carve-out dominates any widened allow scope on the same target.
Unlike the allow ladder, deny is **not** restricted to `tenantOwned` aggregates —
`contextFilters` / `writeScopeFilter` exist on every aggregate.

| Diagnostic | When |
| --- | --- |
| `loom.policy-deny-unknown-aggregate` | the deny target names no aggregate in the context |
| `loom.policy-deny-duplicate` | the same `(aggregate, access)` is denied twice |
| `loom.policy-deny-shadows-allow` | *(warning)* an `allow` on the same target+access is shadowed by a `deny` — the allow is dead (deny wins) |

A lone `deny` with no matching `allow` is **not** flagged — aggregates are readable
by default, so a carve-out with no prior grant is meaningful.

**Not yet shipped (Phase 4.x follow-ups):** the `policy {}`-block field rules
(`field f { mask unless … }` / `deny read` nested in a read block), `data {}`
row-attribute clauses, and per-operation / `Workflow` point gates — the larger
slices the aggregate-level deny-wins primitive lays the plumbing for.

### Field masking — `mask unless` (read redaction)

The **aggregate-field baseline** read mask (authorization.md §5) marks a field
"sensitive everywhere, shown only to the authorised": it is REDACTED (null on the
wire) UNLESS a `currentUser`-only predicate holds.

```ddd
aggregate Person {
  name: string
  salary: money mask unless currentUser.permissions.contains(permissions.salaryUnmask)
}
```

The predicate is a **bool** and, like a `requires` gate, references only
`currentUser` (+ constants) — it is evaluated at read projection as a param-free
caller check, never against the row.

The redaction lands at the **response boundary**: every read route (GET `/:id`,
each `find` shape) and explicit query-handler routes a masked aggregate through a
masked serializer that redacts each masked field to `null` unless the caller
satisfies its predicate — **fail-closed** (an unauthenticated request always
redacts). The masked field is nullable in the response schema. Internal
audit/provenance snapshots stay unmasked (they record the real value). A
mask-free aggregate is byte-identical.

> **Known divergence — .NET audit snapshots.** node, Java, Python and Elixir all
> project audit `before`/`after` through the UNMASKED serializer, as the previous
> paragraph says. .NET does not: its audited command handlers reuse the ordinary
> (masked) wire projection, so a masked field is recorded as `null` whenever the
> acting principal fails the predicate — the stored trail then depends on *who*
> performed the write, and the entity-history read has nothing left to redact.
> Not fixed here (it changes what .NET writes, and overlaps the in-flight
> history-read work); tracked as a follow-up.

```ts
// generated (Hono) — the aggregate's read serializer
toWireMasked(root: Person, currentUser: User | null): unknown {
  const wire = this.toWire(root) as Record<string, unknown>;
  if (!(currentUser !== null && ((currentUser.permissions).includes("hr.salaryUnmask")))) wire.salary = null;
  return wire;
}
```

```py
# generated (FastAPI) — reads the ambient principal, no caller-passed arg
def to_wire_masked(self, root: Person) -> dict[str, object]:
    d = self.to_wire(root)
    _mask_user = current_user()
    if not (_mask_user is not None and ("hr.salaryUnmask" in _mask_user.permissions)):
        d["salary"] = None
    return d
```

On **Java** the aggregate's `<Agg>Response` record gains a second static mapper,
`fromMasked`, that binds the ambient principal off the static
`CurrentUserAccessor.currentOrNull()` and redacts each masked component; the read
services + explicit handlers project through it, while audit before/after
snapshots keep the unmasked `from`.

```java
// generated (Spring) — audit keeps `from`; reads use `fromMasked`
public static PersonResponse fromMasked(Person value) {
    User __maskUser = CurrentUserAccessor.currentOrNull();
    return new PersonResponse(value.id().value(), value.name(),
        (__maskUser != null && (__maskUser.permissions().contains("hr.salaryUnmask"))) ? value.salary() : null);
}
```

On **.NET** the redaction is inlined into the wire projection itself, guarded by
a C# pattern match on the ambient `RequestContext.Current` — no separate masked
mapper.

```csharp
// generated (.NET) — the read handler's projection, two masked fields
return found is null ? null : new PersonResponse(found.Id.Value, found.Name,
    (RequestContext.Current?.CurrentUser is { } __maskUser0 && ((__maskUser0.Permissions).Contains("hr.salaryUnmask"))) ? (decimal?)(found.Salary) : null,
    (RequestContext.Current?.CurrentUser is { } __maskUser1 && ((__maskUser1.Permissions).Contains("hr.salaryUnmask"))) ? (string?)(found.NationalId) : null);
```

The pattern variable is **numbered** (`__maskUser0`, `__maskUser1`, …) rather
than fixed. `x is { } n` declares `n` in the enclosing BLOCK, not in the
conditional expression that tests it, so a second wrap in the same C# scope
would redeclare the same local — `CS0128`. Two masked fields on one aggregate
(above) hit that inside a single projection; an `audited` command hits it across
two, because its handler renders the projection once per before/after snapshot.
Names are allocated per C# scope in field order (`MaskNamer`,
`generator/dotnet/dto-mapping.ts`), so an emitter that renders more than one
projection into one method body threads a single allocator through all of them.

On **Elixir** (vanilla Phoenix) the aggregate REST/ES controller's `serialize/1`
becomes the redacting serializer — it delegates to `serialize_unmasked/1` (the
raw map, which audit before/after snapshots project through) and nils each masked
key unless the ambient principal satisfies the predicate. The controller has no
`conn` in scope, so it reads the principal from the process dictionary the Auth
plug stashes (`Process.put(:loom_current_user, user)`).

```elixir
# generated (Phoenix) — reads the principal off the process dictionary
defp serialize(record) do
  current_user = Process.get(:loom_current_user)
  wire = serialize_unmasked(record)
  wire = if current_user != nil and (Enum.member?(current_user.permissions, "hr.salaryUnmask")), do: wire, else: Map.put(wire, "salary", nil)
  wire
end
```

**Status (M-T3.2 item 6).** Grammar + IR + printer + wire contract + validation,
plus read redaction on **all five backends** (node, .NET, Python, Java, Elixir),
have shipped — a `mask unless` field now redacts fail-closed on every backend.
A write-side field gate (`write(...)` / `readonly when`) was tried and **reverted**
(redundant with a post-load `requires` on the operation, which is also row-aware);
gate field writes with `operation update(…) requires <field> == this.<field> || <caller-check>`.

| Diagnostic | When |
| --- | --- |
| `loom.field-mask-not-current-user` | the predicate references the row / a param, not just `currentUser` |
| `loom.field-mask-unsupported` | the hosting backend does not emit the read redaction (none today — every backend supports it) |
| `loom.field-mask-projection-source` | a masked aggregate is a query-time `projection` source — projection responses aren't read-masked yet, so it would leak |
| *(AST)* `'mask unless' … must be of type 'bool'` | the predicate is not a bool |

### Find `requires` gates

A repository `find` accepts the same optional `requires <expr>` clause,
**before** its `where` filter — the read-side analogue of an operation gate:

```ddd
repository Tickets for Ticket {
  find openOnes(): Ticket[] requires currentUser.role == "agent" where open == true
  find mine(): Ticket[]     requires true where open == true   // intentionally public
}
```

The gate emits an in-handler **403** at the top of the find's route, evaluated
against the request's `currentUser` before the query runs.  It is
**`currentUser`-only** (plus constants) — no source row exists yet,
so referencing an aggregate field is a compile error
(`loom.find-gate-not-current-user`).  Like every `requires` clause it must
**type to `bool`** (a non-bool gate — `requires 42` — is rejected, so it can't
lower to an always-truthy no-op).  Use `where` to scope *which rows* come
back, `requires` to decide *who* may run the find.  `requires true` is the
intentionally-public escape that also satisfies default-deny.

The generated handler throws `ForbiddenError`/`ForbiddenException` (→ RFC-7807
403) on all five backends before touching the repository:

```ts
// generated Hono route for `find openOnes ... requires currentUser.role == "agent"`
const currentUser = c.get("currentUser");
if (!(currentUser.role === "agent")) throw new ForbiddenError("Forbidden");
const result = await repo.openOnes();
```

### UI gate — `page { requires <expr> }`

A `page` carries the same `requires <expr>` clause (page-metamodel §4).  On a
**React / Vue / Svelte** frontend with `auth: ui` (whose target backend is
`auth: required`), the generated page evaluates the gate client-side against
the verified session claims and renders a `<Forbidden/>` fallback instead of
its body when it fails — the read-side mirror of the backend 403:

```ddd
page Secret {
  route: "/secret"
  requires currentUser.role == "agent"
  body: Heading { "Top secret" }
}
```

```tsx
const currentUser = useSession().user as Record<string, any>;
if (!(currentUser.role === "agent")) {
  return ( <div style={{ padding: 24 }}><h2>Forbidden</h2>…</div> );
}
```

It is **`currentUser`-only** (it has no row to scope), so it
and the backend stay decidable from the same claims.  The gate guard lands after
every hook (keeping rules-of-hooks intact).  A page without `auth: ui`, or
without a gate, is byte-identical to before.  The page `requires` gate ships on
React, Vue, and Svelte; menu-link hiding ships on React + Svelte, and
action-button gating on React / Vue / Svelte — only Angular still lacks an auth
UI gate.  The client guard is **defence-in-depth** — the authoritative check is
always the backend 403.

`currentUser` is in scope wherever an expression evaluates **per
request**:

| Context | `currentUser` allowed? |
| --- | --- |
| Operation body (preconditions, assignments, calls, emits) | ✅ |
| Workflow body | ✅ |
| Aggregate-level `test` body | ✅ |
| Repository `find` `where` clause | ✅ (slice 1C) |
| Aggregate / part / value-object invariant | ❌ |
| Derived property | ❌ |
| `function` body | ❌ |

The validator surfaces a friendly diagnostic for any disallowed use.

> **All five backends emit auth files.** The two file layouts documented
> below (.NET and Hono) are representative — Python, Java, and
> Elixir/Phoenix emit the same surface (a strongly-typed `User`, a verifier
> hook, and request middleware that stashes the resolved principal), plus
> the OIDC authorization-code handshake when an `auth { oidc { … } }` block
> is present.

## .NET (ASP.NET Core + Mediator)

When a deployable opts in via `auth: required`, the .NET generator
emits five files under `Auth/`:

| File | Role |
| --- | --- |
| `Auth/User.cs` | Strongly-typed `User` record matching the system's user block |
| `Auth/IUserVerifier.cs` | Interface the user implements to decode a token into a `User` |
| `Auth/ICurrentUserAccessor.cs` | Scoped accessor exposed to handlers |
| `Auth/HttpContextCurrentUserAccessor.cs` | Default implementation backed by `IHttpContextAccessor` |
| `Auth/UserMiddleware.cs` | Middleware that calls the verifier and stashes the resolved user |

`Program.cs` is extended to mount `UseMiddleware<UserMiddleware>()`
between `UseSwagger()` and `MapControllers()`, register the
accessor + `IHttpContextAccessor`, and fail fast at startup if no
`IUserVerifier` is registered.

You supply the verifier in your own project code:

```csharp
using Acme.Auth;

public sealed class JwtUserVerifier : IUserVerifier
{
    public async Task<User?> VerifyAsync(HttpContext ctx, CancellationToken ct)
    {
        // Parse Authorization header, validate signature, project
        // claims into User.  Return null to reject with 401.
        // ...
    }
}
```

Register in `Program.cs` (or any DI extension):

```csharp
builder.Services.AddScoped<IUserVerifier, JwtUserVerifier>();
```

When an aggregate operation references `currentUser`, the generated
C# method picks up a trailing `User currentUser` parameter and the
Mediator handler injects `ICurrentUserAccessor`, passing
`_currentUser.User` into the call.  Operations that don't reference
`currentUser` stay untouched — no DI surface widening, no parameter
noise.

## Hono

When a Hono deployable opts in, the generator emits three files
under `auth/`:

| File | Role |
| --- | --- |
| `auth/user-types.ts` | `User` interface matching the user block |
| `auth/verifier.ts` | `registerUserVerifier(...)` registry + `verifyUserOrThrow(req)` helper |
| `auth/middleware.ts` | Hono middleware mounted in `http/index.ts` |

`http/index.ts` mounts `app.use("*", authMiddleware)` after
`cors()` and asserts at startup that the verifier is registered.

You register your verifier before serving:

```ts
import { registerUserVerifier } from "./auth/verifier.js";

registerUserVerifier(async (req) => {
  const auth = req.headers.get("authorization");
  // ... parse Bearer token, validate, project to User shape ...
  return { id: "u-1", role: "manager", customerId: "c-1", tenantId: "t-1" };
});
```

When an aggregate operation references `currentUser`, the route
handler reads `c.get("currentUser") as User` at the top and passes
it as the trailing argument to the aggregate method.

## Dev-stub verifier (`x-loom-dev-claims`)

Until you register a real verifier, every backend ships an **accept-all dev
stub** so the stack boots and the routes are reachable in local dev. The stub
reads an optional **`x-loom-dev-claims`** request header — a JSON object of user
claims — and projects it onto the `User` shape, so you can exercise
`currentUser`/`requires` gates without wiring an identity provider:

```bash
curl -H 'x-loom-dev-claims: {"id":"u-1","role":"manager","tenantId":"t-1"}' \
  http://localhost:8080/api/orders
```

With no header the stub returns its **built-in identity**: one value per field
the `user { … }` block declares — `"admin"` for a `string`, the all-zero uuid
for a `guid`, `0` for a number, `false` for a `bool`, the epoch for a
`datetime`, the EMPTY list for an array (so a permission-guarded surface denies
by default), and `null` where the field is declared optional. The identity is
derived from the declared shape, so a non-optional field is never null and the
same `.ddd` yields the same principal on every backend. This is emitted
uniformly across all five backends — Hono, .NET, Python, Java, and Elixir — so
the same header drives every generated backend identically. It is a **dev
convenience, not a production path**: register a real verifier (above) before
shipping.

## Auth routes

Every backend mounts its auth routes under the shared API base, i.e.
`/api/auth`, alongside the domain routes (`/api/...`):

- `/api/auth/me` — the session probe the `auth: ui` frontend guard reads;
  always present under `auth: required`, and **not** bypassed (the
  middleware verifies the principal or returns 401 first). The body is the
  declared `user { … }` shape, **by declared name** — and nothing else: the
  per-request derived tenancy members (`currentUser.orgPath` / `rootOrg`) are
  server-side scoping state, so they stay off the wire. All five backends
  answer byte-identically here (frozen by the `/api/auth/me` entry in the
  behavioural wire goldens).
- `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` — the OIDC
  authorization-code redirect handshake, emitted only under an
  `auth { oidc { … } }` block.
- `POST /api/auth/refresh` — silent renewal: exchanges the stored refresh
  token for a fresh access token (no IdP round-trip) and **rotates** it, so a
  SPA can extend a session on a 401 without bouncing the user back to login.
  Emitted with the handshake; bypassed by the middleware (the caller has no
  valid access token yet). On a spent/revoked token it clears both cookies
  (→ full `/login`).

### Session depth (PKCE + refresh rotation)

The handshake is hardened by default (no knobs):

- **PKCE (RFC 7636), unconditional** — `/login` mints a per-login code
  verifier, sends only its `S256` challenge to the IdP, and stashes the
  verifier in an HttpOnly `oidc_verifier` cookie the `/callback` exchange
  proves possession with. OAuth 2.1 makes PKCE mandatory; it costs nothing for
  confidential clients and closes the code-interception hole for public ones.
- **Refresh rotation** — the handshake requests the `offline_access` scope,
  stores the granted refresh token in its own HttpOnly `refresh` cookie, and
  `POST /api/auth/refresh` rotates it (the cookie is overwritten with the new
  token the IdP hands back — single-use). All access/refresh tokens ride
  HttpOnly cookies; the SPA never sees the raw tokens.

Emitted identically across all five backends (Hono, .NET, Java/Spring,
Python/FastAPI, Phoenix).

**Boundary (D-AUTH-OIDC):** Loom owns "validate a token + run the redirect
handshake". **The IdP owns credentials, password reset, MFA, and consent** —
there is deliberately no Loom-hosted login form or password-reset flow. Point
users at your IdP's account pages for those; Loom will not generate them.

**Phoenix-LiveView `auth: ui` guard.** A `phoenixLiveView` deployable that
serves a HEEx `ui:` gates its LiveViews server-side: `LiveAuth.on_mount` runs
first in the `live_session`, assigns `@current_user`, and redirects an
unauthenticated connection to the login handshake. Under OIDC a `BrowserAuth`
plug (in the `:browser` pipeline) seeds the Phoenix session's `current_user`
from the verified session cookie so the on_mount hook sees a signed-in user;
the dev stub falls back to the built-in admin so a fresh stack renders out of
the box.

Auth is browser-facing traffic, the same class as the domain routes, so it
lives under `/api` — one reverse-proxy / k8s-ingress rule (`/api → backend`)
covers it, and the generated frontends (which fetch `${API_BASE_URL}/auth/…`
with `API_BASE_URL` already `/api`) line up. The infra probes (`/health`,
`/ready`) stay at the root: they're hit directly by Docker/k8s, never through
the public proxy. Set `OIDC_REDIRECT_URI` to a `…/api/auth/callback` URL when
overriding the default.

## Bypass list

Every backend bypasses auth on these paths so docker-compose health
checks, OpenAPI clients, and Swagger UI work without tokens:

- `/health`
- `/ready`
- `/openapi.json`
- `/swagger` (and any `/swagger/...` subpath)

Pin the per-platform middleware file in `.loomignore` if you need
to widen or tighten the list.

## Errors

| Situation | Diagnostic |
| --- | --- |
| `auth: required` on a deployable but no `user { ... }` block | Validation error: "deployable 'X' has 'auth: required' but system 'Y' declares no 'user { ... }' block." |
| Two user fields with the same name | Validation error: "user block declares field 'X' more than once." |
| `currentUser` in an invariant / derived / function body | Validation error: "currentUser is only available in per-request handlers." |
| Two permissions with the same name in one subdomain | Validation error: "subdomain 'S': permission 'X' is declared more than once." |
| `permissions.X` referencing an undeclared name (or used outside any subdomain) | Validation error: "permissions.X: no permission named 'X' is declared in this subdomain's 'permissions { ... }' block." |
| Workflow body calls a currentUser-bound repository find | Validation error: "references a currentUser-bound find, which workflows don't yet pass the user into."  Use `getById` or move the call to the route layer. |

Missing `IUserVerifier` registration surfaces at runtime startup,
not during generation — the project compiles, but boots with a
clear `InvalidOperationException` pointing you at the
`AddScoped<IUserVerifier, ...>` line that needs to exist.
