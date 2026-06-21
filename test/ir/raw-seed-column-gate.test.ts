// Bucket V / P4 — raw-seed column value gate.  A `seed raw { … }` row is a
// direct Postgres INSERT (sql-pg.ts `seedSqlLiteral`), so each column must be
// a scalar / enum / id literal (or `now()`).  A non-literal column value
// throws at generate time; this rejects it at validation instead.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function rawSeedErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.seed-raw-non-literal-column")
    .map((d) => d.message);
}

const wrap = (seedBody: string) => `
  system S { subdomain M {
    context C {
      enum St { Draft, Done }
      aggregate Order with crudish {
        sku: string
        qty: int
        status: St
        createdAt: datetime
      }
      repository Orders for Order { }
      ${seedBody}
    }
  }}
`;

describe("raw-seed column gate (P4)", () => {
  it("rejects a raw-seed column whose value is a computed expression", async () => {
    const errs = await rawSeedErrors(
      wrap(`seed reference raw {
        Order { id: "o1", sku: "A", qty: 1 + 1, status: Draft }
      }`),
    );
    expect(errs.some((m) => /seed raw 'Order\.qty'/.test(m))).toBe(true);
  });

  it("admits scalar / enum / id literals and now() on a raw row", async () => {
    const errs = await rawSeedErrors(
      wrap(`seed reference raw {
        Order { id: "o1", sku: "A", qty: 2, status: Done, createdAt: now() }
      }`),
    );
    expect(errs).toEqual([]);
  });

  it("does not gate the domain seed path (non-raw)", async () => {
    const errs = await rawSeedErrors(
      wrap(`seed demo {
        Order { sku: "A", qty: 1, status: Draft, createdAt: now() }
      }`),
    );
    expect(errs).toEqual([]);
  });
});
