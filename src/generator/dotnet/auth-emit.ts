import type {
  AuthIR,
  AuthValueIR,
  FieldIR,
  SystemIR,
  TypeIR,
  UserIR,
} from "../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../util/api-base.js";
import { upperFirst } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// .NET auth scaffolding emitted per deployable when `auth: required`.
// Five small files, each tightly scoped:
//
//   Auth/User.cs                          — strongly-typed claim record
//   Auth/IUserVerifier.cs                 — verifier hook interface
//   Auth/ICurrentUserAccessor.cs          — request-scoped accessor
//   Auth/HttpContextCurrentUserAccessor.cs — facade reading the principal
//                                            slice of the ambient
//                                            RequestContext
//   Auth/UserMiddleware.cs                — JWT decode middleware that
//                                            calls IUserVerifier and
//                                            attaches the resolved user
//                                            to the ambient RequestContext
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
  out.set("Auth/UserMiddleware.cs", renderMiddleware(ns, !!sys.auth));
  out.set("Auth/DevStubUserVerifier.cs", renderDevStubVerifier(sys.user, ns));
  // OIDC turnkey auth (D-AUTH-OIDC): the generated verifier that validates
  // the IdP's tokens against its JWKS and maps claims onto User — the
  // batteries-included fill-in for the IUserVerifier seam.  Registered
  // automatically in Program.cs (last-wins over the dev stub).  The
  // /auth/* redirect handshake mounts the login flow.
  if (sys.auth) {
    out.set("Auth/OidcUserVerifier.cs", renderOidcVerifier(sys.user, sys.auth, ns));
    out.set("Auth/AuthHandshake.cs", renderHandshake(sys.auth, ns));
  }
}

/** Render an `AuthValueIR` (literal | env reference) as a C# expression. */
function csAuthValue(v: AuthValueIR | undefined, fallback = '""'): string {
  if (!v) return fallback;
  return v.kind === "literal"
    ? JSON.stringify(v.value)
    : `Environment.GetEnvironmentVariable(${JSON.stringify(v.env)}) ?? ""`;
}

/** `env-var ?? declared` — the canonical deploy-env var overrides the
 *  declared auth value (12-factor: the generated compose repoints
 *  OIDC_ISSUER / OIDC_CLIENT_ID at the bundled dev Keycloak; a baked
 *  literal issuer 401s every bundled-IdP token).  A declared env-kind
 *  value reading the same var stays a single read. */
function csEnvOverridable(envVar: string, v: AuthValueIR | undefined): string {
  if (v?.kind === "env" && v.env === envVar) return csAuthValue(v);
  return `Environment.GetEnvironmentVariable(${JSON.stringify(envVar)}) ?? ${csAuthValue(v)}`;
}

/** The IdP claim path projected onto a given user field — explicit
 *  `claims:` mapping wins; `id` defaults to `sub`, others read their name. */
function claimPathFor(field: string, auth: AuthIR): string {
  const mapped = auth.claims.find((c) => c.field === field);
  if (mapped) return mapped.path;
  return field === "id" ? "sub" : field;
}

/** The User-constructor argument expression reading a field from the
 *  verified token payload.  string / string[] are mapped; other field
 *  types fall back to `default!` (a documented .NET OIDC limitation —
 *  use string / string[] claims). */
function csClaimRead(f: FieldIR, auth: AuthIR): string {
  const param = upperFirst(f.name);
  const path = JSON.stringify(claimPathFor(f.name, auth));
  const t = f.type;
  if (t.kind === "array" && t.element.kind === "primitive" && t.element.name === "string") {
    return `${param}: ClaimStringList(payload, ${path})`;
  }
  if (t.kind === "primitive" && t.name === "string") {
    return f.optional
      ? `${param}: ClaimString(payload, ${path})`
      : `${param}: ClaimString(payload, ${path}) ?? string.Empty`;
  }
  return `${param}: default!`;
}

