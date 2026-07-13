// `avg(λ)` has NO renderer — it DESUGARS in lowering to
// `count == 0 ? null : sum(λ) / count`, riding the (money/decimal-correct)
// `sum` fold and the money/decimal-safe `/` division.  This pins the SHAPE of
// the generated getter end-to-end: a money projection folds decimal.js
// `Decimal`s (`.plus` + `.div`); a plain-numeric projection stays native
// (`+` + `/`).  Both are optional (empty collection → null).

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Order {
      contains lines: OrderLine[]
      derived a: money? = lines.avg(l => l.price)
      derived b: decimal? = lines.avg(l => l.qty)
      entity OrderLine { qty: int  price: money }
    }
    repository Orders for Order { }
  }
`;

describe("typescript generator — avg(λ) desugar", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("desugars a money `avg` to an empty-guarded decimal.js `.plus`/`.div` mean", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/order.ts")!;
    const line = domain.split("\n").find((l) => l.includes("get a("))!;
    expect(line).toBeDefined();
    // empty collection → null
    expect(line).toContain("length === 0 ? null");
    // money sum folds decimal.js Decimals from a `new Decimal(0)` seed…
    expect(line).toContain(".plus(");
    expect(line).toContain("new Decimal(0)");
    // …divided by the count via Decimal `.div` (native `/` coerces a Decimal).
    expect(line).toContain(".div(");
  });

  it("desugars a plain-numeric (int) `avg` to the native `+`/`/` mean", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/order.ts")!;
    const line = domain.split("\n").find((l) => l.includes("get b("))!;
    expect(line).toBeDefined();
    expect(line).toContain("length === 0 ? null");
    // int sum stays native `+`/`0`, divided by count with native `/`.
    expect(line).toContain("acc + ");
    expect(line).toContain(", 0)");
    expect(line).toContain(" / ");
    // no decimal.js on the numeric path
    expect(line).not.toContain(".plus(");
    expect(line).not.toContain(".div(");
  });
});
