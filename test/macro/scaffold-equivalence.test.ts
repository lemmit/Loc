// Equivalence: the new `with pages(...)` stdlib macro produces
// the same Page AST nodes as the legacy `scaffold modules: ...`
// directive.  Same names, same routes, same body callee/args,
// same menu metadata.
//
// Phase 4 goal: when this test passes for all selector kinds
// (aggregates/workflows/views/modules), we can remove the legacy
// AST expander and migrate examples in a follow-up commit.  The
// test is the migration safety net.

import { describe, expect, it } from "vitest";
import { isPage } from "../../src/language/generated/ast.js";
import type { Model, Page, Ui } from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (uiBody: string, domain = "") => `
  system Demo {
    module Sales {
      context Orders {
        aggregate Order { subject: string }
        aggregate Customer { name: string }
        workflow placeOrder() { let x = 1 }
        view ActiveOrders = Order where subject == "x"
        repository Orders for Order { }
        repository Customers for Customer { }
        ${domain}
      }
    }
    ui App {
      ${uiBody}
    }
  }
`;

const wrapWith = (uiArgs: string, domain = "") => `
  system Demo {
    module Sales {
      context Orders {
        aggregate Order { subject: string }
        aggregate Customer { name: string }
        workflow placeOrder() { let x = 1 }
        view ActiveOrders = Order where subject == "x"
        repository Orders for Order { }
        repository Customers for Customer { }
        ${domain}
      }
    }
    ui App with pages(${uiArgs}) { }
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

interface PageSig {
  name: string;
  route: string | undefined;
  bodyCallee: string | undefined;
  bodyArgs: Array<{ name?: string; valueText: string }>;
  menuKeys: string[];
}

function pageSig(p: Page): PageSig {
  let route: string | undefined;
  let bodyCallee: string | undefined;
  let bodyArgs: PageSig["bodyArgs"] = [];
  const menuKeys: string[] = [];
  for (const prop of p.props ?? []) {
    if (prop.$type === "RouteProp") route = (prop as any).value;
    else if (prop.$type === "BodyProp") {
      const expr = (prop as any).expr;
      if (expr?.$type === "CallExpr") {
        const callee = expr.callee;
        if (callee?.$type === "NameRef") bodyCallee = callee.name;
        bodyArgs = (expr.args ?? []).map((a: any) => ({
          name: a.name ?? undefined,
          valueText:
            a.value?.$type === "NameRef"
              ? `name:${a.value.name}`
              : a.value?.$type === "StringLit"
                ? `str:${a.value.value}`
                : `kind:${a.value?.$type}`,
        }));
      }
    } else if (prop.$type === "PageMenuMeta") {
      for (const e of (prop as any).entries ?? []) menuKeys.push(e.name);
    }
  }
  return { name: p.name, route, bodyCallee, bodyArgs, menuKeys };
}

function uiPageSigs(model: Model): PageSig[] {
  const ui = findUi(model);
  return (ui.members ?? [])
    .filter(isPage)
    .map(pageSig)
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("scaffold macro equivalence with legacy directive", () => {
  it("aggregates: same pages, names, routes, body shapes, menu keys", async () => {
    const legacy = await parseString(wrap("scaffold aggregates: Order, Customer"));
    const macro = await parseString(wrapWith("aggregates: [Order, Customer]"));
    expect(legacy.errors).toEqual([]);
    expect(macro.errors).toEqual([]);
    const a = uiPageSigs(legacy.model);
    const b = uiPageSigs(macro.model);
    expect(b).toEqual(a);
  });

  it("workflows: same pages produced", async () => {
    const legacy = await parseString(wrap("scaffold workflows: placeOrder"));
    const macro = await parseString(wrapWith("workflows: [placeOrder]"));
    expect(legacy.errors).toEqual([]);
    expect(macro.errors).toEqual([]);
    const a = uiPageSigs(legacy.model);
    const b = uiPageSigs(macro.model);
    expect(b).toEqual(a);
  });

  it("views: same pages produced", async () => {
    const legacy = await parseString(wrap("scaffold views: ActiveOrders"));
    const macro = await parseString(wrapWith("views: [ActiveOrders]"));
    expect(legacy.errors).toEqual([]);
    expect(macro.errors).toEqual([]);
    const a = uiPageSigs(legacy.model);
    const b = uiPageSigs(macro.model);
    expect(b).toEqual(a);
  });

  it("modules: fans out into aggregate/workflow/view pages", async () => {
    const legacy = await parseString(wrap("scaffold modules: Sales"));
    const macro = await parseString(wrapWith("modules: [Sales]"));
    expect(legacy.errors).toEqual([]);
    expect(macro.errors).toEqual([]);
    const a = uiPageSigs(legacy.model);
    const b = uiPageSigs(macro.model);
    expect(b).toEqual(a);
  });
});

describe("scaffold macro standalone behaviors", () => {
  it("reports unknown aggregate name with a helpful diagnostic", async () => {
    const { errors } = await parseString(wrapWith("aggregates: [Bogus]"));
    expect(errors.join("\n")).toMatch(/unknown Aggregate 'Bogus'/);
  });

  it("override-by-name: explicit page wins over scaffold-emitted page", async () => {
    const { model } = await parseString(`
      system Demo {
        module Sales {
          context Orders {
            aggregate Order { subject: string }
            repository Orders for Order { }
          }
        }
        ui App with pages(aggregates: [Order]) {
          page OrderList { route: "/custom"  body: List(of: Order) }
        }
      }
    `);
    const ui = findUi(model);
    const orderListPages = (ui.members ?? [])
      .filter(isPage)
      .filter((p) => p.name === "OrderList");
    expect(orderListPages.length).toBe(1);
    // The explicit page kept its custom route, not /orders.
    const explicit = orderListPages[0]!;
    const route = (explicit.props ?? []).find((p) => p.$type === "RouteProp") as any;
    expect(route?.value).toBe("/custom");
  });
});
