import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The emitted unit-test FILE is byte-identical whether the `test` is nested in
// its aggregate or hoisted out with `for <Agg>` — Phase 1 adds no emitter, the
// colocated `<agg>.test.ts` is a pure function of `AggregateIR.tests`, and a
// hoisted test lands there indistinguishably (test-placement.md).
// ---------------------------------------------------------------------------

const TEST_BODY = `let m = Money { amount: 10.5, currency: "USD" }
                   expect(m.amount).toBe(10.5)`;
const MONEY = `valueobject Money { amount: decimal  currency: string  invariant amount >= 0.0 }`;

const system = (p: { nested?: string; ctx?: string; root?: string }): string => `
system Shop {
  subdomain Sales { context Orders {
    ${MONEY}
    aggregate Order { code: string  ${p.nested ?? ""} }
    ${p.ctx ?? ""}
  } }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable api { platform: node contexts: [Orders] serves: OrdersApi dataSources: [st] port: 8080 }
}
${p.root ?? ""}`;

const unitTestFile = (files: Map<string, string>): string => {
  const key = [...files.keys()].find((k) => k.endsWith(".test.ts") && !k.includes("e2e"));
  expect(key, "expected a colocated domain unit test file").toBeDefined();
  return files.get(key!)!;
};

describe("Hono: hoisted `test … for <Agg>` emits an identical unit file", () => {
  it("nested vs context-hoisted → byte-identical emitted test file", async () => {
    const nested = unitTestFile(
      await generateSystemFiles(system({ nested: `test "money" { ${TEST_BODY} }` })),
    );
    const hoisted = unitTestFile(
      await generateSystemFiles(system({ ctx: `test "money" for Order { ${TEST_BODY} }` })),
    );
    expect(hoisted).toBe(nested);
    expect(nested).toContain('describe("Order"');
    expect(nested).toContain('it("money"');
  });

  it("nested vs root-hoisted → byte-identical emitted test file", async () => {
    const nested = unitTestFile(
      await generateSystemFiles(system({ nested: `test "money" { ${TEST_BODY} }` })),
    );
    const hoisted = unitTestFile(
      await generateSystemFiles(system({ root: `test "money" for Order { ${TEST_BODY} }` })),
    );
    expect(hoisted).toBe(nested);
  });
});
