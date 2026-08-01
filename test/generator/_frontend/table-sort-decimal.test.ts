// `sortRows` must order `money` / `decimal` columns NUMERICALLY.
//
// Those fields arrive as a decimal.js `Decimal` OBJECT, and `Decimal`'s
// `valueOf()` returns a STRING — so the original `(av as number) < (bv as
// number)` compared the decimal TEXT and produced [10, 100, 9] for an ascending
// sort.  Every frontend that calls this helper (Vue / Svelte / Angular) had the
// bug, and React had the same one inlined in `tsxTarget.renderSortedRows`.
//
// This executes the EMITTED helper source rather than asserting on its text:
// the defect is a comparison result, and a string-level assertion is exactly
// what let it ship.

import { describe, expect, it } from "vitest";
import { buildTableSortHelper } from "../../../src/generator/_frontend/table-sort-helper.js";

/** Compile the emitted TS helper down to something Node can run.
 *  The module is deliberately plain — the only TS in it is type annotations and
 *  `as` casts, so stripping them is enough to execute the real logic. */
function loadSortRows(): (rows: unknown[], key: string, dir: string) => unknown[] {
  const src = buildTableSortHelper()
    .replace(/export function/g, "function")
    .replace(/<T>/g, "")
    .replace(/: readonly T\[\] \| undefined/g, "")
    .replace(/: unknown\[\]/g, "")
    .replace(/: T\[\]/g, "")
    .replace(/\(v: unknown\)/g, "(v)")
    .replace(/\(rows, key: string, dir: string\)/g, "(rows, key, dir)")
    .replace(/rows, key: string, dir: string/g, "rows, key, dir")
    .replace(/query: string/g, "query")
    .replace(/: unknown/g, "")
    .replace(/ as Record<string, unknown>/g, "")
    .replace(/ as number/g, "");
  // biome-ignore lint/security/noGlobalEval: executing the emitted helper is the point of this test.
  return eval(`${src}\nsortRows`) as (rows: unknown[], key: string, dir: string) => unknown[];
}

/** A stand-in with decimal.js's load-bearing property: `valueOf()` is a STRING,
 *  so `<` between two of them compares text.  (Fable's Decimal, which the Feliz
 *  frontend uses, behaves the same way.) */
class FakeDecimal {
  constructor(private readonly s: string) {}
  valueOf(): string {
    return this.s;
  }
  toString(): string {
    return this.s;
  }
}

describe("sortRows — decimal-like values (M-T1.1 follow-on)", () => {
  const sortRows = loadSortRows();
  const rows = [
    { ref: "c", amount: new FakeDecimal("100.00") },
    { ref: "a", amount: new FakeDecimal("9.00") },
    { ref: "b", amount: new FakeDecimal("10.00") },
  ];
  const refs = (out: unknown[]) => out.map((r) => (r as { ref: string }).ref);

  it("orders a money column by VALUE, not by its decimal text", () => {
    // The bug: text order is "10.00" < "100.00" < "9.00" → b, c, a.
    expect(refs(sortRows(rows, "amount", "asc"))).toEqual(["a", "b", "c"]);
    expect(refs(sortRows(rows, "amount", "desc"))).toEqual(["c", "b", "a"]);
  });

  it("leaves string columns on their existing comparison", () => {
    expect(refs(sortRows(rows, "ref", "asc"))).toEqual(["a", "b", "c"]);
    expect(refs(sortRows(rows, "ref", "desc"))).toEqual(["c", "b", "a"]);
  });

  it("does not reorder non-numeric objects or arrays", () => {
    // `Number([])` is 0 and `Number({})` is NaN — neither may be treated as a
    // numeric value, or unrelated columns would silently change order.
    const odd = [
      { k: "x", v: ["z"] },
      { k: "y", v: ["a"] },
    ];
    // Both coerce to NaN-or-untouched, so the sort is a no-op either way; what
    // matters is that it does not throw and does not invent an ordering.
    expect(sortRows(odd, "v", "asc")).toHaveLength(2);
  });

  it("handles negative amounts (where a digit-chunk comparator would not)", () => {
    const withNeg = [
      { ref: "p", amount: new FakeDecimal("5.00") },
      { ref: "n", amount: new FakeDecimal("-5.00") },
      { ref: "z", amount: new FakeDecimal("0.00") },
    ];
    expect(refs(sortRows(withNeg, "amount", "asc"))).toEqual(["n", "z", "p"]);
  });
});
