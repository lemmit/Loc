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
// ADAPTER, both directions — narrowing a refusal is only honest if what is left
// is actually adapter-shaped, or "we fixed it" has quietly become "we deleted
// the check".
//
// Applying that test to the narrowed form is what moved the last case out.  The
// boundary that survived #2498 — a direct-table arm over a source whose fields
// are not columns — was NOT adapter-shaped: EF Core miscompiles it identically
// (Loom maps a `shape: document` aggregate to a hand-rolled `<Agg>Document` row
// type, so `o.Total` is CS1061 there too).  It is `loom.projection-columnless-
// source` now, universal, and the case below pins that this adapter no longer
// claims it AND that EF Core is no escape from it.

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

describe("`persistence: dapper` — query-time projections emit; the column-less refusal is universal", () => {
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

  // WHERE THE SURVIVING BOUNDARY WENT.  The refusal that outlived the blanket
  // one — a direct-table arm over a source whose fields are not columns — was
  // kept here as an ADAPTER boundary on the premise that "EF Core hides the
  // difference behind its own JSON translation".  That premise was FALSE: Loom
  // maps a `shape: document` aggregate to a hand-rolled `<Agg>Document` row
  // type, so EF names the same missing column (`o.Total` → CS1061), and so does
  // every other backend.  The refusal is therefore universal now
  // (`loom.projection-columnless-source`, test/ir/projection-columnless-source
  // .test.ts), and this adapter raises nothing of its own for it.
  //
  // What stays pinned HERE is the adapter claim: the same model is refused with
  // the SAME code on dapper and on EF Core — because "switch adapters" was the
  // way out the old message offered, and it never worked.
  it("routes the column-less refusal through the universal gate, not this adapter", async () => {
    const codesFor = async (clause: string) =>
      (await diagsFor(clause, AGGREGATION_PROJECTION, "aggregate Order shape: document, with crudish"))
        .filter((d) => d.severity === "error")
        .map((d) => d.code);
    const onDapper = await codesFor("dotnet { persistence: dapper }");
    const onEfCore = await codesFor("dotnet");
    expect(onDapper).toContain("loom.projection-columnless-source");
    expect(onDapper).not.toContain("loom.dapper-unsupported");
    // The load-bearing half: EF Core is NOT an escape hatch from it.
    expect(onEfCore).toEqual(onDapper);
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
    ).filter((d) => d.severity === "error");
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
