import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { readPortsForOperation } from "../../../ir/util/domain-service-read-ports.js";
import { isTphBase } from "../../../ir/util/inheritance.js";
import { AUTH_BASE_PATH } from "../../../util/api-base.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderDotnetLogCall, renderDotnetLogCallWithException } from "../../_obs/render-dotnet.js";
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
// Inside the migration scope the catalog renderer's `_log.` field
// becomes the locally-created `migrationLog.`.
function asMigrationStmt(rendered: string): string {
  return rendered.replace("_log.", "migrationLog.");
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
    /** When true, register `ExecutionContextBehavior` (a Mediator
     *  pipeline behaviour) so the request-scoped ILogger reaches the
     *  domain layer via `DomainLog.Current` (the RequestContext logger
     *  slice) — used by --trace-injected trace calls in aggregate
     *  methods.  Off keeps Program.cs free of the registration entirely. */
    emitTrace?: boolean;
    /** When true, the deployable has channel-routed event subscriptions, so
     *  Program.cs registers the in-process Mediator-notification dispatcher
     *  (instead of the no-op) and `IDomainEvent` is a Mediator notification. */
    hasSubscriptions?: boolean;
    /** Transactional outbox (dispatch-delivery-semantics.md): registers the
     *  outbox-wrapping dispatcher + the relay BackgroundService.  Implies
     *  hasSubscriptions. */
    hasOutbox?: boolean;
    /** Persistence selection (D-REALIZATION-AXES `persistence:`): when true,
     *  the deployable uses Dapper — Program.cs registers an `NpgsqlDataSource`
     *  (not a `DbContext`) and applies the self-contained `DbSchema` at
     *  startup instead of EF migrations. */
    usingDapper?: boolean;
    /** Per-operation audit (audit-and-logging.md): registers the scoped
     *  `IAuditWriter` → `AuditWriter` the audited command handlers depend on
     *  to stage audit rows onto the request unit of work. */
    hasAudit?: boolean;
    /** OIDC turnkey auth (D-AUTH-OIDC): the system declares an `auth { oidc }`
     *  block, so register the generated `OidcUserVerifier` (last-wins over the
     *  dev stub).  Implies `authRequired`. */
    oidc?: boolean;
    /** Field-level provenance (provenance.md): like `hasAudit`, its history
     *  rows stamp the per-dispatch frame's scope / parent ids, so it also
     *  forces the `ExecutionContextBehavior` frame-opener to be registered. */
    hasProvenance?: boolean;
    /** Tenant hierarchy (multi-tenancy P2.2): the registry opts into
     *  `tenantRegistry`, so register the scoped `IOrgPathResolver` →
     *  `EfOrgPathResolver` that UserMiddleware calls per request to materialize
     *  `currentUser.orgPath` from the registry's `data_key`.  Implies
     *  `authRequired`. */
    orgPathResolver?: boolean;
    /** TimerSource scheduling (scheduling.md, M-T4.1): fully-qualified
     *  `<Pascal>TimerService` type names to register as hosted services (one
     *  `AddHostedService<…>()` per owned timer).  Empty ⇒ no registration, so
     *  a timer-free deployable's Program.cs stays byte-identical. */
    timerServices?: string[];
    /** Broker channels (M-T4.4 slice 6a): the deployable wires a redis-bound
     *  channelSource — register the ChannelTransports singleton and wrap the
     *  dispatcher chain in the publish tee (design §4 delivery uniformity). */
    hasChannels?: boolean;
    /** A hosted reactor subscribes to a carried event — start the consumer
     *  BackgroundService feeding envelopes into the in-process dispatch. */
    hasChannelConsumers?: boolean;
    /** TimerSource durable scheduling (scheduling.md Phase 2): the deployable
     *  owns at least one `cron:` timer, so wire Hangfire (`AddHangfire` +
     *  `AddHangfireServer`, Hangfire.PostgreSql storage) + register its recurring
     *  jobs.  `every:`-only + timer-free deployables leave this false — no
     *  Hangfire, byte-identical. */
    hangfireCronTimers?: boolean;
    /** The `AddScoped<…Job>()` DI lines for the Hangfire cron-job classes. */
    hangfireJobDiRegistrations?: string[];
    /** The `RecurringJob.AddOrUpdate<…>(…)` lines (run after `app.Build()`). */
    hangfireRecurringRegistrations?: string[];
    /** Dapper persistence-port DI (M-T6.9): the CLOSED `AddScoped<…>` binding
     *  lines for the workflow / projection / event-store adapters.  Computed in
     *  index.ts (it holds the pre-merge context names the event stores key
     *  off).  Consumed only when `usingDapper` — the EF path uses open generics. */
    dapperPortRegistrations?: string[];
  },
): string {
  const authRequired = !!options?.authRequired;
  const oidc = !!options?.oidc;
  const orgPathResolver = !!options?.orgPathResolver;
  const usesValidators = !!options?.usesValidators;
  const usesStamping = !!options?.usesStamping;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const hasMigrations = !!options?.hasMigrations;
  // In-process dispatch (channels.md): when the deployable has channel-routed
  // subscriptions, register the Mediator-notification dispatcher (Scoped — it
  // depends on the scoped IMediator) so emitted events reach their reactor /
  // starter handlers.  Otherwise the default no-op stands (byte-identical).
  const innerRegistration = options?.hasOutbox
    ? `// Domain event dispatch — durable events (channels with retention: log | work)\n// are recorded in __loom_outbox by the outbox dispatcher and delivered by the\n// relay BackgroundService (at-least-once); ephemeral events dispatch inline.\nbuilder.Services.AddScoped<InProcessDomainEventDispatcher>();\nbuilder.Services.AddScoped<IDomainEventDispatcher, OutboxDomainEventDispatcher>();\nbuilder.Services.AddHostedService<OutboxRelayService>();`
    : options?.hasSubscriptions
      ? `// Domain event dispatch — in-process Mediator-notification dispatcher.\nbuilder.Services.AddScoped<IDomainEventDispatcher, InProcessDomainEventDispatcher>();`
      : `// Domain event dispatch — default no-op; replace in tests / production.\nbuilder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();`;
  // Broker channels (M-T4.4): the publish tee becomes the outermost
  // IDomainEventDispatcher (its ctor takes the concrete inner), the shared
  // transports register once, and — where reactors live — the consumer loop
  // runs as a hosted service feeding the in-process dispatch.
  const dispatcherRegistration = options?.hasChannels
    ? `${innerRegistration
        .split("\n")
        .map((l) =>
          l.startsWith("builder.Services.AddScoped<IDomainEventDispatcher") ||
          l.startsWith("builder.Services.AddSingleton<IDomainEventDispatcher")
            ? l
                .replace("AddScoped<IDomainEventDispatcher, ", "AddScoped<")
                .replace("AddSingleton<IDomainEventDispatcher, ", "AddSingleton<")
                .replace(">();", ">();")
            : l,
        )
        .join(
          "\n",
        )}\n// Broker channel transport (channels.md; M-T4.4): the publish tee routes\n// broker-bound events to the broker (design §4 — co-located consumers\n// receive them via the subscription, not a local shortcut).\nbuilder.Services.AddSingleton<ChannelTransports>();\nbuilder.Services.AddScoped<IDomainEventDispatcher, ChannelPublishTeeDispatcher>();${
        options?.hasChannelConsumers
          ? "\nbuilder.Services.AddHostedService<ChannelConsumerService>();"
          : ""
      }`
    : innerRegistration;
  const hasSeeds = !!options?.hasSeeds;
  const usingDapper = !!options?.usingDapper;
  // TimerSource scheduling (scheduling.md, M-T4.1): one hosted
  // `<Pascal>TimerService` per owned timer, each ticking on its cadence and
  // dispatching through the in-process dispatcher above.  Empty ⇒ no lines, so
  // a timer-free deployable's Program.cs stays byte-identical.
  const timerServices = options?.timerServices ?? [];
  const timerRegistrations =
    timerServices.length > 0
      ? `\n// TimerSource \`every:\` schedulers (scheduling.md) — one hosted BackgroundService\n// per sub-minute timer; each takes a transaction-scoped advisory lock (single-fire\n// across replicas) and dispatches its tick through the in-process dispatcher.\n${timerServices
          .map((fqn) => `builder.Services.AddHostedService<${fqn}>();`)
          .join("\n")}`
      : "";
  // TimerSource `cron:` schedulers (scheduling.md Phase 2) run on Hangfire with
  // Hangfire.PostgreSql storage: the recurring-job scheduler is store-coordinated
  // (single-fire across replicas), retries a failed job with backoff, and fires an
  // overdue recurring job on server start (native missed-run replay).
  const hangfireCronTimers = !!options?.hangfireCronTimers;
  const hangfireJobDiRegistrations = options?.hangfireJobDiRegistrations ?? [];
  const hangfireRecurringRegistrations = options?.hangfireRecurringRegistrations ?? [];
  const hangfireDiBlock = hangfireCronTimers
    ? `\n// Durable cron timers (scheduling.md Phase 2) — Hangfire + Hangfire.PostgreSql.\n// The storage schema is created automatically on first use.\nbuilder.Services.AddHangfire(cfg => cfg\n    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)\n    .UseSimpleAssemblyNameTypeSerializer()\n    .UseRecommendedSerializerSettings()\n    .UsePostgreSqlStorage(o => o.UseNpgsqlConnection(builder.Configuration.GetConnectionString("Default"))));\nbuilder.Services.AddHangfireServer();\n${hangfireJobDiRegistrations.join("\n")}`
    : "";
  const hangfireRecurringBlock = hangfireCronTimers
    ? `\n// Register the durable cron timerSources as Hangfire recurring jobs (standard\n// 5-field cron).  Uses the service-based IRecurringJobManager (the static\n// RecurringJob API needs JobStorage.Current, unset on the DI path).  AddOrUpdate\n// is idempotent per stable id — re-registers on boot.\nusing (var hangfireScope = app.Services.CreateScope())\n{\n    var recurring = hangfireScope.ServiceProvider.GetRequiredService<IRecurringJobManager>();\n${hangfireRecurringRegistrations.join("\n")}\n}\n`
    : "";
  // Dapper resolves the singleton NpgsqlDataSource directly (no per-request
  // scope needed); the EF path scopes an AppDbContext.  The domain-`Create`
  // seed path resolves its repositories off the same provider either way.
  const seedBlock = hasSeeds
    ? usingDapper
      ? `
// Apply first-boot seed data after the schema is ensured (database-seeding.md).
// Ship-once per dataset via the __loom_seed marker; idempotent across boots.
// A scope resolves the domain path's scoped I<Agg>Repository (the singleton
// NpgsqlDataSource resolves off it too).
using (var seedScope = app.Services.CreateScope())
{
    var seedDb = seedScope.ServiceProvider.GetRequiredService<NpgsqlDataSource>();
    await ${ns}.Infrastructure.Persistence.Seed.RunSeeds(seedDb, seedScope.ServiceProvider);
}
`
      : `
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

  // Reading-tier domain services (domain-services.md rev. 4, Slice 1): a
  // `reading` service is a DI'd `sealed class` (it injects an
  // I<Aggregate>Repository per read-port), so it must be registered as a scoped
  // service the orchestrating workflow handler can inject.  A `pure` service is
  // a static class — nothing to register.  Leading newline keeps Program.cs
  // byte-identical when no reading service is present.
  const readingServiceRegistrations = (ctx.domainServices ?? [])
    .filter((svc) => svc.operations.some((op) => readPortsForOperation(op).length > 0))
    .map((svc) => `builder.Services.AddScoped<${ns}.Domain.Services.${upperFirst(svc.name)}>();`);
  const readingServicesDi =
    readingServiceRegistrations.length > 0
      ? `\n// Reading-tier domain services — DI'd read facades (domain-services.md rev. 4).\n${readingServiceRegistrations.join("\n")}`
      : "";

  // Per-operation audit (audit-and-logging.md): the audited command handlers
  // depend on IAuditWriter to stage audit rows onto the request-scoped unit of
  // work (the same AppDbContext the repository saves through).
  // Leading newline so an empty audit registration leaves Program.cs
  // byte-identical (the template emits
  // `${repoRegistrations}${readingServicesDi}${auditDi}`).
  const auditDi = options?.hasAudit
    ? `\n// Per-operation audit — stages audit_records onto the request unit of work.\nbuilder.Services.AddScoped<${ns}.Application.Common.IAuditWriter, ${ns}.Infrastructure.Persistence.AuditWriter>();`
    : "";

  // Domain persistence-port adapters (audit S7 Slice C): the orchestration
  // handlers (transactional workflow command, saga reactors, projection fold)
  // depend on IUnitOfWork / IWorkflowEventStore / ISagaStateStore /
  // IReadModelStore instead of the concrete AppDbContext.  All scoped over the
  // SAME request-scoped AppDbContext (identical transaction/flush semantics).
  // Emitted when the deployable hosts a workflow or projection (the port users)
  // — the exact gate PersistencePorts.cs is emitted under (index.ts).
  const usesPersistencePorts =
    (ctx.workflows?.length ?? 0) > 0 || (ctx.projections?.length ?? 0) > 0;
  // The Dapper path binds CLOSED port implementations (one per workflow /
  // projection / event-log context — no open-generic AppDbContext adapter),
  // computed in index.ts (it has the pre-merge context names the closed event
  // stores key off) and threaded in.  The EF path keeps the open generics.
  const portsDi = usesPersistencePorts
    ? usingDapper
      ? `\n// Domain persistence ports (M-T6.9) — Dapper adapters over NpgsqlDataSource (closed bindings).\n${(options?.dapperPortRegistrations ?? []).join("\n")}`
      : `\n// Domain persistence ports (audit S7 Slice C) — EF adapters over the scoped AppDbContext.\nbuilder.Services.AddScoped<${ns}.Domain.Common.IUnitOfWork, ${ns}.Infrastructure.Persistence.EfUnitOfWork>();\nbuilder.Services.AddScoped(typeof(${ns}.Domain.Common.IWorkflowEventStore<>), typeof(${ns}.Infrastructure.Persistence.EfWorkflowEventStore<>));\nbuilder.Services.AddScoped(typeof(${ns}.Domain.Common.ISagaStateStore<>), typeof(${ns}.Infrastructure.Persistence.EfSagaStateStore<>));\nbuilder.Services.AddScoped(typeof(${ns}.Domain.Common.IReadModelStore<>), typeof(${ns}.Infrastructure.Persistence.EfReadModelStore<>));`
    : "";

  // Extern application-layer handlers ([ExternHandler] scan targets).  Since
  // extern (b) Phase 2, an extern aggregate OPERATION is a domain partial-method
  // hook (no injected handler, no `[ExternHandler]`, no DI registration — a
  // missing implementation is a COMPILE error), so ONLY the extern
  // commandHandler / queryHandler application members (Phase 1's case-2 home)
  // register through the Scrutor scan.  Their user impl carries `[ExternHandler]`;
  // the same scan registers it under `I<Name>Handler` and the startup verify
  // fails fast when the user hasn't supplied one.
  const externHandlers = [...(ctx.commandHandlers ?? []), ...(ctx.queryHandlers ?? [])]
    .filter((h) => h.extern)
    .map((h) => ({
      ifaceFqn: `${ns}.Application.Handlers.I${h.name}Handler`,
      opName: h.name,
      aggName: ctx.name,
    }));
  // Only emit the Scrutor scan when at least one extern application handler
  // exists — otherwise the project pulls in a Scrutor reference for nothing.
  const externScan =
    externHandlers.length === 0
      ? ""
      : `// Extern application handlers — user implements the [ExternHandler]-decorated
// class for each I<Name>Handler port in Application/Handlers/.  Scrutor picks
// them up by attribute.
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
builder.Services.AddScoped<IUserVerifier, DevStubUserVerifier>();${
        oidc
          ? `
// OIDC verifier (D-AUTH-OIDC) — validates the IdP's tokens against its
// JWKS and maps claims onto User.  Registered last so it wins over the
// dev stub; configure the issuer / client via the env vars the
// \`auth { oidc }\` block referenced.
builder.Services.AddScoped<IUserVerifier, OidcUserVerifier>();`
          : ""
      }
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUserAccessor, HttpContextCurrentUserAccessor>();${
        orgPathResolver
          ? `
// Tenant hierarchy (multi-tenancy P2.2): the per-request \`orgPath\` resolver —
// currentUser.orgPath = the caller org's materialized \`data_key\`, read once
// per request by UserMiddleware and memoized on the principal (fail-safe to
// the claim).  Scoped: it holds the request-scoped AppDbContext.
builder.Services.AddScoped<IOrgPathResolver, EfOrgPathResolver>();`
          : ""
      }
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
  // Session probe for the frontend `auth: ui` guard — NOT in the bypass
  // list, so UserMiddleware has already resolved (or rejected) the
  // principal by the time this runs.  Returns the verified User as JSON.
  // `ExcludeFromDescription()` keeps it out of the OpenAPI contract — it's
  // an internal probe, not a business operation, and the Hono `/auth/me`
  // lives outside its OpenAPI doc too (cross-backend parity).
  const authMe = authRequired
    ? `app.MapGet("${AUTH_BASE_PATH}/me", (ICurrentUserAccessor accessor) => Results.Json(accessor.User)).ExcludeFromDescription();
`
    : "";
  // OIDC redirect handshake (/auth/login|callback|logout) — mounted under an
  // `auth { oidc }` block.  Excluded from the OpenAPI contract inside
  // MapAuthHandshake; the middleware bypasses these three paths.
  const authHandshake = oidc ? "app.MapAuthHandshake();\n" : "";
  return `// Auto-generated.
using System.Text.Json;
${usingDapper ? "using Npgsql;\n" : "using Microsoft.EntityFrameworkCore;\n"}${usesValidators ? "using FluentValidation;\n" : ""}${hangfireCronTimers ? "using Hangfire;\nusing Hangfire.PostgreSql;\n" : ""}using ${ns}.Api;
using ${ns}.Domain.Common;
using ${ns}.Infrastructure.Persistence;
using ${ns}.Infrastructure.Events;${options?.hasChannels ? `\nusing ${ns}.Infrastructure.Channels;` : ""}${authUsing}
using Prometheus;

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
  emitTrace || options?.hasAudit || options?.hasProvenance
    ? `
// ExecutionContextBehavior — Mediator pipeline behaviour that opens a
// per-dispatch frame on the ambient RequestContext for the duration of each
// dispatch, so audit / provenance rows stamp a real per-dispatch scope id +
// a parent id chaining to the caller (and, under --trace, the request logger
// reaches domain code via DomainLog → the frame's logger slice).  Registered
// whenever trace / audit / provenance is present; otherwise Program.cs stays
// free of the registration entirely.
builder.Services.AddScoped(
    typeof(Mediator.IPipelineBehavior<,>),
    typeof(${ns}.Application.Common.ExecutionContextBehavior<,>));
`
    : ""
}
${dispatcherRegistration}${timerRegistrations}${hangfireDiBlock}

