# 17. Authentication & authorization

Identity and access for a Loom system, in one place: the system-scope `user` claim shape, the `auth { … }` OIDC config that generates a real verifier, the per-subdomain `permissions` catalogue (with `implies` grant hierarchy), the `requires` gate (HTTP 403), named `policy` functions, the `policy { … }` read/write ladder and its `deny` carve-outs, `mask unless` field redaction, the magic `currentUser`, and `sensitive(...)` tagging. Reach for this chapter when a request must be checked against *who the caller is* — distinct from `precondition`, which checks *what state the aggregate is in* (403 vs 422). Loom owns no auth runtime: declaring this surface generates the typed principal, the middleware, the verifier, the gates and the query filters; the IdP owns credentials, MFA and consent.

> **Grammar:** `UserBlock` / `UserField` / `UserFieldName`, `AuthBlock`, `OidcConfig`, `AuthConfigValue`, `ClaimsMap` / `ClaimEntry`, `SessionMode`, `Enforcement`, `AuthMode`, `PermissionsBlock` / `PermissionDecl`, `PolicyDecl` / `PolicyReadRule` / `PolicyVerb` / `ReadLevel`, `RequiresStmt`, `RequiresProp`, `SensitivityClause`, `Property`'s `mask unless`, `TenancyDecl` · **Validators:** `loom.auth-without-user`, `loom.auth-no-user-block`, `loom.duplicate-auth-block`, `loom.duplicate-user-block`, `loom.user-duplicate-field`, `loom.auth-unknown-provider`, `loom.auth-missing-issuer`, `loom.auth-missing-client-id`, `loom.auth-unknown-claim-field`, `loom.duplicate-permission`, `loom.unknown-permission`, `loom.permission-implies-self`, `loom.permission-implies-unknown`, `loom.policy-*`, `loom.field-mask-*`, `loom.currentuser-not-in-request-scope`, `loom.default-deny-ungated`, `loom.audit-history-ungated`, `loom.find-gate-not-current-user`, `loom.projection-gate-not-current-user`, `loom.workflow-gate-not-current-user`, `loom.workflow-currentuser-find`, `loom.guard-principal-without-auth`, `loom.stamp-principal-without-auth`, `loom.current-user-needs-auth-ui`, `loom.auth-ui-misplaced`, `loom.auth-ui-target-open`, `loom.auth-ui-unsupported-framework`, `loom.orgpath-without-tenancy` · **Docs:** [`../auth.md`](../auth.md), [`../tenancy.md`](../tenancy.md)

