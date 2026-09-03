// node/drizzle — a SCALAR COLLECTION column round-trips through the element's
// own conversion (G2667-C2).
//
// `money[]` / `decimal[]` persist as `numeric(19,4).array()`, and drizzle hands
// back the ELEMENT column's runtime type per item — i.e. `string[]`.  The
// hydrate had arms for optional / primitive / id / enum / valueobject and then
// fell through to the bare column, so a `money[]` reached `_rehydrate` (typed
// `Decimal[]`) as raw strings: the read never produced `Decimal`s and every
// downstream `.eq` / arithmetic on an element blew up.  The write half had the
// mirror-image hole — `Decimal[]` handed to a `string[]` column.
//
// The scalar money/decimal fields beside them have carried both conversions all
// along; this pins that the ARRAY forms agree with them, and that element types
// needing no conversion keep the bare column (byte-identical emission).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = `
system M {
  subdomain S {
    context C {
      aggregate Cart with crudish {
        prices: money[]
        rates: decimal[]
        counts: int[]
        labels: string[]
        one: money
      }
      repository Carts for Cart { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

describe("scalar-collection columns round-trip on drizzle", () => {
  it("hydrates money[]/decimal[] elements and leaves int[]/string[] bare", async () => {
    const files = await generateSystemFiles(SOURCE);
    const repo = files.get("d/db/repositories/cart-repository.ts")!;
    const schema = files.get("d/db/schema.ts")!;
    // The column really is a numeric array — the premise of the whole fix.
    expect(schema).toContain('prices: numeric("prices", { precision: 19, scale: 4 }).array()');

    // READ: each element through the same `new Decimal(...)` / `Number(...)` the
    // scalar arm applies.
    expect(repo).toContain("prices: (root.prices ?? []).map((__v) => new Decimal(__v))");
    expect(repo).toContain("rates: (root.rates ?? []).map((__v) => Number(__v))");
    // …and the element types that need nothing keep the bare column.
    expect(repo).toContain("counts: root.counts");
    expect(repo).toContain("labels: root.labels");
    expect(repo).not.toContain("counts: (root.counts");

    // WRITE: the symmetric stringification — a `numeric` column takes strings,
    // exactly as the scalar money field beside it does.
    expect(repo).toContain("prices: aggregate.prices.map((__v) => __v.toString())");
    expect(repo).toContain("rates: aggregate.rates.map((__v) => String(__v))");
    expect(repo).toContain("one: aggregate.one.toString()");
    expect(repo).toContain("counts: aggregate.counts,");
  });
});
