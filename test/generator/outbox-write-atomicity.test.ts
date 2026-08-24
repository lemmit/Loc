// ---------------------------------------------------------------------------
// The transactional outbox has to be TRANSACTIONAL — the write-side atomicity
// gate (docs/channels.md:134; docs/old/proposals/dispatch-delivery-semantics.md
// §1: "Add an outbox table written in the SAME transaction as the aggregate
// save, so commit atomically records 'this event is owed'").
//
// WHY THIS EXISTS.  Three backends shipped the outbox row in a SECOND
// transaction — node closed `db.transaction` and then dispatched on the pool,
// .NET committed `SaveChangesAsync` and then added + saved again, elixir's
// emitted comment claimed the insert "joins the caller's Repo.transaction"
// while the caller had none.  A crash between the two commits silently loses a
// durable event: exactly the window the outbox exists to close, and invisible
// to every runtime gate because the relay drains fine on the happy path
// (generator-code-review-2026-08-17 finding A3).
//
// These are STRUCTURAL, string-level assertions on the emitted save path —
// the repo's idiom, and the only tier that can see "the insert is inside the
// transaction construct" without staging a mid-save crash.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

/** A durable (`retention: log`) channel + an aggregate whose operation emits
 *  one of its carried events — the minimal shape that puts an outbox INSERT on
 *  the save path.  `__PLATFORM__` is swapped per backend. */
