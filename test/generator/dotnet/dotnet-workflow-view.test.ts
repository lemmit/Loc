// Workflow-sourced views on .NET (workflow-instance-views.md): `view X =
// <Workflow> where <pred>` emits a Mediator query whose handler reads the
// saga-state DbSet with the filter, returning the workflow's
// <Wf>InstanceResponse, plus a ViewsController action over it.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Order { total: int }
        enum FulfillmentStatus { Pending, Shipped }
        event PaymentReceived { order: Order id, amount: int }
        channel Lifecycle { carries: PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          status: FulfillmentStatus
          create(paid: PaymentReceived) by paid.order { let x = paid.amount }
        }
        view ActiveFulfillments = OrderFulfillment where status == Pending
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: dotnet  contexts: [Ops]  port: 3000 }
  }
`;

async function files(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function get(files: Map<string, string>, suffix: string): string {
  const k = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return files.get(k!)!;
}

describe(".NET workflow-sourced view", () => {
  it("emits a query returning the workflow instance response", async () => {
    const q = get(await files(), "Application/Views/ActiveFulfillmentsQuery.cs");
    expect(q).toContain(
      "public sealed record ActiveFulfillmentsQuery() : IQuery<IReadOnlyList<OrderFulfillmentInstanceResponse>>;",
    );
  });

  it("emits a handler reading the saga DbSet with the filter", async () => {
    const h = get(await files(), "Application/Views/ActiveFulfillmentsHandler.cs");
    expect(h).toContain("private readonly AppDbContext _db;");
    expect(h).toMatch(
      /_db\.OrderFulfillments\.AsNoTracking\(\)\.Where\(r => r\.Status == FulfillmentStatus\.Pending\)\.ToListAsync/,
    );
    expect(h).toMatch(/new OrderFulfillmentInstanceResponse\(r\.OrderId\.Value, r\.Status\)/);
  });

  it("exposes it on the ViewsController", async () => {
    const c = get(await files(), "ViewsController.cs");
    expect(c).toContain('[HttpGet("active_fulfillments")]');
    expect(c).toContain("IReadOnlyList<OrderFulfillmentInstanceResponse>");
  });
});

// An event-sourced workflow has no `<Wf>State` DbSet, so a `view = <ESWorkflow>`
// can't push its filter into the EF query.  The handler group-folds the
// `<wf>_events` table into the same instance read model the ES instance LIST
// produces (load all event rows, GroupBy(StreamId), fold each via _FromEvents)
// and applies the SAME predicate IN-MEMORY (`.Where(r => …)`).  The query type,
// operationId, route path and response component stay identical to the state path.
const ES_SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Order { total: int  create place() { total := 0  emit OrderPlaced { order: id } } }
        event OrderPlaced { order: Order id }
        event PaymentReceived { order: Order id, amount: int }
        channel Lifecycle { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment eventSourced {
          orderId: Order id
          paid: int
          create(p: OrderPlaced) by p.order { emit PaymentReceived { order: p.order, amount: 0 } }
          apply(pr: PaymentReceived) { paid := paid + pr.amount }
        }
        view PaidFulfillments = OrderFulfillment where paid > 0
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: dotnet  contexts: [Ops]  port: 3000 }
  }
`;

async function esFiles(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(ES_SRC))).files;
}

describe(".NET event-sourced workflow-sourced view", () => {
  it("emits a query returning the ES workflow instance response (same shape as state)", async () => {
    const q = get(await esFiles(), "Application/Views/PaidFulfillmentsQuery.cs");
    expect(q).toContain(
      "public sealed record PaidFulfillmentsQuery() : IQuery<IReadOnlyList<OrderFulfillmentInstanceResponse>>;",
    );
  });

  it("group-folds the <wf>_events stream and filters IN-MEMORY (no SQL Where)", async () => {
    const h = get(await esFiles(), "Application/Views/PaidFulfillmentsHandler.cs");
    // Loads the event rows ordered by stream, then folds each stream group.
    expect(h).toContain(
      'var __rows = await _db.Events.AsNoTracking().Where(e => e.StreamType == "OrderFulfillment").OrderBy(e => e.StreamId).ThenBy(e => e.Version).ToListAsync(cancellationToken);',
    );
    expect(h).toContain(
      "var rows = __rows.GroupBy(e => e.StreamId).Select(g => OrderFulfillmentState._FromEvents(new OrderId(System.Guid.Parse(g.Key)), g.Select(OrderFulfillmentState.RowToEvent).ToList())).Where(r => r.Paid > 0);",
    );
    expect(h).toContain(
      "return rows.Select(r => new OrderFulfillmentInstanceResponse(r.OrderId.Value, r.Paid)).ToList();",
    );
    // The ES read does NOT read a saga-state DbSet.
    expect(h).not.toContain("_db.OrderFulfillments.AsNoTracking().Where");
  });

  it("exposes it on the ViewsController under the same route", async () => {
    const c = get(await esFiles(), "ViewsController.cs");
    expect(c).toContain('[HttpGet("paid_fulfillments")]');
    expect(c).toContain("IReadOnlyList<OrderFulfillmentInstanceResponse>");
  });
});
