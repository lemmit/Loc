import type { SystemIR, UserIR } from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// .NET auth scaffolding emitted per deployable when `auth: required`.
// Five small files, each tightly scoped:
//
//   Auth/User.cs                          — strongly-typed claim record
//   Auth/IUserVerifier.cs                 — verifier hook interface
//   Auth/ICurrentUserAccessor.cs          — request-scoped accessor
//   Auth/HttpContextCurrentUserAccessor.cs — default IHttpContextAccessor
//                                            implementation
//   Auth/UserMiddleware.cs                — JWT decode middleware that
//                                            calls IUserVerifier and
//                                            stashes the resolved user
//                                            on the request scope
//
// The user supplies a class implementing `IUserVerifier`; the project
// fails fast at startup if no verifier is registered (Program.cs check).
// ---------------------------------------------------------------------------

export function emitAuthFiles(sys: SystemIR, ns: string, out: Map<string, string>): void {
  if (!sys.user) return;
  out.set("Auth/User.cs", renderUserRecord(sys.user, ns));
  out.set("Auth/IUserVerifier.cs", renderVerifierInterface(ns));
  out.set("Auth/ICurrentUserAccessor.cs", renderAccessorInterface(ns));
  out.set("Auth/HttpContextCurrentUserAccessor.cs", renderAccessorImpl(ns));
  out.set("Auth/UserMiddleware.cs", renderMiddleware(ns));
}

function renderUserRecord(user: UserIR, ns: string): string {
  const params = user.fields
    .map((f) => {
      const t = f.optional
        ? renderCsType({ kind: "optional", inner: f.type })
        : renderCsType(f.type);
      return `${t} ${pascal(f.name)}`;
    })
    .join(", ");
  return `// Auto-generated.
using ${ns}.Domain.Enums;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;

namespace ${ns}.Auth;

/// <summary>Strongly-typed claim shape decoded from the inbound
/// JWT.  Populated per request by <see cref="IUserVerifier"/> and
/// exposed to handlers via <see cref="ICurrentUserAccessor"/>.</summary>
public sealed record User(${params});
`;
}

function renderVerifierInterface(ns: string): string {
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace ${ns}.Auth;

/// <summary>User-supplied JWT verifier.  The middleware calls
/// <see cref="VerifyAsync"/> on every authenticated request.  Return
/// a populated <see cref="User"/> on success, or <c>null</c> /
/// <see cref="System.Threading.Tasks.Task.FromException"/> to reject
/// with a 401.</summary>
public interface IUserVerifier
{
    Task<User?> VerifyAsync(HttpContext httpContext, CancellationToken ct);
}
`;
}

function renderAccessorInterface(ns: string): string {
  return `// Auto-generated.
namespace ${ns}.Auth;

/// <summary>Scoped accessor that exposes the current request's
/// resolved <see cref="User"/>.  Mediator handlers / workflow
/// handlers / view-route handlers inject this and read
/// <see cref="User"/> when their body references the
/// <c>currentUser</c> magic identifier.</summary>
public interface ICurrentUserAccessor
{
    User User { get; }
}
`;
}

function renderAccessorImpl(ns: string): string {
  return `// Auto-generated.
using Microsoft.AspNetCore.Http;

namespace ${ns}.Auth;

/// <summary>Default implementation backed by
/// <see cref="IHttpContextAccessor"/>.  The middleware stashes the
/// resolved <see cref="User"/> on
/// <c>HttpContext.Items["currentUser"]</c>; this accessor reads it
/// back per scoped request.</summary>
public sealed class HttpContextCurrentUserAccessor : ICurrentUserAccessor
{
    private readonly IHttpContextAccessor _http;

    public HttpContextCurrentUserAccessor(IHttpContextAccessor http)
    {
        _http = http;
    }

    public User User
    {
        get
        {
            var ctx = _http.HttpContext
                ?? throw new System.InvalidOperationException(
                    "ICurrentUserAccessor requires an active HttpContext.");
            if (ctx.Items["currentUser"] is User u) return u;
            throw new System.InvalidOperationException(
                "currentUser was not populated for this request — verify that " +
                "UserMiddleware is mounted before MapControllers and that the " +
                "request was authenticated.");
        }
    }
}
`;
}

function renderMiddleware(ns: string): string {
  // Bypass list — framework endpoints that should NEVER require auth.
  // Liveness / OpenAPI / Swagger UI all read freely.  Path-prefix
  // match keeps the list tiny and avoids regex overhead.
  return `// Auto-generated.
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace ${ns}.Auth;

public sealed class UserMiddleware
{
    private static readonly string[] BypassPrefixes = new[]
    {
        "/health",
        "/ready",
        "/openapi.json",
        "/swagger",
    };

    private readonly RequestDelegate _next;

    public UserMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext ctx, IUserVerifier verifier)
    {
        var path = ctx.Request.Path.HasValue ? ctx.Request.Path.Value : "/";
        foreach (var prefix in BypassPrefixes)
        {
            if (path.StartsWith(prefix, System.StringComparison.OrdinalIgnoreCase))
            {
                await _next(ctx);
                return;
            }
        }
        User? user;
        try
        {
            user = await verifier.VerifyAsync(ctx, ctx.RequestAborted);
        }
        catch
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsync("unauthorized");
            return;
        }
        if (user is null)
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsync("unauthorized");
            return;
        }
        ctx.Items["currentUser"] = user;
        await _next(ctx);
    }
}
`;
}
