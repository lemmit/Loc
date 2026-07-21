# 17. Authentication & authorization

Identity and access for a Loom system: the system-scope `user` JWT claim shape, the `auth` OIDC config that fills the per-backend verifier seam, the per-subdomain `permissions` catalogue, the `requires` authorization gate (HTTP 403), the magic `currentUser` identifier, and `sensitive(...)` field tagging. Reach for this chapter when a command must check *who* the caller is — distinct from `precondition`, which checks *what state* the aggregate is in. Loom owns no auth runtime: declaring this surface generates the typed `User`, the middleware, and the verifier hook; you (or the generated OIDC verifier) supply the token decoding.

> **Grammar:** `UserBlock`, `AuthBlock`, `OidcConfig`, `ClaimsMap`, `PermissionsBlock`, `RequiresStmt`, `RequiresProp`, `Sensitive` · **Validators:** `loom.auth-without-user`, `loom.duplicate-user-block`, `loom.user-duplicate-field`, `loom.duplicate-permission`, `loom.unknown-permission`, `loom.currentuser-not-in-request-scope`, `loom.default-deny-ungated`, `loom.workflow-currentuser-find`, `loom.auth-unknown-provider`, `loom.auth-missing-issuer`, `loom.auth-unknown-claim-field` · **Docs:** [`../auth.md`](../auth.md)

