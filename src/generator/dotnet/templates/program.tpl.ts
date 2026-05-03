import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const PROGRAM_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
using {{ns}}.Api;
using {{ns}}.Domain.Common;
using {{ns}}.Infrastructure.Persistence;
using {{ns}}.Infrastructure.Events;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Mediator (martinothamar/Mediator) — source-generated, free to use.
builder.Services.AddMediator(opts => opts.ServiceLifetime = ServiceLifetime.Scoped);

// Domain event dispatch — default no-op; replace in tests / production.
builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();

{{#each aggregates}}builder.Services.AddScoped<{{../ns}}.Domain.{{plural name}}.I{{name}}Repository, {{../ns}}.Infrastructure.Repositories.{{name}}Repository>();
{{/each}}
builder.Services.AddControllers(opts =>
{
    opts.Filters.Add<DomainExceptionFilter>();
});

var app = builder.Build();
app.MapControllers();
app.Run();
`,
);

const CSPROJ_TPL = hb.compile(
  `<!-- Auto-generated. -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>{{ns}}</RootNamespace>
  </PropertyGroup>
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
  </ItemGroup>
</Project>
`,
);

export function renderProgram(ctx: BoundedContextIR, ns: string): string {
  return PROGRAM_TPL({ ns, aggregates: ctx.aggregates });
}

export function renderCsproj(ns: string): string {
  return CSPROJ_TPL({ ns });
}
