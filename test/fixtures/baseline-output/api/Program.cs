// Auto-generated.
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using FluentValidation;
using Api.Api;
using Api.Domain.Common;
using Api.Infrastructure.Persistence;
using Api.Infrastructure.Events;

var builder = WebApplication.CreateBuilder(args);

// Fail fast on a missing connection string.  Without this an unset
// ConnectionStrings__Default surfaces as a confusing
// "Cannot open connection" mid-request; we'd rather die at boot
// with a clear pointer to the env var.
{
    var connectionString = builder.Configuration.GetConnectionString("Default");
    if (string.IsNullOrWhiteSpace(connectionString))
    {
        throw new InvalidOperationException(
            "Missing connection string 'Default'. Set ConnectionStrings__Default " +
            "in the environment or appsettings.Development.json.");
    }
}

// Structured JSON logs.  Pairs with UseHttpLogging below to emit
// one line per inbound request with method/path/status, and pulls
// Activity.Current?.TraceId into every log scope so handler logs
// inherit the correlation id automatically.
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(opts =>
{
    opts.IncludeScopes = true;
    opts.JsonWriterOptions = new JsonWriterOptions
    {
        Indented = false,
    };
});
// Runtime log-level knob — read LOG_LEVEL (default "info") and map the
// catalog levels (trace/debug/info/warn/error) onto ASP.NET Core's
// LogLevel.  Distinct from the generate-time --trace switch.
builder.Logging.SetMinimumLevel((System.Environment.GetEnvironmentVariable("LOG_LEVEL") ?? "info").ToLowerInvariant() switch
{
    "trace" => Microsoft.Extensions.Logging.LogLevel.Trace,
    "debug" => Microsoft.Extensions.Logging.LogLevel.Debug,
    "warn" => Microsoft.Extensions.Logging.LogLevel.Warning,
    "error" => Microsoft.Extensions.Logging.LogLevel.Error,
    _ => Microsoft.Extensions.Logging.LogLevel.Information,
});

// Per-request HTTP log.  ASP.NET Core's built-in middleware records
// method/path on entry and status/duration on exit.  Combined with
// the JSON formatter above, every request shows up as a structured
// log line with the framework's TraceId field for correlation.
builder.Services.AddHttpLogging(opts =>
{
    opts.LoggingFields =
        Microsoft.AspNetCore.HttpLogging.HttpLoggingFields.RequestMethod |
        Microsoft.AspNetCore.HttpLogging.HttpLoggingFields.RequestPath |
        Microsoft.AspNetCore.HttpLogging.HttpLoggingFields.ResponseStatusCode |
        Microsoft.AspNetCore.HttpLogging.HttpLoggingFields.Duration;
});

builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Mediator (martinothamar/Mediator) — source-generated, free to use.
builder.Services.AddMediator(opts => opts.ServiceLifetime = ServiceLifetime.Scoped);

// FluentValidation — wire-boundary validators emitted per command in
// Application/<Aggregate>/Commands/<Cmd>CommandValidator.cs.  The
// pipeline behavior runs them before each handler; failures throw
// FluentValidation.ValidationException, which DomainExceptionFilter
// converts to a 400 with a structured `failures` array.  The
// existing domain-layer AssertInvariants() stays as the floor.
builder.Services.AddValidatorsFromAssembly(typeof(Program).Assembly);
builder.Services.AddScoped(
    typeof(Mediator.IPipelineBehavior<,>),
    typeof(Api.Application.Common.ValidationBehavior<,>));

// Domain event dispatch — default no-op; replace in tests / production.
builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();

