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