function renderOidcVerifier(user: UserIR, auth: AuthIR, ns: string): string {
  // Deploy env overrides the declared value — see csEnvOverridable (the
  // 401-from-the-bundled-IdP failure mode caught live by the parity 403 test).
  const issuerExpr = csEnvOverridable("OIDC_ISSUER", auth.oidc.issuer);
  // Audience is optional: an explicit `audience:` validates that value;
  // otherwise default to the OIDC_AUDIENCE env var (null when unset → audience
  // validation is skipped).  An env read (not a literal null) keeps CA1805 /
  // CA5404 / CA1508 quiet.
  const audienceExpr = auth.oidc.audience
    ? csEnvOverridable("OIDC_AUDIENCE", auth.oidc.audience)
    : 'Environment.GetEnvironmentVariable("OIDC_AUDIENCE")';
  const args = user.fields.map((f) => csClaimRead(f, auth)).join(",\n            ");
  return `// Auto-generated.
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace ${ns}.Auth;

/// <summary>Generated OIDC verifier (D-AUTH-OIDC).  Validates the bearer
/// token's signature against the issuer's JWKS (discovered + cached via
/// <see cref="ConfigurationManager{T}"/>), checks iss / aud / exp, then
/// projects the configured claims onto the <see cref="User"/> shape.
/// Returns null to reject (→ 401).</summary>
public sealed class OidcUserVerifier : IUserVerifier
{
    private static readonly string Issuer = (${issuerExpr}).TrimEnd('/');
    private static readonly string? Audience = ${audienceExpr};
    private static readonly ConfigurationManager<OpenIdConnectConfiguration> Configuration =
        new(
            Issuer + "/.well-known/openid-configuration",
            new OpenIdConnectConfigurationRetriever(),
            // RequireHttps stays on for real (https) issuers; a plain-http
            // issuer (the bundled dev Keycloak / loopback) opts out so
            // discovery doesn't throw and reject every request.
            new HttpDocumentRetriever { RequireHttps = Issuer.StartsWith("https://", StringComparison.OrdinalIgnoreCase) });
    private static readonly JsonWebTokenHandler Handler = new();

    public async Task<User?> VerifyAsync(HttpContext httpContext, CancellationToken cancellationToken)
    {
        string? token = ExtractToken(httpContext.Request);
        if (token is null)
        {
            return null;
        }

        OpenIdConnectConfiguration configuration;
        try
        {
            configuration = await Configuration.GetConfigurationAsync(cancellationToken);
        }
#pragma warning disable CA1031 // a discovery failure rejects (401), never 500
        catch (Exception)
#pragma warning restore CA1031
        {
            return null;
        }

        var parameters = new TokenValidationParameters
        {
            ValidIssuer = Issuer,
            ValidateIssuer = true,
            IssuerSigningKeys = configuration.SigningKeys,
            ValidateIssuerSigningKey = true,
            ValidateAudience = Audience is not null,
            ValidAudience = Audience,
            ValidateLifetime = true,
        };

        TokenValidationResult result = await Handler.ValidateTokenAsync(token, parameters);
        if (!result.IsValid && result.Exception is SecurityTokenSignatureKeyNotFoundException)
        {
            // Key rotation: an unknown signing key may be a NEW key the IdP
            // rotated in after the configuration was cached.  RequestRefresh
            // marks the cache stale (internally rate-limited by
            // ConfigurationManager.RefreshInterval, so unknown-kid bursts
            // can't hammer the IdP); re-validate once against fresh keys.
            Configuration.RequestRefresh();
            try
            {
                configuration = await Configuration.GetConfigurationAsync(cancellationToken);
            }
#pragma warning disable CA1031 // a refresh failure rejects (401), never 500
            catch (Exception)
#pragma warning restore CA1031
            {
                return null;
            }
            parameters.IssuerSigningKeys = configuration.SigningKeys;
            result = await Handler.ValidateTokenAsync(token, parameters);
        }
        if (!result.IsValid)
        {
            return null;
        }

        // Re-parse the payload as JSON so dotted claim paths
        // (e.g. realm_access.roles) resolve — the flat claims dictionary
        // would lose the nesting.
        string[] segments = token.Split('.');
        if (segments.Length < 2)
        {
            return null;
        }
        JsonElement payload;
        try
        {
            using JsonDocument document = JsonDocument.Parse(Base64UrlEncoder.Decode(segments[1]));
            payload = document.RootElement.Clone();
        }
#pragma warning disable CA1031 // a malformed payload rejects (401), never 500
        catch (Exception)
#pragma warning restore CA1031
        {
            return null;
        }

        return new User(
            ${args});
    }

    /// <summary>The bearer token from the Authorization header, or the
    /// HttpOnly <c>session</c> cookie issued by the /auth/callback
    /// handshake (the browser flow).  Null when neither is present.</summary>
    private static string? ExtractToken(HttpRequest request)
    {
        string header = request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return header["Bearer ".Length..].Trim();
        }
        string? cookie = request.Cookies["session"];
        return string.IsNullOrEmpty(cookie) ? null : cookie;
    }

    private static string? ClaimString(JsonElement payload, string path)
    {
        JsonElement current = payload;
        foreach (string segment in path.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }
        return current.ValueKind == JsonValueKind.String ? current.GetString() : current.ToString();
    }

    private static List<string> ClaimStringList(JsonElement payload, string path)
    {
        var values = new List<string>();
        JsonElement current = payload;
        foreach (string segment in path.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return values;
            }
        }
        if (current.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement element in current.EnumerateArray())
            {
                string? value = element.ValueKind == JsonValueKind.String ? element.GetString() : element.ToString();
                if (value is not null)
                {
                    values.Add(value);
                }
            }
        }
        return values;
    }
}
`;
}

