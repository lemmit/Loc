// A direct-table query-time projection over a COLUMN-LESS source is refused on
// EVERY backend — `loom.projection-columnless-source`.
//
// WHAT WAS BROKEN.  The two direct-table arms — the whole-table aggregation
// (`select n = count(), revenue = sum(o.total)`) and the grouped one
// (`group by`) — push the aggregation into SQL, so they name COLUMNS on the
// source aggregate's own table.  Three source shapes have none of the columns
// they name, and every backend emitted the reference anyway:
//
//   source shape                 what generate produced
//   ---------------------------  ---------------------------------------------
//   `persistedAs: eventLog`      node `.from(schema.orders)` when the only table
//   (no state table at all)      is `orders_events`; dotnet `_db.Orders` when
//                                the only DbSet is `OrdersEvents`
//   `shape: document`            node `sum(schema.orders.total)` on a
//   (`(id, data, version)`)      `(id, data, version)` table (TS2339); dotnet
//                                `o.Total` on `DbSet<OrderDocument>` (CS1061);
//                                JPQL `sum(e.total)`; `OrderRow.total`;
//                                Ecto `record.total`
//   TPC abstract base            node `.from(schema.payments)` when the only
//   (no table of its own)        table is `card_payments`; dotnet `_db.Payments`
//                                when the only DbSet is `CardPayments`
//
// …with nothing said at generate time.  Only `persistence: dapper` refused it,
// as an ADAPTER boundary, on the premise that "EF Core hides that difference
// behind its own JSON translation".  That premise was false — Loom maps a
// document aggregate to a hand-rolled `<Agg>Document` row type, so EF names the
// same missing column — which is why the gate is universal here and not a
// per-backend gate SET: there is no backend that emits this correctly, so there
// is no membership to keep honest.
//
// WHAT MUST STILL PASS.  The gate is PRECISE about the document case, because a
// document table really does have an `id` column: `select n = count()` over a
// document source emits and runs on all five backends, and it is exactly the
// row-count tile `scaffoldDashboard` synthesises.  Over-gating it would break
// dashboards on every document-shaped aggregate.  The per-row arm over the same
// source is untouched too — it hydrates each row through the repository, so its
// fields never have to BE columns.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.projection-columnless-source";

/** Every backend platform clause a projection can be hosted on, including both
 *  .NET persistence adapters — the gate is universal, so the adapter axis has
 *  to be in the matrix rather than assumed. */
const PLATFORMS = [
  "node",
  "node { persistence: mikroorm }",
  "dotnet",
  "dotnet { persistence: dapper }",
  "java",
  "python",
  "elixir",
];

/** Relational source (the control), with a swappable aggregate header + query. */
const SYS = (platform: string, aggHeader: string, projection: string, extra = "") => `
system S {
  subdomain Sales {
    context Orders {
      ${aggHeader}
      repository Orders for Order { }
      ${projection}
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  ${extra}
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [s${extra ? ", es" : ""}], serves: A, port: 4000 }
}`;

const RELATIONAL_AGG = `aggregate Order { code: string  total: int }`;
const DOCUMENT_AGG = `aggregate Order shape: document, with crudish { code: string  total: int }`;
const EVENTLOG_AGG = `event OrderPlaced { total: int }
      aggregate Order persistedAs: eventLog {
        code: string
        total: int
        operation place(t: int) { emit OrderPlaced { total: t } }
        apply(e: OrderPlaced) { total := e.total }
      }`;
const EVENTLOG_STORE = `resource es { for: Orders, kind: eventLog, use: pg }`;

/** Whole-table aggregation naming a declared field. */
const SUM_PROJECTION = `projection OrderVolume {
        orders: int
        revenue: int
        from Order as o
        select orders = count(), revenue = sum(o.total)
      }`;

/** Whole-table aggregation naming NOTHING but rows — the dashboard tile. */
const COUNT_PROJECTION = `projection OrderVolume {
        orders: int
        from Order as o
        select orders = count()
      }`;

/** Grouped aggregation — the other direct-table arm. */
const GROUPED_PROJECTION = `projection ByCode {
        code: string
        orders: int
        from Order as o
        group by o.code
        select code = o.code, orders = count()
      }`;

