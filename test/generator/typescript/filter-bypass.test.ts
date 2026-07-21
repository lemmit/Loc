// node/Drizzle emission of the `ignoring` filter-bypass clause
// (named-filter-bypass.md §11, Slice 2).  Drizzle has no global query filter,
// so a capability `filter` is AND-ed into every root read as an explicit
// `and(...)` conjunct.  An `ignoring <Cap>` read OMITS that capability's
// conjunct from its own `.where(...)`; `ignoring *` drops EVERY capability
// conjunct.  A non-bypassing read keeps the full conjunction, and a
// hand-written (bare) `filter` is never bypassable.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      aggregate Order with softDeletable { total: int }
      repository OrderRepo for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: node  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

let cache: Map<string, string> | undefined;
async function repo(): Promise<string> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  const k = [...cache.keys()].find((key) => key.endsWith("db/repositories/order-repository.ts"));
  expect(k, "order-repository.ts not emitted").toBeDefined();
  return cache.get(k!)!;
}

function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  expect(start, `method ${name} not found`).toBeGreaterThanOrEqual(0);
  // Body runs to the next `async ` declaration (or end of file).
  const next = src.indexOf("\n  async ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** The root-read `.where(...)` clause of a method's first `from(schema...)`
 *  select — where the capability conjunct lives (NOT the hydrate, which
 *  references `<field>: root.<field>` for the wire shape regardless). */
function whereClause(src: string, name: string): string {
  const body = methodBody(src, name);
  const m = body.match(/\.where\(([\s\S]*?)\);/);
  return m ? m[1]! : "";
}

describe("node/Drizzle ignoring filter-bypass emission", () => {
  it("`ignoring <Cap>` drops the bypassed conjunct from THAT find only", async () => {
    const r = await repo();
    const w = whereClause(r, "recent");
    // The total predicate stays; the isDeleted conjunct is gone.
    expect(w).toBe("gt(schema.orders.total, 0)");
    expect(w).not.toContain("isDeleted");
  });

  it("`ignoring *` drops ALL capability conjuncts (no where clause at all)", async () => {
    const r = await repo();
    const allRows = methodBody(r, "allRows");
    expect(allRows).not.toContain(".where(");
    // The root select has no filter — bare `from(schema.orders)`.
    expect(allRows).toContain("this.db.select().from(schema.orders);");
  });

  it("a non-bypassing find keeps the full capability conjunction", async () => {
    const r = await repo();
    expect(whereClause(r, "normal")).toBe(
      "and(gt(schema.orders.total, 0), eq(schema.orders.isDeleted, false))",
    );
  });

  it("CRUD reads (findById / findManyByIds) keep the capability filter", async () => {
    const r = await repo();
    expect(whereClause(r, "findById")).toContain("eq(schema.orders.isDeleted, false)");
    expect(whereClause(r, "findManyByIds")).toContain("eq(schema.orders.isDeleted, false)");
  });
});

// A query-time projection's `ignoring` rides the synthesised source find, so the
// emitted `repo.<projName>()` read drops the bypassed conjunct exactly like a
// hand-written `find … ignoring`.
const PROJ_SRC = `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      aggregate Order with softDeletable { status: string }
      repository OrderRepo for Order { }
      projection AllOrders { status: string  from Order as o ignoring softDeletable select status = o.status }
      projection LiveOrders { status: string  from Order as o where o.status == "open" select status = o.status }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: node  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

describe("node/Drizzle projection `ignoring` emission", () => {
  let pcache: Map<string, string> | undefined;
  async function projRepo(): Promise<string> {
    pcache ??= (await generateSystems(await parseValid(PROJ_SRC))).files;
    const k = [...pcache.keys()].find((key) => key.endsWith("db/repositories/order-repository.ts"));
    expect(k, "order-repository.ts not emitted").toBeDefined();
    return pcache.get(k!)!;
  }

  it("`ignoring <Cap>` drops the source-read filter for the projection find", async () => {
    const r = await projRepo();
    const allOrders = methodBody(r, "allOrders");
    expect(allOrders).not.toContain(".where(");
    expect(allOrders).toContain("this.db.select().from(schema.orders);");
  });

  it("a projection with no `ignoring` keeps the capability filter", async () => {
    const r = await projRepo();
    expect(whereClause(r, "liveOrders")).toContain("eq(schema.orders.isDeleted, false)");
  });
});
