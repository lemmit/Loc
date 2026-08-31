// G2646 — node's folded-projection emission vs the diagnostic that ships beside it.
//
// `loom.projection-event-uncarried` warns, verbatim:
//
//   "In-process dispatch is channel-routed, so this fold never runs and the
//    read-model row is never written"
//
// …and node then folded it anyway.  `buildProjectionsFile` keyed off
// `isMaterializedProjection` alone, so for a `projection … on(Event)` whose
// event no `channel` carries it still emitted `fold<Event>Into<Proj>` AND wired
// `projectionTee` as `createApp`'s default dispatcher — which `repo.save`
// dispatches every pending event through.  So on node the fold DID run: the
// warning was false on the one backend that contradicted it, while python and
// elixir emitted no fold module at all.
//
// Direction of the fix: the warning is the contract.  `deriveEventSubscriptions`
// records a subscription only for a carried event; node's OWN workflow-reactor
// path already gates on `ctx.eventSubscriptions`; four backends already agree.
// Node's projection emitter was the outlier, so it now filters by the same
// subscription set — and the warning tells the truth on all five.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function sys(channel: string): string {
  return `
  system Shop {
    subdomain Sales { context Orders {
      enum OrderStatus { Placed Shipped }
      event OrderPlaced  { order: Order id }
      event OrderShipped { order: Order id }
      aggregate Customer { name: string }
      aggregate Order { status: OrderStatus  create(customer: Customer id) {} }
      ${channel}
      projection OrderBook keyed by order {
        order: Order id
        status: OrderStatus
        on(e: OrderPlaced)  { status := Placed }
        on(e: OrderShipped) { status := Shipped }
      }
    }}
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 8080
    }
  }`;
}

const CARRIES_BOTH = `channel Lifecycle { carries: OrderPlaced, OrderShipped  delivery: broadcast  retention: ephemeral }`;
const CARRIES_ONE = `channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }`;

async function projections(channel: string): Promise<string> {
  const files = (await generateSystems(await parseValid(sys(channel)))).files;
  const k = [...files.keys()].find((key) => key.endsWith("http/projections.ts"));
  expect(k, "http/projections.ts not emitted").toBeDefined();
  return files.get(k!)!;
}

describe("node folded-projection emission honours channel carriage", () => {
  it("a carried fold is emitted and routed by the tee", async () => {
    const src = await projections(CARRIES_BOTH);
    expect(src).toContain("export async function foldOrderPlacedIntoOrderBook(");
    expect(src).toContain("export async function foldOrderShippedIntoOrderBook(");
    expect(src).toContain('case "OrderPlaced":');
    expect(src).toContain('case "OrderShipped":');
  });

  it("an UNCARRIED fold is not emitted — the warning said it never runs", async () => {
    const src = await projections("");
    expect(src).not.toContain("foldOrderPlacedIntoOrderBook");
    expect(src).not.toContain("foldOrderShippedIntoOrderBook");
    // No fold ⇒ no load/save helpers either (they would be dead code the
    // generated-project Biome gate rejects), and the tee is the identity.
    expect(src).not.toContain("async function loadOrderBook");
    expect(src).toContain("  return inner;");
    // …and the `Events` namespace import goes with them, or `noUnusedImports`
    // fails on the generated project.
    expect(src).not.toContain('import type * as Events from "../domain/events"');
  });

  it("the READ surface survives an uncarried fold — the row table is still declared", async () => {
    const src = await projections("");
    expect(src).toContain("export function projectionsRoutes(");
    expect(src).toContain('path: "/order_book"');
  });

  it("carriage is per-EVENT, not per-projection", async () => {
    const src = await projections(CARRIES_ONE);
    expect(src).toContain("export async function foldOrderPlacedIntoOrderBook(");
    expect(src).not.toContain("foldOrderShippedIntoOrderBook");
    // The tee routes the carried event only — a case for the uncarried one
    // would name a function this module no longer declares (TS2304).
    expect(src).toContain('case "OrderPlaced":');
    expect(src).not.toContain('case "OrderShipped":');
  });
});