All five backends emit auth files. The middleware, verifier seam, `requires`→403 mapping, and `permissions.<name>` lowering are structurally identical across them — the divergence is host-language syntax and, for Elixir, the topology (a plug/guard in the context boundary instead of an inline throw). The frontends consume only the session probe; their `auth: ui` page gate is covered in [UI pages](15-ui-pages-structure.md) and [`../auth.md`](../auth.md#ui-gate--page--requires-expr-).

The single example below threads every feature; each section excerpts the line it produces.

```ddd
system Helpdesk {
  user {
    id: string
    role: string
    permissions: string[]
    tenantId: string
  }

  subdomain Support {
    permissions { ticketsClose, ticketsReassign }

    context Support {
      enum TicketStatus { Open, Pending, Closed }

      aggregate Ticket {
        tenantId: string
        subject: string
        ssn: string sensitive(pii)
        status: TicketStatus
        assignee: string

        operation close() {
          requires currentUser.role == "agent"
                || currentUser.permissions.contains(permissions.ticketsClose)
          precondition status != Closed
          status := Closed
        }
      }

      repository Tickets for Ticket {
        find mine(): Ticket[] where assignee == currentUser.id
      }
    }
  }

  storage primary { type: postgres }
  resource ticketsState { for: Support, kind: state, use: primary }

  deployable api {
    platform: dotnet           // one per backend in the real fixture
    contexts: [Support]
    dataSources: [ticketsState]
    auth: required
  }
}
```

## `user` — the JWT claim shape

`user { field: Type … }` at **system scope** declares the strongly-typed claim record the verifier decodes per request. Exactly one per system; a duplicate is `loom.duplicate-user-block`, a repeated field `loom.user-duplicate-field`. `id` and `permissions` are admissible field names (the grammar reserves them as `UserFieldName`). Every `currentUser.<field>` reference type-checks against this block. It is emitted as a plain record/struct — no behaviour.

```ddd
user {
  id: string
  role: string
  permissions: string[]
  tenantId: string
}
```

::: tabs backend
== node
```ts
// auth/user-types.ts
export interface User {
  id: string;
  role: string;
  permissions: string[];
  tenantId: string;
}
```
== dotnet
```csharp
// Auth/User.cs
public sealed record User(string Id, string Role, List<string> Permissions, string TenantId);
```
== java
```java
// auth/User.java
public record User(String id, String role, List<String> permissions, String tenantId) {}
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
```
== elixir
```elixir
# The user shape is a plain map; build_user/1 in auth.ex projects claims onto it.
%{id: ..., role: ..., permissions: [...], tenant_id: ...}
```
::: end

## `auth: required` — per-deployable middleware + verifier seam

A `user` block declares the shape; `auth: required` on a **deployable** opts that deployable into the JWT-decode middleware. Without it the deployable stays open (existing behaviour). With it but no `user` block, `loom.auth-without-user` fires. The middleware decodes the token via a verifier hook you register, stashes the principal on the request context, and 401s on failure. A shared bypass list (`/health`, `/ready`, `/openapi.json`, `/swagger`, the OIDC handshake paths) keeps framework endpoints anonymous so smoke tests and the OpenAPI parity check work without tokens — pin the middleware file in `.loomignore` to widen or tighten it.

::: tabs backend
== node
```ts
// auth/middleware.ts — mounted in http/index.ts as app.use("*", authMiddleware)
export const authMiddleware = createMiddleware<{ Variables: { currentUser: User } }>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  for (const prefix of BYPASS_PREFIXES) { if (path.startsWith(prefix)) { await next(); return; } }
  let user: User;
  try { user = await verifyUserOrThrow(c.req.raw); }
  catch { return c.json({ error: "unauthorized" }, 401); }
  const ctx = requestContext();
  if (ctx) ctx.currentUser = user;
  c.set("currentUser", user);
  await next();
});
```
The verifier hook is a registry you fill at startup:
```ts
// auth/verifier.ts
export function registerUserVerifier(fn: UserVerifier): void { registered = fn; }
export async function verifyUserOrThrow(req: Request): Promise<User> { /* throws 401 when unregistered or null */ }
```
== dotnet
```csharp
// Auth/UserMiddleware.cs — UseMiddleware<UserMiddleware>() between UseSwagger() and MapControllers()
public async Task InvokeAsync(HttpContext ctx, IUserVerifier verifier)
{
    var path = ctx.Request.Path.Value ?? "/";
    foreach (var prefix in BypassPrefixes)
        if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { await _next(ctx); return; }
    User? user;
    try { user = await verifier.VerifyAsync(ctx, ctx.RequestAborted); }
    catch { ctx.Response.StatusCode = 401; await ctx.Response.WriteAsync("unauthorized"); return; }
    if (user is null) { ctx.Response.StatusCode = 401; await ctx.Response.WriteAsync("unauthorized"); return; }
    if (RequestContext.Current is { } rc) rc.CurrentUser = user;
    await _next(ctx);
}
```
`Program.cs` registers `ICurrentUserAccessor` + `IHttpContextAccessor` and fails fast at startup if no `IUserVerifier` is registered. You implement `IUserVerifier` (or use the generated `OidcUserVerifier`).
== java
```java
// auth/UserFilter.java — a servlet filter; auth/UserVerifier.java is the seam,
// auth/CurrentUserAccessor.java exposes the principal to services.
```
== python
```python
# app/auth/middleware.py — Starlette middleware; app/auth/verifier.py is the seam.
```
== elixir
```elixir
# auth.ex — a Plug mounted in the :api pipeline.
def call(conn, _opts) do
  if bypass_path?(conn.request_path), do: conn, else:
    case verify_token(extract_token(conn)) do
      {:ok, claims} -> assign(conn, :current_user, build_user(claims))
      _ -> send_unauthorized(conn)
    end
end
```
::: end

> Missing-verifier registration surfaces at **runtime startup**, not generation — the project compiles, but boots with a clear error pointing at the registration line that must exist.

## `auth { … }` — OIDC config

`auth { … }` is a system-scope sibling of `user`: the user block declares the claim *shape*, this declares *who issues* the token and how its claims map onto that shape. It generates a real token verifier (filling the per-backend verifier seam, so you don't hand-write one) plus the `/api/auth/{login,callback,logout,me}` redirect handshake. At most one per system, and only admissible alongside a `user` block.

- `provider:` — a preset name (`keycloak`/`custom` are the self-hosted path; they require an explicit `oidc { issuer: … }`, else `loom.auth-missing-issuer`).
- `oidc { issuer, clientId, clientSecret, audience, scopes: […] }` — values are a `"literal"` or `env("VAR")` (secrets never land in source).
- `sessions: cookie | jwt`, `enforcement: opt | denyByDefault` (see below).
- `claims: { field: "dotted.claim.path" }` — maps an IdP claim path onto a `user` field; an unknown field is `loom.auth-unknown-claim-field`.

```ddd
auth {
  provider: keycloak
  oidc {
    issuer: env("OIDC_ISSUER")
    clientId: "helpdesk-web"
    clientSecret: env("OIDC_CLIENT_SECRET")
    scopes: ["openid", "profile"]
  }
  sessions: cookie
  claims: {
    role: "realm_access.roles",
    permissions: "resource_access.helpdesk.roles"
  }
}
```

The `claims:` map drives the generated verifier's claim projection — the dotted paths are read off the verified payload and mapped onto the `User` shape:

::: tabs backend
== node
```ts
// auth/oidc.ts — validates signature (JWKS), issuer, then projects claims
function toUser(payload: JWTPayload): User {
  return {
    id: claim(payload, "sub") as string,
    role: claim(payload, "realm_access.roles") as string,
    permissions: claim(payload, "resource_access.helpdesk.roles") as string[],
    tenantId: claim(payload, "tenantId") as string,
  };
}
```
The issuer's JWKS is discovered lazily via `/.well-known/openid-configuration` and cached; `ISSUER` reads `process.env.OIDC_ISSUER` at boot. `registerOidcVerifier()` wires it in.
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
# auth.ex
defp build_user(claims) do
  %{
    id: get_claim(claims, "sub"),
    role: get_claim(claims, "realm_access.roles"),
    permissions: get_claim(claims, "resource_access.helpdesk.roles") || [],
    tenant_id: get_claim(claims, "tenant_id")
  }
end
```
::: end

The handshake routes mount under `/api/auth` alongside the domain routes (one `/api → backend` proxy rule covers both). `generate system` also emits a `keycloak/realm.json` for a local IdP. Set `OIDC_REDIRECT_URI` to a `…/api/auth/callback` URL when overriding the default. Full route table in [`../auth.md`](../auth.md#auth-routes).

## `permissions` — a typed catalogue

`permissions { name, … }` lives at **subdomain** scope. Each declared name becomes a typed identifier `permissions.<name>` usable in any expression body resolving through the enclosing subdomain. It lowers to a **stable string literal** `<lowercase-subdomain>.<name>` — so `permissions.ticketsClose` inside `subdomain Support` is `"support.ticketsClose"` everywhere, on both sides of the wire. Backends never see a `Permission` type; the runtime is a `string[]` membership check. Multiple blocks in one subdomain merge; a duplicate name is `loom.duplicate-permission`, and an undeclared (or cross-subdomain) reference is `loom.unknown-permission`.

```ddd
permissions { ticketsClose, ticketsReassign }
// … later, in an operation body:
currentUser.permissions.contains(permissions.ticketsClose)
```

`.contains(x)` is a collection op (joining `count`/`sum`/`all`/`any`/`where`/`first`/`firstOrNull`) admissible on **any** array, not just `currentUser.permissions`. It renders as the host's idiomatic membership test:

::: tabs backend
== node
```ts
(currentUser.permissions).includes("support.ticketsClose")
```
== dotnet
```csharp
(currentUser.Permissions).Contains("support.ticketsClose")
```
== java
```java
currentUser.permissions().contains("support.ticketsClose")
```
== python
```python
"support.ticketsClose" in current_user.permissions
```
== elixir
```elixir
Enum.member?(current_user.permissions, "support.ticketsClose")
```
::: end

## `requires` — the authorization gate (HTTP 403)

`requires <expr>` is a declarative authorization gate at the top of an operation or workflow body. Its `bool` expression may reference `currentUser`, `permissions.<name>`, parameters, `this.<field>`, and any `function`. Failure maps to **HTTP 403** (`ForbiddenError`/`ForbiddenException`) — deliberately distinct from `precondition`'s **400**, so caller-authorization and aggregate-state-validity don't share an error class.

| Statement | HTTP | Failure means |
| --- | --- | --- |
| `requires` | 403 | The caller isn't authorized to invoke this op. |
| `precondition` | 400 | The request/aggregate state is invalid for this op. |

```ddd
operation close() {
  requires currentUser.role == "agent"
        || currentUser.permissions.contains(permissions.ticketsClose)
  precondition status != Closed
  status := Closed
}
```

The gate lowers to a guarded throw at the top of the operation; the per-route catch maps the forbidden error to 403. The operation method picks up a trailing `currentUser` parameter (only when it references `currentUser` — no DI noise otherwise), and the route/handler threads the verified principal in.

::: tabs backend
== node
```ts
// domain/ticket.ts
public close(currentUser: User): void {
  if (!(currentUser.role === "agent" || (currentUser.permissions).includes("support.ticketsClose")))
    throw new ForbiddenError("Forbidden: currentUser.role == \"agent\" …");
  if (!(this._status !== TicketStatus.Closed)) throw new DomainError("Precondition failed: status != Closed");
  this._status = TicketStatus.Closed;
  this._assertInvariants();
}
```
```ts
// http/ticket.routes.ts — route reads the principal off the context, catch → 403
const currentUser = c.get("currentUser") as User;
aggregate.close(currentUser);
// …
if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);
```
== dotnet
```csharp
// Domain/Tickets/Ticket.cs
public void Close(User currentUser)
{
    if (!(currentUser.Role == "agent" || (currentUser.Permissions).Contains("support.ticketsClose")))
        throw new ForbiddenException("Forbidden: currentUser.role == \"agent\" …");
    if (!(this.Status != TicketStatus.Closed)) throw new DomainException("Precondition failed: status != Closed");
    Status = TicketStatus.Closed;
    AssertInvariants();
}
```
The Mediator handler injects `ICurrentUserAccessor` and passes `_currentUser.User`; an exception filter maps `ForbiddenException` → 403.
== java
```java
// features/tickets/Ticket.java
public void close(User currentUser) {
    if (!(Objects.equals(currentUser.role(), "agent") || currentUser.permissions().contains("support.ticketsClose")))
        throw new ForbiddenException("Forbidden: currentUser.role == \"agent\" …");
    if (!(this.status != TicketStatus.Closed)) throw new DomainException("Precondition failed: status != Closed");
    this.status = TicketStatus.Closed;
    this._assertInvariants();
}
```
```java
// TicketService injects CurrentUserAccessor; ApiExceptionAdvice maps the throw to 403:
@ExceptionHandler(ForbiddenException.class)
public ResponseEntity<ProblemDetail> onForbidden(ForbiddenException e, WebRequest request) {
    return respond(problem(403, "Forbidden", e.getMessage(), request), 403);
}
```
== python
```python
# app/domain/ticket.py
def close(self, current_user: User) -> None:
    if not (current_user.role == "agent" or "support.ticketsClose" in current_user.permissions):
        raise ForbiddenError("Forbidden: currentUser.role == \"agent\" …")
    if not (self._status != TicketStatus.Closed):
        raise DomainError("Precondition failed: status != Closed")
    self._status = TicketStatus.Closed
    self._assert_invariants()
```
== elixir
```elixir
# The Elixir backend lowers `requires` to an authorization guard in the context
# boundary — the guard returns {:error, :forbidden} (→ 403) when no clause passes.
defp authorize_close(current_user) do
  if current_user.role == "agent" or
       Enum.member?(current_user.permissions, "support.ticketsClose") do
    :ok
  else
    {:error, :forbidden}
  end
end
# … on the context function:
def close(id, current_user) do
  with :ok <- authorize_close(current_user) do
    # … perform the update
  end
end
```
::: end

`requires` is admissible in workflow bodies the same way. A repository `find` and a `page` accept a `requires` gate too (read-side analogue), but those are **`currentUser`-only**. Default-deny enforcement (`auth { enforcement: denyByDefault }`) makes every client-reachable command without a `requires` gate a `loom.default-deny-ungated` error; `requires true` is the explicit "intentionally public" escape. The default (`opt`) leaves ungated commands open. See [`../auth.md`](../auth.md#requires-clauses-slice-2) for the full enforcement story.

## `currentUser` — claim access in domain logic

`currentUser` is a magic identifier resolving to the typed `User`, in scope wherever an expression evaluates **per request**. It is admissible in operation/workflow bodies, aggregate `test` bodies, and — since slice 1C — repository `find` `where` clauses. It is a compile error (`loom.currentuser-not-in-request-scope`) in an invariant, derived property, or `function` body (those can run outside a request).

In a `find`, the renderer threads the resolved user through the generated method as a closure-captured parameter; the caller reads it off the request context:

```ddd
repository Tickets for Ticket {
  find mine(): Ticket[] where assignee == currentUser.id
}
```

::: tabs backend
== node
```ts
// db/repositories/ticket-repository.ts — currentUser is a method param, parametrised into the SQL bind
async mine(currentUser: User): Promise<Ticket[]> {
  const rootRows = await this.db.select().from(schema.tickets)
    .where(eq(schema.tickets.assignee, currentUser.id));
  // …
}
```
```ts
// http/ticket.routes.ts — route threads the principal in
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
# Ecto query function with a currentUser-bound filter — current_user is threaded in
def mine(current_user) do
  Repo.all(from t in Ticket, where: t.assignee == ^current_user.id)
end
```
::: end

> Slice 1C does **not** yet let a workflow body call a `currentUser`-bound find — `loom.workflow-currentuser-find` points you at `getById` (explicit id) or the route layer. Honest gap.

## `sensitive(...)` — field tagging

A field carries `sensitive(tag, …)` (`pii`/`phi`/`cred`/`audited`, any identifiers) to declare it holds protected data. Today the load-bearing effect is **redaction in the auto-generated `inspect`/debug form**: a sensitive field prints as `<redacted>` in the structural stringification, so it never lands in a log line or stack dump via the default `toString`. (A user-supplied `inspect` derived opts out — it is rendered verbatim.) The value still rides the wire response normally — `sensitive` is not a wire-exclusion tag.

```ddd
aggregate Ticket {
  subject: string
  ssn: string sensitive(pii)
}
```

::: tabs backend
== node
```ts
// domain/ticket.ts — auto-generated inspect; ssn is redacted
get inspect(): string {
  return "Ticket(" + "id: " + String(this._id) + ", " + "subject: " + "'" + this._subject + "'"
    + ", " + "ssn: " + "<redacted>" + /* … */ ")";
}
```
== elixir
```elixir
# ticket.ex — module inspect/1
def inspect(record) do
  "Ticket(" <> "id: " <> to_string(record.id) <> ", " <> "subject: " <> "'" <> record.subject <> "'"
    <> ", " <> "ssn: " <> "<redacted>" <> # …
end
```
::: end

> `sensitive` redaction rides the same auto-`inspect` rule as [reserved `inspect`](07-invariants-derived-functions.md#reserved-display-and-inspect). The other backends emit their own auto-`inspect` with the same redaction.

## Errors

| Situation | Diagnostic |
| --- | --- |
| `auth: required` deployable but no `user` block | `loom.auth-without-user` |
| Two `user` blocks / two fields same name | `loom.duplicate-user-block` / `loom.user-duplicate-field` |
| Two permissions same name in one subdomain | `loom.duplicate-permission` |
| `permissions.X` undeclared (or used outside any subdomain) | `loom.unknown-permission` |
| `currentUser` in an invariant / derived / function body | `loom.currentuser-not-in-request-scope` |
| Ungated client-reachable command under `denyByDefault` | `loom.default-deny-ungated` |
| Workflow body calls a `currentUser`-bound find | `loom.workflow-currentuser-find` |
| `auth { provider: ? }` unknown / `oidc` missing issuer / unknown `claims:` field | `loom.auth-unknown-provider` / `loom.auth-missing-issuer` / `loom.auth-unknown-claim-field` |

See [`../auth.md`](../auth.md) for the per-backend file layouts, the OIDC handshake route table, the bypass list, and the `auth: ui` frontend gate.
