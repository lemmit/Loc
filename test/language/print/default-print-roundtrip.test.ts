// Round-trip safety for a property's `= <default>` clause through the
// structural printer.  Pre-existing bug: `printProperty()` never emitted
// the default clause, so `count: int = 0` printed as `count: int` and the
// default was silently dropped.  Surfaced by `examples/lifecycle.ddd`
// (defaulted `Counter`) in the structural round-trip corpus.
//
// Parallel to `sensitivity-print-roundtrip.test.ts` /
// `field-access-print-roundtrip.test.ts`.

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

function prop(model: Model, name: string): Property {
  const ctx = model.members.find((m): m is BoundedContext => m.$type === "BoundedContext")!;
  const agg = ctx.members.find((m): m is Aggregate => m.$type === "Aggregate")!;
  return agg.members.filter(isProperty).find((p) => p.name === name)!;
}

function roundTrip(src: string): Model {
  const orig = parseRawResult(src);
  expect(orig.parserErrors).toEqual([]);
  const ctx = (orig.value as Model).members[0]!;
  const printed = printStructural(ctx);
  const text = src.slice(0, ctx.$cstNode!.offset) + printed + src.slice(ctx.$cstNode!.end);
  const re = parseRawResult(text);
  expect(re.parserErrors, `re-parse must succeed:\n${printed}`).toEqual([]);
  return re.value as Model;
}

describe("property default — printer round-trip", () => {
  it("numeric default survives parse → print → parse", () => {
    const src = `context T {
  aggregate A {
    count: int = 0
  }
  repository As for A { }
}`;
    const ctx = (parseRawResult(src).value as Model).members[0]!;
    expect(printStructural(ctx)).toContain("count: int = 0");
    const back = prop(roundTrip(src), "count");
    expect(back.default?.$type).toBe("IntLit");
  });

  it("string default survives (re-quoted) parse → print → parse", () => {
    const src = `context T {
  aggregate A {
    label: string = "untitled"
  }
  repository As for A { }
}`;
    const ctx = (parseRawResult(src).value as Model).members[0]!;
    expect(printStructural(ctx)).toContain(`label: string = "untitled"`);
    const back = prop(roundTrip(src), "label");
    expect(back.default?.$type).toBe("StringLit");
  });

  it("default sits between the access modifier and check (grammar slot order)", () => {
    const src = `context T {
  aggregate A {
    qty: int immutable = 1 check qty >= 0
  }
  repository As for A { }
}`;
    const ctx = (parseRawResult(src).value as Model).members[0]!;
    expect(printStructural(ctx)).toContain("qty: int immutable = 1 check qty >= 0");
    const back = prop(roundTrip(src), "qty");
    expect(back.default?.$type).toBe("IntLit");
    expect(back.check).toBeDefined();
  });
});
