import Handlebars from "handlebars";
import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  EntityPartIR,
  ExprIR,
  FieldIR,
  ParamIR,
  RepositoryIR,
  StmtIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../util/naming.js";
import {
  csNewIdValue,
  csValueTypeForId,
  renderCsExpr,
  renderCsType,
} from "./render-expr.js";
import { renderCsStatements } from "./render-stmt.js";

// ---------------------------------------------------------------------------
// Handlebars setup
// ---------------------------------------------------------------------------

const hb = Handlebars.create();

hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hb.registerHelper("pascal", (s: string) => pascal(s));
hb.registerHelper("plural", (s: string) => plural(s));
hb.registerHelper("snake", (s: string) => snake(s));
hb.registerHelper("csType", (t: TypeIR) => renderCsType(t));
hb.registerHelper("csExpr", (e: ExprIR) => new hb.SafeString(renderCsExpr(e)));
hb.registerHelper("csStmts", (s: StmtIR[]) => new hb.SafeString(renderCsStatements(s)));
hb.registerHelper("csParams", (params: ParamIR[]) =>
  params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", "),
);
hb.registerHelper("escapeStr", (s: string) => new hb.SafeString(JSON.stringify(s)));
hb.registerHelper("requiredFields", (fields: FieldIR[]) =>
  fields.filter((f) => !f.optional),
);
hb.registerHelper("isPublic", (visibility: string) => visibility === "public");
hb.registerHelper("isOwnsMany", (c: ContainmentIR) => c.collection);
hb.registerHelper("ownedRef", (f: FieldIR) =>
  f.type.kind === "valueobject",
);
hb.registerHelper("isIdField", (f: FieldIR) => f.type.kind === "id");
hb.registerHelper("isEnumField", (f: FieldIR) => f.type.kind === "enum");

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const ID_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Ids;

public readonly record struct {{name}}Id({{valueType}} Value)
{
    public static {{name}}Id New() => new({{newExpr}});
    public override string ToString() => Value.ToString()!;
}
`,
);

const ENUM_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Enums;

public enum {{name}}
{
{{#each values}}    {{this}}{{#unless @last}},{{/unless}}
{{/each}}
}
`,
);

const VALUEOBJECT_TPL = hb.compile(
  `// Auto-generated.
using {{ns}}.Domain.Common;

namespace {{ns}}.Domain.ValueObjects;

public sealed record {{name}}({{#each fields}}{{csType type}} {{pascal name}}{{#unless @last}}, {{/unless}}{{/each}})
{
{{#if invariants.length}}    public {{name}}() : this({{#each fields}}default!{{#unless @last}}, {{/unless}}{{/each}})
    {
{{#each invariants}}        {{#if guard}}if (({{csExpr guard}}) && !({{csExpr expr}})){{else}}if (!({{csExpr expr}})){{/if}} throw new DomainException({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}    }
{{/if}}
{{#each derived}}    public {{csType type}} {{pascal name}} => {{csExpr expr}};
{{/each}}
{{#each functions}}    private {{csType returnType}} {{pascal name}}({{csParams params}}) => {{csExpr body}};
{{/each}}
}
`,
);

const EVENT_TPL = hb.compile(
  `// Auto-generated.
using {{ns}}.Domain.Ids;

namespace {{ns}}.Domain.Events;

public sealed record {{name}}({{#each fields}}{{csType type}} {{pascal name}}{{#unless @last}}, {{/unless}}{{/each}}) : IDomainEvent;
`,
);

const IDOMAINEVENT_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Events;

public interface IDomainEvent { }
`,
);

const COMMON_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Common;

public sealed class DomainException : System.Exception
{
    public DomainException(string message) : base(message) { }
}

public sealed class AggregateNotFoundException : System.Exception
{
    public AggregateNotFoundException(string message) : base(message) { }
}
`,
);

