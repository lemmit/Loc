import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Custom validation messages on the Java/Spring Boot backend — a messaged
// rule surfaces the author text on the wire validator
// (`WireValidationException.error("/path", <text>)`) AND the domain floor
// (`throw new DomainException(<text>)`); a message-less rule keeps its
// derived `Invariant violated:` default, byte-identical.
// ---------------------------------------------------------------------------

const SRC = `
system S {
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
  deployable api { platform: java contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

async function gen() {
  const all = await generateSystemFiles(SRC);
  const key = (suffix: string) => [...all.keys()].find((k) => k.endsWith(suffix))!;
  return {
    domain: all.get(key("features/products/Product.java"))!,
    validator: all.get(key("features/products/CreateProductValidator.java"))!,
  };
}

describe("java — messaged rule → wire validator + domain floor text", () => {
  it("surfaces the author text + a content-hash wire code via rejectValue", async () => {
    const { validator } = await gen();
    // messaged rule → rejectValue(field, "msg.<hash>", <text>) carrying the i18n key
    expect(validator).toContain(
      'errors.rejectValue("name", "msg.j985f2", "Name must be 2-120 characters")',
    );
    expect(validator).toContain('errors.rejectValue("sku", "msg.u3w71r", "SKU is required")');
  });

  it("keeps a message-LESS single-field rule with the sentinel code (no wire code)", async () => {
    const { validator } = await gen();
    // The message-less `invariant sku.length > 0` uses the `loom.invariant`
    // sentinel code, which the advice does NOT surface as a wire `code`.
    expect(validator).toContain(
      'errors.rejectValue("sku", "loom.invariant", "Invariant violated: sku.length > 0")',
    );
  });

  it("throws the author text (not the derived default) in the domain floor", async () => {
    const { domain } = await gen();
    expect(domain).toContain('throw new DomainException("Name must be 2-120 characters")');
    expect(domain).toContain('throw new DomainException("SKU is required")');
    // message-less invariant keeps the derived default
    expect(domain).toContain('throw new DomainException("Invariant violated: sku.length > 0")');
  });
});
