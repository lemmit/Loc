// .NET generator coverage for single-success union finds (`find x(): Agg or
// Err`).  Per exception-less.md §4 the 200 body is the SUCCESS variant
// DIRECTLY (`<Agg>Response`) — never a tagged `oneOf`/JsonPolymorphic
// component (an error variant belongs at its status, not in a 200 schema) — so
// a union find is CQRS-identical to an optional find: the Domain repository
// returns the optional twin (`Agg?`), the query/handler yield `<Agg>Response?`,
// and the controller returns it directly at 200 or maps a null result to the
// error/absent variant's status (ProblemDetails / 404).  No union DTO is
// emitted.  Compiles under `dotnet build /warnaserror`.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order { code: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

function find(map: Map<string, string>, suffix: string): string {
  const key = [...map.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending ${suffix}; have:\n${[...map.keys()].join("\n")}`);
  return map.get(key)!;
}

describe("dotnet generator — discriminated-union finds (P4c)", () => {
  it("emits NO JsonPolymorphic union DTO for a single-success find", async () => {
    const map = await files();
    expect([...map.keys()].some((k) => k.endsWith("Responses/OrderOrNotFound.cs"))).toBe(false);
    // No response file mentions the tagged union base anywhere.
    for (const [k, v] of map) if (k.endsWith(".cs")) expect(v).not.toContain("OrderOrNotFound");
  });

  it("the query + controller return the success variant's <Agg>Response", async () => {
    const map = await files();
    expect(find(map, "Queries/RecentQuery.cs")).toContain("IQuery<OrderResponse?>");
    const ctrl = find(map, "OrdersController.cs");
    expect(ctrl).toContain("Task<ActionResult<OrderResponse>>");
    expect(ctrl).toContain("[ProducesResponseType(typeof(OrderResponse), 200)]");
  });

  it("the handler maps the repository's optional twin to <Agg>Response? (optional-style)", async () => {
    const handler = find(await files(), "Queries/RecentHandler.cs");
    expect(handler).not.toContain("NotImplementedException");
    expect(handler).toContain("var domain = await _repo.Recent(cancellationToken);");
    expect(handler).toContain("return domain is null ? null :");
    expect(handler).not.toContain("OrderOrNotFound");
  });

  it("the Domain repository emits the find as its optional twin", async () => {
    const map = await files();
    const iface = find(map, "Domain/Orders/IOrderRepository.cs");
    expect(iface).toContain("Task<Order?> Recent(");
    expect(iface).not.toContain("OrderOrNotFound");
    expect(find(map, "Repositories/OrderRepository.cs")).not.toContain("OrderOrNotFound");
  });

  it("the controller maps a null result to ProblemDetails at its status, with the resource extension", async () => {
    const ctrl = find(await files(), "OrdersController.cs");
    expect(ctrl).toContain("if (result is null)");
    // The error payload declares `resource`, so the absent arm builds an
    // explicit ProblemDetails (the bare `Problem(...)` helper has no slot for
    // extension members) and serializes the aggregate name at the body root.
    expect(ctrl).toContain(
      'var problem = new ProblemDetails { Status = 404, Title = "Not Found", Type = "/errors/not-found", Detail = "Not Found" };',
    );
    expect(ctrl).toContain('problem.Extensions["resource"] = "Order";');
    expect(ctrl).toContain(
      'return new ObjectResult(problem) { StatusCode = 404, ContentTypes = { "application/problem+json" } };',
    );
    expect(ctrl).toContain("[ProducesResponseType(typeof(ProblemDetails), 404)]");
  });
});