builder.Services.AddScoped<Api.Domain.Products.IProductRepository, Api.Infrastructure.Repositories.ProductRepository>();
builder.Services.AddScoped<Api.Domain.Orders.IOrderRepository, Api.Infrastructure.Repositories.OrderRepository>();
builder.Services.AddScoped<Api.Domain.Customers.ICustomerRepository, Api.Infrastructure.Repositories.CustomerRepository>();
// Domain persistence ports (audit S7 Slice C) — EF adapters over the scoped AppDbContext.
builder.Services.AddScoped<Api.Domain.Common.IUnitOfWork, Api.Infrastructure.Persistence.EfUnitOfWork>();
builder.Services.AddScoped(typeof(Api.Domain.Common.IWorkflowEventStore<>), typeof(Api.Infrastructure.Persistence.EfWorkflowEventStore<>));
builder.Services.AddScoped(typeof(Api.Domain.Common.ISagaStateStore<>), typeof(Api.Infrastructure.Persistence.EfSagaStateStore<>));
builder.Services.AddScoped(typeof(Api.Domain.Common.IReadModelStore<>), typeof(Api.Infrastructure.Persistence.EfReadModelStore<>));



builder.Services.AddControllers(opts =>
{
    opts.Filters.Add<DomainExceptionFilter>();
}).AddJsonOptions(opts =>
{
    // camelCase property names match the Hono backend's wire shape;
    // the cross-platform OpenAPI cross-check would diff otherwise.
    opts.JsonSerializerOptions.PropertyNamingPolicy =
        JsonNamingPolicy.CamelCase;
    opts.JsonSerializerOptions.DictionaryKeyPolicy =
        JsonNamingPolicy.CamelCase;
    // Enums cross the wire as their member name ("Public"), not the
    // ordinal — matching Hono/Phoenix.  Swashbuckle detects this
    // converter and emits a named string-enum schema for each enum type.
    opts.JsonSerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter());
    // Canonical ISO-8601 UTC instants (RS-4): trim trailing zero fractional
    // seconds so an instant with no sub-second part serializes as "…00Z" (not
    // System.Text.Json's fixed 7-digit "…00.0000000Z"), matching the node /
    // Python / Java backends.  Business DTOs carry datetime as a pre-formatted
    // wire string; this covers any raw DateTime a controller serializes.
    opts.JsonSerializerOptions.Converters.Add(
        new Api.Serialization.CanonicalInstantJsonConverter());
    opts.JsonSerializerOptions.Converters.Add(
        new Api.Serialization.CanonicalInstantOffsetJsonConverter());
});

// Minimal-API JSON options — the /health + /ready probes (and the /auth/me
// session probe when auth is on) and any raw datetime a minimal endpoint
// returns serialize through ConfigureHttpJsonOptions rather than the MVC
// AddJsonOptions above.  Register the canonical instant converters here too so
// their wire matches the controllers' (RS-4 temporal round-trip parity).
builder.Services.ConfigureHttpJsonOptions(opts =>
{
    opts.SerializerOptions.Converters.Add(
        new Api.Serialization.CanonicalInstantJsonConverter());
    opts.SerializerOptions.Converters.Add(
        new Api.Serialization.CanonicalInstantOffsetJsonConverter());
});

