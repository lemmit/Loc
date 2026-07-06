// Lowering + IR-validation for the explicit application/transport layers
// (unfoldable-api-derivation.md Layers 3-4):
//   - `commandHandler` / `queryHandler` lower to CommandHandlerIR /
//     QueryHandlerIR on BoundedContextIR.
//   - `route <METHOD> <PATH> -> <Ctx>.<Handler>` lowers to RouteIR on ApiIR.
//   - three layering gates: loom.query-handler-saves,
//     loom.command-handler-multi-aggregate, loom.route-handler-unresolved.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** A two-aggregate system.  `handlers` is spliced into context `Ordering`;
 *  `routes` into the api body.  Both aggregates carry a mutating op + a repo. */
const SYS = (handlers: string, routes: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Order ids guid {
          code: string
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }
        aggregate Customer ids guid {
          status: string
          operation deactivate() { status := "inactive" }
        }
        repository Customers for Customer { }
        ${handlers}
      }
    }
    api SalesApi from Sales {
      ${routes}
    }
    storage pg { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [orderingState], serves: SalesApi, port: 4000 }
  }
`;

async function codesFor(handlers: string, routes: string): Promise<string[]> {
  const { model } = await parseString(SYS(handlers, routes), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

const OK_CMD = `
  commandHandler CancelOrder(id: Order id) {
    let o = Orders.getById(id)
    o.cancel()
  }`;
const OK_QRY = `
  queryHandler GetOrder(id: Order id): Order {
    let o = Orders.getById(id)
  }`;
const OK_ROUTES = `
  route POST "/orders/{id}/cancellations" -> Ordering.CancelOrder
  route GET  "/orders/{id}"               -> Ordering.GetOrder`;

describe("explicit api handlers — lowering", () => {
  it("lowers commandHandler + queryHandler onto the BoundedContextIR", async () => {
    const { model } = await parseString(SYS(`${OK_CMD}\n${OK_QRY}`, OK_ROUTES), {
      validate: false,
    });
    const ctx = allContexts(lowerModel(model)).find((c) => c.name === "Ordering")!;
    expect(ctx.commandHandlers?.map((h) => h.name)).toEqual(["CancelOrder"]);
    expect(ctx.queryHandlers?.map((h) => h.name)).toEqual(["GetOrder"]);
    // commandHandler binds its param and derives its exit-save (the touched Order).
    const cmd = ctx.commandHandlers![0]!;
    expect(cmd.params.map((p) => p.name)).toEqual(["id"]);
    expect(cmd.returnType).toBeUndefined();
    expect(cmd.savesAtExit.map((s) => s.aggName)).toEqual(["Order"]);
    // queryHandler carries its required return type and saves nothing.
    const qry = ctx.queryHandlers![0]!;
    expect(qry.returnType).toBeDefined();
    expect(qry.savesAtExit).toEqual([]);
  });

  it("lowers routes onto ApiIR.routes", async () => {
    const { model } = await parseString(SYS(`${OK_CMD}\n${OK_QRY}`, OK_ROUTES), {
      validate: false,
    });
    const api = lowerModel(model).systems[0]!.apis.find((a) => a.name === "SalesApi")!;
    expect(api.routes).toEqual([
      {
        method: "POST",
        path: "/orders/{id}/cancellations",
        target: { context: "Ordering", handler: "CancelOrder" },
      },
      { method: "GET", path: "/orders/{id}", target: { context: "Ordering", handler: "GetOrder" } },
    ]);
  });
});

describe("explicit api handlers — layering gates", () => {
  it("accepts a read-only queryHandler + single-aggregate commandHandler + resolved routes", async () => {
    expect(await codesFor(`${OK_CMD}\n${OK_QRY}`, OK_ROUTES)).toEqual([]);
  });

  it("loom.query-handler-saves — a queryHandler that mutates", async () => {
    const bad = `
      queryHandler BadQuery(id: Order id): Order {
        let o = Orders.getById(id)
        o.cancel()
      }`;
    const codes = await codesFor(bad, `route GET "/orders/{id}" -> Ordering.BadQuery`);
    expect(codes).toContain("loom.query-handler-saves");
  });

  it("loom.command-handler-multi-aggregate — a commandHandler touching two aggregates", async () => {
    const bad = `
      commandHandler TransferThing(oid: Order id, cid: Customer id) {
        let o = Orders.getById(oid)
        let c = Customers.getById(cid)
        o.cancel()
        c.deactivate()
      }`;
    const codes = await codesFor(bad, `route POST "/transfer" -> Ordering.TransferThing`);
    expect(codes).toContain("loom.command-handler-multi-aggregate");
  });

  it("loom.route-handler-unresolved — a route to a non-existent handler", async () => {
    const codes = await codesFor(OK_CMD, `route GET "/nope" -> Ordering.NoSuchHandler`);
    expect(codes).toContain("loom.route-handler-unresolved");
  });
});
