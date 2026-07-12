// .NET emission for the `when` canCommand gate (criterion.md, use site 2).
//
// The command handler evaluates the predicate against the loaded aggregate
// before invoking the method — false throws DisallowedException, mapped to a
// 409 "Disallowed" ProblemDetails by DomainExceptionFilter — and the
// controller gains a side-effect-free `GET {id}/can_<op>` action dispatching
// `Can<Op>Query` → `CanResponse { allowed }`.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Draft, Shipped, Cancelled }
    aggregate Order {
      status: OrderStatus
      operation cancel() when this.status != Shipped && this.status != Cancelled {
        status := Cancelled
      }
    }
    repository Orders for Order { }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

describe("dotnet generator — when canCommand gate", () => {
  it("gates the command handler with DisallowedException before the method call", async () => {
    const h = (await files()).get("Application/Orders/Commands/CancelHandler.cs")!;
    expect(h).toContain(
      "if (!(aggregate.Status != OrderStatus.Shipped && aggregate.Status != OrderStatus.Cancelled)) throw new DisallowedException(\"operation 'cancel' is not allowed in the current state of Order.\");",
    );
  });

  it("emits the Can<Op> query + handler + CanResponse", async () => {
    const map = await files();
    expect(map.get("Application/Orders/Queries/CanCancelQuery.cs")).toContain(
      "public sealed record CanCancelQuery(OrderId Id) : IQuery<CanResponse>;",
    );
    const h = map.get("Application/Orders/Queries/CanCancelHandler.cs")!;
    expect(h).toContain(
      "return new CanResponse(aggregate.Status != OrderStatus.Shipped && aggregate.Status != OrderStatus.Cancelled);",
    );
    expect(map.get("Application/Orders/Responses/CanResponse.cs")).toContain(
      "public sealed record CanResponse([property: Required] bool Allowed);",
    );
  });

  it("the controller exposes GET can_<op> and declares 409 on the action", async () => {
    const ctrl = (await files()).get("Api/OrdersController.cs")!;
    expect(ctrl).toContain('[HttpGet("{id}/can_cancel")]');
    expect(ctrl).toContain("new CanCancelQuery(new OrderId(id))");
    expect(ctrl).toContain("[ProducesResponseType(typeof(ProblemDetails), 409)]");
  });

  it("DomainExceptionFilter maps DisallowedException to 409 Disallowed", async () => {
    const map = await files();
    const filter = [...map.entries()].find(([k]) => k.endsWith("DomainExceptionFilter.cs"))![1];
    expect(filter).toContain("if (context.Exception is DisallowedException dx)");
    expect(filter).toContain('Problem(context, 409, "Disallowed", dx.Message, trace_id)');
    const common = [...map.entries()].find(([k]) => k.endsWith("Common/Errors.cs"))?.[1];
    if (common) expect(common).toContain("class DisallowedException");
  });
});
