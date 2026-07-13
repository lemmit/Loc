// .NET Mediator emission for the explicit application/transport layer
// (unfoldable-api-derivation.md, A1): `commandHandler` / `queryHandler` context
// members + `route <M> "<path>" -> <Ctx>.<Handler>` api bindings emit onto the
// source-generated martinothamar/Mediator seam (ICommandHandler / IQueryHandler,
// _mediator.Send).  The generated project compiles clean under
// `dotnet build -warnaserror` (verified by hand; gated on demand via
// LOOM_DOTNET_BUILD).
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order ids guid {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
      commandHandler CancelOrder(orderId: Order id): Order id {
        let o = Orders.getById(orderId)
        o.cancel()
        return o.id
      }
      queryHandler GetStatus(orderId: Order id): string {
        let o = Orders.getById(orderId)
        return o.status
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/cancellations" -> Ordering.CancelOrder
    route GET  "/orders/{orderId}/status"        -> Ordering.GetStatus
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("dotnet — explicit commandHandler/queryHandler → Mediator", () => {
  it("emits the ICommand record with the handler's params + return type", async () => {
    const cmd = fileEndingWith(await files(), "Application/Orders/Commands/CancelOrderCommand.cs");
    expect(cmd).toContain(
      "public sealed record CancelOrderCommand(OrderId OrderId) : ICommand<OrderId>;",
    );
    expect(cmd).toContain("namespace Api.Application.Orders.Commands;");
  });

  it("emits the ICommandHandler: injected repo, rendered body, exit-save, return", async () => {
    const h = fileEndingWith(await files(), "Application/Orders/Commands/CancelOrderHandler.cs");
    expect(h).toContain(
      "public sealed class CancelOrderHandler : ICommandHandler<CancelOrderCommand, OrderId>",
    );
    expect(h).toContain("private readonly IOrderRepository _orders;");
    // param ref → command.<Pascal>; load guarded; mutate; save; return.
    expect(h).toContain("await _orders.GetByIdAsync(command.OrderId, cancellationToken)");
    expect(h).toContain("o.Cancel();");
    expect(h).toContain("await _orders.SaveAsync(o, cancellationToken);");
    expect(h).toContain("return o.Id;");
  });

  it("emits the IQueryHandler returning the resolved returnValue (no __bad__)", async () => {
    const h = fileEndingWith(await files(), "Application/Orders/Queries/GetStatusHandler.cs");
    expect(h).toContain(
      "public sealed class GetStatusHandler : IQueryHandler<GetStatusQuery, string>",
    );
    expect(h).toContain("return o.Status;");
    expect(h).not.toContain("__bad__");
  });

  it("emits one ControllerBase per api dispatching each route through _mediator.Send", async () => {
    const ctrl = fileEndingWith(await files(), "Api/SalesApiRoutesController.cs");
    expect(ctrl).toContain("public sealed class SalesApiRoutesController : ControllerBase");
    // command route: POST + wire-coerced id path param → new OrderId(...) → Send → Ok.
    expect(ctrl).toContain('[HttpPost("/orders/{orderId}/cancellations")]');
    expect(ctrl).toContain("public async Task<IActionResult> CancelOrder(Guid orderId)");
    expect(ctrl).toContain("await _mediator.Send(new CancelOrderCommand(new OrderId(orderId)));");
    // query route: GET + Send → Ok(result).
    expect(ctrl).toContain('[HttpGet("/orders/{orderId}/status")]');
    expect(ctrl).toContain("await _mediator.Send(new GetStatusQuery(new OrderId(orderId)));");
  });
});

// A handler param that isn't bound by a `{token}` in the route path rides in a
// `[FromBody]` request record, not as a bare action param (which ASP.NET would
// mis-bind — a second complex `[FromBody]`, or a simple type from the query
// string).  Path params stay URL-bound; the command ctor args keep declared order.
const BODY_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money {
        amount: int
        currency: string
      }
      aggregate Order ids guid {
        status: string
        operation applyDiscount(amount: Money, reason: string) { status := "discounted" }
      }
      repository Orders for Order { }
      commandHandler Discount(orderId: Order id, amount: Money, reason: string): Order id {
        let o = Orders.getById(orderId)
        o.applyDiscount(amount, reason)
        return o.id
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/discounts" -> Ordering.Discount
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("dotnet — explicit handler route param binding (path vs [FromBody])", () => {
  it("collects non-path params into a [FromBody] request record, path stays URL-bound", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(BODY_SRC),
      "Api/SalesApiRoutesController.cs",
    );
    // Body record carries the two non-path params, domain-typed.
    expect(ctrl).toContain("public sealed record DiscountBody(Money Amount, string Reason);");
    // Action: id path param stays URL-bound; the rest is one [FromBody] record.
    expect(ctrl).toContain(
      "public async Task<IActionResult> Discount(Guid orderId, [FromBody] DiscountBody body)",
    );
    // Command ctor args in declared order: path coercion, then body.<Pascal>.
    expect(ctrl).toContain("new DiscountCommand(new OrderId(orderId), body.Amount, body.Reason)");
  });
});

// A handler returning an aggregate projects to its wire-shape `<Agg>Response`
// (the same projection the auto-derived read endpoints use) rather than
// serialising the raw domain entity.
const RESP_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
      queryHandler GetOrder(orderId: Order id): Order {
        let o = Orders.getById(orderId)
        return o
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}" -> Ordering.GetOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("dotnet — explicit handler aggregate return → wire-shape Response", () => {
  it("projects an aggregate return to new <Agg>Response(...), not the raw entity", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(RESP_SRC),
      "Api/SalesApiRoutesController.cs",
    );
    // The Responses namespace is imported and the domain result projected.
    expect(ctrl).toContain("using Api.Application.Orders.Responses;");
    expect(ctrl).toContain(
      "return Ok(new OrderResponse(result.Id.Value, result.Code, result.Status));",
    );
    // Not the raw domain entity.
    expect(ctrl).not.toContain("return Ok(result);");
  });

  it("imports the return aggregate's domain namespace on the query record + handler", async () => {
    // Regression: an aggregate-returning handler emits `IQuery<Order>` /
    // `ValueTask<Order>` but never imported `Api.Domain.Orders`, so the generated
    // project failed to compile (CS0246 / CS0311). The return aggregate's domain
    // namespace must be in scope on both files.
    const files = await generateSystemFiles(RESP_SRC);
    const rec = fileEndingWith(files, "Application/Orders/Queries/GetOrderQuery.cs");
    expect(rec).toContain("using Api.Domain.Orders;");
    expect(rec).toContain("public sealed record GetOrderQuery(OrderId OrderId) : IQuery<Order>;");
    const handler = fileEndingWith(files, "Application/Orders/Queries/GetOrderHandler.cs");
    expect(handler).toContain("using Api.Domain.Orders;");
  });
});

