import { describe, expect, it } from "vitest";
import { printStructural } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// The `for` head and the value-object / domain-service `test` anchors must
// survive printing (drives the `unfold` code action + round-trip).  In
// particular a domainService keeps its `test`s in a SEPARATE list from its
// operations, so the printer must emit both (regression guard: it once printed
// operations only and dropped the tests).
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain M { context C {
    valueobject Money { amount: decimal  currency: string
      test "vo nested" { expect(1).toBe(1) }
    }
    aggregate Order { code: string }
    domainService Pricing {
      operation withTax(base: decimal): decimal { return base * 1.1 }
      test "svc nested" { expect(1).toBe(1) }
    }
    test "ctx hoisted" for Order { expect(1).toBe(1) }
  } }
}
`;

describe("print: test placement anchors survive printing", () => {
  it("prints VO/service nested tests and the hoisted `for` head", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors, errors.join("\n")).toEqual([]);
    const printed = model.members.map((m) => printStructural(m)).join("\n");
    // value-object nested test
    expect(printed).toContain('test "vo nested"');
    // domain-service nested test — the drop-guard: it lives outside `operations`
    expect(printed).toContain('test "svc nested"');
    // hoisted head
    expect(printed).toContain('test "ctx hoisted" for Order');
  });
});
