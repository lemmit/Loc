// .NET producer-side translation for exception-less operation returns
// (exception-less.md, A3 — dotnet slice).  An `operation foo(): X or NotFound`
// emits a pure Domain union (the aggregate method returns the tagged value), a
// JsonPolymorphic Application wire DTO, a `ICommand<Union>` command + handler,
// and a controller action that translates an error variant to a ProblemDetails
// (status from the stdlib default / api `httpStatus`) and a success to 200.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order {
      code: string
      operation reserve(): Order or NotFound {
        return NotFound { resource: code }
      }
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  const model = await parseValid(SRC);
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
    // Binds the variant (RS-19) rather than discarding it with `_`: the arm
    // projects the error payload's declared fields onto the problem body, so it
    // needs the value.  A discard shipped a 404 with no payload.
    expect(c).toMatch(/case \S+\.OrderOrNotFound_NotFound v:/);
    // Built by hand rather than via ControllerBase.Problem(...): that helper
    // routes through ProblemDetailsFactory, which leaves `instance` null and
    // injects a `traceId` extension no other backend sends (both caught by the
    // wire golden), and it has no slot for the payload's declared fields.
    expect(c).toContain(
      'var problem = new Microsoft.AspNetCore.Mvc.ProblemDetails { Status = 404, Title = "Not Found", Type = "/errors/not-found", Detail = "Not Found", Instance = HttpContext.Request.Path };',
    );
    expect(c).toContain(
      'return new ObjectResult(problem) { StatusCode = 404, ContentTypes = { "application/problem+json" } };',
    );
    // success variant → 200 wrapped in the App wire DTO.  `DeclaredType` is
    // load-bearing, not decoration: the DTO is `[JsonPolymorphic]`, and STJ only
    // writes the `"type"` discriminator when serializing through the BASE type.
    // `Ok(object)` left DeclaredType null, so the tag vanished from the wire.
    expect(c).toMatch(/case \S+\.OrderOrNotFound_Order v:/);
    expect(c).toMatch(
      /return new ObjectResult\(\(\S+\.OrderOrNotFound\)new \S+\.OrderOrNotFound_Order\(v\.Id, v\.Code, v\.Version\)\) \{ StatusCode = 200, DeclaredType = typeof\(\S+\.OrderOrNotFound\) \};/,
    );
    expect(c).toMatch(/\[ProducesResponseType\(typeof\(\S+\.OrderOrNotFound\), 200\)\]/);
  });

  it("imports the owning aggregate's Responses namespace when a variant flattens a containment", async () => {
    // A containment field surfaces as `<Part>Response` in the flattened
    // variant record — without the Application Responses using the Domain
    // union fails CS0246 (first hit by showcase's `reserve()` after #1638).
    const src = `
      context Shop {
        error NotFound { resource: string }
        aggregate Order {
          code: string
          contains lines: Line[]
          entity Line { sku: string }
          operation reserve(): Order or NotFound {
            return NotFound { resource: code }
          }
        }
      }
    `;
    const model = await parseValid(src);
    const u = find(await generateDotnet(model), "Domain/Orders/OrderOrNotFound.cs");
    expect(u).toMatch(/using \S+\.Application\.Orders\.Responses;/);
    expect(u).toContain("IReadOnlyList<LineResponse> Lines");
  });
});
