// G2667-C4 — the MikroORM `save` had no transaction.
//
// Every mikro save opened only `this.em.fork({ keepTransactionContext: true })`
// and then ran its statements one after another: the root upsert, then the
// full-list replace of each reference set, then the full child sync of each
// containment.  `keepTransactionContext` only JOINS an ambient transaction, and
// the generated server has no `RequestContext` middleware (see `mikroConfig`'s
// `allowGlobalContext` comment), so on an ordinary route there was nothing to
// join — a save that failed after the root write left the children stale, with
// no rollback.  The drizzle sibling has always wrapped the same statements in
// `this.db.transaction(...)` (`repository-save-builder.ts`).
//
// All THREE mikro save emitters shared the shape (relational, embedded,
// document/blob), so all three are pinned.  The relational case is the one that
// makes the bug visible: assoc + containment writes are extra statements.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

function sys(shape: string): string {
  return `
  system S {
    subdomain D { context C {
      aggregate Order ${shape} with crudish {
        total: int
        tags: Tag id[]
        contains lines: Line[]
        entity Line { sku: string  qty: int }
      }
      aggregate Tag with crudish { label: string }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api {
      platform: node { persistence: mikroorm }
      contexts: [C]
      dataSources: [cState]
      port: 3000
    }
  }`;
}

/** A DURABLE channel (`retention: work`) on the mikro adapter — the only shape
 *  in which the outbox tier is emitted at all. */
const DURABLE_CHANNEL_SYS = `
  system CS {
    subdomain Sales { context Orders {
      aggregate Order {
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: work }
    }}
    api OrdersApi from Sales
    storage pg { type: postgres }
    storage bus { type: rabbitmq }
    resource ordersState { for: Orders, kind: state, use: pg }
    channelSource lifecycleBus { for: Lifecycle, use: bus }
    deployable d {
      platform: node { persistence: mikroorm }
      contexts: [Orders]
      dataSources: [ordersState]
      channels: [lifecycleBus]
      serves: OrdersApi
      port: 4000
    }
  }`;

async function saveMethod(shape: string): Promise<string> {
  const files = await generateSystemFiles(sys(shape));
  const k = [...files.keys()].find((key) => key.endsWith("db/repositories/order-repository.ts"));
  expect(k, "order-repository.ts not emitted").toBeDefined();
  const file = files.get(k!)!;
  const start = file.indexOf("  async save(");
  expect(start, "save() not emitted").toBeGreaterThanOrEqual(0);
  const end = file.indexOf("\n  }\n", start);
  return file.slice(start, end);
}

describe.each([
  ["", "relational"],
  ["shape: embedded,", "embedded"],
  ["shape: document,", "document"],
])("mikroorm save runs in one transaction (%s → %s)", (shape) => {
  it("opens a real transaction around the write statements", async () => {
    const body = await saveMethod(shape);
    expect(body).toContain(
      "await this.em.fork({ keepTransactionContext: true }).transactional(async (em) => {",
    );
    // The bare fork-without-transaction form is the defect itself.
    expect(body).not.toContain("const em = this.em.fork({ keepTransactionContext: true });");
  });

  it("the version CAS read is INSIDE the transaction, not before it", async () => {
    const body = await saveMethod(shape);
    // A read-then-write guard outside a transaction is a race by construction.
    const tx = body.indexOf(".transactional(");
    const read = body.indexOf("await em.findOne(");
    expect(read, "the CAS findOne is emitted").toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(tx);
  });

  it("event dispatch stays OUTSIDE the transaction (after commit)", async () => {
    const body = await saveMethod(shape);
    // Dispatching inside would fan handlers out on uncommitted state — the
    // drizzle sibling dispatches after the tx closes for the same reason.
    // (The relational shape now DRAINS `pullEvents()` before the tx so the
    // durable ones can be recorded on its handle, so the loop — not the drain —
    // is what has to sit after the close.)
    const dispatch = body.indexOf("await this.events.dispatch(event);");
    expect(dispatch, "the dispatch loop is emitted").toBeGreaterThanOrEqual(0);
    expect(body.indexOf("\n    });")).toBeLessThan(dispatch);
  });
});

