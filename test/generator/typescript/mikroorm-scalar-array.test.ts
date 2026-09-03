// node/MikroORM adapter — a root SCALAR/ENUM collection field
// (`tags: string[]`, `kinds: Status[]`) now has a column arm, mirroring
// drizzle's native Postgres array column (M-T6.23, `loom.mikroorm-unsupported
// #scalar-array`, drained).
//
// `columnsOf` (typescript/emit/mikroorm.ts) filters out the two collection
// shapes it already mapped — `X id[]` (a pivot Row) and `<VO>[]` (one inline
// jsonb column) — and routed everything else into `columnsForType`, whose
// `default` arm THREW on an `array` kind: `mikroorm: unsupported field kind
// 'array' … (validator gap)`, so `ddd generate system` aborted with a raw
// Error on a `.ddd` that parsed and validated clean.  `validateMikroOrmSupport`
// turned that crash into an honest `loom.mikroorm-unsupported#scalar-array`
// refusal; this suite pins the REPLACEMENT — the emitter now maps the field
// (mirroring `test/generator/typescript/scalar-collection-roundtrip.test.ts`,
// drizzle's own pin for the identical shape), and the validator no longer
// fires for it at all.
//
// MikroORM's `array: true` + the element's own scalar `type` is what
// `MetadataDiscovery` wraps in an element-typed `ArrayType`, resolving the
// column to `<element column type>[]` on Postgres (native array support) —
// so `money[]`/`decimal[]` still round-trip through the SAME string
// conversion their scalar twins use (shared with drizzle: `projectFieldEntries`
// / `arrayElementHydrate`), and `int[]`/`string[]` keep the bare column.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SOURCE = `
system M {
  subdomain S {
    context C {
      enum Kind { A, B }
      aggregate Cart with crudish {
        prices: money[]
        rates: decimal[]
        counts: int[]
        labels: string[]
        kinds: Kind[]
        one: money
      }
      repository Carts for Cart { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: node { persistence: mikroorm }
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

describe("scalar-collection columns round-trip on mikroorm", () => {
  it("declares a native array property per element kind", async () => {
    const files = await generateSystemFiles(SOURCE);
    const entities = files.get("d/db/entities.ts")!;
    // money/decimal keep their scale-preserving explicit columnType, with the
    // trailing `[]` MikroORM's own auto-append would otherwise supply — set
    // explicitly here because an explicit `columnType` suppresses it.
    expect(entities).toContain(
      'prices: { type: "decimal", columnType: "numeric(19,4)[]", array: true },',
    );
    expect(entities).toContain('rates: { type: "decimal", columnType: "numeric[]", array: true },');
    // int/string/enum need no explicit columnType — MikroORM derives
    // `<element column type>[]` itself.
    expect(entities).toContain('counts: { type: "integer", array: true },');
    expect(entities).toContain('labels: { type: "string", array: true },');
    expect(entities).toContain('kinds: { type: "string", array: true },');
    // The Row class field types are TS arrays of the element's own TS type.
    expect(entities).toContain("prices!: string[];");
    expect(entities).toContain("rates!: string[];");
    expect(entities).toContain("counts!: number[];");
    expect(entities).toContain("labels!: string[];");
    expect(entities).toContain("kinds!: string[];");
  });

  it("hydrates money[]/decimal[] elements and leaves int[]/string[]/enum[] bare — same as drizzle", async () => {
    const files = await generateSystemFiles(SOURCE);
    const repo = files.get("d/db/repositories/cart-repository.ts")!;
    expect(repo).toContain("prices: (row.prices ?? []).map((__v) => new Decimal(__v))");
    expect(repo).toContain("rates: (row.rates ?? []).map((__v) => Number(__v))");
    expect(repo).toContain("counts: row.counts");
    expect(repo).toContain("labels: row.labels");
    expect(repo).toContain("kinds: row.kinds");
    expect(repo).not.toContain("counts: (row.counts");

    // WRITE: the symmetric stringification for money/decimal, bare otherwise —
    // the shared `projectFieldEntries` arm, unchanged from drizzle.
    expect(repo).toContain("prices: aggregate.prices.map((__v) => __v.toString())");
    expect(repo).toContain("rates: aggregate.rates.map((__v) => String(__v))");
    expect(repo).toContain("counts: aggregate.counts,");
  });

  it("no longer refuses a scalar-array root field on mikroorm", async () => {
    const { model } = await parseString(SOURCE, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.filter((d) => d.code === "loom.mikroorm-unsupported")).toEqual([]);
  });
});
