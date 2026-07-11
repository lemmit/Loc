// A6 string interpolation (docs/plans/stdlib.md) — the backtick template
// `` `Order {id} for {customer.name}` ``.  Parse-level coverage: the
// two-mode lexer (interpolation coexists with ordinary block braces), and
// the hole-type gate:
//   loom.interp-hole-type — a hole must be string / stringifiable.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (body: string): string => `
  context C {
    aggregate Order {
      quantity: int
      customerName: string
      total: money
      dueAt: datetime
      tags: string[]
      ${body}
    }
    repository Orders for Order { }
  }
`;

describe("validation — A6 string interpolation", () => {
  it("accepts string / number / money holes, multi-hole, plain, and empty templates", async () => {
    const { errors } = await parseString(
      wrap(`
        derived a: string = \`Order #{quantity} for {customerName}\`
        derived b: string = \`total {total}\`
        derived c: string = \`no holes here\`
        derived e: string = \`{customerName}\`
        derived f: string = \`\`
      `),
    );
    expect(errors).toEqual([]);
  });

  it("coexists with ordinary block braces — no lexer regression", async () => {
    // The surrounding aggregate / context blocks AND a `match`-adjacent body
    // all use `{ }`; a template's `{hole}` must not disturb them.
    const { errors } = await parseString(
      wrap(`
        derived label: string = \`Order {quantity}\`
        operation greet(): string {
          return \`Hi {customerName}, order {quantity}\`
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("supports full-expression holes (arithmetic, calls, nested templates)", async () => {
    const { errors } = await parseString(
      wrap(`
        derived total2: string = \`doubled {quantity + quantity}\`
        derived tern: string = \`{quantity > 0 ? "some" : "none"}\`
        derived nested: string = \`[{\`#{quantity}\`}]\`
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a datetime hole (no stringification) — loom.interp-hole-type", async () => {
    const { diagnostics } = await parseString(wrap(`derived x: string = \`at {dueAt}\``));
    expect(diagnostics.some((d) => d.code === "loom.interp-hole-type")).toBe(true);
  });

  it("rejects a collection hole — loom.interp-hole-type", async () => {
    const { diagnostics } = await parseString(wrap(`derived x: string = \`tags {tags}\``));
    expect(diagnostics.some((d) => d.code === "loom.interp-hole-type")).toBe(true);
  });

  it("rejects an empty hole (parse error)", async () => {
    const { errors } = await parseString(wrap(`derived x: string = \`a {} b\``));
    expect(errors.length).toBeGreaterThan(0);
  });
});
