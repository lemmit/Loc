import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Context integration test emission on the .NET/EF backend (test-placement.md,
// Phase 3b). A `context`-nested `test` (no `for`) emits an in-process,
// EF-repository-backed `Tests/<ns>.Tests/<Ctx>IntegrationTests.cs` that reads
// LOOM_PG_URL (libpq URL → Npgsql keyword string), applies the EF migrations,
// wires the repos, and persists→reads. A create persists via `SaveAsync`; a find
// awaits `GetByIdAsync` (nullable → `!`). Verified end-to-end: the emitted class
// builds 0-warning under `-warnaserror` (net10.0) and runs green against a real
// Postgres.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales { context Ordering {
    aggregate Order { code: string  qty: int }
    repository Orders for Order { }
    test "persists and reads back an order" {
      let o = Order.create({ code: "abc", qty: 2 })
      let found = Order.findById(o.id)
      expect(found.qty).toBe(2)
    }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Ordering, kind: state, use: db }
  deployable api { platform: dotnet contexts: [Ordering] serves: ShopApi dataSources: [st] port: 8080 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("dotnet: context integration test emission (Phase 3b)", () => {
  it("emits Tests/<ns>.Tests/<Ctx>IntegrationTests.cs with the EF boot + persist/read body", async () => {
    const files = await generateSystemFiles(SRC);
    const f = get(files, "Tests/Api.Tests/OrderingIntegrationTests.cs");
    expect(f, "OrderingIntegrationTests.cs").toBeDefined();
    // Provisioning-agnostic boot: LOOM_PG_URL → Npgsql, EF migrate, wire repos.
    expect(f).toContain('Environment.GetEnvironmentVariable("LOOM_PG_URL")');
    expect(f).toContain("await db.Database.MigrateAsync();");
    expect(f).toContain("new NoopDomainEventDispatcher()");
    expect(f).toContain(
      "var orderRepo = new OrderRepository(db, events, NullLogger<OrderRepository>.Instance);",
    );
    expect(f).toContain("public sealed class OrderingIntegrationTests");
  });

  it("renders create→SaveAsync, find→GetByIdAsync (non-null asserted), and the assertion", async () => {
    const f = (await generateSystemFiles(SRC)).get(
      "api/Tests/Api.Tests/OrderingIntegrationTests.cs",
    )!;
    expect(f).toMatch(/var o = Order\.Create\([^)]*\);/);
    expect(f).toContain("await orderRepo.SaveAsync(o);");
    expect(f).toContain("var found = (await orderRepo.GetByIdAsync(o.Id))!;");
    expect(f).toContain("found.Qty.Should().Be(2);");
  });

  it("emits the Tests csproj (gate widened to count context tests)", async () => {
    const files = await generateSystemFiles(SRC);
    expect(get(files, "Tests/Api.Tests/Api.Tests.csproj"), "Api.Tests.csproj").toBeDefined();
  });

  it("emits nothing for a context with no integration test", async () => {
    const files = await generateSystemFiles(SRC.replace(/test "persists[\s\S]*?\}\n/, ""));
    expect(get(files, "IntegrationTests.cs")).toBeUndefined();
  });

  it("op-transition context renders mutate-in-place + SaveAsync", async () => {
    const withOp = `
system Ship {
  subdomain F { context Fulfillment {
    aggregate Order {
      customerId: string  status: string
      operation place() { precondition status == "Draft"  status := "Placed" }
    }
    repository Orders for Order { }
    test "placing transitions to Placed" {
      let o = Order.create({ customerId: "c1", status: "Draft" })
      o.place()
      let found = Order.findById(o.id)
      expect(found.status).toBe("Placed")
    }
  } }
  api FApi from F
  storage pg { type: postgres }
  resource st { for: Fulfillment, kind: state, use: pg }
  deployable d { platform: dotnet contexts: [Fulfillment] serves: FApi dataSources: [st] port: 4000 }
}`;
    const f = get(await generateSystemFiles(withOp), "FulfillmentIntegrationTests.cs");
    expect(f, "FulfillmentIntegrationTests.cs").toBeDefined();
    expect(f).toContain("o.Place();");
    expect(f).toContain("await orderRepo.SaveAsync(o);");
  });
});
