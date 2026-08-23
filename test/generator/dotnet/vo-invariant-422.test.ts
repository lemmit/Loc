import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// .NET — a value object's OWN `invariant`s are enforced at the WIRE boundary
// (422), not just re-thrown by the domain VO constructor (400).
//
// The command carries DOMAIN value objects (`new Quantity(request.Qty.Value)`),
// constructed in the controller BEFORE the Mediator validation pipeline — so a
// command validator can't catch a bad VO field.  Instead each VO-typed wire
// request field SetValidator-refs a `<VO>RequestValidator`, and the controller
// runs the request validator up front (`ValidateAndThrow`) → FluentValidation
// ValidationException → 422 (errors[]), matching node/python/elixir.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales {
    context Catalog {
      valueobject Quantity { value: int  invariant value > 0 }
      valueobject Sku { code: string  invariant code.length >= 3  invariant code.length <= 12 }
      valueobject Extent { lo: int  hi: int  invariant lo < hi message "lo must be below hi" }
      aggregate Item with crudish {
        name: string
        qty: Quantity
        sku: Sku
        span: Extent
      }
      repository Items for Item { }
    }
  }
  api CatalogApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Catalog, kind: state, use: pg }
  deployable d { platform: dotnet, contexts: [Catalog], dataSources: [shopState], port: 4000 }
}
`;

async function files(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(map: Map<string, string>, suffix: string): string {
  const hit = [...map.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no emitted file ending in ${suffix}`);
  return hit[1];
}

describe("dotnet — VO invariant → 422 at the wire", () => {
  it("emits a `<VO>RequestValidator` per VO carrying its own invariants", async () => {
    const v = find(await files(), "Application/Items/Requests/ItemRequestValidators.cs");
    // Single-field int `value > 0` → the sound inclusive `.GreaterThanOrEqualTo(1)`.
    expect(v).toContain("class QuantityRequestValidator : AbstractValidator<QuantityRequest>");
    expect(v).toContain("RuleFor(x => x.Value).GreaterThanOrEqualTo(1);");
    // Two length invariants merge into one chain.  A LENGTH bound is a
    // code-point `.Must`, not FluentValidation's code-unit `.MinimumLength`
    // (RS-31).
    expect(v).toContain("class SkuRequestValidator : AbstractValidator<SkuRequest>");
    expect(v).toContain(
      "RuleFor(x => x.Code).Must(v => v == null || v.EnumerateRunes().Count() >= 3)",
    );
    expect(v).toContain("Must(v => v == null || v.EnumerateRunes().Count() <= 12)");
    // Cross-field / messaged → `.Must(...)` carrier with the stable wire code.
    expect(v).toContain("class ExtentRequestValidator : AbstractValidator<ExtentRequest>");
    expect(v).toContain("RuleFor(x => x).Must(x => x.Lo < x.Hi)");
    expect(v).toContain('.WithMessage("lo must be below hi")');
    expect(v).toContain(".WithErrorCode(");
  });

  it("the request validator SetValidator-refs each VO-typed field", async () => {
    const v = find(await files(), "Application/Items/Requests/ItemRequestValidators.cs");
    expect(v).toContain("class CreateItemRequestValidator : AbstractValidator<CreateItemRequest>");
    expect(v).toContain("RuleFor(x => x.Qty).SetValidator(new QuantityRequestValidator());");
    expect(v).toContain("RuleFor(x => x.Sku).SetValidator(new SkuRequestValidator());");
    expect(v).toContain("RuleFor(x => x.Span).SetValidator(new ExtentRequestValidator());");
  });

  it("the controller runs the request validator before constructing domain VOs", async () => {
    const c = find(await files(), "Api/ItemsController.cs");
    expect(c).toContain("using FluentValidation;");
    // The ValidateAndThrow precedes the throwing `new Quantity(...)` mapping.
    const validateAt = c.indexOf("new CreateItemRequestValidator().ValidateAndThrow(request);");
    const mapAt = c.indexOf("new Quantity(request.Qty.Value)");
    expect(validateAt).toBeGreaterThan(-1);
    expect(mapAt).toBeGreaterThan(validateAt);
  });

  it("turns on the FluentValidation gate (422 filter arm) even with no aggregate invariants", async () => {
    const map = await files();
    // The VO-only aggregate still gets the package ref + the exception filter's
    // 422 arm, so the ValidateAndThrow surfaces as 422 not an unhandled 500.
    expect(find(map, ".csproj")).toContain("FluentValidation");
    expect(find(map, "Api/DomainExceptionFilter.cs")).toContain("Status = 422");
  });
});
