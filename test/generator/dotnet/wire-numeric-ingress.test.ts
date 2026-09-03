// M-T6.48 (.NET arm) — malformed numeric input answered **500**.
//
// `money` and `datetime` cross the wire as strings, and the controller turned
// them into domain values with a bare parse:
//
//     decimal.Parse(request.NewPrice, CultureInfo.InvariantCulture)
//
// `{"price": "12,50"}` therefore threw `FormatException` inside the action.
// `DomainExceptionFilter` has no arm for it, so it fell through to the generic
// tail and the caller got `500 { "detail": "internal" }` — for input the server
// itself refused.  Node answers the same body with **422** and
// `errors: [{ pointer: "/price", message: "Invalid decimal: \"12,50\"" }]`
// (`lib/schemas.ts` `moneySchema`), so the two backends disagreed on both the
// status and whether the client is told which field is wrong.
//
// The fix keeps the parse where it is — `throw` is an expression in C# 7+ and
// `out var` declares into the enclosing block, so `TryParse ? v : throw` fits
// the argument position the bare `Parse` occupied — and adds a
// `WireFormatException` arm to the filter that renders node's envelope
// verbatim.
//
// Compile-verified: the generated project builds under
// `mcr.microsoft.com/dotnet/sdk:10.0` with `/warnaserror`.  (It did NOT at
// first: naming the property `Pointer` is CA1720 "identifier contains type
// name", which is an ERROR under that flag — hence `FieldPointer`.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Mon {
  subdomain S {
    context Ord {
      valueobject Bid {
        offer: money
      }
      aggregate Order with crudish {
        code: string
        price: money
        due: datetime
        best: Bid
      }
      repository Orders for Order { }
      workflow Settle transactional {
        create(amount: money) {
          let o = Order.create({ code: "x", price: amount, due: now(), best: Bid { offer: amount } })
        }
      }
    }
  }
  api OrdApi from S
  storage primary { type: postgres }
  resource ordState { for: Ord, kind: state, use: primary }
  deployable d {
    platform: dotnet
    contexts: [Ord]
    dataSources: [ordState]
    serves: OrdApi
    port: 4000
  }
}
`;

function bySuffix(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe(".NET wire ingress — a malformed money/datetime is 422, not 500", () => {
  it("no bare `decimal.Parse` / `DateTime.Parse` survives in any emitted file", async () => {
    const files = await generateSystemFiles(SRC);
    for (const [path, content] of files) {
      if (!path.endsWith(".cs")) continue;
      // The guarded forms are `decimal.TryParse(` / `DateTime.TryParse(`; the
      // bare ones are what threw.
      expect(content, `${path} still parses money without a guard`).not.toMatch(
        /(?<!Try)\bdecimal\.Parse\(/,
      );
      expect(content, `${path} still parses datetime without a guard`).not.toMatch(
        /(?<!Try)\bDateTime\.Parse\(/,
      );
    }
  });

  it("the create action guards its money field and names it by JSON pointer", async () => {
    const files = await generateSystemFiles(SRC);
    const ctrl = bySuffix(files, "Api/OrdersController.cs");
    expect(ctrl).toContain(
      "decimal.TryParse(request.Price, NumberStyles.Number, CultureInfo.InvariantCulture, out var __wp_request_Price)",
    );
    expect(ctrl).toContain(
      `: throw new global::D.Domain.Common.WireFormatException("/price", $"Invalid decimal: \\"{request.Price}\\"")`,
    );
  });

  it("a datetime field is guarded the same way", async () => {
    const ctrl = bySuffix(await generateSystemFiles(SRC), "Api/OrdersController.cs");
    expect(ctrl).toContain("DateTime.TryParse(request.Due, CultureInfo.InvariantCulture");
    expect(ctrl).toContain(`WireFormatException("/due", $"Invalid datetime: \\"{request.Due}\\"")`);
  });

  it("a money field INSIDE a value object points at the nested path", async () => {
    const ctrl = bySuffix(await generateSystemFiles(SRC), "Api/OrdersController.cs");
    expect(ctrl).toContain(`WireFormatException("/best/offer",`);
  });

  it("a workflow request param is guarded too — same seam, other controller", async () => {
    const ctrl = bySuffix(await generateSystemFiles(SRC), "Api/OrdWorkflowsController.cs");
    expect(ctrl).toContain("decimal.TryParse(request.Amount,");
    expect(ctrl).toContain(`WireFormatException("/amount",`);
  });

  it("the filter renders node's envelope: 422 + errors[{pointer,message}]", async () => {
    const filter = bySuffix(await generateSystemFiles(SRC), "Api/DomainExceptionFilter.cs");
    expect(filter).toContain("context.Exception is WireFormatException wfe");
    expect(filter).toContain('Title = "Validation failed"');
    expect(filter).toContain("Status = 422");
    expect(filter).toContain("new { pointer = wfe.FieldPointer, message = wfe.Message }");
    // The arm must precede the generic 500 tail, or it never runs.
    expect(filter.indexOf("is WireFormatException")).toBeLessThan(
      filter.indexOf('Problem(context, 500, "Internal Server Error"'),
    );
  });

  it("the exception carries FieldPointer — `Pointer` is a /warnaserror CA1720 error", async () => {
    const common = bySuffix(await generateSystemFiles(SRC), "Domain/Common/DomainException.cs");
    expect(common).toContain("public sealed class WireFormatException : Exception");
    expect(common).toContain("public string FieldPointer { get; }");
    expect(common).not.toContain("public string Pointer { get; }");
  });

  it("every action that can now throw it already declares 422", async () => {
    const ctrl = bySuffix(await generateSystemFiles(SRC), "Api/OrdersController.cs");
    // Split into per-action blocks at the [Http…] attributes and assert that
    // any block containing a guard also declares the 422 response.
    const blocks = ctrl.split(/\n {4}\[Http/).slice(1);
    const guarded = blocks.filter((b) => b.includes("WireFormatException"));
    expect(guarded.length).toBeGreaterThan(0);
    for (const b of guarded) {
      expect(
        b,
        `an action throws WireFormatException but declares no 422:\n${b.slice(0, 400)}`,
      ).toContain("ProducesResponseType(typeof(ProblemDetails), 422)");
    }
  });
});
