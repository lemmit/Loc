// Round-trip safety for the `sensitive(...)` clause through the
// structural printer.  Pre-existing bug: `printProperty()` never
// emitted the sensitivity clause, so any property declaring tags
// would silently drop them when printed.  Fix landed alongside
// the access modifier work to leave no debt.
//
// Parallel to `test/language/field-access-print-roundtrip.test.ts`.

import { describe, expect, it } from "vitest";
import type {
  Aggregate,
  BoundedContext,
  Model,
  Property,
} from "../../../src/language/generated/ast.js";
import { isProperty } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseRawResult } from "../../_helpers/index.js";

function payloadProp(model: Model): Property {
  const ctx = model.members.find((m): m is BoundedContext => m.$type === "BoundedContext")!;
  const agg = ctx.members.find((m): m is Aggregate => m.$type === "Aggregate")!;
  return agg.members.filter(isProperty).find((p) => p.name === "payload")!;
}

describe("sensitivity — printer round-trip", () => {
  it("single tag survives parse → print → parse", () => {
    const src = `context T {
  aggregate A {
    payload: string sensitive(pii)
  }
  repository As for A { }
}`;
    const orig = parseRawResult(src);
    expect(orig.parserErrors).toEqual([]);
    expect(payloadProp(orig.value as Model).sensitivity?.tags).toEqual(["pii"]);

    const ctx = (orig.value as Model).members[0]!;
    const printed = printStructural(ctx);
    expect(printed, `printed source should contain the clause`).toContain(
      "payload: string sensitive(pii)",
    );

    const cst = ctx.$cstNode!;
    const text = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(text);
    expect(re.parserErrors, `re-parse must succeed:\n${printed}`).toEqual([]);
    expect(payloadProp(re.value as Model).sensitivity?.tags).toEqual(["pii"]);
  });

  it("multiple tags survive parse → print → parse", () => {
    const src = `context T {
  aggregate A {
    payload: string sensitive(pii, phi, regulated)
  }
  repository As for A { }
}`;
    const orig = parseRawResult(src);
    expect(orig.parserErrors).toEqual([]);
    expect(payloadProp(orig.value as Model).sensitivity?.tags).toEqual(["pii", "phi", "regulated"]);

    const ctx = (orig.value as Model).members[0]!;
    const printed = printStructural(ctx);
    expect(printed).toContain("payload: string sensitive(pii, phi, regulated)");

    const cst = ctx.$cstNode!;
    const text = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(text);
    expect(re.parserErrors).toEqual([]);
    expect(payloadProp(re.value as Model).sensitivity?.tags).toEqual(["pii", "phi", "regulated"]);
  });

  it("composes with provenanced and access modifier", () => {
    // Verifies the clause-emission order matches the grammar slot
    // order: provenanced → sensitivity → access → check.
    // (`display` moved to `derived display: string = expr` in PR #524
    // and is no longer a Property modifier.)
    const src = `context T {
  aggregate A {
    label: string provenanced sensitive(pii) immutable
  }
  repository As for A { }
}`;
    const orig = parseRawResult(src);
    expect(orig.parserErrors).toEqual([]);
    const ctx = (orig.value as Model).members[0]!;
    const printed = printStructural(ctx);
    expect(printed).toContain("label: string provenanced sensitive(pii) immutable");

    const cst = ctx.$cstNode!;
    const text = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(text);
    expect(re.parserErrors).toEqual([]);
  });
});
