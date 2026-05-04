import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { plural } from "../../../util/naming.js";

// Program.cs hosting + DI registration, plus the project + Dockerfile +
// .dockerignore boilerplate.  Pure substitution templates — no
// iteration tricks.

export function renderProgram(ctx: BoundedContextIR, ns: string): string {
  const repoRegistrations = ctx.aggregates
    .map(
      (a) =>
        `builder.Services.AddScoped<${ns}.Domain.${plural(a.name)}.I${a.name}Repository, ${ns}.Infrastructure.Repositories.${a.name}Repository>();`,
    )
    .join("\n");
  return `// Auto-generated.
using Microsoft.EntityFrameworkCore;
using ${ns}.Api;
using ${ns}.Domain.Common;
using ${ns}.Infrastructure.Persistence;
using ${ns}.Infrastructure.Events;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Mediator (martinothamar/Mediator) — source-generated, free to use.
builder.Services.AddMediator(opts => opts.ServiceLifetime = ServiceLifetime.Scoped);

// Domain event dispatch — default no-op; replace in tests / production.
builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();

${repoRegistrations}
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
// Liveness probe — used by docker-compose / kubernetes / smoke tests.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
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
`;
}

export function renderCsproj(ns: string): string {
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
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.9.0" />
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

export function renderDockerfile(ns: string): string {
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
