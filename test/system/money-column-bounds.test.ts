// `money` is created as a BOUNDED `NUMERIC(19,4)` column, a plain `decimal` is
// not — the storage half of #2549.
//
// Every other layer already declared the bound: `money-scale.ts` documents it,
// the Drizzle schema emits `numeric(19,4)`, SQLAlchemy `Numeric(19, 4)`,
// MikroORM `columnType: "numeric(19,4)"`.  The DDL — the thing that actually
// CREATES the table — dropped it and emitted a bare `DECIMAL`, so the table and
// the ORM model reading it disagreed.  An unconstrained numeric keeps whatever
// scale it is handed, which is why the same money value could read back at a
// different scale depending on which backend wrote the row: node and python
// write at 4dp and so looked correct, elixir wrote `10.00` and a `sum` over it
// returned 2dp.
//
// Pinned at the MigrationsIR boundary and at both SQL renderers, because the
// bound has to survive all three: the derived column type, the Postgres DDL the
// SQL backends load, and the Ecto migration Phoenix runs.

import { describe, expect, it } from "vitest";
import { MONEY_PRECISION, MONEY_WIRE_SCALE } from "../../src/generator/money-scale.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

const SYSTEM = (platform: string) => `system MoneyCols {
  subdomain S { context C {
    aggregate Thing { price: money  ratio: decimal  n: int }
    repository Things for Thing { }
  } }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: ${platform} contexts: [C] dataSources: [st] serves: A port: 8080 }
}`;

/** The emitted file ending in `suffix` whose body mentions `needle` — several
 *  files share an extension (a project emits many `.exs`), so the extension
 *  alone would pick an arbitrary one and assert nothing. */
async function emitted(platform: string, suffix: string, needle: string): Promise<string> {
  const { model, errors } = await parseString(SYSTEM(platform));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  const hit = [...files.entries()].find(([k, v]) => k.endsWith(suffix) && v.includes(needle));
  if (!hit) throw new Error(`no generated ${suffix} containing ${needle}`);
  return hit[1];
}

describe("money is a bounded numeric column (#2549 storage half)", () => {
  it("Postgres DDL bounds money and leaves a plain decimal unconstrained", async () => {
    const sql = await emitted("node", ".sql", "CREATE TABLE");
    expect(sql).toContain(`"price" DECIMAL(${MONEY_PRECISION}, ${MONEY_WIRE_SCALE}) NOT NULL`);
    // The distinction is the point: a declared `decimal` carries no bound, so a
    // widened money rule can never silently constrain an unrelated column.
    expect(sql).toContain(`"ratio" DECIMAL NOT NULL`);
    expect(sql).not.toContain(`"ratio" DECIMAL(`);
  });

  it("the Ecto migration carries precision/scale as options, not in the atom", async () => {
    // `{:array, :decimal, precision: …}` would not parse, so the bound rides
    // `add`/`modify` options rather than the type atom itself.
    const exs = await emitted("elixir", ".exs", "CreateThings");
    expect(exs).toContain(
      `add :price, :decimal, precision: ${MONEY_PRECISION}, scale: ${MONEY_WIRE_SCALE}, null: false`,
    );
    expect(exs).toContain("add :ratio, :decimal, null: false");
  });
});
