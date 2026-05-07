# Auth + `currentUser` (slice 1A)

Loom systems can declare a strongly-typed JWT claim shape at system
scope and opt deployables in to JWT-decode middleware per request.
Slice 1A ships the **plumbing**: the user shape, the `currentUser`
magic identifier, the verifier hook, and the middleware mount.

What's intentionally **not** here yet:

- Per-module `permissions { ... }` and typed `permissions.X` refs
  (slice 1B).
- `currentUser` inside `where` clauses on repository finds / view
  filters (slice 1C; the validator currently rejects this with a
  pointer to the slice).
- `requires <expr>` clauses that gate command entry against
  currentUser claims (slice 2).

## Surface

```ddd
system Acme {
  user {
    id: string
    role: string
    customerId: Id<Customer>?
    tenantId: string
  }

  module Sales {
    context Orders {
      enum OrderStatus { Draft, Confirmed, Cancelled }

      aggregate Order {
        customerId: Id<Customer>
        status: OrderStatus

        // currentUser is in scope inside operation bodies.  The
        // precondition runs per request; failure throws
        // DomainException → 400 from the framework filter.
        operation cancel() {
          precondition currentUser.role == "manager"
                    || currentUser.customerId == this.customerId
          status := Cancelled
        }
      }

      repository Orders for Order { }
    }
  }

  // Per-deployable opt-in.  Without `auth: required` the deployable
  // stays open (existing behaviour).
  deployable api {
    platform: dotnet
    modules: Sales
    port: 8080
    auth: required
  }
}
```

`currentUser` is in scope wherever an expression evaluates **per
request**:

| Context | `currentUser` allowed? |
| --- | --- |
| Operation body (preconditions, assignments, calls, emits) | ✅ |
| Workflow body | ✅ |
| Aggregate-level `test` body | ✅ |
| View `bind` expressions (full-form views) | ✅ |
| Aggregate / part / value-object invariant | ❌ |
| Derived property | ❌ |
| `function` body | ❌ |
| Repository `find` `where` clause | ❌ (slice 1C) |
| View shorthand / full-form `where` clause | ❌ (slice 1C) |

The validator surfaces a friendly diagnostic for any disallowed use.

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

## Bypass list

Both backends bypass auth on these paths so docker-compose health
checks, OpenAPI clients, and Swagger UI work without tokens:

- `/health`
- `/openapi.json`
- `/swagger` (and any `/swagger/...` subpath)

Pin the per-platform middleware file in `.loomignore` if you need
to widen or tighten the list.

## Errors

| Situation | Diagnostic |
| --- | --- |
| `auth: required` on a deployable but no `user { ... }` block | Validation error: "deployable 'X' has 'auth: required' but system 'Y' declares no 'user { ... }' block." |
| Two user fields with the same name | Validation error: "user block declares field 'X' more than once." |
| `currentUser` in an invariant / derived / function / find filter | Validation error: "currentUser is only available in per-request handlers." |

Missing `IUserVerifier` registration surfaces at runtime startup,
not during generation — the project compiles, but boots with a
clear `InvalidOperationException` pointing you at the
`AddScoped<IUserVerifier, ...>` line that needs to exist.
