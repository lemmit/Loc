import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Phase 2 anchors (test-placement.md): a unit `test` may nest in a
// `valueobject` / `domainService`, or hoist out with `for <VO|Service>`. The
// same placement rules as Phase 1 apply — `for` required when hoisted, forbidden
// when nested — now across all three subject kinds.
// ---------------------------------------------------------------------------

const build = (p: { voBody?: string; svcBody?: string; ctx?: string; root?: string }): string => `
  system S {
    subdomain M { context C {
      valueobject Money { amount: decimal  currency: string  invariant amount >= 0.0  ${p.voBody ?? ""} }
      aggregate Order { code: string }
      domainService Pricing {
        operation withTax(base: decimal): decimal { return base * 1.1 }
        ${p.svcBody ?? ""}
      }
      ${p.ctx ?? ""}
    } }
  }
  ${p.root ?? ""}
`;

const codes = (d: Diagnostic[]): string[] => d.map((x) => String(x.code ?? "")).filter(Boolean);

describe("validator: test placement — value object + domain service anchors", () => {
  it("ACCEPTS a nested value-object test (no `for`)", async () => {
    const { errors } = await parseString(build({ voBody: `test "vo unit" { expect(1).toBe(1) }` }));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("ACCEPTS a nested domain-service test (no `for`)", async () => {
    const { errors } = await parseString(
      build({ svcBody: `test "svc unit" { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("ACCEPTS a hoisted test `for <ValueObject>` and `for <DomainService>`", async () => {
    const { errors } = await parseString(
      build({
        ctx: `test "a" for Money { expect(1).toBe(1) }  test "b" for Pricing { expect(1).toBe(1) }`,
      }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("ACCEPTS a root-hoisted test `for <ValueObject>`", async () => {
    const { errors } = await parseString(
      build({ root: `test "a" for Money { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("loom.test-redundant-for — nested value-object test that restates `for`", async () => {
    const { diagnostics } = await parseString(
      build({ voBody: `test "vo" for Money { expect(1).toBe(1) }` }),
    );
    expect(codes(diagnostics)).toContain("loom.test-redundant-for");
  });

  it("loom.test-redundant-for — nested domain-service test that restates `for`", async () => {
    const { diagnostics } = await parseString(
      build({ svcBody: `test "svc" for Pricing { expect(1).toBe(1) }` }),
    );
    expect(codes(diagnostics)).toContain("loom.test-redundant-for");
  });
});
