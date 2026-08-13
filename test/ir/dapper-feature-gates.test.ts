// `persistence: dapper` FEATURE gate — query-time projections.
//
// The Dapper adapter reached full parity with EF Core on the PERSISTENCE axis
// (M-T6.9), and its remaining `loom.dapper-unsupported` clauses reject genuinely
// unmappable SHAPES.  Query-time projections are a different kind of gap and a
// worse one: `src/generator/dotnet/query-projection-emit.ts` has no dapper
// branch at all, so it emits the EF shape unconditionally — `using
// Microsoft.EntityFrameworkCore;` and `private readonly AppDbContext _db;`,
// neither of which exists on this adapter.
//
// The result was not a silently-missing feature (the MikroORM shape) but a
// project that DOES NOT COMPILE: `CS0234: the namespace 'EntityFrameworkCore'
// does not exist` / `CS0246: 'AppDbContext' could not be found`, with nothing
// said at generate time.  The author gets a C# build error naming a type they
// never wrote, one layer away from anything they can act on.
//
// Found when `projection-aggregation` / `projection-groupby` got their first
// runtime callers (#2468): the dapper behavioral leg failed to BOOT, and the
// compile tiers had never covered the combination because no corpus fixture
// forces `persistence: dapper` onto a projection-bearing context.
//
// Pins BOTH directions, like the MikroORM gate beside it: dapper is rejected
// with an honest diagnostic, and the SAME model on the default EF Core adapter
// stays clean — so the gate keys on the ADAPTER, not on the feature.  Deleting
// the clause is how the gap closes for real; Dapper is raw SQL and a query-time
// projection IS a SQL aggregate, so that port is a smaller job than the gate's
// existence suggests.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** One system whose `platform:` clause is the only variable between the two
 *  legs — the adapter is the independent variable, the model is not. */
const SYS = (platformClause: string, body: string): string => `
system Shop {
  subdomain Orders {
    context Orders {
      aggregate Order with crudish {
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

async function diagsFor(platformClause: string, body: string) {
  const { model } = await parseString(SYS(platformClause, body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

/** The per-row query-time read model — `select` over a source, no fold. */
const PER_ROW_PROJECTION = `
      projection Board {
        rowId: Order id
        code: string
        from Order as o
        select rowId = o.id, code = o.code
      }`;

/** The SINGLETON whole-table aggregation — the shape `projection-aggregation`
 *  drives, and the one whose emitted handler names `AppDbContext`. */
const AGGREGATION_PROJECTION = `
      projection Totals {
        orders: int
        revenue: money
        from Order as o
        select orders = count(), revenue = sum(o.total)
      }`;

describe("`persistence: dapper` — query-time projections are gated, not mis-emitted", () => {
  for (const [name, body] of [
    ["per-row", PER_ROW_PROJECTION],
    ["whole-table aggregation", AGGREGATION_PROJECTION],
  ] as const) {
    it(`rejects a ${name} query-time projection on the dapper adapter`, async () => {
      const diags = await diagsFor("dotnet { persistence: dapper }", body);
      const gate = diags.filter(
        (d) => d.severity === "error" && d.code === "loom.dapper-unsupported",
      );
      expect(gate.length).toBeGreaterThan(0);
      // The message has to name what the author must change — the adapter and
      // the projection — not just that something is unsupported.
      expect(gate[0]?.message).toContain("persistence: dapper");
      expect(gate[0]?.message).toMatch(/'(Board|Totals)'/);
      // …and the way out, since the same model generates on the default adapter.
      expect(gate[0]?.message).toContain("EF Core");
    });

    it(`emits the same ${name} projection cleanly on the default (EF Core) adapter`, async () => {
      const errors = (await diagsFor("dotnet", body)).filter((d) => d.severity === "error");
      expect(errors.map((d) => d.code)).toEqual([]);
    });
  }

  it("leaves a projection-free dapper deployable alone", async () => {
    // The gate must key on the projection's presence, not on the adapter alone —
    // otherwise every dapper system starts failing.
    const errors = (await diagsFor("dotnet { persistence: dapper }", "")).filter(
      (d) => d.severity === "error",
    );
    expect(errors.map((d) => d.code)).toEqual([]);
  });
});
