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

// Collect all pages in a ui, descending into `area { … }` blocks — the
// scaffold groups aggregate pages under per-aggregate areas, so a page can be
// nested rather than a direct ui member.
function allPages(ui: Ui): any[] {
  const out: any[] = [];
  const walk = (members: any[]): void => {
    for (const m of members ?? []) {
      if (isPage(m)) out.push(m);
      else if (m?.$type === "Area") walk(m.members ?? []);
    }
  };
  walk((ui.members ?? []) as any[]);
  return out;
}

function pageNames(model: Model): string[] {
  return allPages(findUi(model))
    .map((p) => p.name)
    .sort();
}

function pageRoute(model: Model, name: string): string | undefined {
  const p = allPages(findUi(model)).find((pg) => pg.name === name);
  if (!p) return undefined;
  for (const prop of p.props ?? []) {
    if (prop.$type === "RouteProp") return (prop as any).value;
  }
  return undefined;
}

function pageBodyCallee(model: Model, name: string): string | undefined {
  const p = allPages(findUi(model)).find((pg) => pg.name === name);
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

  it("bodies are emitted as full unfoldable trees (the flip)", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    // The scaffold macro now emits the FULL page-body tree directly (the
    // unfoldable scaffolders) instead of a `scaffold<X>(of:|runs:)` sentinel
    // the IR phase later expanded — every page body is a top-level `Stack`.
    expect(pageBodyCallee(model, "OrderList")).toBe("Stack");
    expect(pageBodyCallee(model, "OrderNew")).toBe("Stack");
    expect(pageBodyCallee(model, "OrderDetail")).toBe("Stack");
  });
});

describe("scaffold macro: workflow / view / module selectors", () => {
  it("workflows produce one Form page each", async () => {
    const { model, errors } = await parseString(wrapWith("workflows: [placeOrder]"));
    expect(errors).toEqual([]);
    expect(pageNames(model)).toContain("PlaceOrderWorkflow");
    // Flipped: the body is the full `Stack(Breadcrumbs, Heading,
    // Card(WorkflowForm(runs:)))` tree, not a `scaffoldWorkflowForm` sentinel.
    expect(pageBodyCallee(model, "PlaceOrderWorkflow")).toBe("Stack");
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
          page OrderList { route: "/custom"  body: Stack { Heading { "Orders" } } }
        }
      }
    `);
    const ui = findUi(model);
    // The explicit top-level OrderList wins; the synthesised one is pruned
    // from the scaffold's `area Orders` (override-by-name reaches into areas).
    const topLevelOrderList = (ui.members ?? [])
      .filter(isPage)
      .filter((p: Page) => p.name === "OrderList");
    expect(topLevelOrderList.length).toBe(1);
    const route = (topLevelOrderList[0]!.props ?? []).find((p) => p.$type === "RouteProp") as any;
    expect(route?.value).toBe("/custom");
    // exactly one OrderList across the whole ui (the explicit one)
    expect(allPages(ui).filter((p: any) => p.name === "OrderList").length).toBe(1);
    const ordersArea = (ui.members ?? []).find(
      (m: any) => m.$type === "Area" && m.name === "Orders",
    );
    const areaPageNames = (ordersArea?.members ?? [])
      .filter(isPage)
      .map((p: any) => p.name)
      .sort();
    expect(areaPageNames).toEqual(["OrderDetail", "OrderNew"]); // OrderList pruned
  });

  it("groups an aggregate's List/New/Detail under a per-aggregate `area`", async () => {
    const { model } = await parseString(`
      system Demo {
        subdomain Sales {
          context Orders {
            aggregate Order { subject: string }
            repository Orders for Order { }
          }
        }
        ui App with scaffold(aggregates: [Order]) { }
      }
    `);
    const ui = findUi(model);
    const ordersArea = (ui.members ?? []).find(
      (m: any) => m.$type === "Area" && m.name === "Orders",
    );
    expect(ordersArea, "scaffold should emit an `area Orders` block").toBeTruthy();
    const names = (ordersArea.members ?? [])
      .filter(isPage)
      .map((p: any) => p.name)
      .sort();
    expect(names).toEqual(["OrderDetail", "OrderList", "OrderNew"]);
  });
});
