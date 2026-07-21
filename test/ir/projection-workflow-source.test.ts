// Query-time projection `from <Workflow>` — the projection twin of the removed
// workflow-source view.  A projection reads a workflow's persisted instance /
// saga-state rows (`instanceWireShape`) at query time.  Option A: NON-event-
// sourced (saga-state table) sources with `where`/`select` only.
//
// Gates:
//   loom.projection-workflow-source-not-observable        — no id-shaped correlation field
//   loom.projection-workflow-source-eventsourced-unsupported — event-sourced source (deferred)
//   loom.projection-workflow-source-join-unsupported      — a `join` over a workflow source
//   loom.projection-workflow-source-ignoring-unsupported  — an `ignoring` over a workflow source
//   loom.projection-workflow-source-unsupported-backend   — a backend that hasn't ported the emit

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function codes(body: string, platform = "node"): Promise<string[]> {
  const src = `
system S {
  subdomain D { context C {
    aggregate Order { total: int  operation place() { emit OrderPlaced { order: id } } }
    repository Orders for Order { }
    event OrderPlaced { order: Order id }
    event Paid { order: Order id }
    workflow Fulfil {
      orderId: Order id
      attempts: int
      create(p: OrderPlaced) by p.order { emit Paid { order: p.order } }
    }
    workflow FulfilES eventSourced {
      orderId: Order id
      paid: int
      create(p: OrderPlaced) by p.order { emit Paid { order: p.order } }
      apply(pa: Paid) { paid := paid + 1 }
    }
    workflow Stateless {
      create(p: OrderPlaced) { emit Paid { order: p.order } }
    }
    ${body}
  }}
  storage sql { type: postgres }
  resource st { for: C, kind: state, use: sql }
  deployable api { platform: ${platform}  contexts: [C]  dataSources: [st] }
}
`;
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code?.startsWith("loom.projection-workflow-source"))
    .map((d) => d.code!);
}

describe("query-time projection `from <Workflow>` validation", () => {
  it("accepts a non-event-sourced, observable workflow source on node", async () => {
    expect(
      await codes(
        `projection ActiveFulfils { orderId: Order id  attempts: int  from Fulfil as f where f.attempts > 0 select orderId = f.orderId, attempts = f.attempts }`,
      ),
    ).toEqual([]);
  });

  it("loom.projection-workflow-source-not-observable — a stateless workflow (no correlation)", async () => {
    expect(
      await codes(`projection P { total: int  from Stateless as s select total = 0 }`),
    ).toEqual(["loom.projection-workflow-source-not-observable"]);
  });

  it("loom.projection-workflow-source-eventsourced-unsupported — an event-sourced source", async () => {
    expect(
      await codes(
        `projection P { orderId: Order id  from FulfilES as f where f.paid > 0 select orderId = f.orderId }`,
      ),
    ).toEqual(["loom.projection-workflow-source-eventsourced-unsupported"]);
  });

  it("loom.projection-workflow-source-join-unsupported — a join over a workflow source", async () => {
    expect(
      await codes(
        `projection P { orderId: Order id  total: int  from Fulfil as f join Order as o on f.orderId select orderId = f.orderId, total = o.total }`,
      ),
    ).toContain("loom.projection-workflow-source-join-unsupported");
  });

  it("loom.projection-workflow-source-ignoring-unsupported — an ignoring over a workflow source", async () => {
    expect(
      await codes(
        `projection P { orderId: Order id  from Fulfil as f ignoring * select orderId = f.orderId }`,
      ),
    ).toContain("loom.projection-workflow-source-ignoring-unsupported");
  });

  it("loom.projection-workflow-source-unsupported-backend — a non-node backend (emit not ported)", async () => {
    expect(
      await codes(
        `projection P { orderId: Order id  from Fulfil as f select orderId = f.orderId }`,
        "java",
      ),
    ).toContain("loom.projection-workflow-source-unsupported-backend");
  });
});
