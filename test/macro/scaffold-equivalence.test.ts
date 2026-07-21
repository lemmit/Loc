// Scaffold stdlib macro emits the expected Page AST shape for each
// selector kind.  Originally written as a legacy-vs-macro
// equivalence test; with the legacy `scaffold` keyword removed in
// the Phase 4 finalisation commit, the macro is the only path —
// these tests pin the output shape directly so any future refactor
// surfaces immediately.

import { describe, expect, it } from "vitest";
import type { Model, Ui } from "../../src/language/generated/ast.js";
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
    // Pages are role-named (`List`/`New`/`Detail`), scoped to their
    // per-aggregate area — so the names repeat across Order's + Customer's areas.
    expect(pageNames(model)).toEqual(["Detail", "Detail", "Home", "List", "List", "New", "New"]);
  });

  it("List pages get pluralised snake-case routes", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    expect(pageRoute(model, "List")).toBe("/orders");
    expect(pageRoute(model, "New")).toBe("/orders/new");
    expect(pageRoute(model, "Detail")).toBe("/orders/:id");
  });

  it("bodies are emitted as full unfoldable trees (the flip)", async () => {
    const { model } = await parseString(wrapWith("aggregates: [Order]"));
    // The scaffold macro now emits the FULL page-body tree directly (the
    // unfoldable scaffolders) instead of a `scaffold<X>(of:|runs:)` sentinel
    // the IR phase later expanded — every page body is a top-level `Stack`.
    expect(pageBodyCallee(model, "List")).toBe("Stack");
    expect(pageBodyCallee(model, "New")).toBe("Stack");
    expect(pageBodyCallee(model, "Detail")).toBe("Stack");
  });
});

describe("scaffold macro: workflow / module selectors", () => {
  it("workflows produce one Form page each", async () => {
    const { model, errors } = await parseString(wrapWith("workflows: [placeOrder]"));
    expect(errors).toEqual([]);
    expect(pageNames(model)).toContain("PlaceOrderWorkflow");
    // Flipped: the body is the full `Stack(Breadcrumbs, Heading,
    // Card(WorkflowForm(runs:)))` tree, not a `scaffoldWorkflowForm` sentinel.
    expect(pageBodyCallee(model, "PlaceOrderWorkflow")).toBe("Stack");
    expect(pageNames(model)).toContain("WorkflowsIndex");
  });

  it("modules fan out into aggregate + workflow pages", async () => {
    const { model, errors } = await parseString(wrapWith("subdomains: [Sales]"));
    expect(errors).toEqual([]);
    // Sales contains Order, Customer, placeOrder.
    const names = pageNames(model);
    expect(names).toEqual(
      expect.arrayContaining([
        // role-named aggregate pages (shared across Order's + Customer's areas)
        "List",
        "New",
        "Detail",
        "PlaceOrderWorkflow",
        "Home",
        "WorkflowsIndex",
      ]),
    );
  });
});

// An event-sourced workflow is now observable too (it carries `instanceWireShape`
// + a folded `GET /workflows/<wf>/instances[/{id}]` read model since #1497), so a
// correlation-bearing ES workflow listed in `scaffold(workflows: [...])` emits the
// same read-only `<Wf>InstancesList` / `<Wf>InstanceDetail` instance pages a
// state-table saga does — it previously did NOT (the macro excluded ES workflows).
// A stateless ES workflow (no id-shaped state field ⇒ no correlation read model)
// still produces no instance pages.
const ES_OBS = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { subject: string  create place() { subject := "x"  emit OrderPlaced { order: id } } }
        repository Orders for Order { }
        event OrderPlaced { order: Order id }
        event Paid { order: Order id, amount: int }
        channel L { carries: OrderPlaced, Paid  delivery: broadcast  retention: ephemeral }
        workflow Fulfillment eventSourced {
          orderId: Order id
          total: int
          create(p: OrderPlaced) by p.order { emit Paid { order: p.order, amount: 0 } }
          apply(pr: Paid) { total := total + pr.amount }
        }
      }
    }
    ui App with scaffold(workflows: [Fulfillment]) { }
  }
