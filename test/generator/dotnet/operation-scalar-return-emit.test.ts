// .NET producer-side translation for SCALAR operation returns (BUG-003).  An
// `operation describe(): string { return code }` (non-void, non-`or`-union)
// must serialize the returned value at HTTP 200 — not discard it at 204.  The
// command carries the value's WIRE type (`ICommand<string>`), the handler
// projects the domain value to wire and returns it, and the controller declares
// `[ProducesResponseType(typeof(<Wire>), 200)]` + `return Ok(result)`.  A money
// return crosses the wire as an InvariantCulture string (parity with the union
// scalar-success arm and every other backend).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    aggregate Order {
      code: string
      operation describe(): string {
        return code
      }
    }
    aggregate Invoice {
      total: money
      operation restated(): money {
        return total
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

describe("dotnet — scalar operation returns (BUG-003)", () => {
  it("makes the command + handler carry the scalar wire type and return the value", async () => {
    const f = await files();
    // Command: `ICommand<string>`, not a bare void `ICommand`.
    expect(find(f, "Commands/DescribeCommand.cs")).toContain("ICommand<string>");
    const h = find(f, "Commands/DescribeHandler.cs");
    expect(h).toContain("ICommandHandler<DescribeCommand, string>");
    expect(h).toContain("public async ValueTask<string> Handle(");
    // Domain value captured, saved, then returned as wire (identity for string).
    expect(h).toContain("var result = aggregate.Describe(");
    expect(h).toContain("return result;");
    // No longer the void shape.
    expect(h).not.toContain("return Unit.Value;");
  });

  it("emits ProducesResponseType(typeof(string), 200) + Ok(result) in the controller", async () => {
    const c = find(await files(), "OrdersController.cs");
    expect(c).toContain("[ProducesResponseType(typeof(string), 200)]");
    expect(c).not.toContain("[ProducesResponseType(204)]");
    expect(c).toContain("var result = await _mediator.Send(cmd);");
    expect(c).toContain("return Ok(result);");
    expect(c).not.toContain("return NoContent();");
  });

  it("projects a money scalar return to the InvariantCulture wire string", async () => {
    const f = await files();
    // Money crosses the .NET wire as a string; the command/handler carry it.
    expect(find(f, "Commands/RestatedCommand.cs")).toContain("ICommand<string>");
    const h = find(f, "Commands/RestatedHandler.cs");
    expect(h).toContain("ICommandHandler<RestatedCommand, string>");
    // Money → wire string at the FIXED NUMERIC(19,4) scale (RS-12).
    expect(h).toContain(
      'return result.ToString("F4", System.Globalization.CultureInfo.InvariantCulture);',
    );
    const c = find(f, "InvoicesController.cs");
    expect(c).toContain("[ProducesResponseType(typeof(string), 200)]");
    expect(c).toContain("return Ok(result);");
  });
});
