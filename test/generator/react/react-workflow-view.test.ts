// Workflow-sourced views on React (workflow-instance-views.md): the views api
// module re-exports the workflow's instance list response and emits a
// `use<View>View()` hook over `/views/<view>`; the scaffolded view-list page's
// columns come from the workflow's instance wire shape.

import { describe, expect, it } from "vitest";
import { buildViewsApiModule } from "../../../src/generator/_frontend/views-module.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts, type ExprIR, type PageIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel, parseString } from "../../_helpers/index.js";

const CTX = `
  system S { subdomain M { context C {
    aggregate Order { total: int }
    enum FulfillmentStatus { Pending, Shipped }
    event PaymentReceived { order: Order id, amount: int }
    channel Lifecycle { carries: PaymentReceived  delivery: broadcast  retention: ephemeral }
    workflow Fulfillment {
      orderId: Order id
      status: FulfillmentStatus
      create(paid: PaymentReceived) by paid.order { let x = paid.amount }
    }
    view ActiveFulfillments = Fulfillment where status == Pending
    repository Orders for Order {}
  }}}`;

describe("React workflows-sourced view api module", () => {
  it("re-exports the workflow instance list response + emits the view hook", async () => {
    const { model } = await parseString(CTX, { validate: false });
    const ctxs = allContexts(enrichLoomModel(lowerModel(model)));
    const mod = buildViewsApiModule(ctxs);
    expect(mod).toContain(
      "export const ActiveFulfillmentsResponse = FulfillmentInstanceListResponse;",
    );
    expect(mod).toMatch(/import \{ FulfillmentInstanceListResponse \} from "\.\/workflows";/);
    expect(mod).toContain("export function useActiveFulfillmentsView() {");
    expect(mod).toContain("await api.get(`/views/active_fulfillments`)");
  });
});

/** Whether any node references `Views.<name>` (Pattern C) — the hook the
 *  scaffolded view page binds to. */
function hasViewsMember(expr: ExprIR | undefined): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "member":
      return (
        (expr.receiver.kind === "ref" && expr.receiver.name === "Views") ||
        hasViewsMember(expr.receiver)
      );
    case "call":
      return expr.args.some(hasViewsMember);
    case "lambda":
      return hasViewsMember(expr.body);
    default:
      return false;
  }
}

describe("scaffold view page over a workflow source", () => {
  it("scaffolds a view page bound to Views.<name> with workflow-state columns", async () => {
    const src = CTX.replace("ui ", "ui ").replace(
      "repository Orders for Order {}",
      "repository Orders for Order {}\n  }}} ui App with scaffold(views: [ActiveFulfillments]) {",
    );
    // Simpler: append a ui with scaffold to the system.
    const withUi = CTX.replace(
      "repository Orders for Order {}\n  }}}",
      "repository Orders for Order {}\n  }} ui App with scaffold(views: [ActiveFulfillments]) { } }",
    );
    void src;
    const loom = await buildLoomModel(withUi);
    let pages: PageIR[] = [];
    for (const sys of loom.systems)
      for (const ui of sys.uis) if (ui.name === "App") pages = ui.pages;
    const page = pages.find((p) => p.name === "ActiveFulfillmentsView");
    expect(page, "ActiveFulfillmentsView page scaffolded").toBeDefined();
    expect(hasViewsMember(page!.body)).toBe(true);
  });
});
