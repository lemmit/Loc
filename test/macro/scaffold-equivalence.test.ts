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

// Page names directly inside the named top-level `area` block, sorted.
function areaPageNames(model: Model, areaName: string): string[] {
  const ui = findUi(model);
  const area = (ui.members ?? []).find(
    (m: any) => m.$type === "Area" && m.name === areaName,
  ) as any;
  return (area?.members ?? [])
    .filter((m: any) => isPage(m))
    .map((p: any) => p.name)
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
  it("emits role-named List/New/Detail per aggregate area, plus Home and the indexes that apply", async () => {
    const { model, errors } = await parseString(wrapWith("aggregates: [Order, Customer]"));
    expect(errors).toEqual([]);
    // Each aggregate's pages are grouped under a per-aggregate `area` and named
    // by role, so the flattened list carries one Home plus role names ×2.
    expect(pageNames(model)).toEqual(["Detail", "Detail", "Home", "List", "List", "New", "New"]);
    // The roles are scoped — one `area` per aggregate, each List/New/Detail.
    expect(areaPageNames(model, "Orders")).toEqual(["Detail", "List", "New"]);
    expect(areaPageNames(model, "Customers")).toEqual(["Detail", "List", "New"]);
  });

  it("List pages get pluralised snake-case routes", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    expect(pageRoute(model, "List")).toBe("/orders");
    expect(pageRoute(model, "New")).toBe("/orders/new");
    expect(pageRoute(model, "Detail")).toBe("/orders/:id");
  });

  it("body calls are the canonical scaffold primitives", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    // List / New / Workflow / View now emit the canonical
    // `scaffold<X>(of:|runs:)` body primitive, one per page.  The
    // expander rewrites it inline at lowering to the same Stack /
    // QueryView / Form trees the legacy archetype path produced.
    expect(pageBodyCallee(model, "List")).toBe("scaffoldList");
    expect(pageBodyCallee(model, "New")).toBe("scaffoldNewForm");
    // Detail page emits the explicit Stack {scaffoldDetails,
    // scaffoldOperations} shape so users can unfold into per-slot
    // customisation while leaving auto-op-modal generation intact.
    expect(pageBodyCallee(model, "Detail")).toBe("Stack");
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
    // Sales contains Order, Customer, placeOrder, ActiveOrders.  Aggregate
    // pages are role-named inside per-aggregate areas; workflow/view/singleton
    // pages stay top-level with their descriptive names.
    const names = pageNames(model);
    expect(names).toEqual(
      expect.arrayContaining([
        "List",
        "New",
        "Detail",
        "PlaceOrderWorkflow",
        "ActiveOrdersView",
        "Home",
        "WorkflowsIndex",
        "ViewsIndex",
      ]),
    );
    expect(areaPageNames(model, "Orders")).toEqual(["Detail", "List", "New"]);
    expect(areaPageNames(model, "Customers")).toEqual(["Detail", "List", "New"]);
  });
});

describe("scaffold macro: composition rules", () => {
  it("reports unknown aggregate name with a helpful diagnostic", async () => {
    const { errors } = await parseString(wrapWith("aggregates: [Bogus]"));
    expect(errors.join("\n")).toMatch(/unknown Aggregate 'Bogus'/);
  });

  it("override-by-name is area-scoped: an explicit `area Orders` page wins", async () => {
    const { model } = await parseString(`
      system Demo {
        subdomain Sales {
          context Orders {
            aggregate Order { subject: string }
            repository Orders for Order { }
          }
        }
        ui App with scaffold(aggregates: [Order]) {
          area Orders {
            page List { route: "/custom"  body: scaffoldList { of: Order } }
          }
        }
      }
    `);
    const ui = findUi(model);
    // The scaffold merges its synthesised `area Orders` into the explicit one;
    // override-by-name is scoped to that area, so the explicit `List` wins and
    // the synthesised `New`/`Detail` join it — one `area Orders`, one `List`.
    const ordersAreas = (ui.members ?? []).filter(
      (m: any) => m.$type === "Area" && m.name === "Orders",
    );
    expect(ordersAreas.length).toBe(1);
    const pages = (ordersAreas[0]!.members ?? []).filter(isPage) as Page[];
    expect(pages.filter((p) => p.name === "List").length).toBe(1);
    expect(pages.map((p) => p.name).sort()).toEqual(["Detail", "List", "New"]);
    const list = pages.find((p) => p.name === "List")!;
    const route = (list.props ?? []).find((p) => p.$type === "RouteProp") as any;
    expect(route?.value).toBe("/custom");
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
    expect(names).toEqual(["Detail", "List", "New"]);
  });
});
