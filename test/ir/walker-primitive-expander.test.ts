// Tests for `expandInlineScaffoldPrimitives` — phase ⑤c of lowering.
//
// `src/ir/lower/walker-primitive-expander.ts` is exercised by the
// `validate-expr-integrity` test only for the failure case (an
// un-expanded scaffold primitive escapes phase ⑤c).  This file pins
// the happy-path expansion for each scaffold primitive — after
// `buildLoomModel`, page bodies must NOT contain any
// `scaffold<X>(of:|runs:)` calls; they must have been rewritten into
// the canonical Stack / QueryView / Form trees.

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

/** Walk an ExprIR and report whether any node is a call to a
 *  scaffold primitive (`scaffoldList`/`scaffoldDetails`/...).  The
 *  expander is supposed to rewrite every such call. */
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
      if (SCAFFOLD.has(expr.name) && expr.args.length === 0) return true;
      // Scaffold primitives carry a single `of:` or `runs:` arg.
      if (SCAFFOLD.has(expr.name)) {
        // Home / WorkflowsIndex / ViewsIndex only count when args.length===0;
        // scaffoldList/Details/Operations/NewForm/WorkflowForm/ViewList always count.
        if (expr.name === "Home" || expr.name === "WorkflowsIndex" || expr.name === "ViewsIndex") {
          return expr.args.length === 0;
        }
        return true;
      }
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
      platform: hono
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
      platform: hono
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
      platform: hono
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

describe("walker-primitive-expander — aggregate scaffolds", () => {
  it("scaffoldList page body is rewritten to a Stack tree (no `scaffoldList` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "OrderList");
    expect(topCallee(list.body)).toBe("Stack");
    expect(containsScaffoldCall(list.body)).toBe(false);
  });

  it("scaffoldList expansion places Breadcrumbs at top and Heading inside a Toolbar", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "OrderList");
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

  it("scaffoldList expansion lands on a QueryView whose `data:` arg is a lambda", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const list = findPage(uiPages(loom, "App"), "OrderList");
    const stack = list.body as Extract<ExprIR, { kind: "call" }>;
    const queryView = stack.args.find(
      (a): a is Extract<ExprIR, { kind: "call" }> => topCallee(a) === "QueryView",
    );
    expect(queryView).toBeDefined();
    // QueryView args are named — the `data` arg is a lambda.
    const idx = (queryView!.argNames ?? []).indexOf("data");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(queryView!.args[idx]!.kind).toBe("lambda");
  });

  it("scaffoldDetails+Operations page (Detail) body has both expanded — Stack with QueryView + Group", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const detail = findPage(uiPages(loom, "App"), "OrderDetail");
    expect(topCallee(detail.body)).toBe("Stack");
    expect(containsScaffoldCall(detail.body)).toBe(false);
    const stack = detail.body as Extract<ExprIR, { kind: "call" }>;
    const calleeNames = stack.args.map(topCallee);
    // After flattening, the Stack contains Breadcrumbs, Heading, QueryView
    // (from scaffoldDetails), then a Group or Modal-bearing sibling
    // (from scaffoldOperations).
    expect(calleeNames).toContain("Breadcrumbs");
    expect(calleeNames).toContain("Heading");
    expect(calleeNames).toContain("QueryView");
  });

  it("scaffoldNewForm page (OrderNew) body expands to a Stack with a CreateForm", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const newPage = findPage(uiPages(loom, "App"), "OrderNew");
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

  it("Home sentinel page body is expanded (no bare Home() call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_AGGREGATE_DDD);
    const home = findPage(uiPages(loom, "App"), "Home");
    expect(containsScaffoldCall(home.body)).toBe(false);
  });
});

describe("walker-primitive-expander — workflow scaffold", () => {
  it("scaffoldWorkflowForm page (placeOrderWorkflow) body has been expanded to a Stack", async () => {
    const loom = await buildLoomModel(SCAFFOLD_WORKFLOW_DDD);
    const page = findPage(uiPages(loom, "App"), "PlaceOrderWorkflow");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });

  it("workflow scaffold expansion contains a WorkflowForm primitive", async () => {
    const loom = await buildLoomModel(SCAFFOLD_WORKFLOW_DDD);
    const page = findPage(uiPages(loom, "App"), "PlaceOrderWorkflow");
    const stack = page.body as Extract<ExprIR, { kind: "call" }>;
    // The WorkflowForm lives inside a Card child of the Stack.
    const hasWorkflowForm = stack.args.some((a) => {
      if (topCallee(a) === "WorkflowForm") return true;
      if (a.kind === "call" && a.name === "Card") {
        return a.args.some((c) => topCallee(c) === "WorkflowForm");
      }
      return false;
    });
    expect(hasWorkflowForm).toBe(true);
  });

  it("WorkflowsIndex sentinel page body has been expanded (no `WorkflowsIndex()` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_WORKFLOW_DDD);
    const page = findPage(uiPages(loom, "App"), "WorkflowsIndex");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });
});

describe("walker-primitive-expander — view scaffold", () => {
  it("scaffoldViewList page (ActiveOrdersView) body has been expanded to a Stack", async () => {
    const loom = await buildLoomModel(SCAFFOLD_VIEW_DDD);
    const page = findPage(uiPages(loom, "App"), "ActiveOrdersView");
    expect(topCallee(page.body)).toBe("Stack");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });

  it("view scaffold expansion lands on a QueryView (queries the view by name)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_VIEW_DDD);
    const page = findPage(uiPages(loom, "App"), "ActiveOrdersView");
    const stack = page.body as Extract<ExprIR, { kind: "call" }>;
    expect(stack.args.some((a) => topCallee(a) === "QueryView")).toBe(true);
  });

  it("ViewsIndex sentinel page body has been expanded (no `ViewsIndex()` call remains)", async () => {
    const loom = await buildLoomModel(SCAFFOLD_VIEW_DDD);
    const page = findPage(uiPages(loom, "App"), "ViewsIndex");
    expect(containsScaffoldCall(page.body)).toBe(false);
  });
});

describe("walker-primitive-expander — unresolved targets pass through unchanged", () => {
  it("scaffoldDetails referencing a missing aggregate stays as a `scaffoldDetails` call", async () => {
    // The validator should reject the missing aggregate ref, but the
    // expander itself must be total — when it can't resolve, it returns
    // the input unchanged so a downstream validator can report.
    const { expandInlineScaffoldPrimitives, buildExpandContext } = await import(
      "../../src/ir/lower/walker-primitive-expander.js"
    );
    // Minimal SystemIR + UiIR with no aggregates / workflows / views.
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const sys: any = { subdomains: [] };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const ui: any = { name: "App", pages: [] };
    const ctx = buildExpandContext(sys, ui);
    const body: ExprIR = {
      kind: "call",
      callKind: "free",
      name: "scaffoldDetails",
      args: [{ kind: "ref", name: "DoesNotExist", refKind: "unknown" }],
      argNames: ["of"],
    };
    const expanded = expandInlineScaffoldPrimitives(body, ctx);
    expect(expanded).toBe(body); // identity — unchanged
  });
});
