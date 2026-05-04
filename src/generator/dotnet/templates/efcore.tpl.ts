import type {
  AggregateIR,
  BoundedContextIR,
} from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const DBCONTEXT_TPL = hb.compile(
  `// Auto-generated.
using Microsoft.EntityFrameworkCore;
{{#each aggregates}}using {{../ns}}.Domain.{{plural name}};
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
using {{ns}}.Domain.{{plural aggregate.name}};
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
{{/if}}{{/each}}{{#each containments}}{{#if collection}}        // Ignore the public read-accessor and tell EF to map the
        // private backing field instead.
        b.Ignore(x => x.{{pascal name}});
        b.OwnsMany<{{partName}}>("_{{name}}", o => {
            o.ToTable("{{snake (plural partName)}}");
            o.WithOwner().HasForeignKey("ParentId");
            o.HasKey(x => x.Id);
            o.Property(x => x.Id).HasConversion(v => v.Value, v => new {{partName}}Id(v));
{{#each partFields}}{{#if (isIdField this)}}            o.Property(x => x.{{pascal name}}).HasConversion(v => v.Value, v => new {{type.targetName}}Id(v));
{{else if (isEnumField this)}}            o.Property(x => x.{{pascal name}}).HasConversion<string>();
{{else if (ownedRef this)}}            o.OwnsOne<{{type.name}}>(x => x.{{pascal name}});
{{/if}}{{/each}}        });
{{else}}        b.OwnsOne<{{partName}}>(x => x.{{pascal name}});
{{/if}}{{/each}}        b.Ignore(x => x.DomainEvents);
    }
}
`,
);

export function renderDbContext(ctx: BoundedContextIR, ns: string): string {
  return DBCONTEXT_TPL({ aggregates: ctx.aggregates, ns });
}

export function renderConfiguration(agg: AggregateIR, ns: string): string {
  // Pre-resolve `partFields` per containment so the template can emit
  // the right HasConversion / OwnsOne calls inside each `OwnsMany`
  // block without doing AST lookups itself.
  const containments = agg.contains.map((c) => {
    const part = agg.parts.find((p) => p.name === c.partName);
    return { ...c, partFields: part?.fields ?? [] };
  });
  return CONFIG_TPL({ aggregate: agg, containments, ns });
}
