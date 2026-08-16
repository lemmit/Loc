// `persistence: dapper` FEATURE gate — query-time projections.
//
// HISTORY, because the assertions in this file INVERTED and the reason matters.
//
// `query-projection-emit.ts` used to have no dapper branch at all, so it emitted
// the EF shape unconditionally — `using Microsoft.EntityFrameworkCore;` and
// `private readonly AppDbContext _db;`, neither of which exists on this adapter.
// The result was not a silently-missing feature but a project that DOES NOT
// COMPILE (`CS0234` / `CS0246`), with nothing said at generate time.  #2498 made
// that honest with a BLANKET `loom.dapper-unsupported` over every query-time
// projection, and this file pinned the refusal.
//
// M-T6.25 paid the debt the refusal was standing in for: the four arms that read
// a table directly (whole-table aggregation, grouped, workflow-sourced,
// projection-sourced) are raw Npgsql now, and the per-row arm never touched EF —
// it reads through the aggregate's repository, which this adapter has always
// emitted.  So the blanket clause is gone and the cases below now assert the
// OPPOSITE: both shapes validate.
//
// What the file still pins is the discipline, unchanged: the gate keys on the
// ADAPTER, both directions, and the boundary that SURVIVED still fires.  That
// last one is the load-bearing case — narrowing a refusal is only honest if the
// narrowed form still refuses something, or "we fixed it" has quietly become
// "we deleted the check".

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** One system whose `platform:` clause is the only variable between the two
 *  legs — the adapter is the independent variable, the model is not. */
const SYS = (
  platformClause: string,
  body: string,
  aggHeader = "aggregate Order with crudish",
): string => `
system Shop {
  subdomain Orders {
    context Orders {
      ${aggHeader} {
        code: string
        total: money
      }
      repository Orders for Order { }
${body}
    }
  }
  api A from Orders
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platformClause}
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 3000
  }
}`;

async function diagsFor(platformClause: string, body: string, aggHeader?: string) {
  const { model } = await parseString(SYS(platformClause, body, aggHeader), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

/** The per-row query-time read model — `select` over a source, no fold.  Rides
 *  the aggregate's repository, so it was persistence-neutral all along; the
 *  blanket refusal took it down anyway. */
const PER_ROW_PROJECTION = `
      projection Board {
        rowId: Order id
        code: string
        from Order as o
        select rowId = o.id, code = o.code
      }`;

/** The SINGLETON whole-table aggregation — the shape `projection-aggregation`
 *  drives, and the one whose handler used to name `AppDbContext`.  Now one raw
 *  `SELECT count(*), sum(total) …`. */
const AGGREGATION_PROJECTION = `
      projection Totals {
        orders: int
        revenue: money
        from Order as o
        select orders = count(), revenue = sum(o.total)
      }`;

describe("`persistence: dapper` — query-time projections emit, and the narrow boundary still refuses", () => {
  for (const [name, body] of [
    ["per-row", PER_ROW_PROJECTION],
    ["whole-table aggregation", AGGREGATION_PROJECTION],
  ] as const) {
    it(`accepts a ${name} query-time projection on the dapper adapter (M-T6.25)`, async () => {
      const errors = (await diagsFor("dotnet { persistence: dapper }", body)).filter(
        (d) => d.severity === "error",
      );
      expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    });

    it(`emits the same ${name} projection cleanly on the default (EF Core) adapter`, async () => {
      const errors = (await diagsFor("dotnet", body)).filter((d) => d.severity === "error");
      expect(errors.map((d) => d.code)).toEqual([]);
    });
  }

  // THE SURVIVING BOUNDARY.  An aggregation names COLUMNS, and a `shape:
  // document` aggregate keeps its fields inside one jsonb blob — `sum(total)`
  // has no `total` to name.  EF Core hides the difference behind its own JSON
  // translation; raw SQL cannot, so this stays an honest refusal.  No corpus
  // fixture pairs the two shapes, which makes this the boundary's only witness.
  it("still refuses an aggregation whose source keeps its fields in a jsonb blob", async () => {
    const diags = await diagsFor(
      "dotnet { persistence: dapper }",
      AGGREGATION_PROJECTION,
      "aggregate Order shape: document, with crudish",
    );
    const gate = diags.filter(
      (d) => d.severity === "error" && d.code === "loom.dapper-unsupported",
    );
    expect(gate.length).toBeGreaterThan(0);
    // The message has to name what the author must change — the adapter, the
    // projection, and WHY this source cannot be aggregated in SQL.
    expect(gate[0]?.message).toContain("persistence: dapper");
    expect(gate[0]?.message).toContain("'Totals'");
    expect(gate[0]?.message).toContain(
      "'shape: document' aggregate 'Order', whose fields live inside one jsonb blob",
    );
    // …and the way out, since the same model generates on the default adapter.
    expect(gate[0]?.message).toContain("EF Core");
  });

  it("the per-row arm over that same document source is NOT refused", async () => {
    // The narrowing has to be arm-shaped, not source-shaped: a per-row read of a
    // document aggregate goes through the repository, which hydrates the blob
    // perfectly well.  Refusing it too would be the old blanket gate wearing a
    // narrower name.
    const errors = (
      await diagsFor(
        "dotnet { persistence: dapper }",
        PER_ROW_PROJECTION,
        "aggregate Order shape: document, with crudish",
      )
    ).filter((d) => d.severity === "error" && d.code === "loom.dapper-unsupported");
    expect(errors.map((d) => d.message)).toEqual([]);
  });

  it("leaves a projection-free dapper deployable alone", async () => {
    // The gate must key on the projection's presence, not on the adapter alone —
    // otherwise every dapper system starts failing.
    const errors = (await diagsFor("dotnet { persistence: dapper }", "")).filter(
      (d) => d.severity === "error",
    );
    expect(errors.map((d) => d.code)).toEqual([]);
  });
});
