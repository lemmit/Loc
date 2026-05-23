// Auto-generated.
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using CatalogApi.Api;
using CatalogApi.Domain.Common;
using CatalogApi.Infrastructure.Persistence;
using CatalogApi.Infrastructure.Events;

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
    typeof(CatalogApi.Application.Common.ValidationBehavior<,>));

// Domain event dispatch — default no-op; replace in tests / production.
builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();

builder.Services.AddScoped<CatalogApi.Domain.Products.IProductRepository, CatalogApi.Infrastructure.Repositories.ProductRepository>();
builder.Services.AddScoped<CatalogApi.Domain.Customers.ICustomerRepository, CatalogApi.Infrastructure.Repositories.CustomerRepository>();



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
});

// Permissive CORS so a generated React frontend on a different port
// can reach the API in dev compose.  Pin Program.cs in .loomignore +
// tighten in production.
builder.Services.AddCors(opts =>
{
    opts.AddDefaultPolicy(p =>
        p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

// OpenAPI spec generation — Swashbuckle reflects over controllers and
// emits the spec at /swagger/v1/swagger.json.  The cross-platform
// contract check diffs this against the Hono-emitted /openapi.json.
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new() { Title = "CatalogApi", Version = "v1" });
});

var app = builder.Build();

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
app.MapGet("/ready", async (AppDbContext db, CancellationToken ct) =>
{
    try
    {
        var ok = await db.Database.CanConnectAsync(ct);
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
// Catalog-identity request log — emits the cross-backend
// request_start / request_end events (same envelope shape Hono
// and Phoenix produce).  Mounted FIRST so its Stopwatch covers the
// full pipeline (auth, routing, controller body, serialization).
// See Middleware/RequestLoggingMiddleware.cs.
app.UseMiddleware<CatalogApi.Middleware.RequestLoggingMiddleware>();
// HTTP logging middleware — pairs with AddHttpLogging above.
// Mounted before the auth + business pipelines so every request is
// logged regardless of whether it reached a controller.  Coexists
// with the catalog middleware above (the framework line and the
// catalog line are both useful; dashboards filter on the catalog).
app.UseHttpLogging();
app.UseCors();
app.UseSwagger();
app.MapControllers();

// Dev-friendly schema bootstrap: create the schema from the model on
// first boot.  System-mode compose isolates each deployable to its own
// database (see db-init/), so EnsureCreated runs cleanly without
// racing peers.  For production, replace this with
// 'dotnet ef database update' and remove the block.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}

app.Run();