// ---------------------------------------------------------------------------
// OIDC redirect handshake (D-AUTH-OIDC) — /auth/login starts the
// authorization-code flow, /auth/callback exchanges the code + issues the
// session cookie, /auth/logout clears it.  No login form — the IdP hosts it.
// ---------------------------------------------------------------------------

function renderHandshake(auth: AuthIR, ns: string): string {
  // Env override first (12-factor) — same contract as the verifier's Issuer:
  // the generated compose repoints OIDC_ISSUER at the bundled dev Keycloak.
  const issuerExpr = csEnvOverridable("OIDC_ISSUER", auth.oidc.issuer);
  const clientIdExpr = csEnvOverridable("OIDC_CLIENT_ID", auth.oidc.clientId);
  // The secret is nullable (a public client has none): no `?? ""` so an
  // unset env stays null and the token request omits client_secret.  Default
  // to the OIDC_CLIENT_SECRET env var (an env read, not a literal null, so
  // CA1805 / CA1508 stay quiet).
  const secret = auth.oidc.clientSecret;
  const clientSecretExpr = secret
    ? secret.kind === "literal"
      ? JSON.stringify(secret.value)
      : `Environment.GetEnvironmentVariable(${JSON.stringify(secret.env)})`
    : 'Environment.GetEnvironmentVariable("OIDC_CLIENT_SECRET")';
  const scopes = auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"];
  const scopesLiteral = JSON.stringify(scopes.join(" "));
  return `// Auto-generated.
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace ${ns}.Auth;

/// <summary>OIDC redirect handshake (D-AUTH-OIDC).  <c>/auth/login</c> starts
/// the authorization-code flow, <c>/auth/callback</c> exchanges the code and
/// issues the local <c>session</c> cookie (read by OidcUserVerifier),
/// <c>/auth/logout</c> clears it.  No login form — the IdP hosts the
/// credential pages.</summary>
public static class AuthHandshake
{
    private static readonly string Issuer = (${issuerExpr}).TrimEnd('/');
    private static readonly string ClientId = ${clientIdExpr};
    private static readonly string? ClientSecret = ${clientSecretExpr};
    private static readonly string Scopes = ${scopesLiteral};
    private static readonly string RedirectUri =
        Environment.GetEnvironmentVariable("OIDC_REDIRECT_URI") ?? "http://localhost:8080${AUTH_BASE_PATH}/callback";
    private static readonly string PostLogin =
        Environment.GetEnvironmentVariable("OIDC_POST_LOGIN_REDIRECT") ?? "/";
    private static readonly ConfigurationManager<OpenIdConnectConfiguration> Configuration =
        new(
            Issuer + "/.well-known/openid-configuration",
            new OpenIdConnectConfigurationRetriever(),
            // RequireHttps stays on for real (https) issuers; a plain-http
            // issuer (the bundled dev Keycloak / loopback) opts out so
            // discovery doesn't throw and reject every request.
            new HttpDocumentRetriever { RequireHttps = Issuer.StartsWith("https://", StringComparison.OrdinalIgnoreCase) });
    private static readonly HttpClient Http = new();

    private static CookieOptions SessionCookie() =>
        new() { HttpOnly = true, SameSite = SameSiteMode.Lax, Path = "/" };

    /// <summary>Mount the /auth/* redirect handlers.  Excluded from the
    /// OpenAPI contract — they are redirects, not business operations.</summary>
    public static void MapAuthHandshake(this WebApplication app)
    {
        app.MapGet("${AUTH_BASE_PATH}/login", async (HttpContext ctx) =>
        {
            OpenIdConnectConfiguration config = await Configuration.GetConfigurationAsync(ctx.RequestAborted);
            string state = Guid.NewGuid().ToString("N");
            ctx.Response.Cookies.Append("oidc_state", state, SessionCookie());
            var query = new Dictionary<string, string?>
            {
                ["response_type"] = "code",
                ["client_id"] = ClientId,
                ["redirect_uri"] = RedirectUri,
                ["scope"] = Scopes,
                ["state"] = state,
            };
            return Results.Redirect(QueryHelpers.AddQueryString(config.AuthorizationEndpoint, query));
        }).ExcludeFromDescription();

        app.MapGet("${AUTH_BASE_PATH}/callback", async (HttpContext ctx) =>
        {
            string code = ctx.Request.Query["code"].ToString();
            string state = ctx.Request.Query["state"].ToString();
            if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(state) || state != ctx.Request.Cookies["oidc_state"])
            {
                return Results.Json(new { error = "invalid_state" }, statusCode: 400);
            }
            OpenIdConnectConfiguration config = await Configuration.GetConfigurationAsync(ctx.RequestAborted);
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["redirect_uri"] = RedirectUri,
                ["client_id"] = ClientId,
            };
            if (ClientSecret is not null)
            {
                form["client_secret"] = ClientSecret;
            }
            string accessToken;
            try
            {
                using var content = new FormUrlEncodedContent(form);
                using HttpResponseMessage response = await Http.PostAsync(new Uri(config.TokenEndpoint), content, ctx.RequestAborted);
                if (!response.IsSuccessStatusCode)
                {
                    return Results.Json(new { error = "token_exchange_failed" }, statusCode: 401);
                }
                string payload = await response.Content.ReadAsStringAsync(ctx.RequestAborted);
                using JsonDocument document = JsonDocument.Parse(payload);
                accessToken = document.RootElement.GetProperty("access_token").GetString() ?? string.Empty;
            }
#pragma warning disable CA1031 // any token-exchange failure → 401, never 500
            catch (Exception)
#pragma warning restore CA1031
            {
                return Results.Json(new { error = "token_exchange_failed" }, statusCode: 401);
            }
            ctx.Response.Cookies.Append("session", accessToken, SessionCookie());
            ctx.Response.Cookies.Delete("oidc_state");
            return Results.Redirect(PostLogin);
        }).ExcludeFromDescription();

        app.MapGet("${AUTH_BASE_PATH}/logout", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("session");
            return Results.Redirect(PostLogin);
        }).ExcludeFromDescription();
    }
}
`;
}