const ENTITY_TPL = hb.compile(
  `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.Events;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;
using {{ns}}.Domain.Common;

namespace {{ns}}.Domain.{{aggName}};

public sealed class {{name}}
{
    public {{name}}Id Id { get; private set; }
{{#unless isRoot}}    public {{rootName}}Id ParentId { get; private set; }
{{/unless}}
{{#each fields}}    public {{csType type}} {{pascal name}} { get; private set; }{{#if optional}} = default;{{else}} = default!;{{/if}}
{{/each}}{{#each contains}}{{#if collection}}    private readonly List<{{partName}}> _{{name}} = new();
    public IReadOnlyList<{{partName}}> {{pascal name}} => _{{name}}.AsReadOnly();
{{else}}    public {{partName}} {{pascal name}} { get; private set; } = default!;
{{/if}}{{/each}}
{{#if isRoot}}    private readonly List<IDomainEvent> _domainEvents = new();
    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
{{/if}}
    private {{name}}()
    {
        Id = default!;
{{#unless isRoot}}        ParentId = default!;
{{/unless}}{{#each fields}}        {{pascal name}} = default!;
{{/each}}    }

{{#each derived}}    public {{csType type}} {{pascal name}} => {{csExpr expr}};
{{/each}}
{{#each functions}}    private {{csType returnType}} {{pascal name}}({{csParams params}}) => {{csExpr body}};
{{/each}}
{{#if isRoot}}{{#each operations}}    {{#if (isPublic visibility)}}public{{else}}private{{/if}} void {{pascal name}}({{csParams params}})
    {
{{csStmts statements}}
        AssertInvariants();
    }

{{/each}}{{/if}}
{{#if isRoot}}    public IReadOnlyList<IDomainEvent> PullEvents()
    {
        var copy = _domainEvents.ToArray();
        _domainEvents.Clear();
        return copy;
    }

{{/if}}    private void AssertInvariants()
    {
{{#each invariants}}        {{#if guard}}if (({{csExpr guard}}) && !({{csExpr expr}})){{else}}if (!({{csExpr expr}})){{/if}} throw new DomainException({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}    }

    public sealed class State
    {
        public {{name}}Id Id { get; init; } = default!;
{{#unless isRoot}}        public {{rootName}}Id ParentId { get; init; } = default!;
{{/unless}}{{#each fields}}        public {{csType type}} {{pascal name}} { get; init; } = default!;
{{/each}}    }

    public static {{name}} _Create(State s)
    {
        var e = new {{name}}();
        e.Id = s.Id;
{{#unless isRoot}}        e.ParentId = s.ParentId;
{{/unless}}{{#each fields}}        e.{{pascal name}} = s.{{pascal name}};
{{/each}}        e.AssertInvariants();
        return e;
    }
{{#if isRoot}}
    public static {{name}} Create({{#each (requiredFields fields)}}{{csType type}} {{name}}{{#unless @last}}, {{/unless}}{{/each}})
    {
        var e = new {{name}}();
        e.Id = new {{name}}Id({{newIdExpr}});
{{#each (requiredFields fields)}}        e.{{pascal name}} = {{name}};
{{/each}}        e.AssertInvariants();
        return e;
    }
{{/if}}
}
`,
);

const REPOSITORY_INTERFACE_TPL = hb.compile(
  `// Auto-generated.
using {{ns}}.Domain.Ids;

namespace {{ns}}.Domain.{{name}};

public interface I{{name}}Repository
{
    System.Threading.Tasks.Task<{{name}}?> GetByIdAsync({{name}}Id id, System.Threading.CancellationToken ct = default);
    System.Threading.Tasks.Task SaveAsync({{name}} aggregate, System.Threading.CancellationToken ct = default);
{{#each finds}}    System.Threading.Tasks.Task<{{csType returnType}}> {{pascal name}}({{csParams params}}, System.Threading.CancellationToken ct = default);
{{/each}}
}
`,
);

const REPOSITORY_IMPL_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
using {{ns}}.Domain.{{name}};
using {{ns}}.Domain.Ids;
using {{ns}}.Infrastructure.Persistence;

namespace {{ns}}.Infrastructure.Repositories;

public sealed class {{name}}Repository : I{{name}}Repository
{
    private readonly AppDbContext _db;
    public {{name}}Repository(AppDbContext db) => _db = db;

