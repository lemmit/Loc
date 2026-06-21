// Bucket V / F1, F2 — page/component body shapes the walker renders as a
// silent-wrong placeholder.
//
//   F1 — `Action(<inst>.<op>)` against a parameterized operation renders
//        `mutateAsync({})`, silently dropping the params; use OperationForm.
//   F2 — a method-call whose receiver doesn't resolve to a binding renders
//        a `/* TODO: method-call … */ undefined` sentinel.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function errorsWithCode(source: string, code: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

// ---------------------------------------------------------------------------
// F1 — Action against a parameterized operation.
// ---------------------------------------------------------------------------

const actionSys = (op: string) => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          ${op}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      component OrderPanel(order: Order) {
        body: Toolbar { Action { order.confirm } }
      }
    }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("Action operation parameters (F1)", () => {
  it("rejects an Action targeting an operation that takes parameters", async () => {
    const errs = await errorsWithCode(
      actionSys("operation confirm(reason: string) { }"),
      "loom.action-op-has-params",
    );
    expect(errs.some((m) => /OperationForm/.test(m) && /confirm/.test(m))).toBe(true);
  });

  it("admits an Action targeting a parameterless operation", async () => {
    const errs = await errorsWithCode(
      actionSys("operation confirm() { }"),
      "loom.action-op-has-params",
    );
    expect(errs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F2 — method-call against an unresolved receiver.
// ---------------------------------------------------------------------------

const methodCallSys = (body: string) => `
  system S {
    subdomain M { context C { } }
    ui WebApp {
      page X {
        route: "/x"
        state { draft: int = 0 }
        body: Button { "Sync", onClick: e => { ${body} } }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("method-call receiver resolution (F2)", () => {
  it("rejects a method call whose receiver does not resolve to any binding", async () => {
    const errs = await errorsWithCode(
      methodCallSys("Orders.create(draft)"),
      "loom.method-call-unresolved-receiver",
    );
    expect(errs.some((m) => /unresolved receiver 'Orders'/.test(m))).toBe(true);
  });

  it("admits a method call rooted at a declared api handle", async () => {
    const src = `
      system S {
        subdomain Sales {
          context Sales {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales
        ui WebApp {
          api Sales: SalesApi
          page X {
            route: "/x"
            body: Button { "Go", onClick: e => { Sales.Order.findAll() } }
          }
        }
        deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
      }
    `;
    const errs = await errorsWithCode(src, "loom.method-call-unresolved-receiver");
    expect(errs).toEqual([]);
  });
});