/** Permissive dev stub registered in Program.cs so a generated stack
 *  boots end-to-end without the caller having to wire a JWT decoder
 *  first.  Replace by registering your own IUserVerifier (the last DI
 *  registration wins for new scope resolutions). */
function renderDevStubVerifier(user: UserIR, ns: string): string {
  const args = user.fields
    .map((f) => `${upperFirst(f.name)}: ${stubCsharpValueFor(f)}`)
    .join(",\n            ");
  // Dev-claims override is limited to string-typed claims (the tenant-claim
  // case) — a JSON string maps cleanly onto a `string` property; non-string
  // fields keep their built-in value.
  const stringFields = user.fields.filter(
    (f) => !f.optional && f.type.kind === "primitive" && f.type.name === "string",
  );
  if (stringFields.length === 0) {
    return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace ${ns}.Auth;

/// <summary>Dev-stub verifier — accepts every request as a built-in user.
/// REPLACE for production by registering your own IUserVerifier (e.g.
/// builder.Services.AddScoped&lt;IUserVerifier, MyJwtVerifier&gt;()).</summary>
public sealed class DevStubUserVerifier : IUserVerifier
{
    public Task<User?> VerifyAsync(HttpContext httpContext, CancellationToken cancellationToken)
    {
        return Task.FromResult<User?>(new User(
            ${args}));
    }
}
`;
  }
  const arms = stringFields
    .map(
      (f) =>
        `                    "${f.name}" => prop.Value.ValueKind == JsonValueKind.String ? user with { ${upperFirst(f.name)} = prop.Value.GetString()! } : user,`,
    )
    .join("\n");
  return `// Auto-generated.
using System;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace ${ns}.Auth;

/// <summary>Dev-stub verifier — accepts every request as a built-in user.
/// Dev-only: override string claims (e.g. tenantId) by sending a base64-encoded
/// JSON object in the <c>x-loom-dev-claims</c> header — the same injection the
/// Hono dev stub honours.  REPLACE for production by registering your own
/// IUserVerifier (e.g. builder.Services.AddScoped&lt;IUserVerifier, MyJwtVerifier&gt;()).</summary>
public sealed class DevStubUserVerifier : IUserVerifier
{
    public Task<User?> VerifyAsync(HttpContext httpContext, CancellationToken cancellationToken)
    {
        var user = new User(
            ${args});
        var injected = httpContext.Request.Headers["x-loom-dev-claims"].ToString();
        if (string.IsNullOrEmpty(injected))
        {
            return Task.FromResult<User?>(user);
        }
        try
        {
            var payload = Encoding.UTF8.GetString(Convert.FromBase64String(injected));
            using var doc = JsonDocument.Parse(payload);
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                user = prop.Name switch
                {
${arms}
                    _ => user,
                };
            }
        }
        catch (Exception)
        {
            // Malformed dev-claims header → fall back to the built-in identity.
        }
        return Task.FromResult<User?>(user);
    }
}
`;
}

function stubCsharpValueFor(f: { name: string; type: TypeIR; optional: boolean }): string {
  if (f.optional) return "null";
  return stubCsharpValueForType(f.type);
}

function stubCsharpValueForType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return `"admin"`;
        case "int":
          return "0";
        case "long":
          return "0L";
        case "decimal":
        case "money":
          return "0m";
        case "bool":
          return "false";
        case "datetime":
          return "System.DateTime.UnixEpoch";
        case "guid":
          return "System.Guid.Empty";
        default:
          return `""`;
      }
    case "id":
      return "System.Guid.Empty";
    case "array":
      return `new System.Collections.Generic.List<${renderCsType(t.element)}>()`;
    default:
      return "null!";
  }
}

function renderUserRecord(user: UserIR, ns: string): string {
  const params = user.fields
    .map((f) => {
      const t = f.optional
        ? renderCsType({ kind: "optional", inner: f.type })
        : renderCsType(f.type);
      return `${t} ${upperFirst(f.name)}`;
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
    Task<User?> VerifyAsync(HttpContext httpContext, CancellationToken cancellationToken);
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
using ${ns}.Domain.Common;

namespace ${ns}.Auth;

/// <summary>Default implementation that reads the verified principal from
/// the ambient <see cref="RequestContext"/> — the single source of truth
/// for the request user.  UserMiddleware attaches it after the verifier
/// succeeds; this accessor exposes it as the typed <see cref="User"/>
/// claim per scoped request.</summary>
public sealed class HttpContextCurrentUserAccessor : ICurrentUserAccessor
{
    public User User
    {
        get
        {
            var rc = RequestContext.Current
                ?? throw new InvalidOperationException(
                    "ICurrentUserAccessor requires an active RequestContext — " +
                    "verify RequestContextMiddleware is mounted first.");
            return rc.CurrentUser
                ?? throw new InvalidOperationException(
                    "currentUser was not populated for this request — verify that " +
                    "UserMiddleware is mounted before MapControllers and that the " +
                    "request was authenticated.");
        }
    }
}
`;
}

