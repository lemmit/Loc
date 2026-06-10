import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { isTphBase } from "../../../ir/util/inheritance.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall } from "../../_obs/render-dotnet.js";
import { DAPPER_PROJECT_DEPS, renderDapperConnectionSetup } from "./dapper.js";

// Program.cs is top-level statements, not a class — so the renderer's
// `_log.` prefix becomes `lifecycleLog.`.  When the call sits inside a
// `Register(() => ...)` lambda body the trailing `;` would close the
// lambda too early; `asLifecycleExpr` strips it.
function asLifecycleStmt(rendered: string): string {
  return rendered.replace("_log.", "lifecycleLog.");
}
function asLifecycleExpr(rendered: string): string {
  return asLifecycleStmt(rendered).replace(/;\s*$/, "");
}

// Program.cs hosting + DI registration, plus the project + Dockerfile +
// .dockerignore boilerplate.  Pure substitution templates — no
// iteration tricks.

export function renderProgram(
  ctx: BoundedContextIR,
  ns: string,
  options?: {
    authRequired?: boolean;
    usesValidators?: boolean;
    /** When true, at least one aggregate carries `flags.isAuditable`
     *  (any aggregate has contextStamps from one or more macros).
     *  Program.cs registers the `AuditableInterceptor` and attaches
     *  it to DbContextOptions so stamping happens at SaveChanges
     *  time without per-aggregate handler code. */
    usesStamping?: boolean;
    /** Fullstack-dotnet flag: when true, the deployable hosts an
     *  embedded React SPA from `wwwroot/`.  Adds `UseDefaultFiles` +
     *  `UseStaticFiles` middleware and a `MapFallbackToFile` so SPA
     *  client-side routes load `index.html` while controller routes
     *  (now under `/api/*`, see `routePrefix` in the api template)
     *  match first.  Off for backend-only .NET. */
    hasEmbeddedSpa?: boolean;
    /** When true, the deployable's `Migrations/` directory carries
     *  EF Core Migration classes (one per `MigrationsIR`).  Program.cs
     *  adds a `Database.Migrate()` call at startup (idempotent — EF
     *  tracks applied versions in `__EFMigrationsHistory`) and
     *  configures the DbContext to suppress the
     *  `PendingModelChangesWarning` that fires because our
     *  ModelSnapshot stub is intentionally empty. */
    hasMigrations?: boolean;
    /** When true (a `seed` block is present), adds a `Seed.RunSeeds(...)`
     *  startup call after `Database.Migrate()` (database-seeding.md). */
    hasSeeds?: boolean;
    /** When true, register `DomainLogBehavior` (a Mediator pipeline
     *  behavior) so the request-scoped ILogger reaches the domain
     *  layer via `DomainLog.Current` — used by --trace-injected
     *  trace calls in aggregate methods.  Off keeps Program.cs
     *  free of the registration entirely. */
    emitTrace?: boolean;
    /** When true, the deployable has channel-routed event subscriptions, so
     *  Program.cs registers the in-process Mediator-notification dispatcher
     *  (instead of the no-op) and `IDomainEvent` is a Mediator notification. */
    hasSubscriptions?: boolean;
    /** Persistence selection (D-REALIZATION-AXES `persistence:`): when true,
     *  the deployable uses Dapper — Program.cs registers an `NpgsqlDataSource`
     *  (not a `DbContext`) and applies the self-contained `DbSchema` at
     *  startup instead of EF migrations. */
    usingDapper?: boolean;
  },
): string {
  const authRequired = !!options?.authRequired;
  const usesValidators = !!options?.usesValidators;
  const usesStamping = !!options?.usesStamping;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const hasMigrations = !!options?.hasMigrations;
  // In-process dispatch (channels.md): when the deployable has channel-routed
  // subscriptions, register the Mediator-notification dispatcher (Scoped — it
  // depends on the scoped IMediator) so emitted events reach their reactor /
  // starter handlers.  Otherwise the default no-op stands (byte-identical).
  const dispatcherRegistration = options?.hasSubscriptions
    ? `// Domain event dispatch — in-process Mediator-notification dispatcher.\nbuilder.Services.AddScoped<IDomainEventDispatcher, InProcessDomainEventDispatcher>();`
    : `// Domain event dispatch — default no-op; replace in tests / production.\nbuilder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();`;
  const hasSeeds = !!options?.hasSeeds;
  const usingDapper = !!options?.usingDapper;
  const seedBlock = hasSeeds
    ? `
// Apply first-boot seed data after migrations (database-seeding.md).
// Ship-once per dataset via the __loom_seed marker; idempotent across boots.
using (var seedScope = app.Services.CreateScope())
{
    var seedDb = seedScope.ServiceProvider.GetRequiredService<AppDbContext>();
    await ${ns}.Infrastructure.Persistence.Seed.RunSeeds(seedDb, seedScope.ServiceProvider);
}
`
    : "";
  const emitTrace = !!options?.emitTrace;
  const repoRegistrations = ctx.aggregates
    // A TPH (`sharedTable`) base owns the shared table but emits no repository
    // of its own (only its concretes do; reads route through their DbSets),
    // so it has no I<Base>Repository / <Base>Repository to register.  A TPC
    // base, by contrast, has a base-reader repository — kept.
    .filter((a) => !isTphBase(a, ctx.aggregates))
    .map(
      (a) =>
        `builder.Services.AddScoped<${ns}.Domain.${plural(a.name)}.I${a.name}Repository, ${ns}.Infrastructure.Repositories.${a.name}Repository>();`,
    )
    .join("\n");

  // Per-aggregate list of (op-name, IXAggHandler) pairs for extern
  // operations.  Drives both the Scrutor registration helper text
  // (purely informational) and the startup verification check that
  // every IXAggHandler resolved from DI.
  const externHandlers = ctx.aggregates.flatMap((a) =>
    a.operations
      .filter((o) => o.extern)
      .map((o) => ({
        ifaceFqn: `${ns}.Application.${plural(a.name)}.Handlers.I${upperFirst(o.name)}${a.name}Handler`,
        opName: o.name,
        aggName: a.name,
      })),
  );
  // Only emit the Scrutor scan when at least one aggregate declares
  // an extern op — otherwise the project pulls in a Scrutor reference
  // for nothing.
  const externScan =
    externHandlers.length === 0
      ? ""
      : `// Extern operation handlers — user implements [ExternHandler]-decorated
// classes for each I<Op><Agg>Handler interface in
// Application/<Aggregate>/Handlers/.  Scrutor picks them up by attribute.
builder.Services.Scan(s => s
    .FromAssemblyOf<Program>()
    .AddClasses(c => c.WithAttribute<ExternHandlerAttribute>())
    .AsImplementedInterfaces()
    .WithScopedLifetime());`;
  const externVerify =
    externHandlers.length === 0
      ? ""
      : `
// Verify every extern operation has a registered [ExternHandler].
// Fails fast at startup so a missing user implementation surfaces here
// instead of as a 500 on the first request.
using (var scope = app.Services.CreateScope())
{
${externHandlers
  .map(
    (h) =>
      `    if (scope.ServiceProvider.GetService<${h.ifaceFqn}>() is null)\n` +
      `        throw new InvalidOperationException(\n` +
      `            "Missing [ExternHandler] for ${h.ifaceFqn} (operation '${h.opName}' on aggregate '${h.aggName}'). " +\n` +
      `            "Add a class decorated with [ExternHandler] that implements this interface.");`,
  )
  .join("\n")}
}
`;
  // Auth middleware mount — pinned BETWEEN UseSwagger and MapControllers
  // so that JWT verification happens after the framework's static-asset
  // pipeline (which serves /swagger UI) but before any business route
  // executes.  Bypass list lives in UserMiddleware.cs.
  const authUsing = authRequired ? `\nusing ${ns}.Auth;` : "";
  const authDi = authRequired
    ? `
// Auth — JWT decode middleware + scoped accessor.  Register your
// IUserVerifier implementation here (or anywhere in DI); the verifier
// translates inbound tokens into the strongly-typed User claim record.
// Dev-stub DevStubUserVerifier is registered first so a generated stack
// boots out of the box; replace by registering your own IUserVerifier
// (the last DI registration wins for new scope resolutions).
builder.Services.AddScoped<IUserVerifier, DevStubUserVerifier>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUserAccessor, HttpContextCurrentUserAccessor>();
`
    : "";
  const authVerify = authRequired
    ? `
// Verify the user supplied an IUserVerifier.  Without it every request
// would fail at the middleware, surfacing as a confusing 500; failing
// fast at startup makes the missing registration obvious.
using (var scope = app.Services.CreateScope())
{
    if (scope.ServiceProvider.GetService<IUserVerifier>() is null)
        throw new InvalidOperationException(
            "Missing IUserVerifier registration. Register an implementation that " +
            "decodes inbound JWTs into the generated User record (e.g. " +
            "builder.Services.AddScoped<IUserVerifier, MyJwtVerifier>()).");
}
`
    : "";
  const authMount = authRequired
    ? `app.UseMiddleware<UserMiddleware>();
`
    : "";
  return `// Auto-generated.
using System.Text.Json;
${usingDapper ? "using Npgsql;\n" : "using Microsoft.EntityFrameworkCore;\n"}${usesValidators ? "using FluentValidation;\n" : ""}using ${ns}.Api;
using ${ns}.Domain.Common;
using ${ns}.Infrastructure.Persistence;
using ${ns}.Infrastructure.Events;${authUsing}

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

${
  usingDapper
    ? `// Dapper persistence: a single Npgsql data source, no DbContext.
${renderDapperConnectionSetup().join("\n")}`
    : usesStamping
      ? `builder.Services.AddScoped<${ns}.Infrastructure.Persistence.AuditableInterceptor>();
builder.Services.AddDbContext<AppDbContext>((sp, opts) =>
{
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default"));
    opts.AddInterceptors(sp.GetRequiredService<${ns}.Infrastructure.Persistence.AuditableInterceptor>());
});`
      : `builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));`
}

// Mediator (martinothamar/Mediator) — source-generated, free to use.
builder.Services.AddMediator(opts => opts.ServiceLifetime = ServiceLifetime.Scoped);
${
  usesValidators
    ? `
