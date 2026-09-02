// Two of the three handler-body defects #2652 measured and left unfixed
// (#2659).  Both were SILENT: valid `.ddd`, output that either vanished or did
// not compile.  The third (an OPTIONAL find bound in a handler body) is a
// phase-⑦ refusal now and is pinned in `test/ir/handler-nullable-load.test.ts`.
//
//   A .NET dropped a handler touching NO aggregate — `emitExplicitHandlers`
//     did `const agg = primaryAgg(h); if (!agg) continue;` for both handler
//     kinds — so `commandHandler Echo(text: string): string { return text }`
//     AND its route were absent from the .NET project while the other four
//     backends emitted them.  Such a handler now files under the neutral
//     `Application/Handlers/` folder the extern handlers already use.
//
//   B java renamed a declared find literally named `byId` to `getById` and
//     wrapped its first argument in `new <Agg>Id(...)`.  With an `Agg id`
//     handler param — the ordinary path-param shape — that argument is ALREADY
//     an `OrderId`, so the emitted `ordersRepository.getById(new OrderId(orderId))`
//     is a javac `incompatible types` error, and the renamed method is not the
//     find that was declared.  No other backend did either half.
//
// Fixture: `test/fixtures/corpus/handler-triad.ddd` (the corpus copy, so the
// five compile legs build exactly what these assertions read).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/corpus/handler-triad.ddd", import.meta.url));

function source(platform: string): string {
  return readFileSync(FIXTURE, "utf8").replace("__PLATFORM__", platform);
}

async function files(platform: string): Promise<Map<string, string>> {
  return generateSystemFiles(source(platform));
}

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted; have:\n${[...m.keys()].sort().join("\n")}`).toBeDefined();
  return m.get(key!)!;
}

describe("A — .NET emits a handler that touches no aggregate", () => {
  it("emits the command leg's record + handler under Application/Handlers/", async () => {
    const m = await files("dotnet");
    const rec = fileEndingWith(m, "Application/Handlers/EchoCommand.cs");
    expect(rec).toContain("public sealed record EchoCommand(string Text) : ICommand<string>;");
    expect(rec).toContain("namespace D.Application.Handlers;");

    const h = fileEndingWith(m, "Application/Handlers/EchoHandler.cs");
    expect(h).toContain("public sealed class EchoHandler : ICommandHandler<EchoCommand, string>");
    expect(h).toContain("namespace D.Application.Handlers;");
    // No repo, so no injected field and no `using <ns>.Domain.<Agg>;`.
    expect(h).toContain("public EchoHandler() { }");
    expect(h).not.toContain("using D.Domain.Orders;");
    expect(h).toContain("return command.Text;");
  });

  it("emits the query leg's record + handler under Application/Handlers/", async () => {
    const m = await files("dotnet");
    const rec = fileEndingWith(m, "Application/Handlers/SumQuery.cs");
    expect(rec).toContain("public sealed record SumQuery(int A, int B) : IQuery<int>;");
    const h = fileEndingWith(m, "Application/Handlers/SumHandler.cs");
    expect(h).toContain("public sealed class SumHandler : IQueryHandler<SumQuery, int>");
    expect(h).toContain("return command.A + command.B;");
  });

  it("routes both through the api controller (the route used to vanish too)", async () => {
    const ctrl = fileEndingWith(await files("dotnet"), "Api/ARoutesController.cs");
    expect(ctrl).toContain('[HttpPost("/echo/{text}")]');
    expect(ctrl).toContain("await _mediator.Send(new EchoCommand(text));");
    expect(ctrl).toContain('[HttpGet("/sum/{a}/{b}")]');
    expect(ctrl).toContain("await _mediator.Send(new SumQuery(a, b));");
    // The neutral namespace is imported, not the (non-existent) per-aggregate one.
    expect(ctrl).toContain("using D.Application.Handlers;");
  });

  it("CONTROL — a handler that DOES touch an aggregate still files under it", async () => {
    const m = await files("dotnet");
    const h = fileEndingWith(m, "Application/Orders/Queries/CountReplacingHandler.cs");
    expect(h).toContain("namespace D.Application.Orders.Queries;");
    expect(h).toContain("private readonly IOrderRepository _orders;");
    expect(h).toContain("using D.Domain.Orders;");
  });

  it("python emits it WITHOUT the dispatcher import it has no repo to construct", async () => {
    const m = await files("python");
    // ruff F401 (the python leg's compile gate) on an import nothing names —
    // `NoopDomainEventDispatcher` is only referenced where a repository is
    // constructed, and an aggregate-less handler constructs none.
    const echo = fileEndingWith(m, "app/application/echo.py");
    expect(echo).toContain("async def echo(session: AsyncSession, text: str) -> str:");
    expect(echo).not.toContain("NoopDomainEventDispatcher");
    expect(fileEndingWith(m, "app/application/sum.py")).not.toContain("NoopDomainEventDispatcher");
    // CONTROL — the handler that DOES build a repository still imports it.
    const counted = fileEndingWith(m, "app/application/count_replacing.py");
    expect(counted).toContain("from app.domain.events import NoopDomainEventDispatcher");
    expect(counted).toContain("OrderRepository(session, NoopDomainEventDispatcher())");
  });

  it("CONTROL — the other four backends emitted it all along", async () => {
    expect(fileEndingWith(await files("java"), "application/workflows/EchoHandler.java")).toContain(
      "public String handle(String text)",
    );
    expect(fileEndingWith(await files("python"), "app/application/echo.py")).toContain("def echo(");
    // node inlines the handler body into the api's own routes file.
    expect(fileEndingWith(await files("node"), "http/a-routes.ts")).toContain("/echo/");
  });
});

describe("B — java calls a declared `byId` find by its declared name", () => {
  it("renders the declared method verbatim, with the argument NOT re-wrapped", async () => {
    const h = fileEndingWith(
      await files("java"),
      "application/workflows/CountReplacingHandler.java",
    );
    expect(h).toContain("public int handle(OrderId orderId)");
    expect(h).toContain("var matches = ordersRepository.byId(orderId);");
    // The two halves of the old special case, each independently fatal:
    // `getById` is not the find that was declared, and `orderId` is already an
    // `OrderId` (javac: incompatible types: OrderId cannot be converted to UUID).
    expect(h).not.toContain("getById(");
    expect(h).not.toContain("new OrderId(orderId)");
  });

  it("and the repository interface declares exactly that method", async () => {
    const repo = fileEndingWith(await files("java"), "features/orders/OrderRepository.java");
    expect(repo).toContain("List<Order> byId(OrderId oid);");
  });

  it("CONTROL — the controller still coerces the wire path param once", async () => {
    const ctrl = fileEndingWith(await files("java"), "api/ARoutesController.java");
    expect(ctrl).toContain("public ResponseEntity<?> countReplacing(@PathVariable UUID orderId)");
    expect(ctrl).toContain("countReplacingHandler.handle(new OrderId(orderId))");
  });

  it("CONTROL — the other backends already called the declared name", async () => {
    expect(
      fileEndingWith(await files("dotnet"), "Application/Orders/Queries/CountReplacingHandler.cs"),
    ).toContain("await _orders.ById(command.OrderId, cancellationToken)");
  });
});
