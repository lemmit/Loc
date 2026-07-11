// A6 string interpolation — lowering pins.  A backtick template desugars to
// plain `string + <hole>` concatenation (NO new IR kind): literal segments
// become `literal` nodes, stringifiable non-string holes get a `convert`
// wrap (the same node the explicit `string(x)` / implicit `"a" + x` path
// emits), string holes pass through bare.  This is the whole reason A6 needs
// zero backend work.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function derivedExpr(body: string, name: string): Promise<ExprIR> {
  const src = `
    context C {
      aggregate Order {
        quantity: int
        customerName: string
        ${body}
      }
      repository Orders for Order { }
    }
  `;
  const { model } = await parseString(src, { validate: false });
  const agg = allAggregates(lowerModel(model)).find((a) => a.name === "Order")!;
  return agg.derived.find((d) => d.name === name)!.expr;
}

/** Collect every node kind in an expression tree (pre-order). */
function kinds(e: ExprIR, out: string[] = []): string[] {
  out.push(e.kind);
  for (const v of Object.values(e as Record<string, unknown>)) {
    if (v && typeof v === "object" && "kind" in v) kinds(v as ExprIR, out);
  }
  return out;
}

/** All string-literal values in an expression tree. */
function litValues(e: ExprIR, out: string[] = []): string[] {
  if (e.kind === "literal" && e.lit === "string") out.push(e.value);
  for (const v of Object.values(e as Record<string, unknown>)) {
    if (v && typeof v === "object" && "kind" in v) litValues(v as ExprIR, out);
  }
  return out;
}

describe("A6 interpolation lowering", () => {
  it("lowers to a `+` concat of literals and a `convert`-wrapped int hole", async () => {
    const expr = await derivedExpr(
      "derived label: string = `Order #{quantity} for {customerName}`",
      "label",
    );
    const ks = kinds(expr);
    // No dedicated interpolation node — pure binary/literal/convert.
    expect(ks).not.toContain("template");
    expect(ks).toContain("binary");
    // The int hole is stringified via `convert`; the string hole is not.
    expect(ks.filter((k) => k === "convert")).toHaveLength(1);
    // The literal segments survive verbatim (delimiter-stripped).
    expect(litValues(expr)).toEqual(["Order #", " for "]);
  });

  it("a single string hole lowers to the bare ref (no convert, no concat)", async () => {
    const expr = await derivedExpr("derived g: string = `{customerName}`", "g");
    expect(kinds(expr)).not.toContain("convert");
    expect(kinds(expr)).not.toContain("binary");
  });

  it("a hole-free template lowers to one string literal", async () => {
    const expr = await derivedExpr("derived p: string = `just text`", "p");
    expect(expr.kind).toBe("literal");
    expect(litValues(expr)).toEqual(["just text"]);
  });
});
