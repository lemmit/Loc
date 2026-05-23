// .NET runtime capability translation, end-to-end.
//
// Capability AST (contributed by `with auditable` / `with
// softDeletable` or hand-written `filter` / `stamp` / `implements`)
// must reach the generated .cs output via the existing expression
// renderer.  No hardcoded field names — just AST translation plus
// per-capability grouping by `implementsCapabilities`.
//
// What the tests verify:
//   - One marker interface file per declared capability name
//     (`Domain/Common/IAuditable.cs`, `Domain/Common/ISoftDeletable.cs`).
//     The interfaces are empty — they only tag entities for the
//     OnModelCreating filter pass.
//   - Entity class declarations carry `: IAuditable, ISoftDeletable`
//     iff the aggregate has matching `implements` declarations.
//   - HasQueryFilter is installed via DbContext-level loops, not
//     per-EntityConfiguration.  The lambda predicate translates the
//     macro-supplied AST: `!this.isDeleted` → `!x.IsDeleted`.
//   - SaveChangesInterceptor is registry-driven: a switch on
//     entity type with per-aggregate stamping bodies.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../src/generator/dotnet/index.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

async function modelFrom(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(source, { validation: true });
  return doc.parseResult.value;
}

// `auditable` references Id<User> and currentUser, so the source
// always declares a sibling User aggregate.
const aggregateOnly = (extras: string) => `
  context Sales {
    aggregate User { name: string }
    aggregate Order ${extras} {
      subject: string
    }
    repository Orders for Order { }
    repository Users for User { }
  }
`;

describe(".NET generator: marker interfaces, driven by `implements`", () => {
  it("emits Domain/Common/IAuditable.cs when any aggregate implements auditable", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).toContain("Domain/Common/IAuditable.cs");
    const src = files.get("Domain/Common/IAuditable.cs")!;
    // Empty marker interface — type tag only, no declared members.
    expect(src).toMatch(/public interface IAuditable \{ \}/);
  });

  it("emits Domain/Common/ISoftDeletable.cs when any aggregate implements softDeletable", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).toContain("Domain/Common/ISoftDeletable.cs");
  });

  it("does NOT emit marker interfaces for projects with no `implements` decls", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    const keys = [...files.keys()];
    expect(keys.filter((k) => k.startsWith("Domain/Common/I") && k.endsWith(".cs"))).toEqual([]);
  });

  it("entity class declaration carries `: I<Cap>` for each declared capability", async () => {
    const model = await modelFrom(aggregateOnly("with auditable, softDeletable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs")!;
    expect(orderCs).toMatch(/public sealed class Order : IAuditable, ISoftDeletable/);
  });

  it("entity class declaration is plain when no `implements` was declared", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs")!;
    expect(orderCs).toMatch(/public sealed class Order\n/);
    expect(orderCs).not.toMatch(/: I/);
  });
});

describe(".NET generator: DbContext-level HasQueryFilter pass", () => {
  it("AppDbContext.OnModelCreating runs one loop per capability that has filters", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    const ctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toMatch(/foreach \(var entityType in modelBuilder\.Model\.GetEntityTypes/);
    expect(ctx).toMatch(/typeof\(ISoftDeletable\)\.IsAssignableFrom\(entityType\.ClrType\)/);
    expect(ctx).toMatch(/SoftDeletableFilters\.Apply\(modelBuilder, entityType\.ClrType\)/);
  });

  it("emits Infrastructure/Persistence/<Cap>Filters.cs with per-aggregate Apply methods", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    const path = "Infrastructure/Persistence/SoftDeletableFilters.cs";
    expect([...files.keys()]).toContain(path);
    const src = files.get(path)!;
    expect(src).toMatch(/public static class SoftDeletableFilters/);
    expect(src).toMatch(/public static void ApplyToOrder\(ModelBuilder mb\)/);
    expect(src).toMatch(/mb\.Entity<Order>\(\)\.HasQueryFilter\(x => !x\.IsDeleted\);/);
  });

  it("per-EntityConfiguration HasQueryFilter is NOT emitted when the aggregate uses `implements`", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    // Filter lives in the DbContext pass + helper, not here.
    expect(cfg).not.toMatch(/HasQueryFilter/);
  });

  it("anonymous filter (no `implements`) falls back to per-EntityConfiguration emission", async () => {
    // Hand-written `filter` with no `implements` — generator can't
    // group, so it installs the filter in the entity config.
    const model = await modelFrom(`
      context Sales {
        aggregate Order {
          subject: string
          archived: bool
          filter !this.archived
        }
        repository Orders for Order { }
      }
    `);
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/b\.HasQueryFilter\(x => !x\.Archived\)/);
  });
});

describe(".NET generator: registry-driven SaveChangesInterceptor", () => {
  it("emits AuditableInterceptor.cs when any aggregate has contextStamps", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const src = files.get("Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(/switch \(entry\.Entity\)/);
    expect(src).toMatch(/case Order /);
  });

  it("interceptor body assigns the macro-supplied fields", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const src = files.get("Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(/e\.CreatedAt =/);
    expect(src).toMatch(/e\.UpdatedAt =/);
  });

  it("Program.cs registers the interceptor when stamping is used", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddScoped<Sales\.Infrastructure\.Persistence\.AuditableInterceptor>/);
  });

  it("softDeletable alone does NOT trigger interceptor emission", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).not.toContain(
      "Infrastructure/Persistence/AuditableInterceptor.cs",
    );
  });
});

describe(".NET generator: hand-written equivalents work without macro", () => {
  it("`implements \"softDeletable\"` + `filter ...` produces full DbContext pass", async () => {
    // No macros at all — pure hand-written capability surface.
    const model = await modelFrom(`
      context Sales {
        aggregate Doc {
          subject: string
          isDeleted: bool
          implements "softDeletable"
          filter !this.isDeleted
        }
        repository Docs for Doc { }
      }
    `);
    const files = generateDotnet(model);
    expect([...files.keys()]).toContain("Domain/Common/ISoftDeletable.cs");
    expect([...files.keys()]).toContain("Infrastructure/Persistence/SoftDeletableFilters.cs");
    const ctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toMatch(/typeof\(ISoftDeletable\)/);
    const docCs = files.get("Domain/Docs/Doc.cs")!;
    expect(docCs).toMatch(/public sealed class Doc : ISoftDeletable/);
  });
});
