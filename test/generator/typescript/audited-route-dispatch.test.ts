// An audited route must NOT dispatch domain events inside its own transaction.
//
// `audited` aggregates wrap the write in `db.transaction(async (tx) => …)` and
// hand the repository that `tx`.  `save()` dispatches at the end of its body —
// correct when it owns its handle, wrong there, because the ROUTE's transaction
// is still open.  The in-process dispatcher closes over the ROOT `db`, so an
// in-process subscriber that touches the database queries the very connection
// the open transaction holds: on a single-connection driver (the node
// behavioural leg's PGlite) that self-deadlocks, and on a pool it reads
// pre-commit state.
//
// It deadlocked rather than threw, which is why no error ever surfaced: the
// process simply stopped after `event_dispatched`. Only a runtime caller could
// find it, and this fixture had none until it was drained.
//
// The workflow routes already dispatched after the callback returned; this
// pins the aggregate routes to the same rule.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SOURCE = `system Depot {
  subdomain Ops {
    context Yard {
      event ParcelSent { parcel: Parcel id }
      aggregate Parcel audited {
        code: string
        operation send() {
          emit ParcelSent { parcel: id }
        }
      }
      repository Parcels for Parcel { }
    }
  }

  api YardApi from Ops
  storage primary { type: postgres }
  resource yardState { for: Yard, kind: state, use: primary }

  deployable d {
    platform: node
    contexts: [Yard]
    dataSources: [yardState]
    serves: YardApi
    port: 4000
  }
}`;

describe("audited routes defer dispatch past their own transaction", () => {
  it("hands the repo a deferring dispatcher and flushes after the tx closes", async () => {
    const files = await generateSystemFiles(SOURCE);
    const routes = [...files.entries()].find(([p]) => p.endsWith("http/parcel.routes.ts"));
    expect(routes, "no parcel.routes.ts emitted").toBeDefined();
    const src = routes![1];

    // The transaction must exist at all — otherwise this test would pass
    // vacuously on a non-audited aggregate (§63's empty-population shape).
    expect(src, "expected an audited route to open a transaction").toContain(
      "await db.transaction(async (tx) => {",
    );
    // The repo inside the tx gets the DEFERRING dispatcher, never the root one.
    expect(src).toContain("const __deferred = deferredDispatcher(events);");
    expect(src).toContain("new ParcelRepository(tx, __deferred)");
    expect(src, "a repo built on tx must never receive the root dispatcher").not.toContain(
      "new ParcelRepository(tx, events)",
    );
    // And the buffer is flushed — a deferral that never flushes would silently
    // drop every event instead of deadlocking, which is worse.
    expect(src).toContain("await __deferred.flush();");
  });

  it("emits a deferredDispatcher whose flush runs only after commit", async () => {
    const files = await generateSystemFiles(SOURCE);
    const events = [...files.entries()].find(([p]) => p.endsWith("domain/events.ts"));
    expect(events, "no domain/events.ts emitted").toBeDefined();
    const src = events![1];
    expect(src).toContain("export function deferredDispatcher(");
    // Durable capture must still go INSIDE the transaction — the outbox row is
    // supposed to commit atomically with the write — so it delegates through
    // rather than being buffered.
    expect(src).toContain("recordDurable: inner.recordDurable?.bind(inner),");
  });
});
