// Scaffold stdlib macro emits the expected Page AST shape for each
// selector kind.  Originally written as a legacy-vs-macro
// equivalence test; with the legacy `scaffold` keyword removed in
// the Phase 4 finalisation commit, the macro is the only path —
// these tests pin the output shape directly so any future refactor
// surfaces immediately.

import { describe, expect, it } from "vitest";
import type { Model, Page, Ui } from "../../src/language/generated/ast.js";
import { isPage } from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const wrapWith = (uiArgs: string) => `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { subject: string }
        aggregate Customer { name: string }
        workflow placeOrder {
      create() { let x = 1 }
    }
        view ActiveOrders = Order where subject == "x"
        repository Orders for Order { }
        repository Customers for Customer { }
      }
    }
    ui App with scaffold(${uiArgs}) { }
  }
`;

function findUi(model: Model): Ui {
  for (const sm of model.members ?? []) {
    if ((sm as any).$type !== "System") continue;
    for (const m of (sm as any).members ?? []) {
      if (m.$type === "Ui") return m as Ui;
    }
  }
  throw new Error("ui not found");
}

function pageNames(model: Model): string[] {
  const ui = findUi(model);
  return (ui.members ?? [])
    .filter(isPage)
    .map((p) => p.name)
    .sort();
}

function pageRoute(model: Model, name: string): string | undefined {
  const ui = findUi(model);
  const p = (ui.members ?? []).filter(isPage).find((pg) => pg.name === name);
  if (!p) return undefined;
  for (const prop of p.props ?? []) {
    if (prop.$type === "RouteProp") return (prop as any).value;
  }
  return undefined;
}

function pageBodyCallee(model: Model, name: string): string | undefined {
  const ui = findUi(model);
  const p = (ui.members ?? []).filter(isPage).find((pg) => pg.name === name);
  if (!p) return undefined;
  for (const prop of p.props ?? []) {
    if (prop.$type === "BodyProp") {
      const expr = (prop as any).expr;
      // Post grammar-flatten: a `Name(args)` invocation is a
      // PostfixChain with head=NameRef(Name) and a single CallSuffix.
      if (expr?.$type === "PostfixChain" && expr.head?.$type === "NameRef") {
        const first = (expr.suffixes ?? [])[0];
        if (first?.$type === "CallSuffix") {
          return expr.head.name;
        }
      }
    }
  }
  return undefined;
}

describe("scaffold macro: aggregate selector", () => {
  it("emits List/New/Detail per aggregate, plus Home and the indexes that apply", async () => {
    const { model, errors } = await parseString(wrapWith("aggregates: [Order, Customer]"));
    expect(errors).toEqual([]);
    expect(pageNames(model)).toEqual([
      "CustomerDetail",
      "CustomerList",
      "CustomerNew",
      "Home",
      "OrderDetail",
      "OrderList",
      "OrderNew",
    ]);
  });

  it("List pages get pluralised snake-case routes", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    expect(pageRoute(model, "OrderList")).toBe("/orders");
    expect(pageRoute(model, "OrderNew")).toBe("/orders/new");
    expect(pageRoute(model, "OrderDetail")).toBe("/orders/:id");
  });

  it("body calls are the canonical scaffold primitives", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    // List / New / Workflow / View now emit the canonical
    // `scaffold<X>(of:|runs:)` body primitive, one per page.  The
    // expander rewrites it inline at lowering to the same Stack /
    // QueryView / Form trees the legacy archetype path produced.
    expect(pageBodyCallee(model, "OrderList")).toBe("scaffoldList");
    expect(pageBodyCallee(model, "OrderNew")).toBe("scaffoldNewForm");
    // Detail page emits the explicit Stack {scaffoldDetails,
    // scaffoldOperations} shape so users can unfold into per-slot
    // customisation while leaving auto-op-modal generation intact.
    expect(pageBodyCallee(model, "OrderDetail")).toBe("Stack");
  });
});

describe("scaffold macro: workflow / view / module selectors", () => {
  it("workflows produce one Form page each", async () => {
    const { model, errors } = await parseString(wrapWith("workflows: [placeOrder]"));
    expect(errors).toEqual([]);
    expect(pageNames(model)).toContain("PlaceOrderWorkflow");
    // Canonical body primitive — expands inline to Stack {Breadcrumbs,
    // Heading, Card { WorkflowForm { runs: } }} at lowering.
    expect(pageBodyCallee(model, "PlaceOrderWorkflow")).toBe("scaffoldWorkflowForm");
    expect(pageNames(model)).toContain("WorkflowsIndex");
  });

  it("views produce one List page each", async () => {
    const { model, errors } = await parseString(wrapWith("views: [ActiveOrders]"));
    expect(errors).toEqual([]);
    expect(pageNames(model)).toContain("ActiveOrdersView");
    expect(pageNames(model)).toContain("ViewsIndex");
  });

  it("modules fan out into aggregate + workflow + view pages", async () => {
    const { model, errors } = await parseString(wrapWith("subdomains: [Sales]"));
    expect(errors).toEqual([]);
    // Sales contains Order, Customer, placeOrder, ActiveOrders.
    const names = pageNames(model);
    expect(names).toEqual(
      expect.arrayContaining([
        "OrderList",
        "OrderNew",
        "OrderDetail",
        "CustomerList",
        "CustomerNew",
        "CustomerDetail",
        "PlaceOrderWorkflow",
        "ActiveOrdersView",
        "Home",
        "WorkflowsIndex",
        "ViewsIndex",
      ]),
    );
  });
});

describe("scaffold macro: composition rules", () => {
  it("reports unknown aggregate name with a helpful diagnostic", async () => {
    const { errors } = await parseString(wrapWith("aggregates: [Bogus]"));
    expect(errors.join("\n")).toMatch(/unknown Aggregate 'Bogus'/);
  });

  it("override-by-name: explicit page wins over scaffold-emitted page", async () => {
    const { model } = await parseString(`
      system Demo {
        subdomain Sales {
          context Orders {
            aggregate Order { subject: string }
            repository Orders for Order { }
          }
        }
        ui App with scaffold(aggregates: [Order]) {
          page OrderList { route: "/custom"  body: List { of: Order } }
        }
      }
    `);
    const ui = findUi(model);
    const orderListPages = (ui.members ?? [])
      .filter(isPage)
      .filter((p: Page) => p.name === "OrderList");
    expect(orderListPages.length).toBe(1);
    const explicit = orderListPages[0]!;
    const route = (explicit.props ?? []).find((p) => p.$type === "RouteProp") as any;
    expect(route?.value).toBe("/custom");
  });
});
