// Lowering + validation coverage for the generalised `projection` query-time
// comprehension (read-path-architecture.md rev.13).  The front-half lands the
// surface + IR + validation gates; the per-backend emit is a follow-up, so a
// query-time / `join` projection lowers fully but is HONESTLY rejected by
// `loom.projection-query-time-unsupported` until a backend ports it.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  allContexts,
  type ExprIR,
  isMaterializedProjection,
  isQueryTimeProjection,
  isSingletonProjection,
} from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed Closed }
      event OrderPlaced { order: Order id }
      aggregate Customer { name: string  region: string }
      aggregate Order {
        status: OrderStatus  placedAt: datetime  customerId: Customer id  lineCount: int  total: money
        create place(customer: Customer id) {}
      }
      repository Orders for Order {}
      repository Customers for Customer {}
      criterion InRegion(region: string) of Order as o = o.region == region
      ${body}
    }
  }
}`;

async function lowerProjection(name: string, body: string) {
  const { model } = await parseString(wrap(body), { validate: false });
  const loom = lowerModel(model);
  const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
  return ctx.projections.find((p) => p.name === name)!;
}

async function projectionErrorCodes(body: string): Promise<string[]> {
  const { model } = await parseString(wrap(body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const QUERY_TIME = `
  projection OrdersInRegion(region: string) keyed by orderId {
    orderId: Order id  lineCount: int  customerName: string
    from Order as o
    where InRegion(region) && o.status == Confirmed
    join Customer as c on o.customerId
    select orderId = o.id, lineCount = o.lineCount, customerName = c.name
  }
