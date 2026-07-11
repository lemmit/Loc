# Auth, `currentUser`, and permissions

Loom systems can declare a strongly-typed JWT claim shape at system
scope and opt deployables in to JWT-decode middleware per request.
Modules can declare a typed permission catalogue used to gate
command entry from inside operation / workflow bodies.  Repository
finds and view filters can reference `currentUser` to scope query
results to the requester.

Shipped over four slices:

- **Slice 1A** — `user { ... }` + `currentUser` magic identifier +
  per-deployable `auth: required` middleware + verifier hook.
- **Slice 1B** — per-subdomain `permissions { ... }` block +
  `permissions.<name>` magic identifier resolving to a stable
  `<subdomain>.<name>` runtime string + the `.contains(x)` collection
  op for ergonomic claim membership checks.
- **Slice 1C** — `currentUser` admissible inside repository find /
  view `where` filters; the renderer threads the resolved user
  through as a closure-captured parameter on the generated method.
- **Slice 2**  — `requires <expr>` statement: a declarative
  authorization gate that maps to HTTP 403, distinct from
  `precondition` (which maps to 400).

What's intentionally **not** here yet:

- **Default-deny enforcement** is now opt-in via
  `auth { enforcement: denyByDefault }` (default `opt` preserves the
  per-`requires` behaviour).  Under `denyByDefault`, every **client-reachable
  command** on an `auth: required` deployable must declare a `requires`
  gate — `requires true` is the explicit "intentionally public" escape —
  else `loom.default-deny-ungated` fires.  Covered: public aggregate
  **operations, creates, and destroys**, plus **workflows** (every
  command-triggered `create … {}` starter and named `handle …(){}`
  continuation; event-triggered creates and `on(...)` reactors are not
  client-reachable and so excluded), and **`view`s** (which now carry an
  optional `requires` gate — see [View gates](#view-requires-gates) below).
  Still uncovered: **repository `find`s** — these have no `requires`
  surface in the grammar (only a `where` filter), so flagging them would
  leave no escape hatch; gating bare finds needs the same `requires`-on-
  query addition (separate follow-up).
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
        // DomainException → 400 from the framework filter.
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

`currentUser` is admissible inside repository find and view
`where` clauses; the renderer threads the resolved User through
the generated method as a closure-captured parameter:

```ddd
repository Orders for Order {
  find mine(): Order[] where customerId == currentUser.customerId
}

view MyOrders = Order where customerId == currentUser.customerId
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
distinct from `precondition`'s 400 — the two are deliberately
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
| `precondition` | HTTP 400 (`DomainException` / `DomainError`) | The request is malformed or the aggregate state is invalid for this op. |
| `requires`     | HTTP 403 (`ForbiddenException` / `ForbiddenError`) | The caller isn't authorized to invoke this op. |

Both type-check to `bool` and may reference `currentUser`,
`permissions.<name>`, parameters, `this.<field>`, and any
declared `function`.  `requires` is admissible in workflow
bodies too; the workflow handler / route handler maps it to 403
the same way as the operation route does.

Default-deny is opt-in via `auth { enforcement: denyByDefault }`
(see the note at the top).  Without it (`enforcement: opt`, the
default) a deployable on `auth: required` still serves any
operation that doesn't declare a `requires` gate — Slice 2's
original behaviour.

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

**Not yet shipped (Phase 4.x follow-ups):** field-level masking (`field f { mask
unless … }` / `deny read`), `data {}` row-attribute clauses, and per-operation /
`View` / `Workflow` point gates — the larger slices the aggregate-level deny-wins
primitive lays the plumbing for.

### View `requires` gates

A `view` accepts an optional `requires <expr>` clause **before**
its `where` filter — the read-side analogue of an operation gate:

```ddd
view OpenTickets = Ticket requires currentUser.role == "agent" where open == true
```

The gate emits an in-handler **403** at the top of the view's
route, evaluated against the request's `currentUser` before the
query runs.  Because it runs *before* any row is fetched, a view
gate is **`currentUser`-only** (plus constants): referencing the
source row (`requires open == true`) is a compile error
(`loom.view-gate-not-current-user`).  This keeps the gate decidable
without the data — use `where` to scope *which rows* come back, and
`requires` to decide *who* may run the view.  `requires true` is the
intentionally-public escape that also satisfies default-deny.

The 403 emission lands on **every backend** (Hono, .NET, Java, Python,
Phoenix LiveView); the validation (currentUser-only, default-deny) is
platform-neutral.  See
[Views → Authorization](views.md#authorization--the-requires-gate)
for the full surface.

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

Like the view gate it is **`currentUser`-only** (it has no row to scope), so it
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
| View `bind` expressions (full-form views) | ✅ |
| Repository `find` `where` clause | ✅ (slice 1C) |
| View shorthand / full-form `where` clause | ✅ (slice 1C) |
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

With no header the stub returns a default principal. This is emitted uniformly
across all five backends — Hono, .NET, Python, Java, and Elixir — so the same
header drives every generated backend identically. It is a **dev convenience,
not a production path**: register a real verifier (above) before shipping.

## Auth routes

Every backend mounts its auth routes under the shared API base, i.e.
`/api/auth`, alongside the domain routes (`/api/...`):

- `/api/auth/me` — the session probe the `auth: ui` frontend guard reads;
  always present under `auth: required`, and **not** bypassed (the
  middleware verifies the principal or returns 401 first).
- `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` — the OIDC
  authorization-code redirect handshake, emitted only under an
  `auth { oidc { … } }` block.

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
