// Round-trip safety for the `access` modifier through the structural
// printer.  Parse → print → re-parse → assert AST equivalent.  Pins
// that `printProperty()` emits the modifier in the correct slot
// (after sensitivity, before check) so a printed source survives a
// second parse with the modifier intact.
//
// Pre-existing related bug (sensitivity round-trip omission in
// `printProperty`) is intentionally out of scope for this PR.

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

const MODIFIERS = ["immutable", "managed", "internal", "secret"] as const;
// `token` covered separately so the type can be non-nullable
// (validator forbids `T? token`).

function payloadProp(model: Model): Property {
  const ctx = model.members.find((m): m is BoundedContext => m.$type === "BoundedContext")!;
  const agg = ctx.members.find((m): m is Aggregate => m.$type === "Aggregate")!;
  return agg.members.filter(isProperty).find((p) => p.name === "payload")!;
}

describe("field access — printer round-trip", () => {
  it.each(MODIFIERS)("`%s` survives parse → print → parse", (modifier) => {
    const src = `context T {
  aggregate A {
    payload: string ${modifier}
  }
  repository As for A { }
}`;
    const orig = parseRawResult(src);
    expect(orig.parserErrors).toEqual([]);
    const origProp = payloadProp(orig.value as Model);
    expect(origProp.access).toBe(modifier);

    // Print the whole context (printStructural dispatches into
    // printProperty via the aggregate's member loop).
    const ctx = (orig.value as Model).members[0]!;
    const printed = printStructural(ctx);
    expect(printed, `printed source should contain the modifier`).toContain(
      `payload: string ${modifier}`,
    );

    // Splice the printed text back over the context's range and re-parse.
    const cst = ctx.$cstNode!;
    const text = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(text);
    expect(re.parserErrors, `re-parse must succeed:\n${printed}`).toEqual([]);
    expect(payloadProp(re.value as Model).access).toBe(modifier);
  });

  it("`token` (non-nullable) survives parse → print → parse", () => {
    const src = `context T {
  aggregate A {
    payload: int token
  }
  repository As for A { }
}`;
    const orig = parseRawResult(src);
    expect(orig.parserErrors).toEqual([]);
    expect(payloadProp(orig.value as Model).access).toBe("token");

    const ctx = (orig.value as Model).members[0]!;
    const printed = printStructural(ctx);
    expect(printed).toContain("payload: int token");

    const cst = ctx.$cstNode!;
    const text = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(text);
    expect(re.parserErrors).toEqual([]);
    expect(payloadProp(re.value as Model).access).toBe("token");
  });
});
