// node MikroORM adapter — query-time projection reads (M-T6.23 slice 4).
//
// A QUERY-TIME projection (`from <Agg> … select …`, no `on(e)` folds) is the
// always-current read model: `http/query-projections.ts` mounts `GET
// /projections/<name>` per projection.  On the MikroORM adapter the file was
// never emitted (`emit.ts` gated it on `!usingMikro`), so every one of those
// routes 404'd — the R1 case from `integrity-audit-2026-07-residue.md`, and a
// `loom.mikroorm-unsupported` error until this slice.
//
// Four shapes, and each needs a different thing on this adapter:
//
//   whole-table aggregation   pushed down: `createQueryBuilder` + `raw()` SQL
//   grouped aggregation       same, plus GROUP BY / ORDER BY
//   raw-table source          `em.find(<Row>, <FilterQuery>)` — a WORKFLOW source
//                             reads its saga-state Row, a PROJECTION source the
//                             folded read-model Row
//   repository-sourced        NOTHING: `synthProjectionFinds` already synthesises
//                             the same `repo.<projName>()` find drizzle uses
//
// The raw-table arm was MISSING in the first version of this slice while the
// gate for it was already deleted — an owner review caught it: the shape fell
// through to the drizzle branch and emitted `db.select().from(schema.…)` into an
// EntityManager file with no `schema` import, i.e. generate-then-`tsc`-fail, the
// exact silent class M-T6.23 exists to kill.  No corpus fixture carries a
// workflow-/projection-sourced query projection, which is why the runtime leg
// stayed green.  It is ported and pinned below.
//
// Runtime proof: `node run-mikroorm.mjs projection-aggregation
// projection-groupby` (both booted against real Postgres); compile proof:
// `tsc --noEmit` on the generated trees.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function emit(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(src, { validation: true });
  const parseErrors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const irErrors = validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  expect([...parseErrors, ...irErrors], "validation errors").toEqual([]);
  return generateSystems(doc.parseResult.value as Model).files;
}

/** A whole-table (singleton) aggregation with a filter, a grouped aggregation
 *  with a computed `startOfDay` key, and a plain row-projection — the three
 *  shapes in one system, so one emit covers the whole surface. */
const sys = (persistence: string) => `
system M {
  api A from Sales
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order with crudish {
        code: string
        total: money
        lineCount: int
        placedAt: datetime
        status: OrderStatus
      }
      repository Orders for Order { }

      projection SalesTotals {
        orders: int
        revenue: money
        avgLines: decimal
        from Order as o
        where o.status == OrderStatus.Confirmed
        select orders = count, revenue = sum(o.total), avgLines = avg(o.lineCount)
      }

      projection SalesByDay {
        day: datetime
        orders: int
        revenue: money
        from Order as o
        group by o.placedAt.startOfDay()
        select day = o.placedAt.startOfDay(), orders = count, revenue = sum(o.total)
      }

      projection OpenOrders {
        code: string
        status: OrderStatus
        from Order as o
        where o.status == OrderStatus.Draft
        select code = o.code, status = o.status
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 8080
  }
}`;

/** A WORKFLOW-sourced query-time projection with a plain `select` — the
 *  raw-table arm (a PROJECTION source takes the identical path, reading the
 *  folded read-model Row instead of the saga-state one). */
const wfSourced = (persistence: string, filtered = true) => `
system M {
  api A from Sales
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { orderRef: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id, at: datetime }
      channel Live { carries: OrderPlaced  delivery: queue  retention: ephemeral }
      workflow Fulfillment {
        orderRef: Order id
        stage: string
        create(p: OrderPlaced) by p.orderRef {
          orderRef := p.orderRef
          stage := "Open"
        }
      }
      projection OpenFulfillments {
        ref: Order id
        stage: string
        from Fulfillment as f
${filtered ? '        where f.stage == "Open"' : ""}
        select ref = f.orderRef, stage = f.stage
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 8080
  }
}`;

