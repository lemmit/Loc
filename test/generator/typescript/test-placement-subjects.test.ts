import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Phase 2 emission (test-placement.md): a value-object / domain-service `test`
// emits a colocated `domain/<subject>.test.ts` on the Hono backend, importing
// the VO from `./value-objects` and the service namespace from `./services`.
// Hoisting the test out (`for <Subject>`) yields a byte-identical file.
// ---------------------------------------------------------------------------

const system = (p: { voTest?: string; svcTest?: string; ctx?: string }): string => `
system Shop {
  subdomain Sales { context Orders {
    valueobject Money { amount: decimal  currency: string  invariant amount >= 0.0  ${p.voTest ?? ""} }
    aggregate Order { code: string  total: Money }
    domainService Pricing {
      operation withTax(base: decimal): decimal { return base * 1.1 }
      ${p.svcTest ?? ""}
    }
    ${p.ctx ?? ""}
    repository Orders for Order { }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Orders, kind: state, use: db }
  deployable api { platform: node contexts: [Orders] serves: ShopApi dataSources: [st] port: 8080 }
}`;

const file = (files: Map<string, string>, suffix: string): string | undefined => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  return key ? files.get(key) : undefined;
};

describe("Hono: value-object + domain-service unit-test emission", () => {
  it("emits domain/money.test.ts importing the VO from ./value-objects", async () => {
    const files = await generateSystemFiles(
      system({
        voTest: `test "neg" { expect(Money { amount: -1.0, currency: "USD" }).toThrow() }`,
      }),
    );
    const vo = file(files, "domain/money.test.ts");
    expect(vo, "expected domain/money.test.ts").toBeDefined();
    expect(vo).toContain('import { Money } from "./value-objects";');
    expect(vo).toContain('describe("Money"');
    expect(vo).toContain(".toThrow()");
  });

  it("emits domain/pricing.test.ts importing the service from ./services", async () => {
    const files = await generateSystemFiles(
      system({ svcTest: `test "tax" { expect(Pricing.withTax(100.0)).toBe(110.0) }` }),
    );
    const svc = file(files, "domain/pricing.test.ts");
    expect(svc, "expected domain/pricing.test.ts").toBeDefined();
    expect(svc).toContain('import { Pricing } from "./services";');
    expect(svc).toContain("Pricing.withTax(100.0)");
  });

  it("emits nothing when no VO/service test is declared", async () => {
    const files = await generateSystemFiles(system({}));
    expect(file(files, "domain/money.test.ts")).toBeUndefined();
    expect(file(files, "domain/pricing.test.ts")).toBeUndefined();
  });

  it("hoisted `for Money` emits a byte-identical file to the nested form", async () => {
    const nested = file(
      await generateSystemFiles(
        system({
          voTest: `test "neg" { expect(Money { amount: -1.0, currency: "USD" }).toThrow() }`,
        }),
      ),
      "domain/money.test.ts",
    );
    const hoisted = file(
      await generateSystemFiles(
        system({
          ctx: `test "neg" for Money { expect(Money { amount: -1.0, currency: "USD" }).toThrow() }`,
        }),
      ),
      "domain/money.test.ts",
    );
    expect(hoisted).toBe(nested);
  });
});
