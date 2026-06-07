// .NET generator coverage for discriminated-union finds
// (payload-transport-layer.md, P4c — .NET slice).  A `find x(): A or B` emits a
// `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` base record with
// one `[JsonDerivedType]` per variant, so System.Text.Json serializes
// `{ "type": "Tag", …fields }` — byte-identical to the TS/Hono
// `z.discriminatedUnion("type", …)`.  The query / handler / controller return
// the polymorphic base; the repository method is a producer-side stub.  The
// generated project compiles under `dotnet build /warnaserror`
// (examples/union-dotnet.ddd in the build-generated-dotnet matrix).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order ids guid { code: string }
    aggregate Cancel ids guid { reason: string }
    repository Orders for Order { find recent(): Order or Cancel }
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
    const dto = find(await files(), "Responses/OrderOrCancel.cs");
    expect(dto).toContain('[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]');
    expect(dto).toContain('[JsonDerivedType(typeof(OrderOrCancel_Order), "Order")]');
    expect(dto).toContain('[JsonDerivedType(typeof(OrderOrCancel_Cancel), "Cancel")]');
    expect(dto).toContain("public abstract record OrderOrCancel;");
    expect(dto).toContain("using System.Text.Json.Serialization;");
  });

  it("each variant record flattens its wire fields alongside the discriminator", async () => {
    const dto = find(await files(), "Responses/OrderOrCancel.cs");
    expect(dto).toContain(
      "public sealed record OrderOrCancel_Order([property: Required] Guid Id, [property: Required] string Code) : OrderOrCancel;",
    );
    expect(dto).toContain(
      "public sealed record OrderOrCancel_Cancel([property: Required] Guid Id, [property: Required] string Reason) : OrderOrCancel;",
    );
  });

  it("the query + controller return the polymorphic base type", async () => {
    const map = await files();
    expect(find(map, "Queries/RecentQuery.cs")).toContain("IQuery<OrderOrCancel>");
    const ctrl = find(map, "OrdersController.cs");
    expect(ctrl).toContain("Task<ActionResult<OrderOrCancel>>");
  });

  it("the handler is the producer-side stub; the domain repository emits no union method", async () => {
    const map = await files();
    // The query handler (Application layer) owns the not-implemented stub so it
    // can name the Response-side union; `Task.FromException` keeps it awaiting.
    const handler = find(map, "Queries/RecentHandler.cs");
    expect(handler).toContain(
      "Task.FromException<OrderOrCancel>(new System.NotImplementedException(",
    );
    // The Domain repository (interface + EF impl) never references the union.
    expect(find(map, "Domain/Orders/IOrderRepository.cs")).not.toContain("Recent");
    expect(find(map, "Repositories/OrderRepository.cs")).not.toContain("OrderOrCancel");
  });
});
