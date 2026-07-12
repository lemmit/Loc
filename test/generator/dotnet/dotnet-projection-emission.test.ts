import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// .NET backend — projection read models (projection.md, v1).  A projection
// folds foreign events into a `<Proj>Row` EF-mapped read-model entity (non-key
// columns nullable), dispatched in-process via a pure Mediator
// `INotificationHandler<TEvent>`, and read through
// GET /api/projections/<snake>[/{key}].  Parity with the shipped Hono + Python
// + Java + elixir runtimes (5th / final backend).  The `dotnet build
// /warnaserror` gate lives in test/e2e/generated-dotnet-build.test.ts.
// ---------------------------------------------------------------------------

// `generateDotnet` lowers a BARE context (the legacy per-context entry, like
// the dispatch test's `generateSource`), so the fixture is an unwrapped
// `context {...}` rather than a full `system`.
const SRC = `context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderPlaced  { order: Order id, customer: Customer id }
  event OrderShipped { order: Order id }
  aggregate Customer { name: string }
  repository Customers for Customer { }
  aggregate Order {
    status: OrderStatus
    create place(customer: Customer id) {}
    operation ship() { emit OrderShipped { order: id } }
  }
  repository Orders for Order { }
  channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
  projection OrderBook keyed by order {
    order: Order id
    customer: Customer id
    status: OrderStatus
    on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
    on(e: OrderShipped) { status := Shipped }
  }
}`;

const SRC_NO_PROJECTION = `context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderShipped { order: Order id }
  aggregate Order {
    status: OrderStatus
    operation ship() { emit OrderShipped { order: id } }
  }
  repository Orders for Order { }
}`;

async function generate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper<Model>(services.Ddd)(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errors.map((d) => d.message),
    "source validation errors",
  ).toEqual([]);
  return generateDotnet(doc.parseResult.value);
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe(".NET projection runtime", () => {
  it("emits a nullable-non-key EF read-model entity keyed by the correlation id", async () => {
    const files = await generate(SRC);
    const row = file(files, "Infrastructure/Persistence/Projections/OrderBookRow.cs");
    expect(row).toContain("public sealed class OrderBookRow");
    expect(row).toContain("public OrderId Order { get; set; } = default!;");
    // non-key columns nullable
    expect(row).toContain("public CustomerId? Customer { get; set; }");
    expect(row).toContain("public OrderStatus? Status { get; set; }");

    const cfg = file(files, "Configurations/OrderBookRowConfiguration.cs");
    expect(cfg).toContain('builder.ToTable("order_books"');
    expect(cfg).toContain("builder.HasKey(x => x.Order);");
    // key uses the plain converter; the nullable non-key id uses the guarded form
    expect(cfg).toContain(
      "builder.Property(x => x.Order).HasConversion(v => v.Value, v => new OrderId(v));",
    );
    expect(cfg).toContain("builder.Property(x => x.Customer).HasConversion(v => v.HasValue");
    expect(cfg).toContain("builder.Property(x => x.Status).HasConversion<string>();");
  });

  it("registers the read-model DbSet + configuration in AppDbContext", async () => {
    const db = file(await generate(SRC), "Infrastructure/Persistence/AppDbContext.cs");
    expect(db).toContain("public DbSet<OrderBookRow> OrderBooks => Set<OrderBookRow>();");
    expect(db).toContain(
      "modelBuilder.ApplyConfiguration(new Configurations.OrderBookRowConfiguration());",
    );
  });

  it("emits a pure fold INotificationHandler per subscribed event", async () => {
    const files = await generate(SRC);
    const fold = file(files, "Application/Workflows/OrderBookOnOrderPlacedHandler.cs");
    expect(fold).toContain(
      "public sealed class OrderBookOnOrderPlacedHandler : INotificationHandler<OrderPlaced>",
    );
    expect(fold).toContain("var __key = notification.Order;");
    expect(fold).toContain(
      "var state = await _readModel.FindAsync(x => x.Order == __key, cancellationToken);",
    );
    expect(fold).toContain("state = new OrderBookRow { Order = __key };");
    expect(fold).toContain("state.Customer = notification.Customer;");
    expect(fold).toContain("state.Status = OrderStatus.Placed;");
    expect(fold).toContain("await _readModel.SaveChangesAsync(cancellationToken);");
    // the correlation `:=` is skipped (immutable key)
    expect(fold).not.toContain("state.Order =");

    const shipped = file(files, "Application/Workflows/OrderBookOnOrderShippedHandler.cs");
    expect(shipped).toContain("state.Status = OrderStatus.Shipped;");
  });

  it("emits a read controller + Response DTO under /api/projections", async () => {
    const files = await generate(SRC);
    const ctrl = file(files, "Api/OrdersProjectionsController.cs");
    // Bare-context mode has no `/api` route prefix (that's added in system mode);
    // the compile-verified system-mode output mounts at `api/projections`.
    expect(ctrl).toContain('[Route("projections")]');
    expect(ctrl).toContain('[HttpGet("order_book")]');
    expect(ctrl).toContain("public async Task<IActionResult> ListOrderBook()");
    expect(ctrl).toContain('[HttpGet("order_book/{key}")]');
    expect(ctrl).toContain("public async Task<IActionResult> GetOrderBook(Guid key)");
    expect(ctrl).toContain("var __key = new OrderId(key);");
    expect(ctrl).toContain("if (x is null) return NotFound();");

    const dto = file(files, "Application/Workflows/OrderBookResponse.cs");
    // key required + non-key nullable (partial read model)
    expect(dto).toContain(
      "public sealed record OrderBookResponse([property: Required] Guid Order, Guid? Customer, OrderStatus? Status);",
    );
  });

  it("emits nothing projection-related for a projection-less system (additivity)", async () => {
    const files = await generate(SRC_NO_PROJECTION);
    const projectionFiles = [...files.keys()].filter(
      (k) =>
        k.includes("/Projections/") ||
        k.endsWith("ProjectionsController.cs") ||
        (/OnOrder\w+Handler\.cs$/.test(k) && k.includes("OrderBook")),
    );
    expect(projectionFiles).toEqual([]);
  });
});