// FluentValidation — wire-boundary validators emitted per command in
// Application/<Aggregate>/Commands/<Cmd>CommandValidator.cs.  The
// pipeline behavior runs them before each handler; failures throw
// FluentValidation.ValidationException, which DomainExceptionFilter
// converts to a 400 with a structured \`failures\` array.  The
// existing domain-layer AssertInvariants() stays as the floor.
builder.Services.AddValidatorsFromAssembly(typeof(Program).Assembly);
builder.Services.AddScoped(
    typeof(Mediator.IPipelineBehavior<,>),
    typeof(${ns}.Application.Common.ValidationBehavior<,>));
`
    : ""
}${
  emitTrace
    ? `
// DomainLogBehavior — Mediator pipeline behavior that surfaces the
// request-scoped ILogger to the domain layer via DomainLog.Current
// (AsyncLocal).  --trace-injected log calls in aggregate methods
// resolve through that accessor, so the per-request correlation
// reaches domain code without a constructor-injection refactor.
// Emitted only when --trace is on; off path keeps Program.cs free
// of the registration entirely.
builder.Services.AddScoped(
    typeof(Mediator.IPipelineBehavior<,>),
    typeof(${ns}.Application.Common.DomainLogBehavior<,>));
`
    : ""
}
${dispatcherRegistration}

${repoRegistrations}
${authDi}
${externScan}

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
    c.SwaggerDoc("v1", new() { Title = "${ns}", Version = "v1" });
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
});

var app = builder.Build();
${
  usingDapper
    ? `