/** The per-row arm over the same source — reads through the repository. */
const PER_ROW_PROJECTION = `projection OrderCodes {
        code: string
        from Order as o
        where o.total > 0
        select code = o.code
      }`;

async function codesFor(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

async function messagesFor(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === CODE)
    .map((d) => d.message);
}

describe("column-less direct-table projection source", () => {
  describe("is refused on every backend", () => {
    for (const platform of PLATFORMS) {
      it(`${platform} — aggregation over a 'shape: document' source`, async () => {
        expect(await codesFor(SYS(platform, DOCUMENT_AGG, SUM_PROJECTION))).toContain(CODE);
      });

      it(`${platform} — aggregation over an event-sourced source`, async () => {
        expect(
          await codesFor(SYS(platform, EVENTLOG_AGG, SUM_PROJECTION, EVENTLOG_STORE)),
        ).toContain(CODE);
      });

      it(`${platform} — GROUPED aggregation over a 'shape: document' source`, async () => {
        // The second direct-table arm.  `group by o.code` names a column too,
        // so a gate that only looked at the aggregate `select`s would let the
        // grouped arm through — the exact shape of the original miscompile.
        expect(await codesFor(SYS(platform, DOCUMENT_AGG, GROUPED_PROJECTION))).toContain(CODE);
      });
    }
  });

  describe("leaves alone what every backend genuinely emits", () => {
    for (const platform of PLATFORMS) {
      it(`${platform} — the relational control aggregates fine`, async () => {
        expect(await codesFor(SYS(platform, RELATIONAL_AGG, SUM_PROJECTION))).not.toContain(CODE);
      });

      it(`${platform} — 'select n = count()' over a document source (the dashboard tile)`, async () => {
        // A document table IS `(id, data, version)`, so a row count names a
        // real column.  `scaffoldDashboard` emits exactly this per aggregate;
        // refusing it would break dashboards on every document-shaped model.
        expect(await codesFor(SYS(platform, DOCUMENT_AGG, COUNT_PROJECTION))).not.toContain(CODE);
      });

      it(`${platform} — the PER-ROW arm over a document source`, async () => {
        // Arm-shaped, not source-shaped: the per-row read goes through the
        // aggregate's repository, which hydrates the blob perfectly well.
        expect(await codesFor(SYS(platform, DOCUMENT_AGG, PER_ROW_PROJECTION))).not.toContain(CODE);
      });
    }
  });

  it("refuses an aggregation over a TPC abstract base", async () => {
    // A TPC base has no table of its own — each concrete leaf is its own table
    // — so `FROM payments` names nothing.
    const src = `
system S {
  subdomain Sales {
    context Orders {
      abstract aggregate Payment inheritanceUsing: ownTable { amount: int }
      aggregate CardPayment extends Payment { last4: string }
      repository Payments for Payment { }
      projection PayVolume {
        n: int
        revenue: int
        from Payment as p
        select n = count(), revenue = sum(p.amount)
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node, contexts: [Orders], dataSources: [s], serves: A, port: 4000 }
}`;
    expect(await codesFor(src)).toContain(CODE);
  });

  it("names the offending column and the shape that lacks it", async () => {
    // The message has to say WHICH member has no column and WHY, or the author
    // cannot tell a document-shape problem from a typo.
    const [message] = await messagesFor(SYS("node", DOCUMENT_AGG, SUM_PROJECTION));
    expect(message).toContain("'Orders.OrderVolume'");
    expect(message).toContain("'total'");
    expect(message).toContain("'shape: document' aggregate 'Order'");
    // …and a way out that is a MODEL change, not "use the other adapter": the
    // gate is universal, so no sibling deployable escapes it.
    expect(message).toContain("materialized projection");
    expect(message).not.toContain("persistence:");
  });

  it("no longer routes the same refusal through the dapper adapter gate", async () => {
    // It used to be `loom.dapper-unsupported`, which told the author to switch
    // adapters — advice that could not work, since EF Core miscompiles it too.
    const codes = await codesFor(SYS("dotnet { persistence: dapper }", DOCUMENT_AGG, SUM_PROJECTION));
    expect(codes).toContain(CODE);
    expect(codes).not.toContain("loom.dapper-unsupported");
  });
});