describe("MikroORM query-time projections", () => {
  it("emits http/query-projections.ts over the EntityManager", async () => {
    const files = await emit(sys("mikroorm"));
    const qp = files.get("d/http/query-projections.ts");
    expect(qp, "http/query-projections.ts was not emitted on the mikroorm adapter").toBeDefined();
    const src = qp as string;
    expect(src).toContain('import { EntityManager } from "@mikro-orm/postgresql";');
    expect(src).toContain('import { raw } from "@mikro-orm/core";');
    expect(src).toContain('import { OrderRow } from "../db/entities";');
    expect(src).toContain("export function queryProjectionsRoutes(\n  db: EntityManager,");
    // No drizzle anywhere: no schema module, no drizzle operators.
    expect(src).not.toContain("drizzle");
    expect(src).not.toContain("../db/schema");
    // …and the router is mounted, so the routes are reachable.
    const app = files.get("d/http/index.ts") as string;
    expect(app).toContain('import { queryProjectionsRoutes } from "./query-projections";');
    expect(app).toContain('app.route("/api/projections", queryProjectionsRoutes(db, events));');
  });

  it("pushes a whole-table aggregation down to SQL, with the filter in the query", async () => {
    const src = (await emit(sys("mikroorm"))).get("d/http/query-projections.ts") as string;
    expect(src).toContain('const qb = db.createQueryBuilder(OrderRow, "src");');
    expect(src).toContain('raw("count(*) as \\"orders\\"")');
    expect(src).toContain('raw("sum(src.\\"total\\") as \\"revenue\\"")');
    // snake_cased column, matching MikroORM's underscored naming.
    expect(src).toContain('raw("avg(src.\\"line_count\\") as \\"avg_lines\\"")');
    // The `where` rides the SAME FilterQuery lowering every mikro find uses.
    expect(src).toContain('qb.where({ status: "Confirmed" });');
    // `mapResults: false` — the alias must come back verbatim.
    expect(src).toContain(
      'await qb.execute<{ orders: unknown; revenue: unknown; avg_lines: unknown }[]>("all", false);',
    );
    // One row out, coerced per declared wire type (numeric → string).
    expect(src).toContain("orders: Number(row?.orders ?? 0),");
    expect(src).toContain('revenue: String(row?.revenue ?? "0"),');
    expect(src).toContain("avgLines: Number(row?.avg_lines ?? 0),");
  });

  it("groups in SQL and repeats the computed key across SELECT/GROUP BY/ORDER BY", async () => {
    const src = (await emit(sys("mikroorm"))).get("d/http/query-projections.ts") as string;
    const trunc = "date_trunc('day', src.\\\"placed_at\\\")";
    // The SAME expression in all three positions — Postgres only accepts the
    // grouped select when they match — but as THREE separate `raw()` calls,
    // because a raw fragment is single-use per query.
    expect(src).toContain(`raw("${trunc} as \\"day\\"")`);
    expect(src).toContain(`qb.groupBy([raw("${trunc}")]);`);
    expect(src).toContain(`qb.orderBy([{ [raw("${trunc}")]: "asc" }]);`);
    // The key comes back as the wire STRING (no per-column decoder on a raw
    // QueryBuilder select), so it is DECODED, not cast.
    expect(src).toContain("day: new Date(r.day as string).toISOString(),");
    expect(src).not.toContain("(r.day as Date)");
  });

  it("leaves the repository-sourced shape adapter-neutral", async () => {
    // A row projection reads through the synthesised `repo.<projName>()` find,
    // which the mikro repository emits too — so this route body is identical on
    // both adapters, and the mikro repo really does declare the method.
    const mikro = await emit(sys("mikroorm"));
    const qp = mikro.get("d/http/query-projections.ts") as string;
    expect(qp).toContain("const repo = new OrderRepository(db, events);");
    expect(qp).toContain("const rows = await repo.openOrders();");
    const repo = mikro.get("d/db/repositories/order-repository.ts") as string;
    expect(repo).toContain("async openOrders(");
    expect(repo).toContain("EntityManager");
  });

  it("reads a WORKFLOW-sourced projection off its saga-state Row (the raw-table arm)", async () => {
    // The shape the review named, verbatim: a correlated (non-event-sourced)
    // workflow as the source, a plain `select`, no aggregate.  Neither mikro
    // aggregation branch matches it, so before the fix it fell through to
    // drizzle's `db.select().from(schema.…)`.
    const files = await emit(wfSourced("mikroorm"));
    const src = files.get("d/http/query-projections.ts") as string;
    // The Row entity, imported and read through the EntityManager.
    expect(src).toContain('import { FulfillmentRow } from "../db/entities";');
    expect(src).toContain('const rows = await db.find(FulfillmentRow, { stage: "Open" });');
    // The `where` rides the same FilterQuery lowering every mikro find uses.
    expect(src).not.toContain("db.select(");
    // The regression itself: no `schema` value/type import, and no reference to
    // one — that combination is what failed `tsc` with TS2304.
    expect(src).not.toContain("../db/schema");
    expect(src).not.toMatch(/\bschema\./);
    // The projection body is UNCHANGED from the drizzle arm — the entity's
    // property names are exactly what `select` reads off `r`.
    expect(src).toContain("ref: r.orderRef,");
    expect(src).toContain("stage: r.stage,");
  });

  it("passes an empty FilterQuery when the raw-table projection has no `where`", async () => {
    const src = (await emit(wfSourced("mikroorm", false))).get(
      "d/http/query-projections.ts",
    ) as string;
    expect(src).toContain("const rows = await db.find(FulfillmentRow, {});");
  });

  it("keeps the drizzle raw-table arm byte-identical", async () => {
    const src = (await emit(wfSourced("drizzle"))).get("d/http/query-projections.ts") as string;
    expect(src).toContain("await db.select().from(schema.fulfillments)");
    expect(src).toContain('import * as schema from "../db/schema";');
    expect(src).not.toContain("db.find(");
  });

  it("keeps the drizzle projection routes byte-identical", async () => {
    const src = (await emit(sys("drizzle"))).get("d/http/query-projections.ts") as string;
    expect(src).toContain("  db: NodePgDatabase<typeof schema>,");
    expect(src).toContain('import * as schema from "../db/schema";');
    expect(src).toContain("await db.select({");
    expect(src).not.toContain("EntityManager");
    expect(src).not.toContain("createQueryBuilder");
    // The drizzle key path keeps its `.mapWith(...)` decoder + the plain cast.
    expect(src).toContain(".mapWith(");
    expect(src).toContain("(r.day as Date)");
  });

  it("no longer refuses to generate (the honest gate it replaced)", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(sys("mikroorm"), { validation: true });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)));
    expect(
      diags.filter((d) => d.code === "loom.mikroorm-unsupported").map((d) => d.message),
    ).toEqual([]);
  });
});

