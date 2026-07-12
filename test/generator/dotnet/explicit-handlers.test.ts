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
