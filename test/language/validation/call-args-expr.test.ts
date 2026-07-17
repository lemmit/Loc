// `loom.call-arg-count` / `loom.call-arg-type` for FREE calls in EXPRESSION
// position (M-T6.18 gap #2, slice B) — a user-function call in a `derived`
// expression, a `let` value, a `precondition`, etc. is arity/type-checked the
// same as a statement-level call.  These type through the pure `typeOf`, so the
// check rides an expression walk (`checkExprCallArgs`) hooked at the statement
// walk + non-body sites.

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
        rate: decimal
        function fee(x: int): int = x * 2
        function feeD(x: decimal): decimal = x
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

describe("expression-position free-call args (M-T6.18 gap #2 slice B)", () => {
  it("flags a wrong-typed arg in a DERIVED expression call", async () => {
    expect(await codes('derived d: int = fee("x")')).toContain(TYPE);
  });

  it("flags a wrong arg count in a derived expression call", async () => {
    expect(await codes("derived d: int = fee()")).toContain(COUNT);
  });

  it("is CLEAN for a correctly-typed derived call", async () => {
    const c = await codes("derived d: int = fee(3)");
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });

  it("admits int-literal promotion into a decimal param in expression position", async () => {
    expect(await codes("derived d: decimal = feeD(3)")).not.toContain(TYPE);
  });

  it("flags a wrong-typed arg in a LET value inside an operation body", async () => {
    expect(await codes('operation go() { let y := fee("x")  qty := y }')).toContain(TYPE);
  });

  it("flags a wrong-typed arg to a call used in a precondition", async () => {
    expect(await codes('operation go() { precondition fee("x") > 0 }')).toContain(TYPE);
  });

  it("suppresses on an unresolvable (unknown) argument", async () => {
    expect(await codes("derived d: int = fee(nope)")).not.toContain(TYPE);
  });

  it("does not flag a call whose args are nested well-typed calls", async () => {
    const c = await codes("derived d: int = fee(fee(3))");
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });
});