// Dapper persistence: apply the self-contained schema (CREATE TABLE IF NOT
// EXISTS) before serving traffic.  Idempotent; no migration history table.
await ${ns}.Infrastructure.Persistence.DbSchema.EnsureAsync(
    app.Services.GetRequiredService<NpgsqlDataSource>());
`
    : hasMigrations
      ? `
// Apply pending EF Core migrations before serving traffic.  Idempotent —
// EF tracks applied versions in the __EFMigrationsHistory table.  Runs
// synchronously at startup so the schema is current on first request.
using (var migrationScope = app.Services.CreateScope())
{
    var db = migrationScope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
`
      : ""
}${seedBlock}
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
${asLifecycleStmt(
  renderDotnetLogCall("serverStarting", [
    { name: "port", valueExpr: "loomPort" },
    { name: "env", valueExpr: "loomEnv" },
  ]),
)}
{
    var lifetime = app.Services.GetRequiredService<Microsoft.Extensions.Hosting.IHostApplicationLifetime>();
    lifetime.ApplicationStarted.Register(() =>
        ${asLifecycleExpr(
          renderDotnetLogCall("serverListening", [{ name: "port", valueExpr: "loomPort" }]),
        )});
    lifetime.ApplicationStopping.Register(() =>
        ${asLifecycleExpr(
          renderDotnetLogCall("serverShutdown", [{ name: "signal", valueExpr: '"SIGTERM"' }]),
        )});
    lifetime.ApplicationStopped.Register(() =>
        ${asLifecycleExpr(renderDotnetLogCall("serverDrained"))});
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
${
  usingDapper
    ? `app.MapGet("/ready", async (NpgsqlDataSource db, CancellationToken cancellationToken) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync(cancellationToken);
        return Results.Ok(new { status = "ready" });
    }
    catch (Exception ex)
    {
        return Results.Json(
            new { status = "not_ready", error = ex.Message },
            statusCode: 503);
    }
});`
    : `app.MapGet("/ready", async (AppDbContext db, CancellationToken cancellationToken) =>
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
});`
}
// Catalog-identity request log — emits the cross-backend
// request_start / request_end events (same envelope shape Hono
// and Phoenix produce).  Mounted FIRST so its Stopwatch covers the
// full pipeline (auth, routing, controller body, serialization).
// See Middleware/RequestLoggingMiddleware.cs.
app.UseMiddleware<${ns}.Middleware.RequestLoggingMiddleware>();
// HTTP logging middleware — pairs with AddHttpLogging above.
// Mounted before the auth + business pipelines so every request is
// logged regardless of whether it reached a controller.  Coexists
// with the catalog middleware above (the framework line and the
// catalog line are both useful; dashboards filter on the catalog).
app.UseHttpLogging();
app.UseCors();
app.UseSwagger();
${authMount}app.MapControllers();
${
  hasEmbeddedSpa
    ? `
