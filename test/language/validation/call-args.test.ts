// `loom.call-arg-count` / `loom.call-arg-type` (M-T6.18 gap #2, slice A) —
// a resolved domain call in an operation body (`bump(5)`, `o.bump(a)`,
// `double(x)`) is checked for arity and per-argument type against the callee's
// declared params.  Previously `checkCallStmt` resolved the callee's existence
// only and never inspected the args.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (members: string) => `
system Demo {
  subdomain S {
    context C {
      aggregate Order with crudish {
        qty: int
        price: decimal
        ${members}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(members: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(members), { validate: true });
  return codesOf(diagnostics);
}

const COUNT = "loom.call-arg-count";
const TYPE = "loom.call-arg-type";

describe("loom.call-arg-count / loom.call-arg-type (M-T6.18 gap #2)", () => {
  it("flags too few arguments to an operation call", async () => {
    expect(
      await codes(`
        operation bump(n: int) { qty := qty + n }
        operation go() { bump() }`),
    ).toContain(COUNT);
  });

  it("flags too many arguments to an operation call", async () => {
    expect(
      await codes(`
        operation bump(n: int) { qty := qty + n }
        operation go() { bump(1, 2) }`),
    ).toContain(COUNT);
  });

  it("flags a wrong-typed argument to an operation call", async () => {
    expect(
      await codes(`
        operation bump(n: int) { qty := qty + n }
        operation go() { bump("x") }`),
    ).toContain(TYPE);
  });

  it("is CLEAN for a correctly-typed operation call", async () => {
    const c = await codes(`
      operation bump(n: int) { qty := qty + n }
      operation go() { bump(5) }`);
    expect(c).not.toContain(COUNT);
    expect(c).not.toContain(TYPE);
  });

  it("admits ergonomic int-literal promotion into a decimal param", async () => {
    const c = await codes(`
      operation setPrice(p: decimal) { price := p }
      operation go() { setPrice(5) }`);
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });

  it("checks a bare function-call statement's args", async () => {
    expect(
      await codes(`
        function double(x: int): int = x * 2
        operation go() { double("nope") }`),
    ).toContain(TYPE);
  });

  it("still warns on a self-call while arg-checking it", async () => {
    const c = await codes("operation loopy(n: int) { loopy(1) }");
    expect(c).not.toContain(COUNT);
    expect(c).not.toContain(TYPE);
  });

  it("suppresses on an unresolvable (unknown) argument", async () => {
    // `nope` is undeclared → typed unknown → the arg-type check stays silent
    // (the unknown-name check owns that diagnostic).
    expect(
      await codes(`
        operation bump(n: int) { qty := qty + n }
        operation go() { bump(nope) }`),
    ).not.toContain(TYPE);
  });
});
