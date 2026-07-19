// Scaffold + expansion for observable workflow instances
// (workflow-instance-visibility.md): a correlation-bearing workflow covered by
// `scaffold` gets read-only `<Wf>InstancesList` / `<Wf>InstanceDetail` pages,
// whose bodies expand to QueryView trees over `<Wf>.instances.all` /
// `<Wf>.instances.byId(id)`.

import { describe, expect, it } from "vitest";
import type { ExprIR, PageIR } from "../../src/ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx } from "../../src/ir/util/page-kind.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { subject: string }
        enum FulfillmentStatus { Pending, Shipped }
        workflow Fulfillment {
          orderId: Order id
          status: FulfillmentStatus
          create(o: Order id) { let x = 1 }
        }
        repository Orders for Order { }
      }
    }
    ui App with scaffold(workflows: [Fulfillment]) { }
  }
`;

function uiPages(loom: Awaited<ReturnType<typeof buildLoomModel>>): PageIR[] {
  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      if (ui.name === "App") return ui.pages;
    }
  }
  throw new Error("ui App not found");
}

/** Whether any node in the tree is a member access named `instances`
 *  (the `<Wf>.instances` root the instance hooks key off). */
function hasInstancesMember(expr: ExprIR | undefined): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "member":
      if (expr.member === "instances") return true;
      return hasInstancesMember(expr.receiver);
    case "method-call":
      return hasInstancesMember(expr.receiver) || expr.args.some(hasInstancesMember);
    case "call":
      return expr.args.some(hasInstancesMember);
    case "lambda":
      return hasInstancesMember(expr.body);
    case "binary":
      return hasInstancesMember(expr.left) || hasInstancesMember(expr.right);
    default:
      return false;
  }
}

describe("scaffold — observable workflow instance pages", () => {
  it("synthesises InstancesList + InstanceDetail pages with conventional routes", async () => {
    const loom = await buildLoomModel(SRC);
    const pages = uiPages(loom);
    const names = pages.map((p) => p.name);
    expect(names).toContain("FulfillmentInstancesList");
    expect(names).toContain("FulfillmentInstanceDetail");
    // The form page is still produced (command-triggered facade).
    expect(names).toContain("FulfillmentWorkflow");

    const list = pages.find((p) => p.name === "FulfillmentInstancesList")!;
    const detail = pages.find((p) => p.name === "FulfillmentInstanceDetail")!;
    expect(list.route).toBe("/workflows/fulfillment/instances");
    expect(detail.route).toBe("/workflows/fulfillment/instances/:id");
    const nameCtx: PageNameCtx = {
      aggregateNames: loom.systems.flatMap((s) =>
        s.subdomains.flatMap((m) => m.contexts.flatMap((c) => c.aggregates.map((a) => a.name))),
      ),
      workflowNames: loom.systems.flatMap((s) =>
        s.subdomains.flatMap((m) => m.contexts.flatMap((c) => c.workflows.map((w) => w.name))),
      ),
      viewNames: loom.systems.flatMap((s) =>
        s.subdomains.flatMap((m) => m.contexts.flatMap((c) => c.views.map((v) => v.name))),
      ),
    };
    expect(classifyPage(list, nameCtx).kind).toBe("workflow-instances-list");
    expect(classifyPage(detail, nameCtx).kind).toBe("workflow-instance-detail");
    // Detail synthesises the `id` route param (like aggregate-detail).
    expect(detail.params.some((p) => p.name === "id")).toBe(true);
  });

  it("does NOT synthesise instance pages when the sole id state field is optional", async () => {
    // An optional `X id?` correlation field lowers to kind `optional`, not
    // `id`, so the IR's `instanceWireShape` gate treats the workflow as
    // non-observable and emits no instance surface. The scaffold gate must
    // agree, or the pages reference an endpoint that was never generated.
    const loom = await buildLoomModel(`
      system Demo {
        subdomain Sales {
          context Orders {
            aggregate Order { subject: string }
            enum FulfillmentStatus { Pending, Shipped }
            workflow Fulfillment {
              orderId: Order id?
              status: FulfillmentStatus
              create(o: Order id) { let x = 1 }
            }
            repository Orders for Order { }
          }
        }
        ui App with scaffold(workflows: [Fulfillment]) { }
      }
    `);
    const names = uiPages(loom).map((p) => p.name);
    expect(names).not.toContain("FulfillmentInstancesList");
    expect(names).not.toContain("FulfillmentInstanceDetail");
    // The command-triggered form facade is still produced.
    expect(names).toContain("FulfillmentWorkflow");
  });

  it("expands the bodies to QueryView trees over `<Wf>.instances.*`", async () => {
    const loom = await buildLoomModel(SRC);
    const pages = uiPages(loom);
    const list = pages.find((p) => p.name === "FulfillmentInstancesList")!;
    const detail = pages.find((p) => p.name === "FulfillmentInstanceDetail")!;
    // No raw scaffold sentinel survives lowering; the `instances` member chain
    // the detector/hooks key off is present in both expanded bodies.
    expect(hasInstancesMember(list.body)).toBe(true);
    expect(hasInstancesMember(detail.body)).toBe(true);
    expect(list.emitPath).toBe("src/pages/workflows/fulfillment/instances.tsx");
    expect(detail.emitPath).toBe("src/pages/workflows/fulfillment/instance_detail.tsx");
  });
});