All five backends emit auth files. The middleware, verifier seam, `requires`→403 mapping, `permissions.<name>` lowering, the read/write ladder and `mask unless` redaction are structurally identical across them — the divergence is host-language syntax and, for Elixir, the topology (a plug plus context-function guards rather than route-level throws). The frontends consume only the session probe; the `auth: ui` page gate is covered in [UI pages](15-ui-pages-structure.md) and [`../auth.md`](../auth.md#ui-gate--page--requires-expr-).

The single example below threads every feature in this chapter; each section excerpts the lines it produces.

```ddd
system Helpdesk {
  user { id: string  role: string  permissions: string[]  tenantId: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER")  clientId: "helpdesk-web"  clientSecret: env("OIDC_CLIENT_SECRET")  scopes: ["openid", "profile"] }
    sessions: cookie
    enforcement: opt
    claims: { role: "realm_access.roles", permissions: "resource_access.helpdesk.roles" }
  }
  tenancy by user.tenantId of Organization

  subdomain Support {
    permissions {
      ticketsRead,
      ticketsClose implies ticketsRead,
      ticketsAdmin implies [ticketsClose, ticketsReassign],
      ticketsReassign,
      salaryUnmask
    }

    context Support {
      enum TicketStatus { Open, Pending, Closed }

      policy IsAgent(): bool = currentUser.role == "agent"
      policy CanClose(prio: int): bool =
        currentUser.permissions.contains(permissions.ticketsClose) && prio < 10

      aggregate Ticket with tenantOwned, crudish {
        subject: string
        ssn: string sensitive(pii)
        salary: int mask unless currentUser.permissions.contains(permissions.salaryUnmask)
        status: TicketStatus
        assignee: string
        priority: int

        operation close() requires IsAgent() || CanClose(priority) {
          precondition status != Closed
          status := Closed
        }
        operation reassign(to: string) {
          requires currentUser.permissions.contains(permissions.ticketsReassign)
          assignee := to
        }
      }
      aggregate Secret with tenantOwned, crudish { code: string }
      aggregate Plan crossTenant with crudish { name: string }
      aggregate Organization with crudish { name: string  implements tenantRegistry }

      repository Tickets for Ticket {
        find mine(): Ticket[] where assignee == currentUser.id
        find open(): Ticket[] requires currentUser.role == "agent" where status == Open
      }
      repository Secrets for Secret { }
      repository Plans for Plan { }
      repository Organizations for Organization { }

      policy {
        allow deep on Ticket
        deny on Secret
      }
    }
  }

  storage primary { type: postgres }
  resource supportState { for: Support, kind: state, use: primary }
  api SupportApi from Support

  deployable apiNode { platform: node contexts: [Support] dataSources: [supportState] serves: SupportApi port: 3000 auth: required }
  // … one deployable per backend in the real fixture
}
```

## `user` — the principal claim shape

`user { field: Type … }` at **system scope** declares the strongly-typed claim record the verifier decodes per request. Exactly one per system (`loom.duplicate-user-block`); a repeated field is `loom.user-duplicate-field`. `id` and `permissions` are admissible field names (the grammar's `UserFieldName` re-admits them, plus `migration`). Every `currentUser.<field>` reference type-checks against this block.

```ddd
user { id: string  role: string  permissions: string[]  tenantId: string }
```

The declared fields are the *claims*; under a `tenancy by` declaration the principal additionally carries two **derived** members resolved once per request — `orgPath` (the caller org's materialized registry path) and `rootOrg` (its first segment). They are server-side scoping state and stay off the `/api/auth/me` wire.

::: tabs backend
== node
```ts
// auth/user-types.ts
export interface UserClaims { id: string; role: string; permissions: string[]; tenantId: string; }
export interface User extends UserClaims {
  orgPath: string;   // caller's tenant materialized path (multi-tenancy)
  rootOrg: string;   // first segment of orgPath — anchors `allow global`
}
```
== dotnet
```csharp
// Auth/User.cs
public sealed record User(string Id, string Role, List<string> Permissions, string TenantId)
{
    private string? _orgPath;   // resolved once per request by UserMiddleware, memoized
}
```
== java
```java
// auth/User.java
public record User(String id, String role, List<String> permissions, String tenantId) { /* + orgPath/rootOrg accessors */ }
```
== python
```python
# app/auth/user.py
@dataclass(frozen=True)
class User:
    id: str
    role: str
    permissions: list[str]
    tenant_id: str
    org_path = ""   # class attribute, NOT a field — never serialized by asdict()
```
== elixir
```elixir
# api_elixir_web/auth.ex — the principal is a plain map built from the claims
defp build_user(claims) do
  %{id: get_claim(claims, "sub"), role: get_claim(claims, "realm_access.roles"),
    permissions: get_claim(claims, "resource_access.helpdesk.roles") || [],
    tenant_id: get_claim(claims, "tenant_id")}
end
```
::: end

> Referencing `currentUser.orgPath` / `.rootOrg` without a `tenancy by` line is `loom.orgpath-without-tenancy`.

## `auth: required` — per-deployable middleware + verifier seam

The `user` block declares the shape; `auth: required` on a **deployable** opts it into the decode middleware. Without it the deployable stays open. With it but no `user` block, `loom.auth-no-user-block` fires (the sibling `loom.auth-without-user` is the *auth-block-without-user* case). The middleware decodes the token via the verifier hook, stashes the principal on the request context, and 401s on failure. A shared bypass list (`/health`, `/ready`, `/openapi.json`, `/swagger`, the OIDC handshake paths) keeps framework endpoints anonymous so smoke tests and the OpenAPI parity check work without tokens.

`AuthMode` is a two-value union: `required` (backend — decode + enforce) and `ui` (frontend — the client-side session guard). `auth: ui` on a backend deployable is `loom.auth-ui-misplaced` (it replaced the older `auth-ui-on-backend` code); pointing it at a target that is not `auth: required` is `loom.auth-ui-target-open`; a framework outside `react`/`vue`/`svelte`/`angular`/`feliz`/`flutter` is `loom.auth-ui-unsupported-framework`.

::: tabs backend
== node
```ts
// auth/middleware.ts — mounted in http/index.ts as app.use("*", authMiddleware)
export const authMiddleware = createMiddleware<{ Variables: { currentUser: User } }>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  for (const prefix of BYPASS_PREFIXES) if (path.startsWith(prefix)) { await next(); return; }
  if (routeProbe && !routeProbe(c.req.method, path)) { await next(); return; }
  // … verifyUserOrThrow(c.req.raw) → 401 on failure, then c.set("currentUser", user)
});
```
The verifier is a registry you fill at startup (`auth/verifier.ts`: `registerUserVerifier(fn)` / `verifyUserOrThrow(req)`). `requireCurrentUser()` reads the ambient principal from any layer — that is what lets an always-on tenant filter scope a repository read without threading a parameter.
== dotnet
```csharp
// Auth/UserMiddleware.cs — UseMiddleware<UserMiddleware>() between UseSwagger() and MapControllers()
User? user;
try { user = await verifier.VerifyAsync(ctx, ctx.RequestAborted); }
catch { ctx.Response.StatusCode = 401; return; }
if (user is null) { ctx.Response.StatusCode = 401; return; }
if (RequestContext.Current is { } rc) rc.CurrentUser = user;
```
`Program.cs` registers `ICurrentUserAccessor` + `IHttpContextAccessor` and fails fast at startup if no `IUserVerifier` is registered.
== java
```java
// auth/UserFilter.java — a servlet filter; auth/UserVerifier.java is the seam,
// auth/CurrentUserAccessor.java exposes the principal (statically) to services and mappers.
```
== python
```python
# app/auth/middleware.py — Starlette middleware; app/auth/verifier.py is the seam.
# The principal also lands in a ContextVar (`current_user_var`); require_current_user() reads it
# from any layer, fail-closed.
```
== elixir
```elixir
# api_elixir_web/auth.ex — a Plug in the :api pipeline (and a BrowserAuth plug + LiveAuth.on_mount for LiveViews)
if bypass_path?(conn.request_path), do: conn, else:
  case verify_token(extract_token(conn)) do
    {:ok, claims} -> assign(conn, :current_user, build_user(claims))
    _ -> send_unauthorized(conn)
  end
```
::: end

> A missing verifier registration surfaces at **runtime startup**, not generation.

## `auth { … }` — OIDC config

`auth { … }` is a system-scope sibling of `user`: the user block declares the claim *shape*, this declares *who issues* the token and how its claims map onto that shape. It generates a real verifier (filling the per-backend seam) plus the redirect handshake. At most one per system (`loom.duplicate-auth-block`), and only alongside a `user` block (`loom.auth-without-user`).

- `provider:` — a preset name. Hosted presets (`google`, `microsoft`, `entra`) carry their own issuer; the self-hosted ones (`auth0`, `okta`, `zitadel`, `cognito`, `keycloak`, `custom`) require an explicit `oidc { issuer: … }` or `loom.auth-missing-issuer` fires. An unknown name is `loom.auth-unknown-provider`. Omitting `provider:` entirely and supplying a raw `oidc { issuer }` is also valid.
- `oidc { issuer, clientId, clientSecret, audience, scopes: […] }` — each value is a `"literal"` or `env("VAR")`, so secrets never land in source. A missing `clientId` is `loom.auth-missing-client-id`.
- `sessions: cookie | jwt` (default `cookie`), `enforcement: opt | denyByDefault` (default `opt` — see [`requires`](#requires--the-authorization-gate-http-403)).
- `claims: { field: "dotted.claim.path" }` — maps an IdP claim path onto a `user` field; an unknown target field is `loom.auth-unknown-claim-field`.

```ddd
auth {
  provider: keycloak
  oidc { issuer: env("OIDC_ISSUER")  clientId: "helpdesk-web"  clientSecret: env("OIDC_CLIENT_SECRET")  scopes: ["openid", "profile"] }
  sessions: cookie
  claims: { role: "realm_access.roles", permissions: "resource_access.helpdesk.roles" }
}
```

The `claims:` map drives the verifier's claim projection — the dotted paths are read off the verified payload onto the principal:

::: tabs backend
== node
```ts
// auth/oidc.ts — validates signature (JWKS) + issuer, then projects claims
function toUser(payload: JWTPayload): UserClaims {
  return {
    id: claim(payload, "sub") as string,
    role: claim(payload, "realm_access.roles") as string,
    permissions: claim(payload, "resource_access.helpdesk.roles") as string[],
    tenantId: claim(payload, "tenantId") as string,
  };
}
```
JWKS is discovered lazily via `/.well-known/openid-configuration` and cached; `registerOidcVerifier()` wires it into the seam.
== dotnet
```csharp
// Auth/OidcUserVerifier.cs
return new User(
    Id: ClaimString(payload, "sub") ?? string.Empty,
    Role: ClaimString(payload, "realm_access.roles") ?? string.Empty,
    Permissions: ClaimStringList(payload, "resource_access.helpdesk.roles"),
    TenantId: ClaimString(payload, "tenantId") ?? string.Empty);
```
== elixir
```elixir
# api_elixir_web/auth.ex
defp build_user(claims) do
  %{id: get_claim(claims, "sub"), role: get_claim(claims, "realm_access.roles"),
    permissions: get_claim(claims, "resource_access.helpdesk.roles") || [], tenant_id: get_claim(claims, "tenant_id")}
end
```
::: end

Handshake routes mount under `/api/auth` alongside the domain routes: `login`, `callback`, `logout`, `me` (the session probe the `auth: ui` guard reads) and `POST /api/auth/refresh` (silent renewal with refresh-token rotation). PKCE is unconditional. `generate system` also emits a `keycloak/realm.json` for a local IdP. Full route table, session depth and bypass list: [`../auth.md`](../auth.md#auth-routes).

### Dev-stub verifier (`x-loom-dev-claims`)

Until a real verifier is registered, every backend ships an accept-all **dev stub** so the stack boots. It reads an optional `x-loom-dev-claims` header — **base64-encoded JSON** — and overlays it on a built-in identity derived from the declared shape (`"admin"` for a `string`, `0` for a number, the **empty list** for an array, so permission-gated surfaces deny by default):

```bash
curl -H "x-loom-dev-claims: $(echo -n '{"id":"u-1","permissions":["support.ticketsClose"]}' | base64)" \
  http://localhost:3000/api/tickets
```

```ts
// auth/dev-stub.ts (Hono) — the four typed backends emit an equivalent per-claim mapper
return { ...base, ...JSON.parse(Buffer.from(injected, "base64").toString("utf8")) };
```

Array-typed claims ride the header on **all five** backends (each typed backend emits a `devClaimStringList`-style array mapper), so a permission gate is drivable in dev everywhere. It is a dev convenience, not a production path.

## `permissions` — a typed catalogue with `implies`

`permissions { name, … }` lives at **subdomain** scope (a `Subdomain` member — it does not parse inside a `context`). Each name becomes a typed identifier `permissions.<name>`, usable in any expression resolving through the enclosing subdomain, and lowers to a **stable string literal** `<lowercase-subdomain>.<name>` — `permissions.ticketsClose` inside `subdomain Support` is `"support.ticketsClose"` on both sides of the wire. Backends never see a `Permission` type; the runtime is a `string[]` membership check. Multiple blocks in one subdomain merge; a duplicate is `loom.duplicate-permission`, an undeclared (or cross-subdomain) reference `loom.unknown-permission`.

A permission may declare that holding it transitively **grants** others. The single form omits the brackets, the multi form requires them:

```ddd
permissions {
  ticketsRead,
  ticketsClose implies ticketsRead,
  ticketsAdmin implies [ticketsClose, ticketsReassign],
  ticketsReassign
}
```

The transitive closure is precomputed at lowering (`impliedBy` on the permission IR); the runtime check stays flat membership. A `contains(permissions.X)` gate expands to an **OR over `X` plus every permission that transitively implies it**, so a caller holding `ticketsAdmin` satisfies a `ticketsReassign` gate without the token carrying it:

::: tabs backend
== node
```ts
// http/ticket.routes.ts — the gate written as `contains(permissions.ticketsReassign)`
if (!((currentUser.permissions).includes("support.ticketsReassign")
   || (currentUser.permissions).includes("support.ticketsAdmin")))
  throw new ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.ticketsReassign)");
```
== python
```python
if not ("support.ticketsReassign" in current_user.permissions or "support.ticketsAdmin" in current_user.permissions):
    raise ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.ticketsReassign)")
```
== elixir
```elixir
Enum.member?(current_user.permissions, "support.ticketsReassign") or
  Enum.member?(current_user.permissions, "support.ticketsAdmin")
```
::: end

`loom.permission-implies-self` rejects `a implies a`; `loom.permission-implies-unknown` rejects a target no `permissions { … }` block in the subdomain declares. A mutual cycle (`a implies b`, `b implies a`) is allowed — the closure computation is cycle-safe.

> The expansion is a flat `||` chain spliced into the surrounding expression, so an implied `contains(...)` inside a larger `&&` reads with `&&`'s tighter binding. Parenthesise the gate yourself when the surrounding operator matters.

`.contains(x)` is an ordinary collection op (joining `count`/`sum`/`all`/`any`/`where`/`first`/`firstOrNull`) admissible on **any** array — it renders as the host's idiomatic membership test (`.includes` / `.Contains` / `in` / `Enum.member?`).

## `requires` — the authorization gate (HTTP 403)

`requires <expr>` is a declarative authorization gate. Its `bool` expression may reference `currentUser`, `permissions.<name>`, parameters, `this.<field>`, named `policy` functions and criteria. Failure maps to **HTTP 403** — deliberately distinct from `precondition`'s **422**, so caller-authorization and aggregate-state-validity don't share an error class.

| Clause | HTTP | Failure means |
| --- | --- | --- |
| `requires` | 403 | The caller isn't authorized to invoke this. |
| `precondition` | 422 | The request/aggregate state is invalid for this operation. |

It is admissible in five positions, all of them **declaration headers** or a leading body run:

```ddd
operation close() requires IsAgent() || CanClose(priority) { … }   // header (post-load: sees `this` + params)
operation reassign(to: string) { requires currentUser.permissions.contains(permissions.ticketsReassign)  … }
find open(): Ticket[] requires currentUser.role == "agent" where status == Open   // before `where`
projection Backlog requires currentUser.role == "agent" { … }
workflow Fulfil requires currentUser.role == "ops" { create open(...) requires … { … } handle retry(...) requires … { … } }
page Admin { requires currentUser.role == "admin"  … }            // client-side guard, see ch. 15
```

The gate is **not domain logic and is not emitted into the aggregate**: the leading run of `requires` is hoisted out of the entity and evaluated by whatever calls it — the HTTP route, the Mediator/service handler, or the Phoenix context function. The domain method itself keeps its declared parameters and no injected principal.

::: tabs backend
== node
```ts
// http/ticket.routes.ts — post-load, pre-call; note the gate is here, not in domain/ticket.ts
const currentUser = c.get("currentUser") as User;
const aggregate = await repo.getById(Ids.TicketId(id));
if (!(currentUser.role === "agent" || (currentUser.permissions).includes("support.ticketsClose")
   || (currentUser.permissions).includes("support.ticketsAdmin") && aggregate.priority < 10))
  throw new ForbiddenError("Forbidden: IsAgent() || CanClose(priority)");
aggregate.close();
```
```ts
// domain/ticket.ts — the entity method carries the precondition only
public close(): void {
  if (!(this._status !== TicketStatus.Closed)) throw new DomainError("Precondition failed: status != Closed");
  this._status = TicketStatus.Closed;
  this._assertInvariants();
}
```
```ts
// http/ticket.routes.ts — the shared catch
if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);
if (err instanceof DomainError)    return problem(422, "Unprocessable Entity", err.message);
```
== dotnet
```csharp
// Application/Tickets/Commands/CloseHandler.cs — the Mediator handler owns the gate
var aggregate = await _repo.GetByIdForWriteAsync(command.Id, cancellationToken) ?? throw new AggregateNotFoundException(…);
var currentUser = _currentUser.User;
if (!(currentUser.Role == "agent" || (currentUser.Permissions).Contains("support.ticketsClose")
   || (currentUser.Permissions).Contains("support.ticketsAdmin") && aggregate.Priority < 10))
    throw new ForbiddenException("Forbidden: IsAgent() || CanClose(priority)");
aggregate.Close();
```
An exception filter maps `ForbiddenException` → 403, `DomainException` → 422.
== java
```java
// features/tickets/TicketService.java
if (!(Objects.equals(currentUser.role(), "agent") || currentUser.permissions().contains("support.ticketsClose")
   || currentUser.permissions().contains("support.ticketsAdmin") && aggregate.priority() < 10))
    throw new ForbiddenException("Forbidden: IsAgent() || CanClose(priority)");
aggregate.close();
```
`ApiExceptionAdvice` maps `ForbiddenException` → 403 via `ProblemDetail`.
== python
```python
# app/http/ticket_routes.py
if not (current_user.role == "agent" or "support.ticketsClose" in current_user.permissions
        or "support.ticketsAdmin" in current_user.permissions and found.priority < 10):
    raise ForbiddenError("Forbidden: IsAgent() || CanClose(priority)")
found.close()
```
== elixir
```elixir
# lib/api_elixir/support.ex — the context function owns the gate; {:error, :forbidden} → 403
def close_ticket(%Ticket{} = record, params, current_user \\ nil) when is_map(params) do
  with :ok <- ensure(current_user.role == "agent" or Enum.member?(current_user.permissions, "support.ticketsClose")
                     or Enum.member?(current_user.permissions, "support.ticketsAdmin") and record.priority < 10,
                     {:forbidden, "Forbidden: IsAgent() || CanClose(priority)"}),
       :ok <- ensure(record.status != :Closed, {:precondition_failed, "Precondition failed: status != Closed"}) do
    # … perform the update
  end
end
```
::: end

**Read-side gates are `currentUser`-only.** A `find`, a `projection` and a workflow's header gate all run *before* any row is loaded, so referencing an aggregate field is a compile error — `loom.find-gate-not-current-user`, `loom.projection-gate-not-current-user`, `loom.workflow-gate-not-current-user` respectively (each names the offending reference and points at the alternative). A find gate emits an in-handler 403 at the top of its route:

```ts
// http/ticket.routes.ts — GET /open
if (!(currentUser.role === "agent")) throw new ForbiddenError("Forbidden: find open");
const result = await repo.open();
```

**Default-deny.** `auth { enforcement: denyByDefault }` makes every client-reachable surface without a `requires` gate an error — `loom.default-deny-ungated`, raised separately for operations, finds, projections, workflows, workflow-instance reads and command/query handlers, plus `loom.audit-history-ungated` for an `audited` aggregate's `GET /<agg>/{id}/history`. `requires true` is the explicit "intentionally public" escape. The default (`opt`) leaves ungated surfaces open.

**No principal, no gate.** A `requires` gate (or a principal-reading lifecycle stamp such as `with auditable`'s `createdBy := currentUser`) on a deployable without `auth: required` would emit an unbound identifier and fail to compile — so it is caught first: `loom.guard-principal-without-auth` / `loom.stamp-principal-without-auth`.

## Named `policy` functions

`policy <Name>(<params>): bool = <expr>` (or `{ <expr> }`) is a **context member**: a reusable, ambient boolean authorization predicate — the named twin of an inline `requires`. It sees `currentUser`, its own parameters, `permissions.<name>`, enum values and sibling policy functions; it has **no candidate row**, so pass row fields in as arguments. The parentheses are required even for zero parameters — that is what disambiguates the function form from the `policy { … }` block.

```ddd
policy IsAgent(): bool = currentUser.role == "agent"
policy CanClose(prio: int): bool = currentUser.permissions.contains(permissions.ticketsClose) && prio < 10

operation close() requires IsAgent() || CanClose(priority) { … }
```

The call is **inlined at the gate** — no function is emitted, and the `ForbiddenError` message keeps the author's source text:

```ts
if (!(currentUser.role === "agent" || (currentUser.permissions).includes("support.ticketsClose")
   || (currentUser.permissions).includes("support.ticketsAdmin") && aggregate.priority < 10))
  throw new ForbiddenError("Forbidden: IsAgent() || CanClose(priority)");
```

| Situation | Diagnostic |
| --- | --- |
| Wrong argument count at the call site | `loom.policy-fn-arity` |
| Return type is not `bool` | `loom.policy-fn-return-type` |
| A policy function (transitively) references itself | `loom.policy-fn-cycle` |

## `policy { … }` — the read/write ladder and `deny`

The **block** form of `policy` is a context member that selects a per-aggregate reachability level, refining the tenant floor `with tenantOwned` installs. `allow` carries a widening `ReadLevel` (`local` / `deep` / `global`); the optional `write` verb switches to the write ladder; `deny` is the all-or-nothing carve-out and **wins** over any `allow`.

```ddd
policy {
  allow deep on Ticket        // caller's org + every descendant org
  allow write local on Ticket // (the default floor, spelled explicitly)
  deny on Secret              // Secret is invisible: findAll → [], findById → 404
  deny write on Plan          // Plan is read-only: mutations 404
}
```

| Level | Read scope |
| --- | --- |
| `local` | `tenantId == currentUser.tenantId` — the caller's own org node. **The default.** |
| `deep` | descendant-or-self on the materialized path: `dataKey == orgPath` OR `dataKey` under `orgPath || '.'`. |
| `global` | the caller's **root-org** subtree — the same prefix scan anchored at `currentUser.rootOrg`. Under flat tenancy it stays the flat floor (fail-closed). |

Each rule rewrites the aggregate's capability filter and rides the query seams the flat floor already uses — no new backend plumbing:

::: tabs backend
== node
```ts
// db/repositories/ticket-repository.ts — `allow deep on Ticket`
.where(and(inArray(schema.tickets.id, ids),
  or(and(isNotNull(schema.tickets.dataKey),
    or(eq(schema.tickets.dataKey, requireCurrentUser().orgPath),
       sql`${schema.tickets.dataKey} like ${… + ".%"} escape '!'`)), /* … */)))
```
```ts
// db/repositories/secret-repository.ts — `deny on Secret` composes as an always-false predicate
.where(and(eq(schema.secrets.id, id), and(isNull(schema.secrets.id), isNotNull(schema.secrets.id))))
```
== dotnet
```csharp
// Infrastructure/Persistence/AppDbContext.cs
modelBuilder.Entity<Ticket>().HasQueryFilter("Filter1", x => ((x.DataKey != null && (x.DataKey == _currentUser.User.OrgPath || …))));
modelBuilder.Entity<Organization>().HasQueryFilter("IdFilter", x => x.Id == __SelfScopeId_Organization_0);  // registry self-scope
```
```csharp
// Infrastructure/Persistence/Configurations/SecretConfiguration.cs — `deny on Secret`
builder.HasQueryFilter("Filter2", x => false);
```
== python
```python
# app/db/repositories/ticket_repository.py
select(TicketRow).where(or_(and_(TicketRow.data_key.isnot(None),
    or_(TicketRow.data_key == require_current_user().org_path,
        TicketRow.data_key.like(…))), …))
```
::: end

| Situation | Diagnostic |
| --- | --- |
| Target names no aggregate in this context | `loom.policy-unknown-aggregate` / `loom.policy-deny-unknown-aggregate` |
| Target is not `with tenantOwned` (a level refines the tenant floor) | `loom.policy-target-not-tenant-owned` |
| Two rules select a level for the same aggregate / access | `loom.policy-duplicate-target` / `loom.policy-deny-duplicate` |
| `deep`/`global` without `implements tenantRegistry` (no hierarchy) | `loom.policy-level-requires-hierarchy` |
| `write global` (parses, always rejected — root-wide mutation is a footgun) | `loom.policy-write-global-invalid` |
| Write scope wider than the read scope | `loom.policy-write-wider-than-read` |
| A `deny` that shadows an `allow` for the same aggregate (the allow is dead) | `loom.policy-deny-shadows-allow` |

Full semantics, the registry self-scope, and the per-backend seams: [`../tenancy.md`](../tenancy.md) and [`../auth.md`](../auth.md#deny-carve-outs-phase-4).

## `mask unless` — field read redaction

A property may carry a trailing `mask unless <expr>`: the field is **redacted (null on the wire) unless** the predicate holds — "sensitive everywhere, shown only to the authorised". Like a read gate the predicate is param-free and **`currentUser`-only** (`loom.field-mask-not-current-user`); it is evaluated at read projection, never against the row.

```ddd
aggregate Ticket {
  salary: int mask unless currentUser.permissions.contains(permissions.salaryUnmask)
}
```

Redaction lands at the **response boundary** — every read route and explicit query handler routes the aggregate through a masked serializer — and is **fail-closed**: an unauthenticated request always redacts. Internal audit/provenance snapshots keep the real value.

::: tabs backend
== node
```ts
// db/repositories/ticket-repository.ts
toWireMasked(root: Ticket, currentUser: User | null): unknown {
  const wire = this.toWire(root) as Record<string, unknown>;
  if (!(currentUser !== null && ((currentUser.permissions).includes("support.salaryUnmask")))) wire.salary = null;
  return wire;
}
```
```ts
// http/ticket.routes.ts — every read route projects through it
const __maskUser = c.get("currentUser") ?? null;
return c.json(result.map((r) => repo.toWireMasked(r, __maskUser)), 200);
```
== python
```python
# app/db/repositories/ticket_repository.py — reads the ambient principal, no caller-passed arg
def to_wire_masked(self, root: Ticket) -> dict[str, object]:
    d = self.to_wire(root)
    _mask_user = current_user()
    if not (_mask_user is not None and ("support.salaryUnmask" in _mask_user.permissions)):
        d["salary"] = None
    return d
```
== elixir
```elixir
# api_elixir_web/controllers/ticket_controller.ex — the principal comes off the process dictionary
wire = serialize_unmasked(record)
wire = if current_user != nil and (Enum.member?(current_user.permissions, "support.salaryUnmask")),
         do: wire, else: Map.put(wire, "salary", nil)
```
::: end

Two more gates guard the read paths a mask cannot reach: `loom.field-mask-projection-source` (a query-time projection sourcing from — or joining — a masked aggregate would expose the field; the `#fold` variant covers a folded event payload), and `loom.field-mask-unsupported` (a backend hosting the aggregate does not emit read redaction yet — it names the backends, so the gate is honest rather than silent).

## `currentUser` — claim access in domain logic

`currentUser` is a magic identifier resolving to the typed principal, in scope wherever an expression evaluates **per request**: operation and workflow bodies, `requires` gates, `mask unless` predicates, aggregate `test` bodies, and repository `find` `where` filters. It is a compile error (`loom.currentuser-not-in-request-scope`) in an invariant, a derived property, or a `function` body — those can run outside a request.

```ddd
repository Tickets for Ticket {
  find mine(): Ticket[] where assignee == currentUser.id
}
```

::: tabs backend
== node
```ts
// db/repositories/ticket-repository.ts — currentUser is a method param, parametrised into the bind
async mine(currentUser: User): Promise<Ticket[]> {
  const rootRows = await this.db.select().from(schema.tickets)
    .where(eq(schema.tickets.assignee, currentUser.id));
  // …
}
```
```ts
// http/ticket.routes.ts — the route threads the verified principal in
const currentUser = c.get("currentUser") as User;
const result = await repo.mine(currentUser);
```
== dotnet
```csharp
// Repo signature: Task<...> Mine(User currentUser, CancellationToken ct)
// The Mediator handler injects ICurrentUserAccessor and calls _repo.Mine(_currentUser.User, ct).
// The EF predicate lifts currentUser.Id via Linq-to-Entities — no string interpolation hits SQL.
```
== elixir
```elixir
def mine(current_user) do
  Repo.all(from t in Ticket, where: t.assignee == ^current_user.id)
end
```
::: end

Two honest gaps: a **workflow body** may not call a `currentUser`-bound find (`loom.workflow-currentuser-find` points at `getById` or the route layer), and a **page** reading `currentUser` on a deployable that binds no verified session is `loom.current-user-needs-auth-ui` (the read would emit a dangling reference — react `undefined.<claim>`, invalid Dart on flutter, an unbound match on feliz).

## Tenancy — `tenancy by user.<claim> of <Registry>`

Multi-tenancy is the auth layer's data-partitioning half and shares its principal. One system-level line names the claim and the registry; each aggregate then declares an explicit stance:

```ddd
tenancy by user.tenantId of Organization
aggregate Ticket with tenantOwned { … }        // stamped + filtered by the claim
aggregate Plan crossTenant { … }               // shared reference data, opts out (header-region marker)
aggregate Organization { implements tenantRegistry }   // the registry tree (parent + dataKey)
```

`with tenantOwned` splices `tenantId: string internal`, `dataKey: string? internal`, an `onCreate` stamp from `currentUser.tenantId` / `currentUser.orgPath`, and the filter `this.tenantId == currentUser.tenantId`. `implements tenantRegistry` adds `parent: Self id?` + the managed `dataKey` materialized path, turning `currentUser.orgPath` from a claim copy into a real registry lookup — and unlocking the `deep`/`global` levels above. `crossTenant` rides the aggregate **header region** (`aggregate Plan crossTenant { … }`), not a prefix.

Every persisted aggregate under a `tenancy by` system must take a stance (`loom.tenancy-stance-unmarked`, with an `#inherited` variant when an abstract base already declared one). The other gates: `loom.tenancy-duplicate`, `loom.tenancy-conflicting-stance`, `loom.tenancy-inherited-stance-conflict`, `loom.tenancy-claim-type-mismatch`, `loom.tenant-owned-claim-type`, `loom.tenant-owned-without-tenancy`, `loom.cross-tenant-without-tenancy` (warning), `loom.tenant-registry-without-tenancy`, `loom.tenancy-registry-duplicate`, `loom.tenancy-registry-not-target`, `loom.tenancy-registry-marked`, `loom.orgpath-without-tenancy`, and `loom.unique-missing-tenant-scope` (a `unique` on a tenant-owned aggregate that omits the discriminator is a *global* unique — usually a bug). A seed row on a tenant-owned aggregate must use `seed <dataset> raw { … }`, because the domain create path stamps from a principal a first-boot seeder does not have (`loom.seed-tenant-owned-needs-raw`).

Declaration syntax also appears in [Systems & deployables](02-systems-and-topology.md#tenancy-by-userclaim-of-registry); the full design — registry bootstrap, per-backend filters, the hierarchy — is [`../tenancy.md`](../tenancy.md).

## `sensitive(...)` — field tagging

A property carries `sensitive(tag, …)` (`pii`/`phi`/`cred`/`audited` by convention — any identifiers; multiple tags allowed) to declare it holds protected data. The load-bearing effect today is **redaction in the auto-generated `inspect` form**: the field prints as `<redacted>` in structural stringification, so it never lands in a log line or stack dump. The value still rides the wire normally — `sensitive` is a logging tag, not a wire-exclusion or read-mask (that is `mask unless`).

```ddd
aggregate Ticket {
  subject: string
  ssn: string sensitive(pii)
}
```

::: tabs backend
== node
```ts
// domain/ticket.ts — auto-generated inspect; ssn is redacted, salary is not
get inspect(): string { return "Ticket(" + "id: " + String(this._id) + ", " + "subject: " + "'" + this._subject + "'"
  + ", " + "ssn: " + "<redacted>" + ", " + "salary: " + String(this._salary) + /* … */ ")"; }
```
== elixir
```elixir
# lib/api_elixir/support/ticket.ex
string("Ticket(" <> "id: " <> to_string(record.id) <> ", " <> "subject: " <> "'" <> record.subject <> "'"
  <> ", " <> "ssn: " <> "<redacted>" <> # …
)
```
::: end

> All five backends emit the same redaction in their auto-`inspect`; a user-supplied `inspect` derived opts out and is rendered verbatim. Same rule as [reserved `inspect`](07-invariants-derived-functions.md#reserved-display-and-inspect).

## Errors

| Situation | Diagnostic |
| --- | --- |
| `auth { … }` block without a `user` block | `loom.auth-without-user` |
| `auth: required` deployable but no `user` block | `loom.auth-no-user-block` |
| Two `auth` blocks / two `user` blocks / two fields same name | `loom.duplicate-auth-block` / `loom.duplicate-user-block` / `loom.user-duplicate-field` |
| Unknown `provider:` / self-hosted provider without `oidc { issuer }` / no `clientId` / unknown `claims:` target | `loom.auth-unknown-provider` / `loom.auth-missing-issuer` / `loom.auth-missing-client-id` / `loom.auth-unknown-claim-field` |
| `auth: ui` on a backend / at an open target / on an unsupported framework | `loom.auth-ui-misplaced` / `loom.auth-ui-target-open` / `loom.auth-ui-unsupported-framework` |
| Two permissions same name in one subdomain | `loom.duplicate-permission` |
| `permissions.X` undeclared (or used outside any subdomain) | `loom.unknown-permission` |
| `implies` targets itself / an undeclared name | `loom.permission-implies-self` / `loom.permission-implies-unknown` |
| Policy function: bad arity / non-`bool` return / reference cycle | `loom.policy-fn-arity` / `loom.policy-fn-return-type` / `loom.policy-fn-cycle` |
| `policy { … }` rule problems (unknown target, non-tenant-owned, duplicate, missing hierarchy, `write global`, write wider than read, dead allow) | `loom.policy-unknown-aggregate`, `loom.policy-deny-unknown-aggregate`, `loom.policy-target-not-tenant-owned`, `loom.policy-duplicate-target`, `loom.policy-deny-duplicate`, `loom.policy-level-requires-hierarchy`, `loom.policy-write-global-invalid`, `loom.policy-write-wider-than-read`, `loom.policy-deny-shadows-allow` |
| `mask unless` references a row field / an unsupported backend / a projection source | `loom.field-mask-not-current-user` / `loom.field-mask-unsupported` / `loom.field-mask-projection-source` |
| `currentUser` in an invariant / derived / function body | `loom.currentuser-not-in-request-scope` |
| A read gate (find / projection / workflow header) references a row field | `loom.find-gate-not-current-user` / `loom.projection-gate-not-current-user` / `loom.workflow-gate-not-current-user` |
| Workflow body calls a `currentUser`-bound find | `loom.workflow-currentuser-find` |
| Ungated client-reachable surface under `denyByDefault` / ungated `audited` history | `loom.default-deny-ungated` / `loom.audit-history-ungated` |
| A gate or a principal stamp on a deployable without auth | `loom.guard-principal-without-auth` / `loom.stamp-principal-without-auth` |
| A page reads `currentUser` on a deployable with no session binding | `loom.current-user-needs-auth-ui` |
| Tenancy stance / registry / claim-type problems | `loom.tenancy-*`, `loom.tenant-owned-*`, `loom.tenant-registry-without-tenancy`, `loom.cross-tenant-without-tenancy`, `loom.orgpath-without-tenancy`, `loom.unique-missing-tenant-scope` |

See [`../auth.md`](../auth.md) for the per-backend file layouts, the OIDC handshake route table, PKCE + refresh rotation, the bypass list, and the `auth: ui` frontend gate; [`../tenancy.md`](../tenancy.md) for the full multi-tenancy design.
