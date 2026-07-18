import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Custom validation messages on the .NET backend — a messaged rule renders
// through the FluentValidation `.Must(...).WithMessage(<text>)` carrier and the
// `AssertInvariants` domain floor `DomainException(<text>)`; a message-less rule
// keeps its native chain (`.MinimumLength(N)`) + derived default byte-identical.
// ---------------------------------------------------------------------------

const SOURCE = `
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
    deployable api { platform: dotnet contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
  }
`;

async function gen() {
  const all = await generateSystemFiles(SOURCE);
  const key = (suffix: string) => [...all.keys()].find((k) => k.endsWith(suffix))!;
  return {
    validator: all.get(key("Commands/CreateProductCommandValidator.cs"))!,
    domain: all.get(key("Domain/Products/Product.cs"))!,
  };
}

describe("dotnet — messaged rule → FluentValidation .WithMessage carrier", () => {
  it("routes a messaged invariant/check through .Must(...).WithMessage(text)", async () => {
    const { validator } = await gen();
    expect(validator).toContain(
      "RuleFor(x => x).Must(x => x.Name.Length >= 2 && x.Name.Length <= 120)",
    );
    expect(validator).toContain('.WithMessage("Name must be 2-120 characters");');
    expect(validator).toContain('.WithMessage("SKU is required");');
  });

  it("keeps a message-LESS invariant as a byte-identical native chain", async () => {
    const { validator } = await gen();
    expect(validator).toContain("RuleFor(x => x.Sku).MinimumLength(1);");
  });
});

describe("dotnet — messaged rule → domain floor text", () => {
  it("throws the author text (not the derived default) in AssertInvariants", async () => {
    const { domain } = await gen();
    expect(domain).toContain('throw new DomainException("Name must be 2-120 characters")');
    expect(domain).toContain('throw new DomainException("SKU is required")');
    // message-less invariant keeps the derived default.
    expect(domain).toContain('throw new DomainException("Invariant violated: sku.length > 0")');
  });
});
