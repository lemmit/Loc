// .NET capability translation, post-Phase-3-revert.
//
// After splitting stdlib macros into level-correct trios
// (capability behavior at context; state at aggregate), the
// generator has no capability-grouping infrastructure.  Filters
// install per-EntityConfiguration; stamps go through the
// registry-driven SaveChangesInterceptor.  No marker interfaces,
// no DbContext-level loops, no `<Cap>Filters.cs` helpers.
//
// What the tests verify:
//   - Entity classes are plain `public sealed class Order` with
//     no `: I<Capability>` clause regardless of `implements` decls.
//   - No `Domain/Common/I*.cs` marker interfaces emitted.
//   - No `<Cap>Filters.cs` static helpers emitted.
//   - `b.HasQueryFilter(...)` lives in `<Aggregate>Configuration.cs`
//     for any aggregate whose propagated IR carries `contextFilters`.
//   - `AppDbContext.OnModelCreating` stays minimal — just
//     `ApplyConfiguration` calls, no `foreach` loop.
//   - `AuditableInterceptor.cs` still emitted when any aggregate
//     has stamping rules.  Body is the registry-driven switch.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

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

// Trio-form: capability behavior at context, state at aggregate.
// The aggregate-only macros (`with softDeletable` / `with auditable`)
// now contribute only state; behavior comes from a context-level
// macro (`with softDelete` / `with audit`).
const trioed = (ctxMacro: string, aggMacro: string) => `
  context Sales with ${ctxMacro} {
    aggregate User { name: string }
    aggregate Order with ${aggMacro} {
      subject: string
    }
    repository Orders for Order { }
    repository Users for User { }
  }
`;

describe(".NET generator: no capability artefacts emitted", () => {
  it("no Domain/Common/I*.cs marker interfaces", async () => {
    const model = await modelFrom(trioed("audit, softDelete", "auditable, softDeletable"));
    const files = generateDotnet(model);
    const markers = [...files.keys()].filter(
      (k) => k.startsWith("Domain/Common/I") && k.endsWith(".cs"),
    );
    expect(markers).toEqual([]);
  });

  it("no <Capability>Filters.cs helper", async () => {
    const model = await modelFrom(trioed("softDelete", "softDeletable"));
    const files = generateDotnet(model);
    const helpers = [...files.keys()].filter(
      (k) => k.startsWith("Infrastructure/Persistence/") && k.endsWith("Filters.cs"),
    );
    expect(helpers).toEqual([]);
  });

  it("entity class declaration has no `: I<Cap>` clause", async () => {
    const model = await modelFrom(trioed("audit, softDelete", "auditable, softDeletable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs")!;
    expect(orderCs).toMatch(/public sealed class Order\n/);
    expect(orderCs).not.toMatch(/: I/);
  });

  it("OnModelCreating has no `foreach (var entityType ...)` loop", async () => {
    const model = await modelFrom(trioed("softDelete", "softDeletable"));
    const files = generateDotnet(model);
    const ctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).not.toMatch(/foreach \(var entityType/);
  });
});

describe(".NET generator: HasQueryFilter installs per-EntityConfiguration", () => {
  it("emits one `b.HasQueryFilter(...)` per propagated filter on the matching config", async () => {
    const model = await modelFrom(trioed("softDelete", "softDeletable"));
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/b\.HasQueryFilter\(x => !x\.IsDeleted\)/);
  });

  it("does NOT install HasQueryFilter for non-softDeletable aggregates", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).not.toMatch(/HasQueryFilter/);
  });

  it("hand-written `filter` declaration installs the same way as macro-emitted", async () => {
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
    const model = await modelFrom(trioed("audit", "auditable"));
    const files = generateDotnet(model);
    const src = files.get("Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(/switch \(entry\.Entity\)/);
    expect(src).toMatch(/case Order /);
  });

  it("interceptor body assigns the macro-supplied fields", async () => {
    const model = await modelFrom(trioed("audit", "auditable"));
    const files = generateDotnet(model);
    const src = files.get("Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(/e\.CreatedAt =/);
    expect(src).toMatch(/e\.UpdatedAt =/);
  });

  it("Program.cs registers the interceptor when stamping is used", async () => {
    const model = await modelFrom(trioed("audit", "auditable"));
    const files = generateDotnet(model);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddScoped<Sales\.Infrastructure\.Persistence\.AuditableInterceptor>/);
  });

  it("softDeletable alone does NOT trigger interceptor emission", async () => {
    const model = await modelFrom(trioed("softDelete", "softDeletable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).not.toContain("Infrastructure/Persistence/AuditableInterceptor.cs");
  });
});

describe(".NET generator: context-level propagation reaches per-config emission", () => {
  it("unqualified context-level filter propagates to every aggregate", async () => {
    const model = await modelFrom(`
      context Sales {
        filter !this.isDeleted
        aggregate Order {
          subject: string
          isDeleted: bool
        }
        aggregate Customer {
          name: string
          isDeleted: bool
        }
        repository Orders for Order { }
        repository Customers for Customer { }
      }
    `);
    const files = generateDotnet(model);
    expect(files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!).toMatch(
      /b\.HasQueryFilter\(x => !x\.IsDeleted\)/,
    );
    expect(
      files.get("Infrastructure/Persistence/Configurations/CustomerConfiguration.cs")!,
    ).toMatch(/b\.HasQueryFilter\(x => !x\.IsDeleted\)/);
    const ctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).not.toMatch(/foreach \(var entityType/);
  });
});