    public async System.Threading.Tasks.Task<{{name}}?> GetByIdAsync({{name}}Id id, System.Threading.CancellationToken ct = default)
    {
        return await _db.{{plural (pascal name)}}.FirstOrDefaultAsync(x => x.Id == id, ct);
    }

    public async System.Threading.Tasks.Task SaveAsync({{name}} aggregate, System.Threading.CancellationToken ct = default)
    {
        var existing = await _db.{{plural (pascal name)}}.FirstOrDefaultAsync(x => x.Id == aggregate.Id, ct);
        if (existing == null) _db.{{plural (pascal name)}}.Add(aggregate);
        else _db.Entry(existing).CurrentValues.SetValues(aggregate);
        await _db.SaveChangesAsync(ct);
        var events = aggregate.PullEvents();
        // dispatch via injected event bus (stub)
    }
{{#each finds}}
    public async System.Threading.Tasks.Task<{{csType returnType}}> {{pascal name}}({{csParams params}}, System.Threading.CancellationToken ct = default)
    {
        await System.Threading.Tasks.Task.CompletedTask;
        return default!;
    }
{{/each}}
}
`,
);

const DBCONTEXT_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
{{#each aggregates}}using {{../ns}}.Domain.{{name}};
{{/each}}
namespace {{ns}}.Infrastructure.Persistence;

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

{{#each aggregates}}    public DbSet<{{name}}> {{plural (pascal name)}} => Set<{{name}}>();
{{/each}}
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
{{#each aggregates}}        modelBuilder.ApplyConfiguration(new Configurations.{{name}}Configuration());
{{/each}}    }
}
`,
);

const CONFIG_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using {{ns}}.Domain.{{aggregate.name}};
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;

namespace {{ns}}.Infrastructure.Persistence.Configurations;

public sealed class {{aggregate.name}}Configuration : IEntityTypeConfiguration<{{aggregate.name}}>
{
    public void Configure(EntityTypeBuilder<{{aggregate.name}}> b)
    {
        b.ToTable("{{snake (plural aggregate.name)}}");
        b.HasKey(x => x.Id);
        b.Property(x => x.Id).HasConversion(v => v.Value, v => new {{aggregate.name}}Id(v));
{{#each aggregate.fields}}{{#if (isIdField this)}}        b.Property(x => x.{{pascal name}}).HasConversion(v => v.Value, v => new {{type.targetName}}Id(v));
{{else if (isEnumField this)}}        b.Property(x => x.{{pascal name}}).HasConversion<string>();
{{else if (ownedRef this)}}        b.OwnsOne<{{type.name}}>(x => x.{{pascal name}});
{{/if}}{{/each}}{{#each aggregate.contains}}{{#if collection}}        b.OwnsMany<{{partName}}>("_{{name}}", o => {
            o.ToTable("{{snake (plural partName)}}");
            o.WithOwner().HasForeignKey("ParentId");
            o.HasKey(x => x.Id);
            o.Property(x => x.Id).HasConversion(v => v.Value, v => new {{partName}}Id(v));
        });
{{else}}        b.OwnsOne<{{partName}}>(x => x.{{pascal name}});
{{/if}}{{/each}}        b.Ignore(x => x.DomainEvents);
    }
}
`,
);

const COMMAND_TPL = hb.compile(
  `// Auto-generated.
using MediatR;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;

namespace {{ns}}.Application.{{aggName}}.Commands;

public sealed record {{commandName}}({{commandParams}}){{#if returnType}} : IRequest<{{returnType}}>{{else}} : IRequest{{/if}};
`,
);

const COMMAND_HANDLER_TPL = hb.compile(
  `// Auto-generated.
using MediatR;
using {{ns}}.Domain.{{aggName}};
using {{ns}}.Domain.Common;

namespace {{ns}}.Application.{{aggName}}.Commands;

public sealed class {{handlerName}} : IRequestHandler<{{commandName}}{{#if returnType}}, {{returnType}}{{/if}}>
{
    private readonly I{{aggName}}Repository _repo;
    public {{handlerName}}(I{{aggName}}Repository repo) => _repo = repo;

    public async System.Threading.Tasks.Task{{#if returnType}}<{{returnType}}>{{/if}} Handle({{commandName}} cmd, System.Threading.CancellationToken ct)
    {
{{{body}}}    }
}
`,
);

const QUERY_TPL = hb.compile(
  `// Auto-generated.
using MediatR;
using {{ns}}.Domain.Ids;

namespace {{ns}}.Application.{{aggName}}.Queries;

public sealed record {{queryName}}({{queryParams}}) : IRequest<{{returnType}}>;
{{#if dto}}

public sealed record {{aggName}}Dto({{aggName}}Id Id);
{{/if}}
`,
);

const QUERY_HANDLER_TPL = hb.compile(
  `// Auto-generated.
using MediatR;
using {{ns}}.Domain.{{aggName}};

namespace {{ns}}.Application.{{aggName}}.Queries;

public sealed class {{handlerName}} : IRequestHandler<{{queryName}}, {{returnType}}>
{
    private readonly I{{aggName}}Repository _repo;
    public {{handlerName}}(I{{aggName}}Repository repo) => _repo = repo;

    public async System.Threading.Tasks.Task<{{returnType}}> Handle({{queryName}} q, System.Threading.CancellationToken ct)
    {
{{{body}}}    }
}
`,
);

const CONTROLLER_TPL = hb.compile(
  `// Auto-generated.
using MediatR;
using Microsoft.AspNetCore.Mvc;
using {{ns}}.Application.{{aggregate.name}}.Commands;
using {{ns}}.Application.{{aggregate.name}}.Queries;
using {{ns}}.Domain.Ids;

namespace {{ns}}.Api;

[ApiController]
[Route("{{snake (plural aggregate.name)}}")]
public sealed class {{plural (pascal aggregate.name)}}Controller : ControllerBase
{
    private readonly ISender _sender;
    public {{plural (pascal aggregate.name)}}Controller(ISender sender) => _sender = sender;

    [HttpPost]
    public async System.Threading.Tasks.Task<ActionResult<{{aggregate.name}}Id>> Create([FromBody] Create{{aggregate.name}}Command cmd)
        => Ok(await _sender.Send(cmd));

    [HttpGet("{id}")]
    public async System.Threading.Tasks.Task<ActionResult<{{aggregate.name}}Dto>> GetById({{aggregate.name}}Id id)
    {
        var dto = await _sender.Send(new Get{{aggregate.name}}ByIdQuery(id));
        return dto is null ? NotFound() : Ok(dto);
    }

{{#each publicOps}}    [HttpPost("{id}/{{snake name}}")]
    public async System.Threading.Tasks.Task<IActionResult> {{pascal name}}({{../aggregate.name}}Id id, [FromBody] {{pascal name}}Command cmd)
    {
        await _sender.Send(cmd with { Id = id });
        return Ok();
    }

{{/each}}{{#each finds}}    [HttpGet("{{snake name}}")]
    public async System.Threading.Tasks.Task<IActionResult> {{pascal name}}({{#each params}}[FromQuery] {{csType type}} {{name}}{{#unless @last}}, {{/unless}}{{/each}})
    {
        var result = await _sender.Send(new {{pascal name}}Query({{#each params}}{{name}}{{#unless @last}}, {{/unless}}{{/each}}));
        return Ok(result);
    }

{{/each}}
}
`,
);

const FILTER_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using {{ns}}.Domain.Common;

namespace {{ns}}.Api;

public sealed class DomainExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is DomainException de)
        {
            context.Result = new BadRequestObjectResult(new { error = de.Message });
            context.ExceptionHandled = true;
        }
        else if (context.Exception is AggregateNotFoundException nf)
        {
            context.Result = new NotFoundObjectResult(new { error = nf.Message });
            context.ExceptionHandled = true;
        }
    }
}
`,
);

const PROGRAM_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
using {{ns}}.Api;
using {{ns}}.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddMediatR(cfg => cfg.RegisterServicesFromAssembly(typeof(Program).Assembly));

{{#each aggregates}}builder.Services.AddScoped<{{../ns}}.Domain.{{name}}.I{{name}}Repository, {{../ns}}.Infrastructure.Repositories.{{name}}Repository>();
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
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.0" />
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />
    <PackageReference Include="MediatR" Version="12.4.0" />
  </ItemGroup>
</Project>
`,
);

// ---------------------------------------------------------------------------
// Public renderers
// ---------------------------------------------------------------------------

hb.registerHelper("concat", (...args: unknown[]) => args.slice(0, -1).join(""));

export interface DotnetEmitContext {
  ns: string;
}

export function renderId(name: string, idValueType: string, ns: string): string {
  return ID_TPL({
    name,
    valueType: csValueTypeForId(idValueType),
    newExpr: csNewIdValue(idValueType),
    ns,
  });
}

export function renderEnum(e: { name: string; values: string[] }, ns: string): string {
  return ENUM_TPL({ name: e.name, values: e.values, ns });
}

export function renderValueObject(
  vo: import("../../ir/loom-ir.js").ValueObjectIR,
  ns: string,
): string {
  return VALUEOBJECT_TPL({ ...vo, ns });
}

export function renderEvent(e: import("../../ir/loom-ir.js").EventIR, ns: string): string {
  return EVENT_TPL({ ...e, ns });
}

export function renderIDomainEvent(ns: string): string {
  return IDOMAINEVENT_TPL({ ns });
}

export function renderCommon(ns: string): string {
  return COMMON_TPL({ ns });
}

export function renderEntity(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  ns: string,
  rootName: string,
): string {
  const isAgg = "operations" in entity;
  return ENTITY_TPL({
    name: entity.name,
    aggName: rootName,
    rootName,
    isRoot,
    fields: entity.fields,
    contains: entity.contains,
    derived: entity.derived,
    invariants: entity.invariants,
    functions: entity.functions,
    operations: isAgg ? (entity as AggregateIR).operations : [],
    newIdExpr: csNewIdValue(isAgg ? (entity as AggregateIR).idValueType : "guid"),
    ns,
  });
}

export function renderRepositoryInterface(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
): string {
  return REPOSITORY_INTERFACE_TPL({ name: agg.name, finds: repo?.finds ?? [], ns });
}

export function renderRepositoryImpl(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
): string {
  return REPOSITORY_IMPL_TPL({ name: agg.name, finds: repo?.finds ?? [], ns });
}

export function renderDbContext(ctx: BoundedContextIR, ns: string): string {
  return DBCONTEXT_TPL({ aggregates: ctx.aggregates, ns });
}

export function renderConfiguration(agg: AggregateIR, ns: string): string {
  return CONFIG_TPL({ aggregate: agg, ns });
}

export function renderCommand(args: {
  ns: string;
  aggName: string;
  commandName: string;
  commandParams: string;
  returnType?: string;
}): string {
  return COMMAND_TPL(args);
}

export function renderCommandHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  commandName: string;
  returnType?: string;
  body: string;
}): string {
  return COMMAND_HANDLER_TPL(args);
}

export function renderQuery(args: {
  ns: string;
  aggName: string;
  queryName: string;
  queryParams: string;
  returnType: string;
  dto?: boolean;
}): string {
  return QUERY_TPL(args);
}

export function renderQueryHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  queryName: string;
  returnType: string;
  body: string;
}): string {
  return QUERY_HANDLER_TPL(args);
}

export function renderController(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
): string {
  return CONTROLLER_TPL({
    aggregate: agg,
    publicOps: agg.operations.filter((o) => o.visibility === "public"),
    finds: repo?.finds ?? [],
    ns,
  });
}

export function renderExceptionFilter(ns: string): string {
  return FILTER_TPL({ ns });
}

export function renderProgram(ctx: BoundedContextIR, ns: string): string {
  return PROGRAM_TPL({ ns, aggregates: ctx.aggregates });
}

export function renderCsproj(ns: string): string {
  return CSPROJ_TPL({ ns });
}
