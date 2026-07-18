import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Custom validation messages on the Python/FastAPI backend — a messaged rule
// renders through the wire refine carrier (`@model_validator` raising
// `ValueError(<text>)`) and the domain floor (`_assert_invariants` raising
// `DomainError(<text>)`); a message-less single-field rule keeps its native
// `Field(min_length=N)` constraint + the derived `Invariant violated:`
// default, byte-identical to before.
// ---------------------------------------------------------------------------

const FIXTURE = `system S {
  subdomain Sales {
    context Cat {
      aggregate Product {
        sku: string check sku.length > 0 message "SKU is required"
        name: string
        invariant name.length >= 2 && name.length <= 120 message "Name must be 2-120 characters"
        invariant sku.length > 0
        create(n: string, s: string) { name := n  sku := s }
      }
      repository Products for Product { }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: python contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

async function gen() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  const key = (suffix: string) => [...files.keys()].find((k) => k.endsWith(suffix))!;
  return {
    domain: files.get(key("domain/product.py"))!,
    routes: files.get(key("http/product_routes.py"))!,
  };
}

describe("python — messaged rule → wire refine + domain floor text", () => {
  it("routes a messaged invariant/check through @model_validator PydanticCustomError(code, text)", async () => {
    const { routes } = await gen();
    expect(routes).toContain('@model_validator(mode="after")');
    expect(routes).toContain("from pydantic_core import PydanticCustomError");
    // content-hash wire code (i18n key) + clean author text, no "Value error," prefix
    expect(routes).toContain(
      'raise PydanticCustomError("msg.j985f2", "Name must be 2-120 characters")',
    );
    expect(routes).toContain('raise PydanticCustomError("msg.u3w71r", "SKU is required")');
  });

  it("keeps a message-LESS single-field rule as a native Field() constraint", async () => {
    const { routes } = await gen();
    expect(routes).toContain("sku: str = Field(min_length=1)");
    // the message-less rule never becomes a refine ValueError
    expect(routes).not.toContain('raise ValueError("Invariant violated: sku.length > 0")');
  });

  it("throws the author text (not the derived default) in _assert_invariants", async () => {
    const { domain } = await gen();
    expect(domain).toContain('raise DomainError("Name must be 2-120 characters")');
    expect(domain).toContain('raise DomainError("SKU is required")');
    // message-less invariant keeps the derived default
    expect(domain).toContain('raise DomainError("Invariant violated: sku.length > 0")');
  });
});