// CORS: the compose stack sets CORS_ORIGIN to the frontend origin(s) — a
// comma-separated allowlist (env vars are a Configuration source).  When set,
// only those origins are allowed (with credentials, so the session cookie
// flows cross-origin).  When unset, the fallback is permissive AllowAnyOrigin
// ONLY for an auth-less system; an auth-bearing system configures no origins
// (denies cross-origin) by default.  Pin Program.cs in .loomignore to tighten.
var corsOrigins = (builder.Configuration["CORS_ORIGIN"] ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.AddCors(opts =>
{
    opts.AddDefaultPolicy(p =>
    {
        if (corsOrigins.Length > 0)
        {
            p.WithOrigins(corsOrigins).AllowCredentials().AllowAnyHeader().AllowAnyMethod();
        }
        else
        {
            p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
        }
    });
});

// OpenAPI spec generation — Swashbuckle reflects over controllers and
// emits the spec at /openapi.json (aligned across every backend so the
// cross-platform contract check diffs a single well-known path).
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    // Document name "openapi" + the UseSwagger RouteTemplate below place the
    // spec at /openapi.json (not Swashbuckle's default /swagger/v1/swagger.json).
    c.SwaggerDoc("openapi", new() { Title = "Api", Version = "v1" });
    // RFC 7807: rewrite declared 4xx/5xx responses to
    // application/problem+json carrying ProblemDetails (matches Hono/Phoenix).
    c.OperationFilter<ProblemDetailsResponsesFilter>();
    // Promote inline array list responses to named <Agg>ListResponse
    // components (matches Hono/Phoenix, which name the wrapper).
    c.DocumentFilter<ListResponseWrapperFilter>();
    // Mark non-nullable reference-type properties as required in the
    // schema — matches Hono/Phoenix, which mark every non-optional field
    // required.  Without this Swashbuckle leaves the required set empty.
    c.SupportNonNullableReferenceTypes();
    // Request DTOs carry [Required] on the record's CONSTRUCTOR PARAMETER
    // (a property-targeted [property: Required] makes ASP.NET record
    // validation throw at model-binding time), but Swashbuckle only reads
    // property-targeted attributes — so it misses request-body required-ness.
    // This filter marks those properties required from the ctor params,
    // restoring cross-backend required-set parity.
    c.SchemaFilter<RequiredFromCtorParamFilter>();
    // operationId parity: the generated controller action method names are
    // the PascalCase of the shared operationId (createProject, allProject,
    // getProjectById, …).  Lower-casing the first char yields the exact
    // camelCase operationId Hono/Phoenix emit, so client codegen function
    // names line up.  Returns null for framework endpoints with no action.
    c.CustomOperationIds(apiDesc =>
    {
        var action = apiDesc.ActionDescriptor.RouteValues.TryGetValue("action", out var a) ? a : null;
        return string.IsNullOrEmpty(action)
            ? null
            : char.ToLowerInvariant(action[0]) + action.Substring(1);
    });
    // Schema-name parity for the paged carrier (M-T2.6): the generic
    // Paged<XResponse> return would otherwise get Swashbuckle's default
    // "PagedXResponse" component name — but Hono/Phoenix/Java/Python all name
    // the envelope "<Agg>Paged" (e.g. EngineerPaged).  Map the generic back to
    // that canonical name so the OpenAPI schema set matches cross-backend
    // (conformance-parity).  Every other type keeps its short type name.
    c.CustomSchemaIds(t =>
    {
        if (t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("Paged", StringComparison.Ordinal))
        {
            var inner = t.GetGenericArguments()[0].Name;
            var stem = inner.EndsWith("Response", StringComparison.Ordinal) ? inner.Substring(0, inner.Length - "Response".Length) : inner;
            return stem + "Paged";
        }
        return t.Name;
    });
});

var app = builder.Build();


// Apply pending EF Core migrations before serving traffic.  Idempotent —
// EF tracks applied versions in the __EFMigrationsHistory table.  Runs
// synchronously at startup so the schema is current on first request.
// Bracketed with the catalog migration-lifecycle events (observability.md)
// — same event names + level Hono/Python emit.  EF exposes the pending
// migration ids before applying them, so we can emit migration_applied
// per id (no cheap per-migration duration, so duration_ms is omitted).
using (var migrationScope = app.Services.CreateScope())
{
    var db = migrationScope.ServiceProvider.GetRequiredService<AppDbContext>();
    var migrationLog = migrationScope.ServiceProvider
        .GetRequiredService<Microsoft.Extensions.Logging.ILoggerFactory>()
        .CreateLogger("Migrations");
    var pendingMigrations = db.Database.GetPendingMigrations().ToList();
    migrationLog.LogInformation("{Event} count={Count}", "migrations_starting", pendingMigrations.Count);
    try
    {
        db.Database.Migrate();
        foreach (var migrationId in pendingMigrations)
        {
            migrationLog.LogInformation("{Event} id={Id} name={Name}", "migration_applied", migrationId, migrationId);
        }
        migrationLog.LogInformation("{Event} applied={Applied}", "migrations_complete", pendingMigrations.Count);
    }
    catch (Exception migrationError)
    {
        migrationLog.LogError(migrationError, "{Event} error={Error}", "migration_failed", migrationError.Message);
        throw;
    }
}

