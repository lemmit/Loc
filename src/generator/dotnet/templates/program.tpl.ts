import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { pascal, plural } from "../../../util/naming.js";

// Program.cs hosting + DI registration, plus the project + Dockerfile +
// .dockerignore boilerplate.  Pure substitution templates — no
// iteration tricks.

export function renderProgram(
  ctx: BoundedContextIR,
  ns: string,
  options?: {
    authRequired?: boolean;
    usesValidators?: boolean;
    /** Fullstack-dotnet flag: when true, the deployable hosts an
     *  embedded React SPA from `wwwroot/`.  Adds `UseDefaultFiles` +
     *  `UseStaticFiles` middleware and a `MapFallbackToFile` so SPA
     *  client-side routes load `index.html` while controller routes
     *  (now under `/api/*`, see `routePrefix` in the api template)
     *  match first.  Off for backend-only .NET. */
    hasEmbeddedSpa?: boolean;
  },
): string {
  const authRequired = !!options?.authRequired;
  const usesValidators = !!options?.usesValidators;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const repoRegistrations = ctx.aggregates
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
        ifaceFqn: `${ns}.Application.${plural(a.name)}.Handlers.I${pascal(o.name)}${a.name}Handler`,
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
      `        throw new System.InvalidOperationException(\n` +
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
        throw new System.InvalidOperationException(
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
using Microsoft.EntityFrameworkCore;
using ${ns}.Api;
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
        throw new System.InvalidOperationException(
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
    opts.JsonWriterOptions = new System.Text.Json.JsonWriterOptions
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
}
// Domain event dispatch — default no-op; replace in tests / production.
builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();

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
        System.Text.Json.JsonNamingPolicy.CamelCase;
    opts.JsonSerializerOptions.DictionaryKeyPolicy =
        System.Text.Json.JsonNamingPolicy.CamelCase;
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
});

var app = builder.Build();
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
    catch (System.Exception ex)
    {
        return Results.Json(
            new { status = "not_ready", error = ex.Message },
            statusCode: 503);
    }
});
// HTTP logging middleware — pairs with AddHttpLogging above.
// Mounted before the auth + business pipelines so every request is
// logged regardless of whether it reached a controller.
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
${authVerify}${externVerify}
// Graceful shutdown — log the intent so operators see "shutting down"
// in container logs instead of an abrupt SIGKILL trace.  ASP.NET
// Core's host already drains in-flight requests + disposes scoped
// services (including AppDbContext) automatically; this hook is just
// the visible breadcrumb.
{
    var lifetime = app.Services.GetRequiredService<Microsoft.Extensions.Hosting.IHostApplicationLifetime>();
    var logger = app.Services.GetRequiredService<Microsoft.Extensions.Logging.ILoggerFactory>()
        .CreateLogger("Shutdown");
    lifetime.ApplicationStopping.Register(() =>
        logger.LogInformation("Shutting down — draining in-flight requests."));
}
app.Run();
`;
}

export function renderCsproj(
  ns: string,
  hasExtern: boolean = false,
  usesValidators: boolean = false,
): string {
  // Scrutor only ships when the project actually scans for
  // [ExternHandler]-decorated classes.
  const scrutorRef = hasExtern
    ? `\n    <!-- Scrutor — assembly scan for [ExternHandler]-decorated classes -->\n    <PackageReference Include="Scrutor" Version="5.0.2" />`
    : "";
  // FluentValidation only ships when at least one wire-translatable
  // invariant or precondition exists.  AspNetCore meta-package gives
  // `AddValidatorsFromAssembly` + DI integration in one ref.
  const validatorRef = usesValidators
    ? `\n    <!-- FluentValidation — slice 21.B wire-boundary validators (Mediator pipeline) -->\n    <PackageReference Include="FluentValidation" Version="11.10.0" />\n    <PackageReference Include="FluentValidation.DependencyInjectionExtensions" Version="11.10.0" />`
    : "";
  return `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>${ns}</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <!-- Test files live in the sibling Tests/${ns}.Tests project -->
    <Compile Remove="Tests/**" />
    <None Remove="Tests/**" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.10" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="8.0.10">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.10" />
    <!-- Source-generated Mediator (https://github.com/martinothamar/Mediator) -->
    <PackageReference Include="Mediator.SourceGenerator" Version="2.1.7">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="Mediator.Abstractions" Version="2.1.7" />
    <!-- OpenAPI spec emitted at /swagger/v1/swagger.json -->
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.9.0" />${scrutorRef}${validatorRef}
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
