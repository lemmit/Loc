// A6 string interpolation — printer round-trip.  `print-completeness`
// already gates that a `TemplateStr` arm exists; this pins the reconstruction
// (segments re-escaped, holes recursively printed) and that it re-parses to
// the same segment/hole shape.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type Expression,
  isTemplateStr,
  type TemplateStr,
} from "../../../src/language/generated/ast.js";
import { printExpr } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

async function firstTemplate(exprSource: string): Promise<TemplateStr> {
  const src = `
    context C {
      aggregate Order {
        quantity: int
        customerName: string
        derived v: string = ${exprSource}
      }
      repository Orders for Order { }
    }
  `;
  const { model } = await parseString(src, { validate: false });
  for (const n of AstUtils.streamAllContents(model)) if (isTemplateStr(n)) return n;
  throw new Error("no TemplateStr parsed");
}

describe("print — A6 string interpolation", () => {
  it("reconstructs the backtick template with holes", async () => {
    const node = await firstTemplate("`Order #{quantity} for {customerName}`");
    expect(printExpr(node as Expression)).toBe("`Order #{quantity} for {customerName}`");
  });

  it("reconstructs a hole-free template", async () => {
    const node = await firstTemplate("`no holes here`");
    expect(printExpr(node as Expression)).toBe("`no holes here`");
  });

  it("round-trips: printed source re-parses to the same segments + hole count", async () => {
    const node = await firstTemplate("`a {quantity} b {customerName} c`");
    const printed = printExpr(node as Expression);
    const reparsed = await firstTemplate(printed);
    expect(reparsed.strings).toEqual(node.strings);
    expect(reparsed.holes).toHaveLength(node.holes.length);
  });
});