// Fullstack mode — host the embedded React SPA from wwwroot/.
// UseDefaultFiles rewrites GET / to /index.html before UseStaticFiles
// serves the bundle; MapFallbackToFile catches client-side router
// paths (e.g. /orders/123) that don't match a controller route,
// returning index.html so the SPA can deep-link.  Controller routes
// live under /api/* — the routePrefix passed to renderController
// keeps them disambiguated from the SPA's path namespace.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
`
    : ""
}
${
  usingDapper || hasMigrations
    ? // Dapper applied its schema via DbSchema.EnsureAsync at startup; a
      // migrations-bearing deployable applied them via Database.Migrate().
      // Either way EnsureCreated must NOT also run: mixing it with
      // Migrate() is the classic EF trap — whichever runs first creates
      // *a* table, and the other then sees a non-empty database and
      // no-ops, leaving the schema half-built with no error.
      ""
    : `// Dev-friendly schema bootstrap: create the schema from the model on
// first boot.  System-mode compose isolates each deployable to its own
// database (see db-init/), so EnsureCreated runs cleanly without
// racing peers.  For production, replace this with
// 'dotnet ef database update' and remove the block.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}
`
}${authVerify}${externVerify}
app.Run();
`;
}

export function renderCsproj(
  ns: string,
  hasExtern: boolean = false,
  usesValidators: boolean = false,
  resourceNugetDeps: Record<string, string> = {},
  usingDapper: boolean = false,
  usesSpecifications: boolean = false,
): string {
  // Persistence package set — Dapper + raw Npgsql for `persistence: dapper`,
  // otherwise the EF Core + Npgsql.EntityFrameworkCore stack.
  const persistenceRefs = usingDapper
    ? DAPPER_PROJECT_DEPS.join("\n")
    : `    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.10" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="8.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.10" />`;
  // Resource-client NuGet refs (Phase 4c) — AWSSDK.S3 / RabbitMQ.Client
  // etc., one row per package the deployable's consumed resources need.
  const resourceRefs = Object.entries(resourceNugetDeps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, version]) => `\n    <PackageReference Include="${id}" Version="${version}" />`)
    .join("");
  // Scrutor only ships when the project actually scans for
  // [ExternHandler]-decorated classes.
  const scrutorRef = hasExtern
    ? `\n    <!-- Scrutor — assembly scan for [ExternHandler]-decorated classes -->\n    <PackageReference Include="Scrutor" Version="5.0.2" />`
    : "";
  // FluentValidation only ships when at least one wire-translatable
  // invariant or precondition exists.  AspNetCore meta-package gives
  // `AddValidatorsFromAssembly` + DI integration in one ref.
  const validatorRef = usesValidators
    ? `\n    <!-- FluentValidation — wire-boundary validators (Mediator pipeline) -->\n    <PackageReference Include="FluentValidation" Version="11.10.0" />\n    <PackageReference Include="FluentValidation.DependencyInjectionExtensions" Version="11.10.0" />`
    : "";
  // Ardalis Specification — reified `criterion`/`retrieval` query objects.
  // EF-Core-only: the evaluator runs against `IQueryable`, which the Dapper
  // persistence axis doesn't have (it renders SQL fragments instead), so the
  // dependency ships only for the EF Core path with at least one retrieval.
  const specRef =
    usesSpecifications && !usingDapper
      ? `\n    <!-- Ardalis.Specification — reified retrieval/criterion query objects -->\n    <PackageReference Include="Ardalis.Specification" Version="8.0.0" />\n    <PackageReference Include="Ardalis.Specification.EntityFrameworkCore" Version="8.0.0" />`
      : "";
  return `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>${ns}</RootNamespace>
    <!-- Roslyn analyzer level — see docs/proposals/cross-stack-static-analysis.md.
         latest-recommended brings in ~200 high-signal CA-prefixed rules
         on top of the compiler warnings the existing CI /warnaserror gates. -->
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <!-- CA1707: \`_Create\` factory uses an underscore prefix intentionally
         to signal "internal builder, not public API" — a long-standing DDD
         convention this generator follows uniformly.  Renaming would force
         every emitted aggregate / part to invent a new public name and
         break the established pattern.
         CA1848 + CA1873: LoggerMessage source-generator delegates +
         IsEnabled gate are high-perf optimizations for hot-path logging.
         For the request-tier / domain-narrative logging this generator
         emits (handful of events per request), the overhead is negligible
         and the LoggerMessage boilerplate would dominate the file.
         ASP.NET project templates routinely suppress these. -->
    <NoWarn>CA1707;CA1848;CA1873</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <!-- Test files live in the sibling Tests/${ns}.Tests project -->
    <Compile Remove="Tests/**" />
    <None Remove="Tests/**" />
  </ItemGroup>
  <ItemGroup>
${persistenceRefs}
    <!-- Source-generated Mediator (https://github.com/martinothamar/Mediator) -->
    <PackageReference Include="Mediator.SourceGenerator" Version="2.1.7">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Mediator.Abstractions" Version="2.1.7" />
    <!-- OpenAPI spec emitted at /swagger/v1/swagger.json -->
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.9.0" />${scrutorRef}${validatorRef}${specRef}${resourceRefs}
  </ItemGroup>
</Project>
`;
}

