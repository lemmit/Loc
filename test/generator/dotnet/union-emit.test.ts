// .NET generator coverage for discriminated-union finds
// (payload-transport-layer.md, P4c — .NET slice).  A `find x(): Agg or Err`
// emits a `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` base
// record with one `[JsonDerivedType]` per variant, so System.Text.Json
// serializes `{ "type": "Tag", …fields }` — byte-identical to the TS/Hono
// `z.discriminatedUnion("type", …)`.  Producer side (post the
// `loom.union-find-shape-unsupported` shape pinning): the Domain repository
// emits the find as its optional twin (`Agg?`), the query handler maps a
// found row to the tagged success variant and absence to the error variant
// (`resource` filled with the aggregate name), and the controller translates
// the absent variant to ProblemDetails at its mapped status.  The generated
// project compiles under `dotnet build /warnaserror`
// (examples/union-dotnet.ddd in the build-generated-dotnet matrix).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order ids guid { code: string }
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
  it("emits a JsonPolymorphic base record with a JsonDerivedType per variant", async () => {
    const dto = find(await files(), "Responses/OrderOrNotFound.cs");
    expect(dto).toContain('[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]');
    expect(dto).toContain('[JsonDerivedType(typeof(OrderOrNotFound_Order), "Order")]');
    expect(dto).toContain('[JsonDerivedType(typeof(OrderOrNotFound_NotFound), "NotFound")]');
    expect(dto).toContain("public abstract record OrderOrNotFound;");
    expect(dto).toContain("using System.Text.Json.Serialization;");
  });

  it("each variant record flattens its wire fields alongside the discriminator", async () => {
    const dto = find(await files(), "Responses/OrderOrNotFound.cs");
    expect(dto).toContain(
      "public sealed record OrderOrNotFound_Order([property: Required] Guid Id, [property: Required] string Code) : OrderOrNotFound;",
    );
    expect(dto).toContain(
      "public sealed record OrderOrNotFound_NotFound([property: Required] string Resource) : OrderOrNotFound;",
    );
  });

  it("the query + controller return the polymorphic base type", async () => {
    const map = await files();
    expect(find(map, "Queries/RecentQuery.cs")).toContain("IQuery<OrderOrNotFound>");
    const ctrl = find(map, "OrdersController.cs");
    expect(ctrl).toContain("Task<ActionResult<OrderOrNotFound>>");
  });

  it("the handler maps the repository's optional twin onto the union variants", async () => {
    const handler = find(await files(), "Queries/RecentHandler.cs");
    expect(handler).not.toContain("NotImplementedException");
    expect(handler).toContain("var domain = await _repo.Recent(cancellationToken);");
    expect(handler).toContain('if (domain is null) return new OrderOrNotFound_NotFound("Order");');
    expect(handler).toContain("return new OrderOrNotFound_Order(domain.Id.Value, domain.Code);");
  });

  it("the Domain repository emits the find as its optional twin", async () => {
    const map = await files();
    const iface = find(map, "Domain/Orders/IOrderRepository.cs");
    expect(iface).toContain("Task<Order?> Recent(");
    expect(iface).not.toContain("OrderOrNotFound");
    expect(find(map, "Repositories/OrderRepository.cs")).not.toContain("OrderOrNotFound");
  });

  it("the controller translates the absent variant to ProblemDetails at its status", async () => {
    const ctrl = find(await files(), "OrdersController.cs");
    expect(ctrl).toContain("if (result is OrderOrNotFound_NotFound)");
    expect(ctrl).toContain(
      'return Problem(statusCode: 404, title: "Not Found", type: "/errors/not-found", detail: "Not Found");',
    );
    expect(ctrl).toContain("[ProducesResponseType(typeof(ProblemDetails), 404)]");
  });
});
