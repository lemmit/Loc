import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Java/Spring — a value object's OWN `invariant`s are enforced at the WIRE
// boundary (422), not just re-thrown by the domain VO record's compact ctor
// (which the service invokes → DomainException).
//
// Each VO-typed request field nest-invokes a `<VO>Validator` (a Spring
// `Validator` seeded from the VO's invariants) from the command validator,
// which runs at the `@Valid @RequestBody` seam — before the service builds the
// throwing domain VO.  A rejectValue → MethodArgumentNotValidException → 422
// (errors[]), matching node/python/elixir/.NET.
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
  deployable d { platform: java, contexts: [Catalog], dataSources: [shopState], port: 4000 }
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

describe("java — VO invariant → 422 at the wire", () => {
  it("emits a `<VO>Validator` (Spring Validator) per VO carrying its invariants", async () => {
    const map = await files();
    const q = find(map, "features/items/QuantityValidator.java");
    expect(q).toContain("public final class QuantityValidator implements Validator");
    expect(q).toContain("return QuantityRequest.class.equals(clazz);");
    // int `value > 0` folds to the sound inclusive `value >= 1`.
    expect(q).toContain('if (!(value >= 1)) errors.rejectValue("value"');

    const e = find(map, "features/items/ExtentValidator.java");
    // Cross-field / messaged rule carries the stable wire code + author message.
    expect(e).toContain('if (!(lo < hi)) errors.rejectValue("lo", "msg.');
    expect(e).toContain("lo must be below hi");
  });

  it("the command validator nest-invokes each VO-typed field's validator", async () => {
    const c = find(await files(), "features/items/CreateItemValidator.java");
    expect(c).toContain("import org.springframework.validation.ValidationUtils;");
    expect(c).toContain('errors.pushNestedPath("qty");');
    expect(c).toContain(
      "ValidationUtils.invokeValidator(new QuantityValidator(), request.qty(), errors);",
    );
    expect(c).toContain("errors.popNestedPath();");
    // Null-guarded so an absent optional VO field is skipped, not an NPE.
    expect(c).toContain("if (request.qty() != null) {");
  });

  it("registers the command validator on @InitBinder even with no aggregate invariant", async () => {
    // The VO-only aggregate still emits + registers CreateItemValidator, so the
    // nested VO validators run at `@Valid` → MethodArgumentNotValidException 422.
    const ctrl = find(await files(), "features/items/ItemsController.java");
    expect(ctrl).toContain(
      "if (target instanceof CreateItemRequest) binder.addValidators(new CreateItemValidator());",
    );
  });
});