${repoRegistrations}${readingServicesDi}${auditDi}${portsDi}
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
    // Canonical ISO-8601 UTC instants (RS-4): trim trailing zero fractional
    // seconds so an instant with no sub-second part serializes as "…00Z" (not
    // System.Text.Json's fixed 7-digit "…00.0000000Z"), matching the node /
    // Python / Java backends.  Business DTOs carry datetime as a pre-formatted
    // wire string; this covers any raw DateTime a controller serializes.
    opts.JsonSerializerOptions.Converters.Add(
        new ${ns}.Serialization.CanonicalInstantJsonConverter());
    opts.JsonSerializerOptions.Converters.Add(
        new ${ns}.Serialization.CanonicalInstantOffsetJsonConverter());
});

// Minimal-API JSON options — the /health + /ready probes (and the /auth/me
// session probe when auth is on) and any raw datetime a minimal endpoint
// returns serialize through ConfigureHttpJsonOptions rather than the MVC
// AddJsonOptions above.  Register the canonical instant converters here too so
// their wire matches the controllers' (RS-4 temporal round-trip parity).
builder.Services.ConfigureHttpJsonOptions(opts =>
{
    opts.SerializerOptions.Converters.Add(
        new ${ns}.Serialization.CanonicalInstantJsonConverter());
    opts.SerializerOptions.Converters.Add(
        new ${ns}.Serialization.CanonicalInstantOffsetJsonConverter());
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
${
  authRequired
    ? "            // Auth-bearing system: no origins configured, so no\n            // Access-Control-Allow-Origin is emitted and cross-origin is\n            // denied unless CORS_ORIGIN pins an explicit allowlist.\n            p.AllowAnyHeader().AllowAnyMethod();"
    : "            p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();"
}
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
    c.SwaggerDoc("openapi", new() { Title = "${ns}", Version = "v1" });
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
${hangfireRecurringBlock}
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
    ${asMigrationStmt(
      renderDotnetLogCall("migrationsStarting", [
        { name: "count", valueExpr: "pendingMigrations.Count" },
      ]),
    )}
    try
    {
        db.Database.Migrate();
        foreach (var migrationId in pendingMigrations)
        {
            ${asMigrationStmt(
              renderDotnetLogCall("migrationApplied", [
                { name: "id", valueExpr: "migrationId" },
                { name: "name", valueExpr: "migrationId" },
              ]),
            )}
        }
        ${asMigrationStmt(
          renderDotnetLogCall("migrationsComplete", [
            { name: "applied", valueExpr: "pendingMigrations.Count" },
          ]),
        )}
    }
    catch (Exception migrationError)
    {
        ${asMigrationStmt(
          renderDotnetLogCallWithException("migrationFailed", "migrationError", [
            { name: "error", valueExpr: "migrationError.Message" },
          ]),
        )}
        throw;
    }
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
// Prometheus scrape target — prometheus-net's MapMetrics serves the default
// registry (the .NET runtime + process metrics it auto-collects, plus the
// http_requests_total / http_request_duration_seconds recorded by
// RequestLoggingMiddleware) as the text exposition at /metrics.
app.MapMetrics();
// Ambient execution context — births the RequestContext (correlation id,
// locale, start time, scope id) and opens the root frame.  Mounted FIRST so
// the frame covers the entire pipeline: the request log below rides its
// scope_id (the cross-backend observability envelope — every backend carries
// scope_id on the request bracket), and bypassed (/health) + unauthenticated
// paths are covered too.  See Middleware/RequestContextMiddleware.cs.
app.UseMiddleware<${ns}.Middleware.RequestContextMiddleware>();
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
// Serve the spec at /openapi.json (documentName "openapi" → "{documentName}.json").
app.UseSwagger(c => c.RouteTemplate = "{documentName}.json");
${authMount}app.MapControllers();
${authMe}${authHandshake}${
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

/** Target framework moniker the generated projects build against.  Exported
 *  so the coreclr debug-launch config (`src/platform/dotnet.ts`'s
 *  `debugLaunch`) can point at the same `bin/Debug/<TFM>/` output directory
 *  `dotnet build` produces, without a second hardcoded copy. */
export const DOTNET_TFM = "net10.0";

export function renderCsproj(
  ns: string,
  hasExtern: boolean = false,
  usesValidators: boolean = false,
  resourceNugetDeps: Record<string, string> = {},
  usingDapper: boolean = false,
  usesSpecifications: boolean = false,
  oidc: boolean = false,
  withCronTimers: boolean = false,
  withRedisChannels: boolean = false,
): string {
  // OIDC token validation (D-AUTH-OIDC) — JWKS discovery + JWT validation
  // for the generated OidcUserVerifier.  Only ships under an `auth { oidc }`
  // block.
  // Broker channel transport (M-T4.4 slice 6a) — StackExchange.Redis (MIT,
  // design §6a) speaks RESP to the compose-provisioned Valkey sidecar.
  const redisChannelRef = withRedisChannels
    ? `\n    <!-- Redis channel transport (channels.md, M-T4.4) -->\n    <PackageReference Include="StackExchange.Redis" Version="2.8.16" />`
    : "";
  const oidcRefs = oidc
    ? `\n    <!-- OIDC token validation (generated OidcUserVerifier) -->\n    <PackageReference Include="Microsoft.IdentityModel.JsonWebTokens" Version="8.19.2" />\n    <PackageReference Include="Microsoft.IdentityModel.Protocols.OpenIdConnect" Version="8.19.2" />`
    : "";
  // Persistence package set — Dapper + raw Npgsql for `persistence: dapper`,
  // otherwise the EF Core 10 + Npgsql.EntityFrameworkCore stack.
  const persistenceRefs = usingDapper
    ? DAPPER_PROJECT_DEPS.join("\n")
    : `    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.10" />
    <!-- Pin Relational to the same version as the base package: the Design/Tools
         refs below are PrivateAssets (build-time only, not flowed to the sibling
         Tests project), so without an explicit ref the Relational version floats
         to the transitive floor of Npgsql.EFCore / Ardalis.Specification.EFCore
         (< the base), splitting the EF Core set and breaking the Tests project's
         reference unification (MSB3277). -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.10" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.3" />`;
  // Resource-client NuGet refs (Phase 4c) — AWSSDK.S3 / RabbitMQ.Client
  // etc., one row per package the deployable's consumed resources need.
  const resourceRefs = Object.entries(resourceNugetDeps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, version]) => `\n    <PackageReference Include="${id}" Version="${version}" />`)
    .join("");
  // Scrutor only ships when the project actually scans for
  // [ExternHandler]-decorated classes.
  const scrutorRef = hasExtern
    ? `\n    <!-- Scrutor — assembly scan for [ExternHandler]-decorated classes -->\n    <PackageReference Include="Scrutor" Version="7.0.0" />`
    : "";
  // FluentValidation only ships when at least one wire-translatable
  // invariant or precondition exists.  AspNetCore meta-package gives
  // `AddValidatorsFromAssembly` + DI integration in one ref.
  const validatorRef = usesValidators
    ? `\n    <!-- FluentValidation — wire-boundary validators (Mediator pipeline) -->\n    <PackageReference Include="FluentValidation" Version="12.1.1" />\n    <PackageReference Include="FluentValidation.DependencyInjectionExtensions" Version="12.1.1" />`
    : "";
  // Ardalis Specification — reified `criterion`/`retrieval` query objects.
  // EF-Core-only: the evaluator runs against `IQueryable`, which the Dapper
  // persistence axis doesn't have (it renders SQL fragments instead), so the
  // dependency ships only for the EF Core path with at least one retrieval.
  const specRef =
    usesSpecifications && !usingDapper
      ? `\n    <!-- Ardalis.Specification — reified retrieval/criterion query objects -->\n    <PackageReference Include="Ardalis.Specification" Version="9.3.1" />\n    <PackageReference Include="Ardalis.Specification.EntityFrameworkCore" Version="9.3.1" />`
      : "";
  // Hangfire — durable `timerSource … cron:` scheduling (scheduling.md Phase 2)
  // on Hangfire.PostgreSql storage.  Ships only when an owned timer uses a real
  // cron cadence (an `every:`-only deployable uses PeriodicTimer and needs no
  // dep).  Newtonsoft.Json is pinned to 13.x to override the vulnerable 11.0.1
  // Hangfire pulls transitively (NU1903 under /warnaserror).
  const cronosRef = withCronTimers
    ? `\n    <!-- Hangfire — durable cron timerSource scheduler (Postgres storage) -->\n    <PackageReference Include="Hangfire.AspNetCore" Version="1.8.21" />\n    <PackageReference Include="Hangfire.PostgreSql" Version="1.20.12" />\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />`
    : "";
  // MailKit (smtp mailer, kind: mailer) and its transitive MimeKit carry a
  // moderate BouncyCastle advisory present on every published version; the
  // generated code only uses the SMTP send path.  Suppress the two audit
  // entries so `dotnet build /warnaserror` (NU1902) passes with MailKit present.
  const mailkitAuditSuppress =
    "MailKit" in resourceNugetDeps
      ? `\n  <ItemGroup>
    <!-- MailKit/MimeKit: moderate transitive (BouncyCastle) advisory on every
         version; SMTP send path only.  See docs/old/proposals/email-resource-kind.md. -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-9j88-vvj5-vhgr" />
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-g7hc-96xr-gvvx" />
  </ItemGroup>`
      : "";
  return `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>${DOTNET_TFM}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>${ns}</RootNamespace>
    <!-- Roslyn analyzer level — see docs/old/proposals/cross-stack-static-analysis.md.
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
    <!-- CA1862 + CA1847: idiomatic-alternative suggestions the scalar-
         intrinsic contract can't take (src/util/intrinsics.ts).  CA1862
         wants \`string.Equals(x, StringComparison)\` instead of
         \`a.ToLowerInvariant() == b\` — but the == form is what EF Core
         translates to SQL lower() in the same expression, and the domain
         semantics are the catalogue's, not C#'s.  CA1847 wants
         \`Contains(char)\` for single-character literals — the intrinsic
         is string-typed by contract on every backend.
         CA1304 + CA1311: the EF-query position MUST spell case mapping as
         the parameterless ToUpper()/ToLower() (the only forms EF Core
         translates — the Invariant forms throw at query compile); they
         execute as SQL upper()/lower(), so no culture ever applies.
         MSG0005: Mediator 3's source generator warns on any IMessage with no
         registered handler.  Loom emits domain-event notifications that have
         no in-process subscriber by design (they exist for the outbox / event
         log / external consumers), so this fires on every such event — it's a
         false positive for this codegen model, not a missing handler. -->
    <NoWarn>CA1707;CA1848;CA1873;CA1862;CA1847;CA1304;CA1311;MSG0005</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <!-- Test files live in the sibling Tests/${ns}.Tests project -->
    <Compile Remove="Tests/**" />
    <None Remove="Tests/**" />
  </ItemGroup>
  <ItemGroup>
${persistenceRefs}
    <!-- Source-generated Mediator (https://github.com/martinothamar/Mediator) -->
    <PackageReference Include="Mediator.SourceGenerator" Version="3.0.2">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Mediator.Abstractions" Version="3.0.2" />
    <!-- OpenAPI spec emitted at /openapi.json -->
    <PackageReference Include="Swashbuckle.AspNetCore" Version="10.2.3" />
    <!-- Prometheus metrics at /metrics (prometheus-net) -->
    <PackageReference Include="prometheus-net.AspNetCore" Version="8.2.1" />${scrutorRef}${validatorRef}${specRef}${cronosRef}${redisChannelRef}${oidcRefs}${resourceRefs}
  </ItemGroup>${mailkitAuditSuppress}
</Project>
`;
}

export function renderTestCsproj(ns: string): string {
  return `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${DOTNET_TFM}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
    <RootNamespace>${ns}.Tests</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.8.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <!-- AwesomeAssertions: OSS continuation of FluentAssertions; backs the
         generated Should().Be / BeGreaterThan / etc. test matchers. -->
    <PackageReference Include="AwesomeAssertions" Version="9.4.0" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../${ns}.csproj" />
  </ItemGroup>
</Project>
`;
}

export function renderDockerfile(
  ns: string,
  options?: {
    hasEmbeddedSpa?: boolean;
    /** SPA build output dir relative to ClientApp/ — `dist` for the
     *  React/Vite embed, `build` for the SvelteKit adapter-static
     *  embed.  Defaults to `dist`. */
    spaOutDir?: "dist" | "build";
  },
): string {
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

FROM node:24-alpine AS spa-build
WORKDIR /spa
COPY ClientApp/package.json ClientApp/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund || npm install
COPY ClientApp/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-build
WORKDIR /src
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>&1 | tail -1 || true
COPY ${ns}.csproj ./
RUN dotnet restore ${ns}.csproj
COPY . .
RUN dotnet publish ${ns}.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
# wget for the compose healthcheck (see the other dockerfile branch).
RUN apt-get update -y && apt-get install -y --no-install-recommends wget \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=dotnet-build /app/publish ./
# SPA bundle lands under wwwroot/ so UseStaticFiles + MapFallbackToFile
# can serve it on the same origin as the /api/* controller routes.
COPY --from=spa-build /spa/${options?.spaOutDir ?? "dist"} ./wwwroot
ENTRYPOINT ["dotnet", "${ns}.dll"]
`;
  }
  return `# syntax=docker/dockerfile:1
# Auto-generated.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
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

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
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
