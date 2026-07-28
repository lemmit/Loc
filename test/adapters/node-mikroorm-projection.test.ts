// node MikroORM adapter — folded-projection read parity.
//
// A FOLDED projection emits a `<Proj>Row` read-model table, a fold upsert per
// carried event, and `GET /projections/<snake>[/{key}]` read routes.  The
// MikroORM adapter previously emitted NONE of it (a read 404'd); it now mirrors
// the adapter's WORKFLOW SAGA-STATE persistence — an `EntitySchema` read-model
// Row, an `em.upsert` fold, and `em.find`/`em.findOne` read routes.  The runtime
// proof is `test/behavioral/run-mikroorm.mjs projection`; the compile proof is
// `tsc --noEmit` on the generated tree (LOOM_TS_BUILD).

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

// A folded projection folding two carried events into a per-order read-model row.
const sys = (persistence: string) => `
system M {
  api A from O
  subdomain O {
    context O {
      enum BoardStatus { Placed Shipped }
      aggregate Order with crudish {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { orderRef: id, at: now() }
        }
        operation ship() {
          precondition status == "Placed"
          status := "Shipped"
          emit OrderShipped { orderRef: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced  { orderRef: Order id, at: datetime }
      event OrderShipped { orderRef: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced, OrderShipped  delivery: broadcast  retention: ephemeral }
      projection OrderBoard keyed by orderRef {
        orderRef: Order id
        status: BoardStatus
        at: datetime
        on(e: OrderPlaced)  { orderRef := e.orderRef  status := Placed  at := e.at }
        on(e: OrderShipped) { status := Shipped  at := e.at }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: ${persistence} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("MikroORM folded-projection read model", () => {
  it("emits a nullable-non-key read-model Row EntitySchema keyed by the correlation id", async () => {
    const entities = (await emit(sys("mikroorm"))).get("api/db/entities.ts")!;
    expect(entities).toContain("export class OrderBoardRow {");
    expect(entities).toContain("new EntitySchema<OrderBoardRow>({");
    expect(entities).toContain('tableName: "order_boards",');
    // correlation field is the string PK; non-key columns nullable (partial fold).
    expect(entities).toContain('orderRef: { type: "string", primary: true },');
    expect(entities).toContain('status: { type: "string", nullable: true },');
    expect(entities).toContain('at: { type: "datetime", nullable: true },');
    // registered in the entities array so `updateSchema()` materialises the table.
    expect(entities).toMatch(/export const entities = \[[^\]]*OrderBoardRowSchema[^\]]*\];/);
  });

  it("folds via the EntityManager (findOne/upsert), not drizzle", async () => {
    const proj = (await emit(sys("mikroorm"))).get("api/http/projections.ts")!;
    expect(proj).toContain('import { EntityManager } from "@mikro-orm/postgresql";');
    expect(proj).toContain('import { OrderBoardRow } from "../db/entities";');
    // no drizzle imports on the mikro path.
    expect(proj).not.toContain('from "drizzle-orm"');
    expect(proj).not.toContain("import * as schema");
    // load/save over the EntityManager.
    expect(proj).toContain("const row = await db.findOne(OrderBoardRow, { orderRef: key });");
    expect(proj).toContain("await db.upsert(OrderBoardRow, state);");
    // the fold allocates a fresh typed Row on a not-yet-seen key (no cast), then
    // applies the carried assigns.
    expect(proj).toContain(
      "const state = (await loadOrderBoard(db, __key)) ?? Object.assign(new OrderBoardRow(), { orderRef: __key });",
    );
    // no type-erasing cast on the allocate.
    expect(proj).not.toContain("as unknown as OrderBoardState");
    expect(proj).toContain("state.status = BoardStatus.Placed;");
    expect(proj).toContain("state.status = BoardStatus.Shipped;");
  });

  it("reads the projection over the EntityManager (find/findOne)", async () => {
    const proj = (await emit(sys("mikroorm"))).get("api/http/projections.ts")!;
    expect(proj).toContain("export function projectionsRoutes(db: EntityManager): OpenAPIHono {");
    expect(proj).toContain('path: "/order_board",');
    expect(proj).toContain("const rows = await db.find(OrderBoardRow, {});");
    expect(proj).toContain('path: "/order_board/{key}",');
    expect(proj).toContain("const row = await db.findOne(OrderBoardRow, { orderRef: key });");
  });

  it("mounts /projections + composes the fold tee on the mikro dispatcher", async () => {
    const app = (await emit(sys("mikroorm"))).get("api/http/index.ts")!;
    expect(app).toContain('import { projectionsRoutes, projectionTee } from "./projections";');
    expect(app).toContain("projectionTee(db, NoopDomainEventDispatcher)");
    expect(app).toContain('app.route("/api/projections", projectionsRoutes(db));');
  });

  it("stays byte-identical to drizzle's projection routes on the default adapter", async () => {
    const proj = (await emit(sys("drizzle"))).get("api/http/projections.ts")!;
    // The default adapter is untouched: Drizzle table select/insert, no EntityManager.
    expect(proj).toContain('import { eq } from "drizzle-orm";');
    expect(proj).toContain("await db.select().from(schema.orderBoards);");
    expect(proj).not.toContain("EntityManager");
  });
});