// An `extern` handler is bodyless: the Mediator command/handler + route wire up
// as usual, but the handler delegates to a ctor-injected `I<Name>Handler` port
// the user's scaffold-once `<Name>HandlerImpl` ([ExternHandler]) supplies.
const EXTERN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order { code: string }
      repository Orders for Order { }
      extern commandHandler PlaceOrder(code: string): Order id;
      extern queryHandler GetQuote(orderId: Order id): string;
    }
  }
  api SalesApi from Sales {
    route POST "/orders" -> Ordering.PlaceOrder
    route GET  "/orders/{orderId}/quote" -> Ordering.GetQuote
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe(".NET — extern commandHandler / queryHandler", () => {
  it("the Mediator handler delegates to the injected port", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const handler = fileEndingWith(m, "Application/Handlers/PlaceOrderHandler.cs");
    expect(handler).toContain("private readonly IPlaceOrderHandler _impl;");
    expect(handler).toContain("return await _impl.Handle(command.Code, cancellationToken);");
  });

  it("emits a scaffold-once [ExternHandler] impl that throws", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const impl = fileEndingWith(m, "Application/Handlers/PlaceOrderExternHandler.cs");
    expect(impl.split("\n")[0]).toContain("loom:scaffold-once");
    expect(impl).toContain("[ExternHandler]");
    expect(impl).toContain("public sealed class PlaceOrderExternHandler : IPlaceOrderHandler");
    expect(impl).toContain("throw new NotImplementedException(");
    // Program.cs verifies the impl is registered at startup (Scrutor scan).
    const program = fileEndingWith(m, "Program.cs");
    expect(program).toContain("Api.Application.Handlers.IPlaceOrderHandler");
  });
});