// Catalog server-lifecycle events.  Same event names + level Hono and
// Phoenix emit so a cross-backend dashboard pivots on one identity.
// A separate logger keeps these lines distinct from per-request
// middleware lines in the structured stream.
var lifecycleLog = app.Services.GetRequiredService<Microsoft.Extensions.Logging.ILoggerFactory>()
    .CreateLogger("Lifecycle");
var loomPort = builder.Configuration["PORT"]
    ?? System.Environment.GetEnvironmentVariable("PORT")
    ?? "8080";
var loomEnv = app.Environment.EnvironmentName ?? "Production";
lifecycleLog.LogInformation("{Event} port={Port} env={Env}", "server_starting", loomPort, loomEnv);
{
    var lifetime = app.Services.GetRequiredService<Microsoft.Extensions.Hosting.IHostApplicationLifetime>();
    lifetime.ApplicationStarted.Register(() =>
        lifecycleLog.LogInformation("{Event} port={Port}", "server_listening", loomPort));
    lifetime.ApplicationStopping.Register(() =>
        lifecycleLog.LogInformation("{Event} signal={Signal}", "server_shutdown", "SIGTERM"));
    lifetime.ApplicationStopped.Register(() =>
        lifecycleLog.LogInformation("{Event}", "server_drained"));
}

// Liveness probe — cheap, no I/O.  K8s livenessProbe / docker-compose
// healthcheck use this to decide "is the process alive?".  A DB blip
// must NOT mark the pod not-alive (that restarts the container and
// amplifies the outage), which is why DB-touching checks live on
// /ready instead.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
// Readiness probe — pings the DB.  K8s readinessProbe uses this to
// decide "should I send traffic to this pod?".  Returns 503 with a
// one-line cause when the DB is unreachable so operators see the
// reason in the probe log instead of having to exec into the pod.
app.MapGet("/ready", async (AppDbContext db, CancellationToken cancellationToken) =>
{
    try
    {
        var ok = await db.Database.CanConnectAsync(cancellationToken);
        return ok
            ? Results.Ok(new { status = "ready" })
            : Results.Json(
                new { status = "not_ready", error = "database unreachable" },
                statusCode: 503);
    }
    catch (Exception ex)
    {
        return Results.Json(
            new { status = "not_ready", error = ex.Message },
            statusCode: 503);
    }
});
// Ambient execution context — births the RequestContext (correlation id,
// locale, start time, scope id) and opens the root frame.  Mounted FIRST so
// the frame covers the entire pipeline: the request log below rides its
// scope_id (the cross-backend observability envelope — every backend carries
// scope_id on the request bracket), and bypassed (/health) + unauthenticated
// paths are covered too.  See Middleware/RequestContextMiddleware.cs.
app.UseMiddleware<Api.Middleware.RequestContextMiddleware>();
// Catalog-identity request log — emits the cross-backend
// request_start / request_end events (same envelope shape Hono
// and Phoenix produce).  Mounted FIRST so its Stopwatch covers the
// full pipeline (auth, routing, controller body, serialization).
// See Middleware/RequestLoggingMiddleware.cs.
app.UseMiddleware<Api.Middleware.RequestLoggingMiddleware>();
// HTTP logging middleware — pairs with AddHttpLogging above.
// Mounted before the auth + business pipelines so every request is
// logged regardless of whether it reached a controller.  Coexists
// with the catalog middleware above (the framework line and the
// catalog line are both useful; dashboards filter on the catalog).
app.UseHttpLogging();
app.UseCors();
// Serve the spec at /openapi.json (documentName "openapi" → "{documentName}.json").
app.UseSwagger(c => c.RouteTemplate = "{documentName}.json");
app.MapControllers();


app.Run();