// The atomicity question #2667 register item 5 left open, answered the way the
// drizzle sibling already answers it.  `createOutboxDispatcher`'s `dispatch`
// arm inserts the outbox row on `em.fork({ keepTransactionContext: true })`,
// which only JOINS an ambient transaction — and an ordinary mutation route
// opens none (only the audited / provenanced routes do).  So with the save's
// own transaction closed before the dispatch loop ran, the outbox row committed
// SEPARATELY: a crash in that window left the aggregate written and the durable
// event owed to nobody.  Drizzle has always captured it on the save
// transaction's handle via `recordDurable(pendingEvents, tx)`.
describe("mikroorm relational save — the durable outbox row commits WITH the state", () => {
  it("drains the events before the tx and records the durable ones on its handle", async () => {
    const body = await saveMethod("");
    const drain = body.indexOf("const pendingEvents = aggregate.pullEvents();");
    const tx = body.indexOf(".transactional(");
    const record = body.indexOf("this.events.recordDurable?.(pendingEvents, em)");
    const close = body.indexOf("\n    });", tx);
    expect(drain, "the pre-tx drain is emitted").toBeGreaterThanOrEqual(0);
    expect(record, "recordDurable is called").toBeGreaterThanOrEqual(0);
    // drain → open tx → record → close tx.  `em` is the transactional
    // callback's own EntityManager, so the insert is in that transaction.
    expect(drain).toBeLessThan(tx);
    expect(record).toBeGreaterThan(tx);
    expect(record).toBeLessThan(close);
  });

  it("dispatches only what recordDurable hands back, after the commit", async () => {
    const body = await saveMethod("");
    // A dispatcher with no durable channel has no hook, so `?? pendingEvents`
    // keeps every event on the after-commit path — behaviour unchanged there.
    expect(body).toContain("let dispatchAfterCommit = pendingEvents;");
    expect(body).toContain(
      "dispatchAfterCommit = (await this.events.recordDurable?.(pendingEvents, em)) ?? pendingEvents;",
    );
    expect(body).toContain("for (const event of dispatchAfterCommit) {");
    // …and the loop must not re-drain, which would dispatch nothing at all.
    const loop = body.slice(body.indexOf("for (const event of dispatchAfterCommit)"));
    expect(loop).not.toContain("pullEvents()");
  });

  it("the mikro outbox dispatcher exposes the transactional capture hook", async () => {
    const files = await generateSystemFiles(DURABLE_CHANNEL_SYS);
    const k = [...files.keys()].find((key) => key.endsWith("http/workflows.ts"));
    expect(k, "workflows.ts not emitted").toBeDefined();
    const wf = files.get(k!)!;
    // The mikro half of the tier had ONLY the `dispatch` arm, so the repository's
    // optional-chained call resolved to undefined and every durable event fell
    // through to the after-commit path — where `dispatch` inserted the row on a
    // fork with no ambient transaction to keep.
    expect(wf).toContain("async recordDurable(events: readonly Events.DomainEvent[], tx: unknown)");
    expect(wf).toContain("const txEm = tx as EntityManager;");
    expect(wf).toContain("await txEm.insert(LoomOutboxRow, {");
    // The non-durable events come back for in-process delivery, exactly as on
    // drizzle — the hook is a capture, not a swallow.
    expect(wf).toContain("return events.filter((e) => !DURABLE_EVENT_TYPES.has(e.type));");
  });
});

describe("mikroorm relational save — the multi-statement case the row names", () => {
  it("the assoc replace and the containment sync are in the same transaction", async () => {
    const body = await saveMethod("");
    const tx = body.indexOf(".transactional(");
    const close = body.indexOf("\n    });", tx);
    const inside = body.slice(tx, close);
    // Full-list replace of the `tags` reference set…
    expect(inside).toContain("await em.nativeDelete(OrderTagsRow,");
    expect(inside).toContain("await em.insert(OrderTagsRow,");
    // …and the full child sync of the `lines` containment.
    expect(inside).toContain("await em.nativeDelete(LineRow,");
    expect(inside).toContain("await em.upsert(LineRow,");
  });
});