export function renderTestCsproj(ns: string): string {
  return `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
    <RootNamespace>${ns}.Tests</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <!-- AwesomeAssertions: OSS continuation of FluentAssertions; backs the
         generated Should().Be / BeGreaterThan / etc. test matchers. -->
    <PackageReference Include="AwesomeAssertions" Version="8.0.0" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../${ns}.csproj" />
  </ItemGroup>
</Project>
`;
}

export function renderDockerfile(ns: string, options?: { hasEmbeddedSpa?: boolean }): string {
  if (options?.hasEmbeddedSpa) {
    // Fullstack mode — multi-stage build.  Stage 1 builds the React
    // SPA under ClientApp/, stage 2 builds the .NET project, stage 3
    // ships the runtime image with the .NET publish output AND the
    // SPA bundle copied into wwwroot/ so `app.UseStaticFiles()` +
    // `app.MapFallbackToFile("index.html")` can serve it on the same
    // origin as the API.  Two SDK images instead of one — costs a bit
    // of cache bandwidth but keeps the runtime image small.
    return `# syntax=docker/dockerfile:1
# Auto-generated — fullstack .NET + React (embedded SPA).

FROM node:20-alpine AS spa-build
WORKDIR /spa
COPY ClientApp/package.json ClientApp/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund || npm install
COPY ClientApp/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS dotnet-build
WORKDIR /src
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>&1 | tail -1 || true
COPY ${ns}.csproj ./
RUN dotnet restore ${ns}.csproj
COPY . .
RUN dotnet publish ${ns}.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
# wget for the compose healthcheck (see the other dockerfile branch).
RUN apt-get update -y && apt-get install -y --no-install-recommends wget \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=dotnet-build /app/publish ./
# SPA bundle lands under wwwroot/ so UseStaticFiles + MapFallbackToFile
# can serve it on the same origin as the /api/* controller routes.
COPY --from=spa-build /spa/dist ./wwwroot
ENTRYPOINT ["dotnet", "${ns}.dll"]
`;
  }
  return `# syntax=docker/dockerfile:1
# Auto-generated.

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
# Optional proxy CAs — drop *.crt files into ./certs/ to make the
# build trust them.  The directory always exists (with a .gitkeep),
# so this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>&1 | tail -1 || true
COPY ${ns}.csproj ./
RUN dotnet restore ${ns}.csproj
COPY . .
RUN dotnet publish ${ns}.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
# wget is here so the compose healthcheck (which shells out to wget) works
# inside the aspnet image — without it the container reports unhealthy
# even though the API is responding on /health.
RUN apt-get update -y && apt-get install -y --no-install-recommends wget \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "${ns}.dll"]
`;
}

export function renderDockerignore(): string {
  return `# Auto-generated.
**/bin
**/obj
**/out
.git
.vs
.vscode
*.user
*.log
`;
}
