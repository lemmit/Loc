// Tests for scaffold page-body shapes after macro expansion.
//
// Every scaffold page — list / detail / form AND the Home / WorkflowsIndex /
// ViewsIndex dashboards — carries its full body tree directly from the
// `with scaffold(...)` macro (`_body-builders.ts`); there is no IR-phase
// expander or sentinel left.  This file pins that macro-scaffolded pages lower
// to full Stack / QueryView / Form trees with NO leftover `scaffold*`/`Home()`
// call.

import { describe, expect, it } from "vitest";
import type { ExprIR, PageIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---- helpers ---------------------------------------------------------------

function uiPages(loom: Awaited<ReturnType<typeof buildLoomModel>>, uiName: string): PageIR[] {
  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      if (ui.name === uiName) return ui.pages;
    }
  }
  throw new Error(`ui ${uiName} not found`);
}

function findPage(pages: PageIR[], name: string): PageIR {
  const p = pages.find((pg) => pg.name === name);
  if (!p) throw new Error(`page ${name} not found`);
  return p;
}

/** Walk an ExprIR and report whether any node is a call to a removed
 *  scaffold body primitive or an un-expanded singleton sentinel.  After
 *  lowering, no such call may survive. */
function containsScaffoldCall(expr: ExprIR | undefined): boolean {
  if (!expr) return false;
  const SCAFFOLD = new Set([
    "scaffoldList",
    "scaffoldDetails",
    "scaffoldOperations",
    "scaffoldNewForm",
    "scaffoldWorkflowForm",
    "scaffoldViewList",
    "scaffoldInstanceList",
    "scaffoldInstanceDetails",
    "Home",
    "WorkflowsIndex",
    "ViewsIndex",
  ]);
  switch (expr.kind) {
    case "call":
      if (SCAFFOLD.has(expr.name)) return true;
      return expr.args.some((a) => containsScaffoldCall(a));
    case "lambda":
      return containsScaffoldCall(expr.body);
    case "member":
      return containsScaffoldCall(expr.receiver);
    case "method-call":
      return containsScaffoldCall(expr.receiver) || expr.args.some((a) => containsScaffoldCall(a));
    case "binary":
      return containsScaffoldCall(expr.left) || containsScaffoldCall(expr.right);
    case "ternary":
      return (
        containsScaffoldCall(expr.cond) ||
        containsScaffoldCall(expr.then) ||
        containsScaffoldCall(expr.otherwise)
      );
    case "paren":
      return containsScaffoldCall(expr.inner);
    case "unary":
      return containsScaffoldCall(expr.operand);
    case "match":
      return (
        expr.arms.some((a) => containsScaffoldCall(a.cond) || containsScaffoldCall(a.value)) ||
        containsScaffoldCall(expr.otherwise)
      );
    default:
      return false;
  }
}

/** Top-level callee name of an ExprIR — `body: Stack {...}` → "Stack". */
function topCallee(expr: ExprIR | undefined): string | undefined {
  if (!expr) return undefined;
  if (expr.kind === "call") return expr.name;
  return undefined;
}

// ---- system fixtures -------------------------------------------------------

const SCAFFOLD_AGGREGATE_DDD = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order {
          subject: string
          derived display: string = subject
          create(subject: string) { subject := subject }
          operation confirm() {}
        }
        repository Orders for Order {}
      }
    }
    api SalesApi from Sales
    ui App with scaffold(aggregates: [Order]) {
      api Sales: SalesApi
    }
    deployable api {
      platform: node
      contexts: [Orders]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: static
      targets: api
      ui: App { Sales: api }
      port: 3001
    }
  }
`;

const SCAFFOLD_WORKFLOW_DDD = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { name: string derived display: string = name }
        workflow placeOrder {
      create(name: string) {}
    }
        repository Orders for Order {}
      }
    }
    api SalesApi from Sales
    ui App with scaffold(workflows: [placeOrder]) {
      api Sales: SalesApi
    }
    deployable api {
      platform: node
      contexts: [Orders]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: static
      targets: api
      ui: App { Sales: api }
      port: 3001
    }
  }
`;

const SCAFFOLD_VIEW_DDD = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { subject: string  derived display: string = subject }
        view ActiveOrders = Order where subject == "x"
        repository Orders for Order {}
      }
    }
    api SalesApi from Sales
    ui App with scaffold(views: [ActiveOrders]) {
      api Sales: SalesApi
    }
    deployable api {
      platform: node
      contexts: [Orders]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: static
      targets: api
      ui: App { Sales: api }
      port: 3001
    }
  }
