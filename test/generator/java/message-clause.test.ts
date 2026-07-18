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
    validators: all.get(key("features/products/ProductValidators.java"))!,
  };
}

describe("java — messaged rule → wire validator + domain floor text", () => {
  it("surfaces the author text + a content-hash wire code on the wire validator", async () => {
    const { validators } = await gen();
    // messaged rule → 3-arg error() carrying the "msg.<hash>" wire code (i18n key)
    expect(validators).toContain(
      'errors.add(WireValidationException.error("/name", "Name must be 2-120 characters", "msg.j985f2"))',
    );
    expect(validators).toContain(
      'errors.add(WireValidationException.error("/sku", "SKU is required", "msg.u3w71r"))',
    );
  });

  it("keeps a message-LESS invariant on the derived default with no wire code", async () => {
    const { validators } = await gen();
    // 2-arg error() → no code (byte-identical)
    expect(validators).toContain(
      'errors.add(WireValidationException.error("/sku", "Invariant violated: sku.length > 0"))',
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
