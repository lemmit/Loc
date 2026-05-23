// End-to-end: aggregate `with auditable`/`with softDeletable`
// reaches the .NET generator and produces capability-interface
// emission + the `: IAuditable, ISoftDeletable` clause on the
// entity class.  Verifies the macro -> IR flag -> generator
// pipeline holds across the four points where capability flags
// affect output:
//
//   1. Domain/Common/IAuditable.cs emitted when at least one
//      aggregate has the flag (and not when none do).
//   2. Domain/Common/ISoftDeletable.cs likewise.
//   3. Entity class declaration carries `: IAuditable` /
//      `: ISoftDeletable` interface clauses.
//   4. Macro-added fields (createdAt/updatedAt/isDeleted/...) show
//      up as CLR properties on the entity.

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

// Single-context legacy mode — minimal scaffolding; `Id<User>`
// resolves to a sibling `aggregate User { ... }` we declare here.
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

describe(".NET generator honors auditable / softDeletable flags", () => {
  it("emits IAuditable.cs when an aggregate uses with auditable", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).toContain("Domain/Common/IAuditable.cs");
    expect(files.get("Domain/Common/IAuditable.cs")).toMatch(/public interface IAuditable/);
  });

  it("does NOT emit IAuditable.cs when no aggregate uses the flag", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    expect([...files.keys()]).not.toContain("Domain/Common/IAuditable.cs");
  });

  it("emits ISoftDeletable.cs gated on softDeletable flag", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    expect([...files.keys()]).toContain("Domain/Common/ISoftDeletable.cs");
    expect(files.get("Domain/Common/ISoftDeletable.cs")).toMatch(
      /public interface ISoftDeletable/,
    );
  });

  it("adds `: IAuditable` to the entity class declaration", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs");
    expect(orderCs).toBeDefined();
    expect(orderCs!).toMatch(/public sealed class Order : IAuditable/);
  });

  it("combines auditable + softDeletable into a single interface clause", async () => {
    const model = await modelFrom(aggregateOnly("with auditable, softDeletable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs");
    expect(orderCs!).toMatch(/public sealed class Order : IAuditable, ISoftDeletable/);
  });

  it("emits CreatedAt/UpdatedAt/CreatedBy/UpdatedBy properties from the auditable macro", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs")!;
    expect(orderCs).toMatch(/public DateTime CreatedAt/);
    expect(orderCs).toMatch(/public DateTime UpdatedAt/);
    expect(orderCs).toMatch(/public UserId CreatedBy/);
    expect(orderCs).toMatch(/public UserId UpdatedBy/);
  });

  it("emits IsDeleted/DeletedAt properties from the softDeletable macro", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    const orderCs = files.get("Domain/Orders/Order.cs")!;
    expect(orderCs).toMatch(/public bool IsDeleted/);
    expect(orderCs).toMatch(/public DateTime\? DeletedAt/);
  });
});

describe(".NET runtime infrastructure for capability flags", () => {
  it("auditable: emits SaveChangesInterceptor scanning IAuditable entries", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const interceptorPath = "Infrastructure/Persistence/AuditableInterceptor.cs";
    expect([...files.keys()]).toContain(interceptorPath);
    const src = files.get(interceptorPath)!;
    // The interceptor scans the change tracker for IAuditable, sets
    // CreatedAt/CreatedBy on Added, UpdatedAt/UpdatedBy on Added or
    // Modified.  One interceptor per DbContext, not per aggregate.
    expect(src).toMatch(/SaveChangesInterceptor/);
    expect(src).toMatch(/ChangeTracker\.Entries<IAuditable>/);
    expect(src).toMatch(/entry\.Entity\.CreatedAt = now/);
    expect(src).toMatch(/entry\.Entity\.UpdatedAt = now/);
  });

  it("auditable: Program.cs registers the interceptor against DbContextOptions", async () => {
    const model = await modelFrom(aggregateOnly("with auditable"));
    const files = generateDotnet(model);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddScoped<Sales\.Infrastructure\.Persistence\.AuditableInterceptor>/);
    expect(program).toMatch(/AddInterceptors\(sp\.GetRequiredService/);
  });

  it("does NOT emit the interceptor or wire it up for non-auditable projects", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    expect([...files.keys()]).not.toContain(
      "Infrastructure/Persistence/AuditableInterceptor.cs",
    );
    const program = files.get("Program.cs")!;
    expect(program).not.toMatch(/AuditableInterceptor/);
  });

  it("softDeletable: entity configuration installs HasQueryFilter", async () => {
    const model = await modelFrom(aggregateOnly("with softDeletable"));
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/b\.HasQueryFilter\(x => !x\.IsDeleted\)/);
  });

  it("softDeletable with custom field name: query filter honors the chosen column", async () => {
    const model = await modelFrom(
      aggregateOnly(`with softDeletable(field: "archived")`),
    );
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/b\.HasQueryFilter\(x => !x\.Archived\)/);
  });

  it("does NOT install query filter for non-softDeletable aggregates", async () => {
    const model = await modelFrom(aggregateOnly(""));
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).not.toMatch(/HasQueryFilter/);
  });
});