describe("a projection filter outside the adapter's subset is refused, not dropped", () => {
  // The gate that makes the emitter's `whereToMikroFilter` call safe: an
  // aggregation whose `where` cannot lower would otherwise run UNFILTERED and
  // answer a plausible wrong number.  `validateFindPredicateAdapterSupport` now
  // walks query-time projection filters for every adapter — this pins the
  // mikroorm case (a `currentUser` principal reference, which that adapter's
  // find path cannot bind).
  const principalFiltered = (persistence: string) => `
system M {
  api A from Sales
  user { sub: string, tenant: string }
  auth { }
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        owner: string
        total: money
      }
      repository Orders for Order { }
      projection MyTotals {
        orders: int
        from Order as o
        where o.owner == currentUser.sub
        select orders = count
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [s]
    serves: A
    auth: required
    port: 8080
  }
}`;

  it("reports loom.find-predicate-unsupported naming the projection", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(principalFiltered("mikroorm"), {
      validation: true,
    });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(doc.parseResult.value as Model)))
      .filter((d) => d.code === "loom.find-predicate-unsupported")
      .map((d) => d.message);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((m) => m.includes("query-time projection 'MyTotals'"))).toBe(true);
  });

  it("stays clean on the drizzle adapter (the gate keys on the adapter)", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(principalFiltered("drizzle"), { validation: true });
    const codes = validateLoomModel(
      enrichLoomModel(lowerModel(doc.parseResult.value as Model)),
    ).map((d) => d.code);
    expect(codes).not.toContain("loom.find-predicate-unsupported");
  });
});