`;

describe("projection comprehension — lowering", () => {
  it("lowers params, source + alias, joins, and selects", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(p.params.map((x) => x.name)).toEqual(["region"]);
    expect(p.correlationField).toBe("orderId");
    expect(p.query?.source).toBe("Order");
    expect(p.query?.sourceAlias).toBe("o");
    expect(p.query?.joins.map((j) => ({ agg: j.aggregate, alias: j.alias }))).toEqual([
      { agg: "Customer", alias: "c" },
    ]);
    expect(p.query?.selects?.map((s) => s.field)).toEqual(["orderId", "lineCount", "customerName"]);
  });

  it("derives a by-id auxiliary (path + mapVar) from the `join` clause", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(p.query?.auxiliaries).toEqual([
      { path: ["customerId"], aggName: "Customer", mapVar: "customerById" },
    ]);
  });

  it("resolves a join-alias read (`c.name`) to a member on an entity-typed local (no unknown ref)", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    const sel = p.query!.selects!.find((s) => s.field === "customerName")!.expr as ExprIR;
    expect(sel).toMatchObject({
      kind: "member",
      member: "name",
      receiver: { kind: "ref", name: "c", refKind: "let" },
      receiverType: { kind: "entity", name: "Customer" },
    });
  });

  it("reifies a named-criterion `where` (criterionRef), like a retrieval", async () => {
    const p = await lowerProjection(
      "ByRegion",
      `projection ByRegion(region: string) keyed by orderId {
        orderId: Order id
        from Order as o where InRegion(region)
        select orderId = o.id
      }`,
    );
    expect(p.query?.criterionRef?.name).toBe("InRegion");
  });

  it("derives materialized/singleton/query-time from clause presence (not stamped)", async () => {
    const qt = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(isQueryTimeProjection(qt)).toBe(true);
    expect(isMaterializedProjection(qt)).toBe(false);
    expect(isSingletonProjection(qt)).toBe(false);

    const singleton = await lowerProjection(
      "Dash",
      `projection Dash {
        openOrders: int
        from Order as o where o.status == Confirmed
        select openOrders = o.lineCount.count
      }`,
    );
    expect(isSingletonProjection(singleton)).toBe(true);

    const folded = await lowerProjection(
      "OrderBook",
      `projection OrderBook keyed by order {
        order: Order id  status: OrderStatus
        on(e: OrderPlaced) { order := e.order  status := Confirmed }
      }`,
    );
    expect(isMaterializedProjection(folded)).toBe(true);
    expect(isQueryTimeProjection(folded)).toBe(false);
    expect(folded.query).toBeUndefined();
  });
});

// A full system (with a deployable) so the backend-conditional gate + the Hono
// emit are exercised — the query-time projection reads aggregate `Order`.
const SYS = (platform = "node"): string => `
system S {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed Closed }
      aggregate Customer { name: string }
      aggregate Order { status: OrderStatus  customerId: Customer id  lineCount: int
        create place(customer: Customer id) {} }
      repository Orders for Order { }
      repository Customers for Customer { }
      criterion IsConfirmed of Order = status == Confirmed
      projection OrdersView keyed by orderId {
        orderId: Order id  lineCount: int  customerName: string
        from Order as o
        where IsConfirmed
        join Customer as c on o.customerId
        select orderId = o.id, lineCount = o.lineCount, customerName = c.name
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function sysErrorCodes(platform: string): Promise<string[]> {
  const { model } = await parseString(SYS(platform), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

describe("projection comprehension — validation gates", () => {
  it("HONESTLY gates a query-time projection on a backend that hasn't ported the emit", async () => {
    // node (PR-C) + python (PR-D) + elixir (PR-E) + java (PR-F) emit it; dotnet stays gated.
    for (const platform of ["node", "python", "elixir", "java"]) {
      expect(await sysErrorCodes(platform)).not.toContain("loom.projection-query-time-unsupported");
    }
    for (const platform of ["dotnet"]) {
      expect(await sysErrorCodes(platform)).toContain("loom.projection-query-time-unsupported");
    }
  });

  it("rejects a `from` source AND `on(e)` folds together (reserved combo)", async () => {
    const codes = await projectionErrorCodes(`
      projection Hybrid keyed by orderId {
        orderId: Order id  status: OrderStatus
        on(e: OrderPlaced) { orderId := e.order }
        from Order as o where o.status == Confirmed
        select orderId = o.id
      }
    `);
    expect(codes).toContain("loom.projection-query-and-fold-unsupported");
    // the specific reserved-combo gate fires INSTEAD of the generic honest gate
    expect(codes).not.toContain("loom.projection-query-time-unsupported");
  });

  it("leaves today's folded projection untouched (no comprehension diagnostics)", async () => {
    const codes = await projectionErrorCodes(`
      projection OrderBook keyed by order {
        order: Order id  status: OrderStatus
        on(e: OrderPlaced) { order := e.order  status := Confirmed }
      }
    `);
    expect(codes).not.toContain("loom.projection-query-time-unsupported");
    expect(codes).not.toContain("loom.projection-query-and-fold-unsupported");
  });
});

describe("projection comprehension — Hono emission", () => {
  it("emits a `/projections/<name>` route reading through the synthesised repo find + join map", async () => {
    const files = await generateSystemFiles(SYS("node"));
    const qp = [...files.entries()].find(([p]) => p.endsWith("http/query-projections.ts"))?.[1];
    expect(qp, "query-projections file emitted").toBeDefined();
    // Route + response schema.
    expect(qp).toContain(`path: "/orders_view"`);
    expect(qp).toContain(`const OrdersViewResponse = z.array(OrdersViewRow)`);
    // Sources rows via the synthesised repo find (repository-builder.ts).
    expect(qp).toContain("const rows = await repo.ordersView();");
    // `join Customer as c on o.customerId` → batched by-id load…
    expect(qp).toContain(
      "const customerById = new Map((await customerRepo.findManyByIds(rows.map((r) => r.customerId)))",
    );
    // …and the `select customerName = c.name` reads through the loaded map.
    expect(qp).toContain("customerName: customerById.get(r.customerId as string)!.name");
    // The synthesised find lands on the Order repository.
    const repo = [...files.entries()].find(([p]) => p.endsWith("order-repository.ts"))?.[1];
    expect(repo).toContain("async ordersView(): Promise<Order[]>");
  });

  it("emits the Python twin — synthesised find + join map + alias select", async () => {
    const files = await generateSystemFiles(SYS("python"));
    const qp = [...files.entries()].find(([p]) =>
      p.endsWith("http/query_projections_routes.py"),
    )?.[1];
    expect(qp, "python query-projections file emitted").toBeDefined();
    expect(qp).toContain('@router.get("/orders_view"');
    expect(qp).toContain("rows = await repo.orders_view()");
    expect(qp).toContain(
      "customer_by_id = {str(a.id): a for a in await customer_repo.find_many_by_ids([r.customer_id for r in rows])}",
    );
    expect(qp).toContain('"customerName": customer_by_id[str(r.customer_id)].name');
    const repo = [...files.entries()].find(([p]) => p.endsWith("order_repository.py"))?.[1];
    expect(repo).toContain("async def orders_view(self) -> list[Order]:");
  });

  it("emits the Elixir twin — live source find + join bulk-load map + alias select", async () => {
    const files = await generateSystemFiles(SYS("elixir"));
    const mod = [...files.entries()].find(([p]) =>
      p.endsWith("query_projections/orders_view.ex"),
    )?.[1];
    expect(mod, "elixir query-projection module emitted").toBeDefined();
    // Source find over the aggregate, with the `where IsConfirmed` predicate
    // inlined (enum → dumped declared string under the Ecto query context).
    expect(mod).toContain("from(record in D.Orders.Order,");
    expect(mod).toContain("|> Repo.all()");
    // `join Customer as c on o.customerId` → a batched id→struct map…
    expect(mod).toContain("customer_by_id =");
    expect(mod).toContain(
      "from(row in D.Orders.Customer, where: row.id in ^Enum.map(rows, fn record -> record.customer_id end))",
    );
    expect(mod).toContain("|> Map.new(&{&1.id, &1})");
    // …and the `select customerName = c.name` reads through the loaded map.
    expect(mod).toContain("customerName: Map.get(customer_by_id, record.customer_id).name");
    // `select orderId = o.id` / `lineCount = o.lineCount` render off `record`.
    expect(mod).toContain("orderId: record.id");
    expect(mod).toContain("lineCount: record.line_count");
    // A project-wide controller exposes `GET /api/projections/orders_view`.
    const ctrl = [...files.entries()].find(([p]) =>
      p.endsWith("controllers/query_projections_controller.ex"),
    )?.[1];
    expect(ctrl).toContain("def orders_view(conn, _params) do");
    expect(ctrl).toContain("D.Orders.QueryProjections.OrdersView.run(current_user)");
  });

  it("emits the Java twin — synthesised repo find + join bulk-load map + alias select", async () => {
    const files = await generateSystemFiles(SYS("java"));
    const svc = [...files.entries()].find(([p]) => p.endsWith("OrdersQueryProjections.java"))?.[1];
    expect(svc, "java query-projection service emitted").toBeDefined();
    // Source rows via the synthesised repo find (queryProjectionFindsFor).
    expect(svc).toContain("ordersRepository.ordersView().stream()");
    // `join Customer as c on o.customerId` → a bulk-load-by-id Map…
    expect(svc).toContain("var customerById = customersRepository.findAll().stream()");
    expect(svc).toContain(".collect(Collectors.toMap(__a -> __a.id().value(), __a -> __a));");
    // …and `select customerName = c.name` reads through the loaded map.
    expect(svc).toContain("customerById.get(a.customerId().value()).name()");
    // The synthesised find lands on the Order repository with the inlined `where`.
    const repo = [...files.entries()].find(([p]) => p.endsWith("OrderJpaRepository.java"))?.[1];
    expect(repo).toContain("List<Order> ordersView();");
    // Route under /projections; a query-time <Proj>Row record is emitted.
    const ctrl = [...files.entries()].find(([p]) =>
      p.endsWith("OrdersQueryProjectionsController.java"),
    )?.[1];
    expect(ctrl).toContain('@GetMapping("/orders_view")');
    expect([...files.keys()].some((p) => p.endsWith("OrdersViewRow.java"))).toBe(true);
  });
});