`;

// ---- tests -----------------------------------------------------------------

describe("scaffolded aggregate pages — full body trees", () => {
  it("List page body is a Stack tree (no `scaffold*` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "List");
    expect(topCallee(list.body)).toBe("Stack");
    expect(containsScaffoldCall(list.body)).toBe(false);
  });

  it("List body places Breadcrumbs at top and Heading inside a Toolbar", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "List");
    const body = list.body as Extract<ExprIR, { kind: "call" }>;
    expect(body.name).toBe("Stack");
    const calleeNames = body.args.map(topCallee);
    expect(calleeNames).toContain("Breadcrumbs");
    expect(calleeNames).toContain("Toolbar");
    const toolbar = body.args.find(
      (a): a is Extract<ExprIR, { kind: "call" }> => topCallee(a) === "Toolbar",
    )!;
    expect(toolbar.args.map(topCallee)).toContain("Heading");
  });

  it("List body lands on a QueryView whose `data:` arg is a lambda", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "List");
    const stack = list.body as Extract<ExprIR, { kind: "call" }>;
    const queryView = stack.args.find(
      (a): a is Extract<ExprIR, { kind: "call" }> => topCallee(a) === "QueryView",
    );
    expect(queryView).toBeDefined();
    const idx = (queryView!.argNames ?? []).indexOf("data");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(queryView!.args[idx]!.kind).toBe("lambda");
  });

  it("Detail page body is a Stack with Breadcrumbs + Heading + QueryView", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const detail = findPage(uiPages(loom, "App"), "Detail");
    expect(topCallee(detail.body)).toBe("Stack");
    expect(containsScaffoldCall(detail.body)).toBe(false);
    const stack = detail.body as Extract<ExprIR, { kind: "call" }>;
    const calleeNames = stack.args.map(topCallee);
    expect(calleeNames).toContain("Breadcrumbs");
    expect(calleeNames).toContain("Heading");
    expect(calleeNames).toContain("QueryView");
  });

  it("New page body is a Stack with a CreateForm", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const newPage = findPage(uiPages(loom, "App"), "New");
    expect(topCallee(newPage.body)).toBe("Stack");
    expect(containsScaffoldCall(newPage.body)).toBe(false);
    const stack = newPage.body as Extract<ExprIR, { kind: "call" }>;
    const calleeNames = stack.args.flatMap((a) => {
      if (topCallee(a) === "Card") {
        return (a as Extract<ExprIR, { kind: "call" }>).args.map(topCallee);
      }
      return [topCallee(a)];
    });
    expect(calleeNames).toContain("CreateForm");
  });

  it("Home page body is a full Stack tree (no bare Home() call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const home = findPage(uiPages(loom, "App"), "Home");
    expect(topCallee(home.body)).toBe("Stack");
    expect(containsScaffoldCall(home.body)).toBe(false);
  });
});

describe("scaffolded workflow pages — full body trees", () => {
  it("workflow form page body is a Stack with a WorkflowForm", async () => {
    const loom = await buildLoomModel(SCAFFOLD_WORKFLOW_DDD);
    const page = findPage(uiPages(loom, "App"), "PlaceOrderWorkflow");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
    const stack = page.body as Extract<ExprIR, { kind: "call" }>;
    const hasWorkflowForm = stack.args.some((a) => {
      if (topCallee(a) === "WorkflowForm") return true;
      if (a.kind === "call" && a.name === "Card") {
        return a.args.some((c) => topCallee(c) === "WorkflowForm");
      }
      return false;
    });
    expect(hasWorkflowForm).toBe(true);
  });

  it("WorkflowsIndex page body is a full Stack tree (no `WorkflowsIndex()` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_WORKFLOW_DDD);
    const page = findPage(uiPages(loom, "App"), "WorkflowsIndex");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });
});

describe("scaffolded view pages — full body trees", () => {
  it("view list page body is a Stack landing on a QueryView", async () => {
    const loom = await buildLoomModel(SCAFFOLD_VIEW_DDD);
    const page = findPage(uiPages(loom, "App"), "ActiveOrdersView");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
    const stack = page.body as Extract<ExprIR, { kind: "call" }>;
    expect(stack.args.some((a) => topCallee(a) === "QueryView")).toBe(true);
  });

  it("ViewsIndex page body is a full Stack tree (no `ViewsIndex()` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_VIEW_DDD);
    const page = findPage(uiPages(loom, "App"), "ViewsIndex");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });
});
