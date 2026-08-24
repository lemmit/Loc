import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — a value object's OWN `invariant`s are enforced at the WIRE
// boundary (422), not just re-thrown in the domain constructor (400).
//
// A VO-typed request field references its Pydantic `<VO>` model, and Pydantic
// validates that nested model on request parse — so seeding the VO model with
// its invariants (via the SAME `Field(...)` + `@model_validator` carriers the
// aggregate command DTOs use) makes a malformed VO field a 422 at the edge,
// matching the node (Zod `<VO>Schema`) and Elixir (VO changeset) backends.
// This is the failure-taxonomy "validation → 422" routing for the VO regime.
// ---------------------------------------------------------------------------

const FIXTURE = `
system Shop {
  subdomain Sales {
    context Catalog {
      valueobject Quantity { value: int  invariant value > 0 }
      valueobject Sku { code: string  invariant code.length >= 3  invariant code.length <= 12 }
      valueobject Range { lo: int  hi: int  invariant lo < hi message "lo must be below hi" }
      aggregate Item with crudish {
        name: string
        qty: Quantity
        sku: Sku
        span: Range
      }
      repository Items for Item { }
    }
  }
  api CatalogApi from Sales
  storage pg { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: pg }
  deployable d { platform: python  contexts: [Catalog]  serves: CatalogApi  dataSources: [catalogState]  port: 4000 }
}
`;

async function wireModels(): Promise<string> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files.get("d/app/http/wire_models.py")!;
}

describe("python VO invariant → 422 at the wire", () => {
  it("single-field VO invariants become native `Field(...)` constraints on the VO model", async () => {
    const wm = await wireModels();
    // `value > 0` on an int folds to the sound inclusive `ge=1`.
    expect(wm).toContain("class Quantity(BaseModel):");
    expect(wm).toContain("    value: int = Field(ge=1)");
    // Two length invariants on one field merge into a single Field(...).
    expect(wm).toContain("class Sku(BaseModel):");
    expect(wm).toContain("    code: str = Field(min_length=3, max_length=12)");
    expect(wm).toContain("from pydantic import BaseModel, Field");
  });

  it("cross-field / messaged VO invariants route through a `@model_validator`", async () => {
    const wm = await wireModels();
    expect(wm).toContain("class Range(BaseModel):");
    expect(wm).toContain('    @model_validator(mode="after")');
    expect(wm).toContain("        if not (self.lo < self.hi):");
    // A messaged rule carries the author text via PydanticCustomError (its
    // stable `type` surfaces as errors[].code — the i18n key) plus the field's
    // `loc`, which only `ValidationError.from_exception_data` can supply from a
    // `model_validator` (M-T1.11) — so `errors[].pointer` names the field.
    expect(wm).toContain('"lo must be below hi"');
    expect(wm).toContain("from pydantic_core import InitErrorDetails, PydanticCustomError");
    expect(wm).toContain('loc=("lo",),');
  });

  it("a VO with no invariants stays byte-identical (fields only, BaseModel only)", async () => {
    const { model } = await parseString(`
      system S {
        subdomain Sub {
          context C {
            valueobject Plain { a: int  b: string }
            aggregate A with crudish { p: Plain }
            repository As for A { }
          }
        }
        api SApi from Sub
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        deployable d { platform: python  contexts: [C]  serves: SApi  dataSources: [cState]  port: 4000 }
      }
    `);
    const wm = generateSystems(model).files.get("d/app/http/wire_models.py")!;
    // `StringConstraints`/`WithJsonSchema` ride the always-emitted `UuidStr`
    // alias (schemathesis F2); the VO-driven names stay demand-gated.
    expect(wm).toContain("from pydantic import BaseModel, StringConstraints, WithJsonSchema\n");
    expect(wm).not.toContain("Field");
    expect(wm).not.toContain("model_validator");
    expect(wm).toContain("class Plain(BaseModel):\n    a: int\n    b: str");
  });
});
