// .NET producer-side translation for exception-less operation returns
// (exception-less.md, A3 — dotnet slice).  An `operation foo(): X or NotFound`
// emits a pure Domain union (the aggregate method returns the tagged value), a
// JsonPolymorphic Application wire DTO, a `ICommand<Union>` command + handler,
// and a controller action that translates an error variant to a ProblemDetails
// (status from the stdlib default / api `httpStatus`) and a success to 200.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order ids guid {
      code: string
      operation reserve(): Order or NotFound {
        return NotFound { resource: code }
      }
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  const { model } = await parseString(SRC, { validate: false });
  return generateDotnet(model);
}

/** Suffix-match the emitted path (the namespace prefix varies by entry point). */
function find(map: Map<string, string>, suffix: string): string {
  const hit = [...map.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no emitted file ending in ${suffix}`);
  return hit[1];
}

describe("dotnet — exception-less operation returns (A3)", () => {
  it("emits a pure Domain union (no serialization attributes)", async () => {
    const u = find(await files(), "Domain/Orders/OrderOrNotFound.cs");
    expect(u).toContain("public abstract record OrderOrNotFound;");
    expect(u).toContain(
      "public sealed record OrderOrNotFound_NotFound(string Resource) : OrderOrNotFound;",
    );
    expect(u).not.toContain("JsonPolymorphic");
  });

  it("renders the domain method returning the tagged variant record", async () => {
    const dom = find(await files(), "Domain/Orders/Order.cs");
    expect(dom).toContain("public OrderOrNotFound Reserve()");
    expect(dom).toContain("return new OrderOrNotFound_NotFound(this.Code);");
  });

  it("makes the command + handler carry the union as the result type", async () => {
    const f = await files();
    expect(find(f, "Commands/ReserveCommand.cs")).toContain("ICommand<OrderOrNotFound>");
    const h = find(f, "Commands/ReserveHandler.cs");
    expect(h).toContain("ICommandHandler<ReserveCommand, OrderOrNotFound>");
    expect(h).toContain("var result = aggregate.Reserve(");
    expect(h).toContain("return result;");
  });

  it("translates the union in the controller (error → ProblemDetails, success → 200 wire DTO)", async () => {
    const c = find(await files(), "OrdersController.cs");
    expect(c).toContain("var result = await _mediator.Send(cmd);");
    // error variant → ProblemDetails with the stdlib status / RFC-7807 fields.
    expect(c).toMatch(/case \S+\.OrderOrNotFound_NotFound _:/);
    expect(c).toContain(
      'return Problem(statusCode: 404, title: "Not Found", type: "/errors/not-found", detail: "Not Found");',
    );
    // success variant → 200 wrapped in the App wire DTO (cast to the base).
    expect(c).toMatch(/case \S+\.OrderOrNotFound_Order v:/);
    expect(c).toMatch(
      /return Ok\(\(\S+\.OrderOrNotFound\)new \S+\.OrderOrNotFound_Order\(v\.Id, v\.Code\)\);/,
    );
    expect(c).toMatch(/\[ProducesResponseType\(typeof\(\S+\.OrderOrNotFound\), 200\)\]/);
  });
});