function renderMiddleware(ns: string, oidc: boolean): string {
  // Bypass list — framework endpoints that should NEVER require auth.
  // Liveness / OpenAPI / Swagger UI all read freely.  Path-prefix
  // match keeps the list tiny and avoids regex overhead.  The OIDC
  // redirect handshake (/auth/login|callback|logout) joins it when an
  // `auth { oidc }` block is present — those must be reachable without a
  // verified principal; /auth/me stays protected.
  const handshakeBypass = oidc
    ? `
        "${AUTH_BASE_PATH}/login",
        "${AUTH_BASE_PATH}/callback",
        "${AUTH_BASE_PATH}/logout",`
    : "";
  return `// Auto-generated.
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using ${ns}.Domain.Common;

namespace ${ns}.Auth;

public sealed class UserMiddleware
{
    private static readonly string[] BypassPrefixes = new[]
    {
        "/health",
        "/ready",
        "/openapi.json",
        "/swagger",${handshakeBypass}
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
            if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
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
        // Attach the verified principal to the ambient frame opened by
        // RequestContextMiddleware — the single source of truth read by
        // ICurrentUserAccessor and every currentUser-aware handler.
        if (RequestContext.Current is { } rc) rc.CurrentUser = user;
        await _next(ctx);
    }
}
`;
}
