// node MikroORM adapter — transactional outbox + relay parity (M-T6.23 slice 1).
//
// A durable channel (`retention: log | work`) with a local reactor makes the
// delivery contract at-least-once: the app's dispatcher records the event in
// `__loom_outbox` instead of fanning it out inline, and a boot-started relay
// drains undispatched rows through the in-process dispatcher, threading the row
// id onto the event so the saga's idempotent-consumer marker can no-op on
// redelivery (dispatch-delivery-semantics.md).
//
// The MikroORM adapter emitted NONE of that — no outbox table, no dispatcher
// wrap, no relay — so the same model silently degraded to the at-most-once
// in-process path.  That was a `loom.mikroorm-unsupported` error (the honest
// interim); this suite is the emitter that replaced it.  Runtime proof:
// `test/behavioral/run-mikroorm.mjs outbox`; compile proof: `tsc --noEmit` on
// the generated tree (LOOM_TS_BUILD).

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

/** A durable (`delivery: queue` / `retention: log`) channel WITH a local reactor
 *  — the shape that turns the outbox tier on. */
const sys = (persistence: string) => `
system M {
  api A from O
  subdomain O {
    context O {
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
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: log }
      workflow OrderFulfillment {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.orderRef {
          orderId := p.orderRef
        }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: ${persistence} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("MikroORM transactional outbox", () => {
  it("emits the __loom_outbox Row EntitySchema and registers it for updateSchema()", async () => {
    const entities = (await emit(sys("mikroorm"))).get("api/db/entities.ts")!;
    expect(entities).toContain("export class LoomOutboxRow {");
    expect(entities).toContain("new EntitySchema<LoomOutboxRow>({");
    expect(entities).toContain('tableName: "__loom_outbox",');
    expect(entities).toContain('id: { type: "string", primary: true },');
    expect(entities).toContain('occurredAt: { type: "Date", columnType: "timestamptz" },');
    expect(entities).toContain('payload: { type: "json", columnType: "jsonb" },');
    // NULL dispatchedAt is the undispatched marker the drain filters on.
    expect(entities).toContain(
      'dispatchedAt: { type: "Date", columnType: "timestamptz", nullable: true },',
    );
    expect(entities).toContain('attempts: { type: "number" },');
    expect(entities).toMatch(/export const entities = \[[^\]]*LoomOutboxRowSchema[^\]]*\];/);
  });

  it("gives the saga Row the idempotent-consumer marker column", async () => {
    // Without `lastEventId` the reactor preamble's redelivery no-op has no
    // column to read and the emitted handler would not type-check.
    const entities = (await emit(sys("mikroorm"))).get("api/db/entities.ts")!;
    expect(entities).toContain("export class OrderFulfillmentRow {");
    expect(entities).toContain('lastEventId: { type: "string", nullable: true },');
    // …and a freshly allocated instance spells the null out, since the mikro
    // state type is the Row CLASS (a required, if nullable, property).
    const wf = (await emit(sys("mikroorm"))).get("api/http/workflows.ts")!;
    expect(wf).toContain(
      "const state = (await loadOrderFulfillment(db, __key)) ?? { orderId: __key, attempts: 0, lastEventId: null };",
    );
    expect(wf).toContain("if (__eventId !== undefined && state.lastEventId === __eventId) {");
  });

  it("captures durable events on the EntityManager, not drizzle", async () => {
    const wf = (await emit(sys("mikroorm"))).get("api/http/workflows.ts")!;
    expect(wf).toContain('import { EntityManager } from "@mikro-orm/postgresql";');
    expect(wf).toContain('import { randomUUID } from "node:crypto";');
    expect(wf).toMatch(/import \{[^}]*LoomOutboxRow[^}]*\} from "\.\.\/db\/entities";/);
    expect(wf).not.toContain('from "drizzle-orm"');
    expect(wf).toContain(
      'export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced"]);',
    );
    expect(wf).toContain("export function createOutboxDispatcher(\n  db: EntityManager,");
    // The capture forks KEEPING the ambient transaction context, so the row
    // commits with the aggregate save when the route opened one.
    expect(wf).toContain("await db.fork({ keepTransactionContext: true }).insert(LoomOutboxRow, {");
    expect(wf).toContain("id: randomUUID(),");
    expect(wf).toContain("dispatchedAt: null,");
    expect(wf).toContain("attempts: 0,");
    expect(wf).toContain("return; // the relay delivers");
  });

  it("drains undispatched rows oldest-first and threads the row id onto redelivery", async () => {
    const wf = (await emit(sys("mikroorm"))).get("api/http/workflows.ts")!;
    expect(wf).toContain("export function startOutboxRelay(\n  db: EntityManager,");
    // A FRESH fork per drain — the relay outlives every request.
    expect(wf).toContain("const em = db.fork();");
    expect(wf).toContain("{ dispatchedAt: null, attempts: { $lt: maxAttempts } },");
    expect(wf).toContain('{ orderBy: { occurredAt: "asc" }, limit: batchSize },');
    expect(wf).toContain("__loomEventId: row.id");
    expect(wf).toContain(
      "await em.nativeUpdate(LoomOutboxRow, { id: row.id }, { dispatchedAt: new Date() });",
    );
    // Failure path: bump the attempt counter, dead-letter once at the ceiling.
    expect(wf).toContain("await em.nativeUpdate(LoomOutboxRow, { id: row.id }, { attempts });");
    expect(wf).toContain('event: "event_dead_lettered"');
  });

  it("wraps createApp's dispatcher and starts the relay at boot", async () => {
    const files = await emit(sys("mikroorm"));
    const app = files.get("api/http/index.ts")!;
    expect(app).toContain(
      'import { createInProcessDispatcher, createOutboxDispatcher, workflowsRoutes } from "./workflows";',
    );
    expect(app).toContain("createOutboxDispatcher(db, createInProcessDispatcher(db))");
    const index = files.get("api/index.ts")!;
    expect(index).toContain(
      'import { createInProcessDispatcher, createOutboxDispatcher, startOutboxRelay } from "./http/workflows";',
    );
    expect(index).toContain(
      "const app = createApp(db, createOutboxDispatcher(db, inProcessEvents));",
    );
    expect(index).toContain("const stopOutboxRelay = startOutboxRelay(db, inProcessEvents);");
    expect(index).toContain("stopOutboxRelay();");
    // …still on the mikro connection, not a pg pool.
    expect(index).toContain("const db = orm.em;");
    expect(index).not.toContain('import * as schema from "./db/schema";');
  });

  it("leaves the drizzle adapter's outbox byte-identical", async () => {
    const files = await emit(sys("drizzle"));
    const wf = files.get("api/http/workflows.ts")!;
    expect(wf).toContain("db: NodePgDatabase<typeof schema>,");
    expect(wf).toContain("await db.insert(schema.loomOutbox).values({ type: event.type,");
    expect(wf).not.toContain("EntityManager");
    expect(wf).not.toContain("LoomOutboxRow");
    // The nullable marker column is optional in drizzle's $inferInsert, so the
    // allocate literal omits it (the mikro Row class cannot).
    expect(wf).toContain(
      "const state = (await loadOrderFulfillment(db, __key)) ?? { orderId: __key, attempts: 0 };",
    );
  });

  it("no longer refuses to generate (the honest gate it replaced)", async () => {
    // `validateMikroOrmSupport`'s durable-channel clause is deleted, so this
    // model — which used to be a hard `loom.mikroorm-unsupported` error — now
    // emits.  `emit()` already asserts zero IR errors; assert the code is gone
    // from the diagnostics entirely so a re-added gate fails here.
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(sys("mikroorm"), { validation: true });
    const codes = validateLoomModel(
      enrichLoomModel(lowerModel(doc.parseResult.value as Model)),
    ).map((d) => d.code);
    expect(codes).not.toContain("loom.mikroorm-unsupported");
  });
});