const DURABLE = (platform: string) => `system OS {
  subdomain D {
    context Shop {
      aggregate Order {
        code: string
        placed: bool
        operation place() {
          placed := true
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: queue
        retention: log
      }
      workflow Track {
        orderId: Order id
        create(p: OrderPlaced) by p.order { orderId := p.order }
      }
    }
  }
  api A from D
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable d {
    platform: ${platform}
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

/** The same durable channel, BROKER-bound (`channelSource`) — the wiring that
 *  puts a publish tee in front of the outbox dispatcher, so the tee is where a
 *  dropped `recordDurable` would silently demote the durable path. */
const BROKER = (platform: string) => `system BS {
  subdomain D {
    context Shop {
      aggregate Order {
        code: string
        placed: bool
        operation place() {
          placed := true
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: queue
        retention: work
      }
    }
  }
  api A from D
  storage db { type: postgres }
  storage bus { type: rabbitmq }
  resource st { for: Shop, kind: state, use: db }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable d {
    platform: ${platform}
    contexts: [Shop]
    dataSources: [st]
    channels: [lifecycleBus]
    serves: A
    port: 4000
  }
}`;

async function emit(platform: string): Promise<Map<string, string>> {
  return await generateSystemFiles(DURABLE(platform));
}

async function emitBroker(platform: string): Promise<Map<string, string>> {
  return await generateSystemFiles(BROKER(platform));
}

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

/** The body of a method, from its signature to the next same-column `}` / `end`. */
const from = (src: string, marker: string): string => {
  const i = src.indexOf(marker);
  expect(i, `marker '${marker}' not found`).toBeGreaterThan(-1);
  return src.slice(i);
};

// ── node / Hono (drizzle) ───────────────────────────────────────────────────

describe("outbox write atomicity — node/Hono (drizzle)", () => {
  it("the save transaction itself records the durable events, on its own `tx` handle", async () => {
    const files = await emit("node");
    const repo = fileEndingWith(files, "db/repositories/order-repository.ts");
    const save = from(repo, "async save(aggregate: Order");

    const txOpen = save.indexOf("await this.db.transaction(async (tx) => {");
    const record = save.indexOf("this.events.recordDurable?.(pendingEvents, tx)");
    const txClose = save.indexOf("    });");
    expect(txOpen, "save opens a drizzle transaction").toBeGreaterThan(-1);
    // THE PROPERTY: the outbox capture sits strictly BETWEEN the transaction
    // callback's open and its close — i.e. inside it, holding the `tx` handle.
    expect(record, "durable capture is emitted").toBeGreaterThan(txOpen);
    expect(record, "durable capture is INSIDE the transaction callback").toBeLessThan(txClose);

    // ...and the post-commit fan-out only sees what the capture handed back,
    // so a durable event is not ALSO dispatched inline.
    expect(save).toContain("for (const event of dispatchAfterCommit) {");
    expect(save).not.toContain("for (const event of aggregate.pullEvents()) {");
  });

  it("the outbox dispatcher writes the row on the transaction handle it is given", async () => {
    const files = await emit("node");
    const wf = fileEndingWith(files, "http/workflows.ts");
    const record = from(wf, "async recordDurable(");
    expect(record).toContain("const txDb = tx as NodePgDatabase<typeof schema>;");
    expect(record).toContain("await txDb.insert(schema.loomOutbox).values(");
    // The inline `dispatch` arm (relay re-entry, timer emits — no enclosing
    // write tx) stays on the pool handle; that is the fallback, not the save path.
    expect(wf).toContain("await db.insert(schema.loomOutbox).values({ type: event.type");
  });

  it("the channel publish tee forwards the capture instead of swallowing it", async () => {
    // Without the forward, a channels-wired deployable's repository sees a
    // dispatcher with no `recordDurable` and silently falls back to the
    // second-transaction path.
    const files = await emitBroker("node");
    const ch = fileEndingWith(files, "http/channels.ts");
    expect(ch).toContain("recordDurable: inner.recordDurable?.bind(inner),");
  });
});

// ── .NET (EF Core) ──────────────────────────────────────────────────────────

describe("outbox write atomicity — .NET (EF Core)", () => {
  it("stages the outbox rows BEFORE the single SaveChangesAsync", async () => {
    const files = await emit("dotnet");
    const repo = fileEndingWith(files, "Infrastructure/Repositories/OrderRepository.cs");
    const save = from(repo, "public async Task SaveAsync(Order aggregate");

    const record = save.indexOf(
      "var __deferred = await _events.RecordDurableAsync(__pending, null, cancellationToken);",
    );
    const saveChanges = save.indexOf("await _db.SaveChangesAsync(cancellationToken);");
    expect(record, "durable capture is emitted").toBeGreaterThan(-1);
    // THE PROPERTY: one SaveChangesAsync, and the outbox rows are already on
    // the change tracker when it runs — so they commit in that same round trip.
    expect(record, "capture precedes the commit").toBeLessThan(saveChanges);
    expect(save.split("SaveChangesAsync(cancellationToken)").length - 1).toBe(1);
    expect(save).toContain("foreach (var ev in __deferred)");
  });

  it("the outbox dispatcher's capture Adds without saving", async () => {
    const files = await emit("dotnet");
    const disp = fileEndingWith(files, "Infrastructure/Events/OutboxDomainEventDispatcher.cs");
    const record = from(disp, "public Task<IReadOnlyList<IDomainEvent>> RecordDurableAsync(");
    expect(record).toContain("_db.LoomOutbox.Add(new OutboxMessage");
    // A SaveChangesAsync here would be the second transaction all over again.
    expect(record).not.toContain("SaveChangesAsync");
  });

  it("the realtime + channel tees forward the capture instead of swallowing it", async () => {
    const files = await emitBroker("dotnet");
    const ch = fileEndingWith(files, "Infrastructure/Channels/ChannelTransport.cs");
    expect(ch).toContain(
      "=> ((IDomainEventDispatcher)_inner).RecordDurableAsync(events, transaction, cancellationToken);",
    );
  });
});

// ── .NET (Dapper) ───────────────────────────────────────────────────────────

describe("outbox write atomicity — .NET (Dapper)", () => {
  it("records the durable events on `__tx` before the commit", async () => {
    const files = await generateSystemFiles(DURABLE("dotnet { persistence: dapper }"));
    const repo = fileEndingWith(files, "Infrastructure/Repositories/OrderRepository.cs");
    const save = from(repo, "public async Task SaveAsync(Order aggregate");

    const record = save.indexOf(
      "var __deferred = await _events.RecordDurableAsync(__pending, __tx, cancellationToken);",
    );
    const commit = save.indexOf("await __tx.CommitAsync(cancellationToken);");
    expect(record, "durable capture is emitted, holding __tx").toBeGreaterThan(-1);
    expect(record, "capture precedes the commit").toBeLessThan(commit);
    expect(save).toContain("foreach (var ev in __deferred)");
  });

  it("the Dapper outbox dispatcher INSERTs on the caller's transaction", async () => {
    const files = await generateSystemFiles(DURABLE("dotnet { persistence: dapper }"));
    const disp = fileEndingWith(files, "Infrastructure/Events/OutboxDomainEventDispatcher.cs");
    const record = from(disp, "public async Task<IReadOnlyList<IDomainEvent>> RecordDurableAsync(");
    expect(record).toContain("if (transaction?.Connection is { } txConn)");
    expect(record).toContain("transaction: transaction, cancellationToken: cancellationToken));");
  });
});

// ── Elixir / Phoenix (plain Ecto) ───────────────────────────────────────────

describe("outbox write atomicity — elixir/Phoenix", () => {
  it("wraps persist + durable emit in ONE Repo.transaction", async () => {
    const files = await emit("elixir");
    const ctx = fileEndingWith(files, "lib/d/shop.ex");
    const op = from(ctx, "def place_order(%D.Shop.Order{} = record, params)");

    const txOpen = op.indexOf("D.Repo.transaction(fn ->");
    const persist = op.indexOf("D.Shop.OrderRepository.persist_change(changeset)");
    const dispatch = op.indexOf("D.Channels.dispatch(loom_event_0");
    const txClose = op.indexOf("    end)");
    expect(txOpen, "the persist tail opens a Repo.transaction").toBeGreaterThan(-1);
    // THE PROPERTY: persist AND the outbox-recording dispatch are both inside
    // the same transaction fn, so `Channels.record_durable/2`'s insert really
    // does join "the caller's Repo.transaction" the emitted comment names.
    expect(persist).toBeGreaterThan(txOpen);
    expect(dispatch).toBeGreaterThan(persist);
    expect(dispatch, "dispatch is INSIDE the transaction fn").toBeLessThan(txClose);
    expect(op).toContain("D.Repo.rollback(reason)");
  });

  it("an EPHEMERAL channel keeps the untransacted post-commit fan-out", async () => {
    // The wrap is gated on the event actually being durable, so ephemeral
    // projects keep their (byte-identical) persist tail.
    const files = await generateSystemFiles(
      DURABLE("elixir").replace("retention: log", "retention: ephemeral"),
    );
    const ctx = fileEndingWith(files, "lib/d/shop.ex");
    const op = from(ctx, "def place_order(%D.Shop.Order{} = record, params)");
    expect(op.slice(0, op.indexOf("def ", 10))).not.toContain("D.Repo.transaction(fn ->");
  });
});
