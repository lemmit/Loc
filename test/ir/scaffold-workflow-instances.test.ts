// Scaffold + expansion for observable workflow instances
// (workflow-instance-visibility.md): a correlation-bearing workflow covered by
// `scaffold` gets read-only `<Wf>InstancesList` / `<Wf>InstanceDetail` pages,
// whose bodies expand to QueryView trees over `<Wf>.instances.all` /
// `<Wf>.instances.byId(id)`.

import { describe, expect, it } from "vitest";
import type { ExprIR, PageIR } from "../../src/ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx } from "../../src/ir/util/page-kind.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

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

describe("the scaffolded pages inherit the gate their route is guarded by", () => {
  // The workflow HEADER gate guards `GET /workflows/<wf>/instances[/{id}]`
  // (M-T3.15 §A2) — the exact routes these pages read.  Without propagation
  // the scaffold emits an UNGATED page over a gated route: the client fires
  // the read and eats a 403 instead of rendering its own denial, and any
  // menu-derived nav link to it (which reads the PAGE's gate, not the
  // route's) stays visible to a principal the backend refuses.
  const GATED = `
    system Demo {
      user { id: guid  role: string }
      subdomain Sales {
        context Orders {
          aggregate Order with crudish { subject: string }
          repository Orders for Order {
            find all(): Order[] requires currentUser.role == "agent"
          }
          workflow Fulfillment requires currentUser.role == "supervisor" {
            orderId: Order id
            stage: string
            create(o: Order id) { orderId := o  stage := "open" }
          }
        }
      }
      ui App with scaffold(subdomains: [Sales]) { }
    }
  `;

  it("puts the workflow header gate on BOTH instance pages", async () => {
    const loom = await buildLoomModel(GATED);
    const pages = uiPages(loom);
    for (const name of ["FulfillmentInstancesList", "FulfillmentInstanceDetail"]) {
      const p = pages.find((q) => q.name === name);
      expect(p, name).toBeDefined();
      expect(p?.requires, `${name} carries no gate`).toBeDefined();
    }
  });

  it("puts the `find all` gate on the aggregate List page", async () => {
    const loom = await buildLoomModel(GATED);
    const list = uiPages(loom).find((p) => p.name === "List" && p.route === "/orders");
    expect(list?.requires).toBeDefined();
  });

  it("CLONES the gate — the author's node is not RE-PARENTED onto the page", async () => {
    // The failure this guards is silent and severe: a Langium AST node has ONE
    // `$container`, so attaching the AUTHOR's node to a page moves it there.
    // Lowering still reads `wf.gate` by property, so the IR looks correct and
    // an IR-level assertion passes — this was written that way first and a
    // seeded aliasing bug sailed through it.  The damage is in the CONTAINER
    // chain (what Langium links and scopes against), so that is what is
    // asserted: every gate node must be contained by its own owner, and with
    // two instance pages plus the declaration sharing one node, at most one of
    // the three can be.
    const { model } = await parseString(GATED, { validate: false });
    type Node = {
      $type: string;
      name?: string;
      members?: Node[];
      props?: Node[];
      expr?: { $container?: unknown };
    };
    const uis = ((model.members ?? []) as unknown as Node[])
      .filter((m) => m.$type === "System")
      .flatMap((sys) => sys.members ?? [])
      .filter((m) => m.$type === "Ui" && m.name === "App");
    // `pagesForAggregate` groups List/New/Detail under a per-aggregate `area`,
    // so pages sit at two depths.
    const members = uis.flatMap((u) => u.members ?? []);
    const pages = [
      ...members.filter((m) => m.$type === "Page"),
      ...members.filter((m) => m.$type === "Area").flatMap((a) => a.members ?? []),
    ].filter((m) => m.$type === "Page");
    const gated = pages
      .map((pg) => ({
        name: pg.name,
        prop: (pg.props ?? []).find((pr) => pr.$type === "RequiresProp"),
      }))
      .filter((x) => x.prop);
    // List + the two instance pages.
    expect(gated.map((g) => g.name).sort()).toEqual([
      "FulfillmentInstanceDetail",
      "FulfillmentInstancesList",
      "List",
    ]);
    for (const g of gated) {
      const prop = g.prop as Node;
      expect(prop.expr?.$container, `${g.name}'s gate is parented elsewhere`).toBe(prop);
    }
  });

  it("leaves an UNGATED scaffold ungated", async () => {
    const loom = await buildLoomModel(SRC);
    for (const p of uiPages(loom)) expect(p.requires).toBeUndefined();
  });
});