`;

const ES_STATELESS = `
  system Demo {
    subdomain Sales {
      context Orders {
        aggregate Order { subject: string  create place() { subject := "x"  emit OrderPlaced { order: id } } }
        repository Orders for Order { }
        event OrderPlaced { order: Order id }
        event Paid { order: Order id, amount: int }
        channel L { carries: OrderPlaced, Paid  delivery: broadcast  retention: ephemeral }
        workflow Counter eventSourced {
          total: int
          create(p: OrderPlaced) by p.order { emit Paid { order: p.order, amount: 0 } }
          apply(pr: Paid) { total := total + pr.amount }
        }
      }
    }
    ui App with scaffold(workflows: [Counter]) { }
  }
`;

describe("scaffold macro: event-sourced workflow instance pages", () => {
  it("emits InstancesList + InstanceDetail for a correlation-bearing ES workflow", async () => {
    const { model, errors } = await parseString(ES_OBS);
    expect(errors).toEqual([]);
    const names = pageNames(model);
    expect(names).toContain("FulfillmentInstancesList");
    expect(names).toContain("FulfillmentInstanceDetail");
  });

  it("gives the ES instance pages the conventional instance routes", async () => {
    const { model } = await parseString(ES_OBS);
    expect(pageRoute(model, "FulfillmentInstancesList")).toBe("/workflows/fulfillment/instances");
    expect(pageRoute(model, "FulfillmentInstanceDetail")).toBe(
      "/workflows/fulfillment/instances/:id",
    );
  });

  it("emits the bodies as full unfoldable trees (top-level Stack), not sentinels", async () => {
    const { model } = await parseString(ES_OBS);
    expect(pageBodyCallee(model, "FulfillmentInstancesList")).toBe("Stack");
    expect(pageBodyCallee(model, "FulfillmentInstanceDetail")).toBe("Stack");
  });

  it("emits no instance pages for a stateless ES workflow (no id-shaped field)", async () => {
    const { model, errors } = await parseString(ES_STATELESS);
    expect(errors).toEqual([]);
    const names = pageNames(model);
    expect(names).not.toContain("CounterInstancesList");
    expect(names).not.toContain("CounterInstanceDetail");
  });
});

describe("scaffold macro: composition rules", () => {
  it("reports unknown aggregate name with a helpful diagnostic", async () => {
    const { errors } = await parseString(wrapWith("aggregates: [Bogus]"));
    expect(errors.join("\n")).toMatch(/unknown Aggregate 'Bogus'/);
  });

  it("override-by-name is scope-local: an explicit area page wins over the scaffolded one", async () => {
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
            page List { route: "/custom"  body: Stack { Heading { "Orders" } } }
          }
        }
      }
    `);
    const ui = findUi(model);
    // The scaffold's synthesised `area Orders` merges into the explicit one;
    // the explicit `page List` (custom route) suppresses the synthesised List
    // in that same scope, while New + Detail are still contributed.
    const ordersArea = (ui.members ?? []).find(
      (m: any) => m.$type === "Area" && m.name === "Orders",
    );
    const areaPages = (ordersArea?.members ?? []).filter(isPage);
    const listPages = areaPages.filter((p: any) => p.name === "List");
    expect(listPages.length).toBe(1);
    const route = (listPages[0]!.props ?? []).find((p: any) => p.$type === "RouteProp") as any;
    expect(route?.value).toBe("/custom");
    expect(areaPages.map((p: any) => p.name).sort()).toEqual(["Detail", "List", "New"]);
    // exactly one List across the whole ui (the explicit one)
    expect(allPages(ui).filter((p: any) => p.name === "List").length).toBe(1);
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
